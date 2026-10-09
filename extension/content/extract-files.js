// Ordered list of the files making up the content/extract.js content
// script (lot F4 split) — single source of truth for anyone who needs to
// inject or evaluate them together, in order:
//   - chrome.scripting.executeScript({ files: EXTRACT_FILES.map(f => "/" + f) })
//     (the panel — see extension/panel/page-extract.js's extractFromTab()).
//   - Node/bun tests that eval the content script against a fake DOM (see
//     broker/test/extract*.test.ts).
//
// Plain ESM data module, no DOM/BOM dependency — importable from a bun
// test file directly. extract.js MUST stay last: chrome.scripting
// .executeScript's result, for a multi-file injection, is the completion
// value of the LAST file executed, and it is the only file ending in a
// bare expression statement (the others are pure function/var
// declarations — see each file's own header comment).
//
// Keep in sync with extension/lib/build-fingerprint.js's FINGERPRINT_FILES
// and scripts/stamp.sh's FILES (both list every one of these individually,
// same as the old single content/extract.js entry) — not imported there,
// those two are plain file lists maintained by hand on purpose (see their
// own comments).
export const EXTRACT_FILES = [
  "content/extract/sanitize.js",
  "content/extract/dom-visibility.js",
  "content/extract/article-youtube.js",
  "content/extract/page-kind-overlay.js",
  "content/extract/page-kind-region.js",
  "content/extract/page-kind-facts-items.js",
  "content/extract/page-kind-structure.js",
  "content/extract/clickable-elements.js",
  "content/extract.js",
];
