// Coati content script — injected on demand via chrome.scripting.executeScript.
//
// Extracts plain, sanitized TEXT from the page. Never returns HTML, never
// touches innerHTML: page content is data for the model, never an
// instruction (see CLAUDE.md, security rule 3). The completion value of this
// IIFE becomes the injection result read by the caller (panel.js).
//
// Why innerText and not textContent: textContent returns the raw source text,
// including hidden elements, and inserts nothing between block elements. On
// pages whose HTML is generated without whitespace between tags — most React
// and JSX sites, Medium among them — "<h1>Title</h1><p>Body</p>" comes out as
// "TitleBody". innerText returns the text as rendered: line breaks at block
// boundaries, hidden elements skipped. It costs a layout pass, which is fine
// for a one-shot extraction on a page the user is looking at.
//
// SPLIT NOTE (lot F4): this content script is loaded as several classic
// (non-module) files, injected in order — see content/extract-files.js for
// the authoritative, ordered list, and extension/content/extract.js (the
// last file) for the entry point whose completion value is read by the
// caller. All files share one global scope (the tab's isolated world), same
// as content/pointer.js. Every top-level binding below is declared with
// `var`/`function` rather than `const`/`let`: a top-level `const`/`let` would
// throw "already declared" if this same file is ever injected a second time
// into the same page (e.g. the user re-triggers a page read on the same
// tab) — `var`/`function` redeclare safely, the same guarantee the original
// single-file version got for free by wrapping its entire body in one IIFE.

// Zero-width characters (U+200B-U+200D, U+2060 word joiner, U+FEFF BOM/
// zero-width no-break space) carry no visible glyph but do carry bytes a
// hostile page can use to smuggle a hidden instruction past a human eye —
// strip them everywhere, unconditionally (T45, section 5 point 6). Built
// from numeric code points, not a `\u` regex escape: this source file is
// plain-text-reviewed, and a literal invisible character sitting in the
// regex source itself would be both unreadable in review and fragile
// across editors/encodings.
var MAX_CHARS = 40000;
var ZERO_WIDTH_CODEPOINTS = [0x200b, 0x200c, 0x200d, 0x2060, 0xfeff];
var ZERO_WIDTH_CHARS = ZERO_WIDTH_CODEPOINTS.map((code) => String.fromCharCode(code));

function stripZeroWidth(text) {
  let out = text;
  for (const ch of ZERO_WIDTH_CHARS) out = out.split(ch).join("");
  return out;
}

function truncate(text, max = MAX_CHARS) {
  const clean = stripZeroWidth(text || "")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/^[ \t]+|[ \t]+$/gm, "")
    .trim();
  return clean.length > max ? clean.slice(0, max) : clean;
}

function visibleText(el) {
  if (!el) return "";
  // innerText is undefined on some non-HTMLElement nodes; fall back rather
  // than throwing.
  return typeof el.innerText === "string" ? el.innerText : el.textContent || "";
}

// A [contenteditable] subtree (a draft email, an unsent comment box) is
// "visible" as far as innerText is concerned, so it rides along with
// whatever container contains it. It was never intentionally shared by the
// user's click — exclude it before the text is sent anywhere. We can't just
// skip the container itself (the draft is usually nested a few levels
// inside an otherwise legitimate article/main), so instead strip out each
// editable descendant's own rendered text from the container's text.
function textExcludingEditable(el) {
  return textExcludingNodes(el, []);
}

// Generalization of the above: also subtracts the rendered text of any
// element in `extraExcludedEls` that sits inside `el` (an excluded overlay
// layer nested inside the body, a repeated list entry nested inside the
// region a fact scan runs over…). Used by the Amendement 2026-09-25 page-
// type pipeline below; `textExcludingEditable` keeps its old, narrower
// behavior for the density heuristic's existing callers/tests.
function textExcludingNodes(el, extraExcludedEls) {
  const text = visibleText(el);
  if (!el || typeof el.querySelectorAll !== "function") return text;
  let editableDescendants = [];
  try {
    editableDescendants = Array.from(el.querySelectorAll("[contenteditable]"));
  } catch {
    editableDescendants = [];
  }
  const excludedDescendants = (extraExcludedEls || []).filter(
    (node) => node && node !== el && typeof el.contains === "function" && el.contains(node),
  );
  const allExcluded = editableDescendants.concat(excludedDescendants);
  if (!allExcluded.length) return text;
  // Longest fragment first: a region nested inside another excluded
  // region must not be subtracted twice from an already-shortened string.
  const fragments = allExcluded
    .map((node) => visibleText(node))
    .filter(Boolean)
    .sort((a, b) => b.length - a.length);
  return fragments.reduce((acc, fragment) => acc.split(fragment).join(""), text);
}
