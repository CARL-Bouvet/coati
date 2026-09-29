// Unit tests for the conversation retention-window logic. It lives under
// extension/panel/ (see comment there for why) but is plain, DOM-free JS, so
// it imports and runs fine from the broker's test runner without any browser
// mocking — same pattern as detect.test.ts.
import { describe, expect, test } from "bun:test";
import { applyRetention } from "../../extension/panel/retention.js";

const DAY_MS = 24 * 60 * 60 * 1000;

describe("applyRetention", () => {
  test("drops messages older than the retention window", () => {
    const now = 1_000_000 * DAY_MS;
    const messages = [
      { id: "old", ts: now - 31 * DAY_MS },
      { id: "recent", ts: now - 1 * DAY_MS },
    ];
    const result = applyRetention(messages, 30, now);
    expect(result.map((m) => m.id)).toEqual(["recent"]);
  });

  test("keeps a message exactly at the cutoff boundary", () => {
    const now = 1_000_000 * DAY_MS;
    const messages = [{ id: "boundary", ts: now - 30 * DAY_MS }];
    const result = applyRetention(messages, 30, now);
    expect(result.map((m) => m.id)).toEqual(["boundary"]);
  });

  test("stamps untimestamped messages with now instead of dropping them", () => {
    const now = 1_000_000 * DAY_MS;
    const messages = [{ id: "legacy", role: "user", text: "hi" }];
    const result = applyRetention(messages, 30, now);
    expect(result).toHaveLength(1);
    expect(result[0].ts).toBe(now);
    expect(result[0].id).toBe("legacy");
  });

  test("'jamais' (null) keeps everything regardless of age", () => {
    const now = 1_000_000 * DAY_MS;
    const messages = [
      { id: "ancient", ts: now - 10_000 * DAY_MS },
      { id: "recent", ts: now - 1 * DAY_MS },
    ];
    const result = applyRetention(messages, null, now);
    expect(result.map((m) => m.id)).toEqual(["ancient", "recent"]);
  });

  test("non-array input is treated as empty", () => {
    expect(applyRetention(undefined, 30)).toEqual([]);
  });

  test("does not mutate the input array", () => {
    const now = 1_000_000 * DAY_MS;
    const messages = [{ id: "a", ts: now - 40 * DAY_MS }];
    const result = applyRetention(messages, 30, now);
    expect(result).not.toBe(messages);
    expect(messages).toHaveLength(1);
  });
});
