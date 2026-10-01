// Provider facts for the "Connecter un modèle d'IA" guide (options page,
// goal U2) — DATA ONLY, no text meant for a human (every sentence lives in
// _locales/*/messages.json under the `setup*` keys). Kept in this one file so
// verified facts (URLs, model names, prices, quotas) can be swapped later
// without touching the guide's code (extension/options-setup.js).
//
// Values below are plausible as of 2026-10; a research pass verifies them and
// replaces them here only.

// --- Local path: Ollama ------------------------------------------------------

/** Download page per OS family (see detectOs() in options-setup.js). */
export const OLLAMA_DOWNLOADS = {
  windows: "https://ollama.com/download/windows",
  mac: "https://ollama.com/download/mac",
  linux: "https://ollama.com/download/linux",
};

/** One-line Linux installer, shown as a copyable command on Linux only. */
export const OLLAMA_LINUX_INSTALL_COMMAND = "curl -fsSL https://ollama.com/install.sh | sh";

/** Command a Linux user runs when the service is not started by the
 * installer (e.g. no systemd). Windows and macOS start the app instead. */
export const OLLAMA_START_COMMAND = "ollama serve";

/** Recommended model per amount of memory (RAM) of the machine. `minGb` is
 * the smallest machine memory the row is meant for; `downloadGb` the size of
 * the download. Order: smallest machine first. */
export const OLLAMA_MODELS_BY_MEMORY = [
  { minGb: 4, model: "gemma3:1b", downloadGb: 0.8 },
  { minGb: 8, model: "gemma3:4b", downloadGb: 3.3 },
  // gemma3 rather than qwen3: qwen3 is a "thinking" model whose reasoning
  // leaks into answers through Ollama's OpenAI-compatible path.
  { minGb: 16, model: "gemma3:12b", downloadGb: 8.1 },
  { minGb: 32, model: "gemma3:27b", downloadGb: 17 },
];

// --- Local path, advanced: LM Studio ----------------------------------------

export const LM_STUDIO = {
  downloadUrl: "https://lmstudio.ai/download",
  // Same address as the "LM Studio" preset in lib/model-provider-presets.js.
  baseUrl: "http://localhost:1234/v1",
};

// --- Online path ---------------------------------------------------------------
//
// `provider` / `baseUrl` / `model` are exactly what the guide sends in
// `settings.set` (docs/PROTOCOL.md). `baseUrl` values match
// lib/model-provider-presets.js. `costUsdPerRequest`: rough price of ONE
// question about an average page (~3,000 tokens in, ~500 out) at the listed
// model's public price — `0` means free. `group`: "free" (shown first),
// "paid" (Claude, OpenAI), "other" (under « Autres »).

export const ONLINE_PROVIDERS = [
  {
    id: "openrouter",
    group: "free",
    name: "OpenRouter",
    provider: "openai-compat",
    baseUrl: "https://openrouter.ai/api/v1",
    model: "meta-llama/llama-3.3-70b-instruct:free",
    costUsdPerRequest: 0,
    signupUrl: "https://openrouter.ai/sign-up",
    keysUrl: "https://openrouter.ai/settings/keys",
    privacyUrl: "https://openrouter.ai/settings/privacy",
    freeModelsUrl: "https://openrouter.ai/models?max_price=0",
    // Free-model quotas: requests per day without / with at least
    // `freeQuotaCreditUsd` of purchased credit, and per minute.
    freeRequestsPerDay: 50,
    freeRequestsPerDayWithCredit: 1000,
    freeQuotaCreditUsd: 10,
    freeRequestsPerMinute: 20,
    keyPrefix: "sk-or-",
  },
  {
    id: "claude",
    group: "paid",
    name: "Claude (Anthropic)",
    provider: "claude-api",
    model: "claude-haiku-4-5",
    costUsdPerRequest: 0.006,
    signupUrl: "https://console.anthropic.com/",
    keysUrl: "https://console.anthropic.com/settings/keys",
    limitsUrl: "https://console.anthropic.com/settings/limits",
    keyPrefix: "sk-ant-",
  },
  {
    id: "openai",
    group: "paid",
    name: "OpenAI",
    provider: "openai-compat",
    baseUrl: "https://api.openai.com/v1",
    model: "gpt-5-mini",
    costUsdPerRequest: 0.002,
    signupUrl: "https://platform.openai.com/signup",
    keysUrl: "https://platform.openai.com/api-keys",
    limitsUrl: "https://platform.openai.com/settings/organization/limits",
    keyPrefix: "sk-",
  },
  {
    id: "mistral",
    group: "other",
    name: "Mistral",
    provider: "openai-compat",
    baseUrl: "https://api.mistral.ai/v1",
    model: "mistral-small-latest",
    costUsdPerRequest: 0.0005,
    signupUrl: "https://console.mistral.ai/",
    keysUrl: "https://console.mistral.ai/api-keys",
    limitsUrl: "https://admin.mistral.ai/plateforme/limits",
    keyPrefix: "",
  },
  {
    id: "deepseek",
    group: "other",
    name: "DeepSeek",
    provider: "openai-compat",
    baseUrl: "https://api.deepseek.com/v1",
    model: "deepseek-chat",
    costUsdPerRequest: 0.001,
    signupUrl: "https://platform.deepseek.com/sign_up",
    keysUrl: "https://platform.deepseek.com/api_keys",
    // Prepaid only: no monthly cap page, the balance is the cap.
    limitsUrl: "https://platform.deepseek.com/top_up",
    prepaid: true,
    keyPrefix: "sk-",
  },
];

/** Typical request size behind `costUsdPerRequest`, shown to the user. */
export const COST_BASIS_WORDS = 2000;
