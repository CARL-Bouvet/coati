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
  // A real paste: the key field sends the key on it, no button.
  function paste(selector, value, delayMs) {
    return { type: "fill", selector: selector, value: value, delayMs: delayMs, paste: true };
  }
  // Nothing set up opens both sides idle: the local guide states choose
  // "On this computer" first.
  function onLocal(extra) {
    var fixture = guide(extra);
    var rest = fixture.autoAction ? fixture.autoAction.steps : [];
    fixture.autoAction = { steps: [click("#tabLocal", 40)].concat(rest) };
    return fixture;
  }

  var OLLAMA_STATUS = function (state, reason) {
    return { provider: "ollama", state: state, reason: reason };
  };

  // `models` replies (models.list).
  var OLLAMA_OK = { provider: "ollama", state: "ok" };
  var MODELS_ONE_INSTALLED = {
    current: { provider: "ollama", model: null },
    entries: [{ provider: "ollama", model: "qwen3:4b", local: true, sizeBytes: 2600000000, thinks: true }],
    sources: [OLLAMA_OK],
  };
  var MODELS_SUGGESTED_IN_USE = {
    current: { provider: "ollama", model: "gemma3:4b" },
    entries: [{ provider: "ollama", model: "gemma3:4b", local: true, sizeBytes: 3338801804 }],
    sources: [OLLAMA_OK],
  };
  var MODELS_INSTALLED_CLAUDE_ACTIVE = {
    current: { provider: "claude-api", model: "claude-sonnet-4-5" },
    entries: [
      { provider: "ollama", model: "qwen3:4b", local: true, sizeBytes: 2600000000, thinks: true },
      { provider: "ollama", model: "llama3.2:latest", local: true, sizeBytes: 2019393189 },
      { provider: "ollama", model: "gemma3:12b", local: true, sizeBytes: 8149190253 },
      { provider: "claude-api", model: "claude-sonnet-4-5", local: false },
    ],
    sources: [OLLAMA_OK, { provider: "claude-api", state: "ok" }],
  };
  function hostModels(host, entries) {
    return { current: { provider: "ollama", model: null }, entries: entries, sources: [OLLAMA_OK], host: host };
  }
  // Claude answers, Ollama installed with three models: the case of the bug
  // report (qwen3:4b missing from « Modèle » while another provider is active).
  var CLAUDE_ACTIVE_SETTINGS = {
    provider: "claude-api",
    model: "claude-sonnet-4-5",
    models: [],
    available: [
      { id: "claude-api", available: true, configured: true, label: "Clé API Anthropic" },
      { id: "ollama", available: true, configured: true, label: "Ollama" },
      { id: "openai-compat", available: false, configured: false, reason: "no base URL configured", label: "Compatible OpenAI" },
    ],
  };

  // Redesign — models with their machine fit, Claude active.
  var MODELS_FIT_CLAUDE_ACTIVE = {
    current: { provider: "claude-api", model: "claude-sonnet-4-5" },
    entries: [
      { provider: "ollama", model: "qwen3:4b", local: true, sizeBytes: 2600000000, thinks: true, fit: "gpu" },
      { provider: "ollama", model: "llama3.2:latest", local: true, sizeBytes: 2019393189, fit: "gpu" },
      { provider: "ollama", model: "gemma3:12b", local: true, sizeBytes: 8149190253, fit: "shared" },
      { provider: "claude-api", model: "claude-sonnet-4-5", local: false },
    ],
    sources: [OLLAMA_OK, { provider: "claude-api", state: "ok" }],
    host: { ramGb: 16, vramGb: 6.4 },
  };
  var OLLAMA_ACTIVE_SETTINGS = {
    provider: "ollama",
    model: "qwen3:4b",
    models: [],
    available: [
      { id: "ollama", available: true, configured: true, label: "Ollama" },
      { id: "claude-api", available: true, configured: true, label: "Clé API Anthropic" },
      { id: "openai-compat", available: false, configured: false, reason: "no base URL configured", label: "Compatible OpenAI" },
    ],
  };
  var TWO_SERVICES_SETTINGS = {
    provider: "openai-compat",
    model: "meta-llama/llama-3.3-70b-instruct:free",
    models: [],
    baseUrl: "https://openrouter.ai/api/v1",
    services: [{ baseUrl: "https://openrouter.ai/api/v1", hasKey: true }, { baseUrl: "https://api.deepseek.com/v1", hasKey: true }],
    available: [
      { id: "openai-compat", available: true, configured: true, label: "Compatible OpenAI" },
      { id: "claude-api", available: true, configured: true, label: "Clé API Anthropic" },
      { id: "ollama", available: true, configured: true, label: "Ollama" },
    ],
  };

  // Model picker: an OpenRouter-like catalog (~470 models, 46 makers, 14 free, 8
  // routers without a fixed price, a few undated) and a direct service's (no maker, no price). Made-up names: only
  // the shape of the service's facts matters (docs/PROTOCOL.md `catalog`).
  var PICKER_MAKERS = ["ai21", "aion-labs", "alfredpros", "amazon", "anthracite-org", "anthropic", "arcee-ai", "baidu",
    "bytedance", "cohere", "deepcogito", "deepseek", "eleutherai", "google", "gryphe", "ibm-granite", "inception",
    "inflection", "liquid", "mancer", "meta-llama", "microsoft", "minimax", "mistralai", "moonshotai", "morph",
    "neversleep", "nousresearch", "nvidia", "openai", "opengvlab", "perplexity", "qwen", "raifle", "relace", "sao10k",
    "stepfun-ai", "switchpoint", "tencent", "thedrummer", "thudm", "tngtech", "undi95", "x-ai", "z-ai"];
  function routerCatalog() {
    var out = [];
    var newest = 1764547200; // a fixed "today" so captures do not move
    PICKER_MAKERS.forEach(function (maker, m) {
      var count = 1 + ((m * 7 + 3) % 20);
      for (var i = 0; i < count; i++) {
        var n = out.length;
        var free = n % 34 === 7;
        var entry = {
          id: maker + "/model-" + String.fromCharCode(97 + (i % 5)) + "-" + (count - i) + (free ? ":free" : ""),
          name: maker.charAt(0).toUpperCase() + maker.slice(1) + ": Model " + String.fromCharCode(65 + (i % 5)) + " " + (count - i) + (free ? " (free)" : ""),
          maker: maker,
          price: free ? "free" : "paid",
          usdPerToken: free ? { prompt: 0, completion: 0 } : { prompt: (1 + (n % 30)) * 1e-7, completion: (4 + (n % 50)) * 1e-7 },
        };
        if (n % 41 !== 11) entry.created = newest - ((m * 17 + i * 23) % 700) * 86400;
        out.push(entry);
      }
    });
    // OpenRouter's routers: no fixed price.
    for (var r = 1; r <= 8; r++) out.push({ id: "openrouter/router-" + r, name: "OpenRouter: Router " + r, maker: "openrouter", created: newest - r * 30 * 86400 });
    return out;
  }
  function directCatalog() {
    var out = [];
    for (var i = 1; i <= 9; i++) out.push({ id: "claude-model-" + i, name: "Claude Model " + i, created: 1764547200 - i * 45 * 86400 });
    return out;
  }
  function pickerSettings(opts) {
    var catalog = opts.direct ? directCatalog() : routerCatalog();
    var settings = {
      provider: opts.direct ? "claude-api" : "openai-compat",
      model: opts.model || null,
      models: catalog.map(function (entry) { return entry.id; }),
      catalog: catalog,
      available: [
        { id: "openai-compat", available: !opts.direct, configured: !opts.direct, label: "Compatible OpenAI" },
        { id: "claude-api", available: true, configured: Boolean(opts.direct), label: "Clé API Anthropic" },
        { id: "ollama", available: false, configured: false, reason: "Ollama unreachable at http://127.0.0.1:11434", label: "Ollama" },
      ],
    };
    if (!opts.direct) {
      settings.baseUrl = "https://openrouter.ai/api/v1";
      settings.services = [{ baseUrl: "https://openrouter.ai/api/v1", hasKey: true, model: opts.model }];
      settings.account = { boughtCredit: Boolean(opts.credit), freeRequests: { used: 3, limit: 50, remaining: 47 } };
    }
    if (opts.recent) settings.recentModels = opts.recent;
    return settings;
  }
  function picker(opts, autoAction) {
    return { status: "connected", settings: pickerSettings(opts), storageLocal: { "coati:retentionDays": 30 }, permissions: [], autoAction: autoAction };
  }

  // "Install the local program" step (options.html#setup-program): the local
  // program does not answer; `labPlatformInfo` is what runtime.getPlatformInfo()
  // returns. `help: true` unfolds the per-system help.
  function programStep(opts) {
    return guide(
      Object.assign(
        {
          status: "no-host",
          labHash: "setup-program",
          labPlatform: opts.platform,
          labPlatformInfo: opts.info,
          autoAction: opts.help ? steps(click("#setup-program details > summary", 120)) : undefined,
        },
        opts.extra,
      ),
    );
  }

  var GUIDE_STATES = {
    // Local program not installed: one download button for the system, the
    // system's help unfolded.
    "setup-program-windows": programStep({ platform: "Windows", info: { os: "win", arch: "x86-64" }, help: true }),
    "setup-program-macos": programStep({ platform: "macOS", info: { os: "mac", arch: "arm64" }, help: true }),
    "setup-program-linux": programStep({ platform: "Linux", info: { os: "linux", arch: "x86-64" }, help: true }),

    // The program starts after two reconnect attempts (about 6 s): the step
    // turns green, then the page moves on to the model guide.
    "setup-program-connected-after-wait": programStep({ platform: "Windows", info: { os: "win", arch: "x86-64" }, extra: { connectsAfterReconnects: 2 } }),

    // First screen, nothing set up: both sides idle, half and half.
    "setup-first": guide({}),

    // "On this computer" chosen: the Ollama path, two tools side by side.
    "setup-local": onLocal({}),

    // Same, local program not answering: notice + checks disabled.
    "setup-disconnected": guide({ status: "disconnected" }),

    // Step 3 failed: Ollama does not answer.
    "setup-local-unreachable": onLocal({
      providerStatus: OLLAMA_STATUS("ko", "ollama-unreachable"),
      autoAction: steps(click(".setup-check-ollama", 90)),
    }),

    // Ollama answers, no model installed yet (step 2 flagged).
    "setup-local-no-model": onLocal({
      providerStatus: OLLAMA_STATUS("ko", "no-model-installed"),
      autoAction: steps(click(".setup-check-ollama", 90)),
    }),

    // Ollama answers, the chosen model (gemma3:4b) is not downloaded yet;
    // the installed list shows what IS.
    "setup-local-model-missing": onLocal({
      providerStatus: OLLAMA_STATUS("ko", "model-missing"),
      models: MODELS_ONE_INSTALLED,
      autoAction: steps(click(".setup-check-ollama", 90)),
    }),

    // Steps 1-3 ticked: Ollama answers, model present and in use.
    "setup-local-ready": onLocal({
      providerStatus: OLLAMA_STATUS("ok", "ready"),
      settings: Object.assign({}, FRESH_SETTINGS, { model: "gemma3:4b" }),
      models: MODELS_SUGGESTED_IN_USE,
      autoAction: steps(click(".setup-check-ollama", 90)),
    }),

    // Machine lines in step 2 (`host`, read as soon as the guide opens).
    // Graphics memory measured: memory line + graphics-card sentence.
    "setup-local-host-gpu": onLocal({
      models: hostModels({ ramGb: 16, vramGb: 6.4 }, [
        { provider: "ollama", model: "qwen3:8b", local: true, sizeBytes: 5225387923, fit: "shared" },
      ]),
    }),

    // Mac, 16 GB unified memory: shared-memory sentence.
    "setup-local-host-mac": onLocal({
      labPlatform: "macOS",
      models: hostModels({ ramGb: 16, vramGb: null, unifiedMemory: true }, []),
    }),

    // Graphics memory unknown (every Windows machine today): only
    // « Cet ordinateur : 16 Go de mémoire. », nothing about speed.
    "setup-local-host-unknown-vram": onLocal({
      models: hostModels({ ramGb: 16, vramGb: null }, []),
    }),

    // Older local program, no `host`: no machine lines.
    "setup-local-no-host": onLocal({ models: MODELS_ONE_INSTALLED }),

    // LM Studio path: « Utiliser LM Studio et vérifier » answers OK.
    "setup-local-lmstudio": onLocal({
      testResults: { "openai-compat": { ok: true, message: "Connexion au serveur réussie." } },
      autoAction: steps(click(".setup-check-lmstudio", 100)),
    }),

    // « Accélérer Ollama » open, as
    // the panel's slow-answer tip opens it (options.html#setup-ollama-speedup):
    // Linux host: its two cases (service, by hand), the other systems folded.
    "setup-ollama-speedup": guide({
      labPlatform: "Linux",
      labHash: "setup-ollama-speedup",
    }),

    // Online side chosen, no service yet: step 1 alone.
    "setup-online": guide({ autoAction: steps(click("#tabOnline", 60)) }),

    // Claude picked: the key field, its own to-do (account, credit, key "Coati", copy) folded.
    "setup-online-claude": guide({
      autoAction: steps(click("#tabOnline", 60), click('.setup-service[data-service="claude"] input', 90)),
    }),

    // Same, "I don't have a key yet" unfolded.
    "setup-online-claude-help": guide({
      autoAction: steps(
        click("#tabOnline", 60),
        click('.setup-service[data-service="claude"] input', 90),
        click(".setup-online-fold > summary", 130),
      ),
    }),

    // OpenRouter picked: retention warning under it, the sign-in button, the key by hand folded.
    "setup-online-openrouter": guide({
      autoAction: steps(click("#tabOnline", 60), click('.setup-service[data-service="openrouter"] input', 90)),
    }),

    // Same, "I already have a key" unfolded: the to-do and the key field.
    "setup-online-openrouter-manual": guide({
      autoAction: steps(
        click("#tabOnline", 60),
        click('.setup-service[data-service="openrouter"] input', 90),
        click(".setup-online-fold > summary", 130),
      ),
    }),

    // Back from the sign-in: the key works, no credit bought, no model yet: the list under it,
    // "Free only" on. OpenRouter is picked in this visit, so the services fold to it.
    "setup-online-openrouter-signed-in": guide({
      settings: pickerSettings({}),
      autoAction: steps(click('.setup-service[data-service="openrouter"] input', 90)),
    }),

    // A model chosen in the guide's list: the block ends on "Coati is set up".
    "setup-online-openrouter-ready": guide({
      settings: pickerSettings({ credit: true, model: "qwen/model-a-8" }),
      autoAction: steps(click('.setup-service[data-service="openrouter"] input', 90)),
    }),

    // Same, "Add a service" then closed: the list back in the service's row.
    "setup-online-openrouter-closed": guide({
      settings: pickerSettings({ credit: true, model: "qwen/model-a-8" }),
      autoAction: steps(click('.setup-service[data-service="openrouter"] input', 90), click("#addService > summary", 160)),
    }),

    // « Autres » open, Google Gemini picked: free tier and subscription note.
    "setup-online-google": guide({
      autoAction: steps(click("#tabOnline", 60), click('.setup-service[data-service="google"] input', 90)),
    }),

    // « Autres » open, DeepSeek picked (prepaid wording).
    "setup-online-deepseek": guide({
      autoAction: steps(click("#tabOnline", 60), click('.setup-service[data-service="deepseek"] input', 90)),
    }),

    // Claude: key pasted, the check still running (reply held).
    "setup-online-key-checking": guide({
      testDelayMs: 600000,
      testResults: { "claude-api": { ok: true, message: "Connexion à l'API Anthropic réussie." } },
      autoAction: steps(
        click("#tabOnline", 60),
        click('.setup-service[data-service="claude"] input', 90),
        paste("#setupOnline .key-input-field", "sk-ant-lab-not-a-real-key", 130),
      ),
    }),

    // Claude: key pasted, saved and accepted: the model list right under it, focused.
    "setup-online-key-accepted": guide({
      testResults: { "claude-api": { ok: true, message: "Connexion à l'API Anthropic réussie." } },
      afterKey: { catalog: directCatalog(), models: directCatalog().map(function (entry) { return entry.id; }) },
      autoAction: steps(
        click("#tabOnline", 60),
        click('.setup-service[data-service="claude"] input', 90),
        paste("#setupOnline .key-input-field", "sk-ant-lab-not-a-real-key", 130),
      ),
    }),

    // OpenRouter: key refused (code auth-required).
    "setup-online-key-refused": guide({
      testResults: {
        "openai-compat": { ok: false, code: "auth-required", message: "Clé API refusée — vérifiez-la dans les réglages." },
      },
      autoAction: steps(
        click("#tabOnline", 60),
        click('.setup-service[data-service="openrouter"] input', 90),
        click(".setup-online-fold > summary", 110),
        paste("#setupOnline .key-input-field", "sk-or-lab-not-a-real-key", 130),
      ),
    }),

    // OpenAI: key valid but no credit (code quota-exceeded).
    "setup-online-key-no-credit": guide({
      testResults: {
        "openai-compat": { ok: false, code: "quota-exceeded", message: "Votre compte n'a plus de crédit." },
      },
      autoAction: steps(
        click("#tabOnline", 60),
        click('.setup-service[data-service="openai"] input', 90),
        paste("#setupOnline .key-input-field", "sk-lab-not-a-real-key", 130),
      ),
    }),

    // OpenRouter: rate-limited during the check (code rate-limited).
    "setup-online-key-rate-limited": guide({
      testResults: {
        "openai-compat": { ok: false, code: "rate-limited", message: "Trop de requêtes." },
      },
      autoAction: steps(
        click("#tabOnline", 60),
        click('.setup-service[data-service="openrouter"] input', 90),
        click(".setup-online-fold > summary", 110),
        paste("#setupOnline .key-input-field", "sk-or-lab-not-a-real-key", 130),
      ),
    }),
  };

  // Claude in use, no key yet: the guide under "Add a service" holds the key field.
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
        paste("#setupOnline .key-input-field", "sk-ant-lab-not-a-real-key", 60),
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
        paste("#setupOnline .key-input-field", "sk-ant-lab-not-a-real-key", 60),
      ),
    },

    // « Show » toggled with a typed key (field unmasked, nothing sent).
    "key-revealed": {
      status: "connected",
      settings: CLAUDE_NO_KEY,
      storageLocal: { "coati:retentionDays": 30 },
      permissions: ["https://www.youtube.com/*"],
      autoAction: steps(
        fill("#setupOnline .key-input-field", "sk-ant-lab-not-a-real-key", 60),
        click("#setupOnline .key-input-reveal", 80),
      ),
    },

    // Stored key deleted (two clicks: arm, confirm).
    "key-deleted": {
      status: "connected",
      settings: NOMINAL_SETTINGS,
      echoSettingsSet: true,
      storageLocal: { "coati:retentionDays": 30 },
      permissions: ["https://www.youtube.com/*"],
      autoAction: steps(click(".service--active .service-remove", 60), click(".service--active .service-remove", 90)),
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

    // « Modèle » section fed by models.list — the
    // Ollama models show while Claude answers; one click switches.
    "options-models": {
      status: "connected",
      settings: CLAUDE_ACTIVE_SETTINGS,
      models: MODELS_INSTALLED_CLAUDE_ACTIVE,
      echoSettingsSet: true,
      storageLocal: { "coati:retentionDays": 30 },
      permissions: ["https://www.youtube.com/*"],
    },

    // Redesign — tab « Sur cet ordinateur » while Claude answers: the
    // installed models as bordered choices with their fit note.
    "options-tab-local": {
      status: "connected",
      settings: CLAUDE_ACTIVE_SETTINGS,
      models: MODELS_FIT_CLAUDE_ACTIVE,
      echoSettingsSet: true,
      storageLocal: { "coati:retentionDays": 30 },
      permissions: ["https://www.youtube.com/*"],
      autoAction: steps(click("#tabLocal", 60)),
    },

    // Ollama answers with qwen3:4b: the page opens on the local tab, current
    // model « tient dans la carte graphique ».
    "options-local-active": {
      status: "connected",
      settings: OLLAMA_ACTIVE_SETTINGS,
      models: Object.assign({}, MODELS_FIT_CLAUDE_ACTIVE, { current: { provider: "ollama", model: "qwen3:4b" } }),
      echoSettingsSet: true,
      storageLocal: { "coati:retentionDays": 30 },
      permissions: ["https://www.youtube.com/*"],
    },

    // Tab « En ligne » with two services: OpenRouter in use, Claude ready
    // (Utiliser / Tester / Retirer); « Ajouter un service » folded.
    "options-online-services": {
      status: "connected",
      settings: TWO_SERVICES_SETTINGS,
      models: MODELS_FIT_CLAUDE_ACTIVE,
      echoSettingsSet: true,
      storageLocal: { "coati:retentionDays": 30 },
      permissions: ["https://www.youtube.com/*"],
    },

    // Same, « Ajouter un service » opened: it warns that a new
    // OpenAI-compatible service replaces OpenRouter.
    "options-add-service-open": {
      status: "connected",
      settings: TWO_SERVICES_SETTINGS,
      models: MODELS_FIT_CLAUDE_ACTIVE,
      echoSettingsSet: true,
      storageLocal: { "coati:retentionDays": 30 },
      permissions: ["https://www.youtube.com/*"],
      autoAction: steps(click("#addService > summary", 60)),
    },

    // « Retirer » armed on the Claude row (second click confirms).
    "options-remove-armed": {
      status: "connected",
      settings: TWO_SERVICES_SETTINGS,
      echoSettingsSet: true,
      storageLocal: { "coati:retentionDays": 30 },
      permissions: ["https://www.youtube.com/*"],
      autoAction: steps(click("#provider-claude-api .service-remove", 60)),
    },

    // U1 — language selector (lib/language-selector.js), header band,
    // menu open — same ground state as "nominal".
    "lang-menu-open": {
      status: "connected",
      settings: NOMINAL_SETTINGS,
      storageLocal: { "coati:retentionDays": 30 },
      permissions: ["https://www.youtube.com/*", "https://exemple-actu.fr/*"],
      autoAction: {
        steps: [{ type: "click", selector: "#langSelectorButton", delayMs: 0 }],
      },
    },

    // Fournisseur « Compatible OpenAI » actif, préréglage OpenRouter,
    // clé déjà enregistrée (configured: true, la clé ne revient jamais).
    "openai-compat-openrouter": {
      status: "connected",
      settings: {
        provider: "openai-compat",
        model: "mistralai/mistral-small-3.2",
        models: [],
        baseUrl: "https://openrouter.ai/api/v1",
        services: [{ baseUrl: "https://openrouter.ai/api/v1", hasKey: true }, { baseUrl: "https://api.deepseek.com/v1", hasKey: true }],
        available: [
          { id: "openai-compat", available: true, configured: true, label: "Compatible OpenAI" },
          { id: "claude-api", available: true, configured: false, label: "Clé API Anthropic" },
          { id: "ollama", available: false, configured: false, reason: "Ollama unreachable at http://127.0.0.1:11434", label: "Ollama" },
        ],
      },
      storageLocal: { "coati:retentionDays": 30 },
      permissions: [],
    },

    // Online model picker (options/model-picker.js). OpenRouter, no credit
    // bought, no model chosen yet: "Free only" on, the no-credit line.
    "model-picker-no-credit": picker({}),
    // Credit bought, a paid model in use: "Already used" on top (the models picked lately, one
    // the service no longer lists left out), every price shown.
    "model-picker-used": picker({
      credit: true,
      model: "mistralai/model-b-4",
      recent: ["qwen/model-a-8", "retired/model-x", "mistralai/model-b-4", "ai21/model-a-4"],
    }),
    // A group unfolded ("Other versions (N)").
    "model-picker-more": picker({ credit: true }, steps(click(".model-picker-more", 60))),
    // Typing filters at once (id and name).
    "model-picker-search": picker({ credit: true }, steps(fill("#modelSearch", "qwen", 60))),
    "model-picker-no-match": picker({ credit: true }, steps(fill("#modelSearch", "zzz", 60))),
    // OpenRouter's routers: no fixed price, "price unknown".
    "model-picker-routers": picker({ credit: true }, steps(fill("#modelSearch", "router", 60))),
    // A direct service: one group, no price, no switch.
    "model-picker-direct": picker({ direct: true, model: "claude-model-2" }),

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
      autoAction: { steps: [{ type: "click", selector: ".service--active .service-remove", delayMs: 30 }] },
    },

    // "Tester la connexion" réussit pour claude-api.
    "provider-test-ok": {
      status: "connected",
      settings: NOMINAL_SETTINGS,
      testResults: { "claude-api": { ok: true, message: "Connexion à l'API Anthropic réussie." } },
      storageLocal: { "coati:retentionDays": 30, "coati:devMode": false },
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

    // Programme natif introuvable (docs/PROTOCOL.md) : même section ouverte d'office, texte de
    // statut différent.
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

    // "Tester la connexion" réussit
    // pour openai-compat mais le solde de crédit n'a pas pu être vérifié
    // (creditUnchecked: true) : ligne « connecté » + note secondaire
    // (renderTestResult, options_credit_unchecked). Fournisseur openai-compat /
    // OpenAI pour un provider réaliste.
    "provider-test-connected-unchecked": {
      status: "connected",
      settings: {
        provider: "openai-compat",
        model: "gpt-5-mini",
        models: [],
        baseUrl: "https://api.openai.com/v1",
        services: [{ baseUrl: "https://api.openai.com/v1", hasKey: true }],
        available: [
          { id: "openai-compat", available: true, configured: true, label: "Compatible OpenAI" },
          { id: "claude-api", available: false, configured: false, reason: "no Anthropic API key configured", label: "Clé API Anthropic" },
          { id: "ollama", available: false, configured: false, reason: "Ollama unreachable at http://127.0.0.1:11434", label: "Ollama" },
        ],
      },
      testResults: {
        "openai-compat": { ok: true, creditUnchecked: true, message: "Connexion au serveur réussie." },
      },
      storageLocal: { "coati:retentionDays": 30 },
      permissions: [],
      autoAction: { steps: [{ type: "click", selector: ".test-button", delayMs: 30 }] },
    },

    // Model-missing lors du test :
    // ce modèle n'est pas disponible sur le compte (code "model-missing").
    "provider-test-model-missing": {
      status: "connected",
      settings: NOMINAL_SETTINGS,
      testResults: {
        "claude-api": { ok: false, code: "model-missing", message: "Le modèle demandé n'est pas disponible sur ce compte." },
      },
      storageLocal: { "coati:retentionDays": 30 },
      permissions: ["https://www.youtube.com/*"],
      autoAction: { steps: [{ type: "click", selector: ".test-button", delayMs: 30 }] },
    },

    // Provider-overloaded lors du
    // test : le fournisseur est surchargé (code "provider-overloaded").
    "provider-test-overloaded": {
      status: "connected",
      settings: NOMINAL_SETTINGS,
      testResults: {
        "claude-api": { ok: false, code: "provider-overloaded", message: "Le fournisseur est surchargé en ce moment." },
      },
      storageLocal: { "coati:retentionDays": 30 },
      permissions: ["https://www.youtube.com/*"],
      autoAction: { steps: [{ type: "click", selector: ".test-button", delayMs: 30 }] },
    },

    // Claude-cli : session expirée
    // lors du test. renderTestResult spécialise le texte (options_claude_cli_
    // auth_required) et affiche la commande copiable « claude auth login
    // --claudeai » (CLAUDE_CLI_LOGIN_COMMAND).
    "provider-test-claude-cli-disconnected": {
      status: "connected",
      settings: {
        provider: "claude-cli",
        model: null,
        models: [],
        available: [
          { id: "claude-cli", available: true, configured: true, label: "Claude (abonnement)" },
          { id: "claude-api", available: false, configured: false, reason: "no Anthropic API key configured", label: "Clé API Anthropic" },
          { id: "ollama", available: false, configured: false, reason: "Ollama unreachable at http://127.0.0.1:11434", label: "Ollama" },
        ],
      },
      testResults: {
        "claude-cli": { ok: false, code: "auth-required", provider: "claude-cli", message: "Session expirée." },
      },
      storageLocal: { "coati:retentionDays": 30 },
      permissions: [],
      autoAction: { steps: [{ type: "click", selector: ".test-button", delayMs: 30 }] },
    },

    // docs/PROTOCOL.md "Page on demand" — options page "Dev mode" section
    // (shares the panel's storage key, dev-mode.js), off.
    "dev-mode-off": {
      status: "connected",
      settings: NOMINAL_SETTINGS,
      storageLocal: { "coati:retentionDays": 30, "coati:devMode": false },
      permissions: ["https://www.youtube.com/*"],
    },

    // Same section, on (already acknowledged — the panel and this page
    // share coati:devModeAcknowledged too).
    "dev-mode-on": {
      status: "connected",
      settings: NOMINAL_SETTINGS,
      storageLocal: { "coati:retentionDays": 30, "coati:devMode": true, "coati:devModeAcknowledged": true },
      permissions: ["https://www.youtube.com/*"],
    },

    // First-ever activation from the options page: same confirmation
    // dialog as the panel's switch (confirmDevModeActivation(), reused —
    // not duplicated), reached the same way a user reaches it.
    "dev-mode-confirm": {
      status: "connected",
      settings: NOMINAL_SETTINGS,
      storageLocal: { "coati:retentionDays": 30, "coati:devMode": false },
      permissions: ["https://www.youtube.com/*"],
      autoAction: { steps: [{ type: "click", selector: "#devMode", delayMs: 30 }] },
    },
  };

  Object.assign(window.__COATI_LAB_FIXTURES__, GUIDE_STATES, KEY_CARD_STATES);
})();
