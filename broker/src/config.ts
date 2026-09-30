// Config loading. Base directories are always passed in as parameters (never
// hard-coded via homedir()) so tests can point at a temp dir.

import { existsSync, readFileSync, chmodSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { hardenDir, atomicWriteFileSync } from "./fs-atomic.ts";

/**
 * A model provider's identifier. OPEN string, since amendement 2026-09-29 of
 * docs/PROTOCOL.md: the broker embeds exactly two providers (`ollama`,
 * `claude-api`), and anything else is an externally loaded module (see
 * docs/MODULES.md) whose id the broker cannot know ahead of time. config.ts
 * therefore no longer validates a `provider` value against a closed list —
 * only its *shape* (isProviderId below). Whether an id names a provider this
 * broker actually knows about (built in or successfully loaded from
 * `modules`) is a runtime question, answered by providers/registry.ts — a
 * configured-but-unknown id is reported unavailable, never silently swapped
 * for another provider (docs/PROTOCOL.md).
 */
export type ProviderId = string;

/** One entry of config.json's `modules` array — an external provider module,
 * loaded by providers/registry.ts at startup via dynamic `import()`. `path`
 * must be an absolute filesystem path (never a URL, never anything read from
 * the extension or a page — CLAUDE.md security rule #3). `options` is passed
 * through, untouched, as the module's `createProvider(host, options)` second
 * argument — see docs/MODULES.md. */
export interface ModuleConfigEntry {
  path: string;
  options?: Record<string, unknown>;
}

export interface CoatiConfig {
  port: number;
  allowedExtensionIds: string[];
  /** Selected model provider. Optional at the type level because an old
   * config.json (written before this key existed) won't have it — loadConfig
   * fills in DEFAULT_CONFIG.provider ("ollama") when absent, no migration
   * step needed. */
  provider?: ProviderId;
  /** Provider-specific model name (e.g. "llama3.2" for ollama, an Anthropic
   * model id for claude-api). Unset means "no model chosen yet" — claude-api
   * and most external modules tolerate that (fall back to their own
   * default), ollama does not (see providers/ollama.ts). */
  model?: string;
  /** Base URL of the local Ollama daemon. */
  ollamaUrl?: string;
  /**
   * The user's own Anthropic API key, for the claude-api provider (BYOK).
   * WRITE-ONLY end to end: accepted by `settings.set`, persisted here
   * (0600, same as the rest of this file), and NEVER read back into a
   * `settings`/`settings.set` response — see server.ts's buildSettingsPayload
   * and CLAUDE.md security rule #1 (no secret reaches the extension). Never
   * logged, never included in an error message — see providers/claude-api.ts.
   */
  apiKey?: string;
  /** External provider modules to load at startup — see ModuleConfigEntry
   * above and docs/MODULES.md. Absent/empty means "built-in providers only". */
  modules?: ModuleConfigEntry[];
  /** Amendement 2026-09-30 (G4), docs/PROTOCOL.md "Mode hérité": absent or
   * anything other than `true`/`false` means `false` (with a startup
   * warning for a present-but-invalid value — see loadConfig). Enables the
   * `key: "pasted"` branch of the v: 2 handshake for browsers that cannot
   * launch a native host (Flatpak, Snap). */
  legacyPairing?: boolean;
}

export interface Dirs {
  /** Directory holding config.json, e.g. ~/.config/coati */
  configDir: string;
  /** Directory holding broker-key.json, pairing-secret, prompts-v2.json and
   * prefs.json, e.g. ~/.local/share/coati */
  dataDir: string;
}

// The pinned extension ID, derived from extension/manifest.json's "key" field
// (RSA 2048 public key). See docs/PROTOCOL.md "Pairing" for the derivation.
// Private key: ~/.config/coati/extension-key.pem (outside any repository, never committed).
const PINNED_EXTENSION_ID = "hehlgipomfminodhahcjbencblepjhah";

export const DEFAULT_OLLAMA_URL = "http://127.0.0.1:11434";

// Amendement 2026-09-25 ("Transport"): the port is fixed. config.json's
// `port` key is no longer read into the running config — see loadConfig's
// warning below — this constant is the only source of truth left.
export const FIXED_PORT = 8787;

// Amendement 2026-09-29 (docs/PROTOCOL.md): "ollama", not a personal-CLI
// provider — the only provider a fresh, public-repo install can use without
// any extra setup beyond installing Ollama itself.
export const DEFAULT_CONFIG: CoatiConfig = {
  port: FIXED_PORT,
  allowedExtensionIds: [PINNED_EXTENSION_ID],
  provider: "ollama",
  ollamaUrl: DEFAULT_OLLAMA_URL,
  legacyPairing: false,
};

/** Real-world default directories. Never called from library logic directly
 * — only from server.ts entrypoint. `COATI_DATA_DIR` (amendement 2026-09-30,
 * G4) overrides dataDir only, for tests and for the native host reading the
 * same broker's files — see docs/PROTOCOL.md "Clé de broker". */
export function defaultDirs(): Dirs {
  const home = homedir();
  const dataDir = process.env.COATI_DATA_DIR || join(home, ".local", "share", "coati");
  return {
    configDir: join(home, ".config", "coati"),
    dataDir,
  };
}

// Shape only, not membership — see ProviderId's doc above. Printable ASCII,
// no whitespace, reasonable length: enough to keep a garbage value out of
// config.json and log lines, without the broker having to know the full set
// of ids in advance (built-ins + whatever modules happen to be configured).
const PROVIDER_ID_RE = /^[!-~]{1,64}$/;

export function isProviderId(v: unknown): v is ProviderId {
  return typeof v === "string" && PROVIDER_ID_RE.test(v);
}

/** Pure: validates one raw `modules` array entry's shape (`path` a non-empty
 * string, `options` absent or a plain object) — malformed entries are dropped
 * rather than throwing, same "never crash on a bad config" stance as the rest
 * of loadConfig. Exported for tests. */
export function parseModuleConfigEntries(raw: unknown): ModuleConfigEntry[] {
  if (!Array.isArray(raw)) return [];
  const entries: ModuleConfigEntry[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const obj = item as Record<string, unknown>;
    if (typeof obj.path !== "string" || obj.path.length === 0) continue;
    const options =
      obj.options && typeof obj.options === "object" && !Array.isArray(obj.options)
        ? (obj.options as Record<string, unknown>)
        : undefined;
    entries.push(options ? { path: obj.path, options } : { path: obj.path });
  }
  return entries;
}

function configPath(dirs: Dirs): string {
  return join(dirs.configDir, "config.json");
}

/**
 * Loads ~/.config/coati/config.json (relative to dirs.configDir), creating it
 * with defaults on first run. The `port` key, if present, is IGNORED — the
 * broker always listens on FIXED_PORT (amendement 2026-09-25, "Transport");
 * a value other than FIXED_PORT only produces a startup warning, never a
 * different listening port.
 */
export function loadConfig(dirs: Dirs): CoatiConfig {
  const path = configPath(dirs);
  hardenDir(dirs.configDir);
  if (!existsSync(path)) {
    atomicWriteFileSync(path, JSON.stringify(DEFAULT_CONFIG, null, 2) + "\n", 0o600);
    return { ...DEFAULT_CONFIG, allowedExtensionIds: [...DEFAULT_CONFIG.allowedExtensionIds] };
  }
  // Same reasoning as broker-key.ts's "already exists" branch: a config file
  // surviving a backup/restore could have lost its 0600 mode.
  chmodSync(path, 0o600);
  const raw = readFileSync(path, "utf8");
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    parsed = {};
  }
  const obj = (parsed && typeof parsed === "object" ? parsed : {}) as Record<string, unknown>;
  if (typeof obj.port === "number" && obj.port !== FIXED_PORT) {
    console.warn(
      `coati-broker: config.json a "port": ${obj.port}, ignoré — le port est figé à ${FIXED_PORT} ` +
        `(amendement 2026-09-25, voir docs/PROTOCOL.md "Transport").`,
    );
  }
  let legacyPairing = false;
  if (obj.legacyPairing !== undefined) {
    if (obj.legacyPairing === true || obj.legacyPairing === false) {
      legacyPairing = obj.legacyPairing;
    } else {
      console.warn(
        `coati-broker: config.json a "legacyPairing": ${JSON.stringify(obj.legacyPairing)}, valeur invalide — ` +
          `traité comme false (voir docs/PROTOCOL.md "Mode hérité").`,
      );
    }
  }
  return {
    port: FIXED_PORT,
    allowedExtensionIds: Array.isArray(obj.allowedExtensionIds)
      ? (obj.allowedExtensionIds as string[])
      : [],
    // A malformed or absent provider value in a hand-edited config.json falls
    // back to the default — "ollama" (amendement 2026-09-29). Whether the
    // resulting id actually names a provider this broker knows about (built
    // in or loaded from `modules`) is checked at runtime, not here.
    provider: isProviderId(obj.provider) ? obj.provider : DEFAULT_CONFIG.provider,
    model: typeof obj.model === "string" && obj.model ? obj.model : undefined,
    ollamaUrl:
      typeof obj.ollamaUrl === "string" && obj.ollamaUrl ? obj.ollamaUrl : DEFAULT_CONFIG.ollamaUrl,
    apiKey: typeof obj.apiKey === "string" && obj.apiKey ? obj.apiKey : undefined,
    modules: parseModuleConfigEntries(obj.modules),
    legacyPairing,
  };
}

/**
 * Persists the full config to dirs.configDir/config.json, 0600. Used by the
 * `settings.set` handler (server.ts) — writes the whole config, not a diff,
 * since CoatiConfig is small and this avoids a partial-write footgun.
 */
export function saveConfig(dirs: Pick<Dirs, "configDir">, config: CoatiConfig): void {
  hardenDir(dirs.configDir);
  const path = configPath(dirs as Dirs);
  atomicWriteFileSync(path, JSON.stringify(config, null, 2) + "\n", 0o600);
}
