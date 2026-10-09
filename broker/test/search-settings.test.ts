// Lot C1 — integration tests over the real WebSocket wire (docs/PROTOCOL.md
// §9 "Réglages de recherche" + §9bis "clearKey"): write-only search key,
// `settings.search` echo, `settings.test` target "search", `clearKey`
// leaving the active provider/model untouched, and the handshake's
// `features` advertising "docsearch".

import { describe, expect, test, afterEach } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { startServer } from "../src/server.ts";
import type { ServerMessage, SettingsMessage, SettingsTestResultMessage } from "../src/protocol.ts";
import { makeTmpDir } from "./helpers/tmp-dir.ts";
import { __setFetchImplForTests as __setBraveFetch, __resetFetchImplForTests as __resetBraveFetch } from "../src/search/brave.ts";
import {
  __setFetchImplForTests as __setSafeFetch,
  __resetFetchImplForTests as __resetSafeFetch,
  __setLookupImplForTests,
  __resetLookupImplForTests,
} from "../src/search/safe-fetch.ts";
import { connectAndAuthV2OrThrow } from "./helpers/handshake-v2.ts";

const ALLOWED_ID = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const KEY = Buffer.from("0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcd", "hex");

let servers: ReturnType<typeof startServer>[] = [];

function boot(configDir?: string) {
  const dataDir = makeTmpDir("coati-search-settings-");
  const server = startServer({ port: 0, allowedExtensionIds: [ALLOWED_ID] }, KEY, { dataDir, configDir });
  servers.push(server);
  return server;
}

afterEach(() => {
  for (const s of servers) s.stop(true);
  servers = [];
  __resetBraveFetch();
});

async function connectAndAuth(server: ReturnType<typeof startServer>): Promise<{ ws: WebSocket }> {
  const ws = await connectAndAuthV2OrThrow(`ws://127.0.0.1:${server.port}/ws`, `chrome-extension://${ALLOWED_ID}`, KEY);
  return { ws };
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

describe("BROKER_FEATURES", () => {
  test("advertises docsearch", async () => {
    const { BROKER_FEATURES } = await import("../src/server.ts");
    expect(BROKER_FEATURES).toContain("docsearch");
  });
});

describe("settings.set — search fields", () => {
  test("searchApiKey is write-only: settings never echoes it, only `configured`", async () => {
    const server = boot();
    const { ws } = await connectAndAuth(server);
    ws.send(JSON.stringify({ type: "settings.set", id: "s1", searchProvider: "brave", searchApiKey: "my-secret-key" }));
    const reply = (await nextMessage(ws)) as SettingsMessage;
    expect(reply.type).toBe("settings");
    expect(reply.search).toEqual({ provider: "brave", configured: true });
    expect(JSON.stringify(reply)).not.toContain("my-secret-key");
    ws.close();
  });

  test("searchProvider + searchKeys persist to config.json across a fresh server instance", async () => {
    const configDir = makeTmpDir("coati-search-config-");
    const server1 = boot(configDir);
    const { ws: ws1 } = await connectAndAuth(server1);
    ws1.send(JSON.stringify({ type: "settings.set", id: "s1", searchProvider: "tavily", searchApiKey: "tvly-key" }));
    await nextMessage(ws1);
    ws1.close();

    const raw = readFileSync(join(configDir, "config.json"), "utf8");
    const onDisk = JSON.parse(raw);
    expect(onDisk.searchProvider).toBe("tavily");
    expect(onDisk.searchKeys).toEqual({ tavily: "tvly-key" });

    // startServer(config, ...) never reads config.json itself — same
    // "unit-level against loadConfig directly" pattern as settings.test.ts's
    // own round-trip tests (see that file's comment).
    const { loadConfig } = await import("../src/config.ts");
    const reloaded = loadConfig({ configDir, dataDir: configDir });
    expect(reloaded.searchProvider).toBe("tavily");
    expect(reloaded.searchKeys).toEqual({ tavily: "tvly-key" });
  });

  test("searchProvider '' forgets the stored choice", async () => {
    const server = boot();
    const { ws } = await connectAndAuth(server);
    ws.send(JSON.stringify({ type: "settings.set", id: "s1", searchProvider: "brave", searchApiKey: "k" }));
    await nextMessage(ws);
    ws.send(JSON.stringify({ type: "settings.set", id: "s2", searchProvider: "" }));
    const reply = (await nextMessage(ws)) as SettingsMessage;
    expect(reply.search.provider).toBeNull();
    ws.close();
  });

  test("rejects an invalid searchProvider at the wire", async () => {
    const server = boot();
    const { ws } = await connectAndAuth(server);
    ws.send(JSON.stringify({ type: "settings.set", id: "s1", searchProvider: "google" }));
    const reply = await nextMessage(ws);
    expect(reply.type).toBe("error");
    ws.close();
  });
});

describe("clearKey — EXTRA task, docs/PROTOCOL.md §9bis", () => {
  test("clears a model provider's key WITHOUT touching the active provider/model", async () => {
    const server = boot();
    const { ws } = await connectAndAuth(server);
    ws.send(JSON.stringify({ type: "settings.set", id: "s1", provider: "claude-api", model: "claude-x", apiKey: "sk-abc" }));
    const afterSet = (await nextMessage(ws)) as SettingsMessage;
    expect(afterSet.provider).toBe("claude-api");
    expect(afterSet.available.find((p) => p.id === "claude-api")?.configured).toBe(true);

    ws.send(JSON.stringify({ type: "settings.set", id: "s2", clearKey: "claude-api" }));
    const afterClear = (await nextMessage(ws)) as SettingsMessage;
    expect(afterClear.provider).toBe("claude-api"); // untouched
    expect(afterClear.model).toBe("claude-x"); // untouched
    expect(afterClear.available.find((p) => p.id === "claude-api")?.configured).toBe(false);
    ws.close();
  });

  test("clears a search engine's key via the same field", async () => {
    const server = boot();
    const { ws } = await connectAndAuth(server);
    ws.send(JSON.stringify({ type: "settings.set", id: "s1", searchProvider: "brave", searchApiKey: "k" }));
    await nextMessage(ws);
    ws.send(JSON.stringify({ type: "settings.set", id: "s2", clearKey: "brave" }));
    const reply = (await nextMessage(ws)) as SettingsMessage;
    expect(reply.search).toEqual({ provider: "brave", configured: false }); // provider choice kept, key gone
    ws.close();
  });
});

describe("settings.test — target search", () => {
  test("ok on a successful probe, shape unchanged (ok/message/code?)", async () => {
    __setBraveFetch(async () =>
      new Response(JSON.stringify({ web: { results: [] } }), { status: 200, headers: { "content-type": "application/json" } }),
    );
    const server = boot();
    const { ws } = await connectAndAuth(server);
    ws.send(JSON.stringify({ type: "settings.set", id: "s1", searchProvider: "brave", searchApiKey: "k" }));
    await nextMessage(ws);
    ws.send(JSON.stringify({ type: "settings.test", id: "t1", target: "search", searchProvider: "brave" }));
    const reply = (await nextMessage(ws)) as SettingsTestResultMessage;
    expect(reply.type).toBe("settings.test-result");
    expect(reply.ok).toBe(true);
    expect(typeof reply.message).toBe("string");
    ws.close();
  });

  test("no key configured — auth-required, named remedy", async () => {
    const server = boot();
    const { ws } = await connectAndAuth(server);
    ws.send(JSON.stringify({ type: "settings.test", id: "t1", target: "search", searchProvider: "brave" }));
    const reply = (await nextMessage(ws)) as SettingsTestResultMessage;
    expect(reply.ok).toBe(false);
    expect(reply.code).toBe("auth-required");
    ws.close();
  });
});

describe("chat.docSearch — not configured", () => {
  test("replies with error code search-not-configured, never a silent fallback", async () => {
    const server = boot();
    const { ws } = await connectAndAuth(server);
    ws.send(
      JSON.stringify({
        type: "chat",
        id: "c1",
        // Amendment 2026-10-08 (bis): no more button — a search only runs
        // when the TEXT itself explicitly asks for one (search/intent.ts).
        text: "search the docs: how do I export?",
        docSearch: { origin: "https://app.example.com" },
      }),
    );
    const reply = await nextMessage(ws);
    expect(reply.type).toBe("error");
    if (reply.type === "error") expect(reply.code).toBe("search-not-configured");
    ws.close();
  });

  test("a second concurrent docSearch chat on the same connection is rejected (one in flight, R5)", async () => {
    const server = boot();
    const { ws } = await connectAndAuth(server);
    // Neither is configured, so both resolve almost immediately — this only
    // exercises the gate's synchronous "already in flight" guard being able
    // to fire at all when invoked back to back, not a real race; a genuine
    // slow-search race is covered by code review (connState.docSearching is
    // set before any await — see server.ts's handleChatDocSearch).
    ws.send(
      JSON.stringify({ type: "chat", id: "c1", text: "search the docs for q1", docSearch: { origin: "https://app.example.com" } }),
    );
    ws.send(
      JSON.stringify({ type: "chat", id: "c2", text: "search the docs for q2", docSearch: { origin: "https://app.example.com" } }),
    );
    const first = await nextMessage(ws);
    const second = await nextMessage(ws);
    const codes = [first, second].map((m) => (m.type === "error" ? m.code : undefined));
    expect(codes).toContain("search-not-configured");
    ws.close();
  });
});

describe("security review 2026-10-08 — L9: cancel/close during the search phase", () => {
  test("a cancel for the chat id while the search is in flight stops it — no model stream starts", async () => {
    const { __setFetchImplForTests: setBraveFetch, __resetFetchImplForTests: resetBraveFetch } = await import(
      "../src/search/brave.ts"
    );
    // Only the FIRST Brave call is held open (under the test's own control,
    // via resolveSearch) — the ladder (doc-search.ts) can make a SECOND,
    // unfiltered call when the site-domain-filtered first call comes back
    // empty (see "ladder" tests in search-doc-search.test.ts); that second
    // call must resolve on its own or this test would hang forever waiting
    // on a resolver nobody calls.
    let resolveSearch!: () => void;
    let braveCalls = 0;
    setBraveFetch(() => {
      braveCalls++;
      if (braveCalls === 1) {
        return new Promise((resolve) => {
          resolveSearch = () => resolve(new Response(JSON.stringify({ web: { results: [] } }), { status: 200 }));
        });
      }
      return Promise.resolve(new Response(JSON.stringify({ web: { results: [] } }), { status: 200 }));
    });
    // discoverDocSite's own network calls (safe-fetch.ts) are NOT the thing
    // under test here — without this mock they'd hit the real network for
    // "app.example.com" and the test's timing would depend on real DNS/TCP
    // behaviour. Resolve every probe to a fast 404 (no doc subdomain found,
    // scope stays null) so only the (deliberately hanging) Brave call above
    // controls the timing.
    __setLookupImplForTests(async () => [{ address: "203.0.0.9", family: 4 as const }]);
    __setSafeFetch(async () => new Response(null, { status: 404 }));
    const server = boot();
    const { ws } = await connectAndAuth(server);
    ws.send(JSON.stringify({ type: "settings.set", id: "s1", searchProvider: "brave", searchApiKey: "k" }));
    await nextMessage(ws); // settings reply

    ws.send(
      JSON.stringify({
        type: "chat",
        id: "c1",
        text: "search the docs: how do I export?",
        docSearch: { origin: "https://app.example.com" },
      }),
    );
    // Give the search phase a moment to actually start (register in `active`)
    // before cancelling it — mirrors a real user clicking "stop" mid-search.
    await new Promise((r) => setTimeout(r, 20));
    ws.send(JSON.stringify({ type: "cancel", id: "x1", target: "c1" }));
    // Give the cancel message time to actually reach and be processed by
    // the server over the (real, if loopback) socket before resolving the
    // pending search call — otherwise the two could race.
    await new Promise((r) => setTimeout(r, 20));
    resolveSearch(); // let the (now-cancelled) search call finally settle

    const reply = (await nextMessage(ws)) as ServerMessage;
    expect(reply.type).toBe("error");
    if (reply.type === "error") expect(reply.code).toBe("cancelled");

    resetBraveFetch();
    __resetSafeFetch();
    __resetLookupImplForTests();
    ws.close();
  });
});
