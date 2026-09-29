// The "claude-api" provider: talks directly to the Anthropic Messages API
// over HTTPS, using the user's own API key (BYOK — the only shippable path;
// a personal subscription used through some other means can never be
// resold, see MEMORY.md "Contraintes économiques figées"). Streaming via Bun's `fetch` +
// `ReadableStream`, no SDK dependency. Prompt assembly (fencing, system
// prompt) lives in ../model.ts and is shared by every provider — see
// ../model.ts's header.

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

// Per the claude-api skill's "Current Models" table (checked at implementation
// time, 2026-09-21): always claude-opus-5 unless the user names a different
// model — which they can, via the `model` field of `settings.set` (same slot
// ollama uses for its own model name), overriding this default.
export const CLAUDE_API_DEFAULT_MODEL = "claude-opus-5";

// A comfortable ceiling for a side-panel chat/summary reply. Streaming means
// no HTTP-timeout risk from a larger cap (see the skill's max_tokens
// guidance), but nothing here needs more than a few thousand output tokens.
const MAX_TOKENS = 8192;

// French, user-facing (sent verbatim as ErrorMessage.message — the panel
// displays it as-is), per task brief: a 401/403 names the remedy. Never
// includes the key itself.
export const CLAUDE_API_AUTH_MESSAGE = "Clé API refusée — vérifiez-la dans les réglages.";

async function isAvailable(opts: ProviderRuntimeOptions): Promise<Availability> {
  const key = opts.apiKey?.trim();
  if (!key) {
    return { available: false, reason: "no Anthropic API key configured" };
  }
  return { available: true };
}

/**
 * `provider.status` for claude-api — amendement 2026-09-25 bis / lot3 open
 * detail (c)1: presence-only. A `GET /v1/models` probe would confirm the key
 * is actually accepted, but stays OFF until a sourced amendment to
 * docs/PROTOCOL.md confirms that endpoint is never billed — a stored key is
 * reported `unknown`/`key-unverified`, never `ok`, until then.
 */
async function checkStatus(opts: ProviderRuntimeOptions): Promise<StatusCheck> {
  const key = opts.apiKey?.trim();
  if (!key) return { state: "ko", reason: "no-key" };
  return { state: "unknown", reason: "key-unverified" };
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
      throw new Error(message);
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

  const timeoutMs = opts.timeoutMs ?? MODEL_TIMEOUT_MS;
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    abortController.abort();
  }, timeoutMs);

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
          system: buildSystemPrompt(built.nonce),
          messages: [{ role: "user", content: built.prompt }],
        }),
        signal: abortController.signal,
      });
    } catch (err) {
      if (timedOut) throw new ModelTimeoutError(timeoutMs);
      // I3 (lot7 security review): this used to interpolate the raw fetch
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
      // status is used to classify the failure.
      if (response.status === 401 || response.status === 403) {
        throw new AuthRequiredError(CLAUDE_API_AUTH_MESSAGE);
      }
      if (response.status === 429 || response.status >= 500) {
        throw new ModelUnavailableError(`Anthropic API returned HTTP ${response.status}`);
      }
      throw new Error(`Anthropic API returned HTTP ${response.status}`);
    }
    if (!response.body) {
      throw new Error("Anthropic API response has no body");
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

export const claudeApiProvider: ModelProvider = {
  id: "claude-api",
  label: "Claude (clé API)",
  isAvailable,
  checkStatus,
  streamAnswer,
};
