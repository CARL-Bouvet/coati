// Unit tests for the "coati:action-clicked" re-read path (plan-lecture-des-pages-29-09.md,
// lot 5): the message a panel already open receives when the toolbar icon is
// clicked again, and the dedupe that stops it from racing the read init runs
// via openedFromGesture() when that same click opened the panel fresh.
import { describe, expect, test } from "bun:test";
import {
  isRedetectDuplicate,
  parseActionClickedTabId,
  REDETECT_DEDUPE_MS,
} from "../../extension/panel/redetect-dedupe.js";

describe("isRedetectDuplicate", () => {
  test("no prior redetect (lastTabId null) never dedupes", () => {
    expect(isRedetectDuplicate(null, 0, 7, 100)).toBe(false);
  });

  test("same tab, within the window: deduped", () => {
    expect(isRedetectDuplicate(7, 1000, 7, 1000 + REDETECT_DEDUPE_MS - 1)).toBe(true);
  });

  test("same tab, at or past the window: not deduped", () => {
    expect(isRedetectDuplicate(7, 1000, 7, 1000 + REDETECT_DEDUPE_MS)).toBe(false);
  });

  test("different tab, even immediately after: not deduped", () => {
    expect(isRedetectDuplicate(7, 1000, 8, 1000)).toBe(false);
  });

  test("custom window is honoured", () => {
    expect(isRedetectDuplicate(7, 1000, 7, 1500, 400)).toBe(false);
    expect(isRedetectDuplicate(7, 1000, 7, 1500, 600)).toBe(true);
  });
});

describe("parseActionClickedTabId", () => {
  test("a numeric tabId is returned as-is", () => {
    expect(parseActionClickedTabId({ type: "coati:action-clicked", tabId: 42 })).toBe(42);
  });

  test("tabId 0 is a valid tab id, not falsy-rejected", () => {
    expect(parseActionClickedTabId({ tabId: 0 })).toBe(0);
  });

  test("a missing tabId is ignored", () => {
    expect(parseActionClickedTabId({ type: "coati:action-clicked" })).toBeNull();
  });

  test("a non-numeric tabId is ignored", () => {
    expect(parseActionClickedTabId({ tabId: "7" })).toBeNull();
    expect(parseActionClickedTabId({ tabId: null })).toBeNull();
    expect(parseActionClickedTabId({ tabId: NaN })).toBeNull();
  });

  test("a non-object message is ignored", () => {
    expect(parseActionClickedTabId(null)).toBeNull();
    expect(parseActionClickedTabId(undefined)).toBeNull();
  });
});
