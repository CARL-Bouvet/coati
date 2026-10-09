// ChatImage / ChatDocSearch / HistoryEntry wire types and their parsers
// (docs/PROTOCOL.md §3 "View screen", §6 "Look up official docs",
// "history"). Split out of protocol.ts (lot F5).

import { isRecord, isValidOrigin } from "./shared.ts";

// Amendement 2026-10-08 (lot B1, "View screen" — docs/PROTOCOL.md §3).
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

// Amendement 2026-10-08 (lot C1, "Look up official docs" —
// docs/PROTOCOL.md §6). Origin ONLY — scheme + host + optional port, never a
// path or query string (same reasoning as Context.url staying free-form
// while this one is deliberately narrow: the broker turns this into a
// documentation-site GUESS, docs/PROTOCOL.md "Discovery" — a path would add
// nothing to that and only widen what a page can make the broker fetch).
//
// Amendement 2026-10-08 (bis, "explicit search on demand" — there is
// no more "Search the docs" button). Meaning changed: this no longer
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
export function parseChatDocSearch(v: unknown): ChatDocSearch | undefined {
  if (!isRecord(v)) return undefined;
  if (!isValidOrigin(v.origin)) return undefined;
  return { origin: v.origin };
}

/**
 * Validates `chat.history` (docs/PROTOCOL.md, amendement 2026-10-08 bis).
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

/**
 * Cheap shape test for "does this JSON object look like a chat carrying an
 * image?" — used by the oversized-message gate (parseClientMessage) BEFORE
 * full validation (parseChatImage), so a frame between MAX_MESSAGE_BYTES and
 * MAX_IMAGE_MESSAGE_BYTES that is obviously not a legitimate chat+image can
 * still be refused with the exact pre-amendment message/id, without paying
 * for base64 decode + magic-byte checks on a payload we're about to reject
 * anyway.
 */
export function looksLikeChatWithImage(parsed: unknown): boolean {
  return isRecord(parsed) && parsed.type === "chat" && isRecord(parsed.image);
}
