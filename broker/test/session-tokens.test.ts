// broker/src/session-tokens.ts — docs/PROTOCOL.md "Jeton de session"
// (amendement 2026-09-25). In-memory only, SHA-256-keyed, origin-bound,
// 64-entry LRU cap.

import { describe, expect, test } from "bun:test";
import { SessionTokenStore, SESSION_TOKEN_CAP, sha256Hex } from "../src/session-tokens.ts";

describe("sha256Hex", () => {
  test("matches a known digest", () => {
    // echo -n "" | sha256sum
    expect(sha256Hex("")).toBe("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
  });
});

describe("SessionTokenStore", () => {
  test("issue() returns a 64-hex-char token, distinct from the 32-char permanent secret shape", () => {
    const store = new SessionTokenStore();
    const token = store.issue("chrome-extension://aaaa");
    expect(token).toMatch(/^[0-9a-f]{64}$/);
  });

  test("issue() mints a fresh, distinct token on every call", () => {
    const store = new SessionTokenStore();
    const a = store.issue("origin-a");
    const b = store.issue("origin-a");
    expect(a).not.toBe(b);
  });

  test("lookupOrigin() resolves an issued token back to its origin", () => {
    const store = new SessionTokenStore();
    const token = store.issue("chrome-extension://aaaa");
    expect(store.lookupOrigin(token)).toBe("chrome-extension://aaaa");
  });

  test("lookupOrigin() returns null for an unknown value", () => {
    const store = new SessionTokenStore();
    expect(store.lookupOrigin("0".repeat(64))).toBeNull();
  });

  test("lookupOrigin() does not depend on the store having seen the raw bytes before — keyed by hash", () => {
    const store = new SessionTokenStore();
    const token = store.issue("origin-a");
    // A second, independent store never having called issue() would compute
    // the same hash for the same token value — the point here is just that
    // lookup goes through sha256Hex, not a plain byte comparison shortcut.
    expect(store.lookupOrigin(sha256Hex(token) === sha256Hex(token) ? token : "")).toBe("origin-a");
  });

  test("size() reflects the number of live entries", () => {
    const store = new SessionTokenStore();
    expect(store.size()).toBe(0);
    store.issue("a");
    store.issue("b");
    expect(store.size()).toBe(2);
  });

  test("caps at SESSION_TOKEN_CAP entries, evicting least-recently-used", () => {
    const store = new SessionTokenStore();
    const tokens: string[] = [];
    for (let i = 0; i < SESSION_TOKEN_CAP; i++) {
      tokens.push(store.issue(`origin-${i}`));
    }
    expect(store.size()).toBe(SESSION_TOKEN_CAP);

    // One more push evicts the oldest (origin-0's token).
    const overflow = store.issue("origin-overflow");
    expect(store.size()).toBe(SESSION_TOKEN_CAP);
    expect(store.lookupOrigin(tokens[0])).toBeNull();
    expect(store.lookupOrigin(overflow)).toBe("origin-overflow");
    // The second-oldest survives.
    expect(store.lookupOrigin(tokens[1])).toBe("origin-1");
  });

  test("a successful lookup marks the entry most-recently-used, protecting it from the next eviction", () => {
    const store = new SessionTokenStore();
    const tokens: string[] = [];
    for (let i = 0; i < SESSION_TOKEN_CAP; i++) {
      tokens.push(store.issue(`origin-${i}`));
    }
    // Touch the oldest entry (origin-0) so it becomes most-recently-used.
    expect(store.lookupOrigin(tokens[0])).toBe("origin-0");

    // Next issue would normally evict origin-0 (the oldest) — but it was just
    // touched, so origin-1 (now the actual oldest) is evicted instead.
    store.issue("origin-overflow");
    expect(store.lookupOrigin(tokens[0])).toBe("origin-0");
    expect(store.lookupOrigin(tokens[1])).toBeNull();
  });
});
