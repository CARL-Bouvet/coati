// The "openai-compat" provider (amendement 2026-09-30 bis, docs/PROTOCOL.md,
// goal G5): a single adapter for any server that speaks OpenAI's
// `/v1/chat/completions` SSE format — LM Studio, Ollama's own `/v1`, OpenAI,
// Mistral, OpenRouter, DeepSeek, or any other compatible address the user
// types in. Prompt assembly (fencing, system prompt) lives in ../model.ts and
// is shared by every provider — see ../model.ts's header. Structurally this
// mirrors claude-api.ts (SSE over fetch) and ollama.ts (baseUrl + listModels)
// at once — see both for the established shape.

import {
  buildSystemPrompt,
  MODEL_TIMEOUT_MS,
  ModelTimeoutError,
  ModelUnavailableError,
  AuthRequiredError,
  type AnswerEvent,
  type BuiltPrompt,
  type StreamAnswerOptions,
} from "../model.ts";
import type { Availability, ModelProvider, ProviderRuntimeOptions, StatusCheck } from "./types.ts";
import { t, DEFAULT_LANG } from "../messages.ts";

// Testing seam: production code always drives the real global `fetch`. Tests
// substitute a fake here (a real Bun.serve fake server on 127.0.0.1, per the
// task brief) so the SSE-parsing and error-classification paths can be
// exercised without a real OpenAI-compatible server. Not part of the public
// API — only broker/test/*.test.ts should call the two functions below.
let fetchImpl: typeof fetch = fetch;
export function __setFetchImplForTests(fn: typeof fetch): void {
  fetchImpl = fn;
}
export function __resetFetchImplForTests(): void {
  fetchImpl = fetch;
}

// Short: /models is meant to be a cheap, local-or-nearly-free listing call —
// same reasoning as ollama.ts's TAGS_TIMEOUT_MS. Used by isAvailable(),
// checkStatus() and listModels() alike, so none of them can hang the
// settings UI waiting out the full MODEL_TIMEOUT_MS for an unreachable or
// slow server.
const MODELS_TIMEOUT_MS = 1500;

// Same reasoning as claude-api.ts's CLAUDE_API_AUTH_MESSAGE: user-facing,
// sent verbatim as ErrorMessage.message / settings.test-result's message —
// never includes the key itself. Same message CODE as claude-api (goal G6:
// messages.ts's "auth.apiKeyRejected") so the panel names the same remedy
// regardless of which BYOK provider rejected the key. This constant is the
// DEFAULT_LANG (en) wording — localised per-connection at the throw site
// below (opts.lang).
export const OPENAI_COMPAT_AUTH_MESSAGE = t("auth.apiKeyRejected", DEFAULT_LANG);

/**
 * Security gate for `baseUrl` (docs/PROTOCOL.md "Fournisseur de modèle"):
 * `https://` unconditionally, or `http://` restricted to loopback
 * (localhost/127.0.0.1/[::1]) — a non-loopback `http://` would send the API
 * key in clear text over the network. Re-checked HERE (not just at
 * protocol.ts's settings.set parse time) so a `baseUrl` that reaches this
 * provider some other way — a hand-edited config.json, a future caller that
 * skips the parser — can never slip through. Exported for tests.
 */
export function isAllowedBaseUrl(value: string): boolean {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  if (url.protocol === "https:") return true;
  if (url.protocol === "http:") {
    // URL.hostname keeps the brackets for a literal IPv6 address ("[::1]",
    // not "::1") — verified against Bun/WHATWG URL behaviour.
    return url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "[::1]";
  }
  return false;
}

function resolveBaseUrl(url: string | undefined): string | undefined {
  const trimmed = url?.trim();
  if (!trimmed) return undefined;
  return trimmed.replace(/\/+$/, "");
}

function authHeaders(apiKey: string | undefined): Record<string, string> {
  const key = apiKey?.trim();
  return key ? { authorization: `Bearer ${key}` } : {};
}

/** GET {baseUrl}/models — used by isAvailable(), checkStatus() and
 * listModels(). `redirect: "error"` (security review, task brief): never
 * follow a redirect that could carry the Bearer key to a different origin
 * than the one configured. Throws on any non-2xx or network failure; callers
 * classify. */
async function fetchModelIds(baseUrl: string, apiKey: string | undefined): Promise<string[]> {
  const response = await fetchImpl(`${baseUrl}/models`, {
    headers: authHeaders(apiKey),
    redirect: "error",
    signal: AbortSignal.timeout(MODELS_TIMEOUT_MS),
  });
  if (!response.ok) {
    const err = new Error(`${baseUrl}/models returned HTTP ${response.status}`);
    (err as Error & { status?: number }).status = response.status;
    throw err;
  }
  const body = (await response.json()) as { data?: Array<{ id?: unknown }> };
  if (!Array.isArray(body.data)) return [];
  return body.data.map((m) => m.id).filter((id): id is string => typeof id === "string" && id.length > 0);
}

async function isAvailable(opts: ProviderRuntimeOptions): Promise<Availability> {
  const lang = opts.lang ?? DEFAULT_LANG;
  const baseUrl = resolveBaseUrl(opts.baseUrl);
  if (!baseUrl) {
    return { available: false, reason: t("availability.openaiCompat.noBaseUrl", lang) };
  }
  if (!isAllowedBaseUrl(baseUrl)) {
    return { available: false, reason: t("availability.openaiCompat.invalidBaseUrl", lang) };
  }
  try {
    await fetchModelIds(baseUrl, opts.apiKey);
  } catch (err) {
    return {
      available: false,
      reason: t("availability.openaiCompat.cannotReach", lang, {
        url: baseUrl,
        detail: err instanceof Error ? err.message : String(err),
      }),
    };
  }
  return { available: true };
}

async function listModels(opts: ProviderRuntimeOptions): Promise<string[]> {
  const baseUrl = resolveBaseUrl(opts.baseUrl);
  if (!baseUrl || !isAllowedBaseUrl(baseUrl)) return [];
  return fetchModelIds(baseUrl, opts.apiKey);
}

/**
 * `provider.status` for openai-compat — amendement 2026-09-30 bis. Unlike
 * claude-api (presence-only, no confirmed free probe), a `GET /models` here
 * IS attempted — see docs/PROTOCOL.md's own note on why that default differs
 * from claude-api's for this provider (LM Studio/Ollama: free and local; the
 * hosted presets checked at implementation time also document it as free).
 */
async function checkStatus(opts: ProviderRuntimeOptions): Promise<StatusCheck> {
  const baseUrl = resolveBaseUrl(opts.baseUrl);
  if (!baseUrl) return { state: "ko", reason: "no-base-url" };
  if (!isAllowedBaseUrl(baseUrl)) return { state: "ko", reason: "no-base-url" };
  try {
    await fetchModelIds(baseUrl, opts.apiKey);
    return { state: "ok", reason: "ready" };
  } catch (err) {
    const status = (err as Error & { status?: number })?.status;
    if (status === 401 || status === 403) return { state: "ko", reason: "key-rejected" };
    if (typeof status === "number") return { state: "unknown", reason: "probe-failed" };
    return { state: "unknown", reason: "base-url-unreachable" };
  }
}

/** Parses one SSE line of an OpenAI-compatible /v1/chat/completions streaming
 * response. Tolerates providers that send no `usage`/`role` chunks (task
 * brief) — those fields are read only when present, never required. Exported
 * standalone (alongside parseSseStream below) so tests can feed fixed line
 * fixtures without going through a fake fetch. Mirrors claude-api.ts's
 * parseSseLine structure. */
export function* parseSseLine(line: string): Generator<AnswerEvent> {
  const trimmed = line.trimEnd();
  if (!trimmed.startsWith("data:")) return;
  const jsonText = trimmed.slice(5).trim();
  if (!jsonText) return;
  if (jsonText === "[DONE]") return;
  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonText);
  } catch {
    return; // malformed line — skip rather than crash mid-stream
  }
  if (!parsed || typeof parsed !== "object") return;
  const obj = parsed as Record<string, unknown>;

  // A mid-stream error object some providers emit as a normal `data:` line
  // (rather than an HTTP error status) instead of closing the connection.
  if (obj.error) {
    const error = obj.error as Record<string, unknown> | string;
    const message =
      typeof error === "string" ? error : typeof error?.message === "string" ? (error.message as string) : "stream error";
    // Classified model-unavailable, not a bare Error (task brief: "unknown
    // model (404 or provider error body)" is one of the closed failure
    // modes) — a server that answers 200 then sends an in-band error object
    // (LM Studio does this for a model it can't load) must not surface as
    // `internal`.
    throw new ModelUnavailableError(message);
  }

  const choices = obj.choices as Array<Record<string, unknown>> | undefined;
  const choice = Array.isArray(choices) ? choices[0] : undefined;
  const delta = choice?.delta as Record<string, unknown> | undefined;
  if (delta && typeof delta.content === "string" && delta.content.length > 0) {
    yield { kind: "delta", text: delta.content };
  }

  // Only present when the request asked for it (stream_options.include_usage)
  // AND the server honours that — most don't send it on every chunk, some
  // (Ollama, LM Studio, and providers that never implemented it) never send
  // it at all. Tolerated either way (task brief): server.ts defaults usage to
  // {0, 0} when no "usage" AnswerEvent is ever yielded.
  const usage = obj.usage as Record<string, unknown> | undefined;
  if (usage && typeof usage.prompt_tokens === "number" && typeof usage.completion_tokens === "number") {
    yield {
      kind: "usage",
      usage: { inputTokens: usage.prompt_tokens, outputTokens: usage.completion_tokens },
    };
  }
}

/** Reads a fetch Response body (SSE) and yields AnswerEvents as lines
 * complete. A final partial line with no trailing newline is flushed once the
 * body ends. Mirrors claude-api.ts's parseSseStream / ollama.ts's
 * parseNdjsonStream structure. */
export async function* parseSseStream(body: ReadableStream<Uint8Array>): AsyncGenerator<AnswerEvent> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let newlineIndex: number;
      while ((newlineIndex = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, newlineIndex);
        buffer = buffer.slice(newlineIndex + 1);
        yield* parseSseLine(line);
      }
    }
    if (buffer.trim()) yield* parseSseLine(buffer);
  } finally {
    reader.releaseLock();
  }
}

/**
 * Streams the model's answer to `built.prompt` via
 * `POST {baseUrl}/chat/completions` (SSE). Same timeout/abort/typed-error
 * semantics as the other providers — see providers/types.ts's ModelProvider
 * doc.
 */
export async function* streamAnswer(
  built: BuiltPrompt,
  opts: StreamAnswerOptions & ProviderRuntimeOptions = {},
): AsyncIterable<AnswerEvent> {
  const baseUrl = resolveBaseUrl(opts.baseUrl);
  if (!baseUrl) {
    throw new ModelUnavailableError("no server address configured — pick one in Coati settings");
  }
  if (!isAllowedBaseUrl(baseUrl)) {
    // Belt and braces (protocol.ts's settings.set already rejects this at the
    // door) — never reachable through the normal settings.set path, but a
    // hand-edited config.json could still carry a stale disallowed value.
    throw new ModelUnavailableError("configured server address is not allowed (must be https, or http on loopback)");
  }
  const model = opts.model?.trim();
  if (!model) {
    throw new ModelUnavailableError("no model configured — pick one in Coati settings");
  }

  const abortController = new AbortController();
  if (opts.signal) {
    if (opts.signal.aborted) {
      abortController.abort();
    } else {
      opts.signal.addEventListener("abort", () => abortController.abort(), { once: true });
    }
  }

  const timeoutMs = opts.timeoutMs ?? MODEL_TIMEOUT_MS;
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    abortController.abort();
  }, timeoutMs);

  try {
    let response: Response;
    try {
      response = await fetchImpl(`${baseUrl}/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json", ...authHeaders(opts.apiKey) },
        body: JSON.stringify({
          model,
          stream: true,
          stream_options: { include_usage: true },
          messages: [
            { role: "system", content: buildSystemPrompt(built.nonce, built.lang) },
            { role: "user", content: built.prompt },
          ],
        }),
        redirect: "error",
        signal: abortController.signal,
      });
    } catch (err) {
      if (timedOut) throw new ModelTimeoutError(timeoutMs);
      // Same reasoning as claude-api.ts's own catch here (I3, lot7 security
      // review): never forward a raw fetch error's own message, which can
      // echo request internals in some runtimes — a fixed, generic message
      // names the failure without repeating anything client-supplied.
      throw new ModelUnavailableError(`cannot reach the server at ${baseUrl}`);
    }

    if (!response.ok) {
      if (response.status === 401 || response.status === 403) {
        throw new AuthRequiredError(t("auth.apiKeyRejected", opts.lang ?? DEFAULT_LANG));
      }
      if (response.status === 404) {
        throw new ModelUnavailableError(`model "${model}" not found at ${baseUrl}`);
      }
      if (response.status === 429 || response.status >= 500) {
        throw new ModelUnavailableError(`server returned HTTP ${response.status}`);
      }
      throw new Error(`server returned HTTP ${response.status}`);
    }
    if (!response.body) {
      throw new Error("server response has no body");
    }

    yield* parseSseStream(response.body);
  } catch (err) {
    if (timedOut) throw new ModelTimeoutError(timeoutMs);
    throw err;
  } finally {
    clearTimeout(timer);
  }

  if (timedOut) throw new ModelTimeoutError(timeoutMs);
}

export const openaiCompatProvider: ModelProvider = {
  id: "openai-compat",
  label: "Compatible OpenAI",
  isAvailable,
  listModels,
  checkStatus,
  streamAnswer,
};
