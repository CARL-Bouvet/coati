// Broker -> client message shapes (docs/PROTOCOL.md) and the ServerMessage
// union. Split out of protocol.ts.

import type { ProviderId } from "../config.ts";
import type { TestConnectionCode } from "../providers/types.ts";
import type { ErrorCode } from "./shared.ts";
import type { PromptEntry, SitePrefs, PrefsData } from "./prompts-prefs.ts";

export interface ChunkMessage {
  type: "chunk";
  id: string;
  delta: string;
}

export interface DoneMessage {
  type: "done";
  id: string;
  usage: { inputTokens: number; outputTokens: number };
  /**
   * ("historique" — docs/PROTOCOL.md). Number of
   * `history` entries actually included in the prompt sent to the provider
   * — may be LESS than the request's own `history.length` when the active
   * provider trimmed further for its own capacity (Ollama's context tier;
   * a char budget for every other provider — see model.ts/providers/*.ts).
   * Absent when the request carried no `history` at all (never 0 vs absent:
   * a request with a non-empty `history` that got entirely trimmed away
   * reports `historyKept: 0`, distinct from "no history was sent"). Chosen
   * over a new message type as the least invasive option: `done` is already
   * sent exactly once per request, same lifecycle as `usage`.
   */
  historyKept?: number;
  /**
   * ("page on demand" — docs/PROTOCOL.md "Page
   * on demand"). Present only when the page was actually read during this
   * request (one successful `page.content` round trip) — absent when the
   * model never asked (or a `chat.page` wasn't even offered), same
   * "absent means it never happened" convention as `historyKept`. `chars` is
   * the content's own length as received; `sentChars` is how much of it
   * actually reached the model after any dev-level fit-to-context
   * truncation (model/build.ts's devContentCharBudget); `truncated` is true
   * iff `sentChars < chars`.
   */
  page?: { level: "text" | "dev"; chars: number; sentChars: number; truncated: boolean };
  /** Present only when a search returned results (docs/PROTOCOL.md "Search"): what reached the
   * model; `capped` when a search or open marker was stripped by a limit. */
  search?: { queries: string[]; results: number; pages: number; chars: number; capped?: true };
  /** A further search the model asked for and Coati did not run, for the user to launch. */
  suggest?: { search: string };
}

export interface ErrorMessage {
  type: "error";
  id: string;
  code: ErrorCode;
  message: string;
  /** Only ever present for code "rate-limited", and only when the provider
   * sent a Retry-After header (docs/PROTOCOL.md). */
  retryAfterSec?: number;
}

export interface PromptsMessage {
  type: "prompts";
  id: string;
  items: PromptEntry[];
  /** Present only in reply to prompts.move — see docs/PROTOCOL.md. */
  prefs?: PrefsData;
}

export interface PrefsMessage {
  type: "prefs";
  id: string;
  sites: Record<string, SitePrefs>;
}

// No token, no `v: 1` — the v: 2 handshake proves
// possession of the key on each connection instead of minting anything to
// remember. See docs/PROTOCOL.md "Handshake `v: 2`".
export interface HelloOkMessage {
  type: "hello-ok";
  v: 2;
  /**
   * Open-ended capability strings this
   * broker understands on the wire — `"elements"` (context.elements), `"vision"` (chat.image) — see
   * logging.ts's BROKER_FEATURES. The extension only shows a
   * capability's UI when its word is present — absent word, or the whole
   * field absent (older broker), means "don't offer it", never an error at
   * the moment of use. Never a closed list on either side: a future word
   * needs no handshake change of its own.
   */
  features: string[];
}

/** Reported per known provider in a SettingsMessage's `available` array —
 * every provider Coati knows about is listed, including unavailable ones
 * (with `reason`), never hidden. */
export interface ProviderStatus {
  id: ProviderId;
  label: string;
  available: boolean;
  reason?: string;
  /**
   * True when this provider has what it needs to be used at all — a stored
   * API key (claude-api), a reachable daemon (ollama), whatever an external
   * module judges it needs for its own — independent of whether the
   * currently *selected* model is valid for it (that distinction is
   * `available`, above). The extension
   * shows a state, never a value: this is a boolean, never the key itself.
   */
  configured: boolean;
}

export interface SettingsMessage {
  type: "settings";
  id: string;
  provider: ProviderId;
  model?: string;
  available: ProviderStatus[];
  /** Installed model names for the currently-selected provider, when it can
   * enumerate them (currently ollama and openai-compat). Absent otherwise. */
  models?: string[];
  /** The `openai-compat` provider's configured server address, ONLY when it
   * is the currently active provider. Not a
   * secret (unlike apiKey, never included here): see config.ts's
   * CoatiConfig.baseUrl. Absent for every other provider. */
  baseUrl?: string;
  /** Every configured openai-compat service, whichever provider is active. Absent when none. */
  services?: CompatServiceInfo[];
}

/** One configured openai-compat service. `hasKey` says a key is stored for its origin; the key
 * itself is never sent. */
export interface CompatServiceInfo {
  baseUrl: string;
  model?: string;
  hasKey: boolean;
}

// Reply to a settings.test request — a FREE connection probe for the three built-in providers (an external module
// without its own free probe still falls back to a real minimal model call),
// bounded by a short timeout (see server.ts's SETTINGS_TEST_TIMEOUT_MS),
// never a chat/summarize the extension would otherwise trigger via the wire.
// `message` is localised to the connection's language, one sentence, shown
// verbatim to a human — see docs/PROTOCOL.md.
export interface SettingsTestResultMessage {
  type: "settings.test-result";
  id: string;
  provider: ProviderId;
  ok: boolean;
  message: string;
  /** Only ever present when ok is false — see providers/types.ts's
   * TestConnectionCode and docs/PROTOCOL.md "settings.test". */
  code?: TestConnectionCode;
  /** Only ever present (and true) when ok is true and the free probe cannot
   * see the account's credit balance.
   * The options page renders this as its own line. */
  creditUnchecked?: boolean;
}

// "Provider availability". `state` is the
// broker's best answer, from a never-billed check, to "will the next request
// against this provider work?" — see docs/PROTOCOL.md for the full
// per-provider reason-code table (server.ts's providerStatus.ts owns the
// actual probing). `reason` is a short, stable, English code meant for the
// panel's own logic, never shown to a human verbatim.
export type ProviderStatusState = "ok" | "ko" | "unknown";

export interface ProviderStatusResultMessage {
  type: "provider.status-result";
  id: string;
  provider: ProviderId;
  state: ProviderStatusState;
  reason: string;
  /** ISO 8601 UTC — the time of the *effective* check (for a cached answer,
   * that's the original check's time, not now). */
  checkedAt: string;
  /** openai-compat only, when configured — not a secret: lets the panel tell
   * OpenAI/Mistral/OpenRouter/DeepSeek apart. */
  baseUrl?: string;
}

// Host capacity + model fit classification.

/** Machine capacity reported in every `models` reply. Two rounded
 * numbers only — read locally, never sent to an external service. */
export interface HostCapacity {
  /** Total RAM in GB, rounded to 1 decimal (÷ 1e9). */
  ramGb: number;
  /** Dedicated VRAM in GB (AMD sysfs or nvidia-smi), or null when not
   * detectable. Always null on macOS (unified memory). */
  vramGb: number | null;
  /** Present and true on macOS — GPU shares host RAM (unified memory arch).
   * Absent on every other platform. */
  unifiedMemory?: true;
}

/** Whether a local model is expected to run on GPU, shared CPU+GPU, or is too
 * large for the machine. Absent for non-local (remote) models. */
export type ModelFit = "gpu" | "shared" | "too-big";

/** One model entry in a `models` response. */
export interface ModelEntry {
  provider: ProviderId;
  model: string;
  local: boolean;
  /** Byte size of the model weights, when available (Ollama /api/tags). */
  sizeBytes?: number;
  /**
   * Present and true for Ollama thinking models that cannot disable thinking
   * (think:false is ineffective — template has no `not $.Think` branch).
   * The broker uses think:true for these; reasoning stays in message.thinking,
   * message.content is clean. UI label: "thinks before answering, slower".
   * Absent (undefined) for all other models.
   */
  thinks?: true;
  /** GPU fit classification for local Ollama models (see host.ts's
   * computeFit). Absent when sizeBytes is unknown or the model is remote. */
  fit?: ModelFit;
  /** Fraction of the model currently loaded on the GPU (0–100), from
   * Ollama /api/ps. Present only while the model is loaded; absent otherwise.
   * Example: 70 means 70 % of weights are in VRAM, rest spills to RAM. */
  gpuPercent?: number;
  /** Chosen context window size in tokens for this
   * Ollama model, computed from /api/show model_info and host VRAM capacity.
   * Present only for Ollama entries when the info is available. */
  contextTokens?: number;
  /**
   * (docs/PROTOCOL.md §4): true/false/absent
   * (unknown) — whether this specific model understands an attached image,
   * for the `models` list / settings UI only (lets the panel grey out the
   * "Attach screen" checkbox ahead of time). `true`/`false` for ollama
   * (from /api/show's `capabilities`) and for openai-compat when the source
   * can tell (OpenRouter's `architecture.input_modalities`, LM Studio's
   * `type: "vlm"`); always `true` for claude-api and claude-cli; absent for
   * openai-compat when the source can't tell, and for most external
   * modules. NOT the live gate for an actual `chat.image` request — that's
   * each provider's own `supportsVision?` (providers/types.ts), called
   * against the model that's actually about to answer.
   */
  vision?: boolean;
}

/** Per-source availability in a `models` response. */
export interface ModelSource {
  provider: string;
  state: "ok" | "unreachable" | "not-configured";
}

/** Reply to `models.list`. */
export interface ModelsMessage {
  type: "models";
  id: string;
  current: { provider: ProviderId; model: string | undefined };
  entries: ModelEntry[];
  sources: ModelSource[];
  /** Machine capacity. null when host.ts fails. */
  host: HostCapacity | null;
}

// Result of a `model.warmup` request.
export interface ModelWarmupResultMessage {
  type: "model.warmup-result";
  id: string;
  /** `"loaded"` (warmup succeeded, `ms` present), `"already"` (model was
   * already loaded in Ollama), `"skipped"` (non-Ollama provider),
   * `"failed"` (Ollama unreachable or error). */
  state: "loaded" | "already" | "skipped" | "failed";
  /** Wall-clock milliseconds for the load, only when state === "loaded". */
  ms?: number;
}

// Progress notification sent before the first
// chunk of a summarize/chat response, Ollama provider only.
export interface ProgressMessage {
  type: "progress";
  id: string;
  /**
   * `"loading"` (model not yet in memory), `"reading"` (loaded, generating),
   * `"thinking"` (thinking-only model actively reasoning — message.thinking
   * deltas are arriving but no content yet; sent at most once per request,
   * before any chunk).
   */
  stage: "loading" | "reading" | "thinking";
}

// "page on demand" — docs/PROTOCOL.md "Page
// on demand". Sent when the streamed answer's own text matched one of the
// two markers (model/page-marker.ts) — `id` is the ORIGINATING `chat`'s own
// id, never a fresh one (so the client correlates it to the request it's
// already displaying), mirroring CancelMessage's `target` convention in
// spirit though this message IS itself the chat's id, not a reference to
// it. `discard: true` only when the marker appeared mid-answer (text was
// already shown and must be cleared) — absent (never `false`) when it was
// the very first thing the answer would have shown.
export interface PageRequestMessage {
  type: "page.request";
  id: string;
  level: "text" | "dev";
  discard?: true;
}

// The model asked to open search results (docs/PROTOCOL.md "Search"); `n` is the
// broker's S<n> number, `url` the one the client reported for it.
export interface OpenRequestMessage {
  type: "open.request";
  id: string;
  refs: { n: number; url: string }[];
  discard?: true;
}

// The model asked to search the web (docs/PROTOCOL.md "Search"); same `id` and
// `discard` conventions as PageRequestMessage.
export interface SearchRequestMessage {
  type: "search.request";
  id: string;
  query: string;
  discard?: true;
}

// Broker's step-3 challenge in the v: 2 handshake — docs/PROTOCOL.md. Never
// part of the general message() dispatch: server.ts's handshake state
// machine sends this directly, before the connection is authed.
export interface ChallengeMessage {
  type: "challenge";
  v: 2;
  nonce: string;
  proof: string;
}

export type ServerMessage =
  | ChunkMessage
  | DoneMessage
  | ErrorMessage
  | PromptsMessage
  | PrefsMessage
  | HelloOkMessage
  | ChallengeMessage
  | SettingsMessage
  | SettingsTestResultMessage
  | ProviderStatusResultMessage
  | ModelsMessage
  | ModelWarmupResultMessage
  | ProgressMessage
  | PageRequestMessage
  | SearchRequestMessage
  | OpenRequestMessage;
