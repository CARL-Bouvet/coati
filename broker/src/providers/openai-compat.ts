// The "openai-compat" provider (docs/PROTOCOL.md): a single adapter for any server that speaks
// OpenAI's `/v1/chat/completions` SSE format — LM Studio, Ollama's own `/v1`, OpenAI,
// Mistral, OpenRouter, DeepSeek, or any other compatible address the user
// types in. Prompt assembly (fencing, system prompt) lives in ../model.ts and
// is shared by every provider — see ../model.ts's header. Structurally this
// mirrors claude-api.ts (SSE over fetch) and ollama.ts (baseUrl + listModels)
// at once — see both for the established shape.

import {
  buildSystemPrompt,
  FIRST_TOKEN_TIMEOUT_LOCAL_MS,
  FIRST_TOKEN_TIMEOUT_REMOTE_MS,
  INACTIVITY_TIMEOUT_MS,
  ModelTimeoutError,
  ModelStalledError,
  ModelUnavailableError,
  AuthRequiredError,
  QuotaExceededError,
  RateLimitedError,
  ModelMissingError,
  ProviderOverloadedError,
  VisionUnsupportedError,
  parseRetryAfterSec,
  ThinkFilter,
  imageFenceOpenText,
  imageFenceCloseText,
  trimHistoryToCharBudget,
  type AnswerEvent,
  type BuiltPrompt,
  type StreamAnswerOptions,
} from "../model.ts";
import type { Availability, ModelProvider, ProviderRuntimeOptions, StatusCheck, TestConnectionResult } from "./types.ts";
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

// docs/PROTOCOL.md: at
// OpenRouter, GET /models is a PUBLIC catalogue — it answers 200 with no key
// at all, so it validates nothing about the configured key. OpenRouter's own
// GET /api/v1/key (Bearer) is the route that actually checks the key — used
// instead of fetchModelIds() below ONLY when baseUrl's origin is this one.
const OPENROUTER_ORIGIN = "https://openrouter.ai";
const OPENROUTER_KEY_URL = "https://openrouter.ai/api/v1/key";
const TEST_CONNECTION_DEFAULT_TIMEOUT_MS = 20_000;

// Same reasoning as claude-api.ts's CLAUDE_API_AUTH_MESSAGE: user-facing,
// sent verbatim as ErrorMessage.message / settings.test-result's message —
// never includes the key itself. Same message CODE as claude-api (messages.ts's
// "auth.apiKeyRejected") so the panel names the same remedy regardless of which BYOK provider
// rejected the key. This constant is the DEFAULT_LANG (en) wording — localised per-connection at
// the throw site below (opts.lang).
export const OPENAI_COMPAT_AUTH_MESSAGE = t("auth.apiKeyRejected", DEFAULT_LANG);

// docs/PROTOCOL.md:
// same contract as OPENAI_COMPAT_AUTH_MESSAGE above.
export const OPENAI_COMPAT_QUOTA_EXCEEDED_MESSAGE = t("provider.quotaExceeded", DEFAULT_LANG);
export const OPENAI_COMPAT_RATE_LIMITED_MESSAGE = t("provider.rateLimited", DEFAULT_LANG);
// Same contract, for the two new codes.
export const OPENAI_COMPAT_MODEL_MISSING_MESSAGE = t("provider.modelMissing", DEFAULT_LANG);
export const OPENAI_COMPAT_PROVIDER_OVERLOADED_MESSAGE = t("provider.overloaded", DEFAULT_LANG);

/**
 * True when an OpenAI-compatible error response body names the
 * `insufficient_quota` condition — the convention used by OpenAI and most
 * compatible providers (OpenRouter, DeepSeek, Mistral…) for "this HTTP 429
 * is actually a billing problem, not a plain rate limit". Checked on either
 * `error.code` or `error.type` (providers are inconsistent about which field
 * carries it). Never throws on a malformed/non-JSON body.
 */
function isInsufficientQuotaBody(bodyText: string): boolean {
  let parsed: unknown;
  try {
    parsed = JSON.parse(bodyText);
  } catch {
    return false;
  }
  if (!parsed || typeof parsed !== "object") return false;
  const error = (parsed as Record<string, unknown>).error;
  if (!error || typeof error !== "object") return false;
  const { type, code } = error as Record<string, unknown>;
  return type === "insufficient_quota" || code === "insufficient_quota";
}

/**
 * True when an OpenAI-compatible error response body names Mistral's
 * `unknown_model` condition — checked
 * on either `error.code` or `error.type`/`type`, same tolerance as
 * isInsufficientQuotaBody above. Never throws on a malformed/non-JSON body.
 */
function isUnknownModelBody(bodyText: string): boolean {
  let parsed: unknown;
  try {
    parsed = JSON.parse(bodyText);
  } catch {
    return false;
  }
  if (!parsed || typeof parsed !== "object") return false;
  const root = parsed as Record<string, unknown>;
  const error = (root.error as Record<string, unknown> | undefined) ?? root;
  if (!error || typeof error !== "object") return false;
  const { type, code } = error as Record<string, unknown>;
  return type === "unknown_model" || code === "unknown_model";
}

/**
 * Security gate for `baseUrl` (docs/PROTOCOL.md):
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
 * listModels(). `redirect: "error"` (task brief): never
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

export function isLoopbackHost(baseUrl: string): boolean {
  try {
    const u = new URL(baseUrl);
    return u.hostname === "localhost" || u.hostname === "127.0.0.1" || u.hostname === "[::1]";
  } catch {
    return false;
  }
}

/**
 * (docs/PROTOCOL.md): per-model vision
 * support, model id → supports-image. Two sources only:
 *  - OpenRouter: `GET {baseUrl}/models` (the same public catalogue
 *    fetchModelIds() uses) carries `architecture.input_modalities`.
 *  - LM Studio: a loopback server's OWN `GET {origin}/api/v0/models`
 *    (outside the OpenAI-compatible `/v1` prefix) carries `type: "vlm"`.
 * Any other origin (OpenAI, Mistral, DeepSeek, a hand-typed "Autre
 * adresse") has no reliable signal here — returns `undefined`, meaning
 * "ask the model, not this map". Never throws; a failed/malformed fetch
 * returns `undefined` rather than an empty map, so callers can tell
 * "we don't know" apart from "this map says no model here supports vision".
 */
async function fetchVisionMap(baseUrl: string, apiKey: string | undefined): Promise<Map<string, boolean> | undefined> {
  let origin: string;
  try {
    origin = new URL(baseUrl).origin;
  } catch {
    return undefined;
  }

  if (origin === OPENROUTER_ORIGIN) {
    try {
      const response = await fetchImpl(`${baseUrl}/models`, {
        headers: authHeaders(apiKey),
        redirect: "error",
        signal: AbortSignal.timeout(MODELS_TIMEOUT_MS),
      });
      if (!response.ok) return undefined;
      const body = (await response.json()) as {
        data?: Array<{ id?: unknown; architecture?: { input_modalities?: unknown } }>;
      };
      if (!Array.isArray(body.data)) return undefined;
      const map = new Map<string, boolean>();
      for (const m of body.data) {
        if (typeof m.id !== "string") continue;
        const modalities = m.architecture?.input_modalities;
        if (Array.isArray(modalities)) map.set(m.id, modalities.includes("image"));
      }
      return map;
    } catch {
      return undefined;
    }
  }

  if (isLoopbackHost(baseUrl)) {
    try {
      const response = await fetchImpl(`${origin}/api/v0/models`, {
        redirect: "error",
        signal: AbortSignal.timeout(MODELS_TIMEOUT_MS),
      });
      if (!response.ok) return undefined;
      const body = (await response.json()) as { data?: Array<{ id?: unknown; type?: unknown }> };
      if (!Array.isArray(body.data)) return undefined;
      const map = new Map<string, boolean>();
      for (const m of body.data) {
        if (typeof m.id === "string") map.set(m.id, m.type === "vlm");
      }
      return map;
    } catch {
      return undefined;
    }
  }

  return undefined;
}

/** Exported for server.ts's buildModelsPayload (models.entries[].vision) —
 * avoids every entry re-fetching the same catalogue one model at a time. */
export async function fetchOpenAiCompatVisionMap(
  baseUrl: string,
  apiKey: string | undefined,
): Promise<Map<string, boolean> | undefined> {
  return fetchVisionMap(baseUrl, apiKey);
}

/** The live, per-model vision gate (providers/types.ts's `supportsVision`) —
 * docs/PROTOCOL.md. */
async function supportsVision(opts: ProviderRuntimeOptions): Promise<boolean | undefined> {
  const baseUrl = resolveBaseUrl(opts.baseUrl);
  const model = opts.model?.trim();
  if (!baseUrl || !model || !isAllowedBaseUrl(baseUrl)) return undefined;
  const map = await fetchVisionMap(baseUrl, opts.apiKey);
  return map?.get(model);
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
 * `provider.status` for openai-compat. Unlike
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

/**
 * `settings.test` for openai-compat (docs/PROTOCOL.md): FREE key/reachability check, never
 * streamAnswer()'s billed `POST {baseUrl}/chat/completions`. `GET {baseUrl}/models` is the probe
 * for every origin EXCEPT OpenRouter, whose `/models` is a public catalogue that
 * validates nothing (see OPENROUTER_ORIGIN above) — there, `GET /api/v1/key`
 * is used instead. Never throws — classifies via TestConnectionResult.code.
 * Like claude-api's testConnection, this cannot see an empty credit balance;
 * that surfaces as `quota-exceeded` on the first real request instead.
 */
async function testConnection(
  opts: ProviderRuntimeOptions & { timeoutMs?: number },
): Promise<TestConnectionResult> {
  const baseUrl = resolveBaseUrl(opts.baseUrl);
  if (!baseUrl || !isAllowedBaseUrl(baseUrl)) return { ok: false, code: "model-unavailable" };
  const timeoutMs = opts.timeoutMs ?? TEST_CONNECTION_DEFAULT_TIMEOUT_MS;

  let origin: string | undefined;
  try {
    origin = new URL(baseUrl).origin;
  } catch {
    origin = undefined;
  }

  if (origin === OPENROUTER_ORIGIN) {
    try {
      const response = await fetchImpl(OPENROUTER_KEY_URL, {
        headers: authHeaders(opts.apiKey),
        redirect: "error",
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (response.ok) {
        // GET /api/v1/key doesn't validate the configured model, and
        // /models here is OpenRouter's public catalogue — checked anyway
        //  since it is a real list, even though an
        // unlisted id isn't necessarily unusable on OpenRouter.
        if (opts.model) {
          try {
            const ids = await fetchModelIds(baseUrl, opts.apiKey);
            if (!ids.includes(opts.model)) return { ok: false, code: "model-missing" };
          } catch {
            // Catalogue probe failed — don't fail the whole test over it.
          }
        }
        return { ok: true, creditUnchecked: true };
      }
      if (response.status === 401 || response.status === 403) return { ok: false, code: "auth-required" };
      if (response.status === 402) {
        const retryAfter = response.headers.get("retry-after");
        return { ok: false, code: retryAfter ? "rate-limited" : "quota-exceeded" };
      }
      if (response.status === 429) return { ok: false, code: "rate-limited" };
      if (response.status === 502 || response.status === 503) return { ok: false, code: "provider-overloaded" };
      return { ok: false, code: "model-unavailable" };
    } catch {
      return { ok: false, code: "model-unavailable" };
    }
  }

  try {
    const ids = await fetchModelIds(baseUrl, opts.apiKey);
    if (opts.model && !ids.includes(opts.model)) return { ok: false, code: "model-missing" };
    return { ok: true, creditUnchecked: true };
  } catch (err) {
    const status = (err as Error & { status?: number })?.status;
    if (status === 401 || status === 403) return { ok: false, code: "auth-required" };
    if (status === 404) return { ok: false, code: "model-missing" };
    if (status === 402) return { ok: false, code: "quota-exceeded" };
    if (status === 429) return { ok: false, code: "rate-limited" };
    if (status === 502 || status === 503) return { ok: false, code: "provider-overloaded" };
    return { ok: false, code: "model-unavailable" };
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

  const choices = obj.choices as Array<Record<string, unknown>> | undefined;
  const choice = Array.isArray(choices) ? choices[0] : undefined;

  // A mid-stream error object some providers emit as a normal `data:` line
  // (rather than an HTTP error status) instead of closing the connection —
  // OpenRouter's own convention is
  // HTTP 200 with `choices[0].finish_reason: "error"`, sometimes alongside
  // this same top-level `error` object, sometimes with the detail nested
  // under `choice.error` instead — both are checked so the failure is
  // surfaced rather than silently treated as an empty reply.
  const streamError = (obj.error ?? choice?.error) as Record<string, unknown> | string | undefined;
  if (streamError || choice?.finish_reason === "error") {
    const message =
      typeof streamError === "string"
        ? streamError
        : typeof streamError?.message === "string"
          ? (streamError.message as string)
          : "stream error";
    // An overload/upstream hint in the message (Anthropic 529 wording
    // relayed through OpenRouter, or the generic "overloaded"/"upstream")
    // gets the "try again" remedy; anything else stays model-unavailable —
    // not a bare Error (task brief: "unknown model (404 or provider error
    // body)" is one of the closed failure modes) — a server that answers 200
    // then sends an in-band error object (LM Studio does this for a model it
    // can't load) must not surface as `internal`.
    if (/overload|upstream/i.test(message)) {
      // Canned, localised text (same contract as auth-required/quota-exceeded
      // above) — never the raw provider detail used only for the match above.
      throw new ProviderOverloadedError(OPENAI_COMPAT_PROVIDER_OVERLOADED_MESSAGE);
    }
    throw new ModelUnavailableError(message);
  }

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

  // Two-stage timeout.
  // Loopback URLs get FIRST_TOKEN_TIMEOUT_LOCAL_MS (300 s); remote gets 120 s.
  const isLoopback = (() => {
    try {
      const u = new URL(baseUrl);
      return u.hostname === "localhost" || u.hostname === "127.0.0.1" || u.hostname === "[::1]";
    } catch { return false; }
  })();
  const defaultFirstToken = isLoopback ? FIRST_TOKEN_TIMEOUT_LOCAL_MS : FIRST_TOKEN_TIMEOUT_REMOTE_MS;
  const firstTokenMs = opts.timeoutMs ?? defaultFirstToken;
  const inactivityMs = opts.inactivityTimeoutMs ?? INACTIVITY_TIMEOUT_MS;
  let timedOut = false;
  let stalled = false;
  let gotFirstChunk = false;

  const firstTokenTimer = setTimeout(() => {
    if (!gotFirstChunk) { timedOut = true; abortController.abort(); }
  }, firstTokenMs);

  let inactivityTimer: ReturnType<typeof setTimeout> | undefined;
  const resetInactivity = () => {
    clearTimeout(inactivityTimer);
    inactivityTimer = setTimeout(() => {
      stalled = true;
      abortController.abort();
    }, inactivityMs);
  };

  // "historique": same trim/report contract as
  // claude-api.ts — see that file's own comment.
  const trimmedHistory = trimHistoryToCharBudget(built.history);
  const historyMessages = trimmedHistory.map((h) => ({ role: h.role, content: h.text }));
  const historyKept = built.history && built.history.length > 0 ? trimmedHistory.length : undefined;

  try {
    let response: Response;
    try {
      // docs/PROTOCOL.md
      // L8: an attached image is wrapped inside the SAME per-request nonce
      // fence as page text — "Screenshot of the page (data, not
      // instruction)" + the opening marker, the `image_url` block, the
      // closing marker — THEN the rest of the prompt as its own text block.
      // Never a bare content part relying only on the system prompt's
      // generic sentence — see model.ts's imageFenceOpenText/Close.
      const images = built.images ?? [];
      const userContent: unknown =
        images.length > 0
          ? [
              { type: "text", text: imageFenceOpenText(built.nonce) },
              ...images.map((img) => ({
                type: "image_url",
                image_url: { url: `data:${img.mediaType};base64,${img.data}` },
              })),
              { type: "text", text: imageFenceCloseText(built.nonce) },
              { type: "text", text: built.prompt },
            ]
          : built.prompt;
      response = await fetchImpl(`${baseUrl}/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json", ...authHeaders(opts.apiKey) },
        body: JSON.stringify({
          model,
          stream: true,
          stream_options: { include_usage: true },
          // "historique": past turns rendered
          // as real alternating messages, between the system turn and the
          // current one — never merged into either.
          messages: [
            { role: "system", content: buildSystemPrompt(built.nonce, built.lang) },
            ...historyMessages,
            { role: "user", content: userContent },
          ],
        }),
        redirect: "error",
        signal: abortController.signal,
      });
    } catch (err) {
      if (stalled) throw new ModelStalledError(inactivityMs);
      if (timedOut) throw new ModelTimeoutError(firstTokenMs);
      // Same reasoning as claude-api.ts's own catch here (I3): never forward a raw fetch error's
      // own message, which can echo request internals in some runtimes — a fixed, generic message
      // names the failure without repeating anything client-supplied.
      throw new ModelUnavailableError(`cannot reach the server at ${baseUrl}`);
    }

    if (!response.ok) {
      const lang = opts.lang ?? DEFAULT_LANG;
      const isOpenRouter = (() => {
        try {
          return new URL(baseUrl).origin === OPENROUTER_ORIGIN;
        } catch {
          return false;
        }
      })();
      if (response.status === 401 || response.status === 403) {
        throw new AuthRequiredError(t("auth.apiKeyRejected", lang));
      }
      // 404, or Mistral's `unknown_model` body on another status — the model
      // itself is wrong, not auth, not a generic unreachable server
      if (response.status === 404) {
        throw new ModelMissingError(t("provider.modelMissing", lang));
      }
      {
        const bodyText = await response.text().catch(() => "");
        if (isUnknownModelBody(bodyText)) {
          throw new ModelMissingError(t("provider.modelMissing", lang));
        }
        // docs/PROTOCOL.md: the key/model
        // are fine, the server's 400 is specifically about the image we
        // attached — only ever reclassified when this request actually
        // carried one, so an unrelated 400 mentioning "image" isn't misread.
        if (response.status === 400 && images.length > 0 && /image|vision|multimodal/i.test(bodyText)) {
          throw new VisionUnsupportedError(`server rejected the attached image: ${bodyText.slice(0, 300)}`);
        }
        if (response.status === 402) {
          // OpenRouter's "in-flight budget" 402 carries a Retry-After header
          // and is transient (rate-limited); without it, it's a plain empty
          // balance (quota-exceeded). Every other provider's 402 stays
          // quota-exceeded unconditionally.
          const retryAfter = response.headers.get("retry-after");
          if (isOpenRouter && retryAfter) {
            throw new RateLimitedError(t("provider.rateLimited", lang), parseRetryAfterSec(retryAfter));
          }
          throw new QuotaExceededError(t("provider.quotaExceeded", lang));
        }
        if (response.status === 429) {
          if (isInsufficientQuotaBody(bodyText)) {
            throw new QuotaExceededError(t("provider.quotaExceeded", lang));
          }
          const retryAfterSec = parseRetryAfterSec(response.headers.get("retry-after"));
          throw new RateLimitedError(t("provider.rateLimited", lang), retryAfterSec);
        }
      }
      if (response.status === 502 || response.status === 503) {
        throw new ProviderOverloadedError(t("provider.overloaded", lang));
      }
      if (response.status >= 500) {
        throw new ModelUnavailableError(`server returned HTTP ${response.status}`);
      }
      throw new ModelUnavailableError(`server returned HTTP ${response.status}`);
    }
    if (!response.body) {
      throw new Error("server response has no body");
    }

    // Strip <think>…</think> blocks (and ignore any
    // delta.reasoning_content — already not read by parseSseLine) so that
    // thinking tokens from o1/qwen3-style models never reach the extension.
    const filter = new ThinkFilter();
    for await (const event of parseSseStream(response.body)) {
      if (event.kind === "delta") {
        if (!gotFirstChunk) { gotFirstChunk = true; clearTimeout(firstTokenTimer); resetInactivity(); }
        else { resetInactivity(); }
        const filtered = filter.filter(event.text);
        if (filtered.length > 0) yield { kind: "delta", text: filtered };
      } else {
        yield event.kind === "usage" ? { ...event, historyKept } : event;
      }
    }
    const tail = filter.flush();
    if (tail.length > 0) yield { kind: "delta", text: tail };
  } catch (err) {
    if (stalled) throw new ModelStalledError(inactivityMs);
    if (timedOut) throw new ModelTimeoutError(firstTokenMs);
    throw err;
  } finally {
    clearTimeout(firstTokenTimer);
    clearTimeout(inactivityTimer);
  }

  if (stalled) throw new ModelStalledError(inactivityMs);
  if (timedOut) throw new ModelTimeoutError(firstTokenMs);
}

export const openaiCompatProvider: ModelProvider = {
  id: "openai-compat",
  label: "Compatible OpenAI",
  isAvailable,
  listModels,
  checkStatus,
  testConnection,
  streamAnswer,
  supportsVision,
};
