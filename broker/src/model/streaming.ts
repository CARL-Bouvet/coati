// Streaming-side contract shared by every provider (broker/src/providers/*):
// the typed error classes server.ts switches on to pick a wire error code,
// the two-stage timeout constants, StreamAnswerOptions/AnswerEvent, and
// ThinkFilter. Split out of model.ts (lot F5) — independent of prompt
// building (model/render.ts, model/build.ts).

/** Thrown by a provider's streamAnswer when the first-token deadline elapses
 * with no chunk from the model (hung before generating anything). Distinct
 * from ModelStalledError (below). Treated as model-unavailable by
 * isModelUnavailableError; server.ts logs it with outcome "timeout". */
export class ModelTimeoutError extends Error {
  constructor(timeoutMs: number) {
    super(`model call exceeded ${timeoutMs}ms with no response`);
    this.name = "ModelTimeoutError";
  }
}

/**
 * Thrown by a provider's streamAnswer when the inactivity deadline elapses
 * mid-stream (at least one chunk was received, then silence for
 * INACTIVITY_TIMEOUT_MS). Distinct from ModelTimeoutError (which fires before
 * the first chunk). Maps to error code "model-stalled" (amendement
 * 2026-10-07 bis). isModelUnavailableError returns false for this — it gets
 * its own code via isModelStalledError, checked first in server.ts.
 */
export class ModelStalledError extends Error {
  constructor(inactivityMs: number) {
    super(`model stream stalled: no token for ${inactivityMs}ms mid-answer`);
    this.name = "ModelStalledError";
  }
}

/** True when `err` is (or wraps) a ModelStalledError. Checked by server.ts
 * BEFORE isModelUnavailableError so it gets code "model-stalled" rather than
 * "model-unavailable". */
export function isModelStalledError(err: unknown): boolean {
  return err instanceof ModelStalledError;
}

/** Thrown by a provider when it can positively determine the model/backend is
 * not usable right now — binary missing, daemon not running, configured model
 * not installed. Distinct from ModelTimeoutError (which is about a hang) so a
 * provider can raise this immediately instead of waiting out the timeout. */
export class ModelUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ModelUnavailableError";
  }
}

/**
 * Thrown by a provider when it can positively determine the underlying
 * session/credentials are the problem — not "model unreachable", not "hung",
 * but "the human needs to re-authenticate". Distinct from
 * ModelUnavailableError on purpose (task C3, 2026-09-21): a session-backed
 * provider's credentials can expire routinely, and the remedy for that is
 * nothing like the remedy for a missing binary or an overloaded API, so
 * folding it into `model-unavailable` would send the user fixing the wrong
 * thing. See claude-api.ts's CLAUDE_API_AUTH_MESSAGE, or an external
 * module's own auth detection (docs/MODULES.md), for what actually throws
 * this.
 */
export class AuthRequiredError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AuthRequiredError";
  }
}

/** True when `err` is (or wraps) an AuthRequiredError. Used by server.ts to
 * pick the `auth-required` error code ahead of `model-unavailable`/`internal`
 * — see PROTOCOL.md. */
export function isAuthRequiredError(err: unknown): boolean {
  return err instanceof AuthRequiredError;
}

/**
 * Thrown by a provider when it can positively determine the account behind
 * the configured key/subscription has run out of credit or quota — a billing
 * problem, not a wrong key (that's AuthRequiredError) and not a transient
 * overload (that's RateLimitedError below). Amendement 2026-10-01
 * (docs/PROTOCOL.md "Model provider", goal U1). `message` is the
 * connection-language fixed remedy text (messages.ts's "provider.quotaExceeded"),
 * same contract as AuthRequiredError's message — shown verbatim, never the
 * raw provider detail.
 */
export class QuotaExceededError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "QuotaExceededError";
  }
}

/** True when `err` is (or wraps) a QuotaExceededError. Checked by server.ts
 * ahead of isModelUnavailableError — see PROTOCOL.md. */
export function isQuotaExceededError(err: unknown): boolean {
  return err instanceof QuotaExceededError;
}

/**
 * Thrown by a provider on a plain "too many requests" rejection (HTTP 429
 * with no quota/billing signal in the body) — typical of OpenRouter's free
 * models. Amendement 2026-10-01 (docs/PROTOCOL.md "Model provider",
 * goal U1). `message` is the connection-language fixed remedy text
 * (messages.ts's "provider.rateLimited"). `retryAfterSec`, when the provider
 * sent a `Retry-After` header, is forwarded on the wire's ErrorMessage.
 */
export class RateLimitedError extends Error {
  readonly retryAfterSec?: number;
  constructor(message: string, retryAfterSec?: number) {
    super(message);
    this.name = "RateLimitedError";
    this.retryAfterSec = retryAfterSec;
  }
}

/** True when `err` is (or wraps) a RateLimitedError. Checked by server.ts
 * ahead of isModelUnavailableError — see PROTOCOL.md. */
export function isRateLimitedError(err: unknown): boolean {
  return err instanceof RateLimitedError;
}

/**
 * Thrown either by server.ts itself (BEFORE calling the provider at all,
 * when the active model's vision support is positively known to be
 * `false`) or by a provider's streamAnswer when the backend's own 400 names
 * the attached image as the problem while vision was unknown ahead of time
 * — docs/PROTOCOL.md §4, amendement 2026-10-08 (lot B1). Distinct from
 * ModelMissingError/ModelUnavailableError: the model itself is fine, it
 * just cannot see.
 */
export class VisionUnsupportedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "VisionUnsupportedError";
  }
}

/** True when `err` is (or wraps) a VisionUnsupportedError. Checked by
 * server.ts ahead of isModelUnavailableError — see PROTOCOL.md. */
export function isVisionUnsupportedError(err: unknown): boolean {
  return err instanceof VisionUnsupportedError;
}

/**
 * Thrown by a provider when it can positively determine the configured
 * model does not exist / is not authorized for this account — distinct from
 * AuthRequiredError (the key itself is fine) and from ModelUnavailableError
 * (the backend is reachable, it is this specific model that is wrong).
 * Amendement 2026-10-02 (goal-j2FJ-kI7, "model failure path"): Anthropic's
 * 403 permission_error, a 404 model lookup, or Mistral's `unknown_model` all
 * land here rather than auth-required/model-unavailable, so the panel sends
 * the user to pick another model instead of re-entering a key that is fine.
 */
export class ModelMissingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ModelMissingError";
  }
}

/** True when `err` is (or wraps) a ModelMissingError. Checked by server.ts
 * ahead of isModelUnavailableError — see PROTOCOL.md. */
export function isModelMissingError(err: unknown): boolean {
  return err instanceof ModelMissingError;
}

/**
 * Thrown by a provider when the upstream API itself reports a transient
 * overload — Anthropic 529 overloaded_error, a bare 502/503, OpenAI's
 * `server_is_overloaded`, or an OpenRouter in-stream error whose text names
 * an upstream/overload condition. Amendement 2026-10-02 (goal-j2FJ-kI7): the
 * remedy is "try again shortly", never "open settings" — distinct from
 * ModelUnavailableError so the panel doesn't send the user chasing a
 * misconfiguration that isn't there.
 */
export class ProviderOverloadedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProviderOverloadedError";
  }
}

/** True when `err` is (or wraps) a ProviderOverloadedError. Checked by
 * server.ts ahead of isModelUnavailableError — see PROTOCOL.md. */
export function isProviderOverloadedError(err: unknown): boolean {
  return err instanceof ProviderOverloadedError;
}

/**
 * True when `err` indicates the model itself is unreachable — the `claude`
 * binary missing or not executable (spawn ENOENT/EACCES), a quota/rate-limit
 * rejection surfaced by the SDK, a hung call that hit the provider's timeout,
 * an unreachable/unconfigured Ollama daemon, or a configured Ollama model
 * that isn't installed — as opposed to a genuine internal bug in this broker.
 * Used by server.ts to pick between the `model-unavailable` and `internal`
 * error codes (see PROTOCOL.md). Provider-agnostic on purpose: every provider
 * either throws one of the two typed errors above, or an Error whose message
 * matches one of the patterns below. Never true for an AuthRequiredError —
 * that gets its own `auth-required` code (see isAuthRequiredError above),
 * checked first by server.ts.
 */
export function isModelUnavailableError(err: unknown): boolean {
  if (err instanceof AuthRequiredError) return false;
  // Amendement 2026-10-01 (goal U1): these two now have their own codes
  // (quota-exceeded/rate-limited) — never folded back into model-unavailable
  // for a provider that throws the typed class. Providers that only have a
  // generic Error with a matching message (claude-cli, via the SDK) keep
  // falling through to the heuristic below, unchanged.
  if (err instanceof QuotaExceededError) return false;
  if (err instanceof RateLimitedError) return false;
  // Amendement 2026-10-07 (bis): model-stalled has its own code — checked
  // first in server.ts (isModelStalledError), so never treated as
  // model-unavailable here.
  if (err instanceof ModelStalledError) return false;
  // Amendement 2026-10-08 (lot B1): vision-unsupported has its own code —
  // checked first in server.ts (isVisionUnsupportedError).
  if (err instanceof VisionUnsupportedError) return false;
  if (err instanceof ModelTimeoutError) return true;
  if (err instanceof ModelUnavailableError) return true;
  if (!(err instanceof Error)) return false;
  const code = (err as NodeJS.ErrnoException).code;
  if (code === "ENOENT" || code === "EACCES" || code === "EPERM" || code === "ECONNREFUSED") return true;
  const message = err.message.toLowerCase();
  return (
    message.includes("enoent") ||
    message.includes("eacces") ||
    message.includes("econnrefused") ||
    message.includes("no such file or directory") ||
    message.includes("not executable") ||
    message.includes("process exited") ||
    message.includes("quota") ||
    message.includes("rate limit") ||
    message.includes("rate_limit") ||
    message.includes("overloaded") ||
    message.includes(" 429") ||
    message.includes(" 529") ||
    message.includes("fetch failed") ||
    message.includes("connection refused")
  );
}

/**
 * Parses an HTTP `Retry-After` header value into whole seconds, per
 * RFC 9110 §10.2.3 — this broker only supports the delay-seconds form (a
 * plain non-negative integer), never the HTTP-date form, since no provider
 * observed at implementation time (2026-10-01) sends the latter and a wrong
 * parse would just be omitted rather than mislead the user. Returns
 * `undefined` for anything else (header absent, HTTP-date, negative,
 * non-numeric) — callers then simply omit `retryAfterSec` on the wire.
 * Shared by claude-api.ts and openai-compat.ts (both throw RateLimitedError
 * on a plain HTTP 429 — see docs/PROTOCOL.md "Model provider",
 * amendement 2026-10-01).
 */
export function parseRetryAfterSec(headerValue: string | null): number | undefined {
  if (!headerValue) return undefined;
  const trimmed = headerValue.trim();
  if (!/^\d+$/.test(trimmed)) return undefined;
  const seconds = Number.parseInt(trimmed, 10);
  return Number.isFinite(seconds) && seconds >= 0 ? seconds : undefined;
}

// Amendement 2026-10-07 (bis): two-stage timeout replacing the old single cap.
//
// FIRST_TOKEN_TIMEOUT_*: deadline from request start to first chunk (no chunk
// at all = hung call). Local loopback (Ollama, openai-compat on 127.x) gets
// 300 s to account for cold model loads; remote APIs get 120 s.
//
// INACTIVITY_TIMEOUT_MS: reset on every chunk; fires when the stream goes
// silent for 60 s mid-answer. Throws ModelStalledError (→ error code
// "model-stalled"), distinct from ModelTimeoutError ("model-timeout").
//
// MODEL_TIMEOUT_MS kept for backward compat: equals FIRST_TOKEN_TIMEOUT_REMOTE_MS
// so that test `timeoutMs` overrides keep working unchanged.
export const FIRST_TOKEN_TIMEOUT_LOCAL_MS = 300_000;
export const FIRST_TOKEN_TIMEOUT_REMOTE_MS = 120_000;
export const INACTIVITY_TIMEOUT_MS = 60_000;
/** @deprecated Use FIRST_TOKEN_TIMEOUT_REMOTE_MS or FIRST_TOKEN_TIMEOUT_LOCAL_MS. */
export const MODEL_TIMEOUT_MS = FIRST_TOKEN_TIMEOUT_REMOTE_MS;

export interface StreamAnswerOptions {
  signal?: AbortSignal;
  /**
   * Overrides the first-token deadline. Test-only knob.
   * Maps to FIRST_TOKEN_TIMEOUT_REMOTE_MS by default for non-loopback providers.
   */
  timeoutMs?: number;
  /**
   * Overrides the inactivity deadline. Test-only knob.
   * Defaults to INACTIVITY_TIMEOUT_MS (60 s).
   */
  inactivityTimeoutMs?: number;
}

export type AnswerEvent =
  | { kind: "delta"; text: string }
  | {
      kind: "usage";
      usage: { inputTokens: number; outputTokens: number };
      /**
       * Amendement 2026-10-08 (bis, "historique"). Number of `history`
       * entries this provider actually kept after its own trim (char
       * budget, or Ollama's context-tier fit) — server.ts forwards it
       * verbatim as DoneMessage.historyKept. Absent when this request
       * carried no `history` at all (see DoneMessage.historyKept's own
       * doc for the 0-vs-absent distinction).
       */
      historyKept?: number;
    }
  // Amendement 2026-10-07 (bis) — thinking-only models (e.g. qwen3:4b):
  // Ollama routes reasoning to message.thinking; the provider emits this event
  // so callers can count it as activity without forwarding it as text.
  | { kind: "thinking" };

/**
 * Streaming filter that removes `<think>…</think>` blocks from text deltas.
 * Robust to:
 *  - Tags split across chunk boundaries (carries partial tag state between calls).
 *  - A stream that starts with an unclosed `<think>` (drops content until `</think>`).
 *  - Overlapping/nested think blocks (any `<think>` inside a block is ignored — we
 *    only look for `</think>` to leave think state).
 * Used by ollama.ts and openai-compat.ts to suppress reasoning tokens before
 * they reach the extension. The filter is a no-op for models that never emit
 * `<think>` tags. Amendement 2026-10-07 (docs/PROTOCOL.md).
 */
export class ThinkFilter {
  private _inThink = false;
  /** Tail of the last chunk that could be a partial opening/closing tag. */
  private _buf = "";

  /** Feed the next text chunk; returns the filtered output (may be ""). */
  filter(chunk: string): string {
    let text = this._buf + chunk;
    this._buf = "";
    let out = "";

    while (text.length > 0) {
      if (this._inThink) {
        const end = text.indexOf("</think>");
        if (end !== -1) {
          // Found the close tag — resume normal output after it.
          text = text.slice(end + "</think>".length);
          this._inThink = false;
        } else {
          // Close tag not found; save a potential partial at the tail.
          const CLOSE = "</think>";
          let kept = 0;
          for (let k = Math.min(CLOSE.length - 1, text.length); k > 0; k--) {
            if (text.endsWith(CLOSE.slice(0, k))) { kept = k; break; }
          }
          this._buf = text.slice(text.length - kept);
          text = "";
        }
      } else {
        const start = text.indexOf("<think>");
        if (start !== -1) {
          out += text.slice(0, start);
          text = text.slice(start + "<think>".length);
          this._inThink = true;
        } else {
          // Open tag not found; save a potential partial at the tail.
          const OPEN = "<think>";
          let kept = 0;
          for (let k = Math.min(OPEN.length - 1, text.length); k > 0; k--) {
            if (text.endsWith(OPEN.slice(0, k))) { kept = k; break; }
          }
          out += text.slice(0, text.length - kept);
          this._buf = text.slice(text.length - kept);
          text = "";
        }
      }
    }
    return out;
  }

  /**
   * Flush any carried-over partial tag at end of stream. Must be called once
   * after the last `filter()` to emit any text that was held in the buffer
   * pending a potential tag that never completed.
   */
  flush(): string {
    // If we were in a think block that never closed, the buffered partial is
    // part of the think content — discard it. Otherwise emit it.
    const result = this._inThink ? "" : this._buf;
    this._buf = "";
    return result;
  }
}
