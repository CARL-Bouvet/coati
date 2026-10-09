// Part of the content/extract.js content script (lot F4 split) — "Facts"
// (context.facts) and "Entries" (context.items) extraction. See
// content/extract-files.js for the full load order.

// "never [a fact that lives] in a form" — nor a hidden container,
// nor anything explicitly marked non-visible for assistive tech.
var FACT_HIDDEN_ANCESTOR_SELECTOR = 'form, select, option, datalist, [hidden], [aria-hidden="true"]';

// A fact/entry label or value cell that IS or CONTAINS an editable region
// (a draft comment typed into a <div contenteditable> nested in a table
// cell, a <dd>, one half of an adjacent pair…) must never be read: the
// guard in isFactsExcludedContext() only catches the container living
// INSIDE an editable ancestor, not an editable descendant living inside an
// otherwise ordinary label/value cell. Same promise as textExcludingEditable
// above, applied to the smaller, per-cell granularity facts/items read at.
function isOrContainsEditable(el) {
  if (!el) return false;
  try {
    if (typeof el.getAttribute === "function" && el.getAttribute("contenteditable") != null) return true;
  } catch {
    // fall through
  }
  try {
    if (typeof el.querySelector === "function" && el.querySelector("[contenteditable]")) return true;
  } catch {
    // not a real element / no querySelector — can't contain one.
  }
  return false;
}

// Step 3b — "Faits" (docs/PROTOCOL.md "Faits — context.facts"), the four
// recognized shapes, read within `scopeEl` and excluding `excludedEls` and
// any element in `excludedListEntries` (candidate list entries: facts never
// read inside them, whether or not the page ends up being `list`).
function isFactsExcludedContext(el, excludedEls, excludedListEntries) {
  if (isWithinExcluded(el, excludedEls)) return true;
  if (isWithinExcluded(el, excludedListEntries)) return true;
  if (!isElementUsable(el)) return true;
  try {
    if (el.closest("nav, footer, [role='navigation'], [role='contentinfo'], [contenteditable]")) return true;
    if (el.closest(FACT_HIDDEN_ANCESTOR_SELECTOR)) return true;
    const bannerAncestor = el.closest("header, [role='banner']");
    if (bannerAncestor && !bannerAncestor.closest("article")) return true;
  } catch {
    // Fake/degenerate DOM without closest(): treat as not excluded rather
    // than throwing — the caller's own try/catch is the real safety net.
  }
  return false;
}

// Measured 25/09 (notes/corpus/observations.md, trap #3): MDN's `dt`/`dd`
// pairs are navigation menus ("HTML reference : Elements"), not facts. A
// `dd` that renders as several lines (a `<ul><li>` of links, one per line
// via innerText's block-boundary breaks) or holds 2+ links is that kind of
// menu, not a read-at-a-glance value — the whole dt/dd group is rejected,
// not truncated, so it never dilutes real facts.
function valueLooksLikeMenu(el) {
  if (!el) return false;
  const raw = visibleText(el);
  if (raw.includes("\n")) return true;
  try {
    const links = el.querySelectorAll ? el.querySelectorAll("a") : [];
    if (links.length >= 2) return true;
  } catch {
    // not a real element / no querySelectorAll — can't be a link list.
  }
  return false;
}

function factFromDefinitionLists(scopeEl, excludedEls, excludedListEntries, out) {
  let lists = [];
  try {
    lists = scopeEl.querySelectorAll ? Array.from(scopeEl.querySelectorAll("dl")) : [];
  } catch {
    lists = [];
  }
  for (const dl of lists) {
    if (isFactsExcludedContext(dl, excludedEls, excludedListEntries)) continue;
    const children = dl.children || [];
    let i = 0;
    while (i < children.length) {
      const node = children[i];
      if (node.tagName !== "DT") {
        i += 1;
        continue;
      }
      const label = normalizeFieldText(visibleText(node));
      const values = [];
      let isMenu = false;
      let isEditable = isOrContainsEditable(node);
      let j = i + 1;
      while (j < children.length && children[j].tagName === "DD") {
        if (valueLooksLikeMenu(children[j])) isMenu = true;
        if (isOrContainsEditable(children[j])) isEditable = true;
        values.push(normalizeFieldText(visibleText(children[j])));
        j += 1;
      }
      if (values.length && !isMenu && !isEditable) out.push({ label, value: values.join(", ") });
      i = j > i ? j : i + 1;
    }
  }
}

function factFromTwoCellRows(scopeEl, excludedEls, excludedListEntries, out) {
  let rows = [];
  try {
    rows = scopeEl.querySelectorAll ? Array.from(scopeEl.querySelectorAll("tr")) : [];
  } catch {
    rows = [];
  }
  for (const tr of rows) {
    if (isFactsExcludedContext(tr, excludedEls, excludedListEntries)) continue;
    const cells = Array.from(tr.children || []).filter((c) => c.tagName === "TH" || c.tagName === "TD");
    if (cells.length !== 2) continue;
    if (isOrContainsEditable(cells[0]) || isOrContainsEditable(cells[1])) continue;
    const label = normalizeFieldText(visibleText(cells[0]));
    const value = normalizeFieldText(visibleText(cells[1]));
    out.push({ label, value });
  }
}

// "Repeated adjacent pair" — an element with exactly two text-bearing
// children, at least 2 siblings of the same shape (a characteristics grid).
function factFromAdjacentPairs(scopeEl, excludedEls, excludedListEntries, out) {
  let containers = [];
  try {
    containers = scopeEl.querySelectorAll ? Array.from(scopeEl.querySelectorAll("*")) : [];
  } catch {
    containers = [];
  }
  containers.push(scopeEl);
  const seenParents = new Set();
  for (const parent of containers) {
    if (!parent || !parent.children || seenParents.has(parent)) continue;
    seenParents.add(parent);
    const pairShaped = Array.from(parent.children).filter((child) => {
      const textChildren = Array.from(child.children || []).filter((c) => visibleText(c).trim().length > 0);
      return textChildren.length === 2;
    });
    if (pairShaped.length < 3) continue; // self + at least 2 siblings
    for (const el of pairShaped) {
      if (isFactsExcludedContext(el, excludedEls, excludedListEntries)) continue;
      const [labelEl, valueEl] = Array.from(el.children).filter((c) => visibleText(c).trim().length > 0);
      if (valueLooksLikeMenu(valueEl)) continue; // same guard as the dl shape
      if (isOrContainsEditable(labelEl) || isOrContainsEditable(valueEl)) continue;
      const label = normalizeFieldText(visibleText(labelEl));
      const value = normalizeFieldText(visibleText(valueEl));
      out.push({ label, value });
    }
  }
}

// "Label: value line" — a leaf-ish element whose whole visible text is one
// line shaped like `label: value`.
var LABEL_VALUE_LINE_RE = /^([^\n:.!?]{1,60}):\s*(.+)$/;
function factFromLabelValueLines(scopeEl, excludedEls, excludedListEntries, out) {
  let elements = [];
  try {
    elements = scopeEl.querySelectorAll ? Array.from(scopeEl.querySelectorAll("*")) : [];
  } catch {
    elements = [];
  }
  for (const el of elements) {
    if ((el.children || []).length > 0) continue; // "no block child" (approximation)
    if (isFactsExcludedContext(el, excludedEls, excludedListEntries)) continue;
    if (isOrContainsEditable(el)) continue;
    const raw = visibleText(el).trim();
    if (!raw || raw.includes("\n")) continue; // "the element has other lines"
    const match = LABEL_VALUE_LINE_RE.exec(raw);
    if (!match) continue;
    out.push({ label: normalizeFieldText(match[1]), value: normalizeFieldText(match[2]) });
  }
}

function findFacts(scopeEl, excludedEls, excludedListEntries) {
  const out = [];
  factFromDefinitionLists(scopeEl, excludedEls, excludedListEntries, out);
  factFromTwoCellRows(scopeEl, excludedEls, excludedListEntries, out);
  factFromAdjacentPairs(scopeEl, excludedEls, excludedListEntries, out);
  factFromLabelValueLines(scopeEl, excludedEls, excludedListEntries, out);
  return out;
}

// "Faits" caps and drop order, docs/PROTOCOL.md.
function capFacts(rawFacts) {
  const seen = new Set();
  const out = [];
  for (const fact of rawFacts) {
    if (!fact || typeof fact.label !== "string" || typeof fact.value !== "string") continue;
    if (fact.label.length > FACT_CAPS.label) continue; // prose, not a fact
    // A question or exclamation is an ad insert, not a fact (measured 25/09
    // on a bienici listing: "Need to move? Compare movers!", "Discover the
    // tax benefit now!").
    if (/[?!]/.test(fact.label) || /!\s*$/.test(fact.value)) continue;
    if (!fact.label || !fact.value) continue;
    const key = `${fact.label}\u0000${fact.value}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ label: fact.label, value: truncateField(fact.value, FACT_CAPS.value) });
    if (out.length >= FACT_CAPS.count) break;
  }
  return out;
}

// Step 4 — "Entries" (docs/PROTOCOL.md "Entries — context.items").
function buildItem(entryText) {
  const lines = entryText
    .split("\n")
    .map((l) => normalizeFieldText(l))
    .filter(Boolean);
  if (!lines.length) return null;

  const title = lines[0];
  const price = firstCurrencyValue(entryText);
  const priceLine = price ? lines.find((l) => l.includes(price)) : undefined;
  const locationLine = lines.find((l) => l !== title && l !== priceLine && looksLikeLocation(l));
  const detailLines = lines.filter((l) => l !== title && l !== priceLine && l !== locationLine);
  const detail = detailLines.join(" · ");

  const item = { title };
  if (price) item.price = price;
  if (locationLine) item.location = locationLine;
  if (detail) item.detail = detail;
  return item;
}

function titleForEntry(entry, fallbackText) {
  try {
    const heading = entry.querySelector && entry.querySelector("h2, h3, h4");
    if (heading && !isOrContainsEditable(heading)) {
      const t = normalizeFieldText(visibleText(heading));
      if (t) return t;
    }
    const link = entry.querySelector && entry.querySelector("a");
    if (link && !isOrContainsEditable(link)) {
      const t = normalizeFieldText(visibleText(link));
      if (t) return t;
    }
  } catch {
    // fall through to first line below
  }
  const firstLine = (fallbackText.split("\n")[0] || "").trim();
  return normalizeFieldText(firstLine);
}

function findItems(listCandidate, excludedEls) {
  const out = [];
  for (const { el, text } of listCandidate.entries) {
    const title = titleForEntry(el, text);
    if (!title) continue; // "an entry with no non-empty title is discarded"
    const item = buildItem(text);
    if (!item) continue;
    item.title = title;
    out.push(item);
  }
  return out;
}

// "Entries" caps: price/location over cap are omitted, not truncated.
function capItems(rawItems) {
  const out = [];
  for (const item of rawItems) {
    if (!item || typeof item.title !== "string" || !item.title) continue;
    const capped = { title: truncateField(item.title, ITEM_CAPS.title) };
    if (typeof item.price === "string" && item.price && item.price.length <= ITEM_CAPS.price) {
      capped.price = item.price;
    }
    if (typeof item.location === "string" && item.location && item.location.length <= ITEM_CAPS.location) {
      capped.location = item.location;
    }
    if (typeof item.detail === "string" && item.detail) {
      capped.detail = truncateField(item.detail, ITEM_CAPS.detail);
    }
    out.push(capped);
    if (out.length >= ITEM_CAPS.count) break;
  }
  return out;
}

function textExcludingEntries(el, excludedEls, entries) {
  const entryEls = entries.map((e) => e.el);
  return textExcludingNodes(el, (excludedEls || []).concat(entryEls));
}

// "a line within 3 elements of the h1" — a LINE, not an ancestor's whole
// subtree. Checking the full text of each ancestor up to 3 levels made this
// match arbitrarily far prose: on the Wikipedia "Coati" page, the 3rd
// ancestor up from `h1` contains the entire article body, bibliography
// included, and a citation ("2007, p. 1076") tripped the numeric check.
// Restricting to individual short lines is a second, independent guard on
// top of the regex fix above (NUMERIC_VALUE_RE), either alone would have
// fixed the Coati case, both together are cheap insurance.
var CHIEF_FACT_LINE_MAX_CHARS = 200;
function hasChiefNumericFact(facts, mainRegionEl, h1El, excludedEls) {
  if (facts.some((f) => hasNumericValue(f.value))) return true;
  if (!h1El || !mainRegionEl) return false;
  try {
    let el = h1El;
    for (let i = 0; i < 3 && el; i += 1) {
      el = el.parentElement || null;
      if (!el) break;
      const lines = textExcludingNodes(el, excludedEls).split("\n");
      for (const rawLine of lines) {
        const line = rawLine.trim();
        if (line && line.length <= CHIEF_FACT_LINE_MAX_CHARS && hasNumericValue(line)) return true;
      }
    }
  } catch {
    // ignore — this is a bonus signal, not required for correctness.
  }
  return false;
}
