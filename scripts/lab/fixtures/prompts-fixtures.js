// Coati state lab — prompts/prompts.html fixtures. See panel-fixtures.js for
// the format and static/browser-stub.js for how `prompts`/`prefs` seed an
// in-memory store (prompts.save/delete/move, prefs.set all mutate it for
// real, so clicking in the lab works).
(function () {
  "use strict";

  // Reused by "editing", "editing-coati" and "delete-armed" — same shape as
  // "with-user", just given a name so the three states don't restate it.
  var SAMPLE_PROMPTS = [
    { id: "p_star_1", site: "*", title: "Traduire", body: "Traduis ce texte en anglais." },
    { id: "p_yt_1", site: "@youtube", title: "Mon prompt", body: "Fais un résumé façon punchlines, en trois phrases maximum." },
    { id: "p_crisco_1", site: "crisco4.unicaen.fr", title: "Étymologie", body: "Donne l'étymologie de ce mot." },
    // Untitled on purpose — the row must show the start of the body instead
    // (encart-items.js's labelForPrompt/truncateLabel).
    { id: "p_crisco_2", site: "crisco4.unicaen.fr", body: "Trouve des synonymes de ce mot, du plus courant au plus rare, et dis lequel est le plus soutenu." },
  ];

  // Kept off any line of its own at a 4-space indent: the lab's
  // stateIdsFromFixtureFile() (build-lab.ts) greps top-level fixture keys
  // with exactly that shape, and would otherwise mistake "sites" or
  // "@youtube" here for a state id.
  // The user's prompt is placed 2nd, between two Coati suggestions.
  var SAMPLE_PREFS = { sites: { "@youtube": { order: ["coati:youtube:summarize", "p_yt_1", "coati:youtube:key-points", "coati:youtube:fact-check"] } } };

  window.__COATI_LAB_FIXTURES__ = {
    // No user prompt anywhere: six cases (Tous les sites + the five popular
    // sites), each showing only Coati's own suggestions.
    default: {
      status: "connected",
      prompts: [],
      prefs: { sites: {} },
    },

    // "*" a une entrée, YouTube mêle Coati et l'utilisateur, crisco n'a que
    // des prompts de l'utilisateur (dont un sans titre) — deux cases
    // supplémentaires apparaissent (aucune autre : un seul site utilisateur ici).
    "with-user": {
      status: "connected",
      prompts: SAMPLE_PROMPTS,
      prefs: SAMPLE_PREFS,
    },

    // YouTube a une suggestion de Coati retirée : le lien "Rétablir les
    // suggestions de Coati" doit apparaître dans sa case.
    removed: {
      status: "connected",
      prompts: [],
      prefs: { sites: { "@youtube": { removed: ["coati:youtube:fact-check"] } } },
    },

    // La ligne du prompt utilisateur de "Tous les sites" est ouverte.
    editing: {
      status: "connected",
      prompts: SAMPLE_PROMPTS,
      prefs: SAMPLE_PREFS,
      autoAction: { steps: [{ type: "click", selector: '[data-key="p_star_1"] .prompt-row-label', delayMs: 30 }] },
    },

    // La ligne d'une suggestion de Coati (YouTube, "Points clés minutés")
    // est ouverte — même éditeur, titre vide au départ.
    "editing-coati": {
      status: "connected",
      prompts: SAMPLE_PROMPTS,
      prefs: SAMPLE_PREFS,
      autoAction: { steps: [{ type: "click", selector: '[data-key="coati:youtube:key-points"] .prompt-row-label', delayMs: 30 }] },
    },

    // Premier clic sur "Effacer" un prompt utilisateur — confirmation en attente.
    "delete-armed": {
      status: "connected",
      prompts: SAMPLE_PROMPTS,
      prefs: SAMPLE_PREFS,
      autoAction: { steps: [{ type: "click", selector: '[data-key="p_star_1"] .prompt-row-delete', delayMs: 30 }] },
    },

    // Broker non connecté : bandeau, rien à afficher ou modifier.
    disconnected: {
      status: "disconnected",
      prompts: [],
      prefs: { sites: {} },
    },

    // Head case (plan-activation-28-09.md "Points tranchés" 1): both parts
    // populated — "*" (titled "Sur tous les sites") and "@unsorted" (no
    // title at all, separated by a thin rule), two prompts each.
    "head-both": {
      status: "connected",
      prompts: [
        { id: "p_star_1", site: "*", title: "Traduire", body: "Traduis ce texte en anglais." },
        { id: "p_star_2", site: "*", body: "Corrige les fautes de ce texte." },
        { id: "p_unsorted_1", site: "@unsorted", title: "Résumer", body: "Résume cette page en 3 phrases." },
        { id: "p_unsorted_2", site: "@unsorted", body: "Explique ce texte simplement." },
      ],
      prefs: { sites: {} },
    },

    // Head case with neither part populated: "Sur tous les sites" keeps its
    // heading + the muted "Aucun prompt pour l'instant." line; the second
    // (unnamed) part renders nothing at all — no zone, no rule. A crisco
    // prompt is included so the screenshot isn't otherwise indistinguishable
    // from "default".
    "head-empty": {
      status: "connected",
      prompts: [{ id: "p_crisco_1", site: "crisco4.unicaen.fr", title: "Étymologie", body: "Donne l'étymologie de ce mot." }],
      prefs: { sites: {} },
    },

    // "Actif" switch (plan-activation-28-09.md "Points tranchés" 2): YouTube
    // and crisco4.unicaen.fr already granted (their permissionPatternsFor()
    // output, literal — see static/browser-stub.js's exact-string matching
    // comment), the other popular sites left ungranted/inactive.
    "sites-activation": {
      status: "connected",
      prompts: [{ id: "p_crisco_1", site: "crisco4.unicaen.fr", title: "Étymologie", body: "Donne l'étymologie de ce mot." }],
      prefs: { sites: {} },
      permissions: ["https://*.youtube.com/*", "https://youtu.be/*", "https://*.crisco4.unicaen.fr/*", "http://*.crisco4.unicaen.fr/*"],
    },

    // G5 (T42 amendé le 30/09 bis) — « tous les sites » accordé par le bouton
    // de l'encart : ligne en tête de la zone des sites, bouton « Revenir au
    // site par site », interrupteurs « Actif » allumés et verrouillés. YouTube
    // et crisco gardent leur accord site par site (visible après le retour).
    "all-sites": {
      status: "connected",
      prompts: [{ id: "p_crisco_1", site: "crisco4.unicaen.fr", title: "Étymologie", body: "Donne l'étymologie de ce mot." }],
      prefs: { sites: {} },
      permissions: ["http://*/*", "https://*/*", "https://*.youtube.com/*", "https://youtu.be/*", "https://*.crisco4.unicaen.fr/*", "http://*.crisco4.unicaen.fr/*"],
    },

    // Même page après « Revenir au site par site » (cliqué au chargement) :
    // la ligne disparaît, YouTube et crisco restent actifs, les autres non.
    "all-sites-revoked": {
      status: "connected",
      prompts: [{ id: "p_crisco_1", site: "crisco4.unicaen.fr", title: "Étymologie", body: "Donne l'étymologie de ce mot." }],
      prefs: { sites: {} },
      permissions: ["http://*/*", "https://*/*", "https://*.youtube.com/*", "https://youtu.be/*", "https://*.crisco4.unicaen.fr/*", "http://*.crisco4.unicaen.fr/*"],
      autoAction: { steps: [{ type: "click", selector: "#allSitesRevoke", delayMs: 100 }] },
    },
  };
})();
