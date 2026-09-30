// Shared low-level file/directory hardening helpers — docs/PROTOCOL.md
// "Écoute exclusive du port, durcissement du dossier et fichiers temporaires"
// (amendement 2026-09-30, G4, security review). Used by config.ts (config.json,
// data/config dirs) and broker-key.ts (broker-key.json, pairing-secret).
//
// Two independent guarantees:
//  1. hardenDir(): a data/config directory must never be a symlink, and (POSIX
//     only) must belong to the current user — otherwise the broker refuses to
//     start rather than follow the link or read/write into another account's
//     directory. An existing directory with wider-than-0700 permissions is
//     re-tightened, every call (not just at creation).
//  2. atomicWriteFileSync(): every secret/config file (broker-key.json,
//     pairing-secret, config.json) is written via a `<path>.tmp` opened
//     O_CREAT|O_EXCL|O_NOFOLLOW (never follows a symlink, never reuses an
//     existing file under that name), a leftover .tmp from a previous crash is
//     unlinked first, then renamed atomically over the real path — a reader
//     never observes a half-written file.

import {
  chmodSync,
  closeSync,
  constants,
  existsSync,
  lstatSync,
  mkdirSync,
  openSync,
  renameSync,
  unlinkSync,
  writeSync,
} from "node:fs";

/** Thrown by hardenDir() when the directory is unsafe to use — the caller
 * (server.ts's startup path) lets this propagate and exits rather than
 * silently following a symlink or writing into another account's directory. */
export class UnsafeDirError extends Error {}

/**
 * Ensures `dir` is safe to hold secrets: not a symlink, owned by the current
 * user (POSIX only — Windows has no UID concept here, see docs/PROTOCOL.md
 * "Windows"), and mode 0700. Creates it (mode 0700) if absent. Throws
 * UnsafeDirError for a symlink or a wrong owner — never silently proceeds.
 */
export function hardenDir(dir: string): void {
  let st;
  try {
    st = lstatSync(dir);
  } catch {
    st = undefined;
  }
  if (!st) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    return;
  }
  if (st.isSymbolicLink()) {
    throw new UnsafeDirError(`refusing to start: ${dir} is a symlink`);
  }
  if (process.platform !== "win32" && typeof process.getuid === "function") {
    const uid = process.getuid();
    if (st.uid !== uid) {
      throw new UnsafeDirError(`refusing to start: ${dir} is owned by another user (uid ${st.uid}, expected ${uid})`);
    }
  }
  if ((st.mode & 0o777) !== 0o700) {
    chmodSync(dir, 0o700);
  }
}

/**
 * Atomic, hardened write: `<path>.tmp` created O_CREAT|O_EXCL|O_NOFOLLOW at
 * `mode` (never follows a symlink left at that name, never silently
 * overwrites a file another process just created there), a leftover .tmp from
 * an earlier crash is unlinked first (ENOENT ignored), then renamed over
 * `path`. The directory holding `path` must already exist and be hardened
 * (see hardenDir) — this function does not create it.
 */
export function atomicWriteFileSync(path: string, data: string | Buffer, mode: number): void {
  const tmpPath = `${path}.tmp`;
  try {
    unlinkSync(tmpPath);
  } catch {
    // ENOENT (no leftover) or anything else: proceed — the O_EXCL open below
    // is the real safety net, not this best-effort cleanup.
  }
  const fd = openSync(tmpPath, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, mode);
  try {
    const buf = typeof data === "string" ? Buffer.from(data, "utf8") : data;
    writeSync(fd, buf);
  } finally {
    closeSync(fd);
  }
  // Re-assert mode: O_CREAT's mode argument is subject to umask, so an
  // over-permissive umask could otherwise widen the file.
  chmodSync(tmpPath, mode);
  renameSync(tmpPath, path);
}

/** True iff `path` exists (any type) — thin wrapper so callers don't import
 * node:fs directly just for this one check. */
export function pathExists(path: string): boolean {
  return existsSync(path);
}
