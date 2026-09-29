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
    expect(ids).toEqual(["ollama", "claude-api"]);
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
