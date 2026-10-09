// Coati — "Dev mode" switch in the panel. The preference itself (storage
// keys, parsing, confirmation dialog) lives in lib/dev-mode-pref.js, shared
// with the options page.

import { els } from "./dom-refs.js";
import { panelState } from "./panel-state.js";
import { hasFeature } from "./model-status.js";

export {
  DEV_MODE_KEY,
  DEV_MODE_ACKNOWLEDGED_KEY,
  parseStoredDevMode,
  parseStoredDevModeAcknowledged,
  confirmDevModeActivation,
} from "../lib/dev-mode-pref.js";

// --- Panel switch wiring ----------------------------------------------------

/** `#devMode` is a `role="switch"` button, not a checkbox — same convention
 * as the former `#attachPage`/`#attachScreen` it replaces. */
export function setDevModeChecked(checked) {
  els.devMode.setAttribute("aria-checked", String(checked));
  els.devMode.classList.toggle("switch--on", checked);
}

export function isDevModeChecked() {
  return els.devMode.getAttribute("aria-checked") === "true";
}

/** Shows/hides the switch (only meaningful once the broker offers "page on
 * demand" — an older broker build never asks for the page at all, so the
 * preference would do nothing) and keeps its checked state in sync with
 * `panelState.devModePreference`. Applies the `mode-dev` root class (CSS
 * hook for a later styling pass — no restyling in this change) regardless
 * of whether the switch itself is currently shown, so a preference set from
 * the options page still takes effect even before this panel has heard
 * hello-ok. Called whenever either input changes: broker features
 * (applyBrokerFeatures()) or the preference itself (the click handler, or a
 * chrome.storage.onChanged event from the options page). */
export function updateDevModeUi() {
  els.devMode.hidden = !hasFeature("pageOnDemand");
  setDevModeChecked(panelState.devModePreference);
  document.documentElement.classList.toggle("mode-dev", panelState.devModePreference);
}
