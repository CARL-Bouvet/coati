// Config loading. Base directories are always passed in as parameters (never
// hard-coded via homedir()) so tests can point at a temp dir.

import { existsSync, readFileSync, chmodSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { homedir } from "node:os";
import { hardenDir, atomicWriteFileSync } from "./fs-atomic.ts";

/**
 * A model provider's identifier. OPEN string (docs/PROTOCOL.md): the broker embeds exactly two
 * providers (`ollama`, `claude-api`), and anything else is an externally loaded module (see
 * docs/ARCHITECTURE.md) whose id the broker cannot know ahead of time. config.ts
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
 * the extension or a page). `options` is passed
 * through, untouched, as the module's `createProvider(host, options)` second
 * argument — see docs/ARCHITECTURE.md. */
export interface ModuleConfigEntry {
  path: string;
  options?: Record<string, unknown>;
}

/** One configured `openai-compat` service. */
export interface CompatService {
  baseUrl: string;
  model?: string;
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
   * BYOK secrets, keyed per provider — NEVER a single global field: a secret must only ever reach
   * the service it was entered for. `claude-api` is a bare string (Anthropic has exactly one
   * base URL, no origin to bind against). `openai-compat` is a map from URL *origin*
   * (`new URL(baseUrl).origin`) to the key entered for it: resolveApiKey() only returns the entry
   * of the CURRENT baseUrl's origin, so one service's key never reaches another host, and
   * switching between configured services keeps every key. WRITE-ONLY end to end: accepted by
   * `settings.set`, persisted here (0600, same as the rest of this file), and NEVER read back
   * into a `settings`/`settings.set` response (only a `hasKey` boolean is) — see
   * handlers/settings.ts's buildSettingsPayload and project rule 17. Never logged,
   * never included in an error message — see providers/claude-api.ts and providers/openai-compat.ts.
   */
  apiKeys?: {
    "claude-api"?: string;
    "openai-compat"?: Record<string, string>;
  };
  /** The `openai-compat` services the user configured, each with the model last used on it. The
   * active one is `baseUrl`. Removing a service is explicit (removeCompatService). */
  compatServices?: CompatService[];
  /** Base URL of the ACTIVE `openai-compat` service, e.g. "http://localhost:1234/v1" for LM
   * Studio; always one of `compatServices`. NOT a secret — handlers/settings.ts's
   * buildSettingsPayload echoes it back in `settings` for the active provider, unlike apiKey.
   * Validated (https, or http restricted to loopback) at settings.set time — see protocol.ts's
   * isValidBaseUrl. */
  baseUrl?: string;
  /** External provider modules to load at startup — see ModuleConfigEntry
   * above and docs/ARCHITECTURE.md. Absent/empty means "built-in providers only". */
  modules?: ModuleConfigEntry[];
  /** docs/PROTOCOL.md: absent or
   * anything other than `true`/`false` means `false` (with a startup
   * warning for a present-but-invalid value — see loadConfig). Enables the
   * `key: "pasted"` branch of the v: 2 handshake for browsers that cannot
   * launch a native host (Flatpak, Snap). */
  legacyPairing?: boolean;
  /** docs/PROTOCOL.md
   * — the last model used per provider. Updated on every
   * settings.set that sets a model; restored when settings.set changes
   * only the provider (no explicit model). The active model is still
   * config.model (backward compat). Seeded from provider+model on first
   * load of an older config.json that lacks this field. */
  lastModels?: Record<ProviderId, string>;
}

export interface Dirs {
  /** Directory holding config.json, e.g. ~/.config/coati */
  configDir: string;
  /** Directory holding broker-key.json, pairing-secret, prompts-v2.json and
   * prefs.json, e.g. ~/.local/share/coati */
  dataDir: string;
}

// The pinned extension ID, derived from extension/manifest.json's "key" field
// (RSA 2048 public key). See docs/PROTOCOL.md for the derivation.
// Private key: ~/.config/coati/extension-key.pem (outside any repository, never committed).
const PINNED_EXTENSION_ID = "hehlgipomfminodhahcjbencblepjhah";

export const DEFAULT_OLLAMA_URL = "http://127.0.0.1:11434";

/**
 * Security gate for `ollamaUrl` (notes/BUG_ollama_url_not_validated_and_redirects_followed_20261006.md):
 * same https-always / http-loopback-only rule as openai-compat's
 * `isAllowedBaseUrl` (providers/openai-compat.ts) — reused rather than
 * reinvented, per docs/PROTOCOL.md's "nothing leaves the machine" claim for
 * this provider. Plus one check specific to this provider: no embedded
 * credentials (`http://user:pass@host`) — ollama has no such concept and a
 * leaked ollamaUrl must never carry any. Defined here (not in
 * providers/ollama.ts) to avoid a circular import: ollama.ts already imports
 * DEFAULT_OLLAMA_URL from this module. Applied both at config-load time
 * (loadConfig below, rejects a bad value from a hand-edited config.json) and
 * again at use time in providers/ollama.ts — a value that reaches the
 * provider some other way can never slip through either check alone.
 */
export function isAllowedOllamaUrl(value: string): boolean {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  if (url.username || url.password) return false;
  if (url.protocol === "https:") return true;
  if (url.protocol === "http:") {
    // URL.hostname keeps the brackets for a literal IPv6 address ("[::1]",
    // not "::1"). "127.x.x.x" covers the whole loopback /8, not just
    // 127.0.0.1 — Ollama/the OS accept any address in that range as loopback.
    return (
      url.hostname === "localhost" ||
      url.hostname === "[::1]" ||
      /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(url.hostname)
    );
  }
  return false;
}

// "Transport": the port is fixed. config.json's
// `port` key is no longer read into the running config — see loadConfig's
// warning below — this constant is the only source of truth left.
export const FIXED_PORT = 8787;

// docs/PROTOCOL.md: "ollama", not a personal-CLI
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
 * — only from server.ts entrypoint. `COATI_DATA_DIR` overrides dataDir only, for tests and for the
 * native host reading the same broker's files — see docs/PROTOCOL.md. */
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

function originOf(url: string | undefined): string | undefined {
  if (!url) return undefined;
  try {
    return new URL(url).origin;
  } catch {
    return undefined;
  }
}

/** Reads config.json's raw `apiKeys` object tolerantly, dropping anything malformed rather than
 * throwing. The `openai-compat` entry is a map origin → key; the older single `{ key, origin }`
 * slot is read as a one-entry map. Exported for tests. */
export function parseApiKeys(raw: unknown): CoatiConfig["apiKeys"] {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const obj = raw as Record<string, unknown>;
  const apiKeys: NonNullable<CoatiConfig["apiKeys"]> = {};
  if (typeof obj["claude-api"] === "string" && obj["claude-api"]) {
    apiKeys["claude-api"] = obj["claude-api"];
  }
  const oc = obj["openai-compat"];
  if (oc && typeof oc === "object" && !Array.isArray(oc)) {
    const ocObj = oc as Record<string, unknown>;
    const map: Record<string, string> = {};
    if (typeof ocObj.key === "string" && typeof ocObj.origin === "string") {
      if (ocObj.key && ocObj.origin) map[ocObj.origin] = ocObj.key;
    } else {
      for (const [origin, key] of Object.entries(ocObj)) {
        if (typeof key === "string" && key && originOf(origin) === origin) map[origin] = key;
      }
    }
    if (Object.keys(map).length > 0) apiKeys["openai-compat"] = map;
  }
  return Object.keys(apiKeys).length > 0 ? apiKeys : undefined;
}

/** Reads the raw `compatServices` array tolerantly. A config.json written before several services
 * existed has only `baseUrl` (and the model in `lastModels`): that address becomes the one entry,
 * so nothing configured is lost. Exported for tests. */
export function parseCompatServices(
  raw: unknown,
  baseUrl: string | undefined,
  legacyModel: string | undefined,
): CompatService[] | undefined {
  const services: CompatService[] = [];
  if (Array.isArray(raw)) {
    for (const item of raw) {
      if (!item || typeof item !== "object") continue;
      const { baseUrl: url, model } = item as Record<string, unknown>;
      if (typeof url !== "string" || !originOf(url) || services.some((s) => s.baseUrl === url)) continue;
      services.push(typeof model === "string" && model ? { baseUrl: url, model } : { baseUrl: url });
    }
  }
  if (baseUrl && !services.some((s) => s.baseUrl === baseUrl)) {
    services.push(legacyModel ? { baseUrl, model: legacyModel } : { baseUrl });
  }
  return services.length > 0 ? services : undefined;
}

/**
 * Resolves the API key a provider should actually receive for a request,
 * NEVER the raw stored value — see CoatiConfig.apiKeys's doc for the
 * security reasoning. `claude-api` gets its key unconditionally (no origin
 * to bind: Anthropic has one fixed API host). `openai-compat` only gets the
 * key stored for `config.baseUrl`'s own origin — a baseUrl moved to another
 * host never leaks the previous host's key. Every other provider id (built-in with no BYOK slot,
 * or an external module) gets `undefined`: there is no defined storage for
 * it, so nothing is ever handed out by accident.
 */
export function resolveApiKey(config: CoatiConfig, providerId: ProviderId): string | undefined {
  if (providerId === "claude-api") return config.apiKeys?.["claude-api"];
  if (providerId === "openai-compat") {
    const origin = originOf(config.baseUrl);
    return origin ? config.apiKeys?.["openai-compat"]?.[origin] : undefined;
  }
  return undefined;
}

/** Whether a stored key exists for the service at `baseUrl` — a boolean, never the key. */
export function hasCompatKey(config: CoatiConfig, baseUrl: string): boolean {
  const origin = originOf(baseUrl);
  return Boolean(origin && config.apiKeys?.["openai-compat"]?.[origin]);
}

function withoutEmpty(apiKeys: NonNullable<CoatiConfig["apiKeys"]>): CoatiConfig["apiKeys"] {
  if (apiKeys["openai-compat"] && Object.keys(apiKeys["openai-compat"]).length === 0) {
    delete apiKeys["openai-compat"];
  }
  return Object.keys(apiKeys).length > 0 ? apiKeys : undefined;
}

/**
 * Stores (or forgets, on `key === ""`) an API key for `providerId`, returning
 * the new `apiKeys` object — pure, does not mutate `config`. `openai-compat`
 * binds the key to `config.baseUrl`'s CURRENT origin (must already be set —
 * see server.ts's applySettings, which applies a `baseUrl` patch before this
 * so a settings.set carrying both binds to the new address, not the old
 * one); other services' keys are untouched. An unknown provider id (no defined BYOK slot) is a
 * no-op: there is nowhere safe to put it.
 */
export function setApiKey(
  config: CoatiConfig,
  providerId: ProviderId,
  key: string,
): CoatiConfig["apiKeys"] {
  const apiKeys: NonNullable<CoatiConfig["apiKeys"]> = { ...config.apiKeys };
  if (providerId === "claude-api") {
    if (key === "") delete apiKeys["claude-api"];
    else apiKeys["claude-api"] = key;
  } else if (providerId === "openai-compat") {
    const origin = originOf(config.baseUrl);
    // No usable baseUrl: nothing to bind the key's origin to — dropped rather than stored
    // without an origin.
    if (origin) {
      const map = { ...apiKeys["openai-compat"] };
      if (key === "") delete map[origin];
      else map[origin] = key;
      apiKeys["openai-compat"] = map;
    }
  }
  return withoutEmpty(apiKeys);
}

/** Adds `baseUrl` to the configured services (no-op when present). Pure. */
export function addCompatService(config: CoatiConfig, baseUrl: string): CompatService[] {
  const services = config.compatServices ?? [];
  return services.some((s) => s.baseUrl === baseUrl) ? services : [...services, { baseUrl }];
}

/** Removes the service at `baseUrl` and its key (unless another service shares the origin);
 * `baseUrl` is cleared when it was the active one. Pure; the only way a service or its key goes away. */
export function removeCompatService(config: CoatiConfig, baseUrl: string): CoatiConfig {
  const services = (config.compatServices ?? []).filter((s) => s.baseUrl !== baseUrl);
  const origin = originOf(baseUrl);
  const apiKeys: NonNullable<CoatiConfig["apiKeys"]> = { ...config.apiKeys };
  if (origin && apiKeys["openai-compat"] && !services.some((s) => originOf(s.baseUrl) === origin)) {
    const map = { ...apiKeys["openai-compat"] };
    delete map[origin];
    apiKeys["openai-compat"] = map;
  }
  return {
    ...config,
    compatServices: services.length > 0 ? services : undefined,
    apiKeys: withoutEmpty(apiKeys),
    baseUrl: config.baseUrl === baseUrl ? undefined : config.baseUrl,
  };
}

/** Pure: validates one raw `modules` array entry's shape (`path` an absolute
 * filesystem path, never relative nor a URL; `options` absent or a plain
 * object) — malformed entries are dropped rather than throwing, same "never
 * crash on a bad config" stance as the rest of loadConfig. Exported for tests. */
export function parseModuleConfigEntries(raw: unknown): ModuleConfigEntry[] {
  if (!Array.isArray(raw)) return [];
  const entries: ModuleConfigEntry[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const obj = item as Record<string, unknown>;
    if (typeof obj.path !== "string" || !isAbsolute(obj.path)) continue;
    const options =
      obj.options && typeof obj.options === "object" && !Array.isArray(obj.options)
        ? (obj.options as Record<string, unknown>)
        : undefined;
    entries.push(options ? { path: obj.path, options } : { path: obj.path });
  }
  return entries;
}

/** Parses the raw `lastModels` object from config.json, tolerantly dropping
 * malformed entries. Seeds from the raw object's own provider+model pair when
 * the field is absent (backward compat with older config.json files). Exported
 * for tests. */
export function parseLastModels(
  rawLastModels: unknown,
  rawObj: Record<string, unknown>,
): Record<ProviderId, string> | undefined {
  const result: Record<string, string> = {};

  if (rawLastModels && typeof rawLastModels === "object" && !Array.isArray(rawLastModels)) {
    for (const [k, v] of Object.entries(rawLastModels as Record<string, unknown>)) {
      if (isProviderId(k) && typeof v === "string" && v.length > 0) {
        result[k] = v;
      }
    }
  }

  // Seed from current provider+model when the field was absent (older config.json)
  const seedProvider = isProviderId(rawObj.provider) ? rawObj.provider : undefined;
  const seedModel = typeof rawObj.model === "string" && rawObj.model ? rawObj.model : undefined;
  if (seedProvider && seedModel && !result[seedProvider]) {
    result[seedProvider] = seedModel;
  }

  return Object.keys(result).length > 0 ? result : undefined;
}

function configPath(dirs: Dirs): string {
  return join(dirs.configDir, "config.json");
}

/**
 * Loads ~/.config/coati/config.json (relative to dirs.configDir), creating it
 * with defaults on first run. The `port` key, if present, is IGNORED — the
 * broker always listens on FIXED_PORT ("Transport");
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
      `coati-broker: config.json has "port": ${obj.port}, ignored — the port is fixed at ${FIXED_PORT} ` +
        `(see docs/PROTOCOL.md "Transport").`,
    );
  }
  let legacyPairing = false;
  if (obj.legacyPairing !== undefined) {
    if (obj.legacyPairing === true || obj.legacyPairing === false) {
      legacyPairing = obj.legacyPairing;
    } else {
      console.warn(
        `coati-broker: config.json has "legacyPairing": ${JSON.stringify(obj.legacyPairing)}, invalid value — ` +
          `treated as false (see docs/PROTOCOL.md "Legacy mode").`,
      );
    }
  }
  const baseUrl = typeof obj.baseUrl === "string" && obj.baseUrl ? obj.baseUrl : undefined;
  const model = typeof obj.model === "string" && obj.model ? obj.model : undefined;
  const lastModels = parseLastModels(obj.lastModels, obj);
  return {
    port: FIXED_PORT,
    allowedExtensionIds: Array.isArray(obj.allowedExtensionIds)
      ? (obj.allowedExtensionIds as string[])
      : [],
    // A malformed or absent provider value in a hand-edited config.json falls
    // back to the default — "ollama". Whether the
    // resulting id actually names a provider this broker knows about (built
    // in or loaded from `modules`) is checked at runtime, not here.
    provider: isProviderId(obj.provider) ? obj.provider : DEFAULT_CONFIG.provider,
    model,
    // Rejected (not silently kept) when it fails isAllowedOllamaUrl — a bad
    // scheme, embedded credentials, or a non-loopback http host — falling
    // back to the default rather than sending page content to whatever that
    // value names (notes/BUG_ollama_url_not_validated_and_redirects_followed_20261006.md).
    ollamaUrl: (() => {
      if (typeof obj.ollamaUrl !== "string" || !obj.ollamaUrl) return DEFAULT_CONFIG.ollamaUrl;
      if (isAllowedOllamaUrl(obj.ollamaUrl)) return obj.ollamaUrl;
      console.warn(
        `coati-broker: config.json has "ollamaUrl": ${JSON.stringify(obj.ollamaUrl)}, rejected — must be ` +
          `http(s), no credentials in the URL, and http is only allowed on loopback ` +
          `(localhost/127.0.0.0/8/[::1]). Value ignored, falling back to ${DEFAULT_CONFIG.ollamaUrl}.`,
      );
      return DEFAULT_CONFIG.ollamaUrl;
    })(),
    // New per-provider shape (`apiKeys`) takes priority; a legacy config.json
    // written before this fix (single global `apiKey`, always the
    // claude-api/Anthropic key in practice — openai-compat did not exist
    // yet) is migrated in place: on the very next saveConfig (any
    // settings.set), the legacy field is gone from disk for good.
    apiKeys: parseApiKeys(obj.apiKeys) ?? (typeof obj.apiKey === "string" && obj.apiKey
      ? { "claude-api": obj.apiKey }
      : undefined),
    baseUrl,
    compatServices: parseCompatServices(
      obj.compatServices,
      baseUrl,
      lastModels?.["openai-compat"] ?? (obj.provider === "openai-compat" ? model : undefined),
    ),
    modules: parseModuleConfigEntries(obj.modules),
    legacyPairing,
    lastModels,
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
