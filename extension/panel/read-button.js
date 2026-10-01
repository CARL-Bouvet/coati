// Encart "Lire cette page" button (docs/DECISIONS.md T50, amended T42/T43).
// Pure state logic, no DOM, no chrome.* — panel.js feeds it the permission
// facts and renders the result; broker/test/ui-read-button.test.ts covers it.
//
// States (data-state on the button):
//   "invite"  — page not accessible, waiting for the click. The caramel ring
//               "breathes" (halo pulse) only while `animate` is true.
//   "reading" — the click was accepted and the page is being read: the same
//               ring opens into an arc and spins (the one honest "busy" sign).
//   "refused" — the user declined "all sites" once: no motion, per-site
//               wording when the address is known, plus an explanation line.
//   null      — hidden: the page is already accessible.

import { t } from "../lib/i18n-page.js";

// --- User-facing strings, from _locales/<lang>/messages.json --------------
export const READ_BUTTON_TEXT = {
  invite: t("panel_read_button_invite"),
  reading: t("panel_read_button_reading"),
  activateSite: t("panel_read_button_activate_site"),
  refusedNote: t("panel_read_button_refused_note"),
  refusedNoteUnknownSite: t("panel_read_button_refused_note_unknown_site"),
};

// The one "all sites" request of T42 (amended 30/09): explicit schemes,
// never `*://` (Chrome silently rejects it).
export const ALL_SITES_ORIGINS = ["http://*/*", "https://*/*"];

// storage.local keys — preferences, never secrets (CLAUDE.md rule #1).
export const ALL_SITES_DECLINED_KEY = "coati:allSitesDeclined";
export const READ_BUTTON_USED_KEY = "coati:readButtonUsed";

/**
 * @param {{
 *   allSitesGranted: boolean,
 *   siteGranted: boolean,      // this page's own site permission (per-site activation)
 *   sitePatternsKnown: boolean, // the address is known AND maps to requestable patterns
 *   declined: boolean,         // "all sites" was refused before (ALL_SITES_DECLINED_KEY)
 *   used: boolean,             // a read through this button already succeeded once
 *   reading: boolean,          // a click is being served right now
 *   pageReadable: boolean,     // this page was just read through another gesture
 *                              // (toolbar icon, activeTab) — pass false during the
 *                              // first launch, whose last step IS this button
 * }} facts
 * @returns {{ state: "invite"|"reading"|"refused"|null, request: "all-sites"|"site"|null,
 *   label: string, note: string, animate: boolean }}
 */
export function readButtonState(facts) {
  const hidden = { state: null, request: null, label: "", note: "", animate: false };
  if (facts.reading) {
    return { state: "reading", request: null, label: READ_BUTTON_TEXT.reading, note: "", animate: false };
  }
  if (facts.allSitesGranted || facts.siteGranted) return hidden;
  // Already readable right now: nothing to invite to. Someone who declined
  // "all sites" still gets "Activer ce site" here — the T43 path, the only
  // moment Chrome lets the panel know the address of a non-activated site.
  if (facts.pageReadable && !facts.declined) return hidden;
  if (facts.declined) {
    if (facts.sitePatternsKnown) {
      return {
        state: "refused",
        request: "site",
        label: READ_BUTTON_TEXT.activateSite,
        note: READ_BUTTON_TEXT.refusedNote,
        animate: false,
      };
    }
    // Address unknown: per-site activation has nothing to name, so the only
    // thing a click can do is ask for "all sites" again (an explicit click,
    // never an automatic re-prompt).
    return {
      state: "refused",
      request: "all-sites",
      label: READ_BUTTON_TEXT.invite,
      note: READ_BUTTON_TEXT.refusedNoteUnknownSite,
      animate: false,
    };
  }
  return { state: "invite", request: "all-sites", label: READ_BUTTON_TEXT.invite, note: "", animate: !facts.used };
}
