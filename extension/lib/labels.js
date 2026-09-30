// Shared French labels for provider names and broker error codes — the
// single source of truth for text the panel and the options page both need
// to keep in sync (bug report "panneau et réglages", gaps 3 and 4). Loaded
// the same way as the other lib/*.js modules (plain ESM import, no build).

// One name per BUILT-IN provider, used everywhere (panel status suffix,
// options provider list, error text) — never a different name in one place
// and another elsewhere. Any provider id NOT in this table (an externally
// loaded module, see docs/MODULES.md) has no built-in text here: the caller
// falls back to the `label` the broker sent for it — see providerLabel()
// below.
export const PROVIDER_LABELS = {
  "claude-api": "Claude (clé API)",
  ollama: "Ollama (local)",
  "openai-compat": "Compatible OpenAI",
};

// Connection-status labels — shared base for panel.js's renderStatusLabel()
// and options.js's applyStatus() (KISS audit 2026-09-26, item 9: the two
// were kept as separate copies). "no-token" differs slightly between the two
// callers (panel adds "— voir réglages"), so it's the one entry callers may
// override rather than being forced through here.
export const CONNECTION_STATUS_LABELS = {
  connected: "Connecté",
  connecting: "Connexion…",
  handshaking: "Connexion…",
  "handshake-timeout": "Connexion…",
  disconnected: "Déconnecté",
  "no-token": "Pas de jeton",
  // docs/PROTOCOL.md amendement 2026-09-30 ("Poignée de main v: 2"):
  // "no-host" = the native-messaging host is unreachable; "broker-untrusted"
  // = a program is listening on the port but didn't prove it's the broker.
  "no-host": "Programme local introuvable",
  "broker-untrusted": "Broker non vérifié",
  unknown: "…",
};

/** @param {string} id @param {string} [fallback] - broker-sent label, used
 * only if this build doesn't know the id (forward compat). */
export function providerLabel(id, fallback) {
  return PROVIDER_LABELS[id] ?? fallback ?? id;
}

// French label per broker ErrorCode (broker/src/protocol.ts's ErrorCode).
// This is the primary, human-facing line. The broker's `message` is English
// technical detail (docs/PROTOCOL.md amendment 2026-09-26) and is NEVER
// shown alone — describeError() below always appends it as a secondary
// "Détail : …" line, never as the primary text.
const ERROR_CODE_LABELS = {
  "bad-request": "Requête invalide.",
  unauthorized: "Non autorisé.",
  "model-unavailable": "Le modèle ne répond pas.",
  "auth-required": "Authentification requise auprès du fournisseur de modèle.",
  "context-too-large": "Le contenu envoyé est trop volumineux pour le modèle.",
  cancelled: "Requête annulée.",
  internal: "Erreur interne du broker.",
};

/**
 * @param {string} code - broker ErrorCode. Anything unrecognized (an
 *   older/newer broker) falls back to a generic French label rather than
 *   surfacing the raw code.
 * @param {string} [message] - broker's English technical detail. Shown only
 *   as a secondary "Détail : …" line, appended after the label — never
 *   returned on its own.
 * @returns {string} ready-to-display text, one or two lines (\n-joined).
 */
export function describeError(code, message) {
  const label = ERROR_CODE_LABELS[code] ?? "Une erreur est survenue.";
  return message ? `${label}\nDétail : ${message}` : label;
}

// Provider-unavailability `reason` (SettingsMessage.available[].reason,
// broker/src/protocol.ts) is free English text, not a closed code set (it
// can embed a path or URL — see broker/src/providers/*.ts) — there is no
// `code` to key a label table on. So the label here is always the same
// generic French sentence; the broker's own words become the secondary
// "Détail : …" line, per the same never-alone rule as describeError().
const PROVIDER_UNAVAILABLE_LABEL = "Indisponible.";

// Security review 2026-09-26, finding #2: chrome.scripting.executeScript has
// no built-in deadline, so a hostile or pathological page could leave the
// panel waiting forever for page content. panel.js races extraction against
// EXTRACTION_TIMEOUT_MS and surfaces this label when it loses.
export const EXTRACTION_TIMEOUT_LABEL = "La page met trop de temps à être lue.";

// T47 (docs/DECISIONS.md): verified 2026-09-29 that neither Chrome/Brave's
// injection-refused error nor Firefox's names the three gestures that grant
// access, so the panel names them itself instead of trying to mine an origin
// out of an error message. Shared with panel.js's looksLikeAccessDenied()
// call sites so the three gestures are worded identically everywhere.
export const ACCESS_DENIED_HINT =
  "Cliquez sur son icône, faites un clic droit → « Lire cette page avec Coati », ou utilisez le raccourci clavier.";

/**
 * @param {string} [reason] - broker's free-text English reason, or absent.
 * @returns {string} ready-to-display text, one or two lines (\n-joined).
 */
export function describeProviderUnavailable(reason) {
  return reason ? `${PROVIDER_UNAVAILABLE_LABEL}\nDétail : ${reason}` : PROVIDER_UNAVAILABLE_LABEL;
}
