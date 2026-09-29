// 60s cache in front of each provider's checkStatus() — docs/PROTOCOL.md
// "Disponibilité du fournisseur" (amendement 2026-09-25): "Cache côté broker :
// 60 s. [...] Deux demandes simultanées pendant une vérification en cours
// partagent la même vérification." Keyed on (provider, model, ollamaUrl,
// key presence) so a settings change is never served a stale answer even
// before the cache would naturally expire (settings.set also explicitly
// clears the whole cache — belt and braces, since a key can change without
// `model`/`ollamaUrl` changing, and this key already covers that case, but
// clearing on every settings.set is cheap and simpler to reason about than
// trusting the key alone).

import type { ProviderId } from "./config.ts";
import type { ProviderStatusState } from "./protocol.ts";
import { getProvider } from "./providers/registry.ts";
import type { ProviderRuntimeOptions } from "./providers/types.ts";

export interface ProviderStatusResult {
  provider: ProviderId;
  state: ProviderStatusState;
  reason: string;
  /** ISO 8601 UTC of the check that produced this result — for a
   * cache/in-flight hit, the ORIGINAL check's time, not now. */
  checkedAt: string;
}

const CACHE_TTL_MS = 60_000;

interface CacheEntry {
  result: ProviderStatusResult;
  expiresAt: number;
}

export class ProviderStatusCache {
  private cache = new Map<string, CacheEntry>();
  private inflight = new Map<string, Promise<ProviderStatusResult>>();
  private now: () => number;

  constructor(now: () => number = Date.now) {
    this.now = now;
  }

  private key(providerId: ProviderId, opts: ProviderRuntimeOptions): string {
    return JSON.stringify({
      provider: providerId,
      model: opts.model ?? null,
      ollamaUrl: opts.ollamaUrl ?? null,
      hasKey: Boolean(opts.apiKey),
    });
  }

  async get(providerId: ProviderId, opts: ProviderRuntimeOptions): Promise<ProviderStatusResult> {
    const key = this.key(providerId, opts);
    const cached = this.cache.get(key);
    if (cached && cached.expiresAt > this.now()) return cached.result;

    const inflight = this.inflight.get(key);
    if (inflight) return inflight;

    const promise = this.probe(providerId, opts)
      .then((result) => {
        this.cache.set(key, { result, expiresAt: this.now() + CACHE_TTL_MS });
        this.inflight.delete(key);
        return result;
      })
      .catch(() => {
        this.inflight.delete(key);
        const result: ProviderStatusResult = {
          provider: providerId,
          state: "unknown",
          reason: "probe-failed",
          checkedAt: new Date(this.now()).toISOString(),
        };
        this.cache.set(key, { result, expiresAt: this.now() + CACHE_TTL_MS });
        return result;
      });
    this.inflight.set(key, promise);
    return promise;
  }

  /** Called on a successful settings.set — docs/PROTOCOL.md: "Un settings.set
   * réussi vide le cache." Also empties `inflight` (L3, lot7 security
   * review): a probe that never settles (a subprocess-backed provider's own
   * checkStatus could hang) would otherwise keep every later `get()` for that key waiting on
   * the same stuck promise forever, even past an explicit clear() meant to
   * force a fresh probe. The stuck probe itself is left to run — only its
   * former callers are freed to start a new one. */
  clear(): void {
    this.cache.clear();
    this.inflight.clear();
  }

  private async probe(providerId: ProviderId, opts: ProviderRuntimeOptions): Promise<ProviderStatusResult> {
    const provider = getProvider(providerId);
    const checkedAt = new Date(this.now()).toISOString();
    if (!provider) {
      return { provider: providerId, state: "unknown", reason: "probe-failed", checkedAt };
    }
    const { state, reason } = await provider.checkStatus(opts);
    return { provider: providerId, state, reason, checkedAt };
  }
}
