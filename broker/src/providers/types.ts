// Shared provider contract. Every model backend (ollama, claude-api, and any
// externally loaded module — see docs/ARCHITECTURE.md, docs/DECISIONS.md T8)
// implements this so server.ts and the
// `settings.*` protocol messages never need to know which backend is active.
// Prompt assembly (fencing, the shared system prompt) stays out of here —
// that's ../model.ts, on purpose, so it cannot be duplicated per provider.

import type { AnswerEvent, BuiltPrompt, StreamAnswerOptions } from "../model.ts";
import type { ProviderStatusState } from "../protocol.ts";
import type { Lang } from "../messages.ts";

export interface Availability {
  available: boolean;
  /** Short, human-readable reason when available is false, e.g. "no Anthropic
   * API key configured" or "Ollama unreachable at http://127.0.0.1:11434".
   * Surfaced to the extension's settings UI — never hidden. */
  reason?: string;
}

/** Runtime knobs threaded in from CoatiConfig (broker/src/config.ts).
 * Providers ignore whatever they don't need — ollama ignores apiKey,
 * claude-api ignores ollamaUrl, an external module ignores both unless its
 * own `options` (docs/ARCHITECTURE.md) says otherwise. `apiKey`
 * is WRITE-ONLY end to end (see config.ts's CoatiConfig.apiKey) — it flows
 * from config into this options bag and into the Anthropic API request
 * header, and nowhere else. */
export interface ProviderRuntimeOptions {
  model?: string;
  ollamaUrl?: string;
  apiKey?: string;
  /** Base URL of an `openai-compat` server (e.g. "http://localhost:1234/v1"). NOT a secret (unlike
   * apiKey): it is echoed back in the `settings` response for the active provider. Ignored
   * by every other provider. */
  baseUrl?: string;
  /** The connection's negotiated language — used by isAvailable()
   * to localise its human-readable `reason` (Availability.reason, shown
   * verbatim by the extension's settings UI) and by streamAnswer() to
   * localise an AuthRequiredError's message (docs/PROTOCOL.md: that one
   * message IS shown to a human, unlike model-unavailable/internal). Ignored
   * by any provider (built-in or external module) that doesn't care — see
   * messages.ts's DEFAULT_LANG for the fallback when absent. */
  lang?: Lang;
}

/** One provider's answer to `provider.status` (docs/PROTOCOL.md, "Provider availability") — a cheap,
 * NEVER-BILLED probe, distinct from isAvailable() (which some providers make a real paid/model
 * call to establish, e.g. none currently do, but the contract allows it).
 * `reason` is one of each provider's own closed set of short English codes —
 * see the per-provider implementation for the exact list. */
export interface StatusCheck {
  state: ProviderStatusState;
  reason: string;
}

/** Closed set of `settings.test-result.code` values a provider's
 * `testConnection` can report on failure (docs/PROTOCOL.md) — a subset of `ErrorCode` (protocol.ts)
 * plus `model-missing`, which is NOT a general ErrorCode (it never appears on
 * a chat/summarize `error` message — those report the same underlying
 * condition as `model-unavailable`, see ollama.ts's streamAnswer) but IS
 * useful here to tell "Ollama unreachable" apart from "Ollama is up but this
 * model isn't pulled", mirroring provider.status's own `model-missing`
 * reason for ollama. */
export type TestConnectionCode =
  | "auth-required"
  | "quota-exceeded"
  | "rate-limited"
  | "model-unavailable"
  | "model-missing"
  | "provider-overloaded";

/** Result of a provider's FREE connection probe (docs/PROTOCOL.md
 * "settings.test") — unlike the old
 * streamAnswer-based probe it replaces for built-in providers, this must
 * never spend a token. `code` is only ever present when `ok` is false.
 * `creditUnchecked`: true on a
 * successful probe that cannot see the account's credit balance (every
 * built-in provider's free check — see each provider's own testConnection
 * comment) — the options page renders this as one line, never implies the
 * account has credit. */
export interface TestConnectionResult {
  ok: boolean;
  code?: TestConnectionCode;
  creditUnchecked?: boolean;
}

export interface ModelProvider {
  readonly id: string;
  readonly label: string;
  /** Cheap, side-effect-free probe: is this provider usable right now, with
   * the given runtime options? Never throws — reports unavailability via the
   * return value instead. */
  isAvailable(opts: ProviderRuntimeOptions): Promise<Availability>;
  /** Only implemented by providers that can enumerate installed models
   * (currently just ollama, via /api/tags). Used to populate the settings
   * UI's model picker. */
  listModels?(opts: ProviderRuntimeOptions): Promise<string[]>;
  /** The model this provider uses when none was ever set (docs/PROTOCOL.md). Lets `models.list`
   * still name a sensible model for a configured provider that has neither a
   * `listModels()` nor a remembered model yet — e.g. claude-api right after
   * its key is entered, before any explicit `settings.set` with a model.
   * Optional: a provider that cannot name one sensible default (most
   * modules) simply omits it, and stays `not-configured` in that case. */
  defaultModel?: string;
  /** Backs `provider.status` (see StatusCheck above). Every provider
   * implements this — unlike isAvailable(), it never makes a billed call. */
  checkStatus(opts: ProviderRuntimeOptions): Promise<StatusCheck>;
  /** Backs `settings.test` with a FREE probe (docs/PROTOCOL.md) — optional: a provider (built-in or
   * external module) that cannot offer one simply omits it, and server.ts's
   * testProviderConnection() falls back to the old streamAnswer-based probe
   * (a real minimal model call) for that provider only. Never throws —
   * reports failure via TestConnectionResult.code instead. */
  testConnection?(opts: ProviderRuntimeOptions & { timeoutMs?: number }): Promise<TestConnectionResult>;
  /**
   * (docs/PROTOCOL.md): STATIC vision
   * support, for a provider whose answer never depends on which specific
   * model is active — `true` for claude-api/claude-cli, whatever an
   * external module declares (docs/ARCHITECTURE.md's `vision`). Checked by
   * server.ts's vision gate ONLY when `supportsVision` below is absent.
   * Absent AND no `supportsVision` (a module that declares neither) is
   * treated as `false` — fail closed, per docs/ARCHITECTURE.md. A provider whose
   * vision support DOES vary by model (ollama, openai-compat) leaves this
   * absent and implements `supportsVision` instead.
   */
  vision?: boolean;
  /**
   * (docs/PROTOCOL.md): does the model
   * `opts` names right now understand an attached image? The LIVE gate
   * server.ts calls before honouring a `chat.image` — distinct from
   * `ModelEntry.vision` (protocol.ts), which is display-only, for the
   * `models` list. Returns `true`/`false` when the provider can tell (e.g.
   * ollama's `/api/show` capabilities for THIS model), `undefined` when it
   * can't (server.ts then lets the request through and relies on the
   * provider's own 400 — VisionUnsupportedError — if it turns out wrong).
   * Takes precedence over the static `vision` field above when present.
   * Never throws. */
  supportsVision?(opts: ProviderRuntimeOptions): Promise<boolean | undefined>;
  /** Streams the model's answer to `built.prompt`. Throws ModelTimeoutError
   * or ModelUnavailableError (../model.ts) for conditions server.ts should
   * report as `model-unavailable` rather than `internal`. */
  streamAnswer(
    built: BuiltPrompt,
    opts: StreamAnswerOptions & ProviderRuntimeOptions,
  ): AsyncIterable<AnswerEvent>;
}
