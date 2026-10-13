// chrome.storage.local key and default for the "Montrer du doigt" highlight
// intensity — read by point-at.js right before pointing, per click, and
// written by the level slider next to an answer's first "Montrer" button.
// Same single-source-of-truth pattern as RETENTION_DAYS_KEY in retention.js.
//
// Not a secret (CLAUDE.md rule #1): a visual preference, fine in
// chrome.storage.local.
//
// Deliberately NOT imported by content/pointer.js — that file is a classic
// content script loaded via `files: [...]` and cannot `import` (see its own
// header comment). `normalizeEffect` is duplicated there on purpose; kept in
// sync by the small, fixed set of three values.

export const POINT_EFFECT_KEY = "coati:pointEffect";
export const DEFAULT_POINT_EFFECT = "strong";

/**
 * @param {unknown} stored - whatever `api.storage.local.get(POINT_EFFECT_KEY)` returned.
 * @returns {"subtle"|"strong"|"spectacular"}
 */
export function parseStoredPointEffect(stored) {
  return stored === "subtle" || stored === "spectacular" ? stored : DEFAULT_POINT_EFFECT;
}
