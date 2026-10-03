// Unit tests for the multi-provider abstraction (broker/src/providers/):
// the registry lists both known providers, and the ollama provider parses a
// streamed NDJSON body into deltas without needing a running Ollama daemon
// (fake fetch), and fails loudly (ModelUnavailableError) rather than
// silently falling back when the configured model isn't installed.

import { describe, expect, test, afterEach } from "bun:test";
import { getProviders, getProvider, __resetProvidersForTests } from "../src/providers/registry.ts";
import {
  parseNdjsonLine,
  parseNdjsonStream,
  streamAnswer as ollamaStreamAnswer,
  ollamaContextSize,
  __setFetchImplForTests,
  __resetFetchImplForTests,
} from "../src/providers/ollama.ts";
import { buildPrompt, isModelUnavailableError, ModelUnavailableError } from "../src/model.ts";

afterEach(() => {
  __resetFetchImplForTests();
});

describe("provider registry", () => {
  afterEach(() => {
    __resetProvidersForTests();
  });

  test("lists the built-in providers by default (no modules configured)", () => {
    const ids = getProviders().map((p) => p.id);
    expect(ids).toEqual(["ollama", "claude-api", "openai-compat"]);
  });

  test("getProvider finds by id", () => {
    expect(getProvider("ollama")?.label).toBeTruthy();
    expect(getProvider("claude-api")?.label).toBeTruthy();
  });

  test("getProvider returns undefined for an unknown id", () => {
    expect(getProvider("nonsense")).toBeUndefined();
    expect(getProvider(undefined)).toBeUndefined();
  });
});

describe("ollamaContextSize — bucket selection", () => {
  // estimatedTokens = ceil(totalChars / 3) + 1024
  // 4096 bucket: estimatedTokens <= 4096  →  totalChars <= 9216
  // 8192 bucket: estimatedTokens <= 8192  →  totalChars <= 21504
  // 16384 bucket / cap:                      totalChars > 21504

  test("empty prompt → 4096 (minimum bucket)", () => {
    expect(ollamaContextSize(0)).toBe(4096);
  });

  test("short prompt (100 chars) → 4096", () => {
    expect(ollamaContextSize(100)).toBe(4096);
  });

  test("last char fitting 4096 bucket (9216 chars) → 4096", () => {
    // ceil(9216/3)+1024 = 3072+1024 = 4096
    expect(ollamaContextSize(9216)).toBe(4096);
  });

  test("one char over 4096 boundary (9217 chars) → 8192", () => {
    // ceil(9217/3)+1024 = 3073+1024 = 4097
    expect(ollamaContextSize(9217)).toBe(8192);
  });

  test("~20k chars (typical medium page) → 8192", () => {
    expect(ollamaContextSize(20000)).toBe(8192);
  });

  test("last char fitting 8192 bucket (21504 chars) → 8192", () => {
    // ceil(21504/3)+1024 = 7168+1024 = 8192
    expect(ollamaContextSize(21504)).toBe(8192);
  });

  test("one char over 8192 boundary (21505 chars) → 16384", () => {
    // ceil(21505/3)+1024 = 7169+1024 = 8193
    expect(ollamaContextSize(21505)).toBe(16384);
  });

  test("40000 chars (extension extract cap) → 16384", () => {
    // ceil(40000/3)+1024 = 13334+1024 = 14358
    expect(ollamaContextSize(40000)).toBe(16384);
  });

  test("huge input (200000 chars) is capped at 16384", () => {
    expect(ollamaContextSize(200000)).toBe(16384);
  });
});

describe("ollama NDJSON line parsing", () => {
  test("a content line yields a delta event", () => {
    const events = [...parseNdjsonLine(JSON.stringify({ message: { role: "assistant", content: "hi" }, done: false }))];
    expect(events).toEqual([{ kind: "delta", text: "hi" }]);
  });

  test("a done line yields a usage event with token counts", () => {
    const events = [
      ...parseNdjsonLine(
        JSON.stringify({ message: { role: "assistant", content: "" }, done: true, prompt_eval_count: 12, eval_count: 4 }),
      ),
    ];
    expect(events).toEqual([{ kind: "usage", usage: { inputTokens: 12, outputTokens: 4 } }]);
  });

  test("a line with both content and done yields both events, in order", () => {
    const events = [
      ...parseNdjsonLine(
        JSON.stringify({ message: { content: "bye" }, done: true, prompt_eval_count: 1, eval_count: 1 }),
      ),
    ];
    expect(events).toEqual([
      { kind: "delta", text: "bye" },
      { kind: "usage", usage: { inputTokens: 1, outputTokens: 1 } },
    ]);
  });

  test("a blank line yields nothing", () => {
    expect([...parseNdjsonLine("")]).toEqual([]);
    expect([...parseNdjsonLine("   ")]).toEqual([]);
  });

  test("a malformed line is skipped, not thrown", () => {
    expect([...parseNdjsonLine("{not json")]).toEqual([]);
  });
});

function bodyFromChunks(chunks: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });
}

describe("ollama NDJSON stream parsing", () => {
  test("parses multiple NDJSON lines split arbitrarily across chunks", async () => {
    const line1 = JSON.stringify({ message: { content: "Hel" }, done: false }) + "\n";
    const line2 = JSON.stringify({ message: { content: "lo" }, done: false }) + "\n";
    const line3 = JSON.stringify({ message: { content: "" }, done: true, prompt_eval_count: 5, eval_count: 2 }) + "\n";
    // Split mid-line to exercise the buffer-across-chunks path.
    const whole = line1 + line2 + line3;
    const chunks = [whole.slice(0, 10), whole.slice(10)];

    const events = [];
    for await (const event of parseNdjsonStream(bodyFromChunks(chunks))) {
      events.push(event);
    }
    expect(events).toEqual([
      { kind: "delta", text: "Hel" },
      { kind: "delta", text: "lo" },
      { kind: "usage", usage: { inputTokens: 5, outputTokens: 2 } },
    ]);
  });

  test("flushes a trailing line with no terminating newline", async () => {
    const chunks = [JSON.stringify({ message: { content: "last" }, done: false })];
    const events = [];
    for await (const event of parseNdjsonStream(bodyFromChunks(chunks))) {
      events.push(event);
    }
    expect(events).toEqual([{ kind: "delta", text: "last" }]);
  });
});

function fakeTagsResponse(names: string[]): Response {
  return new Response(JSON.stringify({ models: names.map((name) => ({ name })) }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

describe("ollama streamAnswer — end to end against a fake fetch", () => {
  test("fetch body includes options.num_ctx sized to the prompt", async () => {
    let capturedBody: unknown;
    __setFetchImplForTests((async (url: string, init?: RequestInit) => {
      if (url.endsWith("/api/tags")) return fakeTagsResponse(["llama3.2:latest"]);
      if (url.endsWith("/api/chat")) {
        capturedBody = JSON.parse(init?.body as string);
        const line = JSON.stringify({ message: { content: "" }, done: true, prompt_eval_count: 1, eval_count: 1 }) + "\n";
        return new Response(bodyFromChunks([line]), { status: 200 });
      }
      throw new Error(`unexpected fetch: ${url}`);
    }) as unknown as typeof fetch);

    const built = buildPrompt({ kind: "chat", text: "hello" });
    for await (const _e of ollamaStreamAnswer(built, { model: "llama3.2" })) { /* drain */ }

    expect(capturedBody).toBeDefined();
    const body = capturedBody as Record<string, unknown>;
    expect(body.options).toBeDefined();
    const opts = body.options as Record<string, unknown>;
    expect(typeof opts.num_ctx).toBe("number");
    expect([4096, 8192, 16384]).toContain(opts.num_ctx);
  });

  test("streams deltas and usage from a full fake /api/chat response", async () => {
    const chatLines =
      [
        JSON.stringify({ message: { content: "Bon" }, done: false }),
        JSON.stringify({ message: { content: "jour" }, done: false }),
        JSON.stringify({ message: { content: "" }, done: true, prompt_eval_count: 7, eval_count: 3 }),
      ].join("\n") + "\n";

    __setFetchImplForTests((async (url: string) => {
      if (url.endsWith("/api/tags")) return fakeTagsResponse(["llama3.2:latest"]);
      if (url.endsWith("/api/chat")) {
        return new Response(bodyFromChunks([chatLines]), { status: 200 });
      }
      throw new Error(`unexpected fetch: ${url}`);
    }) as unknown as typeof fetch);

    const built = buildPrompt({ kind: "chat", text: "salut" });
    const events = [];
    for await (const event of ollamaStreamAnswer(built, { model: "llama3.2" })) {
      events.push(event);
    }
    expect(events).toEqual([
      { kind: "delta", text: "Bon" },
      { kind: "delta", text: "jour" },
      { kind: "usage", usage: { inputTokens: 7, outputTokens: 3 } },
    ]);
  });

  test("a configured model absent from /api/tags fails as model-unavailable, without calling /api/chat", async () => {
    let chatCalled = false;
    __setFetchImplForTests((async (url: string) => {
      if (url.endsWith("/api/tags")) return fakeTagsResponse(["llama3.2:latest"]);
      if (url.endsWith("/api/chat")) {
        chatCalled = true;
        return new Response("{}", { status: 200 });
      }
      throw new Error(`unexpected fetch: ${url}`);
    }) as unknown as typeof fetch);

    const built = buildPrompt({ kind: "chat", text: "salut" });
    const iterate = async () => {
      for await (const _event of ollamaStreamAnswer(built, { model: "mistral" })) {
        // draining
      }
    };

    await expect(iterate()).rejects.toBeInstanceOf(ModelUnavailableError);
    const err = await iterate().catch((e) => e);
    expect(err.message).toContain("mistral");
    expect(chatCalled).toBe(false);
    expect(isModelUnavailableError(err)).toBe(true);
  });

  test("no model configured fails as model-unavailable without any network call", async () => {
    let fetchCalled = false;
    __setFetchImplForTests((async () => {
      fetchCalled = true;
      throw new Error("should not be called");
    }) as unknown as typeof fetch);

    const built = buildPrompt({ kind: "chat", text: "salut" });
    const iterate = async () => {
      for await (const _event of ollamaStreamAnswer(built, {})) {
        // draining
      }
    };
    await expect(iterate()).rejects.toBeInstanceOf(ModelUnavailableError);
    expect(fetchCalled).toBe(false);
  });

  test("an unreachable Ollama daemon is classified as model-unavailable", async () => {
    __setFetchImplForTests((async () => {
      throw new Error("fetch failed: connect ECONNREFUSED 127.0.0.1:11434");
    }) as unknown as typeof fetch);

    const built = buildPrompt({ kind: "chat", text: "salut" });
    const err = await (async () => {
      try {
        for await (const _event of ollamaStreamAnswer(built, { model: "llama3.2" })) {
          // draining
        }
      } catch (e) {
        return e;
      }
      return undefined;
    })();
    expect(err).toBeInstanceOf(ModelUnavailableError);
    expect(isModelUnavailableError(err)).toBe(true);
  });
});
