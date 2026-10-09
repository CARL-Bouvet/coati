// Wire-wide limits, the error-code enum, and the small validation primitives
// shared by every message family's own parser (protocol/context.ts,
// protocol/chat.ts, protocol/parse.ts). Split out of protocol.ts (lot F5).

export const MAX_MESSAGE_BYTES = 256 * 1024;

// Amendement 2026-10-08 (lot B1, "View screen" — docs/PROTOCOL.md §5).
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
  // Amendement 2026-10-09 (lot 7, "page on demand" — docs/PROTOCOL.md "Page
  // on demand"): the client never answered a `page.request` (with
  // `page.content` or `page.decline`) within PAGE_REQUEST_TIMEOUT_MS.
  | "page-unavailable"
  | "internal";

export function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

export function isNonEmptyString(v: unknown): v is string {
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
// (docs/PROTOCOL.md "Model provider"): `https://` unconditionally, or
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
