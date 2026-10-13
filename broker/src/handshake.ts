// Origin checks + the v: 2 handshake state machine (docs/PROTOCOL.md
// "Handshake `v: 2`"). Split out of server.ts.

import {
  brokerProof,
  extensionProof,
  freshNonceHex,
  isHex64,
  safeEqualHex,
} from "./broker-key.ts";
import { parseClientMessage } from "./protocol.ts";
import type { ClientAnswer } from "./handlers/chat.ts";
import { normalizeLang, type Lang } from "./messages.ts";
import { send } from "./ws-send.ts";
import { sanitizeLogValue, BROKER_FEATURES } from "./logging.ts";

/** Pure: Origin header must exactly match chrome-extension://<one of allowedExtensionIds>. */
export function checkOrigin(origin: string | null | undefined, allowedExtensionIds: string[]): boolean {
  if (!origin) return false;
  return allowedExtensionIds.some((id) => origin === `chrome-extension://${id}`);
}

// Firefox's own extension origin scheme. The uuid is a standard RFC 4122
// v4-shaped string; Firefox assigns it randomly per install, so — unlike
// Chrome's "key"-derived id — it cannot be part of allowedExtensionIds ahead
// of time. No pinning anymore — ANY well-formed
// uuid passes this step, because the v: 2 handshake's key (not the origin)
// is what actually authenticates (docs/PROTOCOL.md "Handshake `v: 2`").
const MOZ_EXTENSION_ORIGIN_RE = /^moz-extension:\/\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i;

/** Pure: extracts the uuid out of a moz-extension://<uuid> origin, or null if
 * `origin` isn't one. Only used to validate the origin is WELL-FORMED — its
 * value plays no further role (no pinning). */
export function parseMozExtensionOrigin(origin: string | null | undefined): string | null {
  if (!origin) return null;
  const match = MOZ_EXTENSION_ORIGIN_RE.exec(origin);
  return match ? match[1].toLowerCase() : null;
}

/** Pure: true iff `origin` is a chrome-extension:// origin on the allowlist,
 * or a well-formed moz-extension://<uuid> origin (any uuid) — docs/PROTOCOL.md
 * "Handshake `v: 2`", step 1. Never accepts anything else; this step
 * only ever stops web pages, the key (not the origin) does the rest. */
export function isOriginAllowed(origin: string | null | undefined, allowedExtensionIds: string[]): boolean {
  if (checkOrigin(origin, allowedExtensionIds)) return true;
  return parseMozExtensionOrigin(origin) !== null;
}

// --- v: 2 handshake state machine ------------------------------------------
//
// docs/PROTOCOL.md "Handshake `v: 2`": client hello (nonce + which key)
// -> broker challenge (fresh nonce + its own proof) -> client auth (its
// proof) -> hello-ok. A single 3s deadline covers the whole exchange (armed
// at open(), never reset mid-handshake).

export type HandshakeState =
  | { stage: "awaiting-hello" }
  | { stage: "awaiting-auth"; key: Buffer; keyLabel: "native" | "pasted"; cNonce: string; bNonce: string };

export interface ConnData {
  origin: string | null;
  authed: boolean;
  active: Map<string, AbortController>;
  helloTimer: ReturnType<typeof setTimeout> | null;
  hs: HandshakeState;
  /** True while this connection counts toward MAX_UNAUTH_CONNECTIONS — set at
   * open(), cleared the moment it authenticates or closes (whichever first),
   * so it is only ever decremented once. */
  countedUnauth: boolean;
  /** docs/PROTOCOL.md "Langue de la connexion": normalised from the
   * `hello`'s raw `lang` at handshake time (messages.ts's normalizeLang) —
   * defaults to "en" until a hello sets it, and for the handful of tests that
   * connect without ever sending one. */
  lang: Lang;
  /** L9: true from the `close` handler onward — checked
   * before `send()` or `runStream()` after any async phase, so a connection
   * that closed meanwhile never gets written to. */
  closed: boolean;
  /**
   * Pending `page.request`/`search.request`s this connection is waiting an
   * answer for, keyed by the originating chat's own id (never a fresh id).
   * handlers/chat.ts registers a resolver here right before sending the
   * request, and removes it the moment an answer naming that same id as its
   * `target` arrives (dispatch.ts), or the wait times out/aborts on its own.
   * An answer whose `target` has no entry here (late arrival after timeout,
   * or one that never had a matching request) is simply ignored — never an
   * error, same tolerance as `cancel` naming an unknown id.
   */
  clientRequests: Map<string, (answer: ClientAnswer) => void>;
}

// Client-controlled values (Host, Origin) are logged sanitized — control
// characters replaced with `?`, cut to 200 chars — see docs/PROTOCOL.md
// "Journalisation".

// A local process on the machine (not the intended extension) can open a
// WebSocket and probe the handshake. Distinct client-visible messages for
// "wrong secret" / "no hello in time" would let it tell
// those apart — an oracle. Every failure gets this one generic message on the
// wire; the real reason goes to the broker's own stderr only.
const HANDSHAKE_FAILURE_MESSAGE = "unauthorized";

function sendUnauthorizedAndClose(ws: {
  close(code: number, reason: string): unknown;
  send(data: string): unknown;
}): void {
  send(ws, { type: "error", id: "hello", code: "unauthorized", message: HANDSHAKE_FAILURE_MESSAGE });
  ws.close(4401, HANDSHAKE_FAILURE_MESSAGE);
}

/** Anything past the origin check (bad/missing hello, wrong secret, timeout)
 * — `reject stage=handshake` (docs/PROTOCOL.md "Journalisation"). The precise
 * `reason` only ever reaches the broker's own stderr, never the wire (see
 * HANDSHAKE_FAILURE_MESSAGE above). */
export function rejectHandshake(
  ws: { close(code: number, reason: string): unknown; send(data: string): unknown },
  origin: string | null | undefined,
  reason: string,
): void {
  console.error(`coati-broker: reject stage=handshake origin=${sanitizeLogValue(origin)} reason=${reason}`);
  sendUnauthorizedAndClose(ws);
}

/**
 * The v: 2 handshake state machine (docs/PROTOCOL.md "Handshake
 * `v: 2`"):
 *
 *   1. client `hello` (nonce cN, which key) — this connection's ONE hello.
 *   2. broker `challenge` (fresh nonce bN, its own proof bP = HMAC(K, cN:bN)).
 *   3. client `auth` (its proof eP = HMAC(K, cN:bN)).
 *   4. broker compares eP in constant time -> `hello-ok`, or the generic
 *      failure (4401).
 *
 * `key` in step 1 selects K: the broker's own native key (default), or — only
 * when `legacyPairing` is on — the permanent secret `S` ("pasted"). A single
 * 3s deadline (armed at open(), see startServer) covers the whole exchange.
 */
export function handleHandshakeMessage(
  ws: { close(code: number, reason: string): unknown; send(data: string): unknown; data: ConnData },
  raw: string,
  nativeKey: Buffer,
  getLegacySecret: () => Buffer,
  legacyPairingEnabled: boolean,
  onAuthed: () => void,
): void {
  const origin = ws.data.origin;
  const result = parseClientMessage(raw);

  if (ws.data.hs.stage === "awaiting-hello") {
    if (!result.ok || result.message.type !== "hello") {
      rejectHandshake(ws, origin, "expected hello message");
      return;
    }
    const { nonce: cNonce, key } = result.message;
    // Recorded even if this hello later fails (harmless — the
    // connection never authenticates and its lang plays no further role).
    ws.data.lang = normalizeLang(result.message.lang);
    if (!isHex64(cNonce)) {
      rejectHandshake(ws, origin, "malformed client nonce");
      return;
    }
    const keyLabel: "native" | "pasted" = key ?? "native";
    if (keyLabel === "pasted" && !legacyPairingEnabled) {
      rejectHandshake(ws, origin, "legacy-pairing-disabled");
      return;
    }
    const activeKey = keyLabel === "pasted" ? getLegacySecret() : nativeKey;
    const bNonce = freshNonceHex();
    const bProof = brokerProof(activeKey, cNonce, bNonce);
    ws.data.hs = { stage: "awaiting-auth", key: activeKey, keyLabel, cNonce, bNonce };
    send(ws, { type: "challenge", v: 2, nonce: bNonce, proof: bProof });
    return;
  }

  // stage === "awaiting-auth"
  const hs = ws.data.hs;
  if (!result.ok || result.message.type !== "auth") {
    rejectHandshake(ws, origin, "expected auth message");
    return;
  }
  const { proof: eProof } = result.message;
  if (!isHex64(eProof)) {
    rejectHandshake(ws, origin, "malformed extension proof");
    return;
  }
  const expected = extensionProof(hs.key, hs.cNonce, hs.bNonce);
  if (!safeEqualHex(eProof, expected)) {
    rejectHandshake(ws, origin, "invalid extension proof");
    return;
  }
  if (ws.data.helloTimer) {
    clearTimeout(ws.data.helloTimer);
    ws.data.helloTimer = null;
  }
  ws.data.authed = true;
  onAuthed();
  console.error(`coati-broker: grant via=${hs.keyLabel} origin=${sanitizeLogValue(origin)}`);
  send(ws, { type: "hello-ok", v: 2, features: BROKER_FEATURES });
}
