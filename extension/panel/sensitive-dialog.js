// Coati — confirmation dialog shown before a dev-level page read leaves for
// an online model when extension/lib/sensitive-scan.js found an obvious
// pattern (CLAUDE.md product rule #8: "Sensitive data: warn, never mask").
// Same focus-trapped, Escape-closes, backdrop-click-cancels shape as
// lib/dev-mode-pref.js's confirmDevModeActivation() — kept separate because the
// two dialogs answer different questions (switch dev mode on vs. send this
// particular page) and show different, data-dependent text.

import { t } from "../lib/i18n-page.js";

const KIND_LABEL_KEYS = {
  "api-key": "sensitive_kind_api_key",
  card: "sensitive_kind_card",
  iban: "sensitive_kind_iban",
};

/**
 * Builds and shows the dialog, focus-trapped between its two buttons.
 * Resolves `true` ("Send anyway") or `false` (Cancel, Escape, or a click on
 * the backdrop) — never rejects. Removes itself from the DOM before
 * resolving either way.
 * @param {Document} doc
 * @param {string[]} kinds - from scanForSensitiveData(), non-empty
 * @param {string} kTokens - already formatted (formatTokensK())
 * @returns {Promise<boolean>}
 */
export function confirmSendSensitivePage(doc, kinds, kTokens) {
  return new Promise((resolve) => {
    const previouslyFocused = doc.activeElement;

    const backdrop = doc.createElement("div");
    backdrop.className = "dev-mode-dialog-backdrop";

    const dialog = doc.createElement("div");
    dialog.className = "dev-mode-dialog";
    dialog.setAttribute("role", "alertdialog");
    dialog.setAttribute("aria-modal", "true");

    const titleId = "sensitiveDialogTitle";
    const title = doc.createElement("h2");
    title.id = titleId;
    title.className = "dev-mode-dialog-title";
    title.textContent = t("sensitive_dialog_title");
    dialog.setAttribute("aria-labelledby", titleId);

    const kindsLabel = kinds.map((kind) => t(KIND_LABEL_KEYS[kind] ?? kind)).join(", ");
    const body = doc.createElement("p");
    body.className = "dev-mode-dialog-text";
    body.textContent = t("sensitive_dialog_text", [kindsLabel, kTokens]);

    const actions = doc.createElement("div");
    actions.className = "dev-mode-dialog-actions";

    const cancelBtn = doc.createElement("button");
    cancelBtn.type = "button";
    cancelBtn.className = "button-secondary";
    cancelBtn.textContent = t("sensitive_dialog_cancel");

    const sendBtn = doc.createElement("button");
    sendBtn.type = "button";
    sendBtn.className = "dev-mode-dialog-confirm";
    sendBtn.textContent = t("sensitive_dialog_send");

    actions.appendChild(cancelBtn);
    actions.appendChild(sendBtn);
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
        (doc.activeElement === sendBtn ? cancelBtn : sendBtn).focus();
      }
    }

    cancelBtn.addEventListener("click", () => close(false));
    sendBtn.addEventListener("click", () => close(true));
    // Clicking the backdrop itself (not the dialog) counts as Cancel.
    backdrop.addEventListener("click", (event) => {
      if (event.target === backdrop) close(false);
    });
    backdrop.addEventListener("keydown", onKeydown);

    doc.body.appendChild(backdrop);
    cancelBtn.focus();
  });
}
