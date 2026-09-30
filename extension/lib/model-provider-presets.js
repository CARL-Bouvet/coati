// Address presets for the `openai-compat` model provider (docs/PROTOCOL.md
// "Fournisseur de modèle", amendement 2026-09-30 bis, goal G5) — one adapter,
// many servers that speak the same `/v1/chat/completions` format. Preset
// addresses are pure pre-fill: the user can always type a different one (the
// last entry, "Autre adresse", has no baseUrl and just clears the field).
// Shared by extension/options.js; broker/src/providers/openai-compat.ts does
// its OWN security check (isAllowedBaseUrl there) — this file's
// isAllowedBaseUrl is a client-side convenience copy of the exact same rule,
// so the options page can show an inline error before round-tripping to the
// broker, never the sole enforcement point.

export const MODEL_PROVIDER_PRESETS = [
  { label: "LM Studio", baseUrl: "http://localhost:1234/v1" },
  { label: "Ollama", baseUrl: "http://localhost:11434/v1" },
  { label: "OpenAI", baseUrl: "https://api.openai.com/v1" },
  { label: "Mistral", baseUrl: "https://api.mistral.ai/v1" },
  { label: "OpenRouter", baseUrl: "https://openrouter.ai/api/v1" },
  { label: "DeepSeek", baseUrl: "https://api.deepseek.com/v1" },
];

// Same rule as broker/src/protocol.ts's isValidBaseUrl /
// broker/src/providers/openai-compat.ts's isAllowedBaseUrl: `https://`
// unconditionally, or `http://` restricted to loopback (localhost /
// 127.0.0.1 / [::1]) — a non-loopback `http://` would send the API key in
// clear text over the network. The broker is the actual enforcement point
// (a client-side check can always be bypassed); this only gives the user an
// immediate, specific message instead of a silent no-op or a round trip.
export function isAllowedBaseUrl(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  if (url.protocol === "https:") return true;
  if (url.protocol === "http:") {
    // URL.hostname keeps the brackets for a literal IPv6 address ("[::1]",
    // not "::1") — verified against Chrome/Firefox URL behaviour.
    return url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "[::1]";
  }
  return false;
}
