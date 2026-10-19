// API-key format check for `settings.set` (docs/PROTOCOL.md). A key is bound
// to a service; a text that cannot be that service's key (a pasted command, a
// key with spaces) is refused before it is stored.

/** Prefix the service's keys start with, or "" when it has no fixed one. */
function keyPrefix(provider: string, baseUrl: string | undefined): string {
  if (provider === "claude-api") return "sk-ant-";
  if (provider !== "openai-compat" || !baseUrl) return "";
  try {
    const host = new URL(baseUrl).hostname;
    if (host === "openrouter.ai") return "sk-or-";
    if (host === "api.openai.com") return "sk-";
  } catch {
    // unparsable address: no fixed prefix
  }
  return "";
}

/** True when `key` (non-empty; "" means "forget") can be a key for `provider`. */
export function isValidKeyFormat(provider: string, baseUrl: string | undefined, key: string): boolean {
  const trimmed = key.trim();
  // A Claude Code subscription token (`sk-ant-oat…`) is not an API key and may not be used outside Claude Code.
  if (provider === "claude-api" && trimmed.startsWith("sk-ant-oat")) return false;
  return trimmed.length > 0 && !/\s/.test(trimmed) && trimmed.startsWith(keyPrefix(provider, baseUrl));
}
