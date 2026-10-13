// Coati side panel — "Montrer : …" point-at-element, timestamp seek (split of panel.js).
import { t } from "../lib/i18n-page.js";
import { api } from "../lib/browser-compat.js";
import { newId } from "./panel-state.js";
import { addMessage } from "./message-render.js";
import { parseStoredPointEffect, POINT_EFFECT_KEY } from "./point-effect.js";
import { getYouTubeVideoIdFromUrl } from "./timestamps.js";
import { currentTabId } from "./panel.js";

// The "Montrer : …" button currently showing a highlight, if any — a second
// click on THIS button clears it (toggle off); clicking a different one
// just replaces it (pointer.js's own removeExistingHighlight() already does
// that). Not re-synced when pointer.js auto-dismisses on its own (timeout,
// Escape, a click on the page) — out of scope, no message channel back.
let activePointButton = null;

const POINTER_FILES = ["/content/pointer.js"];

// immediately; clicking a DIFFERENT one just replaces it (pointer.js's own
// "one highlight at a time" already handles that case). Escape /
// a click on the page still dismiss on the content-script side — this
// doesn't re-sync `activePointButton`/aria-pressed when that happens (no
// message channel back), same limitation noted where it's declared above.
export function onPointButtonClick(button, entry) {
  if (activePointButton === button) {
    activePointButton = null;
    button.setAttribute("aria-pressed", "false");
    clearPointer(currentTabId);
    return;
  }
  const previous = activePointButton;
  activePointButton = button;
  button.setAttribute("aria-pressed", "true");
  if (previous) previous.setAttribute("aria-pressed", "false");
  pointAtElement(currentTabId, entry).then((ok) => {
    if (!ok && activePointButton === button) {
      activePointButton = null;
      button.setAttribute("aria-pressed", "false");
    }
  });
}

// Highlights the element a "Montrer : …" button names, on the CURRENT page
// of `tabId` — a real click just happened (CLAUDE.md rule #5: this tools the
// user's own gesture, it never fires on its own). Two separate injections:
// first `pointer.js` itself (defines
// `globalThis.__coatiPoint` in that tab's isolated world, does nothing on
// its own), then a `func` call that invokes it with the ref/role/label/
// extractionId `entry` already carries (built by renderElementRefs(), from
// THAT message's own snapshot — see resolveElementClick(), element-refs.js),
// plus the user's chosen highlight intensity (`effect`, read fresh from
// chrome.storage.local — point-effect.js) — pointer.js re-verifies all of
// the entry's own fields against the LIVE page before drawing anything, and
// this function never touches the DOM itself.
// @returns {Promise<boolean>} true on "ok", false on "stale"/any failure —
// used by onPointButtonClick() above to decide whether the button stays
// pressed.
export async function pointAtElement(tabId, entry) {
  if (!entry || tabId == null) {
    addMessage({ id: newId(), role: "system", text: t("panel_point_failed") });
    return false;
  }
  try {
    // Read fresh at click time (not cached) — a change in Options should
    // apply to the very next "Montrer : …" click, not the next panel open.
    const stored = await api.storage.local.get([POINT_EFFECT_KEY]).catch(() => ({}));
    const effect = parseStoredPointEffect(stored[POINT_EFFECT_KEY]);
    await api.scripting.executeScript({ target: { tabId }, files: POINTER_FILES });
    const results = await api.scripting.executeScript({
      target: { tabId },
      func: (opts) => (typeof globalThis.__coatiPoint === "function" ? globalThis.__coatiPoint(opts) : "stale"),
      args: [{ ...entry, effect }],
    });
    const status = results?.[0]?.result;
    if (status === "stale") {
      addMessage({ id: newId(), role: "system", text: t("panel_point_stale") });
    } else if (status !== "ok") {
      addMessage({ id: newId(), role: "system", text: t("panel_point_failed") });
    }
    return status === "ok";
  } catch {
    // Tab closed, no more permission, page navigated away mid-click — best
    // effort, reported the same way a failed highlight is.
    addMessage({ id: newId(), role: "system", text: t("panel_point_failed") });
    return false;
  }
}

/** Second click on the same "Montrer : …" button — removes the highlight
 * without drawing anything new. Best-effort, same spirit as
 * pointAtElement(): a closed tab or a navigated-away page is not an error
 * worth surfacing here, the highlight is gone either way. */
export async function clearPointer(tabId) {
  if (tabId == null) return;
  try {
    await api.scripting.executeScript({ target: { tabId }, files: POINTER_FILES });
    await api.scripting.executeScript({
      target: { tabId },
      func: () => (typeof globalThis.__coatiPoint === "function" ? globalThis.__coatiPoint({ clear: true }) : "stale"),
    });
  } catch {
    // best-effort
  }
}

// Seeks the <video> element of the CURRENT active tab — but only when a real
// click just happened (this is only ever called from a "click" listener
// above) AND that tab is showing the same video the summary was made from.
// CLAUDE.md rule #5 ("the gesture rule"): this tools a gesture the user just
// made, it never fires on its own, never on a timer, never on another tab.
export async function seekActiveVideoTab(videoId, seconds) {
  try {
    const [tab] = await api.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id || getYouTubeVideoIdFromUrl(tab.url) !== videoId) return;
    await api.scripting.executeScript({
      target: { tabId: tab.id },
      func: (t) => {
        const video = document.querySelector("video");
        if (video) video.currentTime = t;
      },
      args: [seconds],
    });
  } catch {
    // Tab closed, no more permission, no <video> on the page yet — a seek is
    // best-effort, never worth surfacing an error for.
  }
}
