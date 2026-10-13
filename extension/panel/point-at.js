// Coati side panel — "Montrer : …" point-at-element, timestamp seek (split of panel.js).
import { t } from "../lib/i18n-page.js";
import { api } from "../lib/browser-compat.js";
import { newId } from "./panel-state.js";
import { addMessage } from "./message-render.js";
import { parseStoredPointEffect, POINT_EFFECT_KEY, DEFAULT_POINT_EFFECT } from "./point-effect.js";
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
  pointWithButton(button, entry);
}

// Draws (or redraws) `button`'s target and marks it as the pressed one.
function pointWithButton(button, entry) {
  const previous = activePointButton;
  activePointButton = button;
  button.setAttribute("aria-pressed", "true");
  if (previous && previous !== button) previous.setAttribute("aria-pressed", "false");
  return pointAtElement(currentTabId, entry).then((ok) => {
    if (!ok && activePointButton === button) {
      activePointButton = null;
      button.setAttribute("aria-pressed", "false");
    }
  });
}

// Highlight intensity, bottom notch first, with each level's name.
const POINT_LEVELS = ["subtle", "strong", "spectacular"];
const POINT_LEVEL_NAMES = {
  subtle: "panel_point_level_subtle",
  strong: "panel_point_level_strong",
  spectacular: "panel_point_level_spectacular",
};

function renderPointLevel(slider, level) {
  const index = POINT_LEVELS.indexOf(level);
  slider.dataset.level = level;
  slider.setAttribute("aria-valuenow", String(index));
  slider.setAttribute("aria-valuetext", t(POINT_LEVEL_NAMES[level]));
  slider.querySelectorAll(".point-level-notch").forEach((notch, i) => notch.classList.toggle("is-on", i === index));
}

/**
 * The small vertical 3-notch slider next to an answer's first "Montrer : …"
 * button. Moving it (arrow keys or a click on a notch) saves the level as
 * the default for every later "Montrer" and redraws that button's target at
 * once, from the user's own input event (the gesture rule).
 */
export function buildPointLevelSlider(button, entry) {
  const slider = document.createElement("span");
  slider.className = "point-level";
  slider.tabIndex = 0;
  slider.setAttribute("role", "slider");
  slider.setAttribute("aria-orientation", "vertical");
  slider.setAttribute("aria-label", t("panel_point_level_label"));
  slider.setAttribute("aria-valuemin", "0");
  slider.setAttribute("aria-valuemax", String(POINT_LEVELS.length - 1));
  POINT_LEVELS.forEach((_, i) => {
    const notch = document.createElement("span");
    notch.className = "point-level-notch";
    notch.dataset.index = String(i);
    slider.appendChild(notch);
  });
  renderPointLevel(slider, DEFAULT_POINT_EFFECT);
  api.storage.local
    .get([POINT_EFFECT_KEY])
    .then((stored) => renderPointLevel(slider, parseStoredPointEffect(stored?.[POINT_EFFECT_KEY])))
    .catch(() => {});

  const choose = (index) => {
    const level = POINT_LEVELS[Math.max(0, Math.min(POINT_LEVELS.length - 1, index))];
    if (level === slider.dataset.level) return;
    const sliders = [...document.querySelectorAll(".point-level")];
    for (const other of sliders) renderPointLevel(other, level);
    // A failed redraw posts a notice, which re-renders the conversation:
    // focus then moves to this answer's rebuilt slider.
    const position = document.activeElement === slider ? sliders.indexOf(slider) : -1;
    api.storage.local
      .set({ [POINT_EFFECT_KEY]: level })
      .catch(() => {})
      .then(() => pointWithButton(button, entry))
      .then(() => {
        if (position >= 0 && !slider.isConnected) document.querySelectorAll(".point-level")[position]?.focus();
      });
  };
  slider.addEventListener("keydown", (event) => {
    const now = POINT_LEVELS.indexOf(slider.dataset.level);
    const last = POINT_LEVELS.length - 1;
    const next = { ArrowUp: now + 1, ArrowRight: now + 1, ArrowDown: now - 1, ArrowLeft: now - 1, PageUp: last, End: last, PageDown: 0, Home: 0 }[event.key];
    if (next === undefined) return;
    event.preventDefault();
    choose(next);
  });
  slider.addEventListener("click", (event) => {
    const notch = event.target.closest(".point-level-notch");
    if (notch) choose(Number(notch.dataset.index));
  });
  return slider;
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
    // Read fresh at click time (not cached): a level picked on any answer's
    // slider applies to the very next "Montrer : …" click.
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
