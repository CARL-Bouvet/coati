// Part of the content/extract.js content script (split) — "main
// region" and "→ list" candidate-group detection. See
// content/extract-files.js for the full load order.

// Step 2 — "main region" (unchanged rule, applied within whatever survived
// step 1). Returns the element, not its text.
// A main region is never inside a fixed or sticky element (contact card,
// side panel):, the contact card on a bienici listing carried
// its CNIL form notice, a dense block that extraction mistook for content.
// But on bienici's results page the whole list is inside a fixed panel
// (#searchSideView, 4 535 chars out of 4 543). Hence the text-share rule: a
// fixed element that carries half or more of the page text is the main
// surface, not a sidebar.
var FIXED_SIDEBAR_MAX_SHARE = 0.5;
var fixedShareCache = new Map();
function isInsideFixedOrSticky(el) {
  let node = el;
  for (let i = 0; node && i < 25; i += 1) {
    const pos = safeComputedPosition(node);
    if (pos === "fixed" || pos === "sticky") {
      if (!fixedShareCache.has(node)) {
        const bodyLen = ((document.body && document.body.innerText) || "").length || 1;
        const ownLen = (node.innerText || "").length;
        fixedShareCache.set(node, ownLen / bodyLen);
      }
      return fixedShareCache.get(node) < FIXED_SIDEBAR_MAX_SHARE;
    }
    node = node.parentElement;
  }
  return false;
}

function findMainRegion(searchRoot, excludedEls) {
  if (searchRoot && typeof searchRoot.querySelectorAll === "function") {
    let semanticCandidates = [];
    try {
      semanticCandidates = searchRoot.querySelectorAll("article, main, [role='main']");
    } catch {
      semanticCandidates = [];
    }
    for (const el of semanticCandidates) {
      if (isWithinExcluded(el, excludedEls)) continue;
      if (!isRenderedCandidate(el)) continue;
      const text = textExcludingNodes(el, excludedEls);
      if (text.trim().length > 200) return el;
    }
  }

  let best = null;
  let bestScore = 0;
  let bestLength = 0;
  let candidates = [];
  try {
    candidates = searchRoot && searchRoot.querySelectorAll ? searchRoot.querySelectorAll("div, section") : [];
  } catch {
    candidates = [];
  }
  for (const el of candidates) {
    if (el.closest("nav, footer, header, aside, form, [contenteditable]")) continue;
    if (isWithinExcluded(el, excludedEls)) continue;
    if (isInsideFixedOrSticky(el)) continue; // fixed sidebar: never the main region
    if (!isRenderedCandidate(el)) continue;
    const text = textExcludingNodes(el, excludedEls);
    const length = text.trim().length;
    if (length < 200) continue;
    const density = length / (el.getElementsByTagName("*").length + 1);
    if (density > bestScore) {
      bestScore = density;
      best = el;
      bestLength = length;
    }
  }

  // T45 section 5 point 2 — "group repeated sibling blocks". A comment
  // thread (Hacker News's table rows) or a Q&A page (Stack Overflow's
  // question + answers) has no single densest block: each entry, taken
  // alone, is denser than the entries-holding container, so the density
  // scan above elects one comment/answer and drops the rest. When a
  // repeated-shape sibling group's COMBINED text beats the single winner
  // above, prefer its container instead — same DENSITY LOSES, VOLUME WINS
  // trade the "list"/"listing" pipeline already makes for structured
  // entries (findCandidateEntryGroup below), applied here to prose
  // threads that never pass that pipeline's link/numeric-value gates.
  let threadGroup = null;
  try {
    threadGroup = findThreadGroupContainer(searchRoot, excludedEls);
  } catch {
    threadGroup = null;
  }
  if (threadGroup && threadGroup.length > bestLength) {
    const container = threadGroup.container;
    const containerOk =
      !isWithinExcluded(container, excludedEls) &&
      !isInsideFixedOrSticky(container) &&
      isRenderedCandidate(container) &&
      !(typeof container.closest === "function" && container.closest("nav, footer, header, aside, form, [contenteditable]"));
    if (containerOk) return container;
  }

  return best || searchRoot || document.body;
}

// Finds the smallest container holding a group of >= LIST_MIN_GROUP_SIZE
// same-shape siblings whose COMBINED rendered text is largest — the
// container itself (e.g. a comment `<table>`'s `<tbody>`, an `#answers`
// wrapper), not any single entry. `bestSameShapeGroup`/`shapeKey` are the
// same "→ list" shape test the structured-entries pipeline uses (step 3a
// below); this walk is deliberately narrower than that pipeline (no link/
// numeric-value requirement) because prose threads often have neither.
var THREAD_GROUP_MIN_SIZE = LIST_MIN_GROUP_SIZE; // same bar as a "list" group
var THREAD_ENTRY_MIN_CHARS = 40; // a real comment/answer, not a byline or a vote count

function findThreadGroupContainer(searchRoot, excludedEls) {
  if (!searchRoot || typeof searchRoot.querySelectorAll !== "function") return null;
  let allEls = [];
  try {
    allEls = Array.from(searchRoot.querySelectorAll("*"));
  } catch {
    return null;
  }
  let bestContainer = null;
  let bestGroup = null;
  let bestCombined = 0;
  for (const container of allEls) {
    if (isWithinExcluded(container, excludedEls)) continue;
    try {
      if (container.closest && container.closest("nav, footer, header, aside, form, [contenteditable]")) continue;
    } catch {
      // treat as not excluded
    }
    const group = bestSameShapeGroup(container);
    if (!group || group.length < THREAD_GROUP_MIN_SIZE) continue;
    let combined = 0;
    let qualifying = 0;
    for (const entry of group) {
      if (!isRenderedCandidate(entry)) continue;
      const t = textExcludingNodes(entry, excludedEls).trim();
      if (t.length >= THREAD_ENTRY_MIN_CHARS) {
        combined += t.length;
        qualifying += 1;
      }
    }
    if (qualifying < THREAD_GROUP_MIN_SIZE) continue;
    if (combined > bestCombined) {
      bestCombined = combined;
      bestContainer = container;
      bestGroup = group;
    }
  }
  return bestContainer ? { container: bestContainer, group: bestGroup, length: bestCombined } : null;
}

// Step 3a — repeated entries ("→ list"). Shape = own tag + child tags, one
// level deep ("same child-tag sequence on two levels").
function shapeKey(el) {
  if (!el) return "";
  const childTags = Array.from(el.children || []).map((c) => c.tagName).join(",");
  return `${el.tagName}[${childTags}]`;
}

function bestSameShapeGroup(parent) {
  if (!parent || !parent.children || parent.children.length < LIST_MIN_GROUP_SIZE) return null;
  const buckets = new Map();
  for (const child of parent.children) {
    const key = shapeKey(child);
    if (!buckets.has(key)) buckets.set(key, []);
    buckets.get(key).push(child);
  }
  let best = null;
  for (const group of buckets.values()) {
    if (group.length >= LIST_MIN_GROUP_SIZE && (!best || group.length > best.length)) best = group;
  }
  return best;
}

// "in the main region — or, if the main region is itself an entry, in its
// closest ancestor that contains several entries".
//
// Correction n°1 (docs/PROTOCOL.md): that closest ancestor is searched by
// WALKING UP, six levels at most — not just the direct parent. Measured on
// bienici: the region picked above is the promoted ad (3 253 chars), sitting
// inside a box of 3 ads; the real results container (`search-results-list`,
// 25 children, 24 same-shape `ARTICLE`) is two levels further up. Stopping
// at the direct parent (the box of 3, too small to be a group of >=5) missed
// the list entirely.
function findCandidateEntryGroup(mainRegionEl) {
  if (!mainRegionEl) return null;

  // The region itself may already BE the results container (found directly
  // via `article, main, [role=main]`, or the density fallback).
  const ownGroup = bestSameShapeGroup(mainRegionEl);
  if (ownGroup) return { container: mainRegionEl, group: ownGroup };

  let ancestor = mainRegionEl.parentElement;
  for (let level = 0; ancestor && level < MAX_ANCESTOR_LEVELS; level += 1) {
    const group = bestSameShapeGroup(ancestor);
    if (group) return { container: ancestor, group };
    ancestor = ancestor.parentElement;
  }

  if (mainRegionEl.children) {
    for (const child of mainRegionEl.children) {
      const nested = bestSameShapeGroup(child);
      if (nested) return { container: child, group: nested };
    }
  }
  return null;
}

function entryLinkAndText(entry, excludedEls) {
  let hasLink = false;
  try {
    hasLink = typeof entry.querySelector === "function" && !!entry.querySelector("a[href]");
  } catch {
    hasLink = false;
  }
  const text = textExcludingNodes(entry, excludedEls).trim();
  return { hasLink, text };
}

// Validates the candidate group against every "list" condition in
// docs/PROTOCOL.md before it is trusted, and computes the facts-outside
// count needed both for the list/carousel distinction and for `listing`.
//
// Correction #2: "an out-of-bounds entry is dropped alone, it does not
// condemn the group." A promoted ad carrying its full description past
// 1 000 chars used to invalidate the whole group; now it is dropped and the
// group survives as long as >=5 in-bounds entries remain. The "at least
// half numeric" and "at least 50% of main region text" ratios are then
// judged against the surviving entries, not the original (possibly larger)
// candidate group — an entry that was skipped never gets a vote either way.
function evaluateListCandidate(container, group, mainRegionText, excludedEls) {
  if (!group || group.length < LIST_MIN_GROUP_SIZE) return null;

  let numericCount = 0;
  let cumulativeLength = 0;
  const entries = [];
  for (const entry of group) {
    if (!isElementUsable(entry)) continue; // out of bounds, skipped individually
    const { hasLink, text } = entryLinkAndText(entry, excludedEls);
    if (!hasLink) continue; // out of bounds, skipped individually
    if (text.length < LIST_ENTRY_MIN_CHARS || text.length > LIST_ENTRY_MAX_CHARS) continue;
    if (hasNumericValue(text)) numericCount += 1;
    cumulativeLength += text.length;
    entries.push({ el: entry, text });
  }
  if (entries.length < LIST_MIN_GROUP_SIZE) return null; // group no longer valid
  if (numericCount * 2 < entries.length) return null; // "at least half"
  const mainLength = (mainRegionText || "").trim().length || 1;
  if (cumulativeLength / mainLength < 0.5) return null; // "au moins 50 %"

  return { container, entries };
}
