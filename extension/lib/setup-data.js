// Provider facts for the "Connect an AI model" guide (options page) — DATA ONLY, no text meant for
// a human (every sentence lives in _locales/*/messages.json under the `setup*` keys). Kept in this
// one file so verified facts (URLs, model names, prices, quotas) can be swapped later
// without touching the guide's code (extension/options-setup.js).
//
// Values below are plausible as of 2026-10; a research pass verifies them and
// replaces them here only.

// --- Local path: Ollama ------------------------------------------------------

/** Official pages that always serve the latest version; the tool's own docs
 * explain how to download a model. */
export const OLLAMA = {
  downloadUrl: "https://ollama.com/download",
  docsUrl: "https://docs.ollama.com/quickstart",
};

/** "Speed up Ollama": flash
 * attention + a q8_0 KV cache, about half the memory the page takes, little
 * quality loss. Two environment variables, set the way each OS's Ollama
 * reads them (https://docs.ollama.com/faq). */
export const OLLAMA_SPEEDUP = {
  faqUrl: "https://docs.ollama.com/faq",
  env: [
    ["OLLAMA_FLASH_ATTENTION", "1"],
    ["OLLAMA_KV_CACHE_TYPE", "q8_0"],
  ],
  linuxEditCommand: "sudo systemctl edit ollama.service",
  linuxRestartCommand: "sudo systemctl restart ollama",
};

/** Where the user finds a model himself (Coati recommends none). */
export const OLLAMA_LIBRARY_URL = "https://ollama.com/search";
export const HUGGING_FACE_GGUF_URL = "https://huggingface.co/models?library=gguf";

// --- Local path: LM Studio ---------------------------------------------------

export const LM_STUDIO = {
  downloadUrl: "https://lmstudio.ai/download",
  docsUrl: "https://lmstudio.ai/docs/app/basics/download-model",
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
// "paid" (Claude, OpenAI), "other" (under "Others").

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
    billingUrl: "https://openrouter.ai/settings/credits",
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
    // console.anthropic.com's
    // settings pages redirect to platform.claude.com now — linking the
    // destination directly rather than through a redirect hop.
    keysUrl: "https://platform.claude.com/settings/keys",
    limitsUrl: "https://platform.claude.com/settings/limits",
    billingUrl: "https://platform.claude.com/settings/billing",
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
    billingUrl: "https://platform.openai.com/settings/organization/billing",
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
    // No distinct billing page — the limits page is where Mistral's spend
    // cap/usage lives.
    billingUrl: "https://admin.mistral.ai/plateforme/limits",
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
    // Prepaid only: no monthly cap page, the balance is the cap — the
    // top-up page doubles as both limitsUrl and billingUrl.
    limitsUrl: "https://platform.deepseek.com/top_up",
    billingUrl: "https://platform.deepseek.com/top_up",
    prepaid: true,
    keyPrefix: "sk-",
  },
];

/** Typical request size behind `costUsdPerRequest`, shown to the user. */
export const COST_BASIS_WORDS = 2000;

/**
 * Maps a broker provider id (docs/PROTOCOL.md, e.g. "claude-api",
 * "openai-compat") + its currently configured `baseUrl` (undefined for
 * claude-api, which has none) to the matching ONLINE_PROVIDERS entry's
 * {keysUrl, billingUrl, name}, built
 * for the panel's "model failure" recovery links (options.js's own
 * `keyInputFor` uses the same match: claude-api by `provider`, everything
 * else by `baseUrl`). Returns undefined when no ONLINE_PROVIDERS entry
 * matches (e.g. ollama, or an openai-compat address the guide doesn't know,
 * such as a local LM Studio/Ollama server — neither has a billing page).
 *
 * @param {string} providerId
 * @param {string | undefined} baseUrl
 * @returns {{ keysUrl: string, billingUrl?: string, name: string } | undefined}
 */
export function getProviderLinks(providerId, baseUrl) {
  const service = ONLINE_PROVIDERS.find((p) =>
    providerId === "claude-api" ? p.provider === "claude-api" : p.baseUrl && p.baseUrl === baseUrl,
  );
  if (!service) return undefined;
  return { keysUrl: service.keysUrl, billingUrl: service.billingUrl, name: service.name };
}
