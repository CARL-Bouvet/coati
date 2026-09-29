// Integration test: spins up the real Bun.serve server and drives it over an
// actual WebSocket, to check that handshake failures emit the `unauthorized`
// error message the protocol promises (docs/PROTOCOL.md:87-88) before the
// close(4401) — see ARCHITECTURE.md §7 "codes d'erreur morts".

import { describe, expect, test, afterEach } from "bun:test";
import { startServer } from "../src/server.ts";
import type { ServerMessage } from "../src/protocol.ts";
import { makeTmpDir } from "./helpers/tmp-dir.ts";

const ALLOWED_ID = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const SECRET = "0123456789abcdef0123456789abcdef";

let servers: ReturnType<typeof startServer>[] = [];

function boot() {
  const dataDir = makeTmpDir("coati-errors-");
  const server = startServer(
    { port: 0, allowedExtensionIds: [ALLOWED_ID] },
    SECRET,
    { dataDir },
  );
  servers.push(server);
  return { server, dataDir };
}

afterEach(() => {
  for (const s of servers) s.stop(true);
  servers = [];
});

/** Collects every ServerMessage received until the socket closes, plus the close code. */
function collectUntilClose(ws: WebSocket): Promise<{ messages: ServerMessage[]; code: number }> {
  const messages: ServerMessage[] = [];
  return new Promise((resolve) => {
    ws.addEventListener("message", (event) => {
      messages.push(JSON.parse(event.data as string));
    });
    ws.addEventListener("close", (event) => {
      resolve({ messages, code: event.code });
    });
  });
}

describe("unauthorized error emission on bad handshake", () => {
  test("wrong Origin: emits error(unauthorized) then closes 4401", async () => {
    const { server } = boot();
    const ws = new WebSocket(`ws://127.0.0.1:${server.port}/ws`, {
      headers: { Origin: "chrome-extension://wrong-id-wrong-id-wrong-id-wro" },
    } as any);
    const { messages, code } = await collectUntilClose(ws);
    expect(code).toBe(4401);
    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({ type: "error", code: "unauthorized" });
  });

  // A known chrome-extension origin with a wrong secret now gets a fresh
  // token (amendement 2026-09-25 quater); the secret only matters for an
  // origin that is not trusted yet — a provisional Firefox uuid.
  test("wrong pairing secret: emits error(unauthorized) then closes 4401", async () => {
    const { server } = boot();
    const ws = new WebSocket(`ws://127.0.0.1:${server.port}/ws`, {
      headers: { Origin: `moz-extension://00000000-0000-4000-8000-000000000000` },
    } as any);
    const donePromise = collectUntilClose(ws);
    await new Promise<void>((resolve) => ws.addEventListener("open", () => resolve()));
    ws.send(JSON.stringify({ type: "hello", secret: "not-the-secret", v: 1 }));
    const { messages, code } = await donePromise;
    expect(code).toBe(4401);
    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({ type: "error", code: "unauthorized" });
  });

  test("correct handshake: no error, gets hello-ok", async () => {
    const { server } = boot();
    const ws = new WebSocket(`ws://127.0.0.1:${server.port}/ws`, {
      headers: { Origin: `chrome-extension://${ALLOWED_ID}` },
    } as any);
    const helloOk = new Promise<ServerMessage>((resolve) => {
      ws.addEventListener("message", (event) => resolve(JSON.parse(event.data as string)));
    });
    await new Promise<void>((resolve) => ws.addEventListener("open", () => resolve()));
    ws.send(JSON.stringify({ type: "hello", secret: SECRET, v: 1 }));
    const msg = await helloOk;
    expect(msg).toMatchObject({ type: "hello-ok" });
    ws.close();
  });

  // Oversized message BEFORE authentication: still the generic handshake
  // failure (4401), same as any other malformed hello — see
  // docs/PROTOCOL.md "Limites côté broker".
  test("an oversized message during the handshake gets the generic unauthorized/4401, not a distinct oversized error", async () => {
    const { server } = boot();
    const ws = new WebSocket(`ws://127.0.0.1:${server.port}/ws`, {
      headers: { Origin: `chrome-extension://${ALLOWED_ID}` },
    } as any);
    const donePromise = collectUntilClose(ws);
    await new Promise<void>((resolve) => ws.addEventListener("open", () => resolve()));
    ws.send(JSON.stringify({ type: "hello", v: 1, secret: "x".repeat(300_000) }));
    const { messages, code } = await donePromise;
    expect(code).toBe(4401);
    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({ type: "error", id: "hello", code: "unauthorized" });
  });
});

// docs/PROTOCOL.md "Limites côté broker" (amendement 2026-09-25, audit écart
// n°11): AFTER authentication, an oversized message gets a DISTINCT `error`
// with id "oversized", then close(1009) — not the generic 4401. The message
// is never parsed (its own `id`, if any, is never looked for).
describe("oversized message, post-authentication", () => {
  async function connectAndAuth(server: ReturnType<typeof startServer>): Promise<WebSocket> {
    const ws = new WebSocket(`ws://127.0.0.1:${server.port}/ws`, {
      headers: { Origin: `chrome-extension://${ALLOWED_ID}` },
    } as any);
    await new Promise<void>((resolve) => ws.addEventListener("open", () => resolve()));
    const helloOk = new Promise<void>((resolve) => {
      const onMessage = (event: MessageEvent) => {
        if (JSON.parse(event.data as string).type === "hello-ok") {
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

  test("an oversized message after auth gets error id=oversized then close(1009)", async () => {
    const { server } = boot();
    const ws = await connectAndAuth(server);

    const closeCode = new Promise<number>((resolve) => {
      ws.addEventListener("close", (event) => resolve(event.code));
    });
    const errorMsg = new Promise<ServerMessage>((resolve) => {
      ws.addEventListener("message", (event) => resolve(JSON.parse(event.data as string)));
    });

    // Well over the 256 KiB cap, but otherwise a syntactically valid chat
    // message with a real `id` — that `id` must NOT be echoed back (the spec
    // says the message is never analyzed for oversized).
    const oversized = JSON.stringify({ type: "chat", id: "should-never-be-echoed", text: "x".repeat(300_000) });
    ws.send(oversized);

    const msg = await errorMsg;
    expect(msg).toEqual({
      type: "error",
      id: "oversized",
      code: "bad-request",
      message: "message exceeds 262144 byte cap",
    });
    expect(await closeCode).toBe(1009);
  });
});
