// A command line + "Copy" button, shared by Settings (options-setup.js) and
// the welcome page. Writing to the clipboard on a click is fine; Coati never
// READS the clipboard. Styles: lib/components.css (.setup-command*).

import { t } from "./i18n-page.js";

function node(tag, className, text) {
  const n = document.createElement(tag);
  n.className = className;
  if (text != null) n.textContent = text;
  return n;
}

/** `block`: several lines, kept as typed (a line too long for the box wraps). */
export function commandLine(command, { block = false } = {}) {
  const wrap = node("div", "setup-command");
  const code = node("code", block ? "c-field setup-command-text setup-command-text--block" : "c-field setup-command-text", command);
  const copy = node("button", "c-button c-button--small setup-copy", t("setup_copy"));
  copy.type = "button";
  copy.addEventListener("click", async () => {
    let ok = false;
    try {
      await navigator.clipboard.writeText(command);
      ok = true;
    } catch {
      // Fallback: select the text so Ctrl+C works.
      const range = document.createRange();
      range.selectNodeContents(code);
      const selection = window.getSelection();
      selection?.removeAllRanges();
      selection?.addRange(range);
    }
    copy.textContent = ok ? t("setup_copied") : t("setup_copy_manual");
    setTimeout(() => {
      copy.textContent = t("setup_copy");
    }, 2000);
  });
  wrap.append(code, copy);
  return wrap;
}
