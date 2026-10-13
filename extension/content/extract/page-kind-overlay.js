// ==========================================================================
// docs/PROTOCOL.md, "Types de page,
// facts and entries". Everything below decides `pageKind` and fills
// `facts`/`items`. Any exception in here is caught by buildPageKindContext()
// and degrades to `pageKind: "other"` with today's plain text — "Une
// exception … never makes the extraction fail."
//
// NOTE on the detect.js/extract.js split (read before touching this): the
// same decision logic (overlay exclusion, pageKind rules, facts/items caps)
// is also implemented, exported, and unit-tested as pure functions in
// extension/content/detect.js. It is duplicated here, not imported: this
// file is injected as a classic (non-module) content script via
// `chrome.scripting.executeScript({ files: [...] })|, which cannot `import`
// an ES module, and there is no browser available in this sandbox to verify
// a dynamic `import()` of an extension resource from a content script's
// isolated world. Duplication was the conservative, verifiable choice.
// Keep the two in sync by construction: same constants, same thresholds,
// same order of checks — detect.test.ts is the source of truth for the
// rules; extract.test.ts checks this copy produces the same outcomes on
// realistic DOM shapes.
//
// Part of the content/extract.js content script (split) — this file
// (page-kind-overlay.js) covers the "stacked layers" step: the
// constants shared by the whole page-kind pipeline, the consent-banner
// lexicon, and overlay-layer resolution. See content/extract-files.js for
// the full load order.
// ==========================================================================

// Page-content heuristic (detects cookie-consent banners on arbitrary
// pages, in whatever language they're written), not extension UI text —
// deliberately mixes French and English words, see below.
var CONSENT_LEXICON = [
  "cookie",
  "cookies",
  "consentement", // i18n-allow: page-content heuristic word, not UI text
  "vie privée", // i18n-allow: page-content heuristic word, not UI text
  "confidentialité", // i18n-allow: page-content heuristic word, not UI text
  "rgpd",
  "traceurs",
  "consent",
  "privacy",
  "gdpr",
];
var CONSENT_CONTROL_WORDS = [
  "tout accepter",
  "j'accepte",
  "tout refuser",
  "continuer sans accepter",
  "accepter",
  "refuser",
  "accept",
  "agree",
  "reject",
];
var OVERLAY_COVERAGE_THRESHOLD = 0.3;
var EDGE_BAND_WIDTH_RATIO = 0.8;
var CONTENT_LAYER_MIN_CHARS = 500;
var LEXICAL_ONLY_MAX_CHARS = 1500;
var OVERLAY_FALLBACK_MIN_VISIBLE_CHARS = 200;
var EDGE_SNAP_PX = 40; // "stuck to the edge" — small tolerance, not a protocol constant.
var ARTICLE_TEXT_THRESHOLD = 1200; // same value as detect.js's classifyPageType.
var OVERLAY_SELECTOR =
  'dialog, [role="dialog"], [role="alertdialog"], [aria-modal], div, section, aside, header, footer, nav';
var FACT_CAPS = { count: 40, label: 60, value: 160 };
var ITEM_CAPS = { count: 40, title: 160, price: 40, location: 80, detail: 200 };
var LIST_MIN_GROUP_SIZE = 5;
var LIST_ENTRY_MIN_CHARS = 20;
var LIST_ENTRY_MAX_CHARS = 1000;
// Correction n°1 — "se cherche en remontant, sur six niveaux au plus."
// Measured: on bienici's results page the densest block (the featured
// listing's description) sits more than six levels below the results container.
// Twelve levels are enough and stay bounded.
var MAX_ANCESTOR_LEVELS = 12;

function normalizeFieldText(text) {
  return (text || "")
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function truncateField(text, max) {
  if (text.length <= max) return text;
  return `${text.slice(0, Math.max(0, max - 1))}…`;
}

// A number is `\d(?:[\d\s.,]*\d)?` — starts AND ENDS with a digit, so a
// separator (comma, period, space) can never bridge an unrelated number to
// a unit further down the string. Without the trailing `\d`, "2007, p.
// 1076" (a bibliography citation) matched as "2007" + unit "p." — measured
// On the Wikipedia "Coati" corpus page: it is what actually made the
// infobox's chief-numeric-fact check pass and misclassified the page as
// `listing`. Never a bare number either way ("21 langues" still has no
// match: no currency, and "langues" isn't a listed unit).
var NUMERIC_VALUE_RE = /(?:[€$£]\s?\d(?:[\d\s.,]*\d)?|\d(?:[\d\s.,]*\d)?\s?(?:€|EUR|\$|£|m²|m2|km|pièces?|p\.|ch\.))/i; // i18n-allow: page-content unit heuristic, not UI text
function hasNumericValue(text) {
  return NUMERIC_VALUE_RE.test(text || "");
}
var CURRENCY_VALUE_RE = /(?:[€$£]\s?\d(?:[\d\s.,]*\d)?|\d(?:[\d\s.,]*\d)?\s?(?:€|EUR|\$|£))/i;
function firstCurrencyValue(text) {
  const match = CURRENCY_VALUE_RE.exec(text || "");
  return match ? match[0].trim() : undefined;
}
var LOCATION_RE = /\b\d{5}\b|\(\d{2,3}\)/;
function looksLikeLocation(text) {
  return LOCATION_RE.test(text || "");
}

function hasConsentLexicon(text) {
  const lower = (text || "").toLowerCase();
  return CONSENT_LEXICON.some((word) => lower.includes(word));
}
function hasConsentControlWords(texts) {
  return (texts || []).some((raw) => {
    const lower = (raw || "").trim().toLowerCase();
    return CONSENT_CONTROL_WORDS.some((word) => lower === word || lower.startsWith(`${word} `));
  });
}
function isDialogLike(sig) {
  return !!(sig.isDialogRole || sig.isAriaModal || sig.isOpenDialogElement);
}
function isFixedOrSticky(sig) {
  return sig.position === "fixed" || sig.position === "sticky";
}
// Measured on bienici: a fixed element is neither
// a layer to drop nor the content on its position alone. The results list
// (#searchSideView, 4,535 chars) and a listing's contact card are both fixed.
// Only a dialog is a strong signal.
function hasStrongStructuralSignal(sig) {
  return isDialogLike(sig);
}
function hasWeakStructuralSignal(sig) {
  return (
    !isDialogLike(sig) &&
    isFixedOrSticky(sig) &&
    ((sig.coverageRatio || 0) >= OVERLAY_COVERAGE_THRESHOLD || !!sig.dockedToEdge)
  );
}
function hasLexicalConfirmation(sig) {
  return hasConsentLexicon(sig.visibleText || "") && hasConsentControlWords(sig.controlTexts || []);
}
// "Exclusion lexicale seule" — trois garde-fous.
function isLexicalOnlyExcludable(sig) {
  if (hasStrongStructuralSignal(sig) || isFixedOrSticky(sig)) return false;
  return (
    hasLexicalConfirmation(sig) &&
    (sig.visibleText || "").length < LEXICAL_ONLY_MAX_CHARS &&
    !sig.containsH1 &&
    !sig.containsMainRegion
  );
}
// "A layer can be the content".
function isContentLayer(sig) {
  return (
    hasStrongStructuralSignal(sig) &&
    (sig.visibleText || "").length >= CONTENT_LAYER_MIN_CHARS &&
    !hasLexicalConfirmation(sig)
  );
}
function shouldExcludeLayer(sig) {
  if (hasStrongStructuralSignal(sig)) return !isContentLayer(sig);
  // A banner is short: a long fixed element is never dropped.
  if (hasWeakStructuralSignal(sig)) {
    return hasLexicalConfirmation(sig) && (sig.visibleText || "").length < LEXICAL_ONLY_MAX_CHARS;
  }
  return isLexicalOnlyExcludable(sig);
}

function viewportSize() {
  const w =
    typeof window !== "undefined" && typeof window.innerWidth === "number" && window.innerWidth > 0
      ? window.innerWidth
      : 1024;
  const h =
    typeof window !== "undefined" && typeof window.innerHeight === "number" && window.innerHeight > 0
      ? window.innerHeight
      : 768;
  return { w, h };
}

function safeComputedPosition(el) {
  try {
    if (typeof getComputedStyle !== "function") return "static";
    const style = getComputedStyle(el);
    return (style && style.position) || "static";
  } catch {
    return "static";
  }
}

function safeRect(el) {
  try {
    return typeof el.getBoundingClientRect === "function" ? el.getBoundingClientRect() : null;
  } catch {
    return null;
  }
}

function rectMetrics(rect, viewport) {
  if (!rect) return { coverageRatio: 0, dockedToEdge: false };
  const width = Math.max(0, rect.width != null ? rect.width : (rect.right || 0) - (rect.left || 0));
  const height = Math.max(0, rect.height != null ? rect.height : (rect.bottom || 0) - (rect.top || 0));
  const area = viewport.w * viewport.h;
  const coverageRatio = area > 0 ? (width * height) / area : 0;
  const wideEnough = width >= EDGE_BAND_WIDTH_RATIO * viewport.w;
  const top = rect.top != null ? rect.top : 0;
  const bottom = rect.bottom != null ? rect.bottom : top + height;
  const dockedToEdge = wideEnough && (Math.abs(top) <= EDGE_SNAP_PX || Math.abs(viewport.h - bottom) <= EDGE_SNAP_PX);
  return { coverageRatio, dockedToEdge };
}

function controlTextsOf(el) {
  if (typeof el.querySelectorAll !== "function") return [];
  try {
    return Array.from(el.querySelectorAll('button, a, [role="button"]'))
      .map((c) => visibleText(c).trim())
      .filter(Boolean);
  } catch {
    return [];
  }
}

function collectOverlayCandidates(viewport, guardMainRegionEl, h1El) {
  if (!document.body || typeof document.body.querySelectorAll !== "function") return [];
  let nodes;
  try {
    nodes = document.body.querySelectorAll(OVERLAY_SELECTOR);
  } catch {
    return [];
  }
  const out = [];
  for (const el of nodes) {
    // A layer the user cannot see is neither content nor an obstacle. Without
    // this, a closed dialog (display:none: its innerText falls back to the raw
    // textContent) passed the content-layer test and replaced the whole page —
    // measured on Le Monde, Amazon and Stack Overflow, all hidden role=dialog.
    if (!isRenderedCandidate(el)) continue;
    const rect = safeRect(el);
    const { coverageRatio, dockedToEdge } = rectMetrics(rect, viewport);
    out.push({
      el,
      isDialogRole: el.getAttribute("role") === "dialog" || el.getAttribute("role") === "alertdialog",
      isAriaModal: el.getAttribute("aria-modal") === "true",
      isOpenDialogElement: el.tagName === "DIALOG" && el.getAttribute("open") != null,
      position: safeComputedPosition(el),
      coverageRatio,
      dockedToEdge,
      visibleText: normalizeFieldText(visibleText(el)),
      controlTexts: controlTextsOf(el),
      containsH1: !!(h1El && typeof el.contains === "function" && el.contains(h1El)),
      containsMainRegion: !!(guardMainRegionEl && typeof el.contains === "function" && el.contains(guardMainRegionEl)),
    });
  }
  return out;
}

// Step 1 — "Stacked layers — excluded before any measurement". Returns
// `{ contentRoot, excludedEls }`: when a layer is judged to BE the content
// (docs/PROTOCOL.md "a layer can be the content"), `contentRoot` is
// that element and the rest of the page is ignored; otherwise `contentRoot`
// is null and `excludedEls` lists what to subtract from every measurement.
function resolveOverlayExclusion() {
  const viewport = viewportSize();
  const h1El = typeof document.querySelector === "function" ? document.querySelector("h1") : null;
  const guardMainRegionEl =
    typeof document.querySelector === "function" ? document.querySelector("article, main, [role='main']") : null;
  const candidates = collectOverlayCandidates(viewport, guardMainRegionEl, h1El);

  const contentLayers = candidates.filter(isContentLayer);
  if (contentLayers.length) {
    // "If there are several, the topmost in the stack (the last one
    // in document order, for lack of better)."
    const chosen = contentLayers[contentLayers.length - 1];
    return { contentRoot: chosen.el, excludedEls: [] };
  }

  const excludedEls = candidates.filter(shouldExcludeLayer).map((c) => c.el);
  return { contentRoot: null, excludedEls };
}

function isWithinExcluded(el, excludedEls) {
  return (excludedEls || []).some((ex) => ex === el || (typeof ex.contains === "function" && ex.contains(el)));
}
