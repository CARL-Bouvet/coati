// Unit tests for the claude-api provider (BYOK, direct HTTPS to the
// Anthropic Messages API — see broker/src/providers/claude-api.ts): SSE line
// parsing, a full streamed success against a fake fetch, and the two error
// classifications the task brief calls out — 401/403 as AuthRequiredError
// with a French remedy message, 429 as model-unavailable.

import { describe, expect, test, afterEach } from "bun:test";
import {
  parseSseLine,
  parseSseStream,
  streamAnswer,
  claudeApiProvider,
  CLAUDE_API_AUTH_MESSAGE,
  CLAUDE_API_DEFAULT_MODEL,
  __setFetchImplForTests,
  __resetFetchImplForTests,
} from "../src/providers/claude-api.ts";
import {
  buildPrompt,
  isAuthRequiredError,
  isModelUnavailableError,
  AuthRequiredError,
  ModelUnavailableError,
} from "../src/model.ts";

afterEach(() => {
  __resetFetchImplForTests();
});

describe("claude-api provider registration", () => {
  test("id and label are set", () => {
    expect(claudeApiProvider.id).toBe("claude-api");
    expect(claudeApiProvider.label).toBeTruthy();
  });

  test("isAvailable reports false with no key, true with one", async () => {
    expect((await claudeApiProvider.isAvailable({})).available).toBe(false);
    expect((await claudeApiProvider.isAvailable({ apiKey: "" })).available).toBe(false);
    expect((await claudeApiProvider.isAvailable({ apiKey: "sk-ant-fake" })).available).toBe(true);
  });
});

describe("claude-api SSE line parsing", () => {
  test("a text_delta content_block_delta yields a delta event", () => {
    const state = { inputTokens: 0, outputTokens: 0 };
    const line = `data: ${JSON.stringify({
      type: "content_block_delta",
      index: 0,
      delta: { type: "text_delta", text: "Bon" },
    })}`;
    expect([...parseSseLine(line, state)]).toEqual([{ kind: "delta", text: "Bon" }]);
  });

  test("a thinking_delta content_block_delta yields nothing", () => {
    const state = { inputTokens: 0, outputTokens: 0 };
    const line = `data: ${JSON.stringify({
      type: "content_block_delta",
      index: 0,
      delta: { type: "thinking_delta", thinking: "hmm" },
    })}`;
    expect([...parseSseLine(line, state)]).toEqual([]);
  });

  test("message_start records input tokens without yielding", () => {
    const state = { inputTokens: 0, outputTokens: 0 };
    const line = `data: ${JSON.stringify({
      type: "message_start",
      message: { id: "msg_1", usage: { input_tokens: 42 } },
    })}`;
    expect([...parseSseLine(line, state)]).toEqual([]);
    expect(state.inputTokens).toBe(42);
  });

  test("message_delta records output tokens without yielding", () => {
    const state = { inputTokens: 0, outputTokens: 0 };
    const line = `data: ${JSON.stringify({ type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 7 } })}`;
    expect([...parseSseLine(line, state)]).toEqual([]);
    expect(state.outputTokens).toBe(7);
  });

  test("message_stop yields a usage event built from the accumulated state", () => {
    const state = { inputTokens: 10, outputTokens: 3 };
    const line = `data: ${JSON.stringify({ type: "message_stop" })}`;
    expect([...parseSseLine(line, state)]).toEqual([{ kind: "usage", usage: { inputTokens: 10, outputTokens: 3 } }]);
  });

  test("a non-data line (event:, blank, ping) yields nothing", () => {
    const state = { inputTokens: 0, outputTokens: 0 };
    expect([...parseSseLine("event: content_block_delta", state)]).toEqual([]);
    expect([...parseSseLine("", state)]).toEqual([]);
    expect([...parseSseLine(`data: ${JSON.stringify({ type: "ping" })}`, state)]).toEqual([]);
  });

  test("a malformed data line is skipped, not thrown", () => {
    const state = { inputTokens: 0, outputTokens: 0 };
    expect([...parseSseLine("data: {not json", state)]).toEqual([]);
  });

  test("an error event throws", () => {
    const state = { inputTokens: 0, outputTokens: 0 };
    const line = `data: ${JSON.stringify({ type: "error", error: { type: "overloaded_error", message: "boom" } })}`;
    expect(() => [...parseSseLine(line, state)]).toThrow("boom");
  });
});

function sseBody(lines: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  const whole = lines.map((l) => `${l}\n`).join("");
  return new ReadableStream({
    start(controller) {
      // Split arbitrarily to exercise the buffer-across-chunks path, same as
      // providers/ollama.ts's NDJSON stream test.
      controller.enqueue(encoder.encode(whole.slice(0, 10)));
      controller.enqueue(encoder.encode(whole.slice(10)));
      controller.close();
    },
  });
}

describe("claude-api SSE stream parsing", () => {
  test("parses a full message_start -> deltas -> message_delta -> message_stop stream", async () => {
    const lines = [
      `data: ${JSON.stringify({ type: "message_start", message: { usage: { input_tokens: 5 } } })}`,
      `data: ${JSON.stringify({ type: "content_block_delta", delta: { type: "text_delta", text: "Bon" } })}`,
      `data: ${JSON.stringify({ type: "content_block_delta", delta: { type: "text_delta", text: "jour" } })}`,
      `data: ${JSON.stringify({ type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 2 } })}`,
      `data: ${JSON.stringify({ type: "message_stop" })}`,
    ];
    const events = [];
    for await (const event of parseSseStream(sseBody(lines))) events.push(event);
    expect(events).toEqual([
      { kind: "delta", text: "Bon" },
      { kind: "delta", text: "jour" },
      { kind: "usage", usage: { inputTokens: 5, outputTokens: 2 } },
    ]);
  });
});

function fakeSseResponse(lines: string[]): Response {
  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const l of lines) controller.enqueue(encoder.encode(`${l}\n`));
      controller.close();
    },
  });
  return new Response(body, { status: 200 });
}

describe("claude-api streamAnswer — end to end against a fake fetch", () => {
  test("streams deltas and usage, and sends the key/model/headers correctly", async () => {
    let capturedUrl = "";
    let capturedHeaders: Record<string, string> = {};
    let capturedBody: any;
    __setFetchImplForTests((async (url: string, init: RequestInit) => {
      capturedUrl = url;
      capturedHeaders = init.headers as Record<string, string>;
      capturedBody = JSON.parse(init.body as string);
      return fakeSseResponse([
        `data: ${JSON.stringify({ type: "message_start", message: { usage: { input_tokens: 4 } } })}`,
        `data: ${JSON.stringify({ type: "content_block_delta", delta: { type: "text_delta", text: "salut" } })}`,
        `data: ${JSON.stringify({ type: "message_delta", delta: {}, usage: { output_tokens: 1 } })}`,
        `data: ${JSON.stringify({ type: "message_stop" })}`,
      ]);
    }) as unknown as typeof fetch);

    const built = buildPrompt({ kind: "chat", text: "salut" });
    const events = [];
    for await (const event of streamAnswer(built, { apiKey: "sk-ant-secret-value" })) {
      events.push(event);
    }
    expect(events).toEqual([
      { kind: "delta", text: "salut" },
      { kind: "usage", usage: { inputTokens: 4, outputTokens: 1 } },
    ]);

    expect(capturedUrl).toBe("https://api.anthropic.com/v1/messages");
    expect(capturedHeaders["x-api-key"]).toBe("sk-ant-secret-value");
    expect(capturedHeaders["anthropic-version"]).toBe("2023-06-01");
    expect(capturedBody.model).toBe(CLAUDE_API_DEFAULT_MODEL);
    expect(capturedBody.stream).toBe(true);
    expect(capturedBody.messages).toEqual([{ role: "user", content: built.prompt }]);
  });

  test("an overridden model in opts is sent instead of the default", async () => {
    let capturedModel = "";
    __setFetchImplForTests((async (_url: string, init: RequestInit) => {
      capturedModel = JSON.parse(init.body as string).model;
      return fakeSseResponse([`data: ${JSON.stringify({ type: "message_stop" })}`]);
    }) as unknown as typeof fetch);

    const built = buildPrompt({ kind: "chat", text: "hi" });
    for await (const _e of streamAnswer(built, { apiKey: "k", model: "claude-haiku-4-5" })) {
      // draining
    }
    expect(capturedModel).toBe("claude-haiku-4-5");
  });

  test("no API key configured fails as model-unavailable without any network call", async () => {
    let fetchCalled = false;
    __setFetchImplForTests((async () => {
      fetchCalled = true;
      throw new Error("should not be called");
    }) as unknown as typeof fetch);

    const built = buildPrompt({ kind: "chat", text: "salut" });
    const iterate = async () => {
      for await (const _event of streamAnswer(built, {})) {
        // draining
      }
    };
    await expect(iterate()).rejects.toBeInstanceOf(ModelUnavailableError);
    expect(fetchCalled).toBe(false);
  });

  // I3 (lot7 security review): a fetch()-level failure must never echo its
  // own message text (which could, in principle, repeat request details) into
  // the error the panel displays — a fixed, generic message only.
  test("a fetch()-level failure never forwards the raw error text to the client-facing message", async () => {
    __setFetchImplForTests((async () => {
      throw new Error("connect ECONNREFUSED 10.0.0.1:443 secret-looking-detail");
    }) as unknown as typeof fetch);

    const built = buildPrompt({ kind: "chat", text: "salut" });
    const err = await (async () => {
      try {
        for await (const _event of streamAnswer(built, { apiKey: "k" })) {
          // draining
        }
      } catch (e) {
        return e as Error;
      }
    })();
    expect(err).toBeInstanceOf(ModelUnavailableError);
    expect(err!.message).not.toContain("ECONNREFUSED");
    expect(err!.message).not.toContain("secret-looking-detail");
  });

  test("a 401 response surfaces as AuthRequiredError with the French remedy message, never the key", async () => {
    __setFetchImplForTests((async () => new Response("unauthorized", { status: 401 })) as unknown as typeof fetch);

    const built = buildPrompt({ kind: "chat", text: "salut" });
    const err = await (async () => {
      try {
        for await (const _event of streamAnswer(built, { apiKey: "sk-ant-should-never-leak" })) {
          // draining
        }
      } catch (e) {
        return e;
      }
    })();

    expect(err).toBeInstanceOf(AuthRequiredError);
    expect(isAuthRequiredError(err)).toBe(true);
    expect(isModelUnavailableError(err)).toBe(false);
    expect((err as Error).message).toBe(CLAUDE_API_AUTH_MESSAGE);
    expect((err as Error).message).not.toContain("sk-ant-should-never-leak");
  });

  test("a 403 response is also classified as AuthRequiredError", async () => {
    __setFetchImplForTests((async () => new Response("forbidden", { status: 403 })) as unknown as typeof fetch);
    const built = buildPrompt({ kind: "chat", text: "salut" });
    const err = await (async () => {
      try {
        for await (const _event of streamAnswer(built, { apiKey: "k" })) {
          // draining
        }
      } catch (e) {
        return e;
      }
    })();
    expect(err).toBeInstanceOf(AuthRequiredError);
  });

  test("a 429 response is classified as model-unavailable, not auth-required", async () => {
    __setFetchImplForTests((async () => new Response("rate limited", { status: 429 })) as unknown as typeof fetch);

    const built = buildPrompt({ kind: "chat", text: "salut" });
    const err = await (async () => {
      try {
        for await (const _event of streamAnswer(built, { apiKey: "k" })) {
          // draining
        }
      } catch (e) {
        return e;
      }
    })();

    expect(err).toBeInstanceOf(ModelUnavailableError);
    expect(isModelUnavailableError(err)).toBe(true);
    expect(isAuthRequiredError(err)).toBe(false);
  });

  test("a 500 response is classified as model-unavailable", async () => {
    __setFetchImplForTests((async () => new Response("boom", { status: 500 })) as unknown as typeof fetch);
    const built = buildPrompt({ kind: "chat", text: "salut" });
    const err = await (async () => {
      try {
        for await (const _event of streamAnswer(built, { apiKey: "k" })) {
          // draining
        }
      } catch (e) {
        return e;
      }
    })();
    expect(isModelUnavailableError(err)).toBe(true);
  });
});
