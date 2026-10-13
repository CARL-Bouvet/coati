// "page on demand" — docs/PROTOCOL.md "Page on demand". Covers
// protocol parsing (chat.page/devMode, page.content/page.decline, size
// limits), the shared marker detector (model/page-marker.ts), the full
// re-run flow against a fake provider (startServer + __setProvidersForTests,
// same pattern as concurrency.test.ts), decline, read caps, and the English
// scaffolding (model/render.ts, no French left in the on-demand prompt).

import { describe, expect, test, afterEach } from "bun:test";
import {
  parseClientMessage,
  MAX_MESSAGE_BYTES,
  MAX_IMAGE_MESSAGE_BYTES,
  type ChatMessage,
  type ServerMessage,
} from "../src/protocol.ts";
import { buildPrompt } from "../src/model.ts";
import { PageMarkerDetector, MARKER_TEXT, MARKER_DEV } from "../src/model/page-marker.ts";
import { devContentCharBudget, resolveActiveContextTokens, searchCharBudget, PAGE_REQUEST_TIMEOUT_MS, SEARCH_REQUEST_TIMEOUT_MS } from "../src/handlers/chat.ts";
import { startServer, MAX_DEV_CONTEXT_CHARS } from "../src/server.ts";
import { __setProvidersForTests, __resetProvidersForTests } from "../src/providers/registry.ts";
import { __setFetchImplForTests, __resetFetchImplForTests } from "../src/providers/ollama.ts";
import type { ModelProvider } from "../src/providers/types.ts";
import { makeTmpDir } from "./helpers/tmp-dir.ts";
import { connectAndAuthV2OrThrow } from "./helpers/handshake-v2.ts";

// ---------------------------------------------------------------------------
// Protocol parsing
// ---------------------------------------------------------------------------

describe("protocol parsing — chat.page/devMode", () => {
  test("parses a well-formed page metadata field", () => {
    const result = parseClientMessage(
      JSON.stringify({
        type: "chat",
        id: "c1",
        text: "hi",
        page: { title: "T", url: "https://example.com", kind: "article", chars: 1234 },
        devMode: true,
      }),
    );
    expect(result.ok).toBe(true);
    if (result.ok && result.message.type === "chat") {
      expect((result.message as ChatMessage).page).toEqual({
        title: "T",
        url: "https://example.com",
        kind: "article",
        chars: 1234,
      });
      expect((result.message as ChatMessage).devMode).toBe(true);
    }
  });

  test("drops a malformed page field, chat still goes through", () => {
    const result = parseClientMessage(
      JSON.stringify({ type: "chat", id: "c1", text: "hi", page: { title: "T" } }),
    );
    expect(result.ok).toBe(true);
    if (result.ok && result.message.type === "chat") {
      expect((result.message as ChatMessage).page).toBeUndefined();
    }
  });

  test("a chat with both context and page keeps context — page is ignored (point 2)", () => {
    const built = buildPrompt({
      kind: "chat",
      text: "hi",
      context: { kind: "page", text: "real content" },
      page: { title: "T", url: "https://example.com", chars: 10 },
    } as any);
    expect(built.prompt).toContain("real content");
    expect(built.prompt).not.toContain("Page available (not yet read)");
  });
});

describe("protocol parsing — page.content / page.decline", () => {
  test("parses a well-formed page.content", () => {
    const result = parseClientMessage(
      JSON.stringify({
        type: "page.content",
        id: "pc1",
        target: "c1",
        level: "text",
        context: { kind: "page", text: "hello" },
      }),
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.message).toMatchObject({ type: "page.content", target: "c1", level: "text" });
    }
  });

  test("page.content with invalid level is a bad-request", () => {
    const result = parseClientMessage(
      JSON.stringify({ type: "page.content", id: "pc1", target: "c1", level: "nope", context: { kind: "page" } }),
    );
    expect(result.ok).toBe(false);
  });

  test("page.content with no context is a bad-request", () => {
    const result = parseClientMessage(
      JSON.stringify({ type: "page.content", id: "pc1", target: "c1", level: "text" }),
    );
    expect(result.ok).toBe(false);
  });

  test("parses a well-formed page.decline", () => {
    const result = parseClientMessage(JSON.stringify({ type: "page.decline", id: "pd1", target: "c1" }));
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.message).toEqual({ type: "page.decline", id: "pd1", target: "c1" });
  });

  test("a dev-level page.content may exceed MAX_MESSAGE_BYTES, up to MAX_IMAGE_MESSAGE_BYTES", () => {
    const raw = JSON.stringify({
      type: "page.content",
      id: "pc1",
      target: "c1",
      level: "dev",
      context: { kind: "page", text: "x".repeat(MAX_MESSAGE_BYTES + 1000) },
    });
    expect(Buffer.byteLength(raw, "utf8")).toBeGreaterThan(MAX_MESSAGE_BYTES);
    expect(Buffer.byteLength(raw, "utf8")).toBeLessThan(MAX_IMAGE_MESSAGE_BYTES);
    const result = parseClientMessage(raw);
    expect(result.ok).toBe(true);
  });

  test("a text-level page.content over MAX_MESSAGE_BYTES is refused as oversized", () => {
    const raw = JSON.stringify({
      type: "page.content",
      id: "pc1",
      target: "c1",
      level: "text",
      context: { kind: "page", text: "x".repeat(MAX_MESSAGE_BYTES + 1000) },
    });
    const result = parseClientMessage(raw);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.oversized).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// PageMarkerDetector — unit tests
// ---------------------------------------------------------------------------

function feedAll(detector: PageMarkerDetector, chunks: string[]) {
  const events = chunks.flatMap((c) => detector.feed(c));
  return [...events, ...detector.flush()];
}

describe("PageMarkerDetector", () => {
  test("whole answer is exactly the text marker — reported as start, nothing forwarded", () => {
    const d = new PageMarkerDetector({ allowDev: false });
    const events = feedAll(d, [MARKER_TEXT]);
    expect(events).toEqual([{ kind: "marker", marker: { type: "read", level: "text" }, position: "start" }]);
  });

  test("marker split across chunk boundaries at the start is still detected", () => {
    const d = new PageMarkerDetector({ allowDev: false });
    const events = feedAll(d, ["[[READ_", "PAGE]]"]);
    expect(events).toEqual([{ kind: "marker", marker: { type: "read", level: "text" }, position: "start" }]);
  });

  test("normal text with no marker is forwarded untouched", () => {
    const d = new PageMarkerDetector({ allowDev: false });
    const events = feedAll(d, ["Hello, ", "world."]);
    expect(events.filter((e) => e.kind === "marker")).toHaveLength(0);
    expect(events.map((e) => (e.kind === "text" ? e.text : "")).join("")).toBe("Hello, world.");
  });

  test("marker appearing mid-answer is reported as position mid, preceding text forwarded first", () => {
    const d = new PageMarkerDetector({ allowDev: false });
    const events = feedAll(d, ["Let me check. ", MARKER_TEXT, " more"]);
    expect(events[0]).toEqual({ kind: "text", text: "Let me check. " });
    expect(events.some((e) => e.kind === "marker" && e.position === "mid" && e.marker.type === "read")).toBe(true);
  });

  test("marker split across chunks mid-answer is still detected", () => {
    const d = new PageMarkerDetector({ allowDev: false });
    const events = feedAll(d, ["Sure. [[READ_", "PAGE]] done"]);
    expect(events.some((e) => e.kind === "marker" && e.position === "mid")).toBe(true);
  });

  test("dev marker is recognised when allowDev is true", () => {
    const d = new PageMarkerDetector({ allowDev: true });
    const events = feedAll(d, [MARKER_DEV]);
    expect(events).toEqual([{ kind: "marker", marker: { type: "read", level: "dev" }, position: "start" }]);
  });

  test("dev marker is treated as plain text when allowDev is false (devMode false)", () => {
    const d = new PageMarkerDetector({ allowDev: false });
    const events = feedAll(d, [MARKER_DEV]);
    expect(events.every((e) => e.kind === "text")).toBe(true);
    expect(events.map((e) => (e.kind === "text" ? e.text : "")).join("")).toBe(MARKER_DEV);
  });

  test("search marker split across chunks yields its query", () => {
    const d = new PageMarkerDetector({ allowDev: false, allowSearch: true });
    const events = feedAll(d, ["[[SEA", "RCH: best ", "laptops 2026]", "]"]);
    expect(events).toEqual([{ kind: "marker", marker: { type: "search", query: "best laptops 2026" }, position: "start" }]);
  });

  test("search marker mid-answer is reported as mid", () => {
    const d = new PageMarkerDetector({ allowDev: false, allowSearch: true });
    const events = feedAll(d, ["I will look. [[SEARCH: bun test]", "] ok"]);
    expect(events[0]).toEqual({ kind: "text", text: "I will look. " });
    expect(events[1]).toEqual({ kind: "marker", marker: { type: "search", query: "bun test" }, position: "mid" });
  });

  test("too-long, multi-line, empty or unoffered search markers stay text", () => {
    const cases: [string, boolean][] = [
      [`[[SEARCH: ${"x".repeat(201)}]]`, true],
      ["[[SEARCH: a\nb]]", true],
      ["[[SEARCH:  ]]", true],
      ["[[SEARCH: hello]]", false],
    ];
    for (const [text, allowSearch] of cases) {
      const events = feedAll(new PageMarkerDetector({ allowDev: false, allowSearch }), [text.slice(0, 20), text.slice(20)]);
      expect(events.every((e) => e.kind === "text")).toBe(true);
      expect(events.map((e) => (e.kind === "text" ? e.text : "")).join("")).toBe(text);
    }
  });

  test("leading whitespace before the marker is held and consumed with it", () => {
    const d = new PageMarkerDetector({ allowDev: false });
    const events = feedAll(d, ["  \n" + MARKER_TEXT]);
    expect(events).toEqual([{ kind: "marker", marker: { type: "read", level: "text" }, position: "start" }]);
  });
});

// ---------------------------------------------------------------------------
// devContentCharBudget — pure unit tests
// ---------------------------------------------------------------------------

describe("devContentCharBudget", () => {
  test("never exceeds MAX_DEV_CONTEXT_CHARS even for a huge context window", () => {
    expect(devContentCharBudget(10_000_000)).toBeLessThanOrEqual(MAX_DEV_CONTEXT_CHARS);
  });

  test("falls back to a fixed default when contextTokens is unknown", () => {
    expect(devContentCharBudget(undefined)).toBeGreaterThan(0);
  });

  test("a smaller context window yields a smaller budget", () => {
    expect(devContentCharBudget(4096)).toBeLessThan(devContentCharBudget(32_000));
  });
});

// ---------------------------------------------------------------------------
// Full re-run flow — fake provider over a real WebSocket connection
// ---------------------------------------------------------------------------

const ALLOWED_ID = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const KEY = Buffer.from("0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcd", "hex");

let servers: ReturnType<typeof startServer>[] = [];

function boot(provider: ModelProvider) {
  __setProvidersForTests([provider]);
  const dataDir = makeTmpDir("coati-page-on-demand-");
  const server = startServer({ port: 0, allowedExtensionIds: [ALLOWED_ID], provider: provider.id as any, model: "x" }, KEY, { dataDir });
  servers.push(server);
  return server;
}

afterEach(() => {
  for (const s of servers) s.stop(true);
  servers = [];
  __resetProvidersForTests();
});

async function connect(server: ReturnType<typeof startServer>): Promise<WebSocket> {
  return connectAndAuthV2OrThrow(`ws://127.0.0.1:${server.port}/ws`, `chrome-extension://${ALLOWED_ID}`, KEY);
}

function collectMessages(ws: WebSocket): ServerMessage[] {
  const messages: ServerMessage[] = [];
  ws.addEventListener("message", (event) => messages.push(JSON.parse(event.data as string)));
  return messages;
}

async function waitFor(messages: ServerMessage[], pred: (m: ServerMessage) => boolean, timeoutMs = 2000): Promise<ServerMessage> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const found = messages.find(pred);
    if (found) return found;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error("timed out waiting for message");
}

/** Fake provider: emits the text marker on any call whose prompt only shows
 * page metadata (never real content); otherwise answers with fixed text that
 * proves the re-run prompt actually carried what the test expects. */
function fakeOnDemandProvider(id: string): ModelProvider {
  return {
    id,
    label: id,
    async isAvailable() {
      return { available: true };
    },
    async checkStatus() {
      return { state: "ok", reason: "ready" };
    },
    async *streamAnswer(built: any) {
      if (built.prompt.includes("Page available (not yet read)")) {
        yield { kind: "delta", text: MARKER_TEXT };
        yield { kind: "usage", usage: { inputTokens: 10, outputTokens: 1 } };
        return;
      }
      if (built.prompt.includes("declined to share the page content")) {
        yield { kind: "delta", text: "no page, answering anyway" };
        yield { kind: "usage", usage: { inputTokens: 7, outputTokens: 3 } };
        return;
      }
      yield { kind: "delta", text: "Got it: " };
      yield { kind: "delta", text: "PAGE_CONTENT_SEEN" };
      yield { kind: "usage", usage: { inputTokens: 20, outputTokens: 5 } };
    },
  };
}

describe("page on demand — re-run flow with a fake provider", () => {
  test("marker at start -> page.request -> page.content -> re-run -> done with page + summed usage", async () => {
    const server = boot(fakeOnDemandProvider("fixture-pod-1"));
    const ws = await connect(server);
    const messages = collectMessages(ws);

    ws.send(
      JSON.stringify({
        type: "chat",
        id: "c1",
        text: "what does this page say?",
        page: { title: "T", url: "https://example.com", chars: 42 },
      }),
    );

    const req = await waitFor(messages, (m) => m.type === "page.request");
    expect(req).toMatchObject({ type: "page.request", id: "c1", level: "text" });
    expect((req as any).discard).toBeUndefined();

    ws.send(
      JSON.stringify({
        type: "page.content",
        id: "pc1",
        target: "c1",
        level: "text",
        context: { kind: "page", text: "PAGE_CONTENT_SEEN here" },
      }),
    );

    const done = await waitFor(messages, (m) => m.type === "done");
    // Note: the FIRST call's usage event is never reached — the provider
    // yields it right after the marker delta, but the broker aborts the
    // instant the marker is detected (never forwarding it), so that usage
    // event is never read. Only the second (real-answer) call's usage
    // survives — the sum is only ever over usage events actually received.
    expect(done).toMatchObject({
      type: "done",
      id: "c1",
      usage: { inputTokens: 20, outputTokens: 5 },
      page: { level: "text", chars: 22, sentChars: 22, truncated: false },
    });

    const chunks = messages.filter((m) => m.type === "chunk").map((m: any) => m.delta).join("");
    expect(chunks).toBe("Got it: PAGE_CONTENT_SEEN");
    // The marker itself must never have been forwarded as a chunk.
    expect(chunks).not.toContain("READ_PAGE");

    ws.close();
  });

  test("decline -> re-run with the trusted note, no page field on done", async () => {
    const server = boot(fakeOnDemandProvider("fixture-pod-2"));
    const ws = await connect(server);
    const messages = collectMessages(ws);

    ws.send(
      JSON.stringify({ type: "chat", id: "c2", text: "hi", page: { title: "T", url: "https://example.com", chars: 10 } }),
    );
    await waitFor(messages, (m) => m.type === "page.request");

    ws.send(JSON.stringify({ type: "page.decline", id: "pd1", target: "c2" }));

    const done = await waitFor(messages, (m) => m.type === "done");
    expect((done as any).page).toBeUndefined();
    const chunks = messages.filter((m) => m.type === "chunk").map((m: any) => m.delta).join("");
    expect(chunks).toBe("no page, answering anyway");

    ws.close();
  });

  test("read caps: a second marker for an already-read level is stripped, not re-requested", async () => {
    // Always emits the marker, regardless of prompt — proves the SECOND
    // occurrence (same level, already read once) never produces a second
    // page.request, and the stream still completes with `done`.
    const alwaysMarker: ModelProvider = {
      id: "fixture-pod-3",
      label: "fixture-pod-3",
      async isAvailable() {
        return { available: true };
      },
      async checkStatus() {
        return { state: "ok", reason: "ready" };
      },
      async *streamAnswer(built: any) {
        if (built.prompt.includes("Page available (not yet read)")) {
          yield { kind: "delta", text: MARKER_TEXT };
        } else {
          yield { kind: "delta", text: MARKER_TEXT }; // re-run also emits it — must be stripped, not re-triggered
        }
        yield { kind: "usage", usage: { inputTokens: 1, outputTokens: 1 } };
      },
    };
    const server = boot(alwaysMarker);
    const ws = await connect(server);
    const messages = collectMessages(ws);

    ws.send(JSON.stringify({ type: "chat", id: "c3", text: "hi", page: { title: "T", url: "https://example.com", chars: 10 } }));
    const req = await waitFor(messages, (m) => m.type === "page.request");
    expect(req).toMatchObject({ level: "text" });

    ws.send(
      JSON.stringify({ type: "page.content", id: "pc1", target: "c3", level: "text", context: { kind: "page", text: "x" } }),
    );

    const done = await waitFor(messages, (m) => m.type === "done");
    expect(done).toBeDefined();
    // Only ONE page.request was ever sent for this question.
    const requests = messages.filter((m) => m.type === "page.request");
    expect(requests).toHaveLength(1);
    const chunks = messages.filter((m) => m.type === "chunk").map((m: any) => m.delta).join("");
    expect(chunks).not.toContain("READ_PAGE");

    ws.close();
  });
});

describe("constants", () => {
  test("PAGE_REQUEST_TIMEOUT_MS is 120000", () => {
    expect(PAGE_REQUEST_TIMEOUT_MS).toBe(120_000);
  });
  test("a search.request waits longer than a page.request (the user may be deciding)", () => {
    expect(SEARCH_REQUEST_TIMEOUT_MS).toBeGreaterThan(PAGE_REQUEST_TIMEOUT_MS);
  });
});

// ---------------------------------------------------------------------------
// English scaffolding snapshot — no French left in render.ts's prompt text
// used by page-on-demand or the already-existing fenced sections.
// ---------------------------------------------------------------------------

describe("English scaffolding (point 8)", () => {
  test("page metadata + on-demand instruction are English, never French", () => {
    const built = buildPrompt({
      kind: "chat",
      text: "hi",
      page: { title: "T", url: "https://example.com", chars: 10 },
      devMode: true,
    } as any);
    expect(built.prompt).toContain("Page available (not yet read)");
    expect(built.prompt).toContain("[[READ_PAGE]]");
    expect(built.prompt).toContain("[[READ_PAGE_DEV]]");
    expect(built.prompt).not.toContain("Texte de la page");
    expect(built.prompt).not.toContain("Éléments interactifs");
    expect(built.prompt).not.toContain("affichées par la page");
  });

  test("dev marker is not offered when devMode is false/absent", () => {
    const built = buildPrompt({
      kind: "chat",
      text: "hi",
      page: { title: "T", url: "https://example.com", chars: 10 },
    } as any);
    expect(built.prompt).toContain("[[READ_PAGE]]");
    expect(built.prompt).not.toContain("[[READ_PAGE_DEV]]");
  });
});

// ---------------------------------------------------------------------------
// Fix 1: resolveActiveContextTokens — per-provider dev budget fallback.
// ---------------------------------------------------------------------------

function stubProvider(id: string): ModelProvider {
  return {
    id,
    label: id,
    async isAvailable() {
      return { available: true };
    },
    async checkStatus() {
      return { state: "ok", reason: "ready" };
    },
    async *streamAnswer() {},
  };
}

describe("resolveActiveContextTokens — fix 1 (non-Ollama dev budget)", () => {
  test("claude-api gets the 200000-token fallback", async () => {
    const tokens = await resolveActiveContextTokens(stubProvider("claude-api"), {});
    expect(tokens).toBe(200_000);
  });

  test("claude-cli gets the 200000-token fallback", async () => {
    const tokens = await resolveActiveContextTokens(stubProvider("claude-cli"), {});
    expect(tokens).toBe(200_000);
  });

  test("any other non-Ollama provider gets the 32768-token fallback", async () => {
    const tokens = await resolveActiveContextTokens(stubProvider("openai-compat"), {});
    expect(tokens).toBe(32_768);
    const tokensModule = await resolveActiveContextTokens(stubProvider("some-external-module"), {});
    expect(tokensModule).toBe(32_768);
  });

  test("the resulting dev budget is far above the old 8192-token default, still capped", () => {
    const claudeBudget = devContentCharBudget(200_000);
    const oldDefaultBudget = devContentCharBudget(8192);
    expect(claudeBudget).toBeGreaterThan(oldDefaultBudget);
    expect(claudeBudget).toBeLessThanOrEqual(MAX_DEV_CONTEXT_CHARS);
  });
});

// ---------------------------------------------------------------------------
// Fix 2 / Fix 3 / Fix 4 — full flow with fake providers.
// ---------------------------------------------------------------------------

describe("page on demand — fix 2 (text→dev escalation offered on re-run)", () => {
  test("after a text read, devMode true and dev unused: re-run prompt still offers [[READ_PAGE_DEV]]", async () => {
    let secondPrompt = "";
    const provider: ModelProvider = {
      id: "fixture-pod-fix2",
      label: "fixture-pod-fix2",
      async isAvailable() {
        return { available: true };
      },
      async checkStatus() {
        return { state: "ok", reason: "ready" };
      },
      async *streamAnswer(built: any) {
        if (built.prompt.includes("Page available (not yet read)")) {
          yield { kind: "delta", text: MARKER_TEXT };
          yield { kind: "usage", usage: { inputTokens: 1, outputTokens: 1 } };
          return;
        }
        secondPrompt = built.prompt;
        yield { kind: "delta", text: "answered from text" };
        yield { kind: "usage", usage: { inputTokens: 1, outputTokens: 1 } };
      },
    };
    const server = boot(provider);
    const ws = await connect(server);
    const messages = collectMessages(ws);

    ws.send(
      JSON.stringify({
        type: "chat",
        id: "f2",
        text: "what does this page say?",
        page: { title: "T", url: "https://example.com", chars: 10 },
        devMode: true,
      }),
    );
    await waitFor(messages, (m) => m.type === "page.request");
    ws.send(
      JSON.stringify({
        type: "page.content",
        id: "pc1",
        target: "f2",
        level: "text",
        context: { kind: "page", text: "the page's own text" },
      }),
    );
    await waitFor(messages, (m) => m.type === "done");

    expect(secondPrompt).toContain("[[READ_PAGE_DEV]]");
    expect(secondPrompt).not.toContain("[[READ_PAGE]]\n"); // no fresh READ_PAGE offer, text already read
    ws.close();
  });

  test("devMode false: re-run prompt after a text read offers nothing", async () => {
    let secondPrompt = "";
    const provider: ModelProvider = {
      id: "fixture-pod-fix2b",
      label: "fixture-pod-fix2b",
      async isAvailable() {
        return { available: true };
      },
      async checkStatus() {
        return { state: "ok", reason: "ready" };
      },
      async *streamAnswer(built: any) {
        if (built.prompt.includes("Page available (not yet read)")) {
          yield { kind: "delta", text: MARKER_TEXT };
          yield { kind: "usage", usage: { inputTokens: 1, outputTokens: 1 } };
          return;
        }
        secondPrompt = built.prompt;
        yield { kind: "delta", text: "answered from text" };
        yield { kind: "usage", usage: { inputTokens: 1, outputTokens: 1 } };
      },
    };
    const server = boot(provider);
    const ws = await connect(server);
    const messages = collectMessages(ws);

    ws.send(
      JSON.stringify({
        type: "chat",
        id: "f2b",
        text: "hi",
        page: { title: "T", url: "https://example.com", chars: 10 },
      }),
    );
    await waitFor(messages, (m) => m.type === "page.request");
    ws.send(
      JSON.stringify({ type: "page.content", id: "pc1", target: "f2b", level: "text", context: { kind: "page", text: "txt" } }),
    );
    await waitFor(messages, (m) => m.type === "done");

    expect(secondPrompt).not.toContain("[[READ_PAGE_DEV]]");
    ws.close();
  });

  test("after a dev read, re-run prompt offers nothing (symmetric)", async () => {
    let secondPrompt = "";
    const provider: ModelProvider = {
      id: "fixture-pod-fix2c",
      label: "fixture-pod-fix2c",
      async isAvailable() {
        return { available: true };
      },
      async checkStatus() {
        return { state: "ok", reason: "ready" };
      },
      async *streamAnswer(built: any) {
        if (built.prompt.includes("Page available (not yet read)")) {
          yield { kind: "delta", text: MARKER_DEV };
          yield { kind: "usage", usage: { inputTokens: 1, outputTokens: 1 } };
          return;
        }
        secondPrompt = built.prompt;
        yield { kind: "delta", text: "answered from html" };
        yield { kind: "usage", usage: { inputTokens: 1, outputTokens: 1 } };
      },
    };
    const server = boot(provider);
    const ws = await connect(server);
    const messages = collectMessages(ws);

    ws.send(
      JSON.stringify({
        type: "chat",
        id: "f2c",
        text: "hi",
        page: { title: "T", url: "https://example.com", chars: 10 },
        devMode: true,
      }),
    );
    const req = await waitFor(messages, (m) => m.type === "page.request");
    expect(req).toMatchObject({ level: "dev" });
    ws.send(
      JSON.stringify({ type: "page.content", id: "pc1", target: "f2c", level: "dev", context: { kind: "page", text: "<html></html>" } }),
    );
    await waitFor(messages, (m) => m.type === "done");

    expect(secondPrompt).not.toContain("[[READ_PAGE_DEV]]");
    expect(secondPrompt).not.toContain("[[READ_PAGE]]");
    ws.close();
  });
});

describe("page on demand — fix 3 (page.content level must match the requested level)", () => {
  test("client answers a text request with level dev -> bad-request, request stops", async () => {
    const provider: ModelProvider = {
      id: "fixture-pod-fix3",
      label: "fixture-pod-fix3",
      async isAvailable() {
        return { available: true };
      },
      async checkStatus() {
        return { state: "ok", reason: "ready" };
      },
      async *streamAnswer(built: any) {
        yield { kind: "delta", text: MARKER_TEXT };
        yield { kind: "usage", usage: { inputTokens: 1, outputTokens: 1 } };
      },
    };
    const server = boot(provider);
    const ws = await connect(server);
    const messages = collectMessages(ws);

    ws.send(
      JSON.stringify({
        type: "chat",
        id: "f3",
        text: "hi",
        page: { title: "T", url: "https://example.com", chars: 10 },
      }),
    );
    const req = await waitFor(messages, (m) => m.type === "page.request");
    expect(req).toMatchObject({ level: "text" });

    ws.send(
      JSON.stringify({ type: "page.content", id: "pc1", target: "f3", level: "dev", context: { kind: "page", text: "<html></html>" } }),
    );

    const err = await waitFor(messages, (m) => m.type === "error");
    expect(err).toMatchObject({ type: "error", id: "f3", code: "bad-request" });
    const done = messages.find((m) => m.type === "done");
    expect(done).toBeUndefined();
    ws.close();
  });
});

describe("page on demand — fix 4 (Ollama progress notifications in the loop)", () => {
  afterEach(() => {
    __resetFetchImplForTests();
  });

  test("loading/reading and thinking progress fire for every provider call the loop makes", async () => {
    __setFetchImplForTests(
      (async (url: string) => {
        const u = String(url);
        if (u.endsWith("/api/ps")) {
          return new Response(
            JSON.stringify({ models: [{ name: "x", size: 1, size_vram: 1 }] }),
            { status: 200 },
          );
        }
        throw new Error(`unexpected fetch: ${u}`);
      }) as unknown as typeof fetch,
    );

    const provider: ModelProvider = {
      id: "ollama",
      label: "ollama",
      async isAvailable() {
        return { available: true };
      },
      async checkStatus() {
        return { state: "ok", reason: "ready" };
      },
      async *streamAnswer(built: any) {
        yield { kind: "thinking" };
        if (built.prompt.includes("Page available (not yet read)")) {
          yield { kind: "delta", text: MARKER_TEXT };
          yield { kind: "usage", usage: { inputTokens: 1, outputTokens: 1 } };
          return;
        }
        yield { kind: "delta", text: "answered" };
        yield { kind: "usage", usage: { inputTokens: 1, outputTokens: 1 } };
      },
    };
    const server = boot(provider);
    const ws = await connect(server);
    const messages = collectMessages(ws);

    ws.send(
      JSON.stringify({
        type: "chat",
        id: "f4",
        text: "hi",
        page: { title: "T", url: "https://example.com", chars: 10 },
      }),
    );
    await waitFor(messages, (m) => m.type === "page.request");
    ws.send(
      JSON.stringify({ type: "page.content", id: "pc1", target: "f4", level: "text", context: { kind: "page", text: "txt" } }),
    );
    await waitFor(messages, (m) => m.type === "done");

    const progressMsgs = messages.filter((m) => m.type === "progress") as { stage: string }[];
    // One "reading" (model already loaded per /api/ps) and one "thinking" per
    // provider call — two calls total (metadata-only + re-run with text).
    expect(progressMsgs.filter((m) => m.stage === "reading").length).toBe(2);
    expect(progressMsgs.filter((m) => m.stage === "thinking").length).toBe(2);

    // Progress for the SECOND call must come after the page.request, not
    // bundled before it.
    const pageReqIdx = messages.findIndex((m) => m.type === "page.request");
    const progressAfterReq = messages.slice(pageReqIdx + 1).filter((m) => m.type === "progress");
    expect(progressAfterReq.length).toBe(2);

    ws.close();
  });
});

describe("search — [[SEARCH: …]] / [[OPEN: …]] markers, search, open and their answers", () => {
  const result = (q: string, k: number, snippet = `snippet ${q} ${k}`) => ({ n: k, title: `T ${q} ${k}`, url: `https://r${k}.example/${q.replace(/\W/g, "")}`, snippet });
  const SEARCH_CONTENT = { type: "search.content", id: "sc1", query: "q", results: [result("q", 1)] };

  /** Replies `script[i]` on call i (the last one repeats), recording each prompt. */
  function scriptedProvider(id: string, script: string[][], prompts: string[]): ModelProvider {
    return {
      id,
      label: id,
      async isAvailable() {
        return { available: true };
      },
      async checkStatus() {
        return { state: "ok", reason: "ready" };
      },
      async *streamAnswer(built: any) {
        prompts.push(built.prompt);
        for (const d of script[Math.min(prompts.length - 1, script.length - 1)]!) yield { kind: "delta", text: d };
        yield { kind: "usage", usage: { inputTokens: 5, outputTokens: 2 } };
      },
    };
  }

  /** Answers every search.request with `perSearch` results and every open.request with each page. */
  function autoClient(ws: WebSocket, perSearch = 8, snippet?: string) {
    ws.addEventListener("message", (event) => {
      const m = JSON.parse(event.data as string);
      if (m.type === "search.request") {
        const results = Array.from({ length: perSearch }, (_, i) => result(m.query, i + 1, snippet));
        ws.send(JSON.stringify({ type: "search.content", id: `sc-${m.query}`, target: m.id, query: m.query, results }));
      } else if (m.type === "open.request") {
        const pages = m.refs.map((r: { n: number; url: string }) => ({ n: r.n, url: r.url, title: `P${r.n}`, text: `PAGE_TEXT_S${r.n}` }));
        ws.send(JSON.stringify({ type: "open.content", id: `oc-${m.refs[0].n}`, target: m.id, pages }));
      }
    });
  }

  const chunksOf = (messages: ServerMessage[]) => messages.filter((m) => m.type === "chunk").map((m: any) => m.delta).join("");

  test("3 searches + 2 opens: S<n> continuous, opens resolved to urls, done.search counted", async () => {
    const prompts: string[] = [];
    const server = boot(
      scriptedProvider("fixture-search-chain", [["[[SEARCH: comfyui]]"], ["[[SEARCH: image ", "generator github]]"], ["Found. [[OPEN: S2, S9]]"], ["[[SEARCH: invokeai]]"], ["[[OPEN: S17]]"], ["Answer [S2] [S17]"]], prompts),
    );
    const ws = await connect(server);
    const messages = collectMessages(ws);
    autoClient(ws, 8);
    ws.send(JSON.stringify({ type: "chat", id: "c1", text: "find open source image generators", abilities: ["search"] }));
    const done: any = await waitFor(messages, (m) => m.type === "done");
    expect(messages.filter((m) => m.type === "search.request").map((m: any) => m.query)).toEqual(["comfyui", "image generator github", "invokeai"]);
    const opens = messages.filter((m) => m.type === "open.request") as any[];
    expect(opens.map((o) => o.refs)).toEqual([
      [{ n: 2, url: "https://r2.example/comfyui" }, { n: 9, url: "https://r1.example/imagegeneratorgithub" }],
      [{ n: 17, url: "https://r1.example/invokeai" }],
    ]);
    expect(opens[0].discard).toBe(true);
    expect(done.search).toMatchObject({ queries: ["comfyui", "image generator github", "invokeai"], results: 24, pages: 3 });
    expect(done.search.capped).toBeUndefined();
    const snippetChars = ["comfyui", "image generator github", "invokeai"].reduce((n, q) => n + [1, 2, 3, 4, 5, 6, 7, 8].reduce((m, k) => m + `snippet ${q} ${k}`.length, 0), 0);
    expect(done.search.chars).toBe(snippetChars + "PAGE_TEXT_S2PAGE_TEXT_S9PAGE_TEXT_S17".length);
    expect(prompts[5]).toContain("[S24]");
    expect(prompts[5]).toContain("PAGE_TEXT_S17");
    expect(prompts[5]).toContain("Copy every link exactly");
    expect(prompts[0]).toContain("[[OPEN:");
    expect(prompts[0]).toContain("Search 2-3 varied queries");
    expect(chunksOf(messages)).toBe("Found. Answer [S2] [S17]");
    ws.close();
  });

  test("limits: a 5th search and a 7th page are stripped, reported, never requested", async () => {
    const prompts: string[] = [];
    const script = [
      ...["a", "b", "c", "d"].map((q) => [`[[SEARCH: ${q}]]`]),
      ["[[OPEN: S1 S2 S3]]"],
      ["[[OPEN: S4 S5 S6]]"],
      ["Done. [[OPEN: S7]] [[SEARCH: e]]"],
    ];
    const server = boot(scriptedProvider("fixture-search-limits", script, prompts));
    const ws = await connect(server);
    const messages = collectMessages(ws);
    autoClient(ws, 2);
    ws.send(JSON.stringify({ type: "chat", id: "c2", text: "compare", abilities: ["search"] }));
    const done: any = await waitFor(messages, (m) => m.type === "done");
    expect(messages.filter((m) => m.type === "search.request")).toHaveLength(4);
    expect(messages.filter((m) => m.type === "open.request")).toHaveLength(2);
    expect(done.search).toMatchObject({ results: 8, pages: 6, capped: true });
    expect(done.suggest).toEqual({ search: "e" });
    expect(chunksOf(messages)).toBe("Done.  ");
    expect(prompts[6]).not.toContain("[[OPEN:");
    expect(prompts[6]).toContain("No more searches or pages");
    ws.close();
  });

  test("CHAT_MAX_MODEL_TURNS: the 10th call is offered no marker and its marker is stripped", async () => {
    const prompts: string[] = [];
    const script = [...["a", "b", "c", "d"].map((q) => [`[[SEARCH: ${q}]]`]), ...[1, 2, 3, 4, 5, 6].map((n) => [`[[OPEN: S${n}]]`])];
    const server = boot(scriptedProvider("fixture-search-turns", script, prompts));
    const ws = await connect(server);
    const messages = collectMessages(ws);
    autoClient(ws, 2);
    ws.send(JSON.stringify({ type: "chat", id: "c3", text: "compare", abilities: ["search"] }));
    const done: any = await waitFor(messages, (m) => m.type === "done");
    expect(prompts).toHaveLength(10);
    expect(messages.filter((m) => m.type === "open.request")).toHaveLength(5);
    expect(prompts[9]).not.toContain("[[OPEN:");
    expect(done.search).toMatchObject({ pages: 5, capped: true });
    ws.close();
  });

  test("[[OPEN]] on unknown refs: dropped; none left -> stripped, no request, not capped", async () => {
    const prompts: string[] = [];
    const server = boot(scriptedProvider("fixture-search-unknown", [["[[SEARCH: q]]"], ["[[OPEN: S1 S99]]"], ["x [[OPEN: S99]] [[OPEN: S1]] y"]], prompts));
    const ws = await connect(server);
    const messages = collectMessages(ws);
    autoClient(ws, 1);
    ws.send(JSON.stringify({ type: "chat", id: "c4", text: "hi", abilities: ["search"] }));
    const done: any = await waitFor(messages, (m) => m.type === "done");
    const opens = messages.filter((m) => m.type === "open.request") as any[];
    expect(opens.map((o) => o.refs)).toEqual([[{ n: 1, url: "https://r1.example/q" }]]);
    expect(chunksOf(messages)).toBe("x   y");
    expect(done.search.capped).toBeUndefined();
    ws.close();
  });

  test("a reply made only of stripped markers gets one more call, offered no marker", async () => {
    const prompts: string[] = [];
    const server = boot(scriptedProvider("fixture-search-empty", [["[[SEARCH: q]]"], ["[[OPEN: S1]]"], ["[[OPEN: S1]]"], ["Answer [S1]"]], prompts));
    const ws = await connect(server);
    const messages = collectMessages(ws);
    autoClient(ws, 1);
    ws.send(JSON.stringify({ type: "chat", id: "c4b", text: "hi", abilities: ["search"] }));
    await waitFor(messages, (m) => m.type === "done");
    expect(prompts).toHaveLength(4);
    expect(prompts[3]).not.toContain("[[SEARCH:");
    expect(prompts[3]).toContain("No more searches or pages");
    expect(chunksOf(messages)).toBe("Answer [S1]");
    ws.close();
  });

  test("the character budget drops what no longer fits and tells the model", async () => {
    const prompts: string[] = [];
    const server = boot(scriptedProvider("fixture-search-budget", [["[[SEARCH: a]]"], ["[[SEARCH: b]]"], ["answer"]], prompts));
    const ws = await connect(server);
    const messages = collectMessages(ws);
    autoClient(ws, 1, "s".repeat(40_000));
    ws.send(JSON.stringify({ type: "chat", id: "c5", text: "hi", abilities: ["search"] }));
    const done: any = await waitFor(messages, (m) => m.type === "done");
    // Online budget 64,000: the second 40,000-character result no longer fits, and no third search is offered.
    expect(done.search).toMatchObject({ queries: ["a"], results: 1, chars: 40_000 });
    expect(prompts[2]).toContain("reading budget for this question is used up");
    expect(prompts[2]).toContain("[S1]");
    expect(prompts[2]).not.toContain("[S2]");
    ws.close();
  });

  test("[[OPEN]] shape: 1 to 3 S<n> refs, spaces or commas; anything else stays text", () => {
    const feed = (s: string, allowSearch = true) => {
      const d = new PageMarkerDetector({ allowDev: false, allowSearch });
      return [...d.feed(s), ...d.flush()];
    };
    expect(feed("[[OPEN: S2, S5 S2]]")).toEqual([{ kind: "marker", marker: { type: "open", refs: [2, 5] }, position: "start" }]);
    for (const text of ["[[OPEN: S1 S2 S3 S4]]", "[[OPEN: 2]]", "[[OPEN:]]", "[[OPEN: S0]]"]) {
      expect(feed(text).map((e) => (e.kind === "text" ? e.text : "MARKER")).join("")).toBe(text);
    }
    expect(feed("[[OPEN: S1]]", false)).toEqual([{ kind: "text", text: "[[OPEN: S1]]" }]);
  });

  test("searchCharBudget: local models get the smaller budget", () => {
    const p = (id: string) => ({ id }) as ModelProvider;
    expect(searchCharBudget(p("ollama"), {})).toBe(32_000);
    expect(searchCharBudget(p("openai-compat"), { baseUrl: "http://localhost:1234/v1" })).toBe(32_000);
    expect(searchCharBudget(p("openai-compat"), { baseUrl: "https://api.example.com/v1" })).toBe(64_000);
    expect(searchCharBudget(p("claude-api"), {})).toBe(64_000);
  });

  test("open.content refusals: an unrequested ref is bad-request, an oversized page context-too-large", async () => {
    for (const [pages, code] of [
      [[{ n: 4, url: "u", title: "t", text: "x" }], "bad-request"],
      [[{ n: 1, url: "u", title: "t", text: "x".repeat(6001) }], "context-too-large"],
    ] as const) {
      const server = boot(scriptedProvider(`fixture-open-${code}`, [["[[SEARCH: q]]"], ["[[OPEN: S1]]"]], []));
      const ws = await connect(server);
      const messages = collectMessages(ws);
      ws.send(JSON.stringify({ type: "chat", id: "c6", text: "hi", abilities: ["search"] }));
      await waitFor(messages, (m) => m.type === "search.request");
      ws.send(JSON.stringify({ ...SEARCH_CONTENT, target: "c6" }));
      await waitFor(messages, (m) => m.type === "open.request");
      ws.send(JSON.stringify({ type: "open.content", id: "oc", target: "c6", pages }));
      expect(await waitFor(messages, (m) => m.type === "error")).toMatchObject({ code });
      ws.close();
    }
  });

  test("open.decline -> trusted note naming the refs", async () => {
    const prompts: string[] = [];
    const server = boot(scriptedProvider("fixture-open-decline", [["[[SEARCH: q]]"], ["[[OPEN: S1]]"], ["ok"]], prompts));
    const ws = await connect(server);
    const messages = collectMessages(ws);
    ws.send(JSON.stringify({ type: "chat", id: "c7", text: "hi", abilities: ["search"] }));
    await waitFor(messages, (m) => m.type === "search.request");
    ws.send(JSON.stringify({ ...SEARCH_CONTENT, target: "c7" }));
    await waitFor(messages, (m) => m.type === "open.request");
    ws.send(JSON.stringify({ type: "open.decline", id: "od", target: "c7", reason: "blocked" }));
    await waitFor(messages, (m) => m.type === "done");
    expect(prompts[2]).toContain("Pages [S1] could not be read (blocked)");
    ws.close();
  });

  test("search.decline -> trusted note in the re-run, no done.search", async () => {
    const prompts: string[] = [];
    const server = boot(scriptedProvider("fixture-search-2", [["[[SEARCH: q]]"], ["no search, answering anyway"]], prompts));
    const ws = await connect(server);
    const messages = collectMessages(ws);
    ws.send(JSON.stringify({ type: "chat", id: "s2", text: "hi", abilities: ["search"] }));
    await waitFor(messages, (m) => m.type === "search.request");
    ws.send(JSON.stringify({ type: "search.decline", id: "sd", target: "s2", reason: "no-access" }));
    const done = await waitFor(messages, (m) => m.type === "done");
    expect((done as any).search).toBeUndefined();
    expect(prompts[1]).toContain("could not be done (no-access)");
    ws.close();
  });

  test("search.decline blocked (refused by the user) -> note telling the model not to ask again", async () => {
    const prompts: string[] = [];
    const server = boot(scriptedProvider("fixture-search-refused", [["[[SEARCH: q]]"], ["answering without it"]], prompts));
    const ws = await connect(server);
    const messages = collectMessages(ws);
    ws.send(JSON.stringify({ type: "chat", id: "s5", text: "hi", abilities: ["search"] }));
    await waitFor(messages, (m) => m.type === "search.request");
    ws.send(JSON.stringify({ type: "search.decline", id: "sd5", target: "s5", reason: "blocked" }));
    const done = await waitFor(messages, (m) => m.type === "done");
    expect((done as any).search).toBeUndefined();
    expect(prompts[1]).toContain("The user refused this web search");
    ws.close();
  });

  test("pageUnreadable: a trusted note says the page cannot be read, with or without abilities", async () => {
    for (const [id, extra] of [["u1", {}], ["u2", { abilities: ["search"] }]] as const) {
      const prompts: string[] = [];
      const server = boot(scriptedProvider(`fixture-unreadable-${id}`, [["no page needed"]], prompts));
      const ws = await connect(server);
      const messages = collectMessages(ws);
      ws.send(JSON.stringify({ type: "chat", id, text: "what is this page?", pageUnreadable: true, ...extra }));
      await waitFor(messages, (m) => m.type === "done");
      expect(prompts[0]).toContain("cannot be read by Coati");
      expect(prompts[0]).toContain("Do not ask the user to copy and paste");
      ws.close();
    }
  });

  test("chat.searchQuery sends search.request without a prior model call", async () => {
    const prompts: string[] = [];
    const server = boot(scriptedProvider("fixture-search-3", [["Per [S1]."]], prompts));
    const ws = await connect(server);
    const messages = collectMessages(ws);
    ws.send(JSON.stringify({ type: "chat", id: "s3", text: "hi", searchQuery: "targeted query" }));
    const req = await waitFor(messages, (m) => m.type === "search.request");
    expect(req).toMatchObject({ id: "s3", query: "targeted query" });
    expect(prompts).toHaveLength(0);
    ws.send(JSON.stringify({ ...SEARCH_CONTENT, target: "s3" }));
    const done = await waitFor(messages, (m) => m.type === "done");
    expect((done as any).search).toMatchObject({ queries: ["targeted query"], results: 1, pages: 0, chars: "snippet q 1".length });
    expect(prompts[0]).toContain("[S1] T q 1");
    ws.close();
  });

  test("a too-long query stays text; without abilities the marker is never offered", async () => {
    const long = `[[SEARCH: ${"x".repeat(201)}]]`;
    const prompts: string[] = [];
    const server = boot(scriptedProvider("fixture-search-4", [[long]], prompts));
    const ws = await connect(server);
    const messages = collectMessages(ws);
    ws.send(JSON.stringify({ type: "chat", id: "s4", text: "hi", abilities: ["search"] }));
    await waitFor(messages, (m) => m.type === "done");
    expect(messages.some((m) => m.type === "search.request")).toBe(false);
    expect(messages.filter((m) => m.type === "chunk").map((m: any) => m.delta).join("")).toBe(long);

    ws.send(JSON.stringify({ type: "chat", id: "s5", text: "hi", page: { title: "T", url: "https://e.com", chars: 1 } }));
    await waitFor(messages, (m) => m.type === "done" && (m as any).id === "s5");
    expect(prompts[1]).not.toContain("[[SEARCH");
    ws.close();
  });
});
