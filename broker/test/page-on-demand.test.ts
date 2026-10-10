// Lot 7, "page on demand" — docs/PROTOCOL.md "Page on demand". Covers
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
import { devContentCharBudget, resolveActiveContextTokens, PAGE_REQUEST_TIMEOUT_MS } from "../src/handlers/chat.ts";
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

describe("search — [[SEARCH: …]] marker, search.request/content/decline", () => {
  const SEARCH_CONTENT = {
    type: "search.content",
    id: "sc1",
    query: "q",
    results: [{ n: 1, title: "Title one", url: "https://a.example/x", snippet: "snippet one" }],
    pages: [{ n: 1, url: "https://a.example/x", title: "Title one", text: "PAGE_TEXT_ONE" }],
  };

  function searchProvider(id: string, firstReply: string[], prompts: string[]): ModelProvider {
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
        const searched = built.prompt.includes("Web search results");
        const declined = built.prompt.includes("could not be done");
        if (searched) {
          // Asks for a second search: must become a suggestion, never a request.
          yield { kind: "delta", text: "Per [S1]. [[SEARCH: some" };
          yield { kind: "delta", text: "thing else]]" };
        } else if (declined) {
          yield { kind: "delta", text: "no search, answering anyway" };
        } else {
          for (const d of firstReply) yield { kind: "delta", text: d };
        }
        yield { kind: "usage", usage: { inputTokens: 5, outputTokens: 2 } };
      },
    };
  }

  test("search.content -> re-run with fenced [S1] data; 2nd marker -> done.suggest; done.search counted", async () => {
    const prompts: string[] = [];
    const server = boot(searchProvider("fixture-search-1", ["[[SEARCH: be", "st laptops]]"], prompts));
    const ws = await connect(server);
    const messages = collectMessages(ws);
    ws.send(JSON.stringify({ type: "chat", id: "s1", text: "which laptop?", abilities: ["search"] }));

    const req = await waitFor(messages, (m) => m.type === "search.request");
    expect(req).toMatchObject({ id: "s1", query: "best laptops" });
    expect((req as any).discard).toBeUndefined();
    ws.send(JSON.stringify({ ...SEARCH_CONTENT, target: "s1" }));

    const done = await waitFor(messages, (m) => m.type === "done");
    expect(done).toMatchObject({
      search: { query: "q", results: 1, pages: 1, chars: "snippet one".length + "PAGE_TEXT_ONE".length },
      suggest: { search: "something else" },
    });
    expect(prompts[0]).toContain("[[SEARCH:");
    expect(prompts[1]).toContain("[S1]");
    expect(prompts[1]).toContain("PAGE_TEXT_ONE");
    // A second search is not offered once one ran.
    expect(prompts[1]).not.toContain("reply with EXACTLY [[SEARCH");
    const chunks = messages.filter((m) => m.type === "chunk").map((m: any) => m.delta).join("");
    expect(chunks).not.toContain("SEARCH");
    expect(messages.filter((m) => m.type === "search.request")).toHaveLength(1);
    ws.close();
  });

  test("search.decline -> trusted note in the re-run, no done.search", async () => {
    const prompts: string[] = [];
    const server = boot(searchProvider("fixture-search-2", ["[[SEARCH: q]]"], prompts));
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

  test("chat.searchQuery sends search.request without a prior model call", async () => {
    const prompts: string[] = [];
    const server = boot(searchProvider("fixture-search-3", ["unused"], prompts));
    const ws = await connect(server);
    const messages = collectMessages(ws);
    ws.send(JSON.stringify({ type: "chat", id: "s3", text: "hi", searchQuery: "targeted query" }));
    const req = await waitFor(messages, (m) => m.type === "search.request");
    expect(req).toMatchObject({ id: "s3", query: "targeted query" });
    expect(prompts).toHaveLength(0);
    ws.send(JSON.stringify({ ...SEARCH_CONTENT, target: "s3" }));
    const done = await waitFor(messages, (m) => m.type === "done");
    expect((done as any).search).toMatchObject({ query: "q" });
    ws.close();
  });

  test("a too-long query stays text; without abilities the marker is never offered", async () => {
    const long = `[[SEARCH: ${"x".repeat(201)}]]`;
    const prompts: string[] = [];
    const server = boot(searchProvider("fixture-search-4", [long], prompts));
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

describe("act — [[CLICK eN]] / [[TYPE eN: …]] markers, action.request/result", () => {
  const refs = new Set(["e1", "e2"]);
  const det = () => new PageMarkerDetector({ allowDev: false, refs });
  const CTX = { kind: "page", text: "BEFORE", elements: [{ ref: "e1", role: "button", label: "Go" }] };

  test("click and type markers split across chunks; unknown ref, long text, no refs stay text", () => {
    expect(feedAll(det(), ["[[CLI", "CK e", "2]]"])).toEqual([{ kind: "marker", marker: { type: "click", ref: "e2" }, position: "start" }]);
    expect(feedAll(det(), ["ok [[TYPE e1: hel", "lo wor", "ld]] bye"])[1]).toEqual({
      kind: "marker",
      marker: { type: "type", ref: "e1", text: "hello world" },
      position: "mid",
    });
    for (const [text, d] of [
      ["[[CLICK e9]]", det()],
      [`[[TYPE e1: ${"x".repeat(501)}]]`, det()],
      ["[[TYPE e1: a\nb]]", det()],
      ["[[CLICK e1]]", new PageMarkerDetector({ allowDev: false })],
    ] as const) {
      const events = feedAll(d, [text.slice(0, 9), text.slice(9)]);
      expect(events.map((e) => (e.kind === "text" ? e.text : "")).join("")).toBe(text);
    }
  });

  test("one action at a time: every status becomes a note, the 6th action is ignored, done.actions counts", async () => {
    const prompts: string[] = [];
    const replies = ["[[CLI", "[[TYPE e1: hello]]", "[[CLICK e1]]", "[[CLICK e1]]", "[[CLICK e1]]", "fin [[CLICK e1]] end"];
    let call = 0;
    const provider: ModelProvider = {
      ...fakeOnDemandProvider("fixture-act-1"),
      async *streamAnswer(built: any) {
        prompts.push(built.prompt);
        const r = replies[call++]!;
        yield { kind: "delta", text: r };
        if (r === "[[CLI") yield { kind: "delta", text: "CK e1]]" };
        yield { kind: "usage", usage: { inputTokens: 1, outputTokens: 1 } };
      },
    };
    const ws = await connect(boot(provider));
    const messages = collectMessages(ws);
    ws.send(JSON.stringify({ type: "chat", id: "a1", text: "go", context: CTX, abilities: ["act"] }));
    const results: object[] = [
      { status: "done", context: { kind: "page", text: "AFTER", elements: CTX.elements } },
      { status: "done", by: "user" },
      { status: "blocked", reason: "looks like a payment" },
      { status: "refused" },
      { status: "no-access" },
    ];
    for (let i = 0; i < results.length; i++) {
      const reqs = () => messages.filter((x) => x.type === "action.request");
      await waitFor(messages, () => reqs().length === i + 1);
      const req = reqs()[i];
      expect(req).toMatchObject(i === 1 ? { action: "type", ref: "e1", text: "hello" } : { action: "click", ref: "e1" });
      ws.send(JSON.stringify({ type: "action.result", id: `r${i}`, target: "a1", ...results[i] }));
    }
    const done = await waitFor(messages, (m) => m.type === "done");
    expect(done).toMatchObject({ actions: 5, page: { sentChars: "AFTER".length } });
    expect(messages.filter((m) => m.type === "action.request")).toHaveLength(5);
    expect(prompts[0]).toContain("[[CLICK e12]]");
    expect(prompts[1]).toContain("Done with the user's consent");
    expect(prompts[1]).toContain("AFTER");
    expect(prompts[2]).toContain('himself');
    expect(prompts[3]).toContain("Coati does not allow this gesture");
    expect(prompts[3]).toContain("looks like a payment");
    expect(prompts[4]).toContain("the user refused");
    expect(prompts[5]).toContain("lost access");
    expect(prompts[5]).not.toContain("[[CLICK e12]]");
    expect(messages.filter((m) => m.type === "chunk").map((m: any) => m.delta).join("")).toBe("fin  end");
    ws.close();
  });

  test("stale note; abilities without elements never offers act", () => {
    const stale = buildPrompt(
      { kind: "chat", text: "x", context: CTX as any, offerAct: true, actions: [{ action: "click", ref: "e1", status: "stale" }] },
      "en",
    ).prompt;
    expect(stale).toContain("no longer on the page");
    const bare = buildPrompt({ kind: "chat", text: "x", context: { kind: "page", text: "t" } as any, offerAct: true }, "en").prompt;
    expect(bare).not.toContain("[[CLICK");
  });
});
