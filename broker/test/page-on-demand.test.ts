// "page on demand" — docs/PROTOCOL.md "Page on demand". Covers
// protocol parsing (chat.page/devMode, page.content/page.decline, size
// limits), the shared marker detector (model/page-marker.ts), the full
// re-run flow against a fake provider (startServer + __setProvidersForTests,
// same pattern as concurrency.test.ts), decline, read caps, and the English
// scaffolding (model/render.ts, no French left in the on-demand prompt).

import { describe, expect, test, afterEach, spyOn } from "bun:test";
import {
  parseClientMessage,
  MAX_MESSAGE_BYTES,
  MAX_LARGE_MESSAGE_BYTES,
  type ChatMessage,
  type ServerMessage,
} from "../src/protocol.ts";
import { buildPrompt } from "../src/model.ts";
import { PageMarkerDetector, MARKER_TEXT, MARKER_DEV } from "../src/model/page-marker.ts";
import { pageContentRoom, resolveActiveContextTokens, searchCharBudget, PAGE_REQUEST_TIMEOUT_MS, SEARCH_REQUEST_TIMEOUT_MS } from "../src/handlers/chat.ts";
import { startServer, MAX_PAGE_CHARS } from "../src/server.ts";
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

  test.each(["text", "dev"] as const)("a %s-level page.content may exceed MAX_MESSAGE_BYTES, up to MAX_LARGE_MESSAGE_BYTES", (level) => {
    const raw = JSON.stringify({
      type: "page.content",
      id: "pc1",
      target: "c1",
      level,
      context: { kind: "page", text: "x".repeat(MAX_MESSAGE_BYTES + 1000) },
    });
    expect(Buffer.byteLength(raw, "utf8")).toBeGreaterThan(MAX_MESSAGE_BYTES);
    expect(Buffer.byteLength(raw, "utf8")).toBeLessThan(MAX_LARGE_MESSAGE_BYTES);
    expect(parseClientMessage(raw).ok).toBe(true);
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
// pageContentRoom — pure unit tests
// ---------------------------------------------------------------------------

describe("pageContentRoom", () => {
  const other = { ollama: false, hasHistory: false };
  const ollama = { ollama: true, hasHistory: false };

  test("never exceeds MAX_PAGE_CHARS even for a huge context window", () => {
    expect(pageContentRoom(10_000_000, 0, other)).toBeLessThanOrEqual(MAX_PAGE_CHARS);
  });

  test("falls back to a fixed default when contextTokens is unknown", () => {
    expect(pageContentRoom(undefined, 0, ollama)).toBeGreaterThan(0);
    expect(pageContentRoom(undefined, 0, other)).toBeGreaterThan(0);
  });

  test("grows with the window, shrinks with the overhead and the history reserve", () => {
    expect(pageContentRoom(4096, 0, other)).toBeLessThan(pageContentRoom(32_000, 0, other));
    expect(pageContentRoom(32_000, 5_000, other)).toBeLessThan(pageContentRoom(32_000, 0, other));
    expect(pageContentRoom(32_000, 0, { ollama: false, hasHistory: true })).toBeLessThan(pageContentRoom(32_000, 0, other));
    expect(pageContentRoom(8192, 3_000, ollama)).toBeLessThan(pageContentRoom(8192, 0, ollama));
  });

  test("Ollama room matches the num_ctx rule: (tokens - 1024) * 3 - overhead", () => {
    expect(pageContentRoom(8192, 1_000, ollama)).toBe((8192 - 1024) * 3 - 1_000);
  });

  test("a part always makes progress, even when the overhead fills the window", () => {
    expect(pageContentRoom(4096, 1_000_000, other)).toBeGreaterThan(0);
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
  test("a call cut by the broker makes done.usage uncounted", async () => {
    const server = boot({
      ...fakeOnDemandProvider("fixture-pod-uncounted"),
      async *streamAnswer() {
        yield { kind: "delta", text: "cut here" };
        yield { kind: "usage", usage: { inputTokens: 0, outputTokens: 0, uncounted: true } };
      },
    });
    const ws = await connect(server);
    const messages = collectMessages(ws);
    ws.send(JSON.stringify({ type: "chat", id: "cu", text: "hi" }));
    const done = await waitFor(messages, (m) => m.type === "done");
    expect((done as any).usage.uncounted).toBe(true);
  });

  test("a marker call that keeps writing is cut after the drain wait and flagged uncounted", async () => {
    const base = fakeOnDemandProvider("fixture-pod-drain");
    const server = boot({
      ...base,
      async *streamAnswer(built: any, opts: any) {
        if (!built.prompt.includes("Page available (not yet read)")) return yield* base.streamAnswer(built, opts);
        yield { kind: "delta", text: MARKER_TEXT };
        yield { kind: "delta", text: "more text" };
        await new Promise((ok) => opts.signal.addEventListener("abort", ok));
        throw new Error("aborted");
      },
    });
    const ws = await connect(server);
    const messages = collectMessages(ws);
    ws.send(JSON.stringify({ type: "chat", id: "cd", text: "what?", page: { title: "T", url: "https://example.com", chars: 42 } }));
    await waitFor(messages, (m) => m.type === "page.request", 5000);
    expect(messages.some((m) => m.type === "chunk")).toBe(false);
    ws.send(JSON.stringify({ type: "page.content", id: "pd", target: "cd", level: "text", context: { kind: "page", text: "PAGE_CONTENT_SEEN" } }));
    const done = await waitFor(messages, (m) => m.type === "done");
    expect((done as any).usage).toMatchObject({ inputTokens: 20, outputTokens: 5, uncounted: true });
  });

  test("while draining a marker call, trailing text and a second marker are swallowed and the usage is counted", async () => {
    const base = fakeOnDemandProvider("fixture-pod-trailing");
    const prompts: string[] = [];
    const server = boot({
      ...base,
      async *streamAnswer(built: any, opts: any) {
        prompts.push(built.prompt);
        if (!built.prompt.includes("Page available (not yet read)")) return yield* base.streamAnswer(built, opts);
        yield { kind: "delta", text: `${MARKER_TEXT} TRAILING_ONE ` };
        yield { kind: "delta", text: `TRAILING_TWO ${MARKER_TEXT}` };
        yield { kind: "usage", usage: { inputTokens: 10, outputTokens: 1 } };
      },
    });
    const ws = await connect(server);
    const messages = collectMessages(ws);
    ws.send(JSON.stringify({ type: "chat", id: "ct", text: "what?", page: { title: "T", url: "https://example.com", chars: 42 } }));
    await waitFor(messages, (m) => m.type === "page.request");
    ws.send(JSON.stringify({ type: "page.content", id: "pt", target: "ct", level: "text", context: { kind: "page", text: "PAGE_CONTENT_SEEN" } }));
    const done: any = await waitFor(messages, (m) => m.type === "done");
    expect(messages.filter((m) => m.type === "page.request")).toHaveLength(1);
    const chunks = messages.filter((m) => m.type === "chunk").map((m: any) => m.delta).join("");
    expect(chunks).toBe("Got it: PAGE_CONTENT_SEEN");
    expect(prompts.at(-1)).not.toContain("TRAILING");
    expect(done.usage).toEqual({ inputTokens: 30, outputTokens: 6 });
    expect(done.limits?.refused).toBeUndefined();
  });

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
    // The marker call is left to end, so its usage (sent right after the marker) is summed in.
    expect((done as any).usage.uncounted).toBeUndefined();
    expect(done).toMatchObject({
      type: "done",
      id: "c1",
      usage: { inputTokens: 30, outputTokens: 6 },
      page: { level: "text", chars: 22, from: 0, sentChars: 22, truncated: false },
    });

    const chunks = messages.filter((m) => m.type === "chunk").map((m: any) => m.delta).join("");
    expect(chunks).toBe("Got it: PAGE_CONTENT_SEEN");
    // The marker itself must never have been forwarded as a chunk.
    expect(chunks).not.toContain("READ_PAGE");

    ws.send(JSON.stringify({ type: "run.get", id: "r1", target: "c1" }));
    const reply: any = await waitFor(messages, (m) => m.type === "run");
    expect(reply.run.steps.map((st: any) => st.kind)).toEqual(["call", "read", "call"]);
    expect(reply.run.steps[0]).toMatchObject({ n: 1, stop: "marker", inputTokens: 10, outputTokens: 1, decision: "accepted", marker: { type: "read", level: "text" } });
    expect(reply.run.steps[1]).toMatchObject({ answer: "page", chars: 22 });
    expect(reply.run.steps[2]).toMatchObject({ n: 2, inputTokens: 20, outputTokens: 5, stop: "answer" });
    expect(JSON.stringify(reply.run)).not.toContain("PAGE_CONTENT_SEEN here");

    ws.close();
  });

  test("run.get: unknown or evicted runs are found:false; the last 5 are kept", async () => {
    const server = boot(fakeOnDemandProvider("fixture-pod-ring"));
    const ws = await connect(server);
    const messages = collectMessages(ws);
    for (let i = 1; i <= 6; i++) {
      ws.send(JSON.stringify({ type: "chat", id: `ring${i}`, text: `q${i}` }));
      await waitFor(messages, (m) => m.type === "done" && m.id === `ring${i}`);
    }
    for (const target of ["ring1", "never-seen", "ring2", "ring6"]) {
      ws.send(JSON.stringify({ type: "run.get", id: `g-${target}`, target }));
    }
    const found = async (target: string) => ((await waitFor(messages, (m) => m.type === "run" && m.target === target)) as any).found;
    expect([await found("ring1"), await found("never-seen"), await found("ring2"), await found("ring6")]).toEqual([false, false, true, true]);
    ws.close();
  });

  test("a call stopped on length: memoryFull, reasoned, local figures from /api/ps, reasoning in the run only", async () => {
    __setFetchImplForTests(
      (async (url: string) => {
        if (String(url).endsWith("/api/ps")) return new Response(JSON.stringify({ models: [{ name: "x", size: 100, size_vram: 62 }] }), { status: 200 });
        throw new Error(`unexpected fetch: ${url}`);
      }) as unknown as typeof fetch,
    );
    try {
      const server = boot({
        ...fakeOnDemandProvider("ollama"),
        async *streamAnswer() {
          yield { kind: "thinking", text: "SECRET_REASONING" };
          yield { kind: "delta", text: "partial" };
          yield { kind: "usage", usage: { inputTokens: 7000, outputTokens: 600 }, stop: "length", stats: { numCtx: 8192, evalMs: 2000 } };
        },
      });
      const ws = await connect(server);
      const messages = collectMessages(ws);
      ws.send(JSON.stringify({ type: "chat", id: "len1", text: "hi" }));
      const done: any = await waitFor(messages, (m) => m.type === "done");
      expect(done.reasoned).toBe(true);
      expect(done.limits.memoryFull).toEqual({ tokens: 7600, contextTokens: 8192 });
      expect(done.limits.local).toMatchObject({ gpuPercent: 62, contextTokens: 8192, tokensPerSec: 300 });
      expect(JSON.stringify(done)).not.toContain("SECRET_REASONING");
      ws.send(JSON.stringify({ type: "run.get", id: "r2", target: "len1" }));
      const reply: any = await waitFor(messages, (m) => m.type === "run");
      expect(reply.run.steps[0]).toMatchObject({ stop: "length", reasoning: "SECRET_REASONING", inputTokens: 7000 });
      expect(reply.run.limits).toEqual(done.limits);
      ws.close();
    } finally {
      __resetFetchImplForTests();
    }
  });

  test("the journal gets one timeline line: calls, page.request, done, never the page text", async () => {
    const lines: string[] = [];
    const spy = spyOn(console, "log").mockImplementation((...args: unknown[]) => void lines.push(args.join(" ")));
    try {
      const server = boot(fakeOnDemandProvider("fixture-pod-timeline"));
      const ws = await connect(server);
      const messages = collectMessages(ws);
      ws.send(JSON.stringify({ type: "chat", id: "tl1", text: "q", page: { title: "T", url: "https://example.com", chars: 42 } }));
      await waitFor(messages, (m) => m.type === "page.request");
      ws.send(JSON.stringify({ type: "page.content", id: "pc1", target: "tl1", level: "text", context: { kind: "page", text: "PAGE_CONTENT_SEEN here" } }));
      await waitFor(messages, (m) => m.type === "done");
      ws.close();
    } finally {
      spy.mockRestore();
    }
    const line = lines.find((l) => l.includes("request timeline id=tl1"));
    expect(line).toMatch(/0\.\d call1 .*page\.request:text .*call2 .*chunk×\d+ .*done · longest silence after a chunk \d+ s$/);
    expect(line).not.toContain("PAGE_CONTENT_SEEN");
  });

  test("text-level content larger than the window is cut on a line break and reported", async () => {
    const server = boot(fakeOnDemandProvider("fixture-pod-fit"));
    const ws = await connect(server);
    const messages = collectMessages(ws);
    ws.send(JSON.stringify({ type: "chat", id: "fit1", text: "q", page: { title: "T", url: "https://example.com", chars: 300_000 } }));
    await waitFor(messages, (m) => m.type === "page.request");
    const text = `${"l".repeat(99)}\n`.repeat(3_000);
    ws.send(JSON.stringify({ type: "page.content", id: "pc1", target: "fit1", level: "text", context: { kind: "page", text } }));
    const done: any = await waitFor(messages, (m) => m.type === "done");
    expect(done.page).toMatchObject({ level: "text", chars: 300_000, from: 0, truncated: true });
    expect(done.page.sentChars).toBeLessThan(300_000);
    expect(done.page.sentChars % 100).toBe(0);
    ws.close();
  });

  test("a chat with context and readPart reads from the offset; the part is reported", async () => {
    const server = boot(fakeOnDemandProvider("fixture-pod-part"));
    const ws = await connect(server);
    const messages = collectMessages(ws);
    const text = `${"l".repeat(99)}\n`.repeat(3_000);
    ws.send(
      JSON.stringify({
        type: "chat",
        id: "part1",
        text: "q",
        context: { kind: "page", text, facts: [{ label: "a", value: "b" }] },
        readPart: { from: 100_000, level: "text" },
      }),
    );
    const done: any = await waitFor(messages, (m) => m.type === "done");
    expect(done.page).toMatchObject({ level: "text", chars: 300_000, from: 100_000, truncated: true });
    ws.send(JSON.stringify({ type: "summarize", id: "part2", context: { kind: "page", text }, readPart: { from: 299_000, level: "text" } }));
    const last: any = await waitFor(messages, (m: any) => m.type === "done" && m.id === "part2");
    expect(last.page).toEqual({ level: "text", chars: 300_000, from: 299_000, sentChars: 1_000, truncated: false });
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

    await waitFor(messages, (m) => m.type === "error");
    expect(messages.find((m) => m.type === "error")).toMatchObject({ code: "model-empty" });
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

  test("the resulting room is far above the 8192-token fallback, still capped", () => {
    const claudeRoom = pageContentRoom(200_000, 0, { ollama: false, hasHistory: false });
    expect(claudeRoom).toBeGreaterThan(pageContentRoom(8192, 0, { ollama: false, hasHistory: false }));
    expect(claudeRoom).toBeLessThanOrEqual(MAX_PAGE_CHARS);
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
        yield { kind: "thinking", text: "hmm" };
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
    expect(done.limits.refused).toEqual([
      { kind: "open", reason: "pages", count: 1, limit: 6 },
      { kind: "search", reason: "searches", count: 1, limit: 4 },
    ]);
    ws.send(JSON.stringify({ type: "run.get", id: "r-limits", target: "c2" }));
    const { run }: any = await waitFor(messages, (m) => m.type === "run");
    expect(run.steps.map((st: any) => st.kind)).toEqual(["call", "search", "call", "search", "call", "search", "call", "search", "call", "open", "call", "open", "call"]);
    expect(run.steps[1]).toMatchObject({ answer: "results", results: 2 });
    expect(run.steps[9]).toMatchObject({ answer: "pages", pages: [{ n: 1, title: "P1", host: "r1.example", chars: "PAGE_TEXT_S1".length }, expect.anything(), expect.anything()] });
    expect(run.steps[12]).toMatchObject({ decision: "refused", reason: "pages", marker: { type: "open", refs: [7] } });
    expect(run.limits).toEqual(done.limits);
    expect(JSON.stringify(run)).not.toContain("snippet ");
    expect(JSON.stringify(run)).not.toContain("PAGE_TEXT_S1\"");
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
    await waitFor(messages, (m) => m.type === "error");
    expect(prompts).toHaveLength(10);
    expect(messages.filter((m) => m.type === "open.request")).toHaveLength(5);
    expect(prompts[9]).not.toContain("[[OPEN:");
    expect(messages.find((m) => m.type === "error")).toMatchObject({
      code: "model-empty",
      limits: { refused: [{ kind: "open", reason: "turns", count: 1, limit: 10 }] },
    });
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
    expect((await waitFor(messages, (m) => m.type === "done")) as any).toMatchObject({
      limits: { refused: [{ kind: "open", reason: "unknown-ref", count: 1 }], answerNow: true },
    });
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

  test("[[OPEN]] shape: S<n> refs, spaces or commas, first 3 kept; anything else stays text", () => {
    const feed = (s: string, allowSearch = true) => {
      const d = new PageMarkerDetector({ allowDev: false, allowSearch });
      return [...d.feed(s), ...d.flush()];
    };
    expect(feed("[[OPEN: S2, S5 S2]]")).toEqual([{ kind: "marker", marker: { type: "open", refs: [2, 5] }, position: "start" }]);
    expect(feed("[[OPEN: S1 S2 S5 S8]]")).toEqual([{ kind: "marker", marker: { type: "open", refs: [1, 2, 5] }, position: "start" }]);
    for (const text of ["[[OPEN: 2]]", "[[OPEN:]]", "[[OPEN: S0]]"]) {
      expect(feed(text).map((e) => (e.kind === "text" ? e.text : "MARKER")).join("")).toBe(text);
    }
    expect(feed("[[OPEN: S1]]", false)).toEqual([{ kind: "text", text: "[[OPEN: S1]]" }]);
  });

  test("marker variants small models write: READ_PAGE with refs, any case, [S2] refs, many refs", () => {
    const feed = (s: string, allowSearch = true) => {
      const d = new PageMarkerDetector({ allowDev: true, allowSearch });
      return [...d.feed(s), ...d.flush()];
    };
    const open = (refs: number[]) => [{ kind: "marker", marker: { type: "open", refs }, position: "start" }];
    expect(feed("[[READ_PAGE: S2]]")).toEqual(open([2]));
    expect(feed("[[READ_PAGE_DEV: S2 S3]]")).toEqual(open([2, 3]));
    expect(feed("[[open: s2]]")).toEqual(open([2]));
    expect(feed("[[OPEN: [S2], [S5]]]")).toEqual(open([2, 5]));
    expect(feed("[[OPEN: S1, S2, S3, S4, S5, S6, S7, S8]]")).toEqual(open([1, 2, 3]));
    expect(feed("[[read_page]]")).toEqual([{ kind: "marker", marker: { type: "read", level: "text" }, position: "start" }]);
    expect(feed("[[READ_PAGE: S2]]", false)).toEqual([{ kind: "text", text: "[[READ_PAGE: S2]]" }]);
    expect(feed("[[READ_PAGE: hello]]")).toEqual([{ kind: "text", text: "[[READ_PAGE: hello]]" }]);
    // A single closing bracket, at the end of the answer or of its line.
    expect(feed("[[SEARCH: coati diet 2024]")).toEqual([{ kind: "marker", marker: { type: "search", query: "coati diet 2024" }, position: "start" }]);
    expect(feed("Let me look.\n[[OPEN: S2 S5]\nthanks")).toContainEqual({ kind: "marker", marker: { type: "open", refs: [2, 5] }, position: "mid" });
    expect(feed("[[SEARCH: coati] diet")).toEqual([{ kind: "text", text: "[[SEARCH: coati] diet" }]);
  });

  test("a reply that stays empty after the retry ends with model-empty, never an empty done", async () => {
    const server = boot(scriptedProvider("fixture-model-empty", [["[[SEARCH: q]]"], ["[[OPEN: S9]]"]], []));
    const ws = await connect(server);
    const messages = collectMessages(ws);
    autoClient(ws, 1);
    ws.send(JSON.stringify({ type: "chat", id: "c-empty", text: "hi", abilities: ["search"] }));
    await waitFor(messages, (m) => m.type === "error" || m.type === "done");
    expect(messages.some((m) => m.type === "done")).toBe(false);
    expect(messages.find((m) => m.type === "error")).toMatchObject({ code: "model-empty" });
    ws.close();
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

  test("open.content failed -> one note per ref with its reason, an unlisted missing ref stays \"not read\"; a failed ref also in pages is bad-request", async () => {
    const prompts: string[] = [];
    const server = boot(scriptedProvider("fixture-open-failed", [["[[SEARCH: q]]"], ["[[OPEN: S1 S2 S3]]"], ["ok"]], prompts));
    const ws = await connect(server);
    const messages = collectMessages(ws);
    ws.send(JSON.stringify({ type: "chat", id: "c8", text: "hi", abilities: ["search"] }));
    await waitFor(messages, (m) => m.type === "search.request");
    const results = [1, 2, 3].map((k) => result("q", k));
    ws.send(JSON.stringify({ ...SEARCH_CONTENT, target: "c8", results }));
    await waitFor(messages, (m) => m.type === "open.request");
    const pages = [{ n: 1, url: "https://r1.example/q", title: "P1", text: "PAGE_TEXT_S1" }];
    ws.send(JSON.stringify({ type: "open.content", id: "oc", target: "c8", pages, failed: [{ n: 2, reason: "http", status: 502 }] }));
    await waitFor(messages, (m) => m.type === "done");
    expect(prompts[2]).toContain("Pages [S2] could not be read (HTTP 502)");
    expect(prompts[2]).toContain("Pages [S3] could not be read (not read)");
    expect(prompts[2]).not.toContain("Pages [S1] could not");
    ws.close();

    const again = await connect(boot(scriptedProvider("fixture-open-failed-dup", [["[[SEARCH: q]]"], ["[[OPEN: S1]]"]], [])));
    const again1 = collectMessages(again);
    again.send(JSON.stringify({ type: "chat", id: "c9", text: "hi", abilities: ["search"] }));
    await waitFor(again1, (m) => m.type === "search.request");
    again.send(JSON.stringify({ ...SEARCH_CONTENT, target: "c9" }));
    await waitFor(again1, (m) => m.type === "open.request");
    again.send(JSON.stringify({ type: "open.content", id: "oc", target: "c9", pages, failed: [{ n: 1, reason: "failed" }] }));
    expect(await waitFor(again1, (m) => m.type === "error")).toMatchObject({ code: "bad-request" });
    again.close();
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
    ws.send(JSON.stringify({ type: "run.get", id: "rg5", target: "s5" }));
    const reply: any = await waitFor(messages, (m) => m.type === "run");
    expect(reply.run.steps.find((st: any) => st.kind === "search")).toMatchObject({ answer: "declined", declineReason: "blocked" });
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
