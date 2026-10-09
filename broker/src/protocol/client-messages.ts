// Client -> broker message shapes (docs/PROTOCOL.md) and the ClientMessage
// union. Split out of protocol.ts (lot F5).

import type { ProviderId } from "../config.ts";
import type { Context } from "./context.ts";
import type { SitePrefs } from "./prompts-prefs.ts";
import type { ChatImage, ChatDocSearch, HistoryEntry, PageMeta } from "./chat.ts";

// v: 2 handshake — docs/PROTOCOL.md "Handshake `v: 2`" (amendement
// 2026-09-30, G4). `v: 1` (secret-based) no longer exists anywhere in the
// code, not even behind `legacyPairing` — see "Legacy mode".
export interface HelloMessage {
  type: "hello";
  v: 2;
  /** 64 lowercase hex chars (32 random bytes), fresh per connection. Format
   * checked here (parseClientMessage); cryptographic validity (HEX64_RE) is
   * re-checked by broker-key.ts's isHex64 before any HMAC use. */
  nonce: string;
  /** Which key the client will use for the rest of the handshake —
   * `"native"` (the broker key, via the native host) when absent, or
   * `"pasted"` (the legacy-mode permanent secret `S`). */
  key?: "native" | "pasted";
  /** Goal G6 (docs/PROTOCOL.md "Langue de la connexion"): the client's UI
   * language, raw BCP 47 (e.g. "fr", "en-US", "zh-CN") straight from
   * chrome.i18n.getUILanguage() — normalised by messages.ts's normalizeLang()
   * once, at hello time (server.ts), and kept for the life of the
   * connection. Optional; missing/unrecognised normalises to "en". */
  lang?: string;
}

/** Client's second handshake message, after verifying the broker's own
 * challenge — docs/PROTOCOL.md step 5. Never part of ClientMessage: it only
 * ever appears mid-handshake, parsed by server.ts's own
 * parseHandshakeAuthMessage, never by the general parseClientMessage used
 * for authenticated traffic. */
export interface AuthMessage {
  type: "auth";
  v: 2;
  proof: string;
}

export interface ChatMessage {
  type: "chat";
  id: string;
  text: string;
  context?: Context;
  // Amendement 2026-10-08 (lot B1). See ChatImage above.
  image?: ChatImage;
  // Amendement 2026-10-08 (lot C1). See ChatDocSearch above.
  docSearch?: ChatDocSearch;
  // Amendement 2026-10-08 (bis, "historique"). See HistoryEntry above.
  history?: HistoryEntry[];
  // Amendement 2026-10-09 (lot 7, "page on demand" — docs/PROTOCOL.md "Page
  // on demand"). Page metadata, offered instead of `context` so the model
  // reads the page only when it actually needs to. Ignored by the broker
  // whenever `context` is ALSO present (point 2 of the spec: "if chat.context
  // is present, behaviour is unchanged") — see handlers/dispatch.ts.
  page?: PageMeta;
  /** Only meaningful together with `page` above — offers the dev marker
   * (model/page-marker.ts's MARKER_DEV) when true. Absent/false means the
   * dev marker is never offered, and a model that emits it anyway gets it
   * treated as ordinary text, never a trigger (docs/PROTOCOL.md). */
  devMode?: boolean;
}

// Amendement 2026-10-09 (lot 7, "page on demand" — docs/PROTOCOL.md "Page
// on demand"). The client's answer to a `page.request`: either the page's
// content (`context`, the SAME shape a `chat` would have carried up front —
// for level "dev", `context.text` holds the cleaned HTML rather than visible
// text) or a decline (PageDeclineMessage below). `target` names the `chat`
// this answers — see docs/PROTOCOL.md's existing `target` convention
// (CancelMessage).
export interface PageContentMessage {
  type: "page.content";
  id: string;
  target: string;
  level: "text" | "dev";
  context: Context;
}

export interface PageDeclineMessage {
  type: "page.decline";
  id: string;
  target: string;
}

export interface SummarizeMessage {
  type: "summarize";
  id: string;
  context: Context;
}

// "shorten" added for the panel's selection context menu (Raccourcir) —
// see docs/PROTOCOL.md and the matching addition in model.ts's ACT_VERB.
export type ActAction = "translate" | "rewrite" | "explain" | "shorten";

export interface ActMessage {
  type: "act";
  id: string;
  action: ActAction;
  text: string;
  params?: { targetLang?: string; [key: string]: unknown };
}

export interface PromptsListMessage {
  type: "prompts.list";
  id: string;
}

/** `prompt.id` absent → create (broker assigns the id); present → update
 * title/body of that prompt (site is ignored on update — see
 * docs/PROTOCOL.md "prompts.save"). */
export interface PromptsSaveMessage {
  type: "prompts.save";
  id: string;
  prompt: { id?: string; site: string; title?: string; body: string };
}

export interface PromptsDeleteMessage {
  type: "prompts.delete";
  id: string;
  promptId: string;
}

export interface PromptsMoveMessage {
  type: "prompts.move";
  id: string;
  promptId: string;
  site: string;
  order: string[];
}

export interface PrefsGetMessage {
  type: "prefs.get";
  id: string;
}

export interface PrefsSetMessage {
  type: "prefs.set";
  id: string;
  site: string;
  prefs: SitePrefs;
}

export interface CancelMessage {
  type: "cancel";
  id: string;
  target: string;
}

// Added 2026-09-20 (3) — see docs/PROTOCOL.md's dated amendment. Lets the
// options page read and change the active model provider. Never carries a
// secret (no API key field) — see CLAUDE.md rule #1.
export interface SettingsGetMessage {
  type: "settings.get";
  id: string;
}

export interface SettingsSetMessage {
  type: "settings.set";
  id: string;
  /** Omitted fields are left unchanged server-side. */
  provider?: ProviderId;
  model?: string;
  /**
   * The user's own Anthropic API key, for the claude-api provider. WRITE-ONLY
   * — see config.ts's CoatiConfig.apiKey and CLAUDE.md rule #1: it is
   * accepted here, persisted, and never echoed back in any `settings`
   * response. An empty string means "forget the stored key". Omitted means
   * "leave the stored key unchanged", same as every other field here.
   */
  apiKey?: string;
  /**
   * Base URL of the `openai-compat` provider's server (amendement 2026-09-30
   * bis, goal G5), e.g. "http://localhost:1234/v1". NOT a secret — unlike
   * apiKey, it IS echoed back in the `settings` response (see
   * SettingsMessage.baseUrl below). An empty string means "forget the stored
   * address", same semantics as apiKey. Omitted means "leave unchanged".
   */
  baseUrl?: string;
  /**
   * Amendement 2026-10-08 (lot C1, docs/PROTOCOL.md §9). Which search engine
   * `chat.docSearch` should use — `""` means "none chosen" (forgets the
   * stored choice, same "" = forget convention as apiKey/baseUrl). Omitted
   * means "leave unchanged". Independent of `provider` above (the MODEL
   * provider).
   */
  searchProvider?: "brave" | "tavily" | "";
  /**
   * The user's own Brave/Tavily API key — WRITE-ONLY, same contract as
   * `apiKey` above (CLAUDE.md rule #1): accepted, persisted to
   * config.json's `searchKeys`, never echoed back. Bound to whichever
   * engine THIS SAME patch's `searchProvider` names, or the currently
   * configured one otherwise (mirrors apiKey/provider's own pairing). An
   * empty string forgets the stored key for that engine. Omitted means
   * "leave unchanged".
   */
  searchApiKey?: string;
  /**
   * Amendement 2026-10-08 (lot C1, EXTRA task — docs/PROTOCOL.md §9bis).
   * Forgets a stored key WITHOUT touching the active provider/model or any
   * other field in this same patch — `"claude-api"` / `"openai-compat"`
   * clear `apiKeys`, `"brave"` / `"tavily"` clear `searchKeys`; any other id
   * is a no-op (no defined key storage for it, same as setApiKey's own
   * unknown-provider case). Lets the options page clear a key for a
   * provider that ISN'T the active one — the gap `apiKey: ""` doesn't cover,
   * since `apiKey`/`searchApiKey` always bind to the *currently selected*
   * (or same-patch-selected) provider.
   */
  clearKey?: ProviderId;
}

// Added for task 3 (2026-09-21): backs the panel's "Tester la connexion"
// button — see docs/PROTOCOL.md's settings.test amendment. Amendement
// 2026-10-08 (lot C1, docs/PROTOCOL.md §9): a discriminated union on
// `target` — `"search"` tests the search feature instead of a model
// provider. Absent/`"model"` is today's shape, byte-for-byte unchanged
// ("Compatibility").
export type SettingsTestMessage =
  | { type: "settings.test"; id: string; target?: "model"; provider: ProviderId }
  | { type: "settings.test"; id: string; target: "search"; searchProvider: "brave" | "tavily" };

// Amendement 2026-09-25 — "Provider availability". Sent by the panel
// once per panel open only (never automatically, never periodically — see
// CLAUDE.md rule #5, "the gesture rule"). Takes no field beyond `id`: it
// always targets the currently active provider.
export interface ProviderStatusMessage {
  type: "provider.status";
  id: string;
}

// Amendement 2026-10-07 — "Available models list". Lists all usable
// models from every configured source, regardless of the active provider.
// Lot 2 builds the UI; this message only provides the data.
export interface ModelsListMessage {
  type: "models.list";
  id: string;
}

// Amendement 2026-10-07 (bis) — "Model warm-up". Asks the broker to
// pre-load the active Ollama model so the first request is faster. Non-Ollama
// providers reply with state:"skipped".
export interface ModelWarmupMessage {
  type: "model.warmup";
  id: string;
}

export type ClientMessage =
  | HelloMessage
  | AuthMessage
  | ChatMessage
  | SummarizeMessage
  | ActMessage
  | PromptsListMessage
  | PromptsSaveMessage
  | PromptsDeleteMessage
  | PromptsMoveMessage
  | PrefsGetMessage
  | PrefsSetMessage
  | CancelMessage
  | SettingsGetMessage
  | SettingsSetMessage
  | SettingsTestMessage
  | ProviderStatusMessage
  | ModelsListMessage
  | ModelWarmupMessage
  | PageContentMessage
  | PageDeclineMessage;
