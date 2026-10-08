// TypeScript types and parser for every message defined in docs/PROTOCOL.md.
// The 256 KB per-message cap is enforced here, at parse time.

import { isProviderId, type ProviderId } from "./config.ts";
import type { Lang } from "./messages.ts";
import type { TestConnectionCode } from "./providers/types.ts";

export const MAX_MESSAGE_BYTES = 256 * 1024;

// Amendement 2026-10-08 (lot B1, "Regarder l'écran" — docs/PROTOCOL.md §5).
// Only a `chat` message carrying a well-formed-looking `image` field may
// exceed MAX_MESSAGE_BYTES, up to this cap. A decoded 1 MiB JPEG/PNG inflates
// to ~1.37 MiB as base64 text; 1.5 MiB leaves room for the rest of the
// envelope (text, context, JSON framing).
export const MAX_IMAGE_MESSAGE_BYTES = 1.5 * 1024 * 1024;

export type ErrorCode =
  | "bad-request"
  | "unauthorized"
  | "model-unavailable"
  | "auth-required"
  | "quota-exceeded"
  | "rate-limited"
  | "model-missing"
  | "provider-overloaded"
  | "context-too-large"
  | "cancelled"
  | "model-stalled"
  // Amendement 2026-10-08 (lot B1): the active model has no vision, or the
  // provider's own 400 names the image as the problem while vision was
  // unknown — see docs/PROTOCOL.md §4.
  | "vision-unsupported"
  // Amendement 2026-10-08 (lot C1, "Consulter la doc officielle" —
  // docs/PROTOCOL.md §8): `chat.docSearch` present but no search provider
  // configured, vs. configured-but-failed (see ErrorMessage.reason below).
  | "search-not-configured"
  | "search-unavailable"
  | "internal";

// "selection" removed (KISS audit 2026-09-26, item H): grep-confirmed nothing
// in the extension ever built a Context with that kind.
export type ContextKind = "page" | "youtube";

// Amendement 2026-09-25 (types de page). Only meaningful when kind === "page"
// — see docs/PROTOCOL.md "Types de page, faits et entrées". Anything outside
// these four literals is not a PageKind: parseContext below drops it, and the
// broker then behaves exactly as it did before this amendment ("other").
export type PageKind = "list" | "listing" | "article" | "other";

// A "libellé : valeur" pair read verbatim off the page (context.facts). Only
// carried when pageKind === "listing" — see "Compatibilité".
export interface Fact {
  label: string;
  value: string;
}

// One entry of a results page (context.items). Only carried when
// pageKind === "list" — see "Compatibilité". `title` is the only required
// field; a malformed/absent one drops the whole entry (parseItem below).
export interface Item {
  title: string;
  price?: string;
  location?: string;
  detail?: string;
}

// Amendement 2026-10-08 (lot A1, "Montrer du doigt"). One interactive element
// the content script numbered on the page — see docs/PROTOCOL.md §2.2. Only
// carried when kind === "page", INDEPENDENT of pageKind (unlike facts/items,
// which require a specific pageKind) — present or not regardless of
// list/listing/article/other.
export interface Element {
  ref: string;
  role: ElementRole;
  label: string;
}

export interface Context {
  kind: ContextKind;
  url?: string;
  title?: string;
  text?: string;
  videoId?: string;

  // Amendement 2026-09-25 (types de page). Optional, page-controlled data —
  // same trust level as `text` (CLAUDE.md rule #3). See model.ts's
  // renderContext for how they're fenced, and server.ts's
  // contextBudgetError for the numeric caps ("Limites côté broker").
  pageKind?: PageKind;
  facts?: Fact[];
  items?: Item[];
  // Amendement 2026-10-08 (lot A1). See Element above.
  elements?: Element[];
}

// Amendement 2026-09-25 (types de page) — "Faits", "Entrées", "Budget de
// taille". These are the contract's numeric bounds: parseContext below only
// enforces *shape* (drops a malformed field/element, never rejects the whole
// message — "Compatibilité"); a numeric breach is refused outright by
// server.ts's contextBudgetError, never silently truncated here ("Limites
// côté broker": the broker refuses, it never truncates).
export const FACTS_MAX = 40;
export const FACT_LABEL_MAX = 60;
export const FACT_VALUE_MAX = 160;
export const ITEMS_MAX = 40;
export const ITEM_TITLE_MAX = 160;
export const ITEM_PRICE_MAX = 40;
export const ITEM_LOCATION_MAX = 80;
export const ITEM_DETAIL_MAX = 200;

// Amendement 2026-10-08 (lot A1, "Montrer du doigt" — docs/PROTOCOL.md §2.2).
// Same shape/numeric split as facts/items above: parseElement below only
// enforces SHAPE (a malformed element is dropped whole, others kept — no
// closed-list role, no ^e[1-9][0-9]{0,2}$ ref, no non-empty label means "not
// an Element"); the numeric bounds (count, label length) are a contract
// checked by server.ts's contextBudgetError, refused outright, never
// truncated — same "the broker refuses, it never truncates" stance.
export const ELEMENTS_MAX = 120;
export const ELEMENT_LABEL_MAX = 80;
export const ELEMENT_REF_RE = /^e[1-9][0-9]{0,2}$/;
// Closed list (docs/PROTOCOL.md §2.2) — an unknown role is not an ElementRole;
// parseElement drops the whole element, it never widens this list silently.
export const ELEMENT_ROLES = [
  "button",
  "link",
  "textbox",
  "checkbox",
  "radio",
  "combobox",
  "menuitem",
  "tab",
  "option",
  "switch",
] as const;
export type ElementRole = (typeof ELEMENT_ROLES)[number];

// Amendement 2026-09-28 (« Mes prompts par site » — docs/DECISIONS.md T41).
// Replaces the flat `{ name, body }` shape. `id` is assigned by the broker,
// never by the client (see PromptsSaveMessage). See docs/PROTOCOL.md
// "Bibliothèque de prompts et préférences par site" for the full contract.
export interface PromptEntry {
  id: string;
  site: string;
  title?: string;
  body: string;
}

export const PROMPT_ID_PREFIX = "p_";
export const PROMPT_ID_RE = /^p_[0-9a-f]{12}$/;
export const POPULAR_SITE_KEY_RE = /^@[a-z0-9-]{1,40}$/;
export const USER_SITE_KEY_RE = /^[a-z0-9.-]{1,253}$/;
export const SUGGESTION_ID_RE = /^coati:[a-z0-9-]{1,40}:[a-z0-9-]{1,40}$/;

export const PROMPT_TITLE_MAX = 120;
export const PROMPT_BODY_MAX = 8000;
export const PREFS_ORDER_MAX = 200;
export const PREFS_SITES_MAX = 500;

/** `"*"` (all sites), a popular-site key (`@youtube`…), or a user site key
 * (lower-case hostname, `www.` already stripped by the caller). Never used
 * to build a file path — see docs/PROTOCOL.md. */
export function isValidSiteKey(v: unknown): v is string {
  if (typeof v !== "string") return false;
  if (v === "*") return true;
  if (POPULAR_SITE_KEY_RE.test(v)) return true;
  if (v.startsWith("www.")) return false;
  return USER_SITE_KEY_RE.test(v);
}

/** An item of `order`/`removed`: a prompt id or a Coati suggestion id. */
export function isValidOrderItem(v: unknown): v is string {
  return typeof v === "string" && (PROMPT_ID_RE.test(v) || SUGGESTION_ID_RE.test(v));
}

export function isValidPromptId(v: unknown): v is string {
  return typeof v === "string" && PROMPT_ID_RE.test(v);
}

/** One site's slice of prefs.json: which order the panel/page shows items
 * in, and which Coati suggestions the user removed from that site. Both
 * optional and independent — see docs/PROTOCOL.md "prefs.get / prefs.set". */
export interface SitePrefs {
  order?: string[];
  removed?: string[];
}

export interface PrefsData {
  sites: Record<string, SitePrefs>;
}

// v: 2 handshake — docs/PROTOCOL.md "Poignée de main `v: 2`" (amendement
// 2026-09-30, G4). `v: 1` (secret-based) no longer exists anywhere in the
// code, not even behind `legacyPairing` — see "Mode hérité".
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

// Amendement 2026-10-08 (lot B1, "Regarder l'écran" — docs/PROTOCOL.md §3).
// Closed media type list, checked against the decoded bytes' own magic
// number below (parseChatImage) — never trusted from `mediaType` alone.
export const IMAGE_MEDIA_TYPES = ["image/jpeg", "image/png"] as const;
export type ImageMediaType = (typeof IMAGE_MEDIA_TYPES)[number];

export const IMAGE_MAX_DECODED_BYTES = 1024 * 1024; // 1 MiB, decoded
export const IMAGE_MAX_SIDE = 2000;

/** One screenshot attached to a `chat` (docs/PROTOCOL.md §3). `data` is
 * base64; width/height are the client's own claim, NOT re-verified against
 * the decoded pixels (no image-decoding dependency added, consistent with
 * this project's zero-dependency broker) — a lie here only mislabels an
 * already-bounded (≤ 1 MiB) blob, it opens no hole. */
export interface ChatImage {
  mediaType: ImageMediaType;
  data: string;
  width: number;
  height: number;
}

// Amendement 2026-10-08 (lot C1, "Consulter la doc officielle" —
// docs/PROTOCOL.md §6). Origin ONLY — scheme + host + optional port, never a
// path or query string (same reasoning as Context.url staying free-form
// while this one is deliberately narrow: the broker turns this into a
// documentation-site GUESS, docs/PROTOCOL.md "Découverte" — a path would add
// nothing to that and only widen what a page can make the broker fetch).
//
// Amendement 2026-10-08 (bis, "recherche sur demande explicite" — there is
// no more "Chercher dans la doc" button). Meaning changed: this no longer
// REQUESTS a search — it only means "search is ALLOWED for this origin",
// sent by the panel on every `chat` whose tab is http(s) (never on a
// chrome://, file:// or extension page). Whether a search actually runs is
// decided by the broker ALONE, from the message's own TEXT (search/intent.ts
// — fr/en/zh explicit phrases: "cherche dans la doc", "search the docs",
// 搜索…文档, etc.). Absent entirely on a non-http(s) tab; a search can still
// run in that case (unscoped, open web) if the text itself asks for one.
export interface ChatDocSearch {
  origin: string;
}

// Amendement 2026-10-08 (bis, "historique" — docs/PROTOCOL.md). One past
// turn of the conversation shown in the panel. `text` only — never a past
// page context, screenshot or source: those attach to the CURRENT turn
// only (ChatMessage.context/image/docSearch above), never replayed. Closed
// role set: a role string outside {"user","assistant"} isn't a HistoryEntry,
// same shape-tolerance stance as Element/ChatImage ("Compatibilité").
export type HistoryRole = "user" | "assistant";
export interface HistoryEntry {
  role: HistoryRole;
  text: string;
}

// HISTORY_MAX_ENTRIES caps the wire array as a hard backstop — the panel
// itself caps at 10 exchanges (20 entries) BEFORE ever sending (see
// extension/panel/history.js), so this only ever matters for a future/other
// client that sends more. HISTORY_ENTRY_TEXT_MAX bounds one entry's `text`;
// an entry over this length is DROPPED (not truncated — "le broker refuse,
// il ne tronque pas" doesn't apply to a tolerant-drop field like this one,
// same stance as a malformed Element), not a bad-request for the whole
// message. Both counted toward the message's existing MAX_MESSAGE_BYTES
// cap (part of the same JSON payload), no separate size cap of their own.
export const HISTORY_MAX_ENTRIES = 20;
export const HISTORY_ENTRY_TEXT_MAX = 8000;

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
// ("Compatibilité").
export type SettingsTestMessage =
  | { type: "settings.test"; id: string; target?: "model"; provider: ProviderId }
  | { type: "settings.test"; id: string; target: "search"; searchProvider: "brave" | "tavily" };

// Amendement 2026-09-25 — "Disponibilité du fournisseur". Sent by the panel
// once per panel open only (never automatically, never periodically — see
// CLAUDE.md rule #5, "la règle du geste"). Takes no field beyond `id`: it
// always targets the currently active provider.
export interface ProviderStatusMessage {
  type: "provider.status";
  id: string;
}

// Amendement 2026-10-07 — "Liste des modèles disponibles". Lists all usable
// models from every configured source, regardless of the active provider.
// Lot 2 builds the UI; this message only provides the data.
export interface ModelsListMessage {
  type: "models.list";
  id: string;
}

// Amendement 2026-10-07 (bis) — "Préchauffage du modèle". Asks the broker to
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
  | ModelWarmupMessage;

// --- Server -> client messages ---

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
   * Amendement 2026-10-08 (bis, "historique" — docs/PROTOCOL.md). Number of
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
}

export interface ErrorMessage {
  type: "error";
  id: string;
  code: ErrorCode;
  message: string;
  /** Only ever present for code "rate-limited", and only when the provider
   * sent a Retry-After header (docs/PROTOCOL.md, amendement 2026-10-01). */
  retryAfterSec?: number;
  /** Only ever present for code "search-unavailable" (docs/PROTOCOL.md §8,
   * lot C1) — "auth" (invalid key), "quota" (free quota exhausted), "rate"
   * (too many requests), "network" (search service or doc page
   * unreachable), "no-result" (nothing found, even without a domain
   * filter). A stable English code, not shown to a human verbatim — same
   * contract as ProviderStatusResultMessage.reason. */
  reason?: "auth" | "quota" | "rate" | "network" | "no-result";
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

// Amendement 2026-09-30 (G4): no token, no `v: 1` — the v: 2 handshake proves
// possession of the key on each connection instead of minting anything to
// remember. See docs/PROTOCOL.md "Poignée de main `v: 2`".
export interface HelloOkMessage {
  type: "hello-ok";
  v: 2;
  /**
   * Amendement 2026-10-08 (lot 0): open-ended capability strings this
   * broker understands on the wire — `"elements"` (context.elements,
   * lot A1), `"vision"` (chat.image, lot B1), `"docsearch"` (chat.docSearch,
   * lot C1 — see server.ts's BROKER_FEATURES, all three sent by this build).
   * The extension only shows a
   * capability's UI when its word is present — absent word, or the whole
   * field absent (older broker), means "don't offer it", never an error at
   * the moment of use. Never a closed list on either side: a future word
   * needs no handshake amendment of its own.
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
   * is the currently active provider — amendement 2026-09-30 bis. Not a
   * secret (unlike apiKey, never included here): see config.ts's
   * CoatiConfig.baseUrl. Absent for every other provider. */
  baseUrl?: string;
  /**
   * Amendement 2026-10-08 (lot C1, docs/PROTOCOL.md §9) — same `configured`
   * semantics as ProviderStatus.configured (a key is present, never the key
   * itself). `provider: null` when none is chosen (searchProvider unset or
   * "").
   */
  search: { provider: "brave" | "tavily" | null; configured: boolean };
}

// Reply to a settings.test request — a FREE connection probe as of amendement
// 2026-10-01 (goal U2) for the three built-in providers (an external module
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
   * see the account's credit balance — amendement 2026-10-02, goal-j2FJ-kI7.
   * The options page renders this as its own line. */
  creditUnchecked?: boolean;
}

// Amendement 2026-09-25 — "Disponibilité du fournisseur". `state` is the
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
  /** openai-compat only, when configured — not a secret (amendement
   * 2026-10-02 ter): lets the panel tell OpenAI/Mistral/OpenRouter/DeepSeek apart. */
  baseUrl?: string;
}

// Lot 4 (2026-10-07): host capacity + model fit classification.

/** Machine capacity reported in every `models` reply (lot 4). Two rounded
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

/** One model entry in a `models` response — amendement 2026-10-07. */
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
   * message.content is clean. UI label: "réfléchit avant de répondre, plus lent".
   * Absent (undefined) for all other models.
   */
  thinks?: true;
  /** Lot 4: GPU fit classification for local Ollama models (see host.ts's
   * computeFit). Absent when sizeBytes is unknown or the model is remote. */
  fit?: ModelFit;
  /** Lot 4: fraction of the model currently loaded on the GPU (0–100), from
   * Ollama /api/ps. Present only while the model is loaded; absent otherwise.
   * Example: 70 means 70 % of weights are in VRAM, rest spills to RAM. */
  gpuPercent?: number;
  /** Amendement 2026-10-07 (bis): chosen context window size in tokens for this
   * Ollama model, computed from /api/show model_info and host VRAM capacity.
   * Present only for Ollama entries when the info is available. */
  contextTokens?: number;
  /**
   * Amendement 2026-10-08 (lot B1, docs/PROTOCOL.md §4): true/false/absent
   * (unknown) — whether this specific model understands an attached image,
   * for the `models` list / settings UI only (lets the panel grey out the
   * "Joindre l'écran" checkbox ahead of time). `true`/`false` for ollama
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

/** Per-source availability in a `models` response — amendement 2026-10-07. */
export interface ModelSource {
  provider: string;
  state: "ok" | "unreachable" | "not-configured";
}

/** Reply to `models.list` (amendement 2026-10-07, lot 4). */
export interface ModelsMessage {
  type: "models";
  id: string;
  current: { provider: ProviderId; model: string | undefined };
  entries: ModelEntry[];
  sources: ModelSource[];
  /** Machine capacity (lot 4). null only before lot 4 or when host.ts fails. */
  host: HostCapacity | null;
}

// Amendement 2026-10-07 (bis) — result of a `model.warmup` request.
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

// Amendement 2026-10-07 (bis) — progress notification sent before the first
// chunk of a summarize/chat response, Ollama provider only.
export interface ProgressMessage {
  type: "progress";
  id: string;
  /**
   * `"loading"` (model not yet in memory), `"reading"` (loaded, generating),
   * `"thinking"` (thinking-only model actively reasoning — message.thinking
   * deltas are arriving but no content yet; sent at most once per request,
   * before any chunk; amendement 2026-10-07 bis).
   */
  stage: "loading" | "reading" | "thinking";
}

// Amendement 2026-10-08 (lot C1, "Consulter la doc officielle" —
// docs/PROTOCOL.md §7). Sent before the first `chunk` of a `chat.docSearch`
// request, like `progress`. `scope: null` means "repli sur le web" (no doc
// domain found for this site) — not an error, the search still runs, just
// unscoped. `sources` only ever present at stage "reading" — the final list
// of pages actually read (≤ 3), numbered exactly as the model's own [S1]…
// citations (model.ts's renderSources). A client that doesn't know this
// message type ignores it, same as `progress` (docs/PROTOCOL.md).
// Amendement 2026-10-08 (bis, "recherche sur demande explicite" — see
// docs/PROTOCOL.md 2026-10-08 amendment): stage "query" is sent once, BEFORE
// "discovering", only when the search was triggered by detected intent — the
// reformulated (or fallback) search query text, so the panel can render
// "Recherche : <query>" instead of a bare spinner. `scope` is always `null`
// at this stage (nothing filtered yet).
export interface SearchStatusMessage {
  type: "search.status";
  id: string;
  stage: "query" | "discovering" | "searching" | "reading";
  scope: string | null;
  engine?: "brave" | "tavily" | "llms.txt";
  sources?: Array<{ n: number; url: string; title: string }>;
  /** Present only at stage "query". */
  query?: string;
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
  | SearchStatusMessage;

// --- Parsing ---

export interface ParseError {
  code: ErrorCode;
  message: string;
  /** Present only if we could recover an id from the raw payload. */
  id?: string;
  /**
   * Amendement 2026-10-08 (lot B1, docs/PROTOCOL.md §5): true only for the
   * two-tier oversized-message rejection — server.ts uses this to also
   * close(1009), same policy as the raw-byte-length gate this generalises
   * (a message over MAX_MESSAGE_BYTES that isn't a legitimate chat+image,
   * or anything over MAX_IMAGE_MESSAGE_BYTES regardless of content).
   */
  oversized?: boolean;
}

export type ParseResult =
  | { ok: true; message: ClientMessage }
  | { ok: false; error: ParseError };

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function isNonEmptyString(v: unknown): v is string {
  return typeof v === "string" && v.length > 0;
}

// I3 (lot7 security review): bounds an apiKey before it's ever persisted or
// used in an HTTP header. Printable ASCII (0x21-0x7e — excludes space and
// every control character, including newlines), no upper bound the real key
// shapes come close to (Anthropic keys are well under 200 chars); generous
// on purpose so a legitimate key format change never breaks this. Exported
// for tests.
const API_KEY_MAX_LEN = 512;
const API_KEY_RE = /^[\x21-\x7e]+$/;
export function isValidApiKeyFormat(value: string): boolean {
  return value.length <= API_KEY_MAX_LEN && API_KEY_RE.test(value);
}

// Amendement 2026-09-30 bis (goal G5): the openai-compat provider's `baseUrl`
// is validated HERE, at settings.set parse time — not deep inside
// providers/openai-compat.ts's streamAnswer — so the user gets an immediate
// bad-request rather than a silently-stored, unusable address. Security rule
// (docs/PROTOCOL.md "Fournisseur de modèle"): `https://` unconditionally, or
// `http://` restricted to loopback only (localhost/127.0.0.1/[::1]) — a
// non-loopback `http://` would send the API key in clear text over the
// network. Not exhaustively re-validated by openai-compat.ts's own runtime
// checks (belt and braces) — see that file's own isAllowedBaseUrl, which
// covers baseUrl values that reach it from anywhere else (e.g. a hand-edited
// config.json bypassing this parser).
const BASE_URL_MAX_LEN = 512;
// URL.hostname keeps the brackets for a literal IPv6 address ("[::1]", not
// "::1") — verified against Bun/WHATWG URL behaviour.
const LOOPBACK_HOSTNAMES = new Set(["localhost", "127.0.0.1", "[::1]"]);
export function isValidBaseUrl(value: string): boolean {
  if (value.length === 0 || value.length > BASE_URL_MAX_LEN) return false;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  if (url.protocol === "https:") return true;
  if (url.protocol === "http:") return LOOPBACK_HOSTNAMES.has(url.hostname);
  return false;
}

// Amendement 2026-10-08 (lot C1, docs/PROTOCOL.md §6): `chat.docSearch.origin`
// must be an ORIGIN — scheme + host + optional port, nothing else. Checked
// by round-tripping through URL and comparing `.origin` back to the input
// verbatim: a value carrying a path/query/fragment, or anything `new URL`
// can't parse, fails this (e.g. "https://a.b/x" has origin "https://a.b",
// which does not equal the input).
const ORIGIN_MAX_LEN = 512;
export function isValidOrigin(value: unknown): value is string {
  if (typeof value !== "string" || value.length === 0 || value.length > ORIGIN_MAX_LEN) return false;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return false;
  return url.origin === value;
}

function isPageKind(v: unknown): v is PageKind {
  return v === "list" || v === "listing" || v === "article" || v === "other";
}

// A single facts[] element: kept only if both fields are strings — see
// "Compatibilité": "label ou value non chaîne" drops the element, others
// stay. No length/emptiness check here — that's a numeric bound, see
// FACT_LABEL_MAX/FACT_VALUE_MAX above and server.ts's contextBudgetError.
function parseFact(v: unknown): Fact | undefined {
  if (!isRecord(v)) return undefined;
  if (typeof v.label !== "string" || typeof v.value !== "string") return undefined;
  return { label: v.label, value: v.value };
}

function parseFacts(v: unknown): Fact[] | undefined {
  if (!Array.isArray(v)) return undefined;
  return v.map(parseFact).filter((f): f is Fact => f !== undefined);
}

// A single items[] element. `title` absent/non-string/empty drops the whole
// entry — "Entrées": "une entrée sans titre non vide est écartée". Each
// optional field is dropped on its own (not the whole entry) when present
// but not a string — "Compatibilité": "champ optionnel non chaîne".
function parseItem(v: unknown): Item | undefined {
  if (!isRecord(v)) return undefined;
  if (typeof v.title !== "string" || v.title.length === 0) return undefined;
  const item: Item = { title: v.title };
  if (typeof v.price === "string") item.price = v.price;
  if (typeof v.location === "string") item.location = v.location;
  if (typeof v.detail === "string") item.detail = v.detail;
  return item;
}

function parseItems(v: unknown): Item[] | undefined {
  if (!Array.isArray(v)) return undefined;
  return v.map(parseItem).filter((i): i is Item => i !== undefined);
}

function isElementRole(v: unknown): v is ElementRole {
  return typeof v === "string" && (ELEMENT_ROLES as readonly string[]).includes(v);
}

// A single elements[] entry. Unlike items' optional fields (dropped alone),
// here EVERY field is required for identity — ref/role/label all wrong-shape
// drops the WHOLE element, same as an item with no title — docs/PROTOCOL.md
// §2.2: "Élément dont `ref` ne matche pas la forme, dont `role` est inconnu,
// ou dont `label` n'est pas une chaîne non vide : écarté en entier." No
// length/count check here — that's ELEMENT_LABEL_MAX/ELEMENTS_MAX, enforced
// as a numeric contract by server.ts's contextBudgetError, never here.
function parseElement(v: unknown): Element | undefined {
  if (!isRecord(v)) return undefined;
  if (typeof v.ref !== "string" || !ELEMENT_REF_RE.test(v.ref)) return undefined;
  if (!isElementRole(v.role)) return undefined;
  if (typeof v.label !== "string" || v.label.length === 0) return undefined;
  return { ref: v.ref, role: v.role, label: v.label };
}

function parseElements(v: unknown): Element[] | undefined {
  if (!Array.isArray(v)) return undefined;
  return v.map(parseElement).filter((e): e is Element => e !== undefined);
}

// Amendement 2026-10-08 (lot B1) — docs/PROTOCOL.md §3. Magic numbers,
// checked against the DECODED bytes, never trusted from `mediaType` alone —
// a mismatch (e.g. a PNG declared "image/jpeg") drops the field exactly like
// every other check here.
const JPEG_MAGIC = [0xff, 0xd8, 0xff];
const PNG_MAGIC = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

function hasMagicBytes(bytes: Uint8Array, magic: number[]): boolean {
  if (bytes.length < magic.length) return false;
  for (let i = 0; i < magic.length; i++) {
    if (bytes[i] !== magic[i]) return false;
  }
  return true;
}

function isPositiveInt(v: unknown): v is number {
  return typeof v === "number" && Number.isInteger(v) && v > 0;
}

/**
 * Validates `chat.image` end to end (docs/PROTOCOL.md §3): closed media
 * type, base64 decodable, magic bytes matching the declared type, decoded
 * size ≤ IMAGE_MAX_DECODED_BYTES, both sides ≤ IMAGE_MAX_SIDE. A field that
 * fails ANY check is dropped — never a bad-request: a chat that mis-attached
 * a screenshot just loses vision for that one question, the text still goes
 * through (same shape-tolerance stance as every other optional Context
 * field — "Compatibilité").
 */
function parseChatImage(v: unknown): ChatImage | undefined {
  if (!isRecord(v)) return undefined;
  const mediaType = v.mediaType;
  if (mediaType !== "image/jpeg" && mediaType !== "image/png") return undefined;
  if (typeof v.data !== "string" || v.data.length === 0) return undefined;
  if (!isPositiveInt(v.width) || v.width > IMAGE_MAX_SIDE) return undefined;
  if (!isPositiveInt(v.height) || v.height > IMAGE_MAX_SIDE) return undefined;

  let decoded: Buffer;
  try {
    decoded = Buffer.from(v.data, "base64");
  } catch {
    return undefined;
  }
  if (decoded.length === 0 || decoded.length > IMAGE_MAX_DECODED_BYTES) return undefined;

  const magic = mediaType === "image/jpeg" ? JPEG_MAGIC : PNG_MAGIC;
  if (!hasMagicBytes(decoded, magic)) return undefined;

  // Security review (L5): forward the CANONICAL re-encoding of the bytes we
  // actually validated, never the client's own raw `data` string. Node's
  // `Buffer.from(str, "base64")` tolerantly accepts whitespace, missing
  // padding, and the URL-safe alphabet (-, _) — a provider or downstream
  // decoder with a stricter base64 parser could reject or MISINTERPRET the
  // raw string differently than the bytes this function just magic-byte
  // checked, a decode-confusion gap. Re-encoding closes it: what gets sent
  // on is byte-for-byte what was validated, in standard base64.
  return { mediaType, data: decoded.toString("base64"), width: v.width, height: v.height };
}

/**
 * Validates `chat.docSearch` (docs/PROTOCOL.md §6). A malformed/invalid
 * value is DROPPED, never a bad-request — same tolerance as `image`: a chat
 * that mis-sent it just loses the doc-search capability for that one
 * question, the text still goes through.
 */
function parseChatDocSearch(v: unknown): ChatDocSearch | undefined {
  if (!isRecord(v)) return undefined;
  if (!isValidOrigin(v.origin)) return undefined;
  return { origin: v.origin };
}

/**
 * Validates `chat.history` (docs/PROTOCOL.md, amendement 2026-10-08 bis).
 * Per-entry tolerant: an entry whose `role` isn't exactly "user"/"assistant",
 * or whose `text` isn't a non-empty string ≤ HISTORY_ENTRY_TEXT_MAX, is
 * dropped — the other entries are kept, same "Compatibilité" stance as
 * parseElement. Any field beyond `role`/`text` is dropped (closed shape).
 * More than HISTORY_MAX_ENTRIES survive validation: only the LAST
 * HISTORY_MAX_ENTRIES are kept (oldest dropped first — the caller sends
 * oldest-to-newest) rather than a bad-request; the panel itself never sends
 * more than this in the first place. An empty or fully-invalid array returns
 * undefined (adds nothing), same as `elements`.
 */
function parseHistory(v: unknown): HistoryEntry[] | undefined {
  if (!Array.isArray(v)) return undefined;
  const entries: HistoryEntry[] = [];
  for (const el of v) {
    if (!isRecord(el)) continue;
    if (el.role !== "user" && el.role !== "assistant") continue;
    if (typeof el.text !== "string" || el.text.length === 0 || el.text.length > HISTORY_ENTRY_TEXT_MAX) continue;
    entries.push({ role: el.role, text: el.text });
  }
  if (entries.length === 0) return undefined;
  return entries.length > HISTORY_MAX_ENTRIES ? entries.slice(entries.length - HISTORY_MAX_ENTRIES) : entries;
}

/**
 * Cheap shape test for "does this JSON object look like a chat carrying an
 * image?" — used by the oversized-message gate (parseClientMessage) BEFORE
 * full validation (parseChatImage), so a frame between MAX_MESSAGE_BYTES and
 * MAX_IMAGE_MESSAGE_BYTES that is obviously not a legitimate chat+image can
 * still be refused with the exact pre-amendment message/id, without paying
 * for base64 decode + magic-byte checks on a payload we're about to reject
 * anyway.
 */
function looksLikeChatWithImage(parsed: unknown): boolean {
  return isRecord(parsed) && parsed.type === "chat" && isRecord(parsed.image);
}

function parseContext(v: unknown): Context | undefined {
  if (v === undefined) return undefined;
  if (!isRecord(v)) return undefined;
  const kind = v.kind;
  if (kind !== "page" && kind !== "youtube") return undefined;
  const context: Context = { kind };
  if (typeof v.url === "string") context.url = v.url;
  if (typeof v.title === "string") context.title = v.title;
  if (typeof v.text === "string") context.text = v.text;
  if (typeof v.videoId === "string") context.videoId = v.videoId;

  // Amendement 2026-09-25 (types de page). pageKind/facts/items only exist
  // for kind === "page" — "Compatibilité": "kind différent de page →
  // pageKind, facts et items ignorés". A pageKind outside the four known
  // values is dropped (undefined), same as an absent one — the client
  // behaves exactly as before this amendment ("other").
  if (kind === "page") {
    if (isPageKind(v.pageKind)) context.pageKind = v.pageKind;
    // "facts avec un pageKind autre que listing, items avec un pageKind
    // autre que list → champ ignoré (ni rendu, ni compté dans le budget)".
    if (context.pageKind === "listing") {
      const facts = parseFacts(v.facts);
      if (facts !== undefined) context.facts = facts;
    }
    if (context.pageKind === "list") {
      const items = parseItems(v.items);
      if (items !== undefined) context.items = items;
    }
    // Amendement 2026-10-08 (lot A1): elements is NOT gated by pageKind —
    // present or not regardless of list/listing/article/other, unlike
    // facts/items above.
    const elements = parseElements(v.elements);
    if (elements !== undefined) context.elements = elements;
  }
  return context;
}

/**
 * Parses a raw WebSocket text frame into a well-typed ClientMessage, or a
 * structured ParseError. Enforces the 256 KB message cap — 1.5 MiB for a
 * `chat` carrying `image` (docs/PROTOCOL.md §5, amendement 2026-10-08).
 */
export function parseClientMessage(raw: string): ParseResult {
  const byteLength = Buffer.byteLength(raw, "utf8");
  let parsed: unknown;

  if (byteLength > MAX_MESSAGE_BYTES) {
    // Amendement 2026-10-08 (lot B1): the ONLY message shape allowed past
    // the standard cap is a chat carrying image — docs/PROTOCOL.md §5.
    // Everything else, including unparsable JSON, is refused with the EXACT
    // fixed id/message this cap always used — an old client/test sees
    // byte-for-byte the same refusal as before this amendment existed.
    try {
      parsed = JSON.parse(raw);
    } catch {
      return {
        ok: false,
        error: { code: "bad-request", message: `message exceeds ${MAX_MESSAGE_BYTES} byte cap`, id: "oversized", oversized: true },
      };
    }
    if (!looksLikeChatWithImage(parsed)) {
      return {
        ok: false,
        error: { code: "bad-request", message: `message exceeds ${MAX_MESSAGE_BYTES} byte cap`, id: "oversized", oversized: true },
      };
    }
    if (byteLength > MAX_IMAGE_MESSAGE_BYTES) {
      return {
        ok: false,
        error: { code: "bad-request", message: `message exceeds ${MAX_IMAGE_MESSAGE_BYTES} byte cap`, id: "oversized", oversized: true },
      };
    }
    // Falls through below with `parsed` already decoded — a legitimate
    // chat+image shape, within the raised cap.
  } else {
    try {
      parsed = JSON.parse(raw);
    } catch {
      return { ok: false, error: { code: "bad-request", message: "invalid JSON" } };
    }
  }

  if (!isRecord(parsed)) {
    return { ok: false, error: { code: "bad-request", message: "message must be a JSON object" } };
  }

  const type = parsed.type;
  if (typeof type !== "string") {
    return { ok: false, error: { code: "bad-request", message: "missing type" } };
  }

  // hello and auth are the only messages without an id — both mid-handshake
  // only (docs/PROTOCOL.md "Poignée de main `v: 2`"). `nonce`/`proof` shape
  // (64 lowercase hex chars) is re-validated by broker-key.ts's isHex64
  // before any HMAC use; a malformed value here is still parsed through (so
  // the handshake state machine can fail it uniformly as `unauthorized`),
  // EXCEPT when it isn't even a string, or absurdly oversized — caught here
  // as bad-request, same "never let a wildly wrong shape reach the crypto
  // helpers" stance as elsewhere in this file.
  if (type === "hello") {
    if (parsed.v !== 2) {
      return { ok: false, error: { code: "bad-request", message: "hello: unsupported v" } };
    }
    if (!isNonEmptyString(parsed.nonce) || parsed.nonce.length > 200) {
      return { ok: false, error: { code: "bad-request", message: "hello: invalid nonce" } };
    }
    if (parsed.key !== undefined && parsed.key !== "native" && parsed.key !== "pasted") {
      return { ok: false, error: { code: "bad-request", message: "hello: invalid key" } };
    }
    // Goal G6: lang is a raw BCP 47 tag, not yet normalised — only its shape
    // is checked here (string, reasonably short); server.ts's normalizeLang()
    // turns anything it doesn't recognise into "en", so there is nothing to
    // reject here beyond "not a string at all" / "absurdly oversized".
    if (parsed.lang !== undefined && (typeof parsed.lang !== "string" || parsed.lang.length > 64)) {
      return { ok: false, error: { code: "bad-request", message: "hello: invalid lang" } };
    }
    return {
      ok: true,
      message: { type: "hello", v: 2, nonce: parsed.nonce, key: parsed.key, lang: parsed.lang },
    };
  }

  if (type === "auth") {
    if (parsed.v !== 2) {
      return { ok: false, error: { code: "bad-request", message: "auth: unsupported v" } };
    }
    if (!isNonEmptyString(parsed.proof) || parsed.proof.length > 200) {
      return { ok: false, error: { code: "bad-request", message: "auth: invalid proof" } };
    }
    return { ok: true, message: { type: "auth", v: 2, proof: parsed.proof } };
  }

  const id = parsed.id;
  if (!isNonEmptyString(id)) {
    return { ok: false, error: { code: "bad-request", message: "missing id" } };
  }

  switch (type) {
    case "chat": {
      if (!isNonEmptyString(parsed.text)) {
        return { ok: false, error: { code: "bad-request", message: "chat: missing text", id } };
      }
      const context = parseContext(parsed.context);
      // Amendement 2026-10-08 (lot B1): a malformed/oversized image is
      // dropped, not a bad-request — the chat still goes through as text
      // only (docs/PROTOCOL.md §3).
      const image = parseChatImage(parsed.image);
      // Security review (L6): the raised 1.5 MiB allowance exists ONLY to
      // carry a VALID image — looksLikeChatWithImage (above) is a cheap
      // shape test only (any object under `image`), so a frame like
      // `{ type: "chat", image: {}, text: "<~1.4 MiB>" }` would otherwise
      // sail through the whole 256 KiB cap on text alone, image dropped as
      // garbage. If the frame was only let through the gate because it
      // LOOKED like chat+image, but the image turned out invalid, it must
      // still be held to the ORIGINAL 256 KiB cap — same oversized
      // error/id/code as the standard gate, not silently accepted.
      if (image === undefined && byteLength > MAX_MESSAGE_BYTES) {
        return {
          ok: false,
          error: {
            code: "bad-request",
            message: `message exceeds ${MAX_MESSAGE_BYTES} byte cap`,
            id: "oversized",
            oversized: true,
          },
        };
      }
      // Amendement 2026-10-08 (lot C1): same drop-not-reject tolerance.
      const docSearch = parseChatDocSearch(parsed.docSearch);
      // Amendement 2026-10-08 (bis, "historique"): same drop-not-reject
      // tolerance, per entry — see parseHistory's own doc.
      const history = parseHistory(parsed.history);
      return { ok: true, message: { type: "chat", id, text: parsed.text, context, image, docSearch, history } };
    }
    case "summarize": {
      const context = parseContext(parsed.context);
      if (!context) {
        return { ok: false, error: { code: "bad-request", message: "summarize: missing context", id } };
      }
      // `length` removed (KISS audit 2026-09-26, item H): the extension only
      // ever sent "medium". A client that still sends it is not an error —
      // the field is simply ignored, same as any other unknown extra field.
      return { ok: true, message: { type: "summarize", id, context } };
    }
    case "act": {
      if (
        parsed.action !== "translate" &&
        parsed.action !== "rewrite" &&
        parsed.action !== "explain" &&
        parsed.action !== "shorten"
      ) {
        return { ok: false, error: { code: "bad-request", message: "act: invalid action", id } };
      }
      if (!isNonEmptyString(parsed.text)) {
        return { ok: false, error: { code: "bad-request", message: "act: missing text", id } };
      }
      const params = isRecord(parsed.params) ? (parsed.params as ActMessage["params"]) : undefined;
      return { ok: true, message: { type: "act", id, action: parsed.action, text: parsed.text, params } };
    }
    case "prompts.list": {
      return { ok: true, message: { type: "prompts.list", id } };
    }
    case "prompts.save": {
      const prompt = parsed.prompt;
      if (!isRecord(prompt)) {
        return { ok: false, error: { code: "bad-request", message: "prompts.save: invalid prompt", id } };
      }
      if (!isValidSiteKey(prompt.site)) {
        return { ok: false, error: { code: "bad-request", message: "prompts.save: invalid site", id } };
      }
      if (typeof prompt.body !== "string" || prompt.body.length === 0 || prompt.body.length > PROMPT_BODY_MAX) {
        return { ok: false, error: { code: "bad-request", message: "prompts.save: invalid body", id } };
      }
      let title: string | undefined;
      if (prompt.title !== undefined) {
        if (typeof prompt.title !== "string") {
          return { ok: false, error: { code: "bad-request", message: "prompts.save: invalid title", id } };
        }
        const trimmed = prompt.title.trim();
        if (trimmed.length > PROMPT_TITLE_MAX) {
          return { ok: false, error: { code: "bad-request", message: "prompts.save: title too long", id } };
        }
        title = trimmed.length > 0 ? trimmed : undefined;
      }
      let promptId: string | undefined;
      if (prompt.id !== undefined) {
        if (!isValidPromptId(prompt.id)) {
          return { ok: false, error: { code: "bad-request", message: "prompts.save: invalid id", id } };
        }
        promptId = prompt.id;
      }
      return {
        ok: true,
        message: { type: "prompts.save", id, prompt: { id: promptId, site: prompt.site, title, body: prompt.body } },
      };
    }
    case "prompts.delete": {
      if (!isValidPromptId(parsed.promptId)) {
        return { ok: false, error: { code: "bad-request", message: "prompts.delete: missing or invalid promptId", id } };
      }
      return { ok: true, message: { type: "prompts.delete", id, promptId: parsed.promptId } };
    }
    case "prompts.move": {
      if (!isValidPromptId(parsed.promptId)) {
        return { ok: false, error: { code: "bad-request", message: "prompts.move: missing or invalid promptId", id } };
      }
      if (!isValidSiteKey(parsed.site)) {
        return { ok: false, error: { code: "bad-request", message: "prompts.move: invalid site", id } };
      }
      const order = parsed.order;
      if (!Array.isArray(order) || order.length > PREFS_ORDER_MAX || !order.every(isValidOrderItem)) {
        return { ok: false, error: { code: "bad-request", message: "prompts.move: invalid order", id } };
      }
      return { ok: true, message: { type: "prompts.move", id, promptId: parsed.promptId, site: parsed.site, order } };
    }
    case "prefs.get": {
      return { ok: true, message: { type: "prefs.get", id } };
    }
    case "prefs.set": {
      if (!isValidSiteKey(parsed.site)) {
        return { ok: false, error: { code: "bad-request", message: "prefs.set: invalid site", id } };
      }
      const prefsRaw = parsed.prefs;
      if (!isRecord(prefsRaw)) {
        return { ok: false, error: { code: "bad-request", message: "prefs.set: invalid prefs", id } };
      }
      const sitePrefs: SitePrefs = {};
      if (prefsRaw.order !== undefined) {
        if (!Array.isArray(prefsRaw.order) || prefsRaw.order.length > PREFS_ORDER_MAX || !prefsRaw.order.every(isValidOrderItem)) {
          return { ok: false, error: { code: "bad-request", message: "prefs.set: invalid order", id } };
        }
        sitePrefs.order = prefsRaw.order;
      }
      if (prefsRaw.removed !== undefined) {
        if (!Array.isArray(prefsRaw.removed) || prefsRaw.removed.length > PREFS_ORDER_MAX || !prefsRaw.removed.every(isValidOrderItem)) {
          return { ok: false, error: { code: "bad-request", message: "prefs.set: invalid removed", id } };
        }
        sitePrefs.removed = prefsRaw.removed;
      }
      return { ok: true, message: { type: "prefs.set", id, site: parsed.site, prefs: sitePrefs } };
    }
    case "cancel": {
      if (!isNonEmptyString(parsed.target)) {
        return { ok: false, error: { code: "bad-request", message: "cancel: missing target", id } };
      }
      return { ok: true, message: { type: "cancel", id, target: parsed.target } };
    }
    case "settings.get": {
      return { ok: true, message: { type: "settings.get", id } };
    }
    case "settings.set": {
      const provider = parsed.provider;
      if (provider !== undefined && !isProviderId(provider)) {
        return { ok: false, error: { code: "bad-request", message: "settings.set: invalid provider", id } };
      }
      const model = parsed.model;
      if (model !== undefined && typeof model !== "string") {
        return { ok: false, error: { code: "bad-request", message: "settings.set: invalid model", id } };
      }
      const apiKey = parsed.apiKey;
      if (apiKey !== undefined && typeof apiKey !== "string") {
        return { ok: false, error: { code: "bad-request", message: "settings.set: invalid apiKey", id } };
      }
      // I3 (lot7 security review): reject a malformed key at the door rather
      // than persisting it and having it flow, unvalidated, into an
      // `x-api-key` HTTP header (providers/claude-api.ts) and error text
      // downstream — see docs/PROTOCOL.md's CLAUDE_API_AUTH_MESSAGE path. An
      // Anthropic key is printable ASCII, no whitespace; "" is exempt (it
      // means "forget the stored key", see SettingsSetMessage.apiKey).
      if (apiKey !== undefined && apiKey !== "" && !isValidApiKeyFormat(apiKey)) {
        return { ok: false, error: { code: "bad-request", message: "settings.set: invalid apiKey format", id } };
      }
      const baseUrl = parsed.baseUrl;
      if (baseUrl !== undefined && typeof baseUrl !== "string") {
        return { ok: false, error: { code: "bad-request", message: "settings.set: invalid baseUrl", id } };
      }
      // "" is exempt, same as apiKey — it means "forget the stored address".
      if (baseUrl !== undefined && baseUrl !== "" && !isValidBaseUrl(baseUrl)) {
        return {
          ok: false,
          error: {
            code: "bad-request",
            message: "settings.set: invalid baseUrl — must be https://, or http:// restricted to loopback",
            id,
          },
        };
      }
      // Amendement 2026-10-08 (lot C1, docs/PROTOCOL.md §9).
      const searchProviderRaw = parsed.searchProvider;
      if (
        searchProviderRaw !== undefined &&
        searchProviderRaw !== "brave" &&
        searchProviderRaw !== "tavily" &&
        searchProviderRaw !== ""
      ) {
        return { ok: false, error: { code: "bad-request", message: "settings.set: invalid searchProvider", id } };
      }
      const searchApiKey = parsed.searchApiKey;
      if (searchApiKey !== undefined && typeof searchApiKey !== "string") {
        return { ok: false, error: { code: "bad-request", message: "settings.set: invalid searchApiKey", id } };
      }
      if (searchApiKey !== undefined && searchApiKey !== "" && !isValidApiKeyFormat(searchApiKey)) {
        return { ok: false, error: { code: "bad-request", message: "settings.set: invalid searchApiKey format", id } };
      }
      // Amendement 2026-10-08 (lot C1, EXTRA task, docs/PROTOCOL.md §9bis).
      const clearKey = parsed.clearKey;
      if (clearKey !== undefined && !isProviderId(clearKey)) {
        return { ok: false, error: { code: "bad-request", message: "settings.set: invalid clearKey", id } };
      }
      return {
        ok: true,
        message: {
          type: "settings.set",
          id,
          provider,
          model,
          apiKey,
          baseUrl,
          searchProvider: searchProviderRaw,
          searchApiKey,
          clearKey,
        },
      };
    }
    case "settings.test": {
      const target = parsed.target;
      if (target !== undefined && target !== "model" && target !== "search") {
        return { ok: false, error: { code: "bad-request", message: "settings.test: invalid target", id } };
      }
      if (target === "search") {
        const searchProvider = parsed.searchProvider;
        if (searchProvider !== "brave" && searchProvider !== "tavily") {
          return { ok: false, error: { code: "bad-request", message: "settings.test: invalid searchProvider", id } };
        }
        return { ok: true, message: { type: "settings.test", id, target, searchProvider } };
      }
      const provider = parsed.provider;
      if (!isProviderId(provider)) {
        return { ok: false, error: { code: "bad-request", message: "settings.test: invalid provider", id } };
      }
      return { ok: true, message: { type: "settings.test", id, target, provider } };
    }
    case "provider.status": {
      return { ok: true, message: { type: "provider.status", id } };
    }
    case "models.list": {
      return { ok: true, message: { type: "models.list", id } };
    }
    case "model.warmup": {
      return { ok: true, message: { type: "model.warmup", id } };
    }
    default:
      return { ok: false, error: { code: "bad-request", message: `unknown type: ${type}`, id } };
  }
}
