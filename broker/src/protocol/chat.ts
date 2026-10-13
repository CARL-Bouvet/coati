// ChatImage / HistoryEntry wire types and their parsers
// (docs/PROTOCOL.md §3 "View screen", "history").

import { isRecord } from "./shared.ts";
import type { PageKind } from "./context.ts";

// "View screen" — docs/PROTOCOL.md §3.
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

// "historique" — docs/PROTOCOL.md. One past
// turn of the conversation shown in the panel. `text` only — never a past
// page context, screenshot or source: those attach to the CURRENT turn
// only (ChatMessage.context/image above), never replayed. Closed
// role set: a role string outside {"user","assistant"} isn't a HistoryEntry,
// same shape-tolerance stance as Element/ChatImage ("Compatibility").
export type HistoryRole = "user" | "assistant";
export interface HistoryEntry {
  role: HistoryRole;
  text: string;
}

// HISTORY_MAX_ENTRIES caps the wire array as a hard backstop — the panel
// itself caps at 10 exchanges (20 entries) BEFORE ever sending (see
// extension/panel/history.js), so this only ever matters for a future/other
// client that sends more. HISTORY_ENTRY_TEXT_MAX bounds one entry's `text`;
// an entry over this length is DROPPED (not truncated — "the broker refuses,
// it never truncates" doesn't apply to a tolerant-drop field like this one,
// same stance as a malformed Element), not a bad-request for the whole
// message. Both counted toward the message's existing MAX_MESSAGE_BYTES
// cap (part of the same JSON payload), no separate size cap of their own.
export const HISTORY_MAX_ENTRIES = 20;
export const HISTORY_ENTRY_TEXT_MAX = 8000;

// docs/PROTOCOL.md §3. Magic numbers,
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
 * field — "Compatibility").
 */
export function parseChatImage(v: unknown): ChatImage | undefined {
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

  // L5: forward the CANONICAL re-encoding of the bytes we
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
 * Validates `chat.history` (docs/PROTOCOL.md).
 * Per-entry tolerant: an entry whose `role` isn't exactly "user"/"assistant",
 * or whose `text` isn't a non-empty string ≤ HISTORY_ENTRY_TEXT_MAX, is
 * dropped — the other entries are kept, same "Compatibility" stance as
 * parseElement. Any field beyond `role`/`text` is dropped (closed shape).
 * More than HISTORY_MAX_ENTRIES survive validation: only the LAST
 * HISTORY_MAX_ENTRIES are kept (oldest dropped first — the caller sends
 * oldest-to-newest) rather than a bad-request; the panel itself never sends
 * more than this in the first place. An empty or fully-invalid array returns
 * undefined (adds nothing), same as `elements`.
 */
export function parseHistory(v: unknown): HistoryEntry[] | undefined {
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

// "page on demand" — docs/PROTOCOL.md "Page
// on demand". Metadata about a page the model may ask to read later, on a
// `chat` that carries no `context` at all (see parse.ts: the two are never
// both honoured on the same message). `title`/`url` are page-controlled —
// same trust level as Context.title/url (CLAUDE.md rule #3) — bounded the
// same way (PAGE_META_TITLE_MAX/PAGE_META_URL_MAX) rather than left
// unbounded like Context's own url/title, since there is no existing
// numeric-budget check (server.ts's contextBudgetError) this field goes
// through on its own path. `chars` is the page's own extracted length, as
// computed by the extension — an informational number shown to the model,
// never re-derived or verified broker-side.
export const PAGE_META_TITLE_MAX = 300;
export const PAGE_META_URL_MAX = 300;

export interface PageMeta {
  title: string;
  url: string;
  kind?: PageKind;
  chars: number;
}

function isPageMetaKind(v: unknown): v is PageKind {
  return v === "list" || v === "listing" || v === "article" || v === "other";
}

/**
 * Validates `chat.page` (docs/PROTOCOL.md "Page on demand"). Same
 * drop-not-reject tolerance as `image`: a malformed value is
 * dropped whole — the chat still goes through as a normal (no-page) request,
 * never a bad-request.
 */
export function parsePageMeta(v: unknown): PageMeta | undefined {
  if (!isRecord(v)) return undefined;
  if (typeof v.title !== "string" || v.title.length === 0 || v.title.length > PAGE_META_TITLE_MAX) return undefined;
  if (typeof v.url !== "string" || v.url.length === 0 || v.url.length > PAGE_META_URL_MAX) return undefined;
  if (typeof v.chars !== "number" || !Number.isFinite(v.chars) || v.chars < 0) return undefined;
  const meta: PageMeta = { title: v.title, url: v.url, chars: v.chars };
  if (isPageMetaKind(v.kind)) meta.kind = v.kind;
  return meta;
}

/**
 * Cheap shape test for "does this JSON object look like a `page.content`
 * carrying real context?" — used by the oversized-message gate
 * (parseClientMessage) the same way as looksLikeChatWithImage below: a
 * `page.content` can legitimately carry up to MAX_IMAGE_MESSAGE_BYTES (dev
 * level's cleaned HTML, docs/PROTOCOL.md "Page on demand"), same allowance
 * as chat+image.
 */
export function looksLikePageContent(parsed: unknown): boolean {
  return isRecord(parsed) && parsed.type === "page.content" && isRecord(parsed.context);
}

/**
 * Cheap shape test for "does this JSON object look like a chat carrying an
 * image?" — used by the oversized-message gate (parseClientMessage) BEFORE
 * full validation (parseChatImage), so a frame between MAX_MESSAGE_BYTES and
 * MAX_IMAGE_MESSAGE_BYTES that is obviously not a legitimate chat+image can
 * still be refused with the exact message/id, without paying
 * for base64 decode + magic-byte checks on a payload we're about to reject
 * anyway.
 */
export function looksLikeChatWithImage(parsed: unknown): boolean {
  return isRecord(parsed) && parsed.type === "chat" && isRecord(parsed.image);
}

// docs/PROTOCOL.md "Search": the abilities a panel can announce, the limits on
// searching and opening pages, and the shape of what the client sends back.
export const SEARCH_QUERY_MAX_CHARS = 200;
export const SEARCH_MAX_PER_QUESTION = 4;
export const SEARCH_MAX_RESULTS = 8;
export const SEARCH_MAX_OPENED = 6;
export const OPEN_MAX_REFS = 3;
export const OPEN_PAGE_MAX_CHARS = 6000;
export const SEARCH_BUDGET_LOCAL_CHARS = 32_000;
export const SEARCH_BUDGET_ONLINE_CHARS = 64_000;
/** Model calls per question, whatever markers it uses. */
export const CHAT_MAX_MODEL_TURNS = 10;

export type ChatAbility = "search";

export interface SearchResultEntry {
  n: number;
  title: string;
  url: string;
  snippet: string;
}

export interface SearchPageEntry {
  n: number;
  url: string;
  title: string;
  text: string;
}

export const SEARCH_DECLINE_REASONS = ["no-access", "no-result", "blocked", "failed"] as const;
export type SearchDeclineReason = (typeof SEARCH_DECLINE_REASONS)[number];
export const OPEN_DECLINE_REASONS = ["no-access", "blocked", "failed"] as const;
export type OpenDeclineReason = (typeof OPEN_DECLINE_REASONS)[number];

/** `chat.abilities`: unknown words are dropped; none left → undefined. */
export function parseAbilities(v: unknown): ChatAbility[] | undefined {
  if (!Array.isArray(v)) return undefined;
  const known = (["search"] as const).filter((a) => v.includes(a));
  return known.length > 0 ? known : undefined;
}

/** `chat.searchQuery`: a single-line query of 1..SEARCH_QUERY_MAX_CHARS characters, else dropped. */
export function parseSearchQuery(v: unknown): string | undefined {
  if (typeof v !== "string") return undefined;
  const q = v.trim();
  return q.length >= 1 && q.length <= SEARCH_QUERY_MAX_CHARS && !/[\r\n]/.test(q) && !q.includes("]]") ? q : undefined;
}

function parseEntries<T>(v: unknown, read: (r: Record<string, unknown>) => T | undefined): T[] | undefined {
  if (!Array.isArray(v)) return undefined;
  const out: T[] = [];
  for (const el of v) {
    const entry = isRecord(el) ? read(el) : undefined;
    if (entry === undefined) return undefined;
    out.push(entry);
  }
  return out;
}

const isN = (v: unknown): v is number => typeof v === "number" && Number.isInteger(v) && v > 0;
const isStr = (v: unknown): v is string => typeof v === "string";

/** Shape check of a `search.content` body; the limits are searchContentError's. */
export function parseSearchBody(parsed: Record<string, unknown>): SearchBody | undefined {
  if (!isStr(parsed.query)) return undefined;
  const results = parseEntries(parsed.results, (r) =>
    isN(r.n) && isStr(r.title) && isStr(r.url) && isStr(r.snippet)
      ? { n: r.n, title: r.title, url: r.url, snippet: r.snippet }
      : undefined,
  );
  return results ? { query: parsed.query, results } : undefined;
}

/** Shape check of `open.content`'s `pages`; the limits are openContentError's. */
export function parseOpenPages(v: unknown): SearchPageEntry[] | undefined {
  return parseEntries(v, (r) =>
    isN(r.n) && isStr(r.url) && isStr(r.title) && isStr(r.text) ? { n: r.n, url: r.url, title: r.title, text: r.text } : undefined,
  );
}

export interface SearchBody {
  query: string;
  results: SearchResultEntry[];
}

/** The limit a `search.content` breaches, or undefined. The broker refuses, it never truncates. */
export function searchContentError(c: SearchBody): string | undefined {
  return c.results.length > SEARCH_MAX_RESULTS ? `more than ${SEARCH_MAX_RESULTS} search results` : undefined;
}

/** What an `open.content` answering a request for `refs` breaches, or undefined. */
export function openContentError(
  pages: readonly SearchPageEntry[],
  refs: readonly number[],
): { code: "bad-request" | "context-too-large"; message: string } | undefined {
  const seen = new Set<number>();
  for (const p of pages) {
    if (!refs.includes(p.n) || seen.has(p.n)) return { code: "bad-request", message: `open.content: page S${p.n} was not requested` };
    seen.add(p.n);
    if (p.text.length > OPEN_PAGE_MAX_CHARS) {
      return { code: "context-too-large", message: `open.content: page S${p.n} exceeds ${OPEN_PAGE_MAX_CHARS} characters` };
    }
  }
  return undefined;
}
