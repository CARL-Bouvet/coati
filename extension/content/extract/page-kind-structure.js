// ==========================================================================
// T45 (docs/DECISIONS.md) — shadow DOM, invisible text, structure, readability.
// points 3, 5, 6 and 4 of T45.
//
// Part of the content/extract.js content script (split) — this file
// also defines buildPageKindContext(), the orchestrator for steps 1-5 of the
// "types de page" pipeline. See content/extract-files.js for the full load
// order.
// ==========================================================================

// Step — shadow DOM (section 5 point 3). `innerText`/`querySelectorAll`
// never pierce a shadow boundary; MDN alone measured 57 shadow hosts,
// 53 000 hidden characters. Both API shapes are feature-detected and
// wrapped: `el.shadowRoot` is null for a closed root, Chrome exposes
// `chrome.dom.openOrClosedShadowRoot(el)`, Firefox exposes
// `el.openOrClosedShadowRoot()` — never assume either exists.
function getOpenOrClosedShadowRoot(el) {
  if (!el) return null;
  try {
    if (el.shadowRoot) return el.shadowRoot;
  } catch {
    // fall through
  }
  try {
    if (
      typeof chrome !== "undefined" &&
      chrome &&
      chrome.dom &&
      typeof chrome.dom.openOrClosedShadowRoot === "function"
    ) {
      const root = chrome.dom.openOrClosedShadowRoot(el);
      if (root) return root;
    }
  } catch {
    // fall through
  }
  try {
    if (typeof el.openOrClosedShadowRoot === "function") {
      const root = el.openOrClosedShadowRoot();
      if (root) return root;
    }
  } catch {
    // fall through
  }
  return null;
}

var SHADOW_MAX_DEPTH = 6; // bounded — a shadow tree recursing further is a bug in the page, not content.

// A ShadowRoot is a DocumentFragment: it has no `.innerText`. Approximate
// its rendered text by summing each direct child's own rendered text,
// through the same `isRenderedCandidate` gate as everything else — a
// closed-off, hidden custom element inside a shadow tree should not leak
// in either.
function shadowRootOwnText(root) {
  let children = [];
  try {
    children = root && root.children ? Array.from(root.children) : [];
  } catch {
    children = [];
  }
  const parts = [];
  for (const child of children) {
    if (!isRenderedCandidate(child)) continue;
    const t = visibleText(child).trim();
    if (t) parts.push(t);
  }
  return parts.join("\n");
}

function shadowRootText(root, depth) {
  if (!root || depth > SHADOW_MAX_DEPTH) return "";
  const ownText = shadowRootOwnText(root);
  let hostEls = [];
  try {
    hostEls = typeof root.querySelectorAll === "function" ? Array.from(root.querySelectorAll("*")) : [];
  } catch {
    hostEls = [];
  }
  const nestedParts = [];
  for (const host of hostEls) {
    const nestedRoot = getOpenOrClosedShadowRoot(host);
    if (nestedRoot) {
      const t = shadowRootText(nestedRoot, depth + 1);
      if (t) nestedParts.push(t);
    }
  }
  return [ownText, ...nestedParts].filter(Boolean).join("\n\n");
}

// Collects the rendered text of every shadow root found inside `root`
// (root included). Never throws — a page that throws on `querySelectorAll`
// or exposes a broken shadow API degrades to "no shadow text found", same
// as the rest of this file's "an exception never fails the extraction".
function collectShadowText(root, excludedEls) {
  if (!root) return "";
  let hostEls = [];
  try {
    hostEls = typeof root.querySelectorAll === "function" ? Array.from(root.querySelectorAll("*")) : [];
  } catch {
    hostEls = [];
  }
  hostEls.unshift(root);
  const parts = [];
  const seen = new Set();
  for (const host of hostEls) {
    if (seen.has(host)) continue;
    seen.add(host);
    if (isWithinExcluded(host, excludedEls)) continue;
    const shadow = getOpenOrClosedShadowRoot(host);
    if (!shadow) continue;
    const t = shadowRootText(shadow, 0);
    if (t) parts.push(t);
  }
  return parts.join("\n\n");
}

// Step — invisible-to-the-eye text (section 5 point 6). Zero-width
// characters are handled textually in `truncate()`; the checks below catch
// the DOM-level techniques (screen-reader-only clipping, off-screen
// positioning, near-zero font size, same-colour-as-background) and feed
// their elements into the SAME `excludedEls` subtraction mechanism already
// used for overlays and contenteditable drafts (`textExcludingNodes`) —
// no new plumbing, every caller downstream benefits automatically. Page
// content stays data, never an instruction (project rule 16); this is a
// conservative reduction of the injection surface, not a security boundary
// on its own.
function isNearZeroFontSize(el) {
  try {
    if (typeof getComputedStyle !== "function") return false;
    const style = getComputedStyle(el);
    if (!style || !style.fontSize) return false;
    const px = parseFloat(style.fontSize);
    return Number.isFinite(px) && px > 0 && px <= 1.5;
  } catch {
    return false;
  }
}

var CLIP_ZERO_RE = /rect\(\s*0(px)?[,\s]+0(px)?[,\s]+0(px)?[,\s]+0(px)?\s*\)/i;
function isClippedSrOnly(el) {
  try {
    if (typeof getComputedStyle !== "function") return false;
    const style = getComputedStyle(el);
    if (!style) return false;
    if (style.clip && CLIP_ZERO_RE.test(style.clip)) return true;
    if (style.clipPath && /inset\(\s*100%/i.test(style.clipPath)) return true;
  } catch {
    return false;
  }
  return false;
}

var OFFSCREEN_MARGIN_PX = 100; // tolerance — a lazy-load offset just above the fold is not "off-screen"
// `getBoundingClientRect` is relative to the CURRENT viewport, not the
// document — and extract.js can run at any scroll position (it's injected
// on a user gesture on whatever the tab currently shows). A long article's
// opening paragraphs, scrolled past, would have a negative top/bottom at
// that instant: reading that as "off-screen" would delete real content.
// The classic hiding technique (`left: -9999px` and relatives) always
// pairs with `position: fixed`/`absolute` — normal flowed prose can't
// reach those coordinates any other way — so require that position too.
function isOffscreen(el, viewport) {
  const position = safeComputedPosition(el);
  if (position !== "fixed" && position !== "absolute") return false;
  const rect = safeRect(el);
  if (!rect) return false;
  const right = rect.right != null ? rect.right : (rect.left || 0) + (rect.width || 0);
  const bottom = rect.bottom != null ? rect.bottom : (rect.top || 0) + (rect.height || 0);
  const left = rect.left != null ? rect.left : 0;
  return (
    right < -OFFSCREEN_MARGIN_PX ||
    bottom < -OFFSCREEN_MARGIN_PX ||
    left > viewport.w + OFFSCREEN_MARGIN_PX * 10
  );
}

// Conservative on purpose (docs/DECISIONS.md T45 motif): exact string
// equality only, both values present and non-transparent. Misses
// near-matches and inherited backgrounds; a false negative here just
// means the text is kept, same as today.
function sameColorAsBackground(el) {
  try {
    if (typeof getComputedStyle !== "function") return false;
    const style = getComputedStyle(el);
    if (!style || !style.color || !style.backgroundColor) return false;
    if (style.backgroundColor === "transparent" || style.backgroundColor === "rgba(0, 0, 0, 0)") return false;
    return style.color === style.backgroundColor;
  } catch {
    return false;
  }
}

function isInvisibleToEye(el, viewport) {
  return (
    isNearZeroFontSize(el) || isClippedSrOnly(el) || isOffscreen(el, viewport) || sameColorAsBackground(el)
  );
}

function findInvisibleTextElements(root) {
  if (!root || typeof root.querySelectorAll !== "function") return [];
  let all = [];
  try {
    all = Array.from(root.querySelectorAll("*"));
  } catch {
    return [];
  }
  const viewport = viewportSize();
  const out = [];
  for (const el of all) {
    if (isInvisibleToEye(el, viewport)) out.push(el);
  }
  return out;
}

// Step — structure as plain text (section 5 point 5): headings become
// `# `/`## `/`### ` lines, list items become `- ` lines. Deliberately NOT
// a DOM-walking serializer: `innerText` already produces correct
// paragraph breaks (see file header — that's why it was chosen over
// `textContent`). Reinventing that walk risks fragmenting a sentence's own
// inline markup (`<em>`, `<a>`) into separate lines. Instead: find each
// heading/list item's OWN rendered text as an exact line already present
// in the innerText-derived string (searching forward-only, so repeated
// labels don't tag the wrong occurrence), and prefix that line in place.
// A heading whose text does not surface as a single exact line (e.g. it
// contains a hard <br>) simply keeps no prefix — degrades silently, never
// throws, never touches the text otherwise.
function headingPrefixFor(tag) {
  if (tag === "H1") return "# ";
  if (tag === "H2") return "## ";
  if (tag === "H3" || tag === "H4" || tag === "H5" || tag === "H6") return "### ";
  return "";
}

function applyStructurePrefixes(text, scopeEl, excludedEls) {
  if (!text || !scopeEl || typeof scopeEl.querySelectorAll !== "function") return text;
  let structuralEls = [];
  try {
    structuralEls = Array.from(scopeEl.querySelectorAll("h1, h2, h3, h4, h5, h6, li"));
  } catch {
    return text;
  }
  if (!structuralEls.length) return text;

  const lines = text.split("\n");
  let searchFrom = 0;
  for (const el of structuralEls) {
    if (isWithinExcluded(el, excludedEls)) continue;
    if (!isRenderedCandidate(el)) continue;
    const prefix = el.tagName === "LI" ? "- " : headingPrefixFor(el.tagName);
    if (!prefix) continue;
    const own = normalizeFieldText(visibleText(el));
    if (!own) continue;
    for (let i = searchFrom; i < lines.length; i += 1) {
      const trimmed = lines[i].trim();
      if (trimmed === own && !/^(#{1,3}|-)\s/.test(trimmed)) {
        lines[i] = `${prefix}${trimmed}`;
        searchFrom = i + 1;
        break;
      }
    }
  }
  return lines.join("\n");
}

// Step — readability (section 6, T45): tells the panel a page could not be
// read, instead of silently sending near-nothing to the model. Measured
// failure modes: a PDF viewer (no injection possible → empty), a map drawn
// on `<canvas>` (structured pixels, no extractable text). "canvas" only
// fires when BOTH signals agree (a dominant canvas AND little text) — a
// canvas-based ad banner next to a normal article must never flip a good
// read to "canvas".
var CANVAS_COVERAGE_THRESHOLD = 0.5;
var READABILITY_CANVAS_MAX_CHARS = 300;
var READABILITY_EMPTY_MAX_CHARS = 200;

function hasLargeCanvas() {
  try {
    if (typeof document.querySelectorAll !== "function") return false;
    const canvases = document.querySelectorAll("canvas");
    const viewport = viewportSize();
    for (const c of canvases) {
      const { coverageRatio } = rectMetrics(safeRect(c), viewport);
      if (coverageRatio >= CANVAS_COVERAGE_THRESHOLD) return true;
    }
  } catch {
    return false;
  }
  return false;
}

function computeReadability(text, items, facts) {
  let len = (text || "").length;
  if (Array.isArray(items)) {
    for (const it of items) {
      len += (it.title || "").length + (it.detail || "").length + (it.price || "").length + (it.location || "").length;
    }
  }
  if (Array.isArray(facts)) {
    for (const f of facts) len += (f.label || "").length + (f.value || "").length;
  }
  if (hasLargeCanvas() && len < READABILITY_CANVAS_MAX_CHARS) return "canvas";
  if (len < READABILITY_EMPTY_MAX_CHARS) return "empty";
  return "ok";
}

// Orchestrates steps 1-5 for `kind: "page"`. Never throws: any failure
// degrades to today's plain-text `other` behavior (docs/PROTOCOL.md,
// "other": "An exception … never causes extraction to fail.").
function buildPageKindContext() {
  const fallbackWholePageText = () => truncate(articleText());

  let contentRoot = null;
  let excludedEls = [];
  try {
    const resolved = resolveOverlayExclusion();
    contentRoot = resolved.contentRoot;
    excludedEls = resolved.excludedEls;
  } catch {
    contentRoot = null;
    excludedEls = [];
  }

  // T45 section 5 point 6 — feed elements invisible to the eye into the
  // same subtraction mechanism overlays already use. Downstream (main
  // region, facts, items, structure prefixes) all thread `excludedEls`
  // through, so this one merge covers the whole pipeline.
  try {
    excludedEls = excludedEls.concat(findInvisibleTextElements(document.body));
  } catch {
    // keep excludedEls as resolved above — a broken scan here must not
    // block extraction.
  }

  // Safety net: over-aggressive exclusion → cancel it and fall back to the
  // full page, today's default behavior, with pageKind "other" — not a
  // silent reset that would let list/listing retry on an exclusion we just
  // judged excessive.
  try {
    if (!contentRoot && excludedEls.length) {
      const wholePageAfterExclusion = textExcludingNodes(document.body, excludedEls).trim();
      if (wholePageAfterExclusion.length < OVERLAY_FALLBACK_MIN_VISIBLE_CHARS) {
        const fallbackText = fallbackWholePageText();
        return {
          kind: "page",
          url: safePageUrl(),
          title: document.title || "",
          pageKind: "other",
          text: fallbackText,
          hasVideoElement: hasVideoElement(),
          hasArticleMarkup: hasArticleMarkup(),
          readability: computeReadability(fallbackText, undefined, undefined),
        };
      }
    }
  } catch {
    excludedEls = [];
  }

  const searchRoot = contentRoot || document.body;

  let mainRegionEl;
  try {
    mainRegionEl = findMainRegion(searchRoot, excludedEls);
  } catch {
    const fallbackText = fallbackWholePageText();
    return {
      kind: "page",
      url: safePageUrl(),
      title: document.title || "",
      text: fallbackText,
      hasVideoElement: hasVideoElement(),
      hasArticleMarkup: hasArticleMarkup(),
      readability: computeReadability(fallbackText, undefined, undefined),
    };
  }

  let mainRegionText = "";
  try {
    mainRegionText = textExcludingNodes(mainRegionEl, excludedEls);
  } catch {
    mainRegionText = "";
  }

  // T45 section 5 point 3 — shadow DOM read within the chosen region only:
  // it supplements the region the rest of the pipeline already trusts,
  // rather than risking pulling in an unrelated web-component's content.
  try {
    const shadowText = collectShadowText(mainRegionEl, excludedEls);
    if (shadowText) {
      mainRegionText = mainRegionText ? `${mainRegionText}\n\n${shadowText}` : shadowText;
    }
  } catch {
    // shadow read is a bonus signal — never block extraction on it.
  }

  let listCandidate = null;
  let facts = [];
  try {
    const candidateGroup = findCandidateEntryGroup(mainRegionEl);
    const excludedListEntries = candidateGroup ? candidateGroup.group : [];
    // `facts` (returned as `context.facts` when the page ends up NOT being
    // a list) only excludes the entries themselves — a fiche followed by a
    // carousel of "annonces similaires" must still report the fiche's own
    // facts, the carousel entries excluded.
    facts = findFacts(searchRoot, excludedEls, excludedListEntries);

    if (candidateGroup) {
      // Correction #3: "no fact block outside the list" is judged outside the
      // CONTAINER, not outside its entries. The promoted ad's description
      // (inside the container, outside any single entry) can legitimately
      // contain "label: value" lines ("Property tax:
      // 503 €") without turning the page into a `listing` — so this check
      // excludes the whole container, not just `group`, before counting.
      const factsOutsideContainer = findFacts(searchRoot, excludedEls, [candidateGroup.container]);
      if (factsOutsideContainer.length < 4) {
        listCandidate = evaluateListCandidate(
          candidateGroup.container,
          candidateGroup.group,
          mainRegionText,
          excludedEls,
        );
      }
    }
  } catch {
    facts = [];
    listCandidate = null;
  }

  const h1El = typeof document.querySelector === "function" ? document.querySelector("h1") : null;

  if (listCandidate) {
    let items = [];
    try {
      items = capItems(findItems(listCandidate, excludedEls));
    } catch {
      items = [];
    }
    if (items.length) {
      let text = "";
      try {
        text = textExcludingEntries(mainRegionEl, excludedEls, listCandidate.entries).trim();
        text = applyStructurePrefixes(text, mainRegionEl, excludedEls);
      } catch {
        text = "";
      }
      const budgetUsed = items.reduce(
        (sum, it) => sum + (it.title || "").length + (it.price || "").length + (it.location || "").length + (it.detail || "").length,
        0,
      );
      const cappedText = truncate(text, Math.max(0, MAX_CHARS - budgetUsed));
      return {
        kind: "page",
        url: safePageUrl(),
        title: document.title || "",
        pageKind: "list",
        items,
        text: cappedText,
        hasVideoElement: hasVideoElement(),
        hasArticleMarkup: hasArticleMarkup(),
        readability: computeReadability(cappedText, items, undefined),
      };
    }
    // "pageKind: 'list' with no valid entry → fall back to other".
  }

  const cappedFacts = capFacts(facts);
  if (cappedFacts.length >= 4 && hasChiefNumericFact(cappedFacts, mainRegionEl, h1El, excludedEls)) {
    const budgetUsed = cappedFacts.reduce((sum, f) => sum + f.label.length + f.value.length, 0);
    const listingText = truncate(
      applyStructurePrefixes(mainRegionText, mainRegionEl, excludedEls),
      Math.max(0, MAX_CHARS - budgetUsed),
    );
    return {
      kind: "page",
      url: safePageUrl(),
      title: document.title || "",
      pageKind: "listing",
      facts: cappedFacts,
      text: listingText,
      hasVideoElement: hasVideoElement(),
      hasArticleMarkup: hasArticleMarkup(),
      readability: computeReadability(listingText, undefined, cappedFacts),
    };
  }

  const articleMarkup = hasArticleMarkup();
  const structuredMainText = applyStructurePrefixes(mainRegionText, mainRegionEl, excludedEls);
  const text = truncate(structuredMainText || fallbackWholePageText());
  if (articleMarkup || mainRegionText.trim().length > ARTICLE_TEXT_THRESHOLD) {
    return {
      kind: "page",
      url: safePageUrl(),
      title: document.title || "",
      pageKind: "article",
      text,
      hasVideoElement: hasVideoElement(),
      hasArticleMarkup: articleMarkup,
      readability: computeReadability(text, undefined, undefined),
    };
  }

  return {
    kind: "page",
    url: safePageUrl(),
    title: document.title || "",
    pageKind: "other",
    text,
    hasVideoElement: hasVideoElement(),
    hasArticleMarkup: articleMarkup,
    readability: computeReadability(text, undefined, undefined),
  };
}
