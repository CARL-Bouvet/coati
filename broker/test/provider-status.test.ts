// `provider.status` — docs/PROTOCOL.md "Disponibilité du fournisseur"
// (amendement 2026-09-25 / 2026-09-25 bis). Three layers:
//   1. broker/src/provider-status.ts's ProviderStatusCache — 60s cache,
//      shared in-flight probe, cleared on demand.
//   2. Each provider's own checkStatus() reason-code table.
//   3. server.ts wiring: `provider.status` -> `provider.status-result`,
//      cache cleared on settings.set, no automatic provider switch.

import { describe, expect, test, afterEach } from "bun:test";
import { ProviderStatusCache } from "../src/provider-status.ts";
import { startServer } from "../src/server.ts";
import { claudeApiProvider } from "../src/providers/claude-api.ts";
import { makeTmpDir } from "./helpers/tmp-dir.ts";
import { ollamaProvider, __setFetchImplForTests, __resetFetchImplForTests } from "../src/providers/ollama.ts";
import { connectAndAuthV2OrThrow } from "./helpers/handshake-v2.ts";

afterEach(() => {
  __resetFetchImplForTests();
});

// --- 1. ProviderStatusCache — generic caching mechanics --------------------

describe("ProviderStatusCache", () => {
  function fakeOllamaFetch(calls: { n: number }): typeof fetch {
    return (async () => {
      calls.n++;
      return new Response(JSON.stringify({ models: [{ name: "llama3.2:latest" }] }), { status: 200 });
    }) as unknown as typeof fetch;
  }

  test("a second get() within the TTL, same key, does not re-probe", async () => {
    const calls = { n: 0 };
    __setFetchImplForTests(fakeOllamaFetch(calls));
    let now = 0;
    const cache = new ProviderStatusCache(() => now);

    const opts = { model: "llama3.2", ollamaUrl: "http://x" };
    const first = await cache.get("ollama", opts);
    const second = await cache.get("ollama", opts);
    expect(calls.n).toBe(1);
    expect(second).toEqual(first);
  });

  test("a get() past the 60s TTL re-probes", async () => {
    const calls = { n: 0 };
    __setFetchImplForTests(fakeOllamaFetch(calls));
    let now = 0;
    const cache = new ProviderStatusCache(() => now);
    const opts = { model: "llama3.2", ollamaUrl: "http://x" };

    await cache.get("ollama", opts);
    now = 60_001;
    await cache.get("ollama", opts);
    expect(calls.n).toBe(2);
  });

  test("a different key (model changed) is never served the other key's cached answer", async () => {
    const calls = { n: 0 };
    __setFetchImplForTests(fakeOllamaFetch(calls));
    const cache = new ProviderStatusCache(() => 0);

    await cache.get("ollama", { model: "llama3.2", ollamaUrl: "http://x" });
    await cache.get("ollama", { model: "mistral", ollamaUrl: "http://x" });
    expect(calls.n).toBe(2);
  });

  test("two concurrent get()s during one in-flight probe share it — a single underlying probe", async () => {
    let resolveFetch!: (r: Response) => void;
    let calls = 0;
    __setFetchImplForTests((async () => {
      calls++;
      return new Promise<Response>((resolve) => {
        resolveFetch = resolve;
      });
    }) as unknown as typeof fetch);
    const cache = new ProviderStatusCache(() => 0);

    const opts = { model: "llama3.2", ollamaUrl: "http://x" };
    const p1 = cache.get("ollama", opts);
    const p2 = cache.get("ollama", opts);
    resolveFetch(new Response(JSON.stringify({ models: [{ name: "llama3.2:latest" }] }), { status: 200 }));
    const [r1, r2] = await Promise.all([p1, p2]);
    expect(calls).toBe(1);
    expect(r1).toEqual(r2);
  });

  test("clear() forces the next get() to re-probe", async () => {
    const calls = { n: 0 };
    __setFetchImplForTests(fakeOllamaFetch(calls));
    const cache = new ProviderStatusCache(() => 0);
    const opts = { model: "llama3.2", ollamaUrl: "http://x" };

    await cache.get("ollama", opts);
    cache.clear();
    await cache.get("ollama", opts);
    expect(calls.n).toBe(2);
  });

  // L3 (lot7 security review): clear() must also empty the in-flight map —
  // otherwise a probe stuck forever (a subprocess-backed provider's own
  // checkStatus could hang) leaves every later get() for that key awaiting the same stuck promise,
  // even past an explicit clear() meant to force a fresh probe.
  test("clear() while a probe is in flight frees the next get() to start a fresh probe, not await the stuck one", async () => {
    let calls = 0;
    let resolveFirstFetch!: (r: Response) => void;
    __setFetchImplForTests((async () => {
      calls++;
      if (calls === 1) {
        return new Promise<Response>((resolve) => {
          resolveFirstFetch = resolve;
        });
      }
      return new Response(JSON.stringify({ models: [{ name: "llama3.2:latest" }] }), { status: 200 });
    }) as unknown as typeof fetch);
    const cache = new ProviderStatusCache(() => 0);
    const opts = { model: "llama3.2", ollamaUrl: "http://x" };

    const stuck = cache.get("ollama", opts); // never resolves until resolveFirstFetch is called
    cache.clear();
    const second = await cache.get("ollama", opts); // must NOT await `stuck`'s shared promise
    expect(calls).toBe(2);
    expect(second.state).toBe("ok");

    resolveFirstFetch(new Response(JSON.stringify({ models: [{ name: "llama3.2:latest" }] }), { status: 200 }));
    await stuck;
  });

  test("an unknown provider id reports unknown/probe-failed rather than throwing", async () => {
    const cache = new ProviderStatusCache(() => 0);
    const result = await cache.get("nonsense" as any, {});
    expect(result.state).toBe("unknown");
    expect(result.reason).toBe("probe-failed");
  });

  test("checkedAt is the ORIGINAL probe's time for a cache hit, not now", async () => {
    __setFetchImplForTests(fakeOllamaFetch({ n: 0 }));
    let now = 1000;
    const cache = new ProviderStatusCache(() => now);
    const opts = { model: "llama3.2", ollamaUrl: "http://x" };

    const first = await cache.get("ollama", opts);
    now = 5000;
    const second = await cache.get("ollama", opts);
    expect(second.checkedAt).toBe(first.checkedAt);
  });
});

// --- 2. Per-provider checkStatus() reason codes -----------------------------

describe("claude-api checkStatus", () => {
  test("no key configured: ko / no-key", async () => {
    expect(await claudeApiProvider.checkStatus({})).toEqual({ state: "ko", reason: "no-key" });
  });

  test("a key present, never validated: unknown / key-unverified (presence only, per lot3 open detail 1)", async () => {
    expect(await claudeApiProvider.checkStatus({ apiKey: "sk-ant-fake" })).toEqual({
      state: "unknown",
      reason: "key-unverified",
    });
  });

  test("a whitespace-only key counts as no key", async () => {
    expect(await claudeApiProvider.checkStatus({ apiKey: "   " })).toEqual({ state: "ko", reason: "no-key" });
  });
});

// A per-provider checkStatus describe block for a personal, subprocess-backed
// provider used to live here (goal G1b, 29/09 ménage du dépôt public) — moved
// to that provider's own private module test suite. See docs/MODULES.md for
// the module contract it now tests against.

describe("ollama checkStatus", () => {
  test("daemon unreachable -> ko / ollama-unreachable", async () => {
    __setFetchImplForTests((async () => {
      throw new Error("connection refused");
    }) as unknown as typeof fetch);
    expect(await ollamaProvider.checkStatus({ ollamaUrl: "http://127.0.0.1:11434" })).toEqual({
      state: "ko",
      reason: "ollama-unreachable",
    });
  });

  test("configured model not installed -> ko / model-missing", async () => {
    __setFetchImplForTests((async () =>
      new Response(JSON.stringify({ models: [{ name: "mistral:latest" }] }), { status: 200 })) as unknown as typeof fetch);
    expect(await ollamaProvider.checkStatus({ model: "llama3.2", ollamaUrl: "http://x" })).toEqual({
      state: "ko",
      reason: "model-missing",
    });
  });

  test("no model configured and none installed -> ko / no-model-installed", async () => {
    __setFetchImplForTests((async () =>
      new Response(JSON.stringify({ models: [] }), { status: 200 })) as unknown as typeof fetch);
    expect(await ollamaProvider.checkStatus({ ollamaUrl: "http://x" })).toEqual({
      state: "ko",
      reason: "no-model-installed",
    });
  });

  test("configured model installed -> ok / ready", async () => {
    __setFetchImplForTests((async () =>
      new Response(JSON.stringify({ models: [{ name: "llama3.2:latest" }] }), { status: 200 })) as unknown as typeof fetch);
    expect(await ollamaProvider.checkStatus({ model: "llama3.2", ollamaUrl: "http://x" })).toEqual({
      state: "ok",
      reason: "ready",
    });
  });

  test("no model configured but the daemon has models installed -> ok / ready", async () => {
    __setFetchImplForTests((async () =>
      new Response(JSON.stringify({ models: [{ name: "llama3.2:latest" }] }), { status: 200 })) as unknown as typeof fetch);
    expect(await ollamaProvider.checkStatus({ ollamaUrl: "http://x" })).toEqual({ state: "ok", reason: "ready" });
  });
});

// Goal U2 (docs/PROTOCOL.md "settings.test", amendement 2026-10-01): same
// free /api/tags probe as checkStatus above, reshaped as TestConnectionResult
// — the task brief's required distinction is model-missing (daemon up,
// configured model absent) vs model-unavailable (daemon unreachable).
describe("ollama testConnection (goal U2)", () => {
  test("daemon unreachable -> model-unavailable", async () => {
    __setFetchImplForTests((async () => {
      throw new Error("connection refused");
    }) as unknown as typeof fetch);
    expect(await ollamaProvider.testConnection!({ model: "llama3.2", ollamaUrl: "http://127.0.0.1:11434" })).toEqual({
      ok: false,
      code: "model-unavailable",
    });
  });

  test("configured model not installed -> model-missing, distinct from model-unavailable", async () => {
    __setFetchImplForTests((async () =>
      new Response(JSON.stringify({ models: [{ name: "mistral:latest" }] }), { status: 200 })) as unknown as typeof fetch);
    expect(await ollamaProvider.testConnection!({ model: "llama3.2", ollamaUrl: "http://x" })).toEqual({
      ok: false,
      code: "model-missing",
    });
  });

  test("no model configured -> model-unavailable, without pretending success", async () => {
    __setFetchImplForTests((async () =>
      new Response(JSON.stringify({ models: [{ name: "llama3.2:latest" }] }), { status: 200 })) as unknown as typeof fetch);
    expect(await ollamaProvider.testConnection!({ ollamaUrl: "http://x" })).toEqual({
      ok: false,
      code: "model-unavailable",
    });
  });

  test("configured model installed -> ok, no code", async () => {
    __setFetchImplForTests((async () =>
      new Response(JSON.stringify({ models: [{ name: "llama3.2:latest" }] }), { status: 200 })) as unknown as typeof fetch);
    expect(await ollamaProvider.testConnection!({ model: "llama3.2", ollamaUrl: "http://x" })).toEqual({ ok: true });
  });
});

// --- 3. server.ts wiring: provider.status -> provider.status-result --------

describe("server.ts — provider.status wiring", () => {
  const ALLOWED_ID = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
  const KEY = Buffer.from("0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcd", "hex");

  let servers: ReturnType<typeof startServer>[] = [];
  afterEach(() => {
    for (const s of servers) s.stop(true);
    servers = [];
  });

  function boot(overrides: Partial<Parameters<typeof startServer>[0]> = {}) {
    const dataDir = makeTmpDir("coati-provider-status-");
    const configDir = makeTmpDir("coati-provider-status-cfg-");
    const server = startServer(
      { port: 0, allowedExtensionIds: [ALLOWED_ID], provider: "ollama", ollamaUrl: "http://x", ...overrides },
      KEY,
      { dataDir, configDir },
    );
    servers.push(server);
    return server;
  }

  async function connectAndAuth(server: ReturnType<typeof startServer>): Promise<WebSocket> {
    return connectAndAuthV2OrThrow(`ws://127.0.0.1:${server.port}/ws`, `chrome-extension://${ALLOWED_ID}`, KEY);
  }

  function request(ws: WebSocket, msg: object): Promise<any> {
    return new Promise((resolve) => {
      const onMessage = (event: MessageEvent) => {
        const parsed = JSON.parse(event.data as string);
        if (parsed.id === (msg as any).id) {
          ws.removeEventListener("message", onMessage);
          resolve(parsed);
        }
      };
      ws.addEventListener("message", onMessage);
      ws.send(JSON.stringify(msg));
    });
  }

  test("provider.status replies provider.status-result for the active provider", async () => {
    __setFetchImplForTests((async () =>
      new Response(JSON.stringify({ models: [] }), { status: 200 })) as unknown as typeof fetch);
    const server = boot();
    const ws = await connectAndAuth(server);
    const result = await request(ws, { type: "provider.status", id: "p1" });
    expect(result.type).toBe("provider.status-result");
    expect(result.provider).toBe("ollama");
    expect(result.state).toBe("ko");
    expect(result.reason).toBe("no-model-installed");
    expect(typeof result.checkedAt).toBe("string");
    ws.close();
  });

  test("a second provider.status shortly after is served from cache — only one probe", async () => {
    const calls = { n: 0 };
    __setFetchImplForTests((async () => {
      calls.n++;
      return new Response(JSON.stringify({ models: [] }), { status: 200 });
    }) as unknown as typeof fetch);
    const server = boot();
    const ws = await connectAndAuth(server);
    await request(ws, { type: "provider.status", id: "p1" });
    await request(ws, { type: "provider.status", id: "p2" });
    expect(calls.n).toBe(1);
    ws.close();
  });

  test("a successful settings.set clears the provider-status cache", async () => {
    const calls = { n: 0 };
    __setFetchImplForTests((async () => {
      calls.n++;
      return new Response(JSON.stringify({ models: [] }), { status: 200 });
    }) as unknown as typeof fetch);
    const server = boot();
    const ws = await connectAndAuth(server);
    await request(ws, { type: "provider.status", id: "p1" });
    // A second provider.status right after is a pure cache hit — no new fetch.
    const beforeSettingsSet = calls.n;
    await request(ws, { type: "provider.status", id: "p1b" });
    expect(calls.n).toBe(beforeSettingsSet);

    // settings.set itself probes availability for the settings payload (a
    // separate, unrelated set of calls) — what matters here is only that the
    // FOLLOWING provider.status is no longer a cache hit.
    await request(ws, { type: "settings.set", id: "s1", model: "llama3.2" });
    const afterSettingsSet = calls.n;
    await request(ws, { type: "provider.status", id: "p2" });
    expect(calls.n).toBeGreaterThan(afterSettingsSet);
    ws.close();
  });

  // docs/PROTOCOL.md "Aucune bascule automatique" / "Règles invariantes": the
  // broker never changes provider on its own — not on a `ko` status.
  test("a ko provider.status never changes the active provider — no automatic switch", async () => {
    __setFetchImplForTests((async () => {
      throw new Error("connection refused");
    }) as unknown as typeof fetch);
    const server = boot();
    const ws = await connectAndAuth(server);

    const status = await request(ws, { type: "provider.status", id: "p1" });
    expect(status.state).toBe("ko");

    const settings = await request(ws, { type: "settings.get", id: "s1" });
    expect(settings.provider).toBe("ollama"); // unchanged — the broker never switched to another provider itself
    ws.close();
  });
});
