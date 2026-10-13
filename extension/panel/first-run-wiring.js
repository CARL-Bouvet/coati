// Coati side panel — first-run card, "never connected" notice, read-button
// wiring and help popover (split of panel.js). Pure state in
// read-button.js / first-run.js; this section only gathers the facts
// (permissions, storage.local preferences, connection and provider state)
// and renders.
import { t } from "../lib/i18n-page.js";
import { getUiLangState } from "../lib/i18n-page.js";
import { currentLanguageName } from "../lib/language-selector.js";
import { api } from "../lib/browser-compat.js";
import { els } from "./dom-refs.js";
import { panelState } from "./panel-state.js";
import { suggestionsFor, siteKeyFor } from "../lib/suggestions.js";
import { permissionPatternsFor } from "../lib/suggestions-data.js";
import { hostFromUrl } from "./card-state.js";
import { startTour, startTourOnce } from "./tour.js";
import {
  readButtonState,
  ALL_SITES_ORIGINS,
  ALL_SITES_DECLINED_KEY,
  READ_BUTTON_USED_KEY,
} from "./read-button.js";
import {
  firstRunChecks,
  markFor,
  FIRST_RUN_TEXT,
  FIRST_RUN_DONE_KEY,
  MODEL_EVER_ANSWERED_KEY,
  MODEL_TUTORIAL_PATH,
  RELEASES_URL,
} from "./first-run.js";
import { currentConnState, providerState, lastProviderReason } from "./model-status.js";
import { AUTH_REQUIRED_TEXT } from "./recovery-blocks.js";
import { currentTabId, langSelector } from "./panel.js";
import { knownOrigin, currentPageUrl, currentFavIconUrl, redetectTab } from "./page-detect.js";

// Coati's own icon, shown in the button's ring when the site's favicon is
// unknown or fails to load — an existing asset, never a drawing (P24).
export const COATI_ICON_PATH = "../icons/icon32.png";
// permissions.onAdded arriving this soon after a full read of the same tab
// is ignored — see onPermissionsChanged in init().
export const PERMISSION_REDETECT_SKIP_MS = 2000;

let allSitesGranted = false;
let siteGranted = false; // this page's own site permission (per-site activation, T42)
let sitePatterns = []; // permissionPatternsFor(knownOrigin), [] when unknown
let allSitesDeclined = false;
let readButtonUsed = false;
let readButtonReading = false;
let readButtonRequest = null; // "all-sites" | "site" | null — what the next click asks for
let firstRunDone = false;
let accessPrefsLoaded = false;

export async function loadAccessPrefs() {
  const keys = [ALL_SITES_DECLINED_KEY, READ_BUTTON_USED_KEY, FIRST_RUN_DONE_KEY, MODEL_EVER_ANSWERED_KEY];
  const stored = await api.storage.local.get(keys).catch(() => ({}));
  allSitesDeclined = stored[ALL_SITES_DECLINED_KEY] === true;
  readButtonUsed = stored[READ_BUTTON_USED_KEY] === true;
  firstRunDone = stored[FIRST_RUN_DONE_KEY] === true;
  // Migration for installs predating this flag (U2): FIRST_RUN_DONE_KEY
  // already true with no MODEL_EVER_ANSWERED_KEY at all means the first-run
  // card completed before this notice existed — its "model" check only
  // passes on providerState "ok" or a real answer, strong enough evidence
  // to infer one happened, rather than resurrecting the notice for every
  // already-onboarded user. A fresh install has neither key true, so the
  // notice still waits behind the first-run card as intended.
  if (MODEL_EVER_ANSWERED_KEY in stored) {
    panelState.modelEverAnswered = stored[MODEL_EVER_ANSWERED_KEY] === true;
  } else {
    panelState.modelEverAnswered = firstRunDone;
    if (panelState.modelEverAnswered) api.storage.local.set({ [MODEL_EVER_ANSWERED_KEY]: true }).catch(() => {});
  }
  accessPrefsLoaded = true;
}

// Opens the model tutorial (U2): the options page,
// jumped to #setup — same destination for the never-connected notice, the
// "?" button, the first-run card's "model" step, the welcome page's model
// step, and every model-related error banner (model unreachable/missing,
// key refused, no credit). "Open settings" buttons about the broker
// connection itself (not the model) keep using openOptionsPage() instead.
export function openModelTutorial() {
  api.tabs.create({ url: api.runtime.getURL(MODEL_TUTORIAL_PATH) });
}

/** Standalone notice shown while Coati has never gotten a real answer from a
 * model — hidden for good once MODEL_EVER_ANSWERED_KEY is set. While the
 * first-run card is still visible, its own "model" step already carries the
 * same action, so this notice stays hidden rather than stacking a second one
 * (U2, Romain's decision: "a shown first-run card absorbs the action"). */
export function renderNeverConnected() {
  if (!accessPrefsLoaded || panelState.modelEverAnswered || !firstRunDone) {
    els.neverConnected.hidden = true;
    return;
  }
  els.neverConnected.hidden = false;
}

/** "?" opens the guided tour (tour.js). */
export function wireHelpButton() {
  els.helpButton.addEventListener("click", startTour);
}

export async function refreshAllSitesGranted() {
  allSitesGranted = await api.permissions.contains({ origins: ALL_SITES_ORIGINS }).catch(() => false);
}

// Bumped on every call to refreshReadButton(); a slower, stale
// permissions.contains() answer (tab switched again meanwhile) checks its
// own token before touching the DOM, so it never clobbers a fresher result.
let readButtonToken = 0;

/** Recomputes the button from `knownOrigin` and the permissions held. Called
 * whenever `knownOrigin` changes and on permissions.onAdded/onRemoved —
 * never throws. */
export async function refreshReadButton() {
  const token = ++readButtonToken;
  const patterns = knownOrigin ? permissionPatternsFor(siteKeyFor(knownOrigin)) : [];
  const granted =
    !allSitesGranted && patterns.length > 0
      ? await api.permissions.contains({ origins: patterns }).catch(() => false)
      : false;
  if (token !== readButtonToken) return; // superseded by a later call
  sitePatterns = patterns;
  siteGranted = granted;
  renderReadButton();
}

export function renderReadButton() {
  const view = readButtonState({
    allSitesGranted,
    siteGranted,
    sitePatternsKnown: sitePatterns.length > 0,
    declined: allSitesDeclined,
    used: readButtonUsed,
    reading: readButtonReading,
    pageReadable: currentPageUrl != null && firstRunDone,
  });
  readButtonRequest = view.request;
  els.readPage.hidden = !view.state;
  if (view.state) {
    els.siteCard.dataset.readButton = view.state;
    els.readPage.dataset.state = view.state;
  } else {
    delete els.siteCard.dataset.readButton;
    delete els.readPage.dataset.state;
  }
  els.readPage.classList.toggle("encart-read--breathing", view.animate);
  // aria-disabled, not `disabled`: a disabled button drops keyboard focus
  // mid-read, and the click handler ignores clicks while reading anyway.
  els.readPage.setAttribute("aria-busy", String(view.state === "reading"));
  els.readPage.setAttribute("aria-disabled", String(view.state === "reading"));
  els.readPageLabel.textContent = view.label;
  if (view.request === "site" && knownOrigin) {
    const siteName = suggestionsFor({ url: knownOrigin }).site?.name ?? hostFromUrl(knownOrigin) ?? knownOrigin;
    els.readPage.title = knownOrigin;
    els.readPage.setAttribute("aria-label", `${view.label} (${siteName})`);
  } else {
    els.readPage.removeAttribute("title");
    els.readPage.removeAttribute("aria-label");
  }
  const icon = currentFavIconUrl || COATI_ICON_PATH;
  if (els.readPageIcon.getAttribute("src") !== icon) els.readPageIcon.src = icon;
  els.readPageNote.textContent = view.note;
  els.readPageNote.hidden = !view.note;
  renderFirstRun();
}

/** Click on the button: the permission request goes out FIRST, before any
 * `await` — Firefox only honours permissions.request inside the click's own
 * task, and Chrome needs the gesture too. Granted → this same click reads
 * the page (detection only: never a summary, rule 5). */
export function onReadPageClick() {
  if (readButtonReading || !readButtonRequest) return;
  const request = readButtonRequest;
  const asked = api.permissions.request({ origins: request === "site" ? sitePatterns : ALL_SITES_ORIGINS });
  readButtonReading = true;
  renderReadButton();
  finishReadPageClick(request, asked);
}

async function finishReadPageClick(request, asked) {
  try {
    const granted = await Promise.resolve(asked).catch(() => false);
    if (!granted) {
      if (request === "all-sites" && !allSitesDeclined) {
        allSitesDeclined = true;
        await api.storage.local.set({ [ALL_SITES_DECLINED_KEY]: true }).catch(() => {});
      }
      return;
    }
    if (request === "all-sites") {
      allSitesGranted = true;
      if (allSitesDeclined) {
        allSitesDeclined = false;
        await api.storage.local.remove(ALL_SITES_DECLINED_KEY).catch(() => {});
      }
    } else {
      siteGranted = true;
    }
    const read = currentTabId != null ? await redetectTab(currentTabId) : false;
    if (read && !readButtonUsed) {
      readButtonUsed = true;
      await api.storage.local.set({ [READ_BUTTON_USED_KEY]: true }).catch(() => {});
    }
  } finally {
    readButtonReading = false;
    await refreshAllSitesGranted();
    await refreshReadButton();
  }
}

/** First-launch card: shown while a check is missing, hidden for good (a
 * storage.local preference) once all three are met. Rebuilt from scratch on
 * each call — it only changes on connection/provider/permission events. */
export function renderFirstRun() {
  if (!accessPrefsLoaded || firstRunDone) {
    els.firstRun.hidden = true;
    renderNeverConnected();
    return;
  }
  const checks = firstRunChecks({
    connState: currentConnState,
    providerState,
    modelAnswered: panelState.modelAnswered,
    pageAccess: readButtonUsed || allSitesGranted || siteGranted,
  });
  if (checks.allMet) {
    firstRunDone = true;
    els.firstRun.hidden = true;
    api.storage.local.set({ [FIRST_RUN_DONE_KEY]: true }).catch(() => {});
    renderNeverConnected();
    startTourOnce();
    return;
  }
  els.firstRunTitle.textContent = FIRST_RUN_TEXT.title;
  // U2: the "never spoken to a model" fact, folded into the card instead of
  // stacking the standalone notice under it (renderNeverConnected() stays
  // hidden while this card shows) — same text, one line under the title.
  els.firstRunNeverConnected.hidden = panelState.modelEverAnswered;
  els.firstRunSteps.replaceChildren(
    firstRunStep("program", checks.program, () => api.tabs.create({ url: RELEASES_URL })),
    firstRunStep("model", checks.model, openModelTutorial, buildOllamaCommandRow()),
    firstRunStep("page", checks.page, pointAtReadButton),
  );
  renderFirstRunLang();
  els.firstRun.hidden = false;
  renderNeverConnected(); // first-run card visible: stays hidden (no stacking)
}

// Discreet one-line language mention in the first-run card (U1, "Defaults
// decided upfront": "Language: English · change" is enough). "change"
// opens the same menu as the header's language button.
async function renderFirstRunLang() {
  const state = await getUiLangState();
  els.firstRunLang.replaceChildren(
    document.createTextNode(`${t("panel_first_run_lang", [currentLanguageName(state)])} · `),
  );
  const change = document.createElement("button");
  change.type = "button";
  change.className = "link-button";
  change.textContent = t("panel_first_run_lang_change");
  change.addEventListener("click", () => langSelector.open());
  els.firstRunLang.appendChild(change);
}

// Ollama's two "model" failure reasons (docs/PROTOCOL.md "Provider
// availability") each have one exact terminal command that fixes them — no
// configured-model name reaches the panel (provider.status-result carries
// none), so "ollama pull" falls back to llama3.2, Ollama's own default.
export const OLLAMA_DEFAULT_MODEL = "llama3.2";

/** @returns {HTMLElement|null} a copyable-command row for the first-run
 * "model" step, only when the last provider.status-result points at one of
 * Ollama's two fixable states — null otherwise (settings button is enough). */
export function buildOllamaCommandRow() {
  let command;
  if (lastProviderReason === "ollama-unreachable") command = "ollama serve";
  else if (lastProviderReason === "model-missing" || lastProviderReason === "no-model-installed") {
    command = `ollama pull ${OLLAMA_DEFAULT_MODEL}`;
  } else return null;

  const row = document.createElement("div");
  row.className = "recovery-command";
  const code = document.createElement("code");
  code.textContent = command;
  const copyBtn = document.createElement("button");
  copyBtn.type = "button";
  copyBtn.className = "recovery-copy";
  copyBtn.textContent = AUTH_REQUIRED_TEXT.copy;
  copyBtn.addEventListener("click", () => copyCommand(copyBtn, command));
  row.append(code, copyBtn);
  return row;
}

/** Shared by copyLoginCommand() below (kept for the exact string it already
 * copies) and buildOllamaCommandRow() above — same copy/feedback dance. */
export async function copyCommand(button, command) {
  const original = button.textContent;
  try {
    await navigator.clipboard.writeText(command);
    button.textContent = AUTH_REQUIRED_TEXT.copied;
  } catch {
    button.textContent = AUTH_REQUIRED_TEXT.copyFailed;
  }
  setTimeout(() => {
    button.textContent = original;
  }, 1500);
}

function firstRunStep(check, value, onAction, extraNode) {
  const text = FIRST_RUN_TEXT[check];
  const status = markFor(value);
  const li = document.createElement("li");
  li.className = "first-run-step";
  li.dataset.check = check;
  li.dataset.status = status;

  const mark = document.createElement("span");
  mark.className = "first-run-mark";
  mark.setAttribute("aria-hidden", "true");
  mark.textContent = FIRST_RUN_TEXT.marks[status];

  const body = document.createElement("div");
  body.className = "first-run-body";
  const label = document.createElement("span");
  label.className = "first-run-label";
  const statusName = document.createElement("span");
  statusName.className = "visually-hidden";
  statusName.textContent = `${FIRST_RUN_TEXT.markNames[status]} : `;
  label.append(statusName, text[value] ?? text[status]);
  body.appendChild(label);

  if (status === "missing") {
    if (text.hint) {
      const hint = document.createElement("p");
      hint.className = "first-run-hint";
      hint.textContent = text.hint;
      body.appendChild(hint);
    }
    if (extraNode) body.appendChild(extraNode);
    const action = document.createElement("button");
    action.type = "button";
    action.className = "toolbar-button first-run-action";
    action.textContent = text.action;
    action.addEventListener("click", onAction);
    body.appendChild(action);
  }
  li.append(mark, body);
  return li;
}

/** "Show the button": moves focus to the encart button — the user still
 * clicks it themselves (the first read is never launched for them). */
export function pointAtReadButton() {
  if (els.readPage.hidden) return;
  els.readPage.scrollIntoView({ block: "nearest" });
  els.readPage.focus({ focusVisible: true });
  // Programmatic focus after a mouse click may not draw :focus-visible —
  // a short outline of its own makes sure the eye lands on it.
  els.readPage.classList.add("encart-read--pointed");
  setTimeout(() => els.readPage.classList.remove("encart-read--pointed"), 2000);
}
