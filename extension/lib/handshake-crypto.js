// WebCrypto helpers for the Native Messaging handshake v2
// (docs/PROTOCOL.md, "Handshake v: 2").
//
// Every HMAC here is HMAC-SHA256 over UTF-8 text, hex-encoded (lowercase).
// `crypto.subtle` is available in both the service worker and `bun test`
// (Bun implements WebCrypto), so this file needs no build step and is
// directly unit-testable — see broker/test/ext-handshake-crypto.test.ts.

/** 64 lowercase hex chars = 32 bytes — the shape of every nonce/proof/key in
 * the v2 handshake. Malformed input (docs/PROTOCOL.md: "nonce not 64 lowercase
 * hex chars") is a handshake failure, never tolerated loosely. */
export const HEX64_RE = /^[0-9a-f]{64}$/;

export function isHex64(value) {
  return typeof value === "string" && HEX64_RE.test(value);
}

function hexToBytes(hex) {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i++) bytes[i] = parseInt(hex.substr(i * 2, 2), 16);
  return bytes;
}

function bytesToHex(bytes) {
  return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** 32 fresh random bytes, as 64 lowercase hex chars — used for `cN` (the
 * extension's own nonce). Never Math.random(): this value stands in for a
 * cryptographic nonce, see the "why" note in PROTOCOL.md. */
export function randomHex32() {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return bytesToHex(bytes);
}

async function importHmacKey(keyHex, usages) {
  const keyBytes = hexToBytes(keyHex);
  return crypto.subtle.importKey("raw", keyBytes, { name: "HMAC", hash: "SHA-256" }, false, usages);
}

/** HMAC-SHA256(keyHex, message), returned as 64 lowercase hex chars. Used to
 * build the extension's own `auth.proof` (eP). */
export async function hmacHex(keyHex, message) {
  const key = await importHmacKey(keyHex, ["sign"]);
  const signature = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(message));
  return bytesToHex(new Uint8Array(signature));
}

/** Verifies `signatureHex` is HMAC-SHA256(keyHex, message), via
 * `crypto.subtle.verify` — NOT a string/timing-unsafe compare of two
 * recomputed hex strings (docs/PROTOCOL.md: "using crypto.subtle.verify, not
 * string compare"). Returns false (never throws) on a malformed
 * `signatureHex`, so a bad broker challenge is just a failed verification,
 * not a crash. */
export async function verifyHmacHex(keyHex, message, signatureHex) {
  if (!isHex64(signatureHex)) return false;
  try {
    const key = await importHmacKey(keyHex, ["verify"]);
    return await crypto.subtle.verify("HMAC", key, hexToBytes(signatureHex), new TextEncoder().encode(message));
  } catch {
    return false;
  }
}

/** The two labelled message strings signed over `cN:bN` (docs/PROTOCOL.md:
 * "The two distinct labels prevent replaying the broker's own proof as an
 * extension proof"). Broker proof uses the "-broker:" prefix, extension
 * proof the "-extension:" prefix — never the same string signed twice under
 * different names. */
export function brokerProofMessage(cN, bN) {
  return `coati-v2-broker:${cN}:${bN}`;
}

export function extensionProofMessage(cN, bN) {
  return `coati-v2-extension:${cN}:${bN}`;
}
