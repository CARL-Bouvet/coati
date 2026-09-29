// Dedupe window for redetectTab(): the panel's own init (via openedFromGesture())
// and the "coati:action-clicked" message can both fire for the very same click —
// init when the click opened the panel, the message right after. Without this,
// a single icon click would trigger two page reads back to back. Keyed by tabId
// so a genuinely different tab is never skipped. Pulled out of panel.js so the
// bare comparison logic can be unit-tested without the rest of the panel's DOM
// and chrome.* dependencies.

export const REDETECT_DEDUPE_MS = 1500;

/**
 * True when a redetect for `tabId` should be SKIPPED because one already ran
 * for the same tab less than `windowMs` ago (default REDETECT_DEDUPE_MS).
 * A different tabId, or `lastTabId` still null (nothing ran yet), never
 * dedupes.
 */
export function isRedetectDuplicate(lastTabId, lastAt, tabId, now, windowMs = REDETECT_DEDUPE_MS) {
  return lastTabId != null && tabId === lastTabId && now - lastAt < windowMs;
}

/**
 * Extracts a valid tabId from a `coati:action-clicked` message, or null when
 * absent/malformed (e.g. the field is missing, a string, NaN…). Kept
 * separate from onRuntimeMessage so the "ignore a non-numeric tabId" case is
 * unit-testable without chrome.* stubs.
 */
export function parseActionClickedTabId(message) {
  return typeof message?.tabId === "number" && Number.isFinite(message.tabId) ? message.tabId : null;
}
