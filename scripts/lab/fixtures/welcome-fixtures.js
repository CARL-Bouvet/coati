// Coati state lab — welcome/welcome.html fixtures (docs/DECISIONS.md T51).
// What varies: the engine (pin wording, lib/browser-compat.js IS_GECKO), the
// connection state (program step), the system (download buttons) and, for
// review only, the open step ("coati:welcomeStep" in storage; production never
// sets it).
(function () {
  "use strict";

  var OLLAMA_UP = { provider: "ollama", state: "ok" };
  var ollamaModels = {
    current: { provider: "ollama", model: null },
    entries: [
      { provider: "ollama", model: "qwen3:4b", local: true, sizeBytes: 2600000000, thinks: true, fit: "gpu" },
      { provider: "ollama", model: "llama3.2:latest", local: true, sizeBytes: 2019393189, fit: "gpu" },
    ],
    sources: [OLLAMA_UP],
    host: { ramGb: 16, vramGb: 6.4 },
  };
  var catalog = [
    { id: "model-a", name: "Model A", created: 1764547200 },
    { id: "model-b", name: "Model B", created: 1764547200 - 30 * 86400 },
    { id: "model-c", name: "Model C", created: 1764547200 - 90 * 86400 },
  ];
  var available = [
    { id: "ollama", available: false, configured: false, reason: "Ollama unreachable", label: "Ollama" },
    { id: "claude-api", available: false, configured: false, label: "Clé API Anthropic" },
    { id: "openai-compat", available: false, configured: false, label: "Compatible OpenAI" },
    { id: "chatgpt", available: false, configured: false, label: "ChatGPT" },
  ];
  // The local program's settings: nothing set up (fresh), or the chosen service working (key stored / signed in).
  function settings(over) {
    return Object.assign({ provider: "ollama", model: null, models: [], available: available }, over);
  }
  function withKey(id, over) {
    return settings(Object.assign({ catalog: catalog, models: catalog.map(function (m) { return m.id; }),
      available: available.map(function (p) { return p.id === id ? Object.assign({}, p, { available: true, configured: true }) : p; }) }, over));
  }
  var READY = {
    openrouter: withKey("openai-compat", {
      provider: "openai-compat",
      baseUrl: "https://openrouter.ai/api/v1",
      services: [{ baseUrl: "https://openrouter.ai/api/v1", hasKey: true }],
      account: { boughtCredit: true },
    }),
    chatgpt: withKey("chatgpt", { provider: "chatgpt", account: { signedIn: true, planUsage: true, welcomed: true } }),
    paid: withKey("claude-api", { provider: "claude-api" }),
    free: withKey("openai-compat", {
      provider: "openai-compat",
      baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai",
      services: [{ baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai", hasKey: true }],
    }),
  };

  // Step 2 with a way chosen; `ready`: the way works (Ollama answers, a key is stored, signed in).
  function access(choice, ready) {
    var f = welcome({ status: "connected", step: "access" });
    f.settings = ready && READY[choice] ? READY[choice] : settings();
    f.echoSettingsSet = true;
    f.models = ollamaModels;
    f.providerStatus = { provider: "ollama", state: "ok", reason: "ready" };
    var steps = [];
    if (choice) steps.push({ type: "click", selector: 'input[value="' + choice + '"]', delayMs: 100 });
    if (choice === "local" && ready) steps.push({ type: "click", selector: '[data-role="check"]', delayMs: 150 });
    if (steps.length) f.autoAction = { steps: steps };
    return f;
  }

  function welcome(o) {
    var storage = {};
    if (o.step) storage["coati:welcomeStep"] = o.step;
    return {
      status: o.status || "no-host",
      labPlatformInfo: { os: "mac", arch: "arm64" },
      storageLocal: storage,
    };
  }

  var linux = welcome({});
  linux.labPlatformInfo = { os: "linux", arch: "x86-64" };

  window.__COATI_LAB_FIXTURES__ = {
    // Chrome, Brave, Edge : menu des extensions (pièce de puzzle), épingle.
    chromium: {
      status: "connected",
    },

    // Firefox : bouton des extensions, roue dentée, « Épingler à la barre d'outils ».
    firefox: {
      status: "connected",
      gecko: true,
    },

    waiting: welcome({}),
    linux: linux,
    connected: welcome({ status: "connected" }),
    theme: welcome({ status: "connected", step: "theme" }),
    access: access(),
    "access-local": access("local"),
    "access-local-ready": access("local", true),
    "access-openrouter": access("openrouter"),
    "access-openrouter-ready": access("openrouter", true),
    "access-chatgpt": access("chatgpt"),
    "access-chatgpt-ready": access("chatgpt", true),
    "access-paid": access("paid"),
    "access-paid-ready": access("paid", true),
    "access-free": access("free"),
    "access-free-ready": access("free", true),
  };
})();
