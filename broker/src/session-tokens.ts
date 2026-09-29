// In-memory session token store — docs/PROTOCOL.md "Poignée de main", "Jeton
// de session" (amendement 2026-09-25). A session token is 256 random bits
// (64 hex chars — the length alone distinguishes it from the 32-hex-char
// permanent secret), held ONLY in memory, keyed by its SHA-256 digest (so
// lookup never depends on the presented value's own bytes sitting around),
// bound to the origin it was issued to, capped at 64 entries with
// least-recently-used eviction. A broker restart drops this store entirely —
// every session token then becomes invalid, by construction (nothing here is
// ever written to disk).

import { randomBytes, createHash } from "node:crypto";

export const SESSION_TOKEN_CAP = 64;

interface TokenEntry {
  origin: string;
}

/** SHA-256 hex digest — exported so callers/tests can compute the same key a
 * store would use without needing a live store instance. */
export function sha256Hex(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

export class SessionTokenStore {
  // Map preserves insertion order; re-inserting a key (delete then set) moves
  // it to the end, which is exactly "most recently used" — the oldest entry
  // eligible for eviction is always the first key in iteration order.
  private byHash = new Map<string, TokenEntry>();

  /** Mints a fresh session token bound to `origin`, stores it, and evicts the
   * least-recently-used entry if this pushes the store over the cap. */
  issue(origin: string): string {
    const token = randomBytes(32).toString("hex"); // 64 hex chars
    this.byHash.set(sha256Hex(token), { origin });
    this.evictOverflow();
    return token;
  }

  /**
   * Looks up which origin `token` was issued to, or null if it is not a
   * known session token (wrong value, evicted, or the store was reset by a
   * broker restart). A successful lookup marks the entry most-recently-used.
   * Does NOT check whether that origin is still allowed/pinned — the spec
   * requires that check to happen against the CURRENT allow/pin state at the
   * time of this hello (see docs/PROTOCOL.md), which this store has no way
   * to know; that's the caller's job (server.ts).
   */
  lookupOrigin(token: string): string | null {
    const key = sha256Hex(token);
    const entry = this.byHash.get(key);
    if (!entry) return null;
    this.byHash.delete(key);
    this.byHash.set(key, entry);
    return entry.origin;
  }

  private evictOverflow(): void {
    while (this.byHash.size > SESSION_TOKEN_CAP) {
      const oldest = this.byHash.keys().next();
      if (oldest.done) break;
      this.byHash.delete(oldest.value);
    }
  }

  size(): number {
    return this.byHash.size;
  }
}
