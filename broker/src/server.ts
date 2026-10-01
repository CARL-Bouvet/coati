// Bun.serve WebSocket entrypoint. Binds to 127.0.0.1 ONLY — never 0.0.0.0, never a
// network interface. Handshake: Origin check, then a `hello` with the pairing
// secret within 3s, else close 4401 with a plain-language reason.

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  DEFAULT_CONFIG,
  defaultDirs,
  loadConfig,
  saveConfig,
  resolveApiKey,
  setApiKey,
  pruneStaleOpenAiCompatKey,
  type Dirs,
  type ProviderId,
  type CoatiConfig,
} from "./config.ts";
import { isHostAllowed, resolvePeerUid } from "./admission.ts";
import {
  brokerProof,
  extensionProof,
  freshNonceHex,
  isHex64,
  keyToHex,
  loadOrCreatePairingSecret,
  deletePairingSecretIfDisabled,
  safeEqualHex,
  writeBrokerKeyFile,
  deleteBrokerKeyFileIfOwned,
  generateBrokerKey,
} from "./broker-key.ts";
import { isNativeHostInvocation, runNativeHost } from "./native-host.ts";
import { hardenDir } from "./fs-atomic.ts";
import { ProviderStatusCache } from "./provider-status.ts";
import {
  MAX_MESSAGE_BYTES,
  parseClientMessage,
  FACTS_MAX,
  FACT_LABEL_MAX,
  FACT_VALUE_MAX,
  ITEMS_MAX,
  ITEM_TITLE_MAX,
  ITEM_PRICE_MAX,
  ITEM_LOCATION_MAX,
  ITEM_DETAIL_MAX,
  type ClientMessage,
  type Context,
  type ProviderStatus,
  type ServerMessage,
  type SettingsSetMessage,
} from "./protocol.ts";
import {
  buildPrompt,
  isAuthRequiredError,
  isQuotaExceededError,
  isRateLimitedError,
  isModelUnavailableError,
  ModelTimeoutError,
  RateLimitedError,
  type BuiltPrompt,
} from "./model.ts";
import { listPrompts, savePrompt, deletePrompt, setPromptSite, withDirLock, type PromptsDirs } from "./prompts.ts";
import { getPrefs, setSitePrefs, moveInPrefs, type PrefsDirs } from "./prefs.ts";
import { getProviders, getProvider, initRegistry } from "./providers/registry.ts";
import type { ModelProvider, ProviderRuntimeOptions, TestConnectionCode } from "./providers/types.ts";
import { t, normalizeLang, DEFAULT_LANG, type Lang } from "./messages.ts";

// Content is truncated to 40 000 chars by the content script (see PROTOCOL.md).
// The broker enforces the same cap server-side as a safety net.
export const MAX_CONTEXT_CHARS = 40_000;

export function contextTooLarge(text: string | undefined): boolean {
  return typeof text === "string" && text.length > MAX_CONTEXT_CHARS;
}

// Amendement 2026-09-25 (types de page) — "Budget de taille" / "Limites côté
// broker". `text` + `facts` + `items` now share the same 40 000-character
// budget, and each of `facts`/`items` has its own count and per-field length
// caps. Checked AFTER protocol.ts's parseContext has already dropped
// malformed-shaped elements ("après avoir écarté les éléments de forme
// invalide") — every count/length here is on data that is at least
// well-formed. On any breach the broker refuses outright — it never
// truncates (a legitimate client already respects every one of these
// bounds; a breach signals a broken client, not something to paper over).
// Returns the exact bound crossed (for the error's `message`, which "nomme
// la borne franchie"), or undefined when the context fits.
export function contextBudgetError(context: Context | undefined): string | undefined {
  if (!context) return undefined;
  const facts = context.facts ?? [];
  const items = context.items ?? [];

  if (facts.length > FACTS_MAX) return `facts exceeds ${FACTS_MAX} entries`;
  if (items.length > ITEMS_MAX) return `items exceeds ${ITEMS_MAX} entries`;

  for (const fact of facts) {
    if (fact.label.length > FACT_LABEL_MAX) return `fact label exceeds ${FACT_LABEL_MAX} characters`;
    if (fact.value.length > FACT_VALUE_MAX) return `fact value exceeds ${FACT_VALUE_MAX} characters`;
  }
  for (const item of items) {
    if (item.title.length > ITEM_TITLE_MAX) return `item title exceeds ${ITEM_TITLE_MAX} characters`;
    if (item.price !== undefined && item.price.length > ITEM_PRICE_MAX) {
      return `item price exceeds ${ITEM_PRICE_MAX} characters`;
    }
    if (item.location !== undefined && item.location.length > ITEM_LOCATION_MAX) {
      return `item location exceeds ${ITEM_LOCATION_MAX} characters`;
    }
    if (item.detail !== undefined && item.detail.length > ITEM_DETAIL_MAX) {
      return `item detail exceeds ${ITEM_DETAIL_MAX} characters`;
    }
  }

  const total =
    (context.text?.length ?? 0) +
    facts.reduce((sum, f) => sum + f.label.length + f.value.length, 0) +
    items.reduce(
      (sum, it) =>
        sum + it.title.length + (it.price?.length ?? 0) + (it.location?.length ?? 0) + (it.detail?.length ?? 0),
      0,
    );
  if (total > MAX_CONTEXT_CHARS) return `context exceeds ${MAX_CONTEXT_CHARS} characters`;

  return undefined;
}

// --- A2: one journal line per request -------------------------------------
//
// Before this, the broker only logged handshake rejections and its own
// listen line — a request that hung (today's incident) or errored left
// nothing in `journalctl --user -u coati-broker` to even start diagnosing
// from. Exactly one line on receipt, one on completion; never page text,
// user content, or the pairing token — these go straight to the systemd
// journal and must stay safe to paste into a bug report as-is.
// L4 (lot7 security review): `id` is entirely client-supplied (protocol.ts
// only requires it to be a non-empty string — see isNonEmptyString) and, once
// authenticated, was logged raw here. Up to 256 KB of newlines/ANSI escapes
// in it could forge journal lines (including these very grant/reject-shaped
// ones). Every client-supplied value in these two lines goes through
// sanitizeLogValue(), same as Host/Origin elsewhere in this file.
// Amendement 2026-09-25 (types de page) — "Limites côté broker": "la ligne de
// réception ... peut porter pageKind validé et les nombres de faits et
// d'entrées ; jamais un libellé, une valeur, un titre ni aucun autre contenu
// de page." pageKind/factsCount/itemsCount are optional so chat/act (which
// carry no pageKind) keep their existing "-"/0/0 shape.
export function logRequestReceived(
  type: string,
  id: string,
  contextKind: string | undefined,
  textLength: number,
  pageKind?: string,
  factsCount = 0,
  itemsCount = 0,
): void {
  console.log(
    `coati-broker: request received type=${type} id=${sanitizeLogValue(id)} context=${contextKind ?? "-"} textLength=${textLength} pageKind=${pageKind ?? "-"} facts=${factsCount} items=${itemsCount}`,
  );
}

// `reason` (2026-09-26 amendment, docs/PROTOCOL.md): the technical detail
// behind an error outcome — a provider's own captured explanation, when it
// has one, else whatever the thrown Error's message says. Optional and
// omitted for non-error outcomes
// (ok/cancelled) — there is nothing to explain. Goes through the same
// sanitizeLogValue() as every other client- or provider-sourced value logged
// here: control chars stripped, cut to 200 chars, never raw.
export function logRequestCompleted(id: string, outcome: string, elapsedMs: number, reason?: string): void {
  const reasonPart = reason ? ` reason="${sanitizeLogValue(reason)}"` : "";
  console.log(
    `coati-broker: request completed id=${sanitizeLogValue(id)} outcome=${outcome} elapsedMs=${elapsedMs}${reasonPart}`,
  );
}

// --- A1: systemd unit drift detection -------------------------------------
//
// Past incident: the installed unit (~/.config/systemd/user/coati-broker.service)
// had drifted from packaging/coati-broker.service in the repo — it lost an
// `Environment=` line a provider depended on — and requests failed for a
// reason nothing surfaced. Diagnosis cost an hour. This can't prevent a
// drifted unit from being *used* (systemd already launched the process by
// the time this runs), but it can name the problem loudly instead of the
// broker failing every request with no clue why.

/** Pure: true when the installed unit's content differs from the repo's. A
 * byte-for-byte compare is deliberate — the goal is catching "someone
 * hand-edited or forgot to re-copy the unit", not semantic diffing. */
export function unitFileDrifted(installedContent: string, repoContent: string): boolean {
  return installedContent !== repoContent;
}

/**
 * Startup-only, best-effort warning. Never throws, never blocks startup:
 *  - Skipped silently when not started by systemd — a bare `bun run
 *    src/server.ts` from a terminal has no INVOCATION_ID (see systemd.exec(5))
 *    and no installed unit to compare against.
 *  - Skipped silently when either file can't be read — a stripped-down
 *    deployment without a `packaging/` directory, or a permissions quirk,
 *    must never turn into a startup failure over a diagnostic nicety.
 */
export function checkUnitDriftAtStartup(
  paths: { installedUnitPath: string; repoUnitPath: string },
  env: NodeJS.ProcessEnv = process.env,
): void {
  if (!env.INVOCATION_ID) return;
  let installed: string;
  let repo: string;
  try {
    installed = readFileSync(paths.installedUnitPath, "utf8");
    repo = readFileSync(paths.repoUnitPath, "utf8");
  } catch {
    return;
  }
  if (unitFileDrifted(installed, repo)) {
    console.warn(
      `coati-broker: attention — l'unité systemd installée (${paths.installedUnitPath}) diffère de ` +
        `${paths.repoUnitPath} dans le dépôt. Une ligne d'environnement a pu disparaître ` +
        `silencieusement : relancez "bash scripts/install-service.sh" pour la remettre à jour.`,
    );
  }
}

/** Pure: Origin header must exactly match chrome-extension://<one of allowedExtensionIds>. */
export function checkOrigin(origin: string | null | undefined, allowedExtensionIds: string[]): boolean {
  if (!origin) return false;
  return allowedExtensionIds.some((id) => origin === `chrome-extension://${id}`);
}

// Firefox's own extension origin scheme. The uuid is a standard RFC 4122
// v4-shaped string; Firefox assigns it randomly per install, so — unlike
// Chrome's "key"-derived id — it cannot be part of allowedExtensionIds ahead
// of time. Amendement 2026-09-30 (G4): no pinning anymore — ANY well-formed
// uuid passes this step, because the v: 2 handshake's key (not the origin)
// is what actually authenticates (docs/PROTOCOL.md "Poignée de main `v: 2`").
const MOZ_EXTENSION_ORIGIN_RE = /^moz-extension:\/\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i;

/** Pure: extracts the uuid out of a moz-extension://<uuid> origin, or null if
 * `origin` isn't one. Only used to validate the origin is WELL-FORMED — its
 * value plays no further role (no pinning since amendement 2026-09-30). */
export function parseMozExtensionOrigin(origin: string | null | undefined): string | null {
  if (!origin) return null;
  const match = MOZ_EXTENSION_ORIGIN_RE.exec(origin);
  return match ? match[1].toLowerCase() : null;
}

/** Pure: true iff `origin` is a chrome-extension:// origin on the allowlist,
 * or a well-formed moz-extension://<uuid> origin (any uuid) — docs/PROTOCOL.md
 * "Poignée de main `v: 2`", step 1. Never accepts anything else; this step
 * only ever stops web pages, the key (not the origin) does the rest. */
export function isOriginAllowed(origin: string | null | undefined, allowedExtensionIds: string[]): boolean {
  if (checkOrigin(origin, allowedExtensionIds)) return true;
  return parseMozExtensionOrigin(origin) !== null;
}

// --- v: 2 handshake state machine ------------------------------------------
//
// docs/PROTOCOL.md "Poignée de main `v: 2`": client hello (nonce + which key)
// -> broker challenge (fresh nonce + its own proof) -> client auth (its
// proof) -> hello-ok. A single 3s deadline covers the whole exchange (armed
// at open(), never reset mid-handshake).

type HandshakeState =
  | { stage: "awaiting-hello" }
  | { stage: "awaiting-auth"; key: Buffer; keyLabel: "native" | "pasted"; cNonce: string; bNonce: string };

interface ConnData {
  origin: string | null;
  authed: boolean;
  active: Map<string, AbortController>;
  helloTimer: ReturnType<typeof setTimeout> | null;
  hs: HandshakeState;
  /** True while this connection counts toward MAX_UNAUTH_CONNECTIONS — set at
   * open(), cleared the moment it authenticates or closes (whichever first),
   * so it is only ever decremented once. */
  countedUnauth: boolean;
  /** Goal G6 (docs/PROTOCOL.md "Langue de la connexion"): normalised from the
   * `hello`'s raw `lang` at handshake time (messages.ts's normalizeLang) —
   * defaults to "en" until a hello sets it, and for the handful of tests that
   * connect without ever sending one. */
  lang: Lang;
}

function send(ws: { send(data: string): unknown }, msg: ServerMessage): void {
  ws.send(JSON.stringify(msg));
}

// Client-controlled values (Host, Origin) are logged sanitized — control
// characters replaced with `?`, cut to 200 chars — see docs/PROTOCOL.md
// "Journalisation" (amendement 2026-09-25).
export function sanitizeLogValue(value: string | null | undefined): string {
  if (value === null || value === undefined) return "(none)";
  // eslint-disable-next-line no-control-regex
  return value.replace(/[\x00-\x1f\x7f]/g, "?").slice(0, 200);
}

// A local process on the machine (not the intended extension) can open a
// WebSocket and probe the handshake. Distinct client-visible messages for
// "wrong Origin" / "wrong secret" / "no hello in time" would let it tell
// those apart — an oracle. Every failure gets this one generic message on the
// wire; the real reason goes to the broker's own stderr only.
const HANDSHAKE_FAILURE_MESSAGE = "unauthorized";

function sendUnauthorizedAndClose(ws: {
  close(code: number, reason: string): unknown;
  send(data: string): unknown;
}): void {
  send(ws, { type: "error", id: "hello", code: "unauthorized", message: HANDSHAKE_FAILURE_MESSAGE });
  ws.close(4401, HANDSHAKE_FAILURE_MESSAGE);
}

/** Origin check failure — `reject stage=origin` (docs/PROTOCOL.md
 * "Journalisation"). */
function rejectOrigin(
  ws: { close(code: number, reason: string): unknown; send(data: string): unknown },
  origin: string | null | undefined,
): void {
  console.error(`coati-broker: reject stage=origin origin=${sanitizeLogValue(origin)}`);
  sendUnauthorizedAndClose(ws);
}

/** Anything past the origin check (bad/missing hello, wrong secret, timeout)
 * — `reject stage=handshake` (docs/PROTOCOL.md "Journalisation"). The precise
 * `reason` only ever reaches the broker's own stderr, never the wire (see
 * HANDSHAKE_FAILURE_MESSAGE above). */
function rejectHandshake(
  ws: { close(code: number, reason: string): unknown; send(data: string): unknown },
  origin: string | null | undefined,
  reason: string,
): void {
  console.error(`coati-broker: reject stage=handshake origin=${sanitizeLogValue(origin)} reason=${reason}`);
  sendUnauthorizedAndClose(ws);
}

// Per-connection cap on simultaneously in-flight model streams. Without it, an
// authenticated client sending N chat/summarize/act messages back to back
// spawns N provider calls with no limit. See docs/PROTOCOL.md "Limites".
export const MAX_CONCURRENT_STREAMS = 3;

async function runStream(
  ws: { send(data: string): unknown },
  active: Map<string, AbortController>,
  id: string,
  built: BuiltPrompt,
  provider: ModelProvider,
  providerOpts: ProviderRuntimeOptions,
  startedAt: number,
): Promise<void> {
  const controller = new AbortController();
  active.set(id, controller);
  try {
    let usage = { inputTokens: 0, outputTokens: 0 };
    for await (const event of provider.streamAnswer(built, { signal: controller.signal, ...providerOpts })) {
      if (controller.signal.aborted) break;
      if (event.kind === "usage") {
        usage = event.usage;
        continue;
      }
      send(ws, { type: "chunk", id, delta: event.text });
    }
    if (controller.signal.aborted) {
      send(ws, { type: "error", id, code: "cancelled", message: "request cancelled" });
      logRequestCompleted(id, "cancelled", Date.now() - startedAt);
    } else {
      send(ws, { type: "done", id, usage });
      logRequestCompleted(id, "ok", Date.now() - startedAt);
    }
  } catch (err) {
    if (controller.signal.aborted) {
      send(ws, { type: "error", id, code: "cancelled", message: "request cancelled" });
      logRequestCompleted(id, "cancelled", Date.now() - startedAt);
    } else {
      const message = err instanceof Error ? err.message : String(err);
      const code = isAuthRequiredError(err)
        ? "auth-required"
        : isQuotaExceededError(err)
          ? "quota-exceeded"
          : isRateLimitedError(err)
            ? "rate-limited"
            : isModelUnavailableError(err)
              ? "model-unavailable"
              : "internal";
      const retryAfterSec = err instanceof RateLimitedError ? err.retryAfterSec : undefined;
      send(ws, { type: "error", id, code, message, ...(retryAfterSec !== undefined ? { retryAfterSec } : {}) });
      const outcome = err instanceof ModelTimeoutError ? "timeout" : `error:${code}`;
      logRequestCompleted(id, outcome, Date.now() - startedAt, message);
    }
  } finally {
    active.delete(id);
  }
}

/** Probes every known provider's isAvailable() and, for the currently active
 * one, its listModels() (when it has one) — the full payload of a `settings`
 * reply. A provider that errors while probing is reported unavailable rather
 * than crashing the whole response; never hidden (see docs/PROTOCOL.md). */
async function buildSettingsPayload(config: CoatiConfig, lang: Lang): Promise<{
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
  if (isAuthRequiredError(err) || isQuotaExceededError(err) || isRateLimitedError(err)) {
    // Already localised and already names the remedy (e.g. the
    // "auth.apiKeyRejected"/"provider.quotaExceeded"/"provider.rateLimited"
    // message thrown by claude-api/openai-compat with this same lang, or an
    // external module's own text).
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
 * (amendement 2026-10-01, goal U2). `model-unavailable` and `model-missing`
 * fall back to each provider's own existing settingsTest.failure.* text
 * (model-missing only ever comes from ollama in practice). */
function settingsTestFailureMessageForCode(providerId: ProviderId, code: TestConnectionCode | undefined, lang: Lang): string {
  switch (code) {
    case "auth-required":
      return t("auth.apiKeyRejected", lang);
    case "quota-exceeded":
      return t("provider.quotaExceeded", lang);
    case "rate-limited":
      return t("provider.rateLimited", lang);
    case "model-missing":
      return t("settingsTest.failure.ollama.modelMissing", lang);
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
): Promise<{ ok: boolean; message: string; code?: TestConnectionCode }> {
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
    if (result.ok) return { ok: true, message: settingsTestSuccessMessage(providerId, lang) };
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

/** Bundles what handleMessage needs beyond the message itself: the provider
 * currently selected (for chat/summarize/act) and read/write access to the
 * live config (for settings.get/settings.set). Config is process-wide per
 * server instance — one broker serves one user — so `set` mutates the
 * closure in startServer() directly. */
interface SettingsCtx {
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
  applySettings(patch: Pick<SettingsSetMessage, "provider" | "model" | "apiKey" | "baseUrl">): CoatiConfig;
  /** `provider.status` for the currently active provider, through the
   * broker-wide ProviderStatusCache (see docs/PROTOCOL.md "Disponibilité du
   * fournisseur"). */
  getProviderStatus(): ReturnType<ProviderStatusCache["get"]>;
}

/** Shared preamble for the three streaming request types (chat/summarize/act):
 * log receipt, reject an oversized payload, reject a full concurrency cap,
 * then hand off to buildPrompt/runStream. Each case only supplies what makes
 * it different — the log fields, which text (if any) to size-check, which
 * context (if any) to budget-check, and how to build its prompt. */
function handleStreamingRequest(
  ws: { send(data: string): unknown },
  message: { id: string },
  active: Map<string, AbortController>,
  settingsCtx: SettingsCtx,
  opts: {
    logType: string;
    logContextKind: string | undefined;
    logTextLength: number;
    logPageKind: string | undefined;
    logFactsCount: number;
    logItemsCount: number;
    tooLargeText?: string;
    budgetContext?: Context;
    build: () => BuiltPrompt;
  },
): void {
  const startedAt = Date.now();
  logRequestReceived(
    opts.logType,
    message.id,
    opts.logContextKind,
    opts.logTextLength,
    opts.logPageKind,
    opts.logFactsCount,
    opts.logItemsCount,
  );
  if (opts.tooLargeText !== undefined && contextTooLarge(opts.tooLargeText)) {
    send(ws, { type: "error", id: message.id, code: "context-too-large", message: "text exceeds 40000 characters" });
    logRequestCompleted(message.id, "error:context-too-large", Date.now() - startedAt);
    return;
  }
  const budgetError = contextBudgetError(opts.budgetContext);
  if (budgetError) {
    send(ws, { type: "error", id: message.id, code: "context-too-large", message: budgetError });
    logRequestCompleted(message.id, "error:context-too-large", Date.now() - startedAt);
    return;
  }
  if (active.size >= MAX_CONCURRENT_STREAMS) {
    send(ws, { type: "error", id: message.id, code: "bad-request", message: `too many concurrent requests (max ${MAX_CONCURRENT_STREAMS} per connection)` });
    logRequestCompleted(message.id, "error:bad-request", Date.now() - startedAt);
    return;
  }
  // Amendement 2026-09-29 (docs/PROTOCOL.md): a configured provider that
  // isn't known (built in or a module loaded successfully) fails the request
  // as model-unavailable, naming the missing id — it is NEVER silently
  // swapped for another provider.
  if (!settingsCtx.provider) {
    const message2 = `configured provider "${settingsCtx.providerId}" is not available (unknown or failed to load)`;
    send(ws, { type: "error", id: message.id, code: "model-unavailable", message: message2 });
    logRequestCompleted(message.id, "error:model-unavailable", Date.now() - startedAt, message2);
    return;
  }
  const built = opts.build();
  void runStream(ws, active, message.id, built, settingsCtx.provider, settingsCtx.providerOpts, startedAt);
}

function handleMessage(
  ws: { send(data: string): unknown },
  message: ClientMessage,
  active: Map<string, AbortController>,
  promptsDirs: PromptsDirs,
  settingsCtx: SettingsCtx,
  lang: Lang,
): void {
  switch (message.type) {
    case "hello":
    case "auth":
      // Duplicate hello/auth after an already-authed handshake: no-op.
      return;
    case "chat": {
      handleStreamingRequest(ws, message, active, settingsCtx, {
        logType: "chat",
        logContextKind: message.context?.kind,
        logTextLength: message.text.length + (message.context?.text?.length ?? 0),
        logPageKind: message.context?.pageKind,
        logFactsCount: message.context?.facts?.length ?? 0,
        logItemsCount: message.context?.items?.length ?? 0,
        tooLargeText: message.text,
        budgetContext: message.context,
        build: () => buildPrompt({ kind: "chat", text: message.text, context: message.context }, lang),
      });
      return;
    }
    case "summarize": {
      handleStreamingRequest(ws, message, active, settingsCtx, {
        logType: "summarize",
        logContextKind: message.context.kind,
        logTextLength: message.context.text?.length ?? 0,
        logPageKind: message.context.pageKind,
        logFactsCount: message.context.facts?.length ?? 0,
        logItemsCount: message.context.items?.length ?? 0,
        budgetContext: message.context,
        build: () => buildPrompt({ kind: "summarize", context: message.context }, lang),
      });
      return;
    }
    case "act": {
      handleStreamingRequest(ws, message, active, settingsCtx, {
        logType: "act",
        logContextKind: undefined,
        logTextLength: message.text.length,
        logPageKind: undefined,
        logFactsCount: 0,
        logItemsCount: 0,
        tooLargeText: message.text,
        build: () =>
          buildPrompt(
            {
              kind: "act",
              action: message.action,
              text: message.text,
              params: message.params,
            },
            lang,
          ),
      });
      return;
    }
    case "prompts.list": {
      send(ws, { type: "prompts", id: message.id, items: listPrompts(promptsDirs) });
      return;
    }
    case "prompts.save": {
      void savePrompt(promptsDirs, message.prompt)
        .then((items) => {
          send(ws, { type: "prompts", id: message.id, items });
        })
        .catch(() => {
          send(ws, { type: "error", id: message.id, code: "bad-request", message: "prompts.save: unknown id" });
        });
      return;
    }
    case "prompts.delete": {
      void deletePrompt(promptsDirs, message.promptId).then((items) => {
        send(ws, { type: "prompts", id: message.id, items });
      });
      return;
    }
    case "prompts.move": {
      const prefsDirs: PrefsDirs = promptsDirs;
      void withDirLock(promptsDirs.dataDir, () => {
        const items = setPromptSite(promptsDirs, message.promptId, message.site);
        const sites = moveInPrefs(prefsDirs, message.promptId, message.site, message.order);
        return { items, sites };
      })
        .then(({ items, sites }) => {
          send(ws, { type: "prompts", id: message.id, items, prefs: { sites } });
        })
        .catch(() => {
          send(ws, { type: "error", id: message.id, code: "bad-request", message: "prompts.move: unknown id" });
        });
      return;
    }
    case "prefs.get": {
      const prefsDirs: PrefsDirs = promptsDirs;
      send(ws, { type: "prefs", id: message.id, sites: getPrefs(prefsDirs) });
      return;
    }
    case "prefs.set": {
      const prefsDirs: PrefsDirs = promptsDirs;
      void setSitePrefs(prefsDirs, message.site, message.prefs).then((sites) => {
        send(ws, { type: "prefs", id: message.id, sites });
      });
      return;
    }
    case "cancel": {
      active.get(message.target)?.abort();
      return;
    }
    case "settings.get": {
      void buildSettingsPayload(settingsCtx.getConfig(), lang).then((payload) => {
        send(ws, { type: "settings", id: message.id, ...payload });
      });
      return;
    }
    case "settings.set": {
      const updated = settingsCtx.applySettings({
        provider: message.provider,
        model: message.model,
        apiKey: message.apiKey,
        baseUrl: message.baseUrl,
      });
      void buildSettingsPayload(updated, lang).then((payload) => {
        send(ws, { type: "settings", id: message.id, ...payload });
      });
      return;
    }
    case "settings.test": {
      void testProviderConnection(message.provider, settingsCtx.getConfig(), lang).then(({ ok, message: resultMessage, code }) => {
        send(ws, { type: "settings.test-result", id: message.id, provider: message.provider, ok, message: resultMessage, code });
      });
      return;
    }
    case "provider.status": {
      void settingsCtx.getProviderStatus().then((result) => {
        send(ws, {
          type: "provider.status-result",
          id: message.id,
          provider: result.provider,
          state: result.state,
          reason: result.reason,
          checkedAt: result.checkedAt,
        });
      });
      return;
    }
  }
}

/**
 * The v: 2 handshake state machine (docs/PROTOCOL.md "Poignée de main
 * `v: 2`", amendement 2026-09-30, G4):
 *
 *   1. client `hello` (nonce cN, which key) — this connection's ONE hello.
 *   2. broker `challenge` (fresh nonce bN, its own proof bP = HMAC(K, cN:bN)).
 *   3. client `auth` (its proof eP = HMAC(K, cN:bN)).
 *   4. broker compares eP in constant time -> `hello-ok`, or the generic
 *      failure (4401).
 *
 * `key` in step 1 selects K: the broker's own native key (default), or — only
 * when `legacyPairing` is on — the permanent secret `S` ("pasted"). A single
 * 3s deadline (armed at open(), see startServer) covers the whole exchange.
 */
function handleHandshakeMessage(
  ws: { close(code: number, reason: string): unknown; send(data: string): unknown; data: ConnData },
  raw: string,
  nativeKey: Buffer,
  getLegacySecret: () => Buffer,
  legacyPairingEnabled: boolean,
  onAuthed: () => void,
): void {
  const origin = ws.data.origin;
  const result = parseClientMessage(raw);

  if (ws.data.hs.stage === "awaiting-hello") {
    if (!result.ok || result.message.type !== "hello") {
      rejectHandshake(ws, origin, "expected hello message");
      return;
    }
    const { nonce: cNonce, key } = result.message;
    // Goal G6: recorded even if this hello later fails (harmless — the
    // connection never authenticates and its lang plays no further role).
    ws.data.lang = normalizeLang(result.message.lang);
    if (!isHex64(cNonce)) {
      rejectHandshake(ws, origin, "malformed client nonce");
      return;
    }
    const keyLabel: "native" | "pasted" = key ?? "native";
    if (keyLabel === "pasted" && !legacyPairingEnabled) {
      rejectHandshake(ws, origin, "legacy-pairing-disabled");
      return;
    }
    const activeKey = keyLabel === "pasted" ? getLegacySecret() : nativeKey;
    const bNonce = freshNonceHex();
    const bProof = brokerProof(activeKey, cNonce, bNonce);
    ws.data.hs = { stage: "awaiting-auth", key: activeKey, keyLabel, cNonce, bNonce };
    send(ws, { type: "challenge", v: 2, nonce: bNonce, proof: bProof });
    return;
  }

  // stage === "awaiting-auth"
  const hs = ws.data.hs;
  if (!result.ok || result.message.type !== "auth") {
    rejectHandshake(ws, origin, "expected auth message");
    return;
  }
  const { proof: eProof } = result.message;
  if (!isHex64(eProof)) {
    rejectHandshake(ws, origin, "malformed extension proof");
    return;
  }
  const expected = extensionProof(hs.key, hs.cNonce, hs.bNonce);
  if (!safeEqualHex(eProof, expected)) {
    rejectHandshake(ws, origin, "invalid extension proof");
    return;
  }
  if (ws.data.helloTimer) {
    clearTimeout(ws.data.helloTimer);
    ws.data.helloTimer = null;
  }
  ws.data.authed = true;
  onAuthed();
  console.error(`coati-broker: grant via=${hs.keyLabel} origin=${sanitizeLogValue(origin)}`);
  send(ws, { type: "hello-ok", v: 2 });
}

/** promptsDirs, widened with an optional configDir so startServer can persist
 * settings.set to config.json. Optional and separate from PromptsDirs (rather
 * than requiring the full config.Dirs shape) so every existing test call site
 * passing a bare `{ dataDir }` keeps compiling — persistence is simply
 * skipped (in-memory only) when configDir is omitted, which is exactly what
 * those tests want since none of them exercise settings.set. */
export interface ServerDirs extends PromptsDirs {
  configDir?: string;
}

// --- Admission (Host allowlist + peer UID) — docs/PROTOCOL.md "Admission
// HTTP et WebSocket" (amendement 2026-09-25). Applied before ANY routing, on
// every HTTP request (/pair, /ws before upgrade, unknown routes included). --

type AdmissionOutcome =
  | { ok: true }
  | { ok: false; stage: "host"; host: string | null }
  | { ok: false; stage: "peer"; peerUid: number | null };

/** Bun-provided IP lookup, narrowed to what admitRequest needs — a thin seam
 * so tests could substitute it, though the integration tests below exercise
 * the real Bun.serve/server.requestIP path directly. */
interface RequestIpSource {
  requestIP(req: Request): { address: string; port: number } | null;
}

function admitRequest(req: Request, server: RequestIpSource, port: number): AdmissionOutcome {
  const host = req.headers.get("host");
  if (!isHostAllowed(host, port)) {
    return { ok: false, stage: "host", host };
  }
  // Peer-UID check: Linux only (docs/PROTOCOL.md "Frontière de menace" — not
  // enforced elsewhere, logged once at startup instead, see startServer).
  if (process.platform === "linux") {
    const ip = server.requestIP(req);
    let uid: number | null = null;
    if (ip) {
      let procNetTcp: string | undefined;
      let procNetTcp6: string | undefined;
      try {
        procNetTcp = readFileSync("/proc/net/tcp", "utf8");
      } catch {
        // Unreadable: treated as "not found" below — fail closed.
      }
      try {
        procNetTcp6 = readFileSync("/proc/net/tcp6", "utf8");
      } catch {
        // ditto
      }
      uid = resolvePeerUid({
        procNetTcp,
        procNetTcp6,
        peerAddress: ip.address,
        peerPort: ip.port,
        serverPort: port,
      });
    }
    if (uid === null || uid !== process.getuid?.()) {
      return { ok: false, stage: "peer", peerUid: uid };
    }
  }
  return { ok: true };
}

function logAdmissionRejection(outcome: Extract<AdmissionOutcome, { ok: false }>): void {
  if (outcome.stage === "host") {
    console.error(`coati-broker: reject stage=host host=${sanitizeLogValue(outcome.host)}`);
  } else {
    const detail = outcome.peerUid === null ? "reason=not-found" : `peerUid=${outcome.peerUid}`;
    console.error(`coati-broker: reject stage=peer ${detail}`);
  }
}

const FORBIDDEN_RESPONSE_HEADERS = { "content-type": "text/plain" };

// docs/PROTOCOL.md "Poignée de main `v: 2`" — "Plafond de connexions non
// authentifiées".
export const MAX_UNAUTH_CONNECTIONS = 16;
// Rate limit for the cap-rejection log line: at most one line per window,
// carrying the count of rejections that happened during it.
const UNAUTH_CAP_LOG_WINDOW_MS = 10_000;

/**
 * `nativeKey` is the broker key for this run (32 bytes, generated by the
 * caller — see main() below — and never written to disk by startServer
 * itself; the caller decides when/whether to persist it, per
 * docs/PROTOCOL.md's "seulement après que l'écoute a réussi"). Legacy mode's
 * permanent secret `S` is loaded lazily, at most once, only if a `"pasted"`
 * hello is actually attempted AND `config.legacyPairing` is on.
 */
export function startServer(config: CoatiConfig, nativeKey: Buffer, dirs: ServerDirs) {
  const promptsDirs: PromptsDirs = { dataDir: dirs.dataDir };
  const legacyPairingEnabled = config.legacyPairing === true;
  // Final security review: a stale pairing-secret from a previous run with
  // legacyPairing:true must not keep sitting on disk once the mode is off —
  // see deletePairingSecretIfDisabled's own comment.
  if (!legacyPairingEnabled) deletePairingSecretIfDisabled({ dataDir: dirs.dataDir });
  let cachedLegacySecret: Buffer | undefined;
  function getLegacySecret(): Buffer {
    if (!cachedLegacySecret) cachedLegacySecret = loadOrCreatePairingSecret({ dataDir: dirs.dataDir });
    return cachedLegacySecret;
  }

  // Config is process-wide for the lifetime of this server instance — one
  // broker serves one user, so there is no per-connection config. Defaults
  // are merged in here (not just in config.ts's loadConfig) so a caller that
  // constructs a CoatiConfig literal directly — every existing test does —
  // doesn't have to know about provider/ollamaUrl to keep working.
  let currentConfig: CoatiConfig = {
    provider: DEFAULT_CONFIG.provider,
    ollamaUrl: DEFAULT_CONFIG.ollamaUrl,
    ...config,
  };

  // Provider-status probe cache is broker-wide (one broker instance serves
  // one user across many connections/panel opens), never per-connection —
  // see docs/PROTOCOL.md "Disponibilité du fournisseur".
  const providerStatusCache = new ProviderStatusCache();

  // Unauthenticated-connection cap state (docs/PROTOCOL.md "Plafond de
  // connexions non authentifiées") — broker-wide, not per-connection.
  let unauthCount = 0;
  let capRejectCount = 0;
  let capRejectTimer: ReturnType<typeof setTimeout> | null = null;
  function logUnauthCapRejection(): void {
    capRejectCount++;
    if (capRejectTimer) return; // already inside a logging window
    console.error(`coati-broker: reject stage=unauth-cap count=${capRejectCount}`);
    capRejectCount = 0;
    capRejectTimer = setTimeout(() => {
      capRejectTimer = null;
      if (capRejectCount > 0) {
        console.error(`coati-broker: reject stage=unauth-cap count=${capRejectCount}`);
        capRejectCount = 0;
      }
    }, UNAUTH_CAP_LOG_WINDOW_MS);
    capRejectTimer.unref?.();
  }

  console.log(
    `coati-broker: peer-uid check: ${
      process.platform === "linux" ? "enforced (linux)" : `NOT enforced on ${process.platform}`
    }`,
  );

  function settingsCtx(lang: Lang): SettingsCtx {
    const cfg = currentConfig;
    const providerId = cfg.provider ?? DEFAULT_CONFIG.provider!;
    const providerOpts: ProviderRuntimeOptions = {
      model: cfg.model,
      ollamaUrl: cfg.ollamaUrl,
      apiKey: resolveApiKey(cfg, providerId),
      baseUrl: cfg.baseUrl,
      lang,
    };
    return {
      providerId,
      // Amendement 2026-09-29: NEVER falls back to another provider when
      // `providerId` is unknown — `undefined` here, handled by
      // handleStreamingRequest, which reports model-unavailable naming the
      // missing id instead of silently answering through a different
      // provider (docs/PROTOCOL.md).
      provider: getProvider(providerId),
      providerOpts,
      getConfig: () => currentConfig,
      applySettings(patch) {
        if (patch.provider !== undefined) currentConfig = { ...currentConfig, provider: patch.provider };
        if (patch.model !== undefined) currentConfig = { ...currentConfig, model: patch.model };
        // Same "" = forget semantics as apiKey — but baseUrl is NOT a secret
        // (amendement 2026-09-30 bis): it still gets dropped from the JSON
        // on "" for the same "leaves no stale trace" reasoning, not because
        // it needs hiding. Applied BEFORE the apiKey patch below (security
        // fix, 2026-09-30 ter): a baseUrl moved to a different origin prunes
        // any openai-compat key stored under the old origin first, so a
        // settings.set carrying both a new baseUrl and a new apiKey binds
        // the key to the NEW origin, never leaves it bound to the old one.
        if (patch.baseUrl !== undefined) {
          currentConfig = { ...currentConfig, baseUrl: patch.baseUrl === "" ? undefined : patch.baseUrl };
          currentConfig = { ...currentConfig, apiKeys: pruneStaleOpenAiCompatKey(currentConfig) };
        }
        // Empty string means "forget the stored key" (task 2) — setApiKey
        // drops it entirely (see config.ts), so a forgotten key leaves no
        // trace on disk either. Bound to whichever provider this same patch
        // selects (patch.provider), or the currently active one otherwise —
        // see config.ts's CoatiConfig.apiKeys doc: a key only ever reaches
        // the service it was entered for.
        if (patch.apiKey !== undefined) {
          const targetProvider = patch.provider ?? currentConfig.provider ?? DEFAULT_CONFIG.provider!;
          currentConfig = { ...currentConfig, apiKeys: setApiKey(currentConfig, targetProvider, patch.apiKey) };
        }
        if (dirs.configDir) saveConfig({ configDir: dirs.configDir }, currentConfig);
        // docs/PROTOCOL.md "Disponibilité du fournisseur": "Un settings.set
        // réussi vide le cache."
        providerStatusCache.clear();
        return currentConfig;
      },
      getProviderStatus: () => providerStatusCache.get(providerId, providerOpts),
    };
  }

  /** Decrements unauthCount exactly once for this connection — called either
   * when it authenticates (frees its cap slot even though the socket stays
   * open) or when it closes without ever authenticating. */
  function releaseUnauthSlot(ws: { data: ConnData }): void {
    if (ws.data.countedUnauth) {
      ws.data.countedUnauth = false;
      unauthCount--;
    }
  }

  return Bun.serve<ConnData, {}>({
    hostname: "127.0.0.1", // NEVER 0.0.0.0 — see CLAUDE.md non-negotiable rule #2.
    port: config.port,
    // docs/PROTOCOL.md "Écoute exclusive du port" (amendement 2026-09-30,
    // G4): explicit even though it's Bun's own default — a second broker
    // trying to bind the same port must fail, never silently share it.
    reusePort: false,
    fetch(req, server) {
      // "le port" always means the port ACTUALLY listened on (server.port),
      // not the requested one — matters for tests (`port: 0`, OS-assigned) —
      // see docs/PROTOCOL.md "Transport": "Toutes les vérifications qui
      // citent « le port »... utilisent le port effectivement écouté."
      const admission = admitRequest(req, server, server.port);
      if (!admission.ok) {
        logAdmissionRejection(admission);
        return new Response("forbidden", { status: 403, headers: FORBIDDEN_RESPONSE_HEADERS });
      }

      const url = new URL(req.url);

      // amendement 2026-09-30 (G4): /pair no longer exists, in any mode —
      // docs/PROTOCOL.md "Mode hérité" / "Règles invariantes, ajouts". Falls
      // through to the generic 404 below like any other unknown route.
      if (url.pathname !== "/ws") {
        return new Response("not found", { status: 404 });
      }

      const origin = req.headers.get("origin");
      const upgraded = server.upgrade(req, {
        data: {
          origin,
          authed: false,
          active: new Map(),
          helloTimer: null,
          hs: { stage: "awaiting-hello" },
          countedUnauth: false,
          lang: DEFAULT_LANG,
        } satisfies ConnData,
      });
      if (!upgraded) {
        return new Response("expected websocket upgrade", { status: 400 });
      }
      return undefined;
    },
    websocket: {
      // Final security review: without an explicit cap, Bun buffers a
      // WebSocket frame of any size in full before this handler ever runs —
      // a multi-hundred-MB frame sent before auth (when there is no other
      // gate yet) would be fully received into memory regardless of what
      // the `message` handler below goes on to check. 4 KiB of slack over
      // MAX_MESSAGE_BYTES (256 KiB, docs/PROTOCOL.md "Limites côté broker")
      // covers the JSON envelope/framing around the largest legitimate
      // prompt payload without meaningfully widening the DoS window.
      maxPayloadLength: MAX_MESSAGE_BYTES + 4096,
      open(ws) {
        // docs/PROTOCOL.md "Plafond de connexions non authentifiées": checked
        // FIRST, before the origin step — a 17th unauthenticated connection
        // is refused immediately, before any message (not even the generic
        // error frame).
        if (unauthCount >= MAX_UNAUTH_CONNECTIONS) {
          logUnauthCapRejection();
          ws.close(4401, "unauthorized");
          return;
        }
        unauthCount++;
        ws.data.countedUnauth = true;

        // A single 3s deadline covers the whole handshake (hello -> challenge
        // -> auth) — docs/PROTOCOL.md "Poignée de main `v: 2`": never reset
        // mid-handshake, only cleared on success or on this timeout firing.
        ws.data.helloTimer = setTimeout(() => {
          rejectHandshake(ws, ws.data.origin, "handshake timeout: no auth within 3s");
        }, 3000);

        if (!isOriginAllowed(ws.data.origin, config.allowedExtensionIds)) {
          rejectOrigin(ws, ws.data.origin);
          return;
        }
      },
      message(ws, raw) {
        // Final security review: the raw frame's byte length is checked
        // BEFORE any UTF-8 decoding or JSON.parse, and before/regardless of
        // auth state — a frame this large gets no CPU/memory spent turning
        // it into a JS string at all. `websocket.maxPayloadLength` below
        // (set to MAX_MESSAGE_BYTES + slack) is the hard backstop at the Bun
        // protocol layer, closing the socket before this handler even runs
        // for anything past that; this check catches the remaining gap
        // between MAX_MESSAGE_BYTES and that slack, pre- or post-auth alike.
        const rawByteLength = typeof raw === "string" ? Buffer.byteLength(raw, "utf8") : raw.byteLength;
        if (rawByteLength > MAX_MESSAGE_BYTES) {
          console.error(`coati-broker: reject stage=oversized origin=${sanitizeLogValue(ws.data.origin)}`);
          if (ws.data.authed) {
            send(ws, {
              type: "error",
              id: "oversized",
              code: "bad-request",
              message: `message exceeds ${MAX_MESSAGE_BYTES} byte cap`,
            });
            ws.close(1009, "oversized");
          } else {
            // Pre-auth: no `error` frame — same as every other handshake
            // rejection (docs/PROTOCOL.md "Journalisation"/rejectHandshake).
            rejectHandshake(ws, ws.data.origin, "oversized message before auth");
          }
          return;
        }
        const text = typeof raw === "string" ? raw : Buffer.from(raw).toString("utf8");
        if (!ws.data.authed) {
          handleHandshakeMessage(ws, text, nativeKey, getLegacySecret, legacyPairingEnabled, () => releaseUnauthSlot(ws));
          return;
        }
        const result = parseClientMessage(text);
        if (!result.ok) {
          if (result.error.id) {
            send(ws, { type: "error", id: result.error.id, code: result.error.code, message: result.error.message });
          }
          return;
        }
        handleMessage(ws, result.message, ws.data.active, promptsDirs, settingsCtx(ws.data.lang), ws.data.lang);
      },
      close(ws) {
        if (ws.data.helloTimer) clearTimeout(ws.data.helloTimer);
        releaseUnauthSlot(ws);
        for (const controller of ws.data.active.values()) controller.abort();
        ws.data.active.clear();
      },
    },
  });
}

if (import.meta.main) {
  // docs/PROTOCOL.md "Hôte natif : lancement et détection": the switch to
  // host mode happens BEFORE ANYTHING ELSE this file's own top-level code
  // does — no port opened, no config read, no dynamic module ever loaded
  // (fixed comment, final security review: this file's own static imports
  // above are already evaluated by this point, ES modules being loaded
  // before any module-level code runs — but none of them writes to stdout,
  // so nothing beyond the host's own single reply frame ever does either).
  // process.argv (not just argv.slice(2)) is scanned: Chrome and Firefox
  // both only ever append their own arguments, which can't collide with the
  // runtime/script path entries ahead of them.
  if (isNativeHostInvocation(process.argv)) {
    const dirs: Dirs = defaultDirs();
    const code = await runNativeHost(process.argv, dirs);
    process.exit(code);
  }

  // docs/PROTOCOL.md "Mode hérité": the only way to read the permanent
  // secret `S` — prints it and exits, never opens a port. Refuses (and
  // creates nothing) when legacyPairing is off.
  if (process.argv.includes("--show-pairing-secret")) {
    const dirs: Dirs = defaultDirs();
    const config = loadConfig(dirs);
    if (config.legacyPairing !== true) {
      console.error(
        "coati-broker: --show-pairing-secret refusé — legacyPairing est éteint dans config.json " +
          '(voir docs/PROTOCOL.md « Mode hérité »).',
      );
      process.exit(1);
    }
    const secret = loadOrCreatePairingSecret({ dataDir: dirs.dataDir });
    console.log(keyToHex(secret));
    process.exit(0);
  }

  // --check-modules: a no-network, no-listen smoke test proving a compiled
  // (`bun build --compile`) binary can still dynamic-`import()` an external
  // provider module from an absolute path named in config.json's `modules`
  // (docs/MODULES.md) — the whole point of the registry staying a plain
  // `import()` rather than something bundle-time. Prints one line per
  // registered provider id and exits 0, or exits 1 if any configured module
  // failed to load (initRegistry's warnings).
  if (process.argv.includes("--check-modules")) {
    const dirs: Dirs = defaultDirs();
    const config = loadConfig(dirs);
    // initRegistry already logs each warning (via its host's logger) — no
    // need to print them again here.
    const { warnings } = await initRegistry(config.modules ?? []);
    for (const p of getProviders()) console.log(p.id);
    process.exit(warnings.length > 0 ? 1 : 0);
  }

  // A1: warn (never block) if the unit we were launched from has drifted
  // from the repo's packaging/coati-broker.service — see
  // checkUnitDriftAtStartup's doc for exactly what today's incident was.
  checkUnitDriftAtStartup({
    installedUnitPath: join(homedir(), ".config", "systemd", "user", "coati-broker.service"),
    repoUnitPath: join(dirname(fileURLToPath(import.meta.url)), "..", "..", "packaging", "coati-broker.service"),
  });
  const dirs: Dirs = defaultDirs();
  // docs/PROTOCOL.md "Durcissement du dossier de données": checked at start,
  // before startServer opens the port and before any prompts/prefs I/O can
  // touch dataDir — not deferred to the first broker-key.json/pairing-secret
  // write, which could otherwise happen after the port is already accepting
  // connections.
  hardenDir(dirs.dataDir);
  const config = loadConfig(dirs);
  console.log(`coati-broker: legacy pairing: ${config.legacyPairing ? "ON (secret permanent, --show-pairing-secret)" : "off"}`);
  // COATI_PORT is for tests only (a free port for a test server) — the
  // extension only ever knows 8787, see config.ts's FIXED_PORT and
  // docs/PROTOCOL.md "Transport".
  if (process.env.COATI_PORT) {
    console.log(`coati-broker: COATI_PORT=${process.env.COATI_PORT} — mode test, l'extension ne se connectera pas`);
  }
  const port = Number(process.env.COATI_PORT) || config.port;
  const nativeKey = generateBrokerKey();
  // Amendement 2026-09-29 (docs/PROTOCOL.md "Modules externes"): load
  // config.json's `modules` BEFORE serving anything — a broken module is
  // logged (by initRegistry itself) and skipped, never fatal (CLAUDE.md
  // security rule #3).
  await initRegistry(config.modules ?? []);
  const server = startServer({ ...config, port }, nativeKey, {
    dataDir: dirs.dataDir,
    configDir: dirs.configDir,
  });
  // docs/PROTOCOL.md "Clé de broker": written only AFTER a successful listen
  // (startServer above throws synchronously on bind failure, so reaching
  // this line means it succeeded), and never when COATI_PORT is set without
  // COATI_DATA_DIR — a test broker must never clobber the real one's key.
  const shouldWriteKeyFile = !(process.env.COATI_PORT && !process.env.COATI_DATA_DIR);
  const startedAt = new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
  if (shouldWriteKeyFile) {
    writeBrokerKeyFile({ dataDir: dirs.dataDir }, nativeKey, process.pid, startedAt);
    console.log("coati-broker: broker key: written");
  } else {
    console.log("coati-broker: broker key: not written (COATI_PORT sans COATI_DATA_DIR)");
  }
  const shutdown = () => {
    if (shouldWriteKeyFile) deleteBrokerKeyFileIfOwned({ dataDir: dirs.dataDir }, process.pid);
    process.exit(0);
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
  console.log(`coati-broker listening on ws://127.0.0.1:${server.port}/ws`);
}
