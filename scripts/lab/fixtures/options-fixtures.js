// Coati state lab — options.html fixtures. See panel-fixtures.js for the
// format and static/browser-stub.js for how these fields are consumed.
(function () {
  "use strict";

  var NOMINAL_SETTINGS = {
    provider: "claude-api",
    model: null,
    models: [],
    available: [
      { id: "claude-api", available: true, configured: true, label: "Clé API Anthropic" },
      { id: "ollama", available: false, configured: false, reason: "ollama-unreachable", label: "Ollama" },
      { id: "demo-module", available: true, configured: false, label: "Modèle maison (module)" },
    ],
  };

  window.__COATI_LAB_FIXTURES__ = {
    // Toutes les sections remplies : jeton, fournisseurs (dont un clé API
    // déjà enregistrée, un fournisseur indisponible avec motif), rétention,
    // sites autorisés.
    nominal: {
      status: "connected",
      settings: NOMINAL_SETTINGS,
      storageLocal: { "coati:retentionDays": 30 },
      permissions: ["https://www.youtube.com/*", "https://exemple-actu.fr/*"],
    },

    // Broker non connecté : bandeau "impossible d'afficher le fournisseur".
    disconnected: {
      status: "disconnected",
      storageLocal: { "coati:retentionDays": null },
      permissions: ["https://www.youtube.com/*"],
    },

    // "Effacer la clé" armé (premier clic) — confirmation en attente.
    "key-erase-confirm": {
      status: "connected",
      settings: NOMINAL_SETTINGS,
      storageLocal: { "coati:retentionDays": 7 },
      permissions: ["https://www.youtube.com/*"],
      autoAction: { steps: [{ type: "click", selector: ".apikey-clear", delayMs: 30 }] },
    },

    // "Tester la connexion" renvoie un échec pour claude-api.
    "provider-test-failed": {
      status: "connected",
      settings: NOMINAL_SETTINGS,
      testResults: { "claude-api": { ok: false, message: "Clé invalide ou expirée." } },
      storageLocal: { "coati:retentionDays": 90 },
      permissions: ["https://www.youtube.com/*"],
      autoAction: { steps: [{ type: "click", selector: ".test-button", delayMs: 30 }] },
    },
  };
})();
