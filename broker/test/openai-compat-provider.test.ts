// Unit + integration tests for the openai-compat provider (goal G5,
// docs/PROTOCOL.md "Fournisseur de modèle" — one adapter for LM Studio,
// Ollama's /v1, OpenAI, Mistral, OpenRouter, DeepSeek). Integration tests
// drive a REAL fake OpenAI-compatible server via Bun.serve on 127.0.0.1, a
// random port (task brief) — no fake fetch for those, only for the pure
// SSE-line-parsing unit tests below.

import { describe, expect, test, afterEach } from "bun:test";
import {
  parseSseLine,
  parseSseStream,
  streamAnswer,
  openaiCompatProvider,
  isAllowedBaseUrl,
  OPENAI_COMPAT_AUTH_MESSAGE,
  __setFetchImplForTests,
  __resetFetchImplForTests,
} from "../src/providers/openai-compat.ts";
import {
  buildPrompt,
  isAuthRequiredError,
  isModelUnavailableError,
  isQuotaExceededError,
  isRateLimitedError,
  AuthRequiredError,
  ModelUnavailableError,
  QuotaExceededError,
  RateLimitedError,
  ModelMissingError,
  ProviderOverloadedError,
} from "../src/model.ts";

afterEach(() => {
  __resetFetchImplForTests();
});

describe("openai-compat provider registration", () => {
  test("id and label are set", () => {
    expect(openaiCompatProvider.id).toBe("openai-compat");
    expect(openaiCompatProvider.label).toBeTruthy();
  });

  test("isAvailable reports false with no baseUrl", async () => {
    expect((await openaiCompatProvider.isAvailable({})).available).toBe(false);
  });
});

describe("openai-compat baseUrl security gate (isAllowedBaseUrl)", () => {
  test("https:// is always allowed", () => {
    expect(isAllowedBaseUrl("https://api.openai.com/v1")).toBe(true);
    expect(isAllowedBaseUrl("https://example.com/v1")).toBe(true);
  });

  test("http:// is allowed only on loopback", () => {
    expect(isAllowedBaseUrl("http://localhost:1234/v1")).toBe(true);
    expect(isAllowedBaseUrl("http://127.0.0.1:11434/v1")).toBe(true);
    expect(isAllowedBaseUrl("http://[::1]:8080/v1")).toBe(true);
  });

  test("http:// to a non-loopback host is rejected", () => {
    expect(isAllowedBaseUrl("http://example.com/v1")).toBe(false);
    expect(isAllowedBaseUrl("http://10.0.0.5:1234/v1")).toBe(false);
  });

  test("other schemes and garbage are rejected", () => {
    expect(isAllowedBaseUrl("ftp://localhost/v1")).toBe(false);
    expect(isAllowedBaseUrl("not a url")).toBe(false);
    expect(isAllowedBaseUrl("")).toBe(false);
  });
});

describe("openai-compat SSE line parsing", () => {
  test("a content delta yields a delta event", () => {
    const line = `data: ${JSON.stringify({ choices: [{ delta: { content: "Bon" } }] })}`;
    expect([...parseSseLine(line)]).toEqual([{ kind: "delta", text: "Bon" }]);
  });

  test("[DONE] yields nothing", () => {
    expect([...parseSseLine("data: [DONE]")]).toEqual([]);
  });

  test("a chunk with no delta/role (tolerant of providers that omit it) yields nothing", () => {
    const line = `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: null }] })}`;
    expect([...parseSseLine(line)]).toEqual([]);
  });

  test("a usage-bearing chunk yields a usage event", () => {
    const line = `data: ${JSON.stringify({
      choices: [],
      usage: { prompt_tokens: 10, completion_tokens: 3 },
    })}`;
    expect([...parseSseLine(line)]).toEqual([{ kind: "usage", usage: { inputTokens: 10, outputTokens: 3 } }]);
  });

  test("a chunk with no usage field at all yields nothing (tolerant of providers that omit it)", () => {
    const line = `data: ${JSON.stringify({ choices: [{ delta: { content: "x" } }] })}`;
    expect([...parseSseLine(line)]).toEqual([{ kind: "delta", text: "x" }]);
  });

  test("a non-data line is ignored", () => {
    expect([...parseSseLine("event: ping")]).toEqual([]);
    expect([...parseSseLine(": comment")]).toEqual([]);
  });

  test("an in-band error object throws ModelUnavailableError", () => {
    const line = `data: ${JSON.stringify({ error: { message: "model not found" } })}`;
    expect(() => [...parseSseLine(line)]).toThrow(ModelUnavailableError);
  });

  test("parseSseStream reassembles a full answer across chunk boundaries", async () => {
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        const encoder = new TextEncoder();
        controller.enqueue(encoder.encode(`data: ${JSON.stringify({ choices: [{ delta: { content: "Bon" } }] })}\n`));
        controller.enqueue(encoder.encode(`data: ${JSON.stringify({ choices: [{ delta: { content: "jour" } }] })}\n`));
        controller.enqueue(encoder.encode("data: [DONE]\n"));
        controller.close();
      },
    });
    const events = [];
    for await (const event of parseSseStream(body)) events.push(event);
    expect(events).toEqual([
      { kind: "delta", text: "Bon" },
      { kind: "delta", text: "jour" },
    ]);
  });
});

// --- Integration: a real fake OpenAI-compatible server -----------------

interface FakeServerHandle {
  baseUrl: string;
  requests: Array<{ method: string; pathname: string; headers: Headers; body: unknown }>;
  stop(): void;
}

/** Boots a real Bun.serve fake server on 127.0.0.1:0 (random free port —
 * task brief). `routes` maps "METHOD /path" to a handler; unmatched requests
 * 404. Every request is recorded in `.requests` (never logs the Authorization
 * header value itself in test failures — assertions read it explicitly when
 * needed). */
function fakeServer(routes: Record<string, (req: Request) => Response | Promise<Response>>): FakeServerHandle {
  const requests: FakeServerHandle["requests"] = [];
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      let body: unknown;
      const raw = req.method !== "GET" ? await req.clone().text() : undefined;
      if (raw) {
        try {
          body = JSON.parse(raw);
        } catch {
          body = raw;
        }
      }
      requests.push({ method: req.method, pathname: url.pathname, headers: req.headers, body });
      const key = `${req.method} ${url.pathname}`;
      const handler = routes[key];
      if (!handler) return new Response("not found", { status: 404 });
      return handler(req);
    },
  });
  return {
    baseUrl: `http://127.0.0.1:${server.port}/v1`,
    requests,
    stop: () => server.stop(true),
  };
}

function sse(lines: string[]): Response {
  const body = lines.map((l) => `${l}\n`).join("") + "\n";
  return new Response(body, { headers: { "content-type": "text/event-stream" } });
}

describe("openai-compat streamAnswer — integration against a real fake server", () => {
  test("a full streamed answer, with an Authorization: Bearer header carrying the key", async () => {
    const server = fakeServer({
      "POST /v1/chat/completions": () =>
        sse([
          `data: ${JSON.stringify({ choices: [{ delta: { role: "assistant" } }] })}`,
          `data: ${JSON.stringify({ choices: [{ delta: { content: "Bon" } }] })}`,
          `data: ${JSON.stringify({ choices: [{ delta: { content: "jour" } }] })}`,
          `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 5, completion_tokens: 2 } })}`,
          "data: [DONE]",
        ]),
    });
    try {
      const built = buildPrompt({ kind: "chat", text: "salut" });
      const events = [];
      for await (const event of streamAnswer(built, { baseUrl: server.baseUrl, apiKey: "sk-test-key", model: "some-model" })) {
        events.push(event);
      }
      expect(events).toEqual([
        { kind: "delta", text: "Bon" },
        { kind: "delta", text: "jour" },
        { kind: "usage", usage: { inputTokens: 5, outputTokens: 2 } },
      ]);
      expect(server.requests).toHaveLength(1);
      expect(server.requests[0]?.headers.get("authorization")).toBe("Bearer sk-test-key");
      expect((server.requests[0]?.body as { model?: string })?.model).toBe("some-model");
      expect((server.requests[0]?.body as { stream?: boolean })?.stream).toBe(true);
    } finally {
      server.stop();
    }
  });

  test("no Authorization header is sent when no key is configured (LM Studio/Ollama)", async () => {
    const server = fakeServer({
      "POST /v1/chat/completions": () => sse([`data: ${JSON.stringify({ choices: [{ delta: { content: "ok" } }] })}`, "data: [DONE]"]),
    });
    try {
      const built = buildPrompt({ kind: "chat", text: "salut" });
      for await (const _e of streamAnswer(built, { baseUrl: server.baseUrl, model: "local-model" })) {
        // draining
      }
      expect(server.requests[0]?.headers.has("authorization")).toBe(false);
    } finally {
      server.stop();
    }
  });

  test("key refused (401) surfaces as AuthRequiredError with the French remedy message, never the key", async () => {
    const server = fakeServer({
      "POST /v1/chat/completions": () => new Response("unauthorized", { status: 401 }),
    });
    try {
      const built = buildPrompt({ kind: "chat", text: "salut" });
      const err = await (async () => {
        try {
          for await (const _e of streamAnswer(built, { baseUrl: server.baseUrl, apiKey: "sk-secret", model: "m" })) {
            // draining
          }
        } catch (e) {
          return e;
        }
      })();
      expect(err).toBeInstanceOf(AuthRequiredError);
      expect(isAuthRequiredError(err)).toBe(true);
      expect(isModelUnavailableError(err)).toBe(false);
      expect((err as Error).message).toBe(OPENAI_COMPAT_AUTH_MESSAGE);
      expect((err as Error).message).not.toContain("sk-secret");
    } finally {
      server.stop();
    }
  });

  test("unknown model via HTTP 404 surfaces as model-missing, not model-unavailable (amendement 2026-10-02)", async () => {
    const server = fakeServer({
      "POST /v1/chat/completions": () => new Response("not found", { status: 404 }),
    });
    try {
      const built = buildPrompt({ kind: "chat", text: "salut" });
      const err = await (async () => {
        try {
          for await (const _e of streamAnswer(built, { baseUrl: server.baseUrl, model: "does-not-exist" })) {
            // draining
          }
        } catch (e) {
          return e as Error;
        }
      })();
      expect(err).toBeInstanceOf(ModelMissingError);
      expect(err).not.toBeInstanceOf(ModelUnavailableError);
    } finally {
      server.stop();
    }
  });

  test("Mistral unknown_model error body (any status) surfaces as model-missing (amendement 2026-10-02)", async () => {
    const server = fakeServer({
      "POST /v1/chat/completions": () =>
        new Response(JSON.stringify({ message: "unknown_model", type: "invalid_request_error", code: "unknown_model" }), { status: 400 }),
    });
    try {
      const built = buildPrompt({ kind: "chat", text: "salut" });
      const err = await (async () => {
        try {
          for await (const _e of streamAnswer(built, { baseUrl: server.baseUrl, model: "does-not-exist" })) {
            // draining
          }
        } catch (e) {
          return e as Error;
        }
      })();
      expect(err).toBeInstanceOf(ModelMissingError);
    } finally {
      server.stop();
    }
  });

  test("a 502/503 response surfaces as provider-overloaded (amendement 2026-10-02)", async () => {
    for (const status of [502, 503]) {
      const server = fakeServer({
        "POST /v1/chat/completions": () => new Response("bad gateway", { status }),
      });
      try {
        const built = buildPrompt({ kind: "chat", text: "salut" });
        const err = await (async () => {
          try {
            for await (const _e of streamAnswer(built, { baseUrl: server.baseUrl, model: "m" })) {
              // draining
            }
          } catch (e) {
            return e;
          }
        })();
        expect(err).toBeInstanceOf(ProviderOverloadedError);
      } finally {
        server.stop();
      }
    }
  });

  test("an in-stream finish_reason:error naming an overload surfaces as provider-overloaded", async () => {
    const server = fakeServer({
      "POST /v1/chat/completions": () =>
        sse([`data: ${JSON.stringify({ choices: [{ finish_reason: "error" }], error: { message: "Upstream provider is overloaded" } })}`]),
    });
    try {
      const built = buildPrompt({ kind: "chat", text: "salut" });
      const err = await (async () => {
        try {
          for await (const _e of streamAnswer(built, { baseUrl: server.baseUrl, model: "m" })) {
            // draining
          }
        } catch (e) {
          return e;
        }
      })();
      expect(err).toBeInstanceOf(ProviderOverloadedError);
    } finally {
      server.stop();
    }
  });

  test("unknown model via an in-band 200-OK error body surfaces as model-unavailable", async () => {
    const server = fakeServer({
      "POST /v1/chat/completions": () => sse([`data: ${JSON.stringify({ error: { message: "model 'x' not found" } })}`]),
    });
    try {
      const built = buildPrompt({ kind: "chat", text: "salut" });
      const err = await (async () => {
        try {
          for await (const _e of streamAnswer(built, { baseUrl: server.baseUrl, model: "x" })) {
            // draining
          }
        } catch (e) {
          return e as Error;
        }
      })();
      expect(err).toBeInstanceOf(ModelUnavailableError);
    } finally {
      server.stop();
    }
  });

  test("connection refused (nothing listening) surfaces as model-unavailable", async () => {
    // A fake server that we boot then immediately stop — the port is free
    // again (or at least nothing answers), giving a real ECONNREFUSED
    // without any external network access.
    const server = fakeServer({});
    const baseUrl = server.baseUrl;
    server.stop();

    const built = buildPrompt({ kind: "chat", text: "salut" });
    const err = await (async () => {
      try {
        for await (const _e of streamAnswer(built, { baseUrl, model: "m" })) {
          // draining
        }
      } catch (e) {
        return e as Error;
      }
    })();
    expect(err).toBeInstanceOf(ModelUnavailableError);
  });

  test("a plain 429 (no quota signal) surfaces as rate-limited", async () => {
    const server = fakeServer({
      "POST /v1/chat/completions": () => new Response("too many requests", { status: 429 }),
    });
    try {
      const built = buildPrompt({ kind: "chat", text: "salut" });
      const err = await (async () => {
        try {
          for await (const _e of streamAnswer(built, { baseUrl: server.baseUrl, model: "m" })) {
            // draining
          }
        } catch (e) {
          return e as Error;
        }
      })();
      expect(err).toBeInstanceOf(RateLimitedError);
      expect(isRateLimitedError(err)).toBe(true);
      expect(isModelUnavailableError(err)).toBe(false);
    } finally {
      server.stop();
    }
  });

  test("a 429 carrying a Retry-After header puts retryAfterSec on the RateLimitedError", async () => {
    const server = fakeServer({
      "POST /v1/chat/completions": () => new Response("too many requests", { status: 429, headers: { "retry-after": "7" } }),
    });
    try {
      const built = buildPrompt({ kind: "chat", text: "salut" });
      const err = await (async () => {
        try {
          for await (const _e of streamAnswer(built, { baseUrl: server.baseUrl, model: "m" })) {
            // draining
          }
        } catch (e) {
          return e as RateLimitedError;
        }
      })();
      expect(err).toBeInstanceOf(RateLimitedError);
      expect((err as RateLimitedError).retryAfterSec).toBe(7);
    } finally {
      server.stop();
    }
  });

  test("a 429 whose body names insufficient_quota (error.code or error.type) surfaces as quota-exceeded", async () => {
    const server = fakeServer({
      "POST /v1/chat/completions": () =>
        new Response(JSON.stringify({ error: { code: "insufficient_quota", message: "no credit" } }), { status: 429 }),
    });
    try {
      const built = buildPrompt({ kind: "chat", text: "salut" });
      const err = await (async () => {
        try {
          for await (const _e of streamAnswer(built, { baseUrl: server.baseUrl, model: "m" })) {
            // draining
          }
        } catch (e) {
          return e as Error;
        }
      })();
      expect(err).toBeInstanceOf(QuotaExceededError);
      expect(isQuotaExceededError(err)).toBe(true);
    } finally {
      server.stop();
    }
  });

  test("a 402 response surfaces as quota-exceeded", async () => {
    const server = fakeServer({
      "POST /v1/chat/completions": () => new Response("payment required", { status: 402 }),
    });
    try {
      const built = buildPrompt({ kind: "chat", text: "salut" });
      const err = await (async () => {
        try {
          for await (const _e of streamAnswer(built, { baseUrl: server.baseUrl, model: "m" })) {
            // draining
          }
        } catch (e) {
          return e as Error;
        }
      })();
      expect(err).toBeInstanceOf(QuotaExceededError);
    } finally {
      server.stop();
    }
  });

  test("a stream cut mid-way still surfaces the partial deltas already received, then an error", async () => {
    const server = fakeServer({
      "POST /v1/chat/completions": () => {
        const body = new ReadableStream<Uint8Array>({
          start(controller) {
            const encoder = new TextEncoder();
            controller.enqueue(encoder.encode(`data: ${JSON.stringify({ choices: [{ delta: { content: "Bon" } }] })}\n\n`));
            // Cut the stream without ever sending [DONE] — simulates a
            // dropped connection mid-answer. Deferred to the next tick: an
            // error() thrown synchronously from start() would fail the whole
            // Response before headers are even sent, defeating the point of
            // this test (a cut AFTER some data already streamed).
            setTimeout(() => controller.error(new Error("simulated mid-stream cut")), 10);
          },
        });
        return new Response(body, { headers: { "content-type": "text/event-stream" } });
      },
    });
    try {
      const built = buildPrompt({ kind: "chat", text: "salut" });
      const events: unknown[] = [];
      let caught: unknown;
      try {
        for await (const e of streamAnswer(built, { baseUrl: server.baseUrl, model: "m" })) {
          events.push(e);
        }
      } catch (e) {
        caught = e;
      }
      expect(events).toEqual([{ kind: "delta", text: "Bon" }]);
      expect(caught).toBeTruthy();
    } finally {
      server.stop();
    }
  });

  test("redirect is never followed — the Bearer key never reaches the redirect target", async () => {
    let redirectTargetHit = false;
    const server = fakeServer({
      "POST /v1/chat/completions": () => Response.redirect("/elsewhere", 302),
      "POST /elsewhere": () => {
        redirectTargetHit = true;
        return sse(["data: [DONE]"]);
      },
    });
    try {
      const built = buildPrompt({ kind: "chat", text: "salut" });
      const err = await (async () => {
        try {
          for await (const _e of streamAnswer(built, { baseUrl: server.baseUrl, apiKey: "sk-secret", model: "m" })) {
            // draining
          }
        } catch (e) {
          return e as Error;
        }
      })();
      expect(err).toBeInstanceOf(ModelUnavailableError);
      expect(redirectTargetHit).toBe(false);
    } finally {
      server.stop();
    }
  });

  test("a non-loopback http:// baseUrl is rejected without any network call", async () => {
    let fetchCalled = false;
    __setFetchImplForTests((async () => {
      fetchCalled = true;
      throw new Error("should not be called");
    }) as unknown as typeof fetch);

    const built = buildPrompt({ kind: "chat", text: "salut" });
    const err = await (async () => {
      try {
        for await (const _e of streamAnswer(built, { baseUrl: "http://example.com/v1", model: "m" })) {
          // draining
        }
      } catch (e) {
        return e as Error;
      }
    })();
    expect(err).toBeInstanceOf(ModelUnavailableError);
    expect(fetchCalled).toBe(false);
  });

  test("no baseUrl configured fails as model-unavailable without any network call", async () => {
    let fetchCalled = false;
    __setFetchImplForTests((async () => {
      fetchCalled = true;
      throw new Error("should not be called");
    }) as unknown as typeof fetch);

    const built = buildPrompt({ kind: "chat", text: "salut" });
    const err = await (async () => {
      try {
        for await (const _e of streamAnswer(built, { model: "m" })) {
          // draining
        }
      } catch (e) {
        return e as Error;
      }
    })();
    expect(err).toBeInstanceOf(ModelUnavailableError);
    expect(fetchCalled).toBe(false);
  });
});

describe("openai-compat listModels / GET /models", () => {
  test("returns the ids advertised by the server", async () => {
    const server = fakeServer({
      "GET /v1/models": () =>
        Response.json({ data: [{ id: "llama-3" }, { id: "mistral-7b" }] }),
    });
    try {
      const names = await openaiCompatProvider.listModels!({ baseUrl: server.baseUrl });
      expect(names).toEqual(["llama-3", "mistral-7b"]);
    } finally {
      server.stop();
    }
  });

  test("a readable error when /models itself fails", async () => {
    const server = fakeServer({
      "GET /v1/models": () => new Response("nope", { status: 500 }),
    });
    try {
      await expect(openaiCompatProvider.listModels!({ baseUrl: server.baseUrl })).rejects.toBeTruthy();
    } finally {
      server.stop();
    }
  });

  test("checkStatus: no baseUrl → ko/no-base-url", async () => {
    expect(await openaiCompatProvider.checkStatus({})).toEqual({ state: "ko", reason: "no-base-url" });
  });

  test("checkStatus: reachable /models → ok/ready", async () => {
    const server = fakeServer({ "GET /v1/models": () => Response.json({ data: [] }) });
    try {
      expect(await openaiCompatProvider.checkStatus({ baseUrl: server.baseUrl })).toEqual({ state: "ok", reason: "ready" });
    } finally {
      server.stop();
    }
  });

  test("checkStatus: key rejected on /models → ko/key-rejected", async () => {
    const server = fakeServer({ "GET /v1/models": () => new Response("no", { status: 401 }) });
    try {
      expect(await openaiCompatProvider.checkStatus({ baseUrl: server.baseUrl })).toEqual({
        state: "ko",
        reason: "key-rejected",
      });
    } finally {
      server.stop();
    }
  });

  test("checkStatus: unreachable server → unknown/base-url-unreachable", async () => {
    const server = fakeServer({});
    const baseUrl = server.baseUrl;
    server.stop();
    expect(await openaiCompatProvider.checkStatus({ baseUrl })).toEqual({
      state: "unknown",
      reason: "base-url-unreachable",
    });
  });
});

// Goal U2 (docs/PROTOCOL.md "settings.test", amendement 2026-10-01): a FREE
// probe — never the billed POST /chat/completions. Default origins reuse
// GET /models (fakeServer, as above); the OpenRouter special case needs a
// fake fetch since its origin is a real external host.
describe("openai-compat testConnection (goal U2)", () => {
  test("no baseUrl configured → model-unavailable, without any network call", async () => {
    let fetchCalled = false;
    __setFetchImplForTests((async () => {
      fetchCalled = true;
      throw new Error("should not be called");
    }) as unknown as typeof fetch);
    expect(await openaiCompatProvider.testConnection!({})).toEqual({ ok: false, code: "model-unavailable" });
    expect(fetchCalled).toBe(false);
  });

  test("default origin: reachable /models → ok, no code", async () => {
    const server = fakeServer({ "GET /v1/models": () => Response.json({ data: [] }) });
    try {
      expect(await openaiCompatProvider.testConnection!({ baseUrl: server.baseUrl })).toEqual({
        ok: true,
        creditUnchecked: true,
      });
    } finally {
      server.stop();
    }
  });

  test("default origin: /models 401 → auth-required", async () => {
    const server = fakeServer({ "GET /v1/models": () => new Response("no", { status: 401 }) });
    try {
      expect(await openaiCompatProvider.testConnection!({ baseUrl: server.baseUrl })).toEqual({
        ok: false,
        code: "auth-required",
      });
    } finally {
      server.stop();
    }
  });

  test("default origin: /models 429 → rate-limited", async () => {
    const server = fakeServer({ "GET /v1/models": () => new Response("slow down", { status: 429 }) });
    try {
      expect(await openaiCompatProvider.testConnection!({ baseUrl: server.baseUrl })).toEqual({
        ok: false,
        code: "rate-limited",
      });
    } finally {
      server.stop();
    }
  });

  test("default origin: unreachable server → model-unavailable", async () => {
    const server = fakeServer({});
    const baseUrl = server.baseUrl;
    server.stop();
    expect(await openaiCompatProvider.testConnection!({ baseUrl })).toEqual({ ok: false, code: "model-unavailable" });
  });

  test("OpenRouter origin: /models is NEVER called — /api/v1/key is used instead, and a 200 there is ok", async () => {
    const calledUrls: string[] = [];
    __setFetchImplForTests((async (url: string, init?: RequestInit) => {
      calledUrls.push(String(url));
      expect((init?.headers as Record<string, string>)?.authorization).toBe("Bearer sk-or-v1-works");
      return new Response(JSON.stringify({ data: { limit: null } }), { status: 200 });
    }) as unknown as typeof fetch);

    const result = await openaiCompatProvider.testConnection!({
      baseUrl: "https://openrouter.ai/api/v1",
      apiKey: "sk-or-v1-works",
    });
    expect(result).toEqual({ ok: true, creditUnchecked: true });
    expect(calledUrls).toEqual(["https://openrouter.ai/api/v1/key"]);
  });

  test("OpenRouter origin: a rejected key (401 on /api/v1/key) reports auth-required", async () => {
    __setFetchImplForTests((async () => new Response("nope", { status: 401 })) as unknown as typeof fetch);
    const result = await openaiCompatProvider.testConnection!({
      baseUrl: "https://openrouter.ai/api/v1",
      apiKey: "sk-or-v1-bad",
    });
    expect(result).toEqual({ ok: false, code: "auth-required" });
  });
});
