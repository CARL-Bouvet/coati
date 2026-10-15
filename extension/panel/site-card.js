// Coati side panel — site card (T27-T29, encart), split of panel.js.
//
// Fixed-size block: a small spinner while (re)detection is running (only if
// it takes a moment — see card-state.js's SPINNER_DELAY_MS), then the site's
// own favicon + name when suggestions.js recognizes the site, the host name
// on an unrecognized-but-readable site, or neither on a site we have no
// permission for yet (unchanged "Activer Coati sur ce site" flow below it).
// Its buttons (encart-items.js's ordering) replace the old fixed "Summarize"
// button entirely: on YouTube, the first Coati suggestion IS the summarize
// action (coati:youtube:summarize) — there is no other way to trigger
// summarize() anymore. An unknown site with nothing saved shows only the
// head line and "My prompts ↗".
import { t } from "../lib/i18n-page.js";
import { els } from "./dom-refs.js";
import { panelState } from "./panel-state.js";
import { suggestionsFor } from "../lib/suggestions.js";
import { cardState, hostFromUrl, SPINNER_DELAY_MS } from "./card-state.js";
import { encartItems } from "./encart-items.js";
import { currentPageUrl, currentFavIconUrl, pageKind } from "./page-detect.js";
import { runSuggestion } from "./composer-send.js";
import { summarize } from "./page-extract.js";

/** @type {Array<{id:string, site:string, title?:string, body:string}>} */
let prompts = [];
/** @type {Record<string, {order?:string[], removed?:string[]}>} */
let prefsSites = {};

// Relayed as broadcast (service-worker.js broadcasts every broker message to
// all extension pages) — applied here whoever requested it, so this panel
// stays in sync with any change made from "Mes prompts" in another tab, for
// free.
export function onPromptsMessage(message) {
  prompts = Array.isArray(message.items) ? message.items : [];
  // prompts.move's reply also carries the full prefs (docs/PROTOCOL.md) —
  // folded in here too, so a move made elsewhere updates order/removed
  // without a separate round trip.
  if (message.prefs && typeof message.prefs === "object" && message.prefs.sites) {
    prefsSites = message.prefs.sites;
  }
  updateSiteCard();
}

/** The line above the composer saying the open page is one Coati cannot read. */
export function setInternalPageNotice(shown) {
  els.internalPageNotice.hidden = !shown;
}

export function onPrefsMessage(message) {
  prefsSites = message.sites && typeof message.sites === "object" ? message.sites : {};
  updateSiteCard();
}

let cardDetectingTimer = null;

/** Arms the spinner-after-a-delay timer. Paired with endCardDetection() in a
 * try/finally around every (re)detection — see redetectTab() and
 * redetectTabFromMetadata() in page-detect.js. */
export function beginCardDetection() {
  clearTimeout(cardDetectingTimer);
  cardDetectingTimer = setTimeout(showCardSpinner, SPINNER_DELAY_MS);
}

export function endCardDetection() {
  clearTimeout(cardDetectingTimer);
  cardDetectingTimer = null;
}

function showCardSpinner() {
  els.siteCard.dataset.state = "detecting";
  els.siteCardSpinner.hidden = false;
  els.siteCardFavicon.hidden = true;
  els.siteCardLabel.textContent = "";
}

/** Recomputes and re-renders the card from the current detection state.
 * Called after every point that changes `currentPageUrl`/`pageKind`/
 * `currentFavIconUrl`/`prompts`/`prefsSites` — see resetPageState(),
 * applyDetectedContext(), redetectTabFromMetadata(), refreshFavIcon(),
 * handleBrokerMessage()'s "prompts"/"prefs" cases. */
export function updateSiteCard() {
  const result = suggestionsFor({ url: currentPageUrl, pageKind });
  const state = cardState({ url: currentPageUrl, site: result.site ?? null });
  renderSiteCard(state, result);
}

export function renderSiteCard(state, result) {
  els.siteCard.dataset.state = state;
  els.siteCardSpinner.hidden = true;

  // Favicon absent, or its icon failed to load (Brave bug, handled by the
  // "error" listener): the icon slot simply collapses — no placeholder
  // square.
  const showFavicon = !!currentFavIconUrl;
  els.siteCardFavicon.hidden = !showFavicon;
  if (showFavicon) {
    els.siteCardFavicon.src = currentFavIconUrl;
  } else {
    els.siteCardFavicon.removeAttribute("src");
  }

  if (state === "known") {
    els.siteCardLabel.textContent = result.site?.name ?? "";
  } else if (state === "unknown") {
    els.siteCardLabel.textContent = hostFromUrl(currentPageUrl) ?? "";
  } else {
    // Unreadable URL (site not activated): the head line is reserved anyway
    // (no layout jump, T27) — a neutral label beats an empty band.
    els.siteCardLabel.textContent = t("common_this_page");
  }

  renderEncart(result.siteKey, result.items ?? []);
}

/** Rebuilds the encart's buttons from encart-items.js's ordering: the site's
 * own case (Coati suggestions minus removed, plus the user's prompts for
 * that site), then "All sites" — "My prompts ↗" is a separate, static
 * button in the markup, always last. Real DOM
 * nodes, textContent only (project rule 16): a prompt's title/body is
 * user data, a suggestion's label ships with the extension — same
 * discipline either way. The first button keeps the primary/caramel style
 * whatever its kind, since the user controls the order (see report). */
function renderEncart(siteKey, coatiItems) {
  const buttons = encartItems({ siteKey, coatiItems, prompts, prefsSites });
  els.siteCardSuggestions.textContent = "";
  buttons.forEach((button, index) => {
    const el = document.createElement("button");
    el.type = "button";
    el.className = `c-button c-button--small site-card-suggestion${index === 0 ? " c-button--primary" : ""}`;
    el.textContent = button.label;
    el.disabled = !!panelState.activeRequestId;
    el.addEventListener("click", () => runEncartButton(button));
    els.siteCardSuggestions.appendChild(el);
  });
}

/** A click on any encart button: the YouTube summarize item reuses the
 * existing summarize() path (extraction + transcript handling unchanged);
 * every other item — Coati suggestion or user prompt — goes through
 * runSuggestion(), which always reads the page (rule of the gesture). */
function runEncartButton(button) {
  if (button.action === "summarize") {
    summarize();
  } else {
    runSuggestion(button.prompt);
  }
}
