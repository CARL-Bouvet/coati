// Coati options page — keyboard shortcut display and "About" (split of options.js).
//
// Read-only here: no browser lets an extension set its own shortcut, so the
// button only opens the browser's own shortcut page.

import { api, IS_GECKO } from "../lib/browser-compat.js";
import { shortcutKeys, actionShortcut } from "../lib/shortcut.js";
import { computeCodeFingerprint } from "../lib/build-fingerprint.js";
import { t } from "../lib/i18n-page.js";
import { els } from "./dom-refs.js";
import { clearChildren } from "./dom-helpers.js";

export function setupShortcut() {
  renderShortcut();
  // Coming back from the shortcut page (another tab): re-read the value.
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") renderShortcut();
  });
  api.commands?.onChanged?.addListener?.(renderShortcut);

  if (IS_GECKO) {
    // commands.openShortcutSettings() exists from Firefox 137; older
    // versions get the one-line manual path instead of a dead button.
    if (typeof api.commands?.openShortcutSettings === "function") {
      els.shortcutEdit.hidden = false;
      els.shortcutEdit.addEventListener("click", () => api.commands.openShortcutSettings());
    } else {
      els.shortcutHelp.hidden = false;
    }
  } else {
    // An <a href="chrome://…"> is blocked from an extension page; tabs.create
    // is allowed. Brave redirects chrome:// to brave:// by itself.
    els.shortcutEdit.hidden = false;
    els.shortcutEdit.addEventListener("click", () => api.tabs.create({ url: "chrome://extensions/shortcuts" }));
  }
}

async function renderShortcut() {
  const commands = await api.commands?.getAll?.().catch(() => []);
  const keys = shortcutKeys(actionShortcut(commands));
  clearChildren(els.shortcutKeys);
  if (keys.length === 0) {
    const none = document.createElement("span");
    none.className = "shortcut-none";
    none.textContent = t("options_shortcut_not_set");
    els.shortcutKeys.appendChild(none);
    return;
  }
  keys.forEach((key, index) => {
    if (index > 0) {
      const plus = document.createElement("span");
      plus.className = "shortcut-plus";
      plus.textContent = "+";
      els.shortcutKeys.appendChild(plus);
    }
    const kbd = document.createElement("kbd");
    kbd.textContent = key;
    els.shortcutKeys.appendChild(kbd);
  });
}

// --- About ------------------------------------------------------------------

export async function showAbout() {
  els.aboutVersion.textContent = api.runtime.getManifest().version;
  const fingerprint = await computeCodeFingerprint(api).catch(() => null);
  els.aboutFingerprint.textContent = fingerprint ?? t("panel_unavailable");
}

