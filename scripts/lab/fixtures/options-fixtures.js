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

  // U2 — "Connecter un modèle d'IA" guide (options.html#setup). A fresh
  // install: Ollama selected but not running, no key anywhere.
  var FRESH_SETTINGS = {
    provider: "ollama",
    model: null,
    models: [],
    available: [
      { id: "ollama", available: false, configured: false, reason: "Ollama unreachable at http://127.0.0.1:11434", label: "Ollama" },
      { id: "claude-api", available: false, configured: false, reason: "no Anthropic API key configured", label: "Clé API Anthropic" },
      { id: "openai-compat", available: false, configured: false, reason: "no base URL configured", label: "Compatible OpenAI" },
    ],
  };

  // Common ground for every guide state: page opened at #setup, a Windows
  // machine whose browser reports 8 GB, settings.set echoed like the broker.
  function guide(extra) {
    return Object.assign(
      {
        status: "connected",
        settings: FRESH_SETTINGS,
        echoSettingsSet: true,
        labHash: "setup",
        labPlatform: "Windows",
        labDeviceMemory: 8,
        storageLocal: { "coati:retentionDays": 30 },
        permissions: ["https://www.youtube.com/*"],
      },
      extra,
    );
  }

  function steps() {
    return { steps: Array.prototype.slice.call(arguments) };
  }
  function click(selector, delayMs) {
    return { type: "click", selector: selector, delayMs: delayMs };
  }
  function fill(selector, value, delayMs) {
    return { type: "fill", selector: selector, value: value, delayMs: delayMs };
  }

  var OLLAMA_STATUS = function (state, reason) {
    return { provider: "ollama", state: state, reason: reason };
  };

  var GUIDE_STATES = {
    // First screen: one sentence on the local program, two cards.
    "setup-first": guide({}),

    // Same, local program not answering: notice + checks disabled.
    "setup-disconnected": guide({ status: "disconnected" }),

    // Local path chosen, nothing checked yet (Windows, 8 GB row highlighted).
    "setup-local": guide({ autoAction: steps(click("#setupPathLocal", 60)) }),

    // Linux, memory not reported: install + start commands, no highlighted row.
    "setup-local-linux": guide({
      labPlatform: "Linux",
      labDeviceMemory: undefined,
      autoAction: steps(click("#setupPathLocal", 60)),
    }),

    // Step 2 failed: Ollama does not answer.
    "setup-local-unreachable": guide({
      providerStatus: OLLAMA_STATUS("ko", "ollama-unreachable"),
      autoAction: steps(click("#setupPathLocal", 60), click(".setup-check-ollama", 90)),
    }),

    // Steps 1-2 ticked, no model installed yet (step 3 explains).
    "setup-local-no-model": guide({
      providerStatus: OLLAMA_STATUS("ko", "no-model-installed"),
      autoAction: steps(click("#setupPathLocal", 60), click(".setup-check-ollama", 90)),
    }),

    // Step 3 failed: the chosen model is not pulled yet.
    "setup-local-model-missing": guide({
      providerStatus: OLLAMA_STATUS("ko", "model-missing"),
      autoAction: steps(click("#setupPathLocal", 60), click(".setup-check-model", 90)),
    }),

    // Steps 1-3 ticked: Ollama answers, model present.
    "setup-local-ready": guide({
      providerStatus: OLLAMA_STATUS("ok", "ready"),
      autoAction: steps(click("#setupPathLocal", 60), click(".setup-check-model", 90)),
    }),

    // « Avancé : LM Studio » open and checked OK.
    "setup-local-lmstudio": guide({
      testResults: { "openai-compat": { ok: true, message: "Connexion au serveur réussie." } },
      autoAction: steps(
        click("#setupPathLocal", 60),
        click(".setup-advanced > summary", 80),
        click(".setup-check-lmstudio", 100),
      ),
    }),

    // Online path chosen: the free-models warning comes before the choice.
    "setup-online": guide({ autoAction: steps(click("#setupPathOnline", 60)) }),

    // OpenRouter picked: step 1 ticked, account + key steps filled in.
    "setup-online-openrouter": guide({
      autoAction: steps(click("#setupPathOnline", 60), click('.setup-service[data-service="openrouter"] input', 90)),
    }),

    // « Autres » open, DeepSeek picked (prepaid wording).
    "setup-online-deepseek": guide({
      autoAction: steps(click("#setupPathOnline", 60), click('.setup-service[data-service="deepseek"] input', 90)),
    }),

    // Claude: key pasted, saved, accepted (steps 1-3 ticked).
    "setup-online-key-accepted": guide({
      testResults: { "claude-api": { ok: true, message: "Connexion à l'API Anthropic réussie." } },
      autoAction: steps(
        click("#setupPathOnline", 60),
        click('.setup-service[data-service="claude"] input', 90),
        fill("#setupOnline .key-input-field", "sk-ant-lab-not-a-real-key", 130),
        click("#setupOnline .key-input-save", 150),
      ),
    }),

    // OpenRouter: key refused (code auth-required).
    "setup-online-key-refused": guide({
      testResults: {
        "openai-compat": { ok: false, code: "auth-required", message: "Clé API refusée — vérifiez-la dans les réglages." },
      },
      autoAction: steps(
        click("#setupPathOnline", 60),
        click('.setup-service[data-service="openrouter"] input', 90),
        fill("#setupOnline .key-input-field", "sk-or-lab-not-a-real-key", 130),
        click("#setupOnline .key-input-save", 150),
      ),
    }),

    // OpenAI: key valid but no credit (code quota-exceeded).
    "setup-online-key-no-credit": guide({
      testResults: {
        "openai-compat": { ok: false, code: "quota-exceeded", message: "Votre compte n'a plus de crédit." },
      },
      autoAction: steps(
        click("#setupPathOnline", 60),
        click('.setup-service[data-service="openai"] input', 90),
        fill("#setupOnline .key-input-field", "sk-lab-not-a-real-key", 130),
        click("#setupOnline .key-input-save", 150),
      ),
    }),

    // OpenRouter: rate-limited during the check (code rate-limited).
    "setup-online-key-rate-limited": guide({
      testResults: {
        "openai-compat": { ok: false, code: "rate-limited", message: "Trop de requêtes." },
      },
      autoAction: steps(
        click("#setupPathOnline", 60),
        click('.setup-service[data-service="openrouter"] input', 90),
        fill("#setupOnline .key-input-field", "sk-or-lab-not-a-real-key", 130),
        click("#setupOnline .key-input-save", 150),
      ),
    }),
  };

  // Settings card (not the guide): the same key component.
  var CLAUDE_NO_KEY = {
    provider: "claude-api",
    model: null,
    models: [],
    available: [
      { id: "claude-api", available: false, configured: false, reason: "no Anthropic API key configured", label: "Clé API Anthropic" },
      { id: "ollama", available: true, configured: true, label: "Ollama" },
    ],
  };

  var KEY_CARD_STATES = {
    // Key typed in the selected card, saved, accepted.
    "key-accepted": {
      status: "connected",
      settings: CLAUDE_NO_KEY,
      echoSettingsSet: true,
      testResults: { "claude-api": { ok: true, message: "Connexion à l'API Anthropic réussie." } },
      storageLocal: { "coati:retentionDays": 30 },
      permissions: ["https://www.youtube.com/*"],
      autoAction: steps(
        fill(".provider-item .key-input-field", "sk-ant-lab-not-a-real-key", 60),
        click(".provider-item .key-input-save", 80),
      ),
    },

    // Key refused (auth-required): « Vérifier à nouveau » offered.
    "key-refused": {
      status: "connected",
      settings: CLAUDE_NO_KEY,
      echoSettingsSet: true,
      testResults: { "claude-api": { ok: false, code: "auth-required", message: "Clé API refusée." } },
      storageLocal: { "coati:retentionDays": 30 },
      permissions: ["https://www.youtube.com/*"],
      autoAction: steps(
        fill(".provider-item .key-input-field", "sk-ant-lab-not-a-real-key", 60),
        click(".provider-item .key-input-save", 80),
      ),
    },

    // « Show » toggled with a typed key (field unmasked, nothing sent).
    "key-revealed": {
      status: "connected",
      settings: CLAUDE_NO_KEY,
      storageLocal: { "coati:retentionDays": 30 },
      permissions: ["https://www.youtube.com/*"],
      autoAction: steps(
        fill(".provider-item .key-input-field", "sk-ant-lab-not-a-real-key", 60),
        click(".provider-item .key-input-reveal", 80),
      ),
    },

    // Stored key deleted (two clicks: arm, confirm).
    "key-deleted": {
      status: "connected",
      settings: NOMINAL_SETTINGS,
      echoSettingsSet: true,
      storageLocal: { "coati:retentionDays": 30 },
      permissions: ["https://www.youtube.com/*"],
      autoAction: steps(click(".provider-item .key-input-delete", 60), click(".provider-item .key-input-delete", 90)),
    },
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

    // U1 — language selector (lib/language-selector.js), "Langue" section,
    // menu open — same ground state as "nominal".
    "lang-menu-open": {
      status: "connected",
      settings: NOMINAL_SETTINGS,
      storageLocal: { "coati:retentionDays": 30 },
      permissions: ["https://www.youtube.com/*", "https://exemple-actu.fr/*"],
      autoAction: {
        steps: [{ type: "click", selector: "#languageSelectorButton", delayMs: 0 }],
      },
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
      autoAction: { steps: [{ type: "click", selector: ".provider-item .apikey-clear", delayMs: 30 }] },
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

  Object.assign(window.__COATI_LAB_FIXTURES__, GUIDE_STATES, KEY_CARD_STATES);
})();
