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
      { id: "ollama", available: false, configured: false, reason: "Ollama unreachable at http://127.0.0.1:11434", label: "Ollama" },
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

    // G5 — fournisseur « Compatible OpenAI » actif, préréglage OpenRouter,
    // clé déjà enregistrée (configured: true, la clé ne revient jamais).
    "openai-compat-openrouter": {
      status: "connected",
      settings: {
        provider: "openai-compat",
        model: "mistralai/mistral-small-3.2",
        models: [],
        baseUrl: "https://openrouter.ai/api/v1",
        available: [
          { id: "openai-compat", available: true, configured: true, label: "Compatible OpenAI" },
          { id: "claude-api", available: true, configured: false, label: "Clé API Anthropic" },
          { id: "ollama", available: false, configured: false, reason: "Ollama unreachable at http://127.0.0.1:11434", label: "Ollama" },
        ],
      },
      storageLocal: { "coati:retentionDays": 30 },
      permissions: [],
    },

    // Broker non connecté : encart "impossible d'afficher le modèle".
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

    // "Tester la connexion" réussit pour claude-api.
    "provider-test-ok": {
      status: "connected",
      settings: NOMINAL_SETTINGS,
      testResults: { "claude-api": { ok: true, message: "Connexion à l'API Anthropic réussie." } },
      storageLocal: { "coati:retentionDays": 30, "coati:attachPage": false },
      permissions: ["https://www.youtube.com/*"],
      autoAction: { steps: [{ type: "click", selector: ".test-button", delayMs: 30 }] },
    },

    // Firefox sans jeton, version sans commands.openShortcutSettings() :
    // raccourci effacé par l'utilisateur ("non défini"), consigne manuelle,
    // section "Navigateur sans programme natif (Flatpak, Snap)" ouverte
    // d'office sur le champ du secret.
    "firefox-no-token": {
      gecko: true,
      geckoShortcutSettings: false,
      status: "no-token",
      commands: [{ name: "_execute_action", shortcut: "" }],
      storageLocal: { "coati:retentionDays": 30 },
      permissions: ["https://www.youtube.com/*"],
    },

    // Programme natif introuvable (G4, docs/PROTOCOL.md amendement
    // 2026-09-30) : même section ouverte d'office, texte de statut différent.
    "no-host": {
      status: "no-host",
      storageLocal: { "coati:retentionDays": 30 },
      permissions: ["https://www.youtube.com/*"],
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
