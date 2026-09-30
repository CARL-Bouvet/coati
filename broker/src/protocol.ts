// TypeScript types and parser for every message defined in docs/PROTOCOL.md.
// The 256 KB per-message cap is enforced here, at parse time.

import { isProviderId, type ProviderId } from "./config.ts";

export const MAX_MESSAGE_BYTES = 256 * 1024;

export type ErrorCode =
  | "bad-request"
  | "unauthorized"
  | "model-unavailable"
  | "auth-required"
  | "context-too-large"
  | "cancelled"
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
}

// Added for task 3 (2026-09-21): backs the panel's "Tester la connexion"
// button — see docs/PROTOCOL.md's settings.test amendment.
export interface SettingsTestMessage {
  type: "settings.test";
  id: string;
  provider: ProviderId;
}

// Amendement 2026-09-25 — "Disponibilité du fournisseur". Sent by the panel
// once per panel open only (never automatically, never periodically — see
// CLAUDE.md rule #5, "la règle du geste"). Takes no field beyond `id`: it
// always targets the currently active provider.
export interface ProviderStatusMessage {
  type: "provider.status";
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
  | ProviderStatusMessage;

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
}

export interface ErrorMessage {
  type: "error";
  id: string;
  code: ErrorCode;
  message: string;
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
}

// Reply to a settings.test request — a real minimal model call, bounded by a
// short timeout (see server.ts's SETTINGS_TEST_TIMEOUT_MS), never a
// chat/summarize the extension would otherwise trigger via the wire. `message`
// is French, one sentence, shown verbatim to a human — see docs/PROTOCOL.md.
export interface SettingsTestResultMessage {
  type: "settings.test-result";
  id: string;
  provider: ProviderId;
  ok: boolean;
  message: string;
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
  | ProviderStatusResultMessage;

// --- Parsing ---

export interface ParseError {
  code: ErrorCode;
  message: string;
  /** Present only if we could recover an id from the raw payload. */
  id?: string;
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
  }
  return context;
}

/**
 * Parses a raw WebSocket text frame into a well-typed ClientMessage, or a
 * structured ParseError. Enforces the 256 KB message cap.
 */
export function parseClientMessage(raw: string): ParseResult {
  const byteLength = Buffer.byteLength(raw, "utf8");
  if (byteLength > MAX_MESSAGE_BYTES) {
    return {
      ok: false,
      error: { code: "bad-request", message: `message exceeds ${MAX_MESSAGE_BYTES} byte cap` },
    };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { ok: false, error: { code: "bad-request", message: "invalid JSON" } };
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
    return {
      ok: true,
      message: { type: "hello", v: 2, nonce: parsed.nonce, key: parsed.key },
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
      return { ok: true, message: { type: "chat", id, text: parsed.text, context } };
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
      return { ok: true, message: { type: "settings.set", id, provider, model, apiKey, baseUrl } };
    }
    case "settings.test": {
      const provider = parsed.provider;
      if (!isProviderId(provider)) {
        return { ok: false, error: { code: "bad-request", message: "settings.test: invalid provider", id } };
      }
      return { ok: true, message: { type: "settings.test", id, provider } };
    }
    case "provider.status": {
      return { ok: true, message: { type: "provider.status", id } };
    }
    default:
      return { ok: false, error: { code: "bad-request", message: `unknown type: ${type}`, id } };
  }
}
