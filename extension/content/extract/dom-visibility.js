// Part of the content/extract.js content script (lot F4 split) — see
// content/extract-files.js for the load order. Shared "is this node
// actually visible to the user" gate, used by nearly every later file.

// T45 (docs/DECISIONS.md), point 1: "innerText of a hidden element returns its
// textContent" — a hidden settings dialog, a closed popin, a menu with
// `display:none` all measure as if they were on screen. Never let one win
// a text-length/density contest. `checkVisibility` is the modern, cheap
// check (feature-detected: not every embedder ships it); `getClientRects`
// catches `display:none`/detached nodes even where it's missing; an
// `aria-hidden="true"` ancestor is excluded outright — it is also used in
// the wild to hide dialogs/menus from sighted users, not just assistive
// tech (measured on Le Monde, Amazon, PAP).
function isRenderedCandidate(el) {
  if (!el) return false;
  // `display: contents` generates no box of its own, so getClientRects() is
  // empty and checkVisibility() says false even when everything inside is on
  // screen (measured on MDN, whose <main> is `display: contents`). Such an
  // element is visible when one of its children is — checked before
  // isElementUsable(), which would reject it for having no box.
  let displayContents = false;
  try {
    displayContents =
      typeof getComputedStyle === "function" && getComputedStyle(el).display === "contents";
  } catch {
    displayContents = false;
  }
  if (displayContents) {
    try {
      if (typeof el.closest === "function" && el.closest('[aria-hidden="true"]')) return false;
    } catch {
      // Fake/degenerate DOM — fall through.
    }
    return Array.from(el.children || []).some((child) => isRenderedCandidate(child));
  }
  if (!isElementUsable(el)) return false;
  try {
    if (
      typeof el.checkVisibility === "function" &&
      el.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true }) === false
    ) {
      return false;
    }
  } catch {
    // Not implemented reliably everywhere — fall through to the other
    // checks rather than treating a throw as "hidden".
  }
  try {
    if (typeof el.closest === "function" && el.closest('[aria-hidden="true"]')) return false;
  } catch {
    // Fake/degenerate DOM — don't let a harness quirk hide real content.
  }
  return true;
}

// Fix #4 (docs/PROTOCOL.md, "Fixes measured on real
// pages"). "A fact is only read from a displayed element." DOM trap:
// `innerText` of a `display: none` element still returns its
// `textContent` — reading it without this check is exactly how the 40
// fact slots on the bienici fiche got filled with a hidden phone
// country-code dropdown ("Afghanistan : +93"…) and form validation
// messages. `getClientRects()` catches `display: none` (and detachment);
// it does NOT catch `visibility: hidden` (the box still has layout), which
// is why that is checked separately via computed style.
function isElementUsable(el) {
  if (!el) return false;
  try {
    if (typeof el.getClientRects !== "function" || el.getClientRects().length === 0) return false;
  } catch {
    return false;
  }
  try {
    if (typeof getComputedStyle === "function") {
      const style = getComputedStyle(el);
      if (style && style.visibility === "hidden") return false;
    }
  } catch {
    // Can't tell — don't let a styling failure hide legitimate content.
  }
  return true;
}
