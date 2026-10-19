// The "claude-api" provider: talks directly to the Anthropic Messages API
// over HTTPS, using the user's own API key (BYOK — the only shippable path;
// a personal subscription used through some other means can never be
// resold, see MEMORY.md "Fixed economic constraints"). Streaming via Bun's `fetch` +
// `ReadableStream`, no SDK dependency. Prompt assembly (fencing, system
// prompt) lives in ../model.ts and is shared by every provider — see
// ../model.ts's header.

import {
  buildSystemPrompt,
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
// substitute a fake here so the SSE-parsing and error-classification paths
// can be exercised without a real Anthropic API key or network access. Not
// part of the public API — only broker/test/*.test.ts should call the two
// functions below.
let fetchImpl: typeof fetch = fetch;
export function __setFetchImplForTests(fn: typeof fetch): void {
  fetchImpl = fn;
}
export function __resetFetchImplForTests(): void {
  fetchImpl = fetch;
}

const ANTHROPIC_API_URL = "https://api.anthropic.com/v1/messages";
const ANTHROPIC_VERSION = "2023-06-01";

// docs/PROTOCOL.md: a FREE
// key check — confirmed by a cited source at implementation time
// that this route is never billed, unlike POST /v1/messages above. Used only
// by testConnection() below, never by streamAnswer().
const ANTHROPIC_MODELS_URL = "https://api.anthropic.com/v1/models";
const TEST_CONNECTION_DEFAULT_TIMEOUT_MS = 20_000;

// Per the claude-api skill's "Current Models" table (checked at implementation
// time): always claude-opus-5 unless the user names a different
// model — which they can, via the `model` field of `settings.set` (same slot
// ollama uses for its own model name), overriding this default.
export const CLAUDE_API_DEFAULT_MODEL = "claude-opus-5";

// A comfortable ceiling for a side-panel chat/summary reply. Streaming means
// no HTTP-timeout risk from a larger cap (see the skill's max_tokens
// guidance), but nothing here needs more than a few thousand output tokens.
const MAX_TOKENS = 8192;

// User-facing (sent verbatim as ErrorMessage.message — the panel
// displays it as-is), per task brief: a 401/403 names the remedy. Never
// includes the key itself. Localised per-connection at the throw site below
// (opts.lang) — this constant is the DEFAULT_LANG (en) wording, kept exported
// for tests that don't set up a lang at all.
export const CLAUDE_API_AUTH_MESSAGE = t("auth.apiKeyRejected", DEFAULT_LANG);

// docs/PROTOCOL.md:
// same contract as CLAUDE_API_AUTH_MESSAGE above — DEFAULT_LANG (en) wording,
// localised per-connection at the throw site via opts.lang.
export const CLAUDE_API_QUOTA_EXCEEDED_MESSAGE = t("provider.quotaExceeded", DEFAULT_LANG);
export const CLAUDE_API_RATE_LIMITED_MESSAGE = t("provider.rateLimited", DEFAULT_LANG);

/**
 * True when an Anthropic API error response body signals a billing/quota
 * problem rather than a plain rejection — the Messages API returns this as
 * either a 402, or a 400 whose error object is a billing_error / whose
 * message names a credit shortfall ("credit balance is too low" — the exact
 * wording observed at implementation time), or (defensively,
 * mirroring the OpenAI-compatible convention) a 429 whose error code/type is
 * "insufficient_quota". Never throws on a malformed/non-JSON body — treated
 * as "no quota signal" rather than crashing the error path.
 */
function isAnthropicQuotaBody(bodyText: string): boolean {
  const lower = bodyText.toLowerCase();
  if (lower.includes("credit balance is too low")) return true;
  // "model failure path": a 400
  // invalid_request_error can also name a spend/usage limit the account's
  // owner configured (distinct from an empty credit balance, same remedy:
  // quota-exceeded, never a generic internal error).
  if (lower.includes("spend limit") || lower.includes("usage limit")) return true;
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
  return type === "billing_error" || type === "insufficient_quota" || code === "insufficient_quota";
}

async function isAvailable(opts: ProviderRuntimeOptions): Promise<Availability> {
  const key = opts.apiKey?.trim();
  if (!key) {
    return { available: false, reason: t("availability.claudeApi.noKey", opts.lang ?? DEFAULT_LANG) };
  }
  return { available: true };
}

/** `provider.status` for claude-api (docs/PROTOCOL.md "Provider availability"): the same free
 * `GET /v1/models` probe as testConnection below. */
async function checkStatus(opts: ProviderRuntimeOptions): Promise<StatusCheck> {
  if (!opts.apiKey?.trim()) return { state: "ko", reason: "no-key" };
  const result = await testConnection(opts);
  if (result.ok) return { state: "ok", reason: "ready" };
  if (result.code === "auth-required") return { state: "ko", reason: "key-rejected" };
  if (result.code === "model-missing") return { state: "ko", reason: "model-missing" };
  return { state: "unknown", reason: "probe-failed" };
}

/**
 * `settings.test` for claude-api (docs/PROTOCOL.md): FREE key check via `GET /v1/models`, never the
 * billed `POST /v1/messages` streamAnswer() uses. `redirect: "error"` — same
 * redirect-refusal invariant as openai-compat.ts's fetchModelIds, never
 * follow a redirect that could carry the key to a different origin. Never
 * throws — classifies via TestConnectionResult.code instead. This is
 * intentionally presence/acceptance-only: it cannot see an empty credit
 * balance (docs/PROTOCOL.md's own caveat) — that surfaces as
 * `quota-exceeded` on the first real request instead.
 */
async function testConnection(
  opts: ProviderRuntimeOptions & { timeoutMs?: number },
): Promise<TestConnectionResult> {
  const key = opts.apiKey?.trim();
  if (!key) return { ok: false, code: "auth-required" };
  try {
    const response = await fetchImpl(ANTHROPIC_MODELS_URL, {
      headers: {
        "x-api-key": key,
        "anthropic-version": ANTHROPIC_VERSION,
      },
      redirect: "error",
      signal: AbortSignal.timeout(opts.timeoutMs ?? TEST_CONNECTION_DEFAULT_TIMEOUT_MS),
    });
    if (response.ok) {
      // The key is accepted — now
      // check the CONFIGURED model is actually in the list this key can see,
      // so a wrong/retired model name surfaces here rather than on the first
      // real chat request. Never throws on an unexpected body shape — no
      // model configured, or a body this probe can't parse, just skips the
      // check (ok: true). This probe is presence/acceptance-only: it cannot
      // see the account's credit balance (docs/PROTOCOL.md's own caveat).
      if (opts.model) {
        const body = await response.json().catch(() => undefined);
        const ids = Array.isArray((body as { data?: unknown })?.data)
          ? ((body as { data: unknown[] }).data
              .map((m) => (m && typeof m === "object" ? (m as Record<string, unknown>).id : undefined))
              .filter((id): id is string => typeof id === "string"))
          : undefined;
        if (ids && !ids.includes(opts.model)) {
          return { ok: false, code: "model-missing" };
        }
      }
      return { ok: true, creditUnchecked: true };
    }
    if (response.status === 401) return { ok: false, code: "auth-required" };
    if (response.status === 403) return { ok: false, code: "model-missing" };
    if (response.status === 402) return { ok: false, code: "quota-exceeded" };
    if (response.status === 429) return { ok: false, code: "rate-limited" };
    if (response.status === 529 || response.status === 502 || response.status === 503) {
      return { ok: false, code: "provider-overloaded" };
    }
    return { ok: false, code: "model-unavailable" };
  } catch {
    return { ok: false, code: "model-unavailable" };
  }
}

/**
 * Model ids this key can use, from `GET /v1/models` (free, never billed).
 * Rejects when there is no key or the call fails, so a missing or refused key
 * yields no model list at all.
 */
async function listModels(opts: ProviderRuntimeOptions): Promise<string[]> {
  const key = opts.apiKey?.trim();
  if (!key) throw new Error("no key");
  const response = await fetchImpl(`${ANTHROPIC_MODELS_URL}?limit=1000`, {
    headers: { "x-api-key": key, "anthropic-version": ANTHROPIC_VERSION },
    redirect: "error",
    signal: AbortSignal.timeout(TEST_CONNECTION_DEFAULT_TIMEOUT_MS),
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const body = (await response.json()) as { data?: unknown };
  if (!Array.isArray(body?.data)) throw new Error("unexpected body");
  return body.data
    .map((m) => (m && typeof m === "object" ? (m as Record<string, unknown>).id : undefined))
    .filter((id): id is string => typeof id === "string");
}

/**
 * Parses one SSE line of an Anthropic /v1/messages streaming response,
 * mutating `state` for the two usage fields that only ever appear on
 * separate events (message_start carries input_tokens, message_delta
 * carries the running output_tokens) and yielding zero or more AnswerEvents.
 * Non-"data:" lines (blank separators, "event:" lines, ":" comments) are
 * ignored — the JSON payload's own `type` field is enough to dispatch on, so
 * the "event:" line is redundant here. Exported standalone (alongside
 * parseSseStream below) so tests can feed fixed line fixtures without going
 * through a fake fetch.
 */
export function* parseSseLine(
  line: string,
  state: { inputTokens: number; outputTokens: number },
): Generator<AnswerEvent> {
  const trimmed = line.trimEnd();
  if (!trimmed.startsWith("data:")) return;
  const jsonText = trimmed.slice(5).trim();
  if (!jsonText) return;
  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonText);
  } catch {
    return; // malformed line — skip rather than crash mid-stream
  }
  if (!parsed || typeof parsed !== "object") return;
  const obj = parsed as Record<string, unknown>;

  switch (obj.type) {
    case "message_start": {
      const message = obj.message as Record<string, unknown> | undefined;
      const usage = message?.usage as Record<string, unknown> | undefined;
      if (usage && typeof usage.input_tokens === "number") state.inputTokens = usage.input_tokens;
      return;
    }
    case "content_block_delta": {
      const delta = obj.delta as Record<string, unknown> | undefined;
      // Only text_delta carries visible reply text — thinking_delta (adaptive
      // thinking, on by default on this model family) is intentionally not
      // surfaced to the panel.
      if (delta?.type === "text_delta" && typeof delta.text === "string") {
        yield { kind: "delta", text: delta.text };
      }
      return;
    }
    case "message_delta": {
      const usage = obj.usage as Record<string, unknown> | undefined;
      if (usage && typeof usage.output_tokens === "number") state.outputTokens = usage.output_tokens;
      return;
    }
    case "message_stop": {
      yield { kind: "usage", usage: { inputTokens: state.inputTokens, outputTokens: state.outputTokens } };
      return;
    }
    case "error": {
      const error = obj.error as Record<string, unknown> | undefined;
      const message = typeof error?.message === "string" ? error.message : "Anthropic API stream error";
      throw Object.assign(new Error(message), { streamErrorType: error?.type });
    }
    default:
      return; // ping, content_block_start/stop, etc. — nothing to do
  }
}

/** Reads a fetch Response body (SSE, one `data: {...}` JSON payload per
 * event) and yields AnswerEvents as lines complete. A final partial line with
 * no trailing newline is flushed once the body ends. Mirrors
 * providers/ollama.ts's parseNdjsonStream structure. */
export async function* parseSseStream(body: ReadableStream<Uint8Array>): AsyncGenerator<AnswerEvent> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  const state = { inputTokens: 0, outputTokens: 0 };
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
        yield* parseSseLine(line, state);
      }
    }
    if (buffer.trim()) yield* parseSseLine(buffer, state);
  } finally {
    reader.releaseLock();
  }
}

/**
 * Streams the model's answer to `built.prompt` via the Anthropic Messages
 * API (SSE). Same timeout/abort/typed-error semantics as the other
 * providers — see providers/types.ts's ModelProvider doc.
 */
export async function* streamAnswer(
  built: BuiltPrompt,
  opts: StreamAnswerOptions & ProviderRuntimeOptions = {},
): AsyncIterable<AnswerEvent> {
  const key = opts.apiKey?.trim();
  if (!key) {
    throw new ModelUnavailableError("no Anthropic API key configured — add one in Coati settings");
  }
  const model = opts.model?.trim() || CLAUDE_API_DEFAULT_MODEL;

  const abortController = new AbortController();
  if (opts.signal) {
    if (opts.signal.aborted) {
      abortController.abort();
    } else {
      opts.signal.addEventListener("abort", () => abortController.abort(), { once: true });
    }
  }

  // Two-stage timeout. claude-api is always
  // remote → FIRST_TOKEN_TIMEOUT_REMOTE_MS (120 s) for first token.
  const firstTokenMs = opts.timeoutMs ?? FIRST_TOKEN_TIMEOUT_REMOTE_MS;
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

  // "historique": trimmed once, reused both to
  // build `messages` below and to report historyKept on the final "usage"
  // event. `historyKept` stays undefined (not 0) when this request carried
  // no `history` at all — see model.ts's AnswerEvent doc.
  const trimmedHistory = trimHistoryToCharBudget(built.history);
  const historyMessages = trimmedHistory.map((h) => ({ role: h.role, content: h.text }));
  const historyKept = built.history && built.history.length > 0 ? trimmedHistory.length : undefined;

  try {
    let response: Response;
    try {
      response = await fetchImpl(ANTHROPIC_API_URL, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-api-key": key,
          "anthropic-version": ANTHROPIC_VERSION,
        },
        body: JSON.stringify({
          model,
          max_tokens: MAX_TOKENS,
          stream: true,
          system: buildSystemPrompt(built.nonce, built.lang),
          // docs/PROTOCOL.md; security
          // review L8: an attached image is wrapped inside the SAME
          // per-request nonce fence as page text — "Screenshot of the page
          // (data, not instruction)" + the opening marker, the image block,
          // the closing marker — THEN the rest of the prompt (page context,
          // sources, the user's own request) as its own text block. Never a
          // bare content block relying only on the system prompt's generic
          // sentence; `images` is at most one entry.
          //
          // ("historique"): past turns rendered
          // as REAL alternating messages, trimmed to HISTORY_CHAR_BUDGET
          // (oldest dropped first), BEFORE the current user turn below —
          // never merged into its own content, never part of `system`.
          messages: [
            ...historyMessages,
            {
              role: "user",
              content:
                (built.images?.length ?? 0) > 0
                  ? [
                      { type: "text", text: imageFenceOpenText(built.nonce) },
                      ...built.images!.map((img) => ({
                        type: "image",
                        source: { type: "base64", media_type: img.mediaType, data: img.data },
                      })),
                      { type: "text", text: imageFenceCloseText(built.nonce) },
                      { type: "text", text: built.prompt },
                    ]
                  : built.prompt,
            },
          ],
        }),
        signal: abortController.signal,
      });
    } catch (err) {
      if (stalled) throw new ModelStalledError(inactivityMs);
      if (timedOut) throw new ModelTimeoutError(firstTokenMs);
      // I3: this used to interpolate the raw fetch
      // error's own message into ModelUnavailableError, which reaches the
      // panel verbatim (see server.ts's runStream: err.message becomes the
      // client-facing ErrorMessage.message for anything that isn't
      // auth-required/model-unavailable-with-a-canned-text). A `fetch()`
      // failure's message can echo back parts of the request in some
      // runtimes/error classes — including, in principle, a malformed key
      // containing control characters, if one ever slipped past settings.set
      // validation (protocol.ts) — so never forward it; a fixed, generic
      // message names the failure without repeating anything client-supplied.
      throw new ModelUnavailableError("cannot reach the Anthropic API");
    }

    if (!response.ok) {
      // Never read the key back out, never include it below — only the HTTP
      // status (and, for the two cases below, the error body's own `type`/
      // `code`/`message` — never anything client-supplied) is used to
      // classify the failure.
      const lang = opts.lang ?? DEFAULT_LANG;
      // 403 permission_error: the key
      // IS accepted, it's this model the account isn't authorized for — not
      // auth-required (that would send the user re-entering a key that's
      // fine). 401 stays auth-required: that's a rejected key.
      if (response.status === 401) {
        throw new AuthRequiredError(t("auth.apiKeyRejected", lang));
      }
      if (response.status === 403) {
        throw new ModelMissingError(t("provider.modelMissing", lang));
      }
      if (response.status === 402) {
        throw new QuotaExceededError(t("provider.quotaExceeded", lang));
      }
      if (response.status === 400) {
        const bodyText = await response.text().catch(() => "");
        if (isAnthropicQuotaBody(bodyText)) {
          throw new QuotaExceededError(t("provider.quotaExceeded", lang));
        }
        // docs/PROTOCOL.md: the key is
        // fine, Anthropic's 400 is specifically about the attached image —
        // only ever reclassified when this request actually carried one.
        if ((built.images?.length ?? 0) > 0 && /image/i.test(bodyText)) {
          throw new VisionUnsupportedError(`Anthropic API rejected the attached image: ${bodyText.slice(0, 300)}`);
        }
        // Any other 400 is a malformed/unsupported
        // request, not an internal Coati bug — model-unavailable names the
        // actual failure instead of the generic "internal" code.
        throw new ModelUnavailableError(`Anthropic API returned HTTP 400`);
      }
      if (response.status === 429) {
        const bodyText = await response.text().catch(() => "");
        if (isAnthropicQuotaBody(bodyText)) {
          throw new QuotaExceededError(t("provider.quotaExceeded", lang));
        }
        const retryAfterSec = parseRetryAfterSec(response.headers.get("retry-after"));
        throw new RateLimitedError(t("provider.rateLimited", lang), retryAfterSec);
      }
      // 529 overloaded_error, and a bare 502/503 — transient upstream
      // overload: "try again", not
      // "fix your settings" (model-unavailable's remedy). Any other 5xx
      // still falls back to model-unavailable below.
      if (response.status === 529 || response.status === 502 || response.status === 503) {
        throw new ProviderOverloadedError(t("provider.overloaded", lang));
      }
      if (response.status >= 500) {
        throw new ModelUnavailableError(`Anthropic API returned HTTP ${response.status}`);
      }
      throw new ModelUnavailableError(`Anthropic API returned HTTP ${response.status}`);
    }
    if (!response.body) {
      throw new Error("Anthropic API response has no body");
    }

    for await (const event of parseSseStream(response.body)) {
      if (event.kind === "delta") {
        if (!gotFirstChunk) { gotFirstChunk = true; clearTimeout(firstTokenTimer); resetInactivity(); }
        else { resetInactivity(); }
      }
      yield event.kind === "usage" ? { ...event, historyKept } : event;
    }
  } catch (err) {
    if (stalled) throw new ModelStalledError(inactivityMs);
    if (timedOut) throw new ModelTimeoutError(firstTokenMs);
    // An `error` event mid-stream carries the same types as an HTTP error.
    const streamType = (err as { streamErrorType?: unknown })?.streamErrorType;
    if (streamType === "overloaded_error" || streamType === "api_error") {
      throw new ProviderOverloadedError(t("provider.overloaded", opts.lang ?? DEFAULT_LANG));
    }
    if (streamType === "rate_limit_error") throw new RateLimitedError(t("provider.rateLimited", opts.lang ?? DEFAULT_LANG));
    throw err;
  } finally {
    clearTimeout(firstTokenTimer);
    clearTimeout(inactivityTimer);
  }

  if (stalled) throw new ModelStalledError(inactivityMs);
  if (timedOut) throw new ModelTimeoutError(firstTokenMs);
}

export const claudeApiProvider: ModelProvider = {
  id: "claude-api",
  label: "Claude (API key)",
  isAvailable,
  checkStatus,
  testConnection,
  listModels,
  streamAnswer,
  defaultModel: CLAUDE_API_DEFAULT_MODEL,
  // docs/PROTOCOL.md: every claude-api
  // model understands an attached image — static, not per-model.
  vision: true,
};
