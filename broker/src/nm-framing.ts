// Chrome Native Messaging framing — docs/PROTOCOL.md "Cadrage et échange avec
// l'hôte" (amendement 2026-09-30, G4): 4 bytes of length, native byte order
// (little-endian on every platform Coati targets — x86-64, arm64), followed
// by that many UTF-8 JSON bytes. Pure, allocation-light functions — no I/O
// here; native-host.ts wires these against real stdin/stdout.

export const MIN_FRAME_BYTES = 1;
export const MAX_FRAME_BYTES = 4096;
export const HEADER_BYTES = 4;

/** Encodes `body` (already-serialized JSON bytes) into a full Native
 * Messaging frame: 4-byte LE length prefix + body. Does not enforce
 * MIN/MAX_FRAME_BYTES itself — callers only ever encode replies this module's
 * own protocol defines, which are always small; the cap is an INCOMING-frame
 * rule (docs/PROTOCOL.md). */
export function encodeFrame(body: Buffer | string): Buffer {
  const bodyBuf = typeof body === "string" ? Buffer.from(body, "utf8") : body;
  const header = Buffer.alloc(HEADER_BYTES);
  header.writeUInt32LE(bodyBuf.length, 0);
  return Buffer.concat([header, bodyBuf]);
}

export function encodeJsonFrame(value: unknown): Buffer {
  return encodeFrame(JSON.stringify(value));
}

export type ParseFrameResult =
  | { status: "incomplete" }
  | { status: "invalid-length"; length: number }
  | { status: "complete"; body: Buffer; rest: Buffer };

/**
 * Pure: attempts to parse ONE frame off the front of `buffer`.
 *  - Fewer than 4 bytes buffered: "incomplete" (need more data, unless the
 *    stream has already ended — that EOF-before-header case is the caller's
 *    job to detect, this function has no notion of "the stream is done").
 *  - Length outside [MIN_FRAME_BYTES, MAX_FRAME_BYTES]: "invalid-length" —
 *    docs/PROTOCOL.md: "Longueur hors de 1 à 4 096 : aucune réponse, sortie 1."
 *  - Length valid but fewer than `length` body bytes buffered yet:
 *    "incomplete".
 *  - Otherwise "complete": `body` is exactly `length` bytes, `rest` is
 *    whatever followed (docs/PROTOCOL.md: "deux trames : seule la première
 *    est traitée" — the caller simply discards `rest`, it never asks for a
 *    second frame).
 */
export function tryParseFrame(buffer: Buffer): ParseFrameResult {
  if (buffer.length < HEADER_BYTES) return { status: "incomplete" };
  const length = buffer.readUInt32LE(0);
  if (length < MIN_FRAME_BYTES || length > MAX_FRAME_BYTES) {
    return { status: "invalid-length", length };
  }
  if (buffer.length < HEADER_BYTES + length) return { status: "incomplete" };
  const body = buffer.subarray(HEADER_BYTES, HEADER_BYTES + length);
  const rest = buffer.subarray(HEADER_BYTES + length);
  return { status: "complete", body: Buffer.from(body), rest: Buffer.from(rest) };
}
