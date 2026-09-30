// Pure helpers for "the page cannot usefully be read" (goal G2, T46-T47,
// docs/DECISIONS.md; extraction result shape from extract.js, worker A).
// No DOM, no chrome.* — kept separate from panel.js so both are unit
// testable without a browser (see broker/test/ui-unreadable.test.ts).

import { t } from "../lib/i18n.js";

const HINT = t("panel_unreadable_hint");

export const PDF_MESSAGE = `${t("panel_unreadable_pdf")} ${HINT}`;
export const CANVAS_MESSAGE = `${t("panel_unreadable_canvas")} ${HINT}`;
export const EMPTY_MESSAGE = `${t("panel_unreadable_empty")} ${HINT}`;

/** True when `url`'s path (ignoring query/fragment) ends in ".pdf" — the
 * browser's own PDF viewer refuses script injection there, so extraction
 * never even reaches extract.js for this case. Case-insensitive; malformed
 * input is never a PDF. */
export function isPdfUrl(url) {
  if (typeof url !== "string" || !url) return false;
  try {
    return /\.pdf$/i.test(new URL(url).pathname);
  } catch {
    return false;
  }
}

/** Maps extract.js's `context.readability` ("ok" | "canvas" | "empty",
 * amendment T45/T46) to the ready-to-display French message, or `null` when
 * the page is readable (or the field is absent — an older client). */
export function readabilityMessage(readability) {
  if (readability === "canvas") return CANVAS_MESSAGE;
  if (readability === "empty") return EMPTY_MESSAGE;
  return null;
}

/** `context` sent to the broker must never carry `readability` — it exists
 * only for this panel's own local decision (docs/PROTOCOL.md's `Context`
 * shape has no such field). Returns a new object; never mutates `context`. */
export function stripReadability(context) {
  if (!context || typeof context !== "object" || !("readability" in context)) return context;
  const { readability, ...rest } = context;
  return rest;
}
