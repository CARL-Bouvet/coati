// Parses a raw WebSocket text frame into a well-typed ClientMessage. The
// single entry point every message family's own shape check (context.ts,
// chat.ts) feeds into. Split out of protocol.ts (lot F5).

import { isProviderId } from "../config.ts";
import {
  MAX_MESSAGE_BYTES,
  MAX_IMAGE_MESSAGE_BYTES,
  isRecord,
  isNonEmptyString,
  isValidApiKeyFormat,
  isValidBaseUrl,
  type ErrorCode,
} from "./shared.ts";
import { parseContext } from "./context.ts";
import {
  parseChatImage,
  parseHistory,
  parsePageMeta,
  parseAbilities,
  parseSearchQuery,
  parseSearchBody,
  parseOpenPages,
  OPEN_DECLINE_REASONS,
  SEARCH_DECLINE_REASONS,
  looksLikeChatWithImage,
  looksLikePageContent,
} from "./chat.ts";
import {
  isValidSiteKey,
  isValidOrderItem,
  isValidPromptId,
  PROMPT_TITLE_MAX,
  PROMPT_BODY_MAX,
  PREFS_ORDER_MAX,
} from "./prompts-prefs.ts";
import type { SitePrefs } from "./prompts-prefs.ts";
import type { ActMessage, ClientMessage } from "./client-messages.ts";

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
    // Amendement 2026-10-09 (lot 7, docs/PROTOCOL.md "Page on demand"): a
    // `page.content` carrying dev-level content gets the same raised
    // allowance as a chat+image — see looksLikePageContent's own doc.
    if (!looksLikeChatWithImage(parsed) && !looksLikePageContent(parsed)) {
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
  // only (docs/PROTOCOL.md "Handshake `v: 2`"). `nonce`/`proof` shape
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
      // Amendement 2026-10-08 (bis, "historique"): same drop-not-reject
      // tolerance, per entry — see parseHistory's own doc.
      const history = parseHistory(parsed.history);
      // Amendement 2026-10-09 (lot 7, "page on demand" — docs/PROTOCOL.md
      // "Page on demand"): same drop-not-reject tolerance as image.
      const page = parsePageMeta(parsed.page);
      const devMode = typeof parsed.devMode === "boolean" ? parsed.devMode : undefined;
      const abilities = parseAbilities(parsed.abilities);
      const searchQuery = parseSearchQuery(parsed.searchQuery);
      return { ok: true, message: { type: "chat", id, text: parsed.text, context, image, history, page, devMode, abilities, searchQuery } };
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
          clearKey,
        },
      };
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
    case "models.list": {
      return { ok: true, message: { type: "models.list", id } };
    }
    case "model.warmup": {
      return { ok: true, message: { type: "model.warmup", id } };
    }
    // Amendement 2026-10-09 (lot 7, "page on demand" — docs/PROTOCOL.md
    // "Page on demand"). Unlike image/page (above), a malformed
    // `page.content`/`page.decline` IS a bad-request — there is no
    // "degrade gracefully, the request still goes through" fallback here:
    // these messages carry no text of their own to fall back to, they only
    // ever exist to answer a `page.request` the broker is actively waiting
    // on (handlers/chat.ts) — a malformed answer must surface as an error,
    // not vanish silently and leave that wait to run out the full
    // PAGE_REQUEST_TIMEOUT_MS for nothing.
    case "page.content": {
      if (!isNonEmptyString(parsed.target)) {
        return { ok: false, error: { code: "bad-request", message: "page.content: missing target", id } };
      }
      const level = parsed.level;
      if (level !== "text" && level !== "dev") {
        return { ok: false, error: { code: "bad-request", message: "page.content: invalid level", id } };
      }
      const context = parseContext(parsed.context);
      if (!context) {
        return { ok: false, error: { code: "bad-request", message: "page.content: missing context", id } };
      }
      // Security review (L6 pattern, same as chat+image): the raised 1.5 MiB
      // allowance only exists to carry a VALID context — a frame that only
      // got past the 256 KiB gate because it LOOKED like page.content, but
      // whose context turned out unparsable, must still be held to the
      // original cap.
      if (byteLength > MAX_MESSAGE_BYTES && level !== "dev") {
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
      return { ok: true, message: { type: "page.content", id, target: parsed.target, level, context } };
    }
    case "page.decline": {
      if (!isNonEmptyString(parsed.target)) {
        return { ok: false, error: { code: "bad-request", message: "page.decline: missing target", id } };
      }
      return { ok: true, message: { type: "page.decline", id, target: parsed.target } };
    }
    case "search.content": {
      const body = parseSearchBody(parsed);
      if (!isNonEmptyString(parsed.target) || !body) {
        return { ok: false, error: { code: "bad-request", message: "search.content: invalid", id } };
      }
      return { ok: true, message: { type: "search.content", id, target: parsed.target, ...body } };
    }
    case "search.decline": {
      const reason = SEARCH_DECLINE_REASONS.find((r) => r === parsed.reason);
      if (!isNonEmptyString(parsed.target) || !reason) {
        return { ok: false, error: { code: "bad-request", message: "search.decline: invalid", id } };
      }
      return { ok: true, message: { type: "search.decline", id, target: parsed.target, reason } };
    }
    case "open.content": {
      const pages = parseOpenPages(parsed.pages);
      if (!isNonEmptyString(parsed.target) || !pages) {
        return { ok: false, error: { code: "bad-request", message: "open.content: invalid", id } };
      }
      return { ok: true, message: { type: "open.content", id, target: parsed.target, pages } };
    }
    case "open.decline": {
      const reason = OPEN_DECLINE_REASONS.find((r) => r === parsed.reason);
      if (!isNonEmptyString(parsed.target) || !reason) {
        return { ok: false, error: { code: "bad-request", message: "open.decline: invalid", id } };
      }
      return { ok: true, message: { type: "open.decline", id, target: parsed.target, reason } };
    }
    default:
      return { ok: false, error: { code: "bad-request", message: `unknown type: ${type}`, id } };
  }
}
