// Config and pairing-secret loading. Base directories are always passed in as
// parameters (never hard-coded via homedir()) so tests can point at a temp dir.

import { existsSync, mkdirSync, readFileSync, writeFileSync, chmodSync, renameSync } from "node:fs";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { homedir } from "node:os";

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
}

export interface Dirs {
  /** Directory holding config.json, e.g. ~/.config/coati */
  configDir: string;
  /** Directory holding pairing.txt, prompts-v2.json and prefs.json, e.g. ~/.local/share/coati */
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
};

/** Real-world default directories. Never called from library logic directly — only from server.ts entrypoint. */
export function defaultDirs(): Dirs {
  const home = homedir();
  return {
    configDir: join(home, ".config", "coati"),
    dataDir: join(home, ".local", "share", "coati"),
  };
}

/** Creates `dir` (recursively) if absent, and (re)asserts 0700 on it either
 * way — docs/PROTOCOL.md "Frontière de menace": the broker's own directories
 * are "remis à 0700 à chaque démarrage" (re-applied at every start), not just
 * set once at creation, in case a backup/restore/sync tool loosened them. */
function ensureDir0700(dir: string): void {
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
  }
  chmodSync(dir, 0o700);
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
  ensureDir0700(dirs.configDir);
  if (!existsSync(path)) {
    writeFileSync(path, JSON.stringify(DEFAULT_CONFIG, null, 2) + "\n", {
      mode: 0o600,
    });
    return { ...DEFAULT_CONFIG, allowedExtensionIds: [...DEFAULT_CONFIG.allowedExtensionIds] };
  }
  // Same reasoning as loadOrCreatePairingSecret's "already exists" branch: a
  // config file surviving a backup/restore could have lost its 0600 mode.
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
  };
}

/**
 * Persists the full config to dirs.configDir/config.json, 0600. Used by the
 * `settings.set` handler (server.ts) — writes the whole config, not a diff,
 * since CoatiConfig is small and this avoids a partial-write footgun.
 */
export function saveConfig(dirs: Pick<Dirs, "configDir">, config: CoatiConfig): void {
  ensureDir0700(dirs.configDir);
  const path = configPath(dirs as Dirs);
  writeFileSync(path, JSON.stringify(config, null, 2) + "\n", { mode: 0o600 });
  chmodSync(path, 0o600);
}

/**
 * Loads the pairing secret from ~/.local/share/coati/pairing.txt (relative to
 * dirs.dataDir), generating a fresh 32 hex char secret with mode 0600 if absent.
 */
export function loadOrCreatePairingSecret(dirs: Dirs): string {
  const secretPath = join(dirs.dataDir, "pairing.txt");
  ensureDir0700(dirs.dataDir);
  if (existsSync(secretPath)) {
    // Re-assert 0600 even on the "already exists" path: a file restored from a
    // backup, copied by a naive sync tool, or left over from an older broker
    // version could have laxer permissions than the mode we set at creation.
    chmodSync(secretPath, 0o600);
    return readFileSync(secretPath, "utf8").trim();
  }
  const secret = randomBytes(16).toString("hex"); // 32 hex chars
  writeFileSync(secretPath, secret, { mode: 0o600 });
  chmodSync(secretPath, 0o600);
  return secret;
}

// --- Firefox pinning — amendement 2026-09-25 ---------------------------------
//
// Firefox gives every install of an extension a random moz-extension://<uuid>
// origin — unlike Chrome's "key"-derived, stable chrome-extension://<id>, it
// cannot be known ahead of time and put in allowedExtensionIds. Instead the
// broker learns it on first successful pairing (valid permanent secret over a
// moz-extension:// origin) and pins it. Unlike the pre-2026-09-25 behaviour
// (one uuid, one file, one value), this is now a LIST — several Firefox
// profiles/installs/temporary-loads can each pin their own uuid — capped at
// FIREFOX_UUID_CAP with least-recently-seen eviction. See server.ts's
// evaluateOrigin and docs/PROTOCOL.md "Cas Firefox".

export const FIREFOX_UUIDS_FILENAME = "firefox-extension-uuids.txt";

export const FIREFOX_UUID_CAP = 16;

// Exported (L4, lot7 security review) so every uuid read off disk or over the
// wire is validated before being written into the pin store or logged.
export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface FirefoxPin {
  uuid: string;
  /** ISO 8601 UTC, e.g. "2026-09-25T14:03:00Z". */
  pinnedAt: string;
  /** ISO 8601 UTC — updated on every grant to this uuid. */
  lastSeen: string;
}

/** Pure: parses `firefox-extension-uuids.txt`'s content into pins. Blank
 * lines and `#`-comments are skipped; a line that doesn't parse as
 * `<uuid> <pinnedAt> <lastSeen>` is dropped and counted in `malformedCount`
 * (the caller logs it) rather than throwing or aborting the whole file. */
export function parseFirefoxPinsFile(content: string): { pins: FirefoxPin[]; malformedCount: number } {
  const pins: FirefoxPin[] = [];
  let malformedCount = 0;
  for (const rawLine of content.split("\n")) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const parts = line.split(/\s+/);
    if (parts.length !== 3 || !UUID_RE.test(parts[0])) {
      malformedCount++;
      continue;
    }
    const [uuid, pinnedAt, lastSeen] = parts;
    pins.push({ uuid: uuid.toLowerCase(), pinnedAt, lastSeen });
  }
  return { pins, malformedCount };
}

/** Pure: the inverse of parseFirefoxPinsFile — one `<uuid> <pinnedAt>
 * <lastSeen>` line per pin, trailing newline, nothing else. */
export function serializeFirefoxPinsFile(pins: FirefoxPin[]): string {
  if (pins.length === 0) return "";
  return pins.map((p) => `${p.uuid} ${p.pinnedAt} ${p.lastSeen}`).join("\n") + "\n";
}

function firefoxPinsPath(dirs: Pick<Dirs, "dataDir">): string {
  return join(dirs.dataDir, FIREFOX_UUIDS_FILENAME);
}

/** Reads the current Firefox pin list off disk — called at EVERY WebSocket
 * open (docs/PROTOCOL.md: "relu à chaud"), never cached, so a hand-edit takes
 * effect on the very next connection without a broker restart. */
export function loadFirefoxPins(dirs: Pick<Dirs, "dataDir">): FirefoxPin[] {
  ensureDir0700(dirs.dataDir);
  const path = firefoxPinsPath(dirs);
  if (!existsSync(path)) {
    return [];
  }
  chmodSync(path, 0o600);
  const { pins, malformedCount } = parseFirefoxPinsFile(readFileSync(path, "utf8"));
  if (malformedCount > 0) {
    console.warn(`coati-broker: ${malformedCount} malformed line(s) in ${FIREFOX_UUIDS_FILENAME} ignored`);
  }
  return pins;
}

/** Atomic write: temp file in the same directory, then renamed over the real
 * path — so a reader never observes a half-written file, and a concurrent
 * writer's win is all-or-nothing. 0600, matching every other file here. */
function writeFirefoxPinsAtomic(dirs: Pick<Dirs, "dataDir">, pins: FirefoxPin[]): void {
  ensureDir0700(dirs.dataDir);
  const path = firefoxPinsPath(dirs);
  const tmpPath = `${path}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  writeFileSync(tmpPath, serializeFirefoxPinsFile(pins), { mode: 0o600 });
  chmodSync(tmpPath, 0o600);
  renameSync(tmpPath, path);
}

export interface RecordFirefoxSeenResult {
  pins: FirefoxPin[];
  /** True when `uuid` was not already pinned and this call just pinned it
   * (a "pin" event, per docs/PROTOCOL.md's journal lines) — false when this
   * was only a lastSeen refresh for an already-pinned uuid. */
  pinned: boolean;
  /** Set when adding this pin pushed the list over FIREFOX_UUID_CAP and the
   * least-recently-seen entry was evicted to make room. */
  evicted?: FirefoxPin;
}

/**
 * Records a successful grant to `uuid`: re-reads the file first (per spec,
 * "toute écriture relit d'abord le fichier" — a line deleted by hand between
 * the read at WS-open and this call must never be silently recreated), then
 * either refreshes `lastSeen` for an existing pin, or — only when `mayCreate`
 * is true — adds a fresh pin (pinnedAt = lastSeen = nowIso), evicting the
 * least-recently-seen entry if that pushes the list past FIREFOX_UUID_CAP.
 * Writes atomically. Used for BOTH the "provisional origin presents the
 * permanent secret" case (a new pin, `mayCreate: true`) and the
 * "already-pinned origin connects again" case (a lastSeen touch) — see
 * server.ts's handleHandshakeMessage.
 *
 * `mayCreate` defaults to true so every existing direct caller (this
 * module's own tests included) keeps its historical "touch or create"
 * behaviour; server.ts passes it explicitly, true only on the permanent
 * secret + not-yet-pinned-origin path (L1, lot7 security review). When
 * `mayCreate` is false and `uuid` isn't already pinned, this is a no-op: no
 * write, `pinned: false`, the pin list unchanged — a lastSeen touch must
 * never resurrect (or silently pin) an entry that isn't there.
 */
export function recordFirefoxSeen(
  dirs: Pick<Dirs, "dataDir">,
  uuid: string,
  nowIso: string,
  mayCreate = true,
): RecordFirefoxSeenResult {
  const current = loadFirefoxPins(dirs); // re-read, per spec
  const idx = current.findIndex((p) => p.uuid === uuid);
  if (idx >= 0) {
    const pins = current.slice();
    pins[idx] = { ...pins[idx], lastSeen: nowIso };
    writeFirefoxPinsAtomic(dirs, pins);
    return { pins, pinned: false };
  }
  if (!mayCreate) {
    return { pins: current, pinned: false };
  }
  const fresh: FirefoxPin = { uuid, pinnedAt: nowIso, lastSeen: nowIso };
  let pins = [...current, fresh];
  let evicted: FirefoxPin | undefined;
  if (pins.length > FIREFOX_UUID_CAP) {
    let lruIdx = 0;
    for (let i = 1; i < pins.length; i++) {
      if (pins[i].lastSeen < pins[lruIdx].lastSeen) lruIdx = i;
    }
    evicted = pins[lruIdx];
    pins = pins.filter((_, i) => i !== lruIdx);
  }
  writeFirefoxPinsAtomic(dirs, pins);
  return { pins, pinned: true, evicted };
}
