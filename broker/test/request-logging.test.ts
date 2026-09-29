// Integration tests for task A2: exactly one journal line on request receipt
// and one on completion, per chat/summarize/act — never page text, user
// content, or the pairing token in either line (measured incident:
// journalctl only had the handshake/listen lines, nothing to diagnose a hung
// or failed request from). Driven against the ollama provider's fake fetch
// (goal G1b, 29/09 ménage du dépôt public — this used to run against a
// now-private provider module).

import { describe, expect, test, afterEach, mock } from "bun:test";
import { startServer } from "../src/server.ts";
import { __setFetchImplForTests, __resetFetchImplForTests } from "../src/providers/ollama.ts";
import type { ServerMessage } from "../src/protocol.ts";
import { makeTmpDir } from "./helpers/tmp-dir.ts";

const ALLOWED_ID = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const SECRET = "0123456789abcdef0123456789abcdef";
const SECRET_VALUE = "s3cr3t-page-content-should-never-leak";

let servers: ReturnType<typeof startServer>[] = [];
let logSpy: ReturnType<typeof mock>;
let originalLog: typeof console.log;

function boot() {
  const dataDir = makeTmpDir("coati-logging-");
  const server = startServer(
    { port: 0, allowedExtensionIds: [ALLOWED_ID], provider: "ollama", model: "llama3.2" },
    SECRET,
    { dataDir },
  );
  servers.push(server);
  return server;
}

async function connectAndAuth(server: ReturnType<typeof startServer>): Promise<WebSocket> {
  const ws = new WebSocket(`ws://127.0.0.1:${server.port}/ws`, {
    headers: { Origin: `chrome-extension://${ALLOWED_ID}` },
  } as any);
  await new Promise<void>((resolve) => ws.addEventListener("open", () => resolve()));
  const helloOk = new Promise<void>((resolve) => {
    const onMessage = (event: MessageEvent) => {
      const msg = JSON.parse(event.data as string);
      if (msg.type === "hello-ok") {
        ws.removeEventListener("message", onMessage);
        resolve();
      }
    };
    ws.addEventListener("message", onMessage);
  });
  ws.send(JSON.stringify({ type: "hello", secret: SECRET, v: 1 }));
  await helloOk;
  return ws;
}

const TAGS_OK = () => new Response(JSON.stringify({ models: [{ name: "llama3.2:latest" }] }), { status: 200 });

function fakeOllamaFetchYielding(text: string): typeof fetch {
  return (async (url: string) => {
    if (String(url).includes("/api/tags")) return TAGS_OK();
    const line = JSON.stringify({ message: { content: text }, done: true, prompt_eval_count: 1, eval_count: 1 });
    return new Response(`${line}\n`, { status: 200 });
  }) as unknown as typeof fetch;
}

afterEach(() => {
  for (const s of servers) s.stop(true);
  servers = [];
  __resetFetchImplForTests();
  console.log = originalLog;
});

function loggedLines(): string[] {
  return logSpy.mock.calls.map((call: unknown[]) => String(call[0]));
}

describe("A2 — one journal line per request", () => {
  test("a successful chat logs one 'received' and one 'completed: ok' line, without leaking text", async () => {
    originalLog = console.log;
    logSpy = mock(() => {});
    console.log = logSpy as unknown as typeof console.log;

    __setFetchImplForTests(fakeOllamaFetchYielding("réponse"));
    const server = boot();
    const ws = await connectAndAuth(server);

    const done = new Promise<ServerMessage>((resolve) => {
      const onMessage = (event: MessageEvent) => {
        const msg = JSON.parse(event.data as string);
        if (msg.type === "done") {
          ws.removeEventListener("message", onMessage);
          resolve(msg);
        }
      };
      ws.addEventListener("message", onMessage);
    });
    ws.send(JSON.stringify({ type: "chat", id: "log-1", text: SECRET_VALUE }));
    await done;
    ws.close();

    const lines = loggedLines();
    const received = lines.filter((l) => l.includes("request received") && l.includes("id=log-1"));
    const completed = lines.filter((l) => l.includes("request completed") && l.includes("id=log-1"));
    expect(received).toHaveLength(1);
    expect(completed).toHaveLength(1);
    expect(received[0]).toContain("type=chat");
    expect(completed[0]).toContain("outcome=ok");
    expect(completed[0]).toMatch(/elapsedMs=\d+/);

    // Never the request's own text content or the pairing secret.
    for (const line of lines) {
      expect(line).not.toContain(SECRET_VALUE);
      expect(line).not.toContain(SECRET);
    }
  });

  test("a context-too-large chat is rejected and logged as completed immediately, no model call", async () => {
    originalLog = console.log;
    logSpy = mock(() => {});
    console.log = logSpy as unknown as typeof console.log;

    let fetchCalled = false;
    __setFetchImplForTests((async () => {
      fetchCalled = true;
      return TAGS_OK();
    }) as unknown as typeof fetch);
    const server = boot();
    const ws = await connectAndAuth(server);

    const errorMsg = new Promise<ServerMessage>((resolve) => {
      const onMessage = (event: MessageEvent) => {
        const msg = JSON.parse(event.data as string);
        if (msg.type === "error" && msg.id === "log-2") {
          ws.removeEventListener("message", onMessage);
          resolve(msg);
        }
      };
      ws.addEventListener("message", onMessage);
    });
    ws.send(JSON.stringify({ type: "chat", id: "log-2", text: "x".repeat(40_001) }));
    await errorMsg;
    ws.close();

    expect(fetchCalled).toBe(false);
    const lines = loggedLines();
    const completed = lines.find((l) => l.includes("request completed") && l.includes("id=log-2"));
    expect(completed).toBeDefined();
    expect(completed).toContain("outcome=error:context-too-large");
  });

  // 2026-09-26 amendment (docs/PROTOCOL.md): the completed line for a model
  // error carries `reason="…"` — a provider's own captured explanation, not
  // just the bare outcome code. Before this, a failed request left nothing in
  // the journal to tell one failure apart from another.
  test('a model-unavailable error\'s completed line carries reason="…" naming the HTTP status', async () => {
    originalLog = console.log;
    logSpy = mock(() => {});
    console.log = logSpy as unknown as typeof console.log;

    __setFetchImplForTests((async (url: string) => {
      if (String(url).includes("/api/tags")) return TAGS_OK();
      return new Response("internal error", { status: 500 });
    }) as unknown as typeof fetch);
    const server = boot();
    const ws = await connectAndAuth(server);

    const errorMsg = new Promise<ServerMessage>((resolve) => {
      const onMessage = (event: MessageEvent) => {
        const msg = JSON.parse(event.data as string);
        if (msg.type === "error" && msg.id === "log-reason") {
          ws.removeEventListener("message", onMessage);
          resolve(msg);
        }
      };
      ws.addEventListener("message", onMessage);
    });
    ws.send(JSON.stringify({ type: "chat", id: "log-reason", text: "hello" }));
    const msg = await errorMsg;
    ws.close();

    expect(msg).toMatchObject({ code: "model-unavailable" });
    expect((msg as any).message).toContain("HTTP 500");
    const lines = loggedLines();
    const completed = lines.find((l) => l.includes("request completed") && l.includes("id=log-reason"));
    expect(completed).toBeDefined();
    expect(completed).toContain("outcome=error:model-unavailable");
    expect(completed).toContain('reason="Ollama returned HTTP 500');
  });

  // L4 (lot7 security review): `id` is entirely client-supplied — a control
  // character or newline in it must not forge a fake journal line.
  test("a control-character-laden id is sanitized in both the received and completed lines", async () => {
    originalLog = console.log;
    logSpy = mock(() => {});
    console.log = logSpy as unknown as typeof console.log;

    __setFetchImplForTests(fakeOllamaFetchYielding("réponse"));
    const server = boot();
    const ws = await connectAndAuth(server);

    const hostileId = "log-3\ncoati-broker: grant via=secret origin=forged\x1b[31m";
    const done = new Promise<ServerMessage>((resolve) => {
      const onMessage = (event: MessageEvent) => {
        const msg = JSON.parse(event.data as string);
        if (msg.type === "done") {
          ws.removeEventListener("message", onMessage);
          resolve(msg);
        }
      };
      ws.addEventListener("message", onMessage);
    });
    ws.send(JSON.stringify({ type: "chat", id: hostileId, text: "hi" }));
    await done;
    ws.close();

    const lines = loggedLines();
    for (const line of lines) {
      expect(line).not.toContain("\n");
      expect(line).not.toContain("\x1b");
    }
    expect(lines.some((l) => l.includes("request received") && l.includes("id=log-3?coati-broker"))).toBe(true);
    expect(lines.some((l) => l.includes("request completed") && l.includes("id=log-3?coati-broker"))).toBe(true);
  });
});

// Item 7 (lot7 security review): grant/pin/evict lines must go to stderr —
// same as every reject* line already does — per docs/PROTOCOL.md
// "Journalisation" ("le broker écrit sur sa sortie d'erreur"). They used to
// go to console.log (stdout), the odd ones out.
describe("grant/pin/evict — stderr, not stdout", () => {
  let errorSpy: ReturnType<typeof mock>;
  let originalError: typeof console.error;

  afterEach(() => {
    console.error = originalError;
  });

  test("a silent grant on an already-known origin logs 'grant' to console.error, never console.log", async () => {
    originalLog = console.log;
    logSpy = mock(() => {});
    console.log = logSpy as unknown as typeof console.log;
    originalError = console.error;
    errorSpy = mock(() => {});
    console.error = errorSpy as unknown as typeof console.error;

    const server = boot();
    const ws = await connectAndAuth(server); // sends the permanent secret — a "grant via=secret" line
    ws.close();

    const errorLines = errorSpy.mock.calls.map((call: unknown[]) => String(call[0]));
    const logLines = logSpy.mock.calls.map((call: unknown[]) => String(call[0]));
    expect(errorLines.some((l) => l.includes("grant via=secret"))).toBe(true);
    expect(logLines.some((l) => l.includes("grant"))).toBe(false);
  });

  test("pinning a Firefox uuid logs 'pin' to console.error, never console.log", async () => {
    originalLog = console.log;
    logSpy = mock(() => {});
    console.log = logSpy as unknown as typeof console.log;
    originalError = console.error;
    errorSpy = mock(() => {});
    console.error = errorSpy as unknown as typeof console.error;

    const server = boot();
    const uuid = "12345678-1234-1234-1234-123456789abc";
    const ws = new WebSocket(`ws://127.0.0.1:${server.port}/ws`, {
      headers: { Origin: `moz-extension://${uuid}` },
    } as any);
    await new Promise<void>((resolve) => {
      ws.addEventListener("open", () => ws.send(JSON.stringify({ type: "hello", secret: SECRET, v: 1 })));
      ws.addEventListener("message", (event) => {
        if (JSON.parse(event.data as string).type === "hello-ok") resolve();
      });
    });
    ws.close();

    const errorLines = errorSpy.mock.calls.map((call: unknown[]) => String(call[0]));
    const logLines = logSpy.mock.calls.map((call: unknown[]) => String(call[0]));
    expect(errorLines.some((l) => l.includes(`pin uuid=${uuid}`))).toBe(true);
    expect(logLines.some((l) => l.includes("pin uuid="))).toBe(false);
  });
});
