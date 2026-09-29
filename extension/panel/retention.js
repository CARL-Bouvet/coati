// Pure retention-window logic for the stored conversation history. Extracted
// so it can be unit-tested without any chrome.* mocking (see
// broker/test/retention.test.ts, following the pattern of detect.test.ts).
//
// Each stored message SHOULD carry a numeric `ts` (epoch ms), stamped the
// moment it was added. Messages persisted before this feature shipped carry
// no `ts` at all: applyRetention migrates them by stamping `now` rather than
// dropping them outright — their real age is unknown, so from this point on
// they are treated as fresh.

// chrome.storage.local key and default — shared by panel.js (reads it to
// filter the conversation on load) and options.js (the settings UI that
// writes it). Single source of truth (KISS audit 2026-09-26, item 9).
export const RETENTION_DAYS_KEY = "coati:retentionDays"; // number of days, or null for "jamais"
export const DEFAULT_RETENTION_DAYS = 30;

/** Reads back what `api.storage.local.get(RETENTION_DAYS_KEY)` returned:
 * `null` ("jamais", stored deliberately) and a finite number both pass
 * through as-is; anything else (never set, corrupted) falls back to the
 * default.
 * @param {number|null|undefined} stored
 * @returns {number|null}
 */
export function parseStoredRetentionDays(stored) {
  return stored === null || typeof stored === "number" ? stored : DEFAULT_RETENTION_DAYS;
}

/**
 * @param {Array<{id: string, ts?: number}>} messages
 * @param {number|null} retentionDays - number of days to keep messages for.
 *   `null` (or any value <= 0) means "jamais" — never expire.
 * @param {number} [now] - epoch ms, injected for testability. Defaults to
 *   Date.now().
 * @returns {Array} a new array: untimestamped messages stamped with `now`,
 *   then messages older than the retention window dropped.
 */
export function applyRetention(messages, retentionDays, now = Date.now()) {
  const stamped = (Array.isArray(messages) ? messages : []).map((msg) =>
    typeof msg.ts === "number" ? msg : { ...msg, ts: now },
  );

  if (retentionDays == null || retentionDays <= 0) return stamped;

  const cutoffMs = now - retentionDays * 24 * 60 * 60 * 1000;
  return stamped.filter((msg) => msg.ts >= cutoffMs);
}
