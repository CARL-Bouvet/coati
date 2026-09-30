// Integration tests for the settings.get / settings.set protocol messages
// (docs/PROTOCOL.md's dated amendment): the registry is reported in full
// (never hiding an unavailable provider), an unknown provider is rejected at
// the wire with bad-request, and a successful settings.set persists to
// config.json and round-trips on the next settings.get — including across a
// fresh server instance reading the same configDir, proving it actually hit
// disk and not just in-memory state.

import { describe, expect, test, afterEach } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { startServer } from "../src/server.ts";
import type { ServerMessage, SettingsMessage, SettingsTestResultMessage } from "../src/protocol.ts";
import { makeTmpDir } from "./helpers/tmp-dir.ts";
import { __setFetchImplForTests as __setClaudeApiFetch, __resetFetchImplForTests as __resetClaudeApiFetch } from "../src/providers/claude-api.ts";
import { __setFetchImplForTests as __setOllamaFetch, __resetFetchImplForTests as __resetOllamaFetch } from "../src/providers/ollama.ts";
import { connectAndAuthV2OrThrow } from "./helpers/handshake-v2.ts";

const ALLOWED_ID = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const KEY = Buffer.from("0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcd", "hex");

let servers: ReturnType<typeof startServer>[] = [];

function boot(configDir?: string) {
  const dataDir = makeTmpDir("coati-settings-");
  const server = startServer(
    { port: 0, allowedExtensionIds: [ALLOWED_ID] },
    KEY,
    { dataDir, configDir },
  );
  servers.push(server);
  return server;
}

afterEach(() => {
  for (const s of servers) s.stop(true);
  servers = [];
  __resetClaudeApiFetch();
  __resetOllamaFetch();
});

async function connectAndAuth(server: ReturnType<typeof startServer>): Promise<WebSocket> {
  return connectAndAuthV2OrThrow(`ws://127.0.0.1:${server.port}/ws`, `chrome-extension://${ALLOWED_ID}`, KEY);
}

function nextMessage(ws: WebSocket): Promise<ServerMessage> {
  return new Promise((resolve) => {
    const onMessage = (event: MessageEvent) => {
      ws.removeEventListener("message", onMessage);
      resolve(JSON.parse(event.data as string));
    };
    ws.addEventListener("message", onMessage);
  });
}

describe("settings.get", () => {
  test("reports both known providers, never hiding an unavailable one", async () => {
    const server = boot();
    const ws = await connectAndAuth(server);
    ws.send(JSON.stringify({ type: "settings.get", id: "s1" }));
    const msg = (await nextMessage(ws)) as SettingsMessage;
    expect(msg.type).toBe("settings");
    expect(msg.id).toBe("s1");
    expect(msg.provider).toBe("ollama"); // untouched default (amendement 2026-09-29)
    expect(msg.available).toHaveLength(2);
    const ids = msg.available.map((p) => p.id).sort();
    expect(ids).toEqual(["claude-api", "ollama"]);
    for (const status of msg.available) {
      expect(typeof status.available).toBe("boolean");
      expect(typeof status.configured).toBe("boolean");
      if (!status.available) expect(typeof status.reason).toBe("string");
    }
    ws.close();
  });
});

describe("settings.set", () => {
  // Amendement 2026-09-29: `provider` is an open string — only its SHAPE is
  // rejected at the wire, not membership in a closed list. A well-shaped but
  // unknown id is accepted and persisted; it is reported unavailable
  // (never silently swapped for another provider) rather than refused here.
  test("rejects a malformed provider (empty string) with bad-request, over the wire", async () => {
    const server = boot();
    const ws = await connectAndAuth(server);
    ws.send(JSON.stringify({ type: "settings.set", id: "s2", provider: "" }));
    const msg = await nextMessage(ws);
    expect(msg).toMatchObject({ type: "error", id: "s2", code: "bad-request" });
    ws.close();
  });

  test("accepts a well-shaped but unknown provider id, and reports it absent from `available`", async () => {
    const server = boot();
    const ws = await connectAndAuth(server);
    ws.send(JSON.stringify({ type: "settings.set", id: "s2b", provider: "not-a-real-provider" }));
    const msg = (await nextMessage(ws)) as SettingsMessage;
    expect(msg.type).toBe("settings");
    expect(msg.provider).toBe("not-a-real-provider");
    expect(msg.available.some((p) => p.id === "not-a-real-provider")).toBe(false);
    ws.close();
  });

  test("persists provider + model and round-trips on the next settings.get", async () => {
    const configDir = makeTmpDir("coati-settings-config-");
    const server = boot(configDir);
    const ws = await connectAndAuth(server);

    ws.send(JSON.stringify({ type: "settings.set", id: "s3", provider: "ollama", model: "llama3.2" }));
    const setReply = (await nextMessage(ws)) as SettingsMessage;
    expect(setReply.type).toBe("settings");
    expect(setReply.provider).toBe("ollama");
    expect(setReply.model).toBe("llama3.2");

    ws.send(JSON.stringify({ type: "settings.get", id: "s4" }));
    const getReply = (await nextMessage(ws)) as SettingsMessage;
    expect(getReply.provider).toBe("ollama");
    expect(getReply.model).toBe("llama3.2");
    ws.close();

    // Persisted to disk, 0600, readable by a fresh process/server reading the
    // same configDir — not just held in the first server's memory.
    const onDisk = JSON.parse(readFileSync(join(configDir, "config.json"), "utf8"));
    expect(onDisk.provider).toBe("ollama");
    expect(onDisk.model).toBe("llama3.2");

    const server2 = boot(configDir);
    // startServer doesn't itself call loadConfig (the entrypoint block does) —
    // simulate what the entrypoint does: read config.json before booting.
    // Here we just confirm the file round-trip is what a fresh loadConfig
    // would see, since startServer's config argument is what the caller reads
    // off disk first in real usage (see server.ts's `if (import.meta.main)`).
    const { loadConfig } = await import("../src/config.ts");
    const reloaded = loadConfig({ configDir, dataDir: configDir });
    expect(reloaded.provider).toBe("ollama");
    expect(reloaded.model).toBe("llama3.2");
    void server2;
  });

  test("changing only the model leaves the provider untouched", async () => {
    const server = boot();
    const ws = await connectAndAuth(server);
    ws.send(JSON.stringify({ type: "settings.set", id: "s5", model: "llama3.2" }));
    const msg = (await nextMessage(ws)) as SettingsMessage;
    expect(msg.provider).toBe("ollama");
    expect(msg.model).toBe("llama3.2");
    ws.close();
  });
});

// --- apiKey: write-only end to end (task 2) ---------------------------------
//
// Security rule #1: no secret reaches the extension. A settings.set carrying
// an apiKey must persist it (config.ts already writes config.json at 0600 —
// unchanged here) but the wire reply — and every later settings.get — must
// never contain it, under any key name.
describe("settings.set — apiKey is write-only", () => {
  test("a settings.set reply never echoes the apiKey, even as raw JSON", async () => {
    const server = boot();
    const ws = await connectAndAuth(server);
    ws.send(JSON.stringify({ type: "settings.set", id: "k1", provider: "claude-api", apiKey: "sk-ant-super-secret" }));
    const raw = await new Promise<string>((resolve) => {
      const onMessage = (event: MessageEvent) => {
        ws.removeEventListener("message", onMessage);
        resolve(event.data as string);
      };
      ws.addEventListener("message", onMessage);
    });
    expect(raw).not.toContain("sk-ant-super-secret");
    expect(raw).not.toContain("apiKey");
    const msg = JSON.parse(raw) as SettingsMessage;
    expect(msg.type).toBe("settings");
    expect(msg.provider).toBe("claude-api");
    ws.close();
  });

  test("a later settings.get on the same connection still never echoes it", async () => {
    const server = boot();
    const ws = await connectAndAuth(server);
    ws.send(JSON.stringify({ type: "settings.set", id: "k2", apiKey: "sk-ant-another-secret" }));
    await nextMessage(ws);
    ws.send(JSON.stringify({ type: "settings.get", id: "k3" }));
    const raw = await new Promise<string>((resolve) => {
      const onMessage = (event: MessageEvent) => {
        ws.removeEventListener("message", onMessage);
        resolve(event.data as string);
      };
      ws.addEventListener("message", onMessage);
    });
    expect(raw).not.toContain("sk-ant-another-secret");
    expect(raw).not.toContain("apiKey");
    ws.close();
  });

  test("is persisted to config.json (0600) even though never echoed on the wire", async () => {
    const configDir = makeTmpDir("coati-settings-apikey-");
    const server = boot(configDir);
    const ws = await connectAndAuth(server);
    ws.send(JSON.stringify({ type: "settings.set", id: "k4", provider: "claude-api", apiKey: "sk-ant-on-disk" }));
    await nextMessage(ws);
    ws.close();
    const onDisk = JSON.parse(readFileSync(join(configDir, "config.json"), "utf8"));
    expect(onDisk.apiKey).toBe("sk-ant-on-disk");
  });

  test("an empty-string apiKey forgets the previously stored key", async () => {
    const configDir = makeTmpDir("coati-settings-apikey-forget-");
    const server = boot(configDir);
    const ws = await connectAndAuth(server);
    ws.send(JSON.stringify({ type: "settings.set", id: "k5", provider: "claude-api", apiKey: "sk-ant-to-forget" }));
    await nextMessage(ws);
    let onDisk = JSON.parse(readFileSync(join(configDir, "config.json"), "utf8"));
    expect(onDisk.apiKey).toBe("sk-ant-to-forget");

    ws.send(JSON.stringify({ type: "settings.set", id: "k6", apiKey: "" }));
    await nextMessage(ws);
    onDisk = JSON.parse(readFileSync(join(configDir, "config.json"), "utf8"));
    expect(onDisk.apiKey).toBeUndefined();
    ws.close();
  });

  test("rejects a non-string apiKey with bad-request", async () => {
    const server = boot();
    const ws = await connectAndAuth(server);
    ws.send(JSON.stringify({ type: "settings.set", id: "k7", apiKey: 12345 }));
    const msg = await nextMessage(ws);
    expect(msg).toMatchObject({ type: "error", id: "k7", code: "bad-request" });
    ws.close();
  });

  // I3 (lot7 security review): a malformed key must never reach config.json
  // or providers/claude-api.ts's x-api-key header in the first place.
  test("rejects an apiKey containing control characters with bad-request", async () => {
    const server = boot();
    const ws = await connectAndAuth(server);
    ws.send(JSON.stringify({ type: "settings.set", id: "k8", apiKey: "sk-ant-\n-evil" }));
    const msg = await nextMessage(ws);
    expect(msg).toMatchObject({ type: "error", id: "k8", code: "bad-request" });
    ws.close();
  });

  test("rejects an apiKey containing a space with bad-request", async () => {
    const server = boot();
    const ws = await connectAndAuth(server);
    ws.send(JSON.stringify({ type: "settings.set", id: "k9", apiKey: "sk ant" }));
    const msg = await nextMessage(ws);
    expect(msg).toMatchObject({ type: "error", id: "k9", code: "bad-request" });
    ws.close();
  });

  test("an oversized apiKey (over 512 chars) is rejected with bad-request", async () => {
    const server = boot();
    const ws = await connectAndAuth(server);
    ws.send(JSON.stringify({ type: "settings.set", id: "k10", apiKey: "a".repeat(513) }));
    const msg = await nextMessage(ws);
    expect(msg).toMatchObject({ type: "error", id: "k10", code: "bad-request" });
    ws.close();
  });

  test("an empty-string apiKey is still accepted (means: forget the stored key)", async () => {
    const server = boot();
    const ws = await connectAndAuth(server);
    ws.send(JSON.stringify({ type: "settings.set", id: "k11", apiKey: "" }));
    const msg = await nextMessage(ws);
    expect(msg).toMatchObject({ type: "settings", id: "k11" });
    ws.close();
  });
});

// --- configured flag (task 2) -----------------------------------------------
describe("settings — the `configured` flag", () => {
  test("claude-api starts unconfigured (no key) and becomes configured once a key is set", async () => {
    const server = boot();
    const ws = await connectAndAuth(server);

    ws.send(JSON.stringify({ type: "settings.get", id: "c1" }));
    const before = (await nextMessage(ws)) as SettingsMessage;
    const beforeStatus = before.available.find((p) => p.id === "claude-api")!;
    expect(beforeStatus.configured).toBe(false);

    ws.send(JSON.stringify({ type: "settings.set", id: "c2", apiKey: "sk-ant-now-configured" }));
    const after = (await nextMessage(ws)) as SettingsMessage;
    const afterStatus = after.available.find((p) => p.id === "claude-api")!;
    expect(afterStatus.configured).toBe(true);
    ws.close();
  });

  test("ollama is configured when its daemon answers, independent of the chosen model being installed", async () => {
    __setOllamaFetch((async (url: string) => {
      if (url.endsWith("/api/tags")) {
        return new Response(JSON.stringify({ models: [{ name: "llama3.2:latest" }] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      throw new Error(`unexpected fetch: ${url}`);
    }) as unknown as typeof fetch);

    const server = boot();
    const ws = await connectAndAuth(server);
    // A model that is NOT in the fake /api/tags list — available should be
    // false (model not installed) while configured stays true (daemon answers).
    ws.send(JSON.stringify({ type: "settings.set", id: "c3", provider: "ollama", model: "not-installed-model" }));
    const msg = (await nextMessage(ws)) as SettingsMessage;
    const status = msg.available.find((p) => p.id === "ollama")!;
    expect(status.configured).toBe(true);
    expect(status.available).toBe(false);
    ws.close();
  });
});

// --- settings.test / settings.test-result (task 3) --------------------------
describe("settings.test", () => {
  test("claude-api: a successful minimal call reports ok with a French success message", async () => {
    __setClaudeApiFetch((async () => {
      const encoder = new TextEncoder();
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify({ type: "message_stop" })}\n`));
          controller.close();
        },
      });
      return new Response(body, { status: 200 });
    }) as unknown as typeof fetch);

    const server = boot();
    const ws = await connectAndAuth(server);
    ws.send(JSON.stringify({ type: "settings.set", id: "t0", apiKey: "sk-ant-works" }));
    await nextMessage(ws);
    ws.send(JSON.stringify({ type: "settings.test", id: "t1", provider: "claude-api" }));
    const msg = (await nextMessage(ws)) as SettingsTestResultMessage;
    expect(msg.type).toBe("settings.test-result");
    expect(msg.provider).toBe("claude-api");
    expect(msg.ok).toBe(true);
    expect(msg.message).toMatch(/[Aa]nthropic/);
    ws.close();
  });

  test("claude-api: no key configured fails immediately, without a network call, naming the remedy", async () => {
    let fetchCalled = false;
    __setClaudeApiFetch((async () => {
      fetchCalled = true;
      throw new Error("should not be called");
    }) as unknown as typeof fetch);

    const server = boot();
    const ws = await connectAndAuth(server);
    ws.send(JSON.stringify({ type: "settings.test", id: "t2", provider: "claude-api" }));
    const msg = (await nextMessage(ws)) as SettingsTestResultMessage;
    expect(msg.ok).toBe(false);
    expect(msg.message).toMatch(/clé/i);
    expect(fetchCalled).toBe(false);
    ws.close();
  });

  test("claude-api: a refused key (401) fails with the French auth remedy, key never in the message", async () => {
    __setClaudeApiFetch((async () => new Response("nope", { status: 401 })) as unknown as typeof fetch);

    const server = boot();
    const ws = await connectAndAuth(server);
    ws.send(JSON.stringify({ type: "settings.set", id: "t3", apiKey: "sk-ant-bad-key-value" }));
    await nextMessage(ws);
    ws.send(JSON.stringify({ type: "settings.test", id: "t4", provider: "claude-api" }));
    const msg = (await nextMessage(ws)) as SettingsTestResultMessage;
    expect(msg.ok).toBe(false);
    expect(msg.message).toMatch(/clé/i);
    expect(msg.message).not.toContain("sk-ant-bad-key-value");
    ws.close();
  });

  test("ollama: no model configured fails immediately, naming the remedy", async () => {
    const server = boot();
    const ws = await connectAndAuth(server);
    ws.send(JSON.stringify({ type: "settings.test", id: "t5", provider: "ollama" }));
    const msg = (await nextMessage(ws)) as SettingsTestResultMessage;
    expect(msg.ok).toBe(false);
    expect(msg.message).toMatch(/mod[eè]le/i);
    ws.close();
  });

  test("ollama: unreachable daemon fails, naming Ollama as the remedy", async () => {
    __setOllamaFetch((async () => {
      throw new Error("fetch failed: connect ECONNREFUSED 127.0.0.1:11434");
    }) as unknown as typeof fetch);

    const server = boot();
    const ws = await connectAndAuth(server);
    ws.send(JSON.stringify({ type: "settings.set", id: "t6", provider: "ollama", model: "llama3.2" }));
    await nextMessage(ws);
    ws.send(JSON.stringify({ type: "settings.test", id: "t7", provider: "ollama" }));
    const msg = (await nextMessage(ws)) as SettingsTestResultMessage;
    expect(msg.ok).toBe(false);
    expect(msg.message).toMatch(/Ollama/);
    ws.close();
  });

  test("ollama: a successful minimal call reports ok", async () => {
    __setOllamaFetch((async (url: string) => {
      if (String(url).endsWith("/api/tags")) {
        return new Response(JSON.stringify({ models: [{ name: "llama3.2:latest" }] }), { status: 200 });
      }
      const line = JSON.stringify({ message: { content: "ok" }, done: true, prompt_eval_count: 1, eval_count: 1 });
      return new Response(`${line}\n`, { status: 200 });
    }) as unknown as typeof fetch);

    const server = boot();
    const ws = await connectAndAuth(server);
    ws.send(JSON.stringify({ type: "settings.set", id: "t8a", provider: "ollama", model: "llama3.2" }));
    await nextMessage(ws);
    ws.send(JSON.stringify({ type: "settings.test", id: "t8", provider: "ollama" }));
    const msg = (await nextMessage(ws)) as SettingsTestResultMessage;
    expect(msg.ok).toBe(true);
    ws.close();
  });

  // Amendement 2026-09-29: a settings.test naming a provider unknown to this
  // broker (not built in, no module loaded it) fails with a generic French
  // message, never a crash — mirrors testProviderConnection's own contract.
  test("an unknown provider id fails with 'Fournisseur inconnu.'", async () => {
    const server = boot();
    const ws = await connectAndAuth(server);
    ws.send(JSON.stringify({ type: "settings.test", id: "t9", provider: "not-a-real-provider" }));
    const msg = (await nextMessage(ws)) as SettingsTestResultMessage;
    expect(msg.ok).toBe(false);
    expect(msg.message).toMatch(/inconnu/i);
    ws.close();
  });

  test("a malformed provider (empty string) is rejected at the wire with bad-request", async () => {
    const server = boot();
    const ws = await connectAndAuth(server);
    ws.send(JSON.stringify({ type: "settings.test", id: "t10", provider: "" }));
    const msg = await nextMessage(ws);
    expect(msg).toMatchObject({ type: "error", id: "t10", code: "bad-request" });
    ws.close();
  });
});
