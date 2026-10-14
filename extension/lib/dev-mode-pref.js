// Coati — "Dev mode" preference (no panel dependency, so the options page can
// import it too): storage key, default, and the one-time
// confirmation dialog, shared between the panel's switch (site-card head)
// and the options page's checkbox — ONE preference, ONE storage key, same
// pattern as the former #attachPage switch it replaces (coati:attachPage).
//
// Not a secret (CLAUDE.md rule #1): a feature preference, fine in
// chrome.storage.local, same family as POINT_EFFECT_KEY (point-effect.js).
//
// docs/PROTOCOL.md "Page on demand": `devMode: true` on a `chat` offers the
// model the [[READ_PAGE_DEV]] marker (the page's full cleaned HTML) on top
// of the ordinary text marker — the broker never reads more than the model
// actually asks for, this preference only widens what it may ask for.

import { t } from "./i18n-page.js";

export const DEV_MODE_KEY = "coati:devMode";
export const DEV_MODE_ACKNOWLEDGED_KEY = "coati:devModeAcknowledged";

/** @param {unknown} stored @returns {boolean} */
export function parseStoredDevMode(stored) {
  return stored === true;
}

/** @param {unknown} stored @returns {boolean} */
export function parseStoredDevModeAcknowledged(stored) {
  return stored === true;
}

/**
 * Builds the first-activation confirmation dialog as real DOM nodes
 * (CLAUDE.md rule #3 — no innerHTML), appended to `doc.body`, focus-trapped
 * (Tab/Shift+Tab cycle between the two buttons only) and closable with
 * Escape (treated as "Cancel"). Resolves `true` ("Turn on" clicked) or
 * `false` (Cancel, Escape, or a click on the backdrop) — never rejects.
 * Removes itself from the DOM before resolving either way.
 * @param {Document} doc
 * @returns {Promise<boolean>}
 */
export function confirmDevModeActivation(doc) {
  return new Promise((resolve) => {
    const previouslyFocused = doc.activeElement;

    const backdrop = doc.createElement("div");
    backdrop.className = "dev-mode-dialog-backdrop";

    const dialog = doc.createElement("div");
    dialog.className = "c-card dev-mode-dialog";
    dialog.setAttribute("role", "alertdialog");
    dialog.setAttribute("aria-modal", "true");

    const titleId = "devModeDialogTitle";
    const title = doc.createElement("h2");
    title.id = titleId;
    title.className = "dev-mode-dialog-title";
    title.textContent = t("dev_mode_confirm_title");
    dialog.setAttribute("aria-labelledby", titleId);

    const body = doc.createElement("p");
    body.className = "dev-mode-dialog-text";
    body.textContent = t("dev_mode_confirm_text");

    const actions = doc.createElement("div");
    actions.className = "dev-mode-dialog-actions";

    const cancelBtn = doc.createElement("button");
    cancelBtn.type = "button";
    cancelBtn.className = "c-button";
    cancelBtn.textContent = t("dev_mode_confirm_cancel");

    const confirmBtn = doc.createElement("button");
    confirmBtn.type = "button";
    confirmBtn.className = "c-button c-button--primary";
    confirmBtn.textContent = t("dev_mode_confirm_turn_on");

    actions.appendChild(cancelBtn);
    actions.appendChild(confirmBtn);
    dialog.appendChild(title);
    dialog.appendChild(body);
    dialog.appendChild(actions);
    backdrop.appendChild(dialog);

    function close(result) {
      backdrop.removeEventListener("keydown", onKeydown);
      backdrop.remove();
      if (previouslyFocused && typeof previouslyFocused.focus === "function") previouslyFocused.focus();
      resolve(result);
    }

    function onKeydown(event) {
      if (event.key === "Escape") {
        event.preventDefault();
        close(false);
        return;
      }
      // Focus trap: only two focusable elements in this dialog — Tab/Shift+Tab
      // cycle between them, never escaping to the panel behind the backdrop.
      if (event.key === "Tab") {
        event.preventDefault();
        (doc.activeElement === confirmBtn ? cancelBtn : confirmBtn).focus();
      }
    }

    cancelBtn.addEventListener("click", () => close(false));
    confirmBtn.addEventListener("click", () => close(true));
    // Clicking the backdrop itself (not the dialog) counts as Cancel.
    backdrop.addEventListener("click", (event) => {
      if (event.target === backdrop) close(false);
    });
    backdrop.addEventListener("keydown", onKeydown);

    doc.body.appendChild(backdrop);
    cancelBtn.focus();
  });
}
