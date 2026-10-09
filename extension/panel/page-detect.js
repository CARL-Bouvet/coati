// Coati side panel — page detection (lot F3 split of panel.js): metadata-only
// tab-switch classification, the one gesture-gated full extraction on tab
// read, and the favicon lookup that rides along. See panel.js's own header
// comment ("Permission flow for the contextual main button") for the rule
// this whole file exists to respect: never read a page without a gesture.
import { classifyPageType, classifyPageTypeFromMetadata } from "../content/detect.js";
import { api, IS_GECKO } from "../lib/browser-compat.js";
import { faviconSrc } from "./card-state.js";
import { updateSiteCard, beginCardDetection, endCardDetection } from "./site-card.js";
import { refreshReadButton, renderReadButton } from "./first-run-wiring.js";
import { extractFromTab } from "./page-extract.js";
import { currentTabId } from "./panel.js";

// Page detection state (deliverable 1) — see panel.js's header comment.
export let pageType = null; // "video" | "article" | "page" | null (unknown)
// "list" | "listing" | "article" | "other" | null (unknown — no DOM read yet,
// or the client-side context predates the amendment). DOM-derived only:
// redetectTabFromMetadata() never sets this (see its own comment).
export let pageKind = null;
export let knownOrigin = null; // origin string once learned (granted, or from a failed-extraction error), or null
// See redetect-dedupe.js for why this exists (the "coati:action-clicked"
// message can race init's own redetectTab() for the same click).
export let lastRedetectTabId = null;
export let lastRedetectAt = 0;

// Site card state (T27-T29) — see card-state.js for the pure state logic.
// `currentPageUrl` is the full URL when it's legible (metadata via a granted
// host permission, or from a completed extraction) and null otherwise — same
// visibility rule as knownOrigin, just the full string instead of the
// origin. `currentFavIconUrl` is the icon source from faviconSrc().
export let currentPageUrl = null;
export let currentFavIconUrl = null;

export function resetPageState() {
  pageType = null;
  pageKind = null;
  currentPageUrl = null;
  currentFavIconUrl = null;
  updateSiteCard();
}

export function classifyForContext(context) {
  return classifyPageType({
    url: context.url,
    title: context.title,
    textLength: (context.text || "").length,
    hasTranscript: context.kind === "youtube" && !context.needsTranscript && !!context.text,
    hasVideoElement: !!context.hasVideoElement,
    hasArticleMarkup: !!context.hasArticleMarkup,
  });
}

export function applyDetectedContext(context) {
  try {
    knownOrigin = new URL(context.url).origin;
  } catch {
    knownOrigin = null;
  }
  currentPageUrl = context.url || null;
  pageType = classifyForContext(context);
  // docs/PROTOCOL.md "Compatibility": an absent field, or a value outside
  // the four expected ones, means "behave exactly as before" — falling back
  // to the legacy pageType label in mainButtonLabel() achieves that without
  // needing to special-case it here.
  pageKind =
    context.kind === "page" && typeof context.pageKind === "string" ? context.pageKind : null;
  refreshReadButton();
  updateSiteCard();
  // extract.js reads page content, never tab metadata — the favicon comes
  // from a separate, metadata-only chrome.tabs.get(), same visibility rule
  // as everywhere else in this file (T28: the site's own icon, no logo of
  // ours). Best-effort: a failure here just means no favicon, never a
  // blocked card. Re-render once it resolves.
  refreshFavIcon(currentTabId).then(() => {
    updateSiteCard();
    renderReadButton();
  });
}

/** Re-runs detection for `tabId`. Never throws — degrades to the generic
 * state (and, when possible, the "activer sur ce site" affordance) instead. */
/** How long after the browser starts a loading panel is assumed to be a
 * restored one rather than a freshly clicked one. Chrome restores side panels
 * within a second or two of startup; ten seconds covers a cold machine without
 * swallowing a deliberate click, which realistically comes later than that. */
const RESTORE_WINDOW_MS = 10_000;

/** False when this panel is most likely one the browser restored at startup.
 * Fails closed: any error reading the stamp means we do NOT read the page. */
export async function openedFromGesture() {
  try {
    const { browserStartedAt } = await api.storage.session.get("browserStartedAt");
    if (typeof browserStartedAt !== "number") return true;
    return Date.now() - browserStartedAt > RESTORE_WINDOW_MS;
  } catch {
    return false;
  }
}

export async function redetectTab(tabId) {
  // Recorded on every read, but only the "coati:action-clicked" handler skips
  // on it: a read requested by the encart's read button right after a grant
  // must never be swallowed by the dedupe window. Resolves true when the page
  // was actually read, false otherwise (never throws).
  lastRedetectTabId = tabId;
  lastRedetectAt = Date.now();
  beginCardDetection();
  try {
    const context = await extractFromTab(tabId);
    applyDetectedContext(context);
    return true;
  } catch {
    resetPageState();
    // T47: the injection-refused error no longer carries the page address
    // (neither browser embeds it — verified 2026-09-29), so the origin is
    // read from tabs.get() instead. Legitimate here specifically: this
    // function only runs inside a genuine gesture (icon click, context menu,
    // shortcut, the encart's read button), whose activeTab grant already gives tab metadata
    // regardless of any scripting/host permission. If we already hold this
    // site's permission, extraction failed for some other reason (a
    // chrome:// page, a PDF viewer…) — refreshReadButton() checks
    // that itself and stays hidden in that case. The favicon rides along so
    // the button's ring shows the site's own icon.
    try {
      const tab = await api.tabs.get(tabId);
      knownOrigin = tab?.url ? new URL(tab.url).origin : null;
      currentFavIconUrl = tab?.url ? iconFor(tab) : null;
    } catch {
      knownOrigin = null;
    }
    await refreshReadButton();
    return false;
  } finally {
    endCardDetection();
  }
}

/** Tab-switch handler — never reads the page (see the comment block at the
 * top of this file). Classifies from `tab.url`/`tab.title` only, which
 * `chrome.tabs.get` returns without injecting anything as long as we hold a
 * host permission for that tab's origin. Leaves the type "unknown" (and the
 * main button generic) whenever the URL shape alone can't tell — that is the
 * honest answer, not a bug. */
export async function redetectTabFromMetadata(tabId) {
  beginCardDetection();
  try {
    let tab;
    try {
      tab = await api.tabs.get(tabId);
    } catch {
      tab = null;
    }

    resetPageState();
    knownOrigin = null;
    if (!tab || !tab.url) {
      refreshReadButton();
      return; // no permission for this origin: nothing legible
    }

    try {
      knownOrigin = new URL(tab.url).origin;
    } catch {
      knownOrigin = null;
    }
    currentPageUrl = tab.url;
    currentFavIconUrl = iconFor(tab);
    pageType = classifyPageTypeFromMetadata({ url: tab.url, title: tab.title });
      refreshReadButton();
    updateSiteCard();
  } finally {
    endCardDetection();
  }
}

export function iconFor(tab) {
  return faviconSrc({
    pageUrl: tab?.url,
    favIconUrl: tab?.favIconUrl,
    isGecko: IS_GECKO,
    getURL: (path) => api.runtime.getURL(path),
  });
}

/** Metadata-only favicon lookup (T28), same visibility rule as tab.url
 * everywhere else in this file — used after a real extraction, which reads
 * page content and knows nothing about tab chrome. */
async function refreshFavIcon(tabId) {
  if (tabId == null) {
    currentFavIconUrl = null;
    return;
  }
  try {
    const tab = await api.tabs.get(tabId);
    currentFavIconUrl = iconFor(tab);
  } catch {
    currentFavIconUrl = null;
  }
}
