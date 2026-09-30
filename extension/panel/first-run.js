// First-launch card (docs/DECISIONS.md T51, P20). Pure state logic, no DOM,
// no chrome.* — panel.js feeds it the facts it already tracks and renders the
// result; broker/test/ui-first-run.test.ts covers it.
//
// Three checks, each "ok" | "missing" | "pending":
//   program — the local program answered through Native Messaging. Read off
//             the service worker's connection state: "no-host" is exactly
//             "the native host call failed" (service-worker.js,
//             resolveBrokerKey); "connected"/"handshaking"/"no-token"/
//             "broker-untrusted" all mean a key came back. "disconnected"/
//             "connecting"/"unknown" can't tell yet → pending (the
//             connection banner already names the fix for a stopped broker).
//   model   — provider.status state "ok", or a first complete answer.
//   page    — the encart button (T50) already read a page once, or the
//             current page is accessible anyway (all sites / this site).

// --- User-facing strings (French; G6 moves them to _locales) --------------
export const FIRST_RUN_TEXT = {
  title: "Premiers pas avec Coati",
  program: {
    ok: "Programme local détecté",
    missing: "Programme local introuvable",
    pending: "Recherche du programme local…",
    action: "Télécharger le programme",
  },
  model: {
    ok: "Modèle connecté",
    missing: "Aucun modèle ne répond",
    pending: "Vérification du modèle…",
    waiting: "Modèle : en attente du programme local",
    action: "Ouvrir les réglages",
  },
  page: {
    ok: "Accès aux pages accordé",
    missing: "Donnez-lui accès à la page",
    hint: "Cliquez sur « Lire cette page » en haut de l'encart. Le navigateur demandera l'accès à tous les sites ; Coati ne lit une page que lorsque vous cliquez.",
    action: "Montrer le bouton",
  },
  marks: { ok: "✓", missing: "✗", pending: "…" },
  markNames: { ok: "fait", missing: "à faire", pending: "en cours" },
};

export const RELEASES_URL = "https://github.com/CARL-Bouvet/coati/releases/latest";
// storage.local key — a preference, never a secret (CLAUDE.md rule #1).
export const FIRST_RUN_DONE_KEY = "coati:firstRunDone";

const PROGRAM_FOUND_STATES = new Set(["connected", "handshaking", "no-token", "broker-untrusted"]);

/**
 * @param {{
 *   connState: string,               // service-worker connection state
 *   providerState: "ok"|"ko"|"unknown"|null, // last provider.status-result state, null = none yet
 *   modelAnswered: boolean,          // a chat/summary reached "done" in this panel
 *   pageAccess: boolean,             // read-button used once, or page accessible now
 * }} facts
 */
export function firstRunChecks(facts) {
  const program =
    facts.connState === "no-host" ? "missing" : PROGRAM_FOUND_STATES.has(facts.connState) ? "ok" : "pending";

  let model;
  if (facts.modelAnswered || facts.providerState === "ok") model = "ok";
  else if (facts.providerState === "ko" || facts.providerState === "unknown") model = "missing";
  else if (program !== "ok" || facts.connState !== "connected") model = "waiting";
  else model = "pending";

  const page = facts.pageAccess ? "ok" : "missing";
  return { program, model, page, allMet: program === "ok" && model === "ok" && page === "ok" };
}

/** Maps a check value to the mark shown (the "waiting" model state renders
 * as pending: nothing to do about the model until the program answers). */
export function markFor(value) {
  return value === "ok" ? "ok" : value === "missing" ? "missing" : "pending";
}
