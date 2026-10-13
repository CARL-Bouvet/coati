// Coati side panel — "Mes prompts" round trips and "save current composer
// text" (split of panel.js).
//
// The library itself (list/order/removed suggestions/editing) is managed on
// the "Mes prompts" page (a later phase); the panel only ever reads it (to
// build the encart) and writes exactly one thing: the disquette below, which
// saves the current composer text with no title, into the current site's
// case (or "All sites" on an unreadable address).
import { t } from "../lib/i18n-page.js";
import { api } from "../lib/browser-compat.js";
import { els } from "./dom-refs.js";
import { newId } from "./panel-state.js";
import { suggestionsFor, siteKeyFor } from "../lib/suggestions.js";
import { hostFromUrl } from "./card-state.js";
import { currentPageUrl } from "./page-detect.js";

export function requestPrompts() {
  api.runtime.sendMessage({
    type: "coati:client-message",
    payload: { type: "prompts.list", id: newId() },
  });
}

export function requestPrefs() {
  api.runtime.sendMessage({
    type: "coati:client-message",
    payload: { type: "prefs.get", id: newId() },
  });
}

export function openMyPromptsPage() {
  api.tabs.create({ url: api.runtime.getURL("prompts/prompts.html") });
}

export function updateSavePromptEnabled() {
  els.savePrompt.disabled = els.input.value.trim().length === 0;
}

export function saveCurrentAsPrompt() {
  const body = els.input.value.trim();
  if (!body) return;
  // T44: an unreadable address no longer files silently into "All
  // sites" (docs/DECISIONS.md, T33) — it goes to the unnamed,
  // unsorted part of the head case instead.
  const siteKey = siteKeyFor(currentPageUrl) ?? "@unsorted";
  api.runtime.sendMessage({
    type: "coati:client-message",
    payload: { type: "prompts.save", id: newId(), prompt: { site: siteKey, body } },
  });
  requestPrompts();
  showPromptSavedNotice(siteKey);
}

let promptSavedNoticeTimer = null;

/** Calm, temporary confirmation (no title asked, no dialog) — cleared after
 * ~2s, same pattern as the recovery block's "Copied!". */
export function showPromptSavedNotice(siteKey) {
  clearTimeout(promptSavedNoticeTimer);
  if (siteKey === "@unsorted") {
    els.promptSavedNotice.textContent = t("panel_prompt_saved_no_site");
  } else {
    const label = siteKey === "*" ? t("common_all_sites") : suggestionsFor({ url: currentPageUrl }).site?.name ?? hostFromUrl(currentPageUrl) ?? siteKey;
    els.promptSavedNotice.textContent = t("panel_prompt_saved_for", [label]);
  }
  promptSavedNoticeTimer = setTimeout(() => {
    els.promptSavedNotice.textContent = "";
  }, 2000);
}
