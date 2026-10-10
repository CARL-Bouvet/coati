// settings.get / settings.set / settings.test backend — docs/PROTOCOL.md
// "Model provider" and "settings.test". Split out of server.ts
// (lot F5).

import {
  DEFAULT_CONFIG,
  resolveApiKey,
  type ProviderId,
  type CoatiConfig,
} from "../config.ts";
import { getProviders, getProvider } from "../providers/registry.ts";
import type { ModelProvider, ProviderRuntimeOptions, TestConnectionCode } from "../providers/types.ts";
import type { ProviderStatus, SettingsSetMessage } from "../protocol.ts";
import { t, DEFAULT_LANG, type Lang } from "../messages.ts";
import {
  buildPrompt,
  isAuthRequiredError,
  isQuotaExceededError,
  isRateLimitedError,
  isModelMissingError,
  isProviderOverloadedError,
  ModelTimeoutError,
  RateLimitedError,
} from "../model.ts";
import type { ProviderStatusCache } from "../provider-status.ts";

/** Bundles what handleMessage needs beyond the message itself: the provider
 * currently selected (for chat/summarize/act) and read/write access to the
 * live config (for settings.get/settings.set). Config is process-wide per
 * server instance — one broker serves one user — so `set` mutates the
 * closure in startServer() directly. */
export interface SettingsCtx {
  /** The id of the currently configured provider — always present, even when
   * it names no provider this broker actually knows about (a module that
   * failed to load, a typo). */
  providerId: ProviderId;
  /** `undefined` when `providerId` doesn't match any built-in or
   * successfully loaded module — amendement 2026-09-29,
   * docs/PROTOCOL.md: reported as unavailable, never silently swapped for
   * another provider. handleStreamingRequest checks this before calling
   * runStream(). */
  provider: ModelProvider | undefined;
  providerOpts: ProviderRuntimeOptions;
  getConfig(): CoatiConfig;
  /** Applies provider/model/apiKey fields from a settings.set message,
   * persists to config.json when a configDir was supplied to startServer,
   * and returns the resulting config. */
  applySettings(
    patch: Pick<
      SettingsSetMessage,
      "provider" | "model" | "apiKey" | "baseUrl" | "clearKey"
    >,
  ): CoatiConfig;
  /** `provider.status` for the currently active provider, through the
   * broker-wide ProviderStatusCache (see docs/PROTOCOL.md "Provider
   * availability"). */
  getProviderStatus(): ReturnType<ProviderStatusCache["get"]>;
}

/** Probes every known provider's isAvailable() and, for the currently active
 * one, its listModels() (when it has one) — the full payload of a `settings`
 * reply. A provider that errors while probing is reported unavailable rather
 * than crashing the whole response; never hidden (see docs/PROTOCOL.md). */
export async function buildSettingsPayload(config: CoatiConfig, lang: Lang): Promise<{
  provider: ProviderId;
  model?: string;
  available: ProviderStatus[];
  models?: string[];
  baseUrl?: string;
}> {
  const provider = config.provider ?? DEFAULT_CONFIG.provider!;
  // Each provider gets ONLY its own key (security fix, 2026-09-30 ter) — see
  // config.ts's resolveApiKey. Built per-provider-id inside the `available`
  // loop below rather than once, since a single shared `opts` here was
  // exactly the bug: every provider's isAvailable() used to receive whatever
  // key was configured for the currently *active* provider.
  const opts: ProviderRuntimeOptions = {
    model: config.model,
    ollamaUrl: config.ollamaUrl,
    apiKey: resolveApiKey(config, provider),
    baseUrl: config.baseUrl,
    lang,
  };
  const available = await Promise.all(
    getProviders().map(async (p): Promise<ProviderStatus> => {
      const pOpts: ProviderRuntimeOptions = {
        ollamaUrl: config.ollamaUrl,
        apiKey: resolveApiKey(config, p.id as ProviderId),
        baseUrl: config.baseUrl,
        lang,
      };
      // `configured` (task 2) deliberately omits `model`: it answers "does
      // this provider have what it needs at all" (a stored key, a reachable
      // daemon, an installed CLI) — independent of whether the *currently
      // selected* model happens to be valid for it, which `available`
      // (below, with the full opts) already covers. For ollama this turns
      // isAvailable()'s "model X not installed" branch off, leaving only the
      // daemon-reachability check — exactly "its URL answers" per the task
      // brief.
      const configured = await p
        .isAvailable(pOpts)
        .then((r) => r.available)
        .catch(() => false);
      try {
        const a = await p.isAvailable({ ...pOpts, model: config.model });
        return { id: p.id as ProviderId, label: p.label, available: a.available, reason: a.reason, configured };
      } catch (err) {
        return {
          id: p.id as ProviderId,
          label: p.label,
          available: false,
          reason: err instanceof Error ? err.message : String(err),
          configured,
        };
      }
    }),
  );
  const active = getProvider(provider);
  const models = active?.listModels ? await active.listModels(opts).catch(() => undefined) : undefined;
  // baseUrl is NOT a secret (docs/PROTOCOL.md, amendement 2026-09-30 bis) —
  // unlike apiKey, echoed back, but ONLY for the currently active provider
  // (openai-compat), never for every provider in `available` (which never
  // carries any provider-specific config value beyond id/label/available).
  const baseUrl = provider === "openai-compat" ? config.baseUrl : undefined;
  return { provider, model: config.model, available, models, baseUrl };
}

// --- settings.test (task 3): "Tester la connexion" backend ------------------
//
// A real, minimal model call — a few tokens, not a summarize — bounded by
// SETTINGS_TEST_TIMEOUT_MS so the panel's button can never hang. Runs
// against whichever provider id the message names, not necessarily the one
// currently selected: the user can test a provider before switching to it.
export const SETTINGS_TEST_TIMEOUT_MS = 20_000;

// Amendement 2026-09-29: `providerId` is an open string (built-ins + external
// modules, docs/PROTOCOL.md), so these can no longer be exhaustive switches.
// Built-in providers keep their own French wording; anything else — an
// external module — gets a generic message naming the provider's own
// `label`, since the broker has no fixed text for an id it doesn't own.
function settingsTestSuccessMessage(providerId: ProviderId, lang: Lang): string {
  switch (providerId) {
    case "claude-api":
      return t("settingsTest.success.claude-api", lang);
    case "ollama":
      return t("settingsTest.success.ollama", lang);
    case "openai-compat":
      return t("settingsTest.success.openai-compat", lang);
    default:
      return t("settingsTest.success.default", lang);
  }
}

/** Names the remedy, in the connection's language — never the raw error text
 * (which is English and provider-internal), per task brief: wrong key, Ollama
 * not running, expired session. */
function settingsTestFailureMessage(providerId: ProviderId, err: unknown, lang: Lang): string {
  if (
    isAuthRequiredError(err) ||
    isQuotaExceededError(err) ||
    isRateLimitedError(err) ||
    isModelMissingError(err) ||
    isProviderOverloadedError(err)
  ) {
    // Already localised and already names the remedy (e.g. the
    // "auth.apiKeyRejected"/"provider.quotaExceeded"/"provider.rateLimited"/
    // "provider.modelMissing"/"provider.overloaded" message thrown by
    // claude-api/openai-compat with this same lang, or an external module's
    // own text).
    return (err as Error).message;
  }
  if (err instanceof ModelTimeoutError) {
    return t("settingsTest.timeout", lang);
  }
  switch (providerId) {
    case "claude-api":
      return t("settingsTest.failure.claude-api", lang);
    case "ollama":
      return t("settingsTest.failure.ollama", lang);
    case "openai-compat":
      return t("settingsTest.failure.openai-compat", lang);
    default:
      return t("settingsTest.failure.default", lang);
  }
}

/** Maps a provider's TestConnectionResult.code (providers/types.ts) to the
 * localised sentence shown verbatim in settings.test-result.message —
 * reusing the SAME codes/wording as chat/summarize/act's own error messages
 * (auth.apiKeyRejected, provider.quotaExceeded, provider.rateLimited) so the
 * panel names the same remedy everywhere, per docs/PROTOCOL.md "settings.test"
 * (amendement 2026-10-01, goal U2). `model-unavailable` falls back to each
 * provider's own existing settingsTest.failure.* text. `model-missing`
 * (amendement 2026-10-02, goal-j2FJ-kI7: now also raised by claude-api and
 * openai-compat, not just ollama) keeps ollama's own "pull it" wording for
 * ollama and uses the generic "pick another model" text for every other
 * provider. `provider-overloaded` is the same sentence for every provider —
 * no settings action applies. */
function settingsTestFailureMessageForCode(providerId: ProviderId, code: TestConnectionCode | undefined, lang: Lang): string {
  switch (code) {
    case "auth-required":
      return t("auth.apiKeyRejected", lang);
    case "quota-exceeded":
      return t("provider.quotaExceeded", lang);
    case "rate-limited":
      return t("provider.rateLimited", lang);
    case "provider-overloaded":
      return t("provider.overloaded", lang);
    case "model-missing":
      return providerId === "ollama"
        ? t("settingsTest.failure.ollama.modelMissing", lang)
        : t("provider.modelMissing", lang);
    case "model-unavailable":
    default: {
      switch (providerId) {
        case "claude-api":
          return t("settingsTest.failure.claude-api", lang);
        case "ollama":
          return t("settingsTest.failure.ollama", lang);
        case "openai-compat":
          return t("settingsTest.failure.openai-compat", lang);
        default:
          return t("settingsTest.failure.default", lang);
      }
    }
  }
}

export async function testProviderConnection(
  providerId: ProviderId,
  config: CoatiConfig,
  lang: Lang = DEFAULT_LANG,
): Promise<{ ok: boolean; message: string; code?: TestConnectionCode; creditUnchecked?: boolean }> {
  const provider = getProvider(providerId);
  if (!provider) return { ok: false, message: t("testConnection.unknownProvider", lang) };

  if (providerId === "claude-api" && !resolveApiKey(config, providerId)) {
    return { ok: false, message: t("testConnection.noApiKey", lang), code: "auth-required" };
  }
  if (providerId === "ollama" && !config.model) {
    return { ok: false, message: t("testConnection.noOllamaModel", lang), code: "model-unavailable" };
  }
  if (providerId === "openai-compat" && !config.baseUrl) {
    return { ok: false, message: t("testConnection.noBaseUrl", lang), code: "model-unavailable" };
  }
  if (providerId === "openai-compat" && !config.model) {
    return { ok: false, message: t("testConnection.noModel", lang), code: "model-unavailable" };
  }

  const opts: ProviderRuntimeOptions = {
    model: config.model,
    ollamaUrl: config.ollamaUrl,
    apiKey: resolveApiKey(config, providerId),
    baseUrl: config.baseUrl,
    lang,
  };

  // Goal U2 (docs/PROTOCOL.md "settings.test", amendement 2026-10-01): a
  // FREE probe, when the provider offers one — never the billed streamAnswer
  // call below, which is now only a fallback for a provider (necessarily an
  // external module — every built-in implements testConnection) that hasn't
  // been updated to offer a free check of its own.
  if (provider.testConnection) {
    const result = await provider.testConnection({ ...opts, timeoutMs: SETTINGS_TEST_TIMEOUT_MS });
    if (result.ok) {
      return {
        ok: true,
        message: settingsTestSuccessMessage(providerId, lang),
        ...(result.creditUnchecked ? { creditUnchecked: true } : {}),
      };
    }
    return {
      ok: false,
      code: result.code,
      message: settingsTestFailureMessageForCode(providerId, result.code, lang),
    };
  }

  // Internal probe text, discarded (draining only, no chunk reaches the
  // client) — never shown to a human, so it stays English regardless of
  // `lang` (scaffolding, not a message — see messages.ts's own header).
  const built = buildPrompt({ kind: "chat", text: "Reply with exactly one word: ok." }, lang);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), SETTINGS_TEST_TIMEOUT_MS);
  try {
    for await (const _event of provider.streamAnswer(built, {
      ...opts,
      signal: controller.signal,
      timeoutMs: SETTINGS_TEST_TIMEOUT_MS,
    })) {
      // Draining only — a minimal connectivity probe, no chunk reaches the
      // client (the extension only cares about ok/message, see PROTOCOL.md).
    }
    return { ok: true, message: settingsTestSuccessMessage(providerId, lang) };
  } catch (err) {
    return { ok: false, message: settingsTestFailureMessage(providerId, err, lang) };
  } finally {
    clearTimeout(timer);
  }
}
