// The registry of model providers Coati knows about: the two built-ins
// (ollama, claude-api) plus whatever external modules config.json's
// `modules` array names — see docs/MODULES.md and docs/PROTOCOL.md's
// amendement 2026-09-29. server.ts uses this both to dispatch
// chat/summarize/act to the currently-selected provider and to answer
// `settings.get`/`settings.set` by probing every provider's isAvailable().

import type { ModelProvider } from "./types.ts";
import { ollamaProvider } from "./ollama.ts";
import { claudeApiProvider } from "./claude-api.ts";
import { buildProviderHost, type ProviderHost } from "./host.ts";
import type { ModuleConfigEntry } from "../config.ts";

const BUILTIN_PROVIDERS: readonly ModelProvider[] = [ollamaProvider, claudeApiProvider];

/** Runtime shape check on whatever a module's `createProvider()` returned —
 * this is the ONLY guarantee the broker has that an external module honours
 * the ModelProvider contract, since there is no compiler between the two.
 * `listModels` is intentionally not required (optional on ModelProvider). */
function isModelProviderShape(value: unknown): value is ModelProvider {
  if (!value || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.id === "string" &&
    v.id.length > 0 &&
    typeof v.label === "string" &&
    typeof v.isAvailable === "function" &&
    typeof v.checkStatus === "function" &&
    typeof v.streamAnswer === "function"
  );
}

export interface LoadModulesResult {
  providers: ModelProvider[];
  /** One entry per module that failed to load or didn't return a valid
   * provider — never thrown. A broken module must never crash the broker nor
   * stop the other providers from loading (CLAUDE.md security rule #3). */
  warnings: string[];
}

/**
 * Loads every module declared in config.json's `modules` array via dynamic
 * `import()` — the ONLY path a provider beyond the two built-ins enters this
 * broker. `entry.path` is used as given (an absolute filesystem path is the
 * documented contract, docs/MODULES.md) — never a URL, never anything that
 * came from the extension or a page.
 */
export async function loadProviderModules(
  entries: readonly ModuleConfigEntry[],
  host: ProviderHost = buildProviderHost(),
): Promise<LoadModulesResult> {
  const providers: ModelProvider[] = [];
  const warnings: string[] = [];
  for (const entry of entries) {
    let mod: unknown;
    try {
      mod = await import(entry.path);
    } catch (err) {
      warnings.push(
        `module at ${entry.path} failed to import: ${err instanceof Error ? err.message : String(err)} — skipped`,
      );
      continue;
    }
    const factory = (mod as { default?: unknown } | undefined)?.default;
    if (typeof factory !== "function") {
      warnings.push(`module at ${entry.path} has no default export function — skipped`);
      continue;
    }
    let provider: unknown;
    try {
      provider = await factory(host, entry.options ?? {});
    } catch (err) {
      warnings.push(
        `module at ${entry.path}'s createProvider() threw: ${err instanceof Error ? err.message : String(err)} — skipped`,
      );
      continue;
    }
    if (!isModelProviderShape(provider)) {
      warnings.push(`module at ${entry.path} did not return a valid provider (see docs/MODULES.md) — skipped`);
      continue;
    }
    providers.push(provider);
  }
  return { providers, warnings };
}

// Populated once at startup by initRegistry() (server.ts's entrypoint), or
// directly by tests via __setProvidersForTests(). A module load failure is
// final for the lifetime of this process — restart to retry, same as any
// other config.json change.
let providers: readonly ModelProvider[] = BUILTIN_PROVIDERS;

export function getProviders(): readonly ModelProvider[] {
  return providers;
}

export function getProvider(id: string | undefined): ModelProvider | undefined {
  if (!id) return undefined;
  return providers.find((p) => p.id === id);
}

/** Loads config.json's `modules` and installs the registry (built-ins +
 * whatever loaded) as the process-wide set `getProvider`/`getProviders`
 * read from. Called once from server.ts's `import.meta.main` entrypoint,
 * before `Bun.serve` starts. Logs (never throws) one line per module that
 * failed to load. */
export async function initRegistry(
  moduleEntries: readonly ModuleConfigEntry[] = [],
  host?: ProviderHost,
): Promise<{ warnings: string[] }> {
  const { providers: loaded, warnings } = await loadProviderModules(moduleEntries, host);
  const usedHost = host ?? buildProviderHost();
  for (const w of warnings) usedHost.logger.warn(w);
  providers = [...BUILTIN_PROVIDERS, ...loaded];
  return { warnings };
}

// --- Testing seams -----------------------------------------------------
//
// Bypass dynamic import entirely — tests that want a fake provider (or the
// bare built-ins) set the registry directly rather than writing a module
// file to disk. Not part of the public API.

export function __setProvidersForTests(list: readonly ModelProvider[]): void {
  providers = list;
}

export function __resetProvidersForTests(): void {
  providers = BUILTIN_PROVIDERS;
}

/** The built-in providers alone, regardless of what the registry currently
 * holds — used by tests that want to compose "built-ins + one fake" without
 * hard-coding the list. */
export const BUILTIN_PROVIDER_IDS: readonly string[] = BUILTIN_PROVIDERS.map((p) => p.id);
