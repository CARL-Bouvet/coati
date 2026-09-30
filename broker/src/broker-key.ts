// The broker key (docs/PROTOCOL.md "Clé de broker") and the legacy-mode
// permanent pairing secret S ("Mode hérité : legacyPairing") — amendement
// 2026-09-30 (G4). Both are 32-byte keys used as HMAC-SHA256 keys in the
// v: 2 handshake ("Poignée de main v: 2"); this module owns their
// generation, on-disk format, file hardening, and the HMAC/compare helpers
// the handshake needs. Never logs a key or a proof.

import { readFileSync, existsSync, unlinkSync, chmodSync, lstatSync } from "node:fs";
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { join } from "node:path";
import { hardenDir, atomicWriteFileSync } from "./fs-atomic.ts";
import type { Dirs } from "./config.ts";

export const BROKER_KEY_FILENAME = "broker-key.json";
export const PAIRING_SECRET_FILENAME = "pairing-secret";

export const KEY_BYTES = 32;

/** `^[0-9a-f]{64}$` — every nonce and proof on the wire is checked against
 * this BEFORE any hex decoding (docs/PROTOCOL.md "Poignée de main v: 2"): a
 * value that doesn't match is an immediate failure, never an exception. */
export const HEX64_RE = /^[0-9a-f]{64}$/;

export interface BrokerKeyFile {
  v: 1;
  key: string; // 64 lowercase hex chars
  pid: number;
  startedAt: string; // ISO 8601 UTC
}

function brokerKeyPath(dirs: Pick<Dirs, "dataDir">): string {
  return join(dirs.dataDir, BROKER_KEY_FILENAME);
}

function pairingSecretPath(dirs: Pick<Dirs, "dataDir">): string {
  return join(dirs.dataDir, PAIRING_SECRET_FILENAME);
}

/** True iff `path` exists and is a regular file — via lstat, NEVER stat, so a
 * symlink at that path is itself inspected rather than followed (final
 * security review): a secret file is only ever created by this module with
 * atomicWriteFileSync, so anything else there (symlink, FIFO, device node —
 * e.g. planted by another local account sharing the data dir, or a race
 * before hardenDir's 0700 took effect) is refused rather than read through
 * or chmod'd, which would otherwise silently act on whatever it points to.
 * Absent path (lstat throws) is also `false` — callers distinguish "absent"
 * from "present but rejected" themselves via existsSync where they need to. */
function isRegularFileLstat(path: string): boolean {
  try {
    return lstatSync(path).isFile();
  } catch {
    return false;
  }
}

/** Generates a fresh 32-byte broker key. Kept in memory only by the caller —
 * this function never touches disk. */
export function generateBrokerKey(): Buffer {
  return randomBytes(KEY_BYTES);
}

export function keyToHex(key: Buffer): string {
  return key.toString("hex");
}

/** Parses a 64-lowercase-hex-char string into its 32 raw bytes, or undefined
 * if it doesn't match HEX64_RE. Never throws. */
export function hexToKey(hex: string): Buffer | undefined {
  if (!HEX64_RE.test(hex)) return undefined;
  try {
    return Buffer.from(hex, "hex");
  } catch {
    return undefined;
  }
}

/**
 * Writes broker-key.json, atomically, 0600, in a hardened 0700 dataDir. Must
 * only be called AFTER the broker has successfully bound its port
 * (docs/PROTOCOL.md: "seulement après que l'écoute sur le port a réussi") —
 * callers (server.ts) are responsible for that ordering.
 */
export function writeBrokerKeyFile(dirs: Pick<Dirs, "dataDir">, key: Buffer, pid: number, startedAt: string): void {
  hardenDir(dirs.dataDir);
  const file: BrokerKeyFile = { v: 1, key: keyToHex(key), pid, startedAt };
  atomicWriteFileSync(brokerKeyPath(dirs), JSON.stringify(file), 0o600);
}

/** True iff a process with this pid is alive AND belongs to the same OS
 * account as the caller — docs/PROTOCOL.md "Hôte natif": `process.kill(pid,
 * 0)` failing with either ESRCH (no such process) or EPERM (a process exists
 * but under another account) both mean "not our broker". Never throws. */
export function isSameAccountProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export type ReadBrokerKeyResult =
  | { ok: true; file: BrokerKeyFile }
  | { ok: false; reason: "broker-not-running" };

/** Reads and validates broker-key.json — used by the native host
 * (native-host.ts). Any of "file absent", "unreadable", "malformed JSON",
 * "wrong shape", "pid not alive under this account" collapses to the single
 * `broker-not-running` outcome (docs/PROTOCOL.md), never an exception. */
export function readBrokerKeyFile(dirs: Pick<Dirs, "dataDir">): ReadBrokerKeyResult {
  const path = brokerKeyPath(dirs);
  // Final security review: lstat before ever reading — a symlink planted at
  // this path (see isRegularFileLstat's comment) must never be followed by
  // the native host, which runs with the caller's own privileges and would
  // otherwise happily hand back the content of an arbitrary file as if it
  // were the broker key.
  if (existsSync(path) && !isRegularFileLstat(path)) {
    return { ok: false, reason: "broker-not-running" };
  }
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    return { ok: false, reason: "broker-not-running" };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { ok: false, reason: "broker-not-running" };
  }
  if (!parsed || typeof parsed !== "object") return { ok: false, reason: "broker-not-running" };
  const obj = parsed as Record<string, unknown>;
  if (obj.v !== 1 || typeof obj.key !== "string" || !HEX64_RE.test(obj.key)) {
    return { ok: false, reason: "broker-not-running" };
  }
  if (typeof obj.pid !== "number" || !Number.isInteger(obj.pid)) {
    return { ok: false, reason: "broker-not-running" };
  }
  if (typeof obj.startedAt !== "string") return { ok: false, reason: "broker-not-running" };
  if (!isSameAccountProcessAlive(obj.pid)) return { ok: false, reason: "broker-not-running" };
  return { ok: true, file: { v: 1, key: obj.key, pid: obj.pid, startedAt: obj.startedAt } };
}

/** Deletes broker-key.json on clean shutdown (SIGTERM/SIGINT), but ONLY if
 * the file's own `pid` still matches `pid` — docs/PROTOCOL.md "Effacement".
 * Never throws (best-effort — a broker exiting must not crash on this). */
export function deleteBrokerKeyFileIfOwned(dirs: Pick<Dirs, "dataDir">, pid: number): void {
  const path = brokerKeyPath(dirs);
  try {
    const raw = readFileSync(path, "utf8");
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    if (parsed.pid !== pid) return;
    unlinkSync(path);
  } catch {
    // Absent, unreadable, malformed: nothing to clean up.
  }
}

/**
 * Loads the legacy-mode permanent pairing secret S, creating it (32 random
 * bytes, hardened dir + file) if absent — docs/PROTOCOL.md "Mode hérité":
 * created once, at the first need (--show-pairing-secret, or first startup
 * with legacyPairing: true). Callers gate this on legacyPairing themselves —
 * this function has no opinion on the flag.
 */
export function loadOrCreatePairingSecret(dirs: Pick<Dirs, "dataDir">): Buffer {
  hardenDir(dirs.dataDir);
  const path = pairingSecretPath(dirs);
  if (existsSync(path)) {
    if (!isRegularFileLstat(path)) {
      // Final security review: refuse to chmodSync/readFileSync through a
      // symlink (or other non-regular file) at this path — see
      // isRegularFileLstat's comment. Removed outright and regenerated below,
      // same as any other malformed secret on disk.
      console.error(`coati-broker: refusing non-regular-file pairing secret at ${path}, regenerating`);
      try {
        unlinkSync(path);
      } catch {
        // Best-effort — atomicWriteFileSync below still replaces the
        // directory entry either way.
      }
    } else {
      // Re-assert 0600 even on the "already exists" path — same reasoning as
      // the rest of this codebase's secret files (a restore/sync tool could
      // have widened it).
      chmodSync(path, 0o600);
      const raw = readFileSync(path, "utf8").trim().toLowerCase();
      const key = hexToKey(raw);
      if (key) return key;
      // Malformed on disk (hand-edited, truncated): treat as absent and
      // regenerate, rather than handing back garbage bytes as a usable key.
    }
  }
  const key = generateBrokerKey();
  atomicWriteFileSync(path, keyToHex(key), 0o600);
  return key;
}

/** Deletes the legacy pairing-secret file if present — called at broker
 * startup when `legacyPairing` is off (docs/PROTOCOL.md "Mode hérité"; final
 * security review): a secret left over from a previous run with
 * `legacyPairing: true` must not keep sitting on disk, readable, once the
 * operator has turned the mode off. Logs exactly one line when it actually
 * removes something; silent (and never throws) when there is nothing to do —
 * the overwhelmingly common case. */
export function deletePairingSecretIfDisabled(dirs: Pick<Dirs, "dataDir">): void {
  const path = pairingSecretPath(dirs);
  if (!existsSync(path)) return;
  try {
    unlinkSync(path);
    console.error(`coati-broker: legacyPairing off — removed stale pairing secret at ${path}`);
  } catch {
    // Unremovable (permissions, race): best-effort, nothing more to do.
  }
}

// --- v: 2 handshake HMAC helpers -------------------------------------------

export const HMAC_BROKER_LABEL = "coati-v2-broker:";
export const HMAC_EXTENSION_LABEL = "coati-v2-extension:";

/** HMAC-SHA256(key, message), lowercase hex. */
export function hmacHex(key: Buffer, message: string): string {
  return createHmac("sha256", key).update(message, "utf8").digest("hex");
}

export function brokerProof(key: Buffer, cNonce: string, bNonce: string): string {
  return hmacHex(key, `${HMAC_BROKER_LABEL}${cNonce}:${bNonce}`);
}

export function extensionProof(key: Buffer, cNonce: string, bNonce: string): string {
  return hmacHex(key, `${HMAC_EXTENSION_LABEL}${cNonce}:${bNonce}`);
}

/**
 * Constant-time-safe comparison of two hex strings representing the wire
 * values of the v: 2 handshake (nonces, proofs). Validates BOTH against
 * HEX64_RE before decoding — an invalid shape is an immediate `false`, never
 * an exception (docs/PROTOCOL.md: "ne lève jamais"). Only ever compares two
 * equal-length (32-byte) buffers through timingSafeEqual.
 */
export function safeEqualHex(a: string, b: string): boolean {
  if (typeof a !== "string" || typeof b !== "string") return false;
  if (!HEX64_RE.test(a) || !HEX64_RE.test(b)) return false;
  try {
    const bufA = Buffer.from(a, "hex");
    const bufB = Buffer.from(b, "hex");
    if (bufA.length !== bufB.length) return false;
    return timingSafeEqual(bufA, bufB);
  } catch {
    return false;
  }
}

/** True iff `v` is a well-formed wire value per HEX64_RE — used to validate
 * nonces/proofs before any further processing (never decoded otherwise). */
export function isHex64(v: unknown): v is string {
  return typeof v === "string" && HEX64_RE.test(v);
}

/** Generates a fresh 32-byte nonce as a 64-lowercase-hex-char string. */
export function freshNonceHex(): string {
  return randomBytes(KEY_BYTES).toString("hex");
}
