// Welcome page (docs/DECISIONS.md T51) — opened once by the service worker's
// runtime.onInstalled when reason === "install", never on an update. Static
// content: pin the icon (wording per engine), the three first-launch steps,
// the installer link. Reads nothing, sends nothing to the broker.

import { api, IS_GECKO } from "../lib/browser-compat.js";
import { RELEASES_URL } from "../panel/first-run.js";
import { t, setDocumentLanguage, reloadOnLanguageChange } from "../lib/i18n-page.js";
import { mountLanguageSelector } from "../lib/language-selector.js";

setDocumentLanguage();
mountLanguageSelector(document.getElementById("langSelectorMount"));

function setText(id, text) {
  const el = document.getElementById(id);
  if (el) el.textContent = text;
}

// U1 — live language switch: this page builds every string in JS (no
// data-i18n* markup), so it re-reads the whole TEXT table and repaints on
// every uiLang change (onLanguageChange below), same as on first load.
function render() {
  setDocumentLanguage();
  // --- User-facing strings, from _locales/<lang>/messages.json ------------
  const TEXT = {
    pageTitle: t("welcome_title"),
    title: t("welcome_title"),
    lead: t("welcome_lead"),
    pinTitle: t("welcome_pin_title"),
    pinBrowserChromium: t("welcome_pin_browser_chromium"),
    pinBrowserGecko: t("welcome_pin_browser_gecko"),
    pinStepsChromium: [
      t("welcome_pin_step1_chromium"),
      t("welcome_pin_step2_chromium"),
      t("welcome_pin_step3_chromium"),
    ],
    pinStepsGecko: [
      t("welcome_pin_step1_gecko"),
      t("welcome_pin_step2_gecko"),
      t("welcome_pin_step3_gecko"),
    ],
    stepsTitle: t("welcome_steps_title"),
    programTitle: t("welcome_program_title"),
    programText: t("welcome_program_text"),
    programLink: t("welcome_program_link"),
    modelTitle: t("welcome_model_title"),
    modelText: t("welcome_model_text"),
    modelAction: t("panel_open_settings"),
    pageTitleStep: t("welcome_page_title"),
    pageTextChromium: t("welcome_page_text_chromium"),
    pageTextGecko: t("welcome_page_text_gecko"),
    gesture: t("welcome_gesture"),
  };

  document.title = TEXT.pageTitle;
  setText("welcomeTitle", TEXT.title);
  setText("welcomeLead", TEXT.lead);
  setText("pinTitle", TEXT.pinTitle);
  setText("pinBrowser", IS_GECKO ? TEXT.pinBrowserGecko : TEXT.pinBrowserChromium);
  document.getElementById("pinSteps").replaceChildren(
    ...(IS_GECKO ? TEXT.pinStepsGecko : TEXT.pinStepsChromium).map((step) => {
      const li = document.createElement("li");
      li.textContent = step;
      return li;
    }),
  );
  setText("stepsTitle", TEXT.stepsTitle);
  setText("stepProgramTitle", TEXT.programTitle);
  setText("stepProgramText", TEXT.programText);
  const programLink = document.getElementById("stepProgramLink");
  programLink.href = RELEASES_URL;
  programLink.textContent = TEXT.programLink;
  setText("stepModelTitle", TEXT.modelTitle);
  setText("stepModelText", TEXT.modelText);
  const modelAction = document.getElementById("stepModelAction");
  modelAction.textContent = TEXT.modelAction;
  setText("stepPageTitle", TEXT.pageTitleStep);
  setText("stepPageText", IS_GECKO ? TEXT.pageTextGecko : TEXT.pageTextChromium);
  setText("welcomeGesture", TEXT.gesture);
}

document.getElementById("stepModelAction").addEventListener("click", () => api.runtime.openOptionsPage());

render();
// U1 — live language switch: this page re-reads t() lazily inside render(),
// so it could repaint in place; reloading instead keeps every page's switch
// behavior uniform (panel.js, options.js, prompts.js) and is simple and
// complete for a page with no state to lose.
reloadOnLanguageChange();
