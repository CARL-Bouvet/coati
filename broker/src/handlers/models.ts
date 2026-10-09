// models.list backend (amendement 2026-10-07) — "Available models list" /
// "Lot 4: host capacity + fit classification". Split out of
// server.ts (lot F5).
//
// Builds the payload for a `models` reply: queries every configured source
// independently (each failure is isolated, reported in `sources`) and returns
// the flat list of usable models. Sources:
//   1. Ollama — always queried, regardless of the active provider.
//   2. openai-compat — if config.baseUrl is loopback, list via /models; if
//      remote with a stored key and a remembered model, one static entry.
//   3. claude-api — if key is configured and a model was remembered.
//   4. Any loaded module provider — if configured (isAvailable sans model)
//      and a model was remembered.
// `host: null` until lot 4 fills it.

import { DEFAULT_CONFIG, DEFAULT_OLLAMA_URL, resolveApiKey, type ProviderId, type CoatiConfig } from "../config.ts";
import { getProviders, getProvider } from "../providers/registry.ts";
import { fetchOpenAiCompatVisionMap } from "../providers/openai-compat.ts";
import { listModelEntries as listOllamaModelEntries, fetchPsEntries } from "../providers/ollama.ts";
import { readHostCapacity, computeFit } from "../host.ts";
import type { HostCapacity, ModelEntry, ModelSource } from "../protocol.ts";
import type { ModelProvider, ProviderRuntimeOptions } from "../providers/types.ts";

// Amendement 2026-10-07 bis: a sensible model for a configured provider with
// no remembered model — its own listModels() (first entry) when it has one,
// else its declared defaultModel. Never throws: a listModels() failure just
// falls through to defaultModel, same as having none.
async function resolveFallbackModel(provider: ModelProvider, opts: ProviderRuntimeOptions): Promise<string | undefined> {
  if (provider.listModels) {
    try {
      const models = await provider.listModels(opts);
      if (models.length > 0) return models[0];
    } catch {
      // fall through to defaultModel
    }
  }
  return provider.defaultModel;
}

function isLoopbackUrl(url: string): boolean {
  try {
    const u = new URL(url);
    return u.hostname === "localhost" || u.hostname === "127.0.0.1" || u.hostname === "[::1]";
  } catch {
    return false;
  }
}

export async function buildModelsPayload(config: CoatiConfig): Promise<{
  current: { provider: ProviderId; model: string | undefined };
  entries: ModelEntry[];
  sources: ModelSource[];
  host: HostCapacity | null;
}> {
  const currentProvider = config.provider ?? DEFAULT_CONFIG.provider!;
  const entries: ModelEntry[] = [];
  const sources: ModelSource[] = [];

  // --- Source 1: Ollama — always queried -----------------------------------
  try {
    const ollamaEntries = await listOllamaModelEntries({ ollamaUrl: config.ollamaUrl ?? DEFAULT_OLLAMA_URL });
    for (const e of ollamaEntries) {
      const hasThinking = Array.isArray(e.capabilities) && e.capabilities.includes("thinking");
      // thinks:true = thinking-capable but cannot disable it (think:false ineffective).
      const thinks: true | undefined = hasThinking && !e.canDisableThinking ? true : undefined;
      // Amendement 2026-10-08 (lot B1): vision from the same /api/show
      // capabilities array already fetched for this entry — true/false when
      // the array is present, absent (unknown) when the daemon's /api/show
      // doesn't report capabilities at all (older Ollama).
      const vision: boolean | undefined = Array.isArray(e.capabilities)
        ? e.capabilities.includes("vision")
        : undefined;
      entries.push({
        provider: "ollama",
        model: e.name,
        local: true,
        ...(e.sizeBytes > 0 ? { sizeBytes: e.sizeBytes } : {}),
        ...(thinks ? { thinks } : {}),
        ...(e.contextTokens !== undefined ? { contextTokens: e.contextTokens } : {}),
        ...(vision !== undefined ? { vision } : {}),
      });
    }
    sources.push({ provider: "ollama", state: "ok" });
  } catch {
    sources.push({ provider: "ollama", state: "unreachable" });
  }

  // --- Source 2: openai-compat ---------------------------------------------
  if (config.baseUrl) {
    if (isLoopbackUrl(config.baseUrl)) {
      const ocProvider = getProvider("openai-compat");
      if (ocProvider?.listModels) {
        try {
          const ocApiKey = resolveApiKey(config, "openai-compat");
          const models = await ocProvider.listModels({ baseUrl: config.baseUrl, apiKey: ocApiKey });
          // Amendement 2026-10-08 (lot B1): one shared fetch for the whole
          // batch (OpenRouter's /models or LM Studio's /api/v0/models),
          // instead of a per-entry round trip — absent map (unknown origin)
          // simply leaves `vision` off every entry.
          const visionMap = await fetchOpenAiCompatVisionMap(config.baseUrl, ocApiKey).catch(() => undefined);
          for (const m of models) {
            const vision = visionMap?.get(m);
            entries.push({ provider: "openai-compat", model: m, local: true, ...(vision !== undefined ? { vision } : {}) });
          }
          sources.push({ provider: "openai-compat", state: "ok" });
        } catch {
          sources.push({ provider: "openai-compat", state: "unreachable" });
        }
      }
    } else {
      // Remote openai-compat: one static entry if key + remembered model.
      const hasKey = !!resolveApiKey(config, "openai-compat");
      const remembered = config.lastModels?.["openai-compat"];
      if (hasKey && remembered) {
        entries.push({ provider: "openai-compat", model: remembered, local: false });
        sources.push({ provider: "openai-compat", state: "ok" });
      } else {
        sources.push({ provider: "openai-compat", state: "not-configured" });
      }
    }
  }

  // --- Sources 3+: claude-api and loaded module providers ------------------
  for (const p of getProviders()) {
    if (p.id === "ollama" || p.id === "openai-compat") continue;
    const pOpts = {
      ollamaUrl: config.ollamaUrl,
      apiKey: resolveApiKey(config, p.id as ProviderId),
      baseUrl: config.baseUrl,
    };
    const configured = await p.isAvailable(pOpts).then((r) => r.available).catch(() => false);
    if (configured) {
      const remembered = config.lastModels?.[p.id];
      // Amendement 2026-10-07 bis: a configured provider with no remembered
      // model yet (never switched to with an explicit model) still gets a
      // sensible entry — its own listModels() when it has one, else its
      // declared defaultModel — instead of vanishing from the list. Without
      // this, a configured-but-never-explicitly-set provider (e.g. claude-api
      // right after its key is entered) reported "not-configured" even
      // though it is perfectly usable.
      const model = remembered ?? (await resolveFallbackModel(p, pOpts));
      if (model) {
        // Amendement 2026-10-08 (lot B1): the provider's static `vision`
        // field (claude-api: true; an external module: whatever it
        // declared, docs/MODULES.md) — never a per-model lookup here, this
        // loop never knows the model's own capabilities beyond its name.
        entries.push({ provider: p.id, model, local: false, ...(p.vision !== undefined ? { vision: p.vision } : {}) });
        sources.push({ provider: p.id, state: "ok" });
      } else {
        sources.push({ provider: p.id, state: "not-configured" });
      }
    }
  }

  // --- Lot 4: host capacity + /api/ps + fit classification -------------------
  const ollamaUrl = config.ollamaUrl ?? DEFAULT_OLLAMA_URL;
  const [host, psEntries] = await Promise.all([
    readHostCapacity().catch(() => null as HostCapacity | null),
    fetchPsEntries({ ollamaUrl }).catch(() => [] as Awaited<ReturnType<typeof fetchPsEntries>>),
  ]);

  // Build a map of currently-loaded model name → gpuPercent.
  const psMap = new Map<string, number>();
  for (const ps of psEntries) {
    if (ps.size > 0) {
      psMap.set(ps.name, Math.round((100 * ps.size_vram) / ps.size));
    }
  }

  // Annotate entries: fit (local Ollama with known size) + gpuPercent (from /api/ps).
  for (const entry of entries) {
    if (entry.local && host && typeof entry.sizeBytes === "number") {
      entry.fit = computeFit(entry.sizeBytes, host);
    }
    const gpu = psMap.get(entry.model);
    if (gpu !== undefined) {
      entry.gpuPercent = gpu;
    }
  }

  return {
    current: { provider: currentProvider, model: config.model },
    entries,
    sources,
    host,
  };
}
