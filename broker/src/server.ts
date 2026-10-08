// Bun.serve WebSocket entrypoint. Binds to 127.0.0.1 ONLY — never 0.0.0.0, never a
// network interface. Handshake: Origin check, then a `hello` with the pairing
// secret within 3s, else close 4401 with a plain-language reason.

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  DEFAULT_CONFIG,
  DEFAULT_OLLAMA_URL,
  defaultDirs,
  loadConfig,
  saveConfig,
  resolveApiKey,
  setApiKey,
  pruneStaleOpenAiCompatKey,
  resolveSearchApiKey,
  setSearchApiKey,
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
  MAX_IMAGE_MESSAGE_BYTES,
  parseClientMessage,
  FACTS_MAX,
  FACT_LABEL_MAX,
  FACT_VALUE_MAX,
  ITEMS_MAX,
  ITEM_TITLE_MAX,
  ITEM_PRICE_MAX,
  ITEM_LOCATION_MAX,
  ITEM_DETAIL_MAX,
  ELEMENTS_MAX,
  ELEMENT_LABEL_MAX,
  type ClientMessage,
  type ChatImage,
  type Context,
  type HistoryEntry,
  type ModelEntry,
  type ModelSource,
  type ProviderStatus,
  type ServerMessage,
  type SettingsSetMessage,
} from "./protocol.ts";
import {
  buildPrompt,
  isAuthRequiredError,
  isQuotaExceededError,
  isRateLimitedError,
  isModelMissingError,
  isProviderOverloadedError,
  isModelUnavailableError,
  isModelStalledError,
  isVisionUnsupportedError,
  ModelTimeoutError,
  RateLimitedError,
  type BuiltPrompt,
} from "./model.ts";
import { listPrompts, savePrompt, deletePrompt, setPromptSite, withDirLock, type PromptsDirs } from "./prompts.ts";
import { getPrefs, setSitePrefs, moveInPrefs, type PrefsDirs } from "./prefs.ts";
import { getProviders, getProvider, initRegistry } from "./providers/registry.ts";
import { fetchOpenAiCompatVisionMap } from "./providers/openai-compat.ts";
import {
  listModelEntries as listOllamaModelEntries,
  fetchPsEntries,
  matchesModel,
  warmupModel,
} from "./providers/ollama.ts";
import { readHostCapacity, computeFit, FIT_CONSTANTS as _FIT_CONSTANTS } from "./host.ts";
import type { HostCapacity } from "./protocol.ts";
import type { ModelProvider, ProviderRuntimeOptions, TestConnectionCode } from "./providers/types.ts";
import { t, normalizeLang, DEFAULT_LANG, type Lang } from "./messages.ts";
import {
  runDocSearch,
  isSearchNotConfiguredError,
  isSearchUnavailableError,
  type DocSearchStatusEvent,
} from "./search/doc-search.ts";
import { braveTestConnection } from "./search/brave.ts";
import { tavilyTestConnection } from "./search/tavily.ts";
import { isSearchProviderId, type SearchProviderId } from "./search/types.ts";
import { detectSearchIntent } from "./search/intent.ts";
import { reformulateSearchQuery } from "./search/reformulate.ts";
import { registrableDomain } from "./search/discover.ts";

// Content is truncated to 40 000 chars by the content script (see PROTOCOL.md).
// The broker enforces the same cap server-side as a safety net.
export const MAX_CONTEXT_CHARS = 40_000;

// Amendement 2026-10-08 (lot 0/A1/B1/C1): open-ended wire capabilities this
// broker build understands — docs/PROTOCOL.md "Amendement 2026-10-08" §1.
// "elements" (context.elements, lot A1), "vision" (chat.image, lot B1) and
// "docsearch" (chat.docSearch, lot C1) are all unconditional — this build
// always implements the WIRE capability regardless of the active
// model/provider or of whether a search key is actually configured yet
// (whether a GIVEN model sees, or search is actually usable right now, are
// separate questions — see ModelEntry.vision/supportsVision and the
// search-not-configured error code respectively).
export const BROKER_FEATURES: string[] = ["elements", "vision", "docsearch", "history"];

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
  // Amendement 2026-10-08 (lot A1, "Montrer du doigt" — docs/PROTOCOL.md §2).
  const elements = context.elements ?? [];

  if (facts.length > FACTS_MAX) return `facts exceeds ${FACTS_MAX} entries`;
  if (items.length > ITEMS_MAX) return `items exceeds ${ITEMS_MAX} entries`;
  if (elements.length > ELEMENTS_MAX) return `elements exceeds ${ELEMENTS_MAX} entries`;

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
  for (const el of elements) {
    if (el.label.length > ELEMENT_LABEL_MAX) return `element label exceeds ${ELEMENT_LABEL_MAX} characters`;
  }

  const total =
    (context.text?.length ?? 0) +
    facts.reduce((sum, f) => sum + f.label.length + f.value.length, 0) +
    items.reduce(
      (sum, it) =>
        sum + it.title.length + (it.price?.length ?? 0) + (it.location?.length ?? 0) + (it.detail?.length ?? 0),
      0,
    ) +
    elements.reduce((sum, el) => sum + el.ref.length + el.role.length + el.label.length, 0);
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
  // Amendement 2026-10-08 (lot B1, docs/PROTOCOL.md §3): "Jamais journalisée
  // (seulement `image: true` + octets)" — a boolean presence flag only,
  // never mediaType/data/dimensions.
  hasImage = false,
): void {
  console.log(
    `coati-broker: request received type=${type} id=${sanitizeLogValue(id)} context=${contextKind ?? "-"} textLength=${textLength} pageKind=${pageKind ?? "-"} facts=${factsCount} items=${itemsCount} image=${hasImage}`,
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
  /** Amendement 2026-10-08 (lot C1, docs/PROTOCOL.md §C "Sécurité", R5):
   * "une seule recherche en cours par connexion" — set true for the
   * lifetime of one `chat.docSearch` request, checked (and rejected with
   * bad-request) by a second one arriving before the first finishes. Never
   * reset on error paths other than the request's own completion — see
   * handleChatDocSearch's try/finally. */
  docSearching: boolean;
  /** Security review (L9): true from the `close` handler onward — checked
   * by handleChatDocSearch before it ever calls `send()` or starts
   * `runStream()` after its (potentially long) search phase, so a
   * connection that closed mid-search never gets written to, and never
   * starts a model stream nobody is listening to anymore. */
  closed: boolean;
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

  // Amendement 2026-10-07 (bis): progress notifications (Ollama only).
  // Check /api/ps before the stream starts, emit loading/reading, then poll
  // every 1 s until the model appears in /api/ps or the first chunk arrives.
  let firstChunkSent = false;
  let progressPollingDone = false;
  // Amendement 2026-10-07 (bis): thinking stage — sent at most once, before
  // any content, when the provider emits a thinking event (thinking-only model).
  let thinkingProgressSent = false;

  if (provider.id === "ollama") {
    const ollamaUrl = providerOpts.ollamaUrl ?? DEFAULT_OLLAMA_URL;
    const model = providerOpts.model ?? "";
    const psEntries = await fetchPsEntries({ ollamaUrl, signal: controller.signal }).catch(() => [] as Awaited<ReturnType<typeof fetchPsEntries>>);
    if (!controller.signal.aborted) {
      const alreadyLoaded = psEntries.some((e) => matchesModel(e.name, model));
      send(ws, { type: "progress", id, stage: alreadyLoaded ? "reading" : "loading" });
      if (alreadyLoaded) {
        progressPollingDone = true;
      } else {
        // Poll /api/ps every 1 s in background; stop when model appears or stream ends.
        void (async () => {
          while (!progressPollingDone && !firstChunkSent) {
            await new Promise<void>((r) => setTimeout(r, 1000));
            if (progressPollingDone || firstChunkSent) break;
            const ps = await fetchPsEntries({ ollamaUrl, signal: controller.signal }).catch(() => [] as Awaited<ReturnType<typeof fetchPsEntries>>);
            if (ps.some((e) => matchesModel(e.name, model))) {
              if (!firstChunkSent) send(ws, { type: "progress", id, stage: "reading" });
              progressPollingDone = true;
              break;
            }
          }
        })();
      }
    }
  }

  try {
    let usage = { inputTokens: 0, outputTokens: 0 };
    // Amendement 2026-10-08 (bis, "historique"): forwarded verbatim as
    // DoneMessage.historyKept below — undefined stays undefined (no
    // `history` on this request), never coerced to 0.
    let historyKept: number | undefined;
    for await (const event of provider.streamAnswer(built, { signal: controller.signal, ...providerOpts })) {
      if (controller.signal.aborted) break;
      if (event.kind === "usage") {
        usage = event.usage;
        historyKept = event.historyKept;
        continue;
      }
      // Amendement 2026-10-07 (bis): thinking event — emit progress:thinking
      // once (before any content chunk), never forward as text.
      if (event.kind === "thinking") {
        if (!thinkingProgressSent && !firstChunkSent) {
          thinkingProgressSent = true;
          send(ws, { type: "progress", id, stage: "thinking" });
        }
        continue;
      }
      if (!firstChunkSent) {
        firstChunkSent = true;
        progressPollingDone = true; // stop progress polling
      }
      send(ws, { type: "chunk", id, delta: event.text });
    }
    if (controller.signal.aborted) {
      send(ws, { type: "error", id, code: "cancelled", message: "request cancelled" });
      logRequestCompleted(id, "cancelled", Date.now() - startedAt);
    } else {
      send(ws, { type: "done", id, usage, ...(historyKept !== undefined ? { historyKept } : {}) });
      logRequestCompleted(id, "ok", Date.now() - startedAt);
    }
  } catch (err) {
    progressPollingDone = true;
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
            : isModelMissingError(err)
              ? "model-missing"
              : isProviderOverloadedError(err)
                ? "provider-overloaded"
                : isModelStalledError(err)
                  ? "model-stalled"
                  // Amendement 2026-10-08 (lot B1): checked ahead of the
                  // generic model-unavailable heuristic, same rank as the
                  // other typed errors above — docs/PROTOCOL.md §4.
                  : isVisionUnsupportedError(err)
                    ? "vision-unsupported"
                    : isModelUnavailableError(err)
                      ? "model-unavailable"
                      : "internal";
      const retryAfterSec = err instanceof RateLimitedError ? err.retryAfterSec : undefined;
      send(ws, { type: "error", id, code, message, ...(retryAfterSec !== undefined ? { retryAfterSec } : {}) });
      const outcome = err instanceof ModelTimeoutError
        ? "timeout"
        : isModelStalledError(err)
          ? "stalled"
          : `error:${code}`;
      logRequestCompleted(id, outcome, Date.now() - startedAt, message);
    }
  } finally {
    progressPollingDone = true;
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
  search: { provider: SearchProviderId | null; configured: boolean };
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
  // Amendement 2026-10-08 (lot C1, docs/PROTOCOL.md §9): same `configured`
  // semantics as every other provider — a key is present, never the key
  // itself (CLAUDE.md rule #1).
  const search = {
    provider: config.searchProvider ?? null,
    configured: config.searchProvider ? !!resolveSearchApiKey(config, config.searchProvider) : false,
  };
  return { provider, model: config.model, available, models, baseUrl, search };
}

// --- models.list (amendement 2026-10-07) -------------------------------------
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

async function buildModelsPayload(config: CoatiConfig): Promise<{
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

/** Amendement 2026-10-08 (lot C1, docs/PROTOCOL.md §9) — `settings.test`'s
 * `target: "search"` branch: a FREE-in-spirit probe (spends one real search
 * call — neither Brave nor Tavily offers a true free key check, see
 * search/brave.ts's own comment) against whichever engine `searchProvider`
 * names, using whichever key is CURRENTLY stored for it (never a key the
 * message itself might carry — settings.test never carries one, by design,
 * same as the model-provider branch). */
export async function testSearchConnection(
  searchProvider: SearchProviderId,
  config: CoatiConfig,
  lang: Lang = DEFAULT_LANG,
): Promise<{ ok: boolean; message: string; code?: TestConnectionCode }> {
  const apiKey = resolveSearchApiKey(config, searchProvider);
  if (!apiKey) {
    return { ok: false, message: t("testConnection.noSearchApiKey", lang), code: "auth-required" };
  }
  const result =
    searchProvider === "brave" ? await braveTestConnection(apiKey) : await tavilyTestConnection(apiKey);
  if (result.ok) {
    return { ok: true, message: t(`settingsTest.success.search.${searchProvider}`, lang) };
  }
  const code: TestConnectionCode =
    result.reason === "auth"
      ? "auth-required"
      : result.reason === "quota"
        ? "quota-exceeded"
        : result.reason === "rate"
          ? "rate-limited"
          : "model-unavailable";
  const message =
    result.reason === "auth"
      ? t("auth.apiKeyRejected", lang)
      : result.reason === "quota"
        ? t("provider.quotaExceeded", lang)
        : result.reason === "rate"
          ? t("provider.rateLimited", lang)
          : t(`settingsTest.failure.search.${searchProvider}`, lang);
  return { ok: false, message, code };
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
  applySettings(
    patch: Pick<
      SettingsSetMessage,
      "provider" | "model" | "apiKey" | "baseUrl" | "searchProvider" | "searchApiKey" | "clearKey"
    >,
  ): CoatiConfig;
  /** `provider.status` for the currently active provider, through the
   * broker-wide ProviderStatusCache (see docs/PROTOCOL.md "Disponibilité du
   * fournisseur"). */
  getProviderStatus(): ReturnType<ProviderStatusCache["get"]>;
}

/**
 * Amendement 2026-10-08 (lot B1, docs/PROTOCOL.md §4): resolves whether
 * `provider` can see an attached image RIGHT NOW, with `opts` (the active
 * model). Prefers the live, per-model `supportsVision` probe (ollama,
 * openai-compat); falls back to the provider's static `vision` field
 * (claude-api, claude-cli, an external module that declared one); a
 * provider with NEITHER (a module that declared nothing) fails closed —
 * `false`, never `undefined` — per docs/MODULES.md's documented safe
 * default. Never throws: a `supportsVision` rejection is treated as
 * "unknown", not as a hard false (a transient probe failure shouldn't block
 * a request a model may well be able to answer).
 */
async function resolveVisionSupport(
  provider: ModelProvider,
  opts: ProviderRuntimeOptions,
): Promise<boolean | undefined> {
  if (provider.supportsVision) {
    try {
      return await provider.supportsVision(opts);
    } catch {
      return undefined;
    }
  }
  if (provider.vision !== undefined) return provider.vision;
  return false;
}

/** Shared SYNCHRONOUS preamble for every streaming request type
 * (chat/summarize/act, including a `chat.docSearch`): log receipt, reject an
 * oversized payload, reject a full concurrency cap, reject an unknown
 * configured provider. Returns the resolved provider/opts/startedAt on
 * success, or `undefined` once it has already sent an error and logged the
 * outcome itself (caller just returns in that case — amendement 2026-10-08
 * lot C1 split this out of the old handleStreamingRequest so a
 * `chat.docSearch` request can run its own async steps, unlike
 * summarize/act, between this gate and buildPrompt/runStream). */
function gateStreamingRequest(
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
    hasImage: boolean;
    tooLargeText?: string;
    budgetContext?: Context;
  },
): { provider: ModelProvider; providerOpts: ProviderRuntimeOptions; startedAt: number } | undefined {
  const startedAt = Date.now();
  logRequestReceived(
    opts.logType,
    message.id,
    opts.logContextKind,
    opts.logTextLength,
    opts.logPageKind,
    opts.logFactsCount,
    opts.logItemsCount,
    opts.hasImage,
  );
  if (opts.tooLargeText !== undefined && contextTooLarge(opts.tooLargeText)) {
    send(ws, { type: "error", id: message.id, code: "context-too-large", message: "text exceeds 40000 characters" });
    logRequestCompleted(message.id, "error:context-too-large", Date.now() - startedAt);
    return undefined;
  }
  const budgetError = contextBudgetError(opts.budgetContext);
  if (budgetError) {
    send(ws, { type: "error", id: message.id, code: "context-too-large", message: budgetError });
    logRequestCompleted(message.id, "error:context-too-large", Date.now() - startedAt);
    return undefined;
  }
  if (active.size >= MAX_CONCURRENT_STREAMS) {
    send(ws, { type: "error", id: message.id, code: "bad-request", message: `too many concurrent requests (max ${MAX_CONCURRENT_STREAMS} per connection)` });
    logRequestCompleted(message.id, "error:bad-request", Date.now() - startedAt);
    return undefined;
  }
  // Amendement 2026-09-29 (docs/PROTOCOL.md): a configured provider that
  // isn't known (built in or a module loaded successfully) fails the request
  // as model-unavailable, naming the missing id — it is NEVER silently
  // swapped for another provider.
  if (!settingsCtx.provider) {
    const message2 = `configured provider "${settingsCtx.providerId}" is not available (unknown or failed to load)`;
    send(ws, { type: "error", id: message.id, code: "model-unavailable", message: message2 });
    logRequestCompleted(message.id, "error:model-unavailable", Date.now() - startedAt, message2);
    return undefined;
  }
  return { provider: settingsCtx.provider, providerOpts: settingsCtx.providerOpts, startedAt };
}

/** Amendement 2026-10-08 (lot B1): gates a request carrying `image` on
 * vision support BEFORE calling the provider (docs/PROTOCOL.md §4). Returns
 * true when the request should proceed (vision known-true, or unknown —
 * left to the provider's own 400), false once it has already sent
 * vision-unsupported and logged the outcome. */
async function gateVisionSupport(
  ws: { send(data: string): unknown },
  message: { id: string },
  provider: ModelProvider,
  providerOpts: ProviderRuntimeOptions,
  startedAt: number,
): Promise<boolean> {
  const vision = await resolveVisionSupport(provider, providerOpts);
  if (vision === false) {
    const message2 = `active model (provider "${provider.id}") does not support image input`;
    send(ws, { type: "error", id: message.id, code: "vision-unsupported", message: message2 });
    logRequestCompleted(message.id, "error:vision-unsupported", Date.now() - startedAt, message2);
    return false;
  }
  return true;
}

/** Shared preamble for the two SYNCHRONOUS-build streaming request types
 * (summarize/act, and a `chat` with no `docSearch`): gate, then optionally
 * gate vision, then buildPrompt/runStream. A `chat.docSearch` request uses
 * gateStreamingRequest/gateVisionSupport directly instead — see
 * handleChatDocSearch below, which also needs search.status/doc-search
 * between the gate and the build. */
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
    image?: ChatImage;
    build: () => BuiltPrompt;
  },
): void {
  const gated = gateStreamingRequest(ws, message, active, settingsCtx, { ...opts, hasImage: opts.image !== undefined });
  if (!gated) return;
  const { provider, providerOpts, startedAt } = gated;
  if (opts.image) {
    void gateVisionSupport(ws, message, provider, providerOpts, startedAt).then((proceed) => {
      if (!proceed) return;
      const built = opts.build();
      void runStream(ws, active, message.id, built, provider, providerOpts, startedAt);
    });
    return;
  }
  const built = opts.build();
  void runStream(ws, active, message.id, built, provider, providerOpts, startedAt);
}

/** Best-effort site name for reformulate.ts's fallback query ("+ nom du
 * site") — the origin's registrable domain, or its bare hostname when it
 * has none (e.g. a single-label host), or "" when `origin` is empty/invalid
 * (no http(s) tab — chat.docSearch wasn't sent at all). Never throws. */
function siteNameForOrigin(origin: string): string {
  if (!origin) return "";
  try {
    const hostname = new URL(origin).hostname;
    return registrableDomain(hostname) ?? hostname;
  } catch {
    return "";
  }
}

/**
 * Amendement 2026-10-08 (lot C1 + bis "recherche sur demande explicite" —
 * docs/PROTOCOL.md §6/§7/§8). Called only once handleMessage's own
 * detectSearchIntent() found an explicit search request in the message
 * text. Gates the request exactly like any other chat (size, budget,
 * concurrency, provider, vision if an image is also attached), enforces
 * "une seule recherche en cours par connexion" (R5), reformulates the
 * question into a short search query (search/reformulate.ts, emits
 * `search.status` stage "query"), then runs discover → search → read
 * (search/doc-search.ts), emitting `search.status` before the first `chunk`
 * at each remaining stage, and only THEN builds the prompt (with `sources`)
 * and streams the answer. `search-not-configured`/`search-unavailable`
 * (with `reason`) are sent as a normal `error` message — the request does
 * NOT silently fall back to answering without sources, same "hard error,
 * never a silent degrade" stance as `vision-unsupported`.
 */
function handleChatDocSearch(
  ws: { send(data: string): unknown },
  message: {
    id: string;
    text: string;
    context?: Context;
    image?: ChatImage;
    history?: HistoryEntry[];
    docSearch: { origin: string };
  },
  active: Map<string, AbortController>,
  settingsCtx: SettingsCtx,
  lang: Lang,
  dataDir: string,
  connState: { docSearching: boolean; closed: boolean },
): void {
  const gated = gateStreamingRequest(ws, message, active, settingsCtx, {
    logType: "chat",
    logContextKind: message.context?.kind,
    logTextLength: message.text.length + (message.context?.text?.length ?? 0),
    logPageKind: message.context?.pageKind,
    logFactsCount: message.context?.facts?.length ?? 0,
    logItemsCount: message.context?.items?.length ?? 0,
    hasImage: message.image !== undefined,
    tooLargeText: message.text,
    budgetContext: message.context,
  });
  if (!gated) return;
  const { provider, providerOpts, startedAt } = gated;

  if (connState.docSearching) {
    send(ws, {
      type: "error",
      id: message.id,
      code: "bad-request",
      message: "a documentation search is already in progress on this connection",
    });
    logRequestCompleted(message.id, "error:bad-request", Date.now() - startedAt);
    return;
  }

  // Set BEFORE the first `await` (synchronously, in this same tick) so a
  // second `chat.docSearch` arriving while this one is still gating on
  // vision support can never slip past the check above — R5.
  connState.docSearching = true;
  // Security review (L9): registered in `active` for the WHOLE search phase
  // (discover/search/read), not just once runStream() eventually starts —
  // without this, a `cancel` for this id arriving mid-search found nothing
  // to abort (handleMessage's "cancel" case is a bare `active.get(target)
  // ?.abort()`), and the search ran to completion regardless. `close()`'s
  // existing "abort everything in `active`" loop now reaches it too. If the
  // request DOES reach runStream(), that function `active.set`s its OWN
  // controller under the same id — overwriting this one — and owns the
  // entry's lifecycle from then on; the `finally` below only ever deletes
  // this controller's OWN entry, never one runStream already replaced it with.
  const searchController = new AbortController();
  active.set(message.id, searchController);
  void (async () => {
    try {
      if (message.image) {
        const proceed = await gateVisionSupport(ws, message, provider, providerOpts, startedAt);
        if (!proceed) return;
      }
      if (searchController.signal.aborted || connState.closed) {
        if (!connState.closed) {
          send(ws, { type: "error", id: message.id, code: "cancelled", message: "request cancelled" });
        }
        logRequestCompleted(message.id, "cancelled", Date.now() - startedAt);
        return;
      }

      const config = settingsCtx.getConfig();
      const searchProvider = config.searchProvider;
      const searchApiKey = searchProvider ? resolveSearchApiKey(config, searchProvider) : undefined;

      // Amendement 2026-10-08 (bis, "recherche sur demande explicite" §3):
      // one short extra model call turns the question into a standalone
      // search query BEFORE the pipeline runs — skipped when no provider is
      // configured at all (runDocSearch below throws SearchNotConfiguredError
      // immediately in that case; a reformulation call would be wasted work
      // for a search that can never run).
      let query = message.text;
      if (searchProvider && searchApiKey) {
        query = await reformulateSearchQuery({
          provider,
          providerOpts,
          question: message.text,
          pageTitle: message.context?.title,
          pageUrl: message.context?.url,
          history: message.history,
          lang,
          siteName: siteNameForOrigin(message.docSearch.origin),
          signal: searchController.signal,
        });
        if (searchController.signal.aborted || connState.closed) {
          if (!connState.closed) {
            send(ws, { type: "error", id: message.id, code: "cancelled", message: "request cancelled" });
          }
          logRequestCompleted(message.id, "cancelled", Date.now() - startedAt);
          return;
        }
        if (!connState.closed) {
          send(ws, { type: "search.status", id: message.id, stage: "query", scope: null, query });
        }
      }

      const result = await runDocSearch({
        origin: message.docSearch.origin,
        question: query,
        dataDir,
        searchProvider,
        apiKey: searchApiKey,
        onStatus: (event: DocSearchStatusEvent) => {
          // Security review (L9): never write to a connection that already
          // closed while the (potentially long) search phase was running.
          if (connState.closed) return;
          send(ws, { type: "search.status", id: message.id, ...event });
        },
      });

      // Security review (L9): re-checked AFTER the search phase too — a
      // `cancel`/close that arrived WHILE runDocSearch was awaiting network
      // calls must still stop this request from starting a model stream
      // (runDocSearch itself isn't signal-aware mid-flight — its own
      // network calls run to their own completion/timeout regardless — but
      // nothing downstream of it ever reaches the model or the socket).
      if (searchController.signal.aborted || connState.closed) {
        if (!connState.closed) {
          send(ws, { type: "error", id: message.id, code: "cancelled", message: "request cancelled" });
        }
        logRequestCompleted(message.id, "cancelled", Date.now() - startedAt);
        return;
      }

      const built = buildPrompt(
        {
          kind: "chat",
          text: message.text,
          context: message.context,
          image: message.image,
          sources: result.sources,
          sourcesScoped: result.scope !== null,
        },
        lang,
      );
      void runStream(ws, active, message.id, built, provider, providerOpts, startedAt);
    } catch (err) {
      if (connState.closed) return; // nobody left to tell
      // Security review (L9): a cancel that arrived WHILE runDocSearch's own
      // network calls were in flight surfaces here as whatever error those
      // calls happened to end up throwing (e.g. "no-result") — that's an
      // artifact of timing, not the real outcome; report the cancellation
      // the user actually asked for instead.
      if (searchController.signal.aborted) {
        send(ws, { type: "error", id: message.id, code: "cancelled", message: "request cancelled" });
        logRequestCompleted(message.id, "cancelled", Date.now() - startedAt);
        return;
      }
      if (isSearchNotConfiguredError(err)) {
        const msg = "no search provider is configured — open settings to add a Brave Search or Tavily key";
        send(ws, { type: "error", id: message.id, code: "search-not-configured", message: msg });
        logRequestCompleted(message.id, "error:search-not-configured", Date.now() - startedAt, msg);
        return;
      }
      if (isSearchUnavailableError(err)) {
        send(ws, { type: "error", id: message.id, code: "search-unavailable", message: err.message, reason: err.reason });
        logRequestCompleted(message.id, "error:search-unavailable", Date.now() - startedAt, err.message);
        return;
      }
      const msg = err instanceof Error ? err.message : String(err);
      send(ws, { type: "error", id: message.id, code: "internal", message: msg });
      logRequestCompleted(message.id, "error:internal", Date.now() - startedAt, msg);
    } finally {
      connState.docSearching = false;
      if (active.get(message.id) === searchController) active.delete(message.id);
    }
  })();
}

function handleMessage(
  ws: { send(data: string): unknown },
  message: ClientMessage,
  active: Map<string, AbortController>,
  promptsDirs: PromptsDirs,
  settingsCtx: SettingsCtx,
  lang: Lang,
  // Amendement 2026-10-08 (lot C1): only ever used by a `chat.docSearch`
  // request — dataDir for discover.ts's cache, connState for the "one
  // search in flight per connection" rule (R5). Every other message type
  // ignores both.
  dataDir: string,
  connState: { docSearching: boolean; closed: boolean },
): void {
  switch (message.type) {
    case "hello":
    case "auth":
      // Duplicate hello/auth after an already-authed handshake: no-op.
      return;
    case "chat": {
      // Amendement 2026-10-08 (bis, "recherche sur demande explicite" —
      // docs/PROTOCOL.md): the panel no longer has a search button —
      // `chat.docSearch.origin` now just means "this chat's tab is http(s),
      // a search is ALLOWED for this origin" and is sent on every chat for
      // such a tab. Whether a search actually runs is decided HERE, on the
      // message TEXT alone (fr/en/zh intent phrases, search/intent.ts) —
      // never on the mere presence of `docSearch`. `docSearch.origin` can be
      // "" (no http(s) tab) and intent can still be detected: the pipeline
      // then runs unscoped (open web), see doc-search.ts's ladder.
      if (detectSearchIntent(message.text, lang)) {
        handleChatDocSearch(
          ws,
          { ...message, docSearch: message.docSearch ?? { origin: "" } },
          active,
          settingsCtx,
          lang,
          dataDir,
          connState,
        );
        return;
      }
      handleStreamingRequest(ws, message, active, settingsCtx, {
        logType: "chat",
        logContextKind: message.context?.kind,
        logTextLength: message.text.length + (message.context?.text?.length ?? 0),
        logPageKind: message.context?.pageKind,
        logFactsCount: message.context?.facts?.length ?? 0,
        logItemsCount: message.context?.items?.length ?? 0,
        tooLargeText: message.text,
        budgetContext: message.context,
        // Amendement 2026-10-08 (lot B1): `image` is never logged beyond its
        // presence (docs/PROTOCOL.md §3) — see logRequestReceived's own call
        // site below, which only ever gets booleans/counts, never content.
        image: message.image,
        build: () =>
          buildPrompt(
            { kind: "chat", text: message.text, context: message.context, image: message.image, history: message.history },
            lang,
          ),
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
        searchProvider: message.searchProvider,
        searchApiKey: message.searchApiKey,
        clearKey: message.clearKey,
      });
      void buildSettingsPayload(updated, lang).then((payload) => {
        send(ws, { type: "settings", id: message.id, ...payload });
      });
      return;
    }
    case "settings.test": {
      // Amendement 2026-10-08 (lot C1, docs/PROTOCOL.md §9): target "search"
      // tests a search engine instead of a model provider. The reply keeps
      // the exact same shape either way ("ne change pas de forme") — the
      // engine id (open-ended ProviderId shape already, see
      // search/types.ts's SearchProviderId) is echoed back in `provider`.
      if (message.target === "search") {
        void testSearchConnection(message.searchProvider, settingsCtx.getConfig(), lang).then(
          ({ ok, message: resultMessage, code }) => {
            send(ws, {
              type: "settings.test-result",
              id: message.id,
              provider: message.searchProvider,
              ok,
              message: resultMessage,
              code,
            });
          },
        );
        return;
      }
      void testProviderConnection(message.provider, settingsCtx.getConfig(), lang).then(
        ({ ok, message: resultMessage, code, creditUnchecked }) => {
          send(ws, {
            type: "settings.test-result",
            id: message.id,
            provider: message.provider,
            ok,
            message: resultMessage,
            code,
            ...(creditUnchecked ? { creditUnchecked: true } : {}),
          });
        },
      );
      return;
    }
    case "provider.status": {
      void settingsCtx.getProviderStatus().then((result) => {
        // baseUrl is NOT a secret (amendement 2026-09-30 bis). Sent for
        // openai-compat so the panel can name the real provider (OpenAI,
        // Mistral, OpenRouter, DeepSeek…) and link to its key/billing pages
        // without asking for `settings` — a `settings` broadcast would
        // re-render an open options page (amendement 2026-10-02 ter).
        const baseUrl = result.provider === "openai-compat" ? settingsCtx.getConfig().baseUrl : undefined;
        send(ws, {
          type: "provider.status-result",
          id: message.id,
          provider: result.provider,
          state: result.state,
          reason: result.reason,
          checkedAt: result.checkedAt,
          ...(baseUrl ? { baseUrl } : {}),
        });
      });
      return;
    }
    case "models.list": {
      // Amendement 2026-10-07: lists all usable models from every configured
      // source, regardless of the active provider (root-cause fix for Ollama
      // models disappearing when active provider is claude-cli).
      void buildModelsPayload(settingsCtx.getConfig()).then((payload) => {
        send(ws, { type: "models", id: message.id, ...payload });
      });
      return;
    }
    case "model.warmup": {
      // Amendement 2026-10-07 (bis): pre-load the active Ollama model into
      // memory so the first summarize/chat request doesn't wait for a cold load.
      void (async () => {
        const config = settingsCtx.getConfig();
        if (settingsCtx.providerId !== "ollama") {
          send(ws, { type: "model.warmup-result", id: message.id, state: "skipped" });
          return;
        }
        const model = config.model?.trim();
        if (!model) {
          send(ws, { type: "model.warmup-result", id: message.id, state: "skipped" });
          return;
        }
        // Determine context tokens for the model (from show cache or default).
        const ollamaUrl = config.ollamaUrl ?? DEFAULT_OLLAMA_URL;
        // Use models.list entries to find the contextTokens if already cached,
        // otherwise default to 8192.
        let contextTokens = 8192;
        try {
          const entries = await listOllamaModelEntries({ ollamaUrl });
          const entry = entries.find((e) => matchesModel(e.name, model));
          if (entry?.contextTokens !== undefined) contextTokens = entry.contextTokens;
        } catch {
          // fallback to 8192
        }
        const result = await warmupModel(model, contextTokens, { ollamaUrl });
        send(ws, {
          type: "model.warmup-result",
          id: message.id,
          state: result.state,
          ...(result.ms !== undefined ? { ms: result.ms } : {}),
        });
      })();
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
  send(ws, { type: "hello-ok", v: 2, features: BROKER_FEATURES });
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
        // Amendement 2026-10-07 bis: capture the OLD provider's current
        // model into lastModels BEFORE switching away from it. Without this,
        // a model only ever set through the initial config (never through
        // its own settings.set while that provider was active) had no entry
        // yet, and switching away lost it for good — switching back could
        // not restore it (bug report: "Ollama (local) : modèle configuré
        // absent d'Ollama" shown even though the model was installed, after
        // an earlier provider switch had dropped it).
        if (patch.provider !== undefined) {
          const oldProvider = currentConfig.provider ?? DEFAULT_CONFIG.provider!;
          if (oldProvider !== patch.provider && currentConfig.model) {
            currentConfig = {
              ...currentConfig,
              lastModels: { ...currentConfig.lastModels, [oldProvider]: currentConfig.model },
            };
          }
        }
        if (patch.provider !== undefined) currentConfig = { ...currentConfig, provider: patch.provider };
        if (patch.model !== undefined) {
          currentConfig = { ...currentConfig, model: patch.model };
        } else if (patch.provider !== undefined) {
          // Switching provider without specifying a model: restore the last
          // model used with that provider (amendement 2026-10-07).
          const remembered = currentConfig.lastModels?.[patch.provider];
          if (remembered) {
            currentConfig = { ...currentConfig, model: remembered };
          }
        }
        // Track the last model per provider (amendement 2026-10-07).
        const activeProvider = currentConfig.provider ?? DEFAULT_CONFIG.provider!;
        if (currentConfig.model) {
          currentConfig = {
            ...currentConfig,
            lastModels: { ...currentConfig.lastModels, [activeProvider]: currentConfig.model },
          };
        }
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
        // Amendement 2026-10-08 (lot C1, docs/PROTOCOL.md §9): independent of
        // the model `provider`/`model`/`apiKey` fields above — "" forgets the
        // stored choice, same convention as every other field here.
        if (patch.searchProvider !== undefined) {
          currentConfig = {
            ...currentConfig,
            searchProvider: patch.searchProvider === "" ? undefined : patch.searchProvider,
          };
        }
        // Bound to whichever engine THIS SAME patch's searchProvider names,
        // or the currently configured one otherwise — mirrors apiKey/provider
        // above. A searchApiKey with neither a same-patch nor an already
        // configured searchProvider has nowhere safe to bind to and is
        // dropped, same reasoning as setApiKey's own "no baseUrl yet" case.
        if (patch.searchApiKey !== undefined) {
          const targetSearchProvider = patch.searchProvider || currentConfig.searchProvider;
          if (targetSearchProvider) {
            currentConfig = {
              ...currentConfig,
              searchKeys: setSearchApiKey(currentConfig, targetSearchProvider, patch.searchApiKey),
            };
          }
        }
        // Amendement 2026-10-08 (lot C1, EXTRA task, docs/PROTOCOL.md §9bis):
        // forgets a stored key WITHOUT touching provider/model/searchProvider
        // — independent of every other field in this same patch.
        if (patch.clearKey !== undefined) {
          if (isSearchProviderId(patch.clearKey)) {
            currentConfig = { ...currentConfig, searchKeys: setSearchApiKey(currentConfig, patch.clearKey, "") };
          } else {
            currentConfig = { ...currentConfig, apiKeys: setApiKey(currentConfig, patch.clearKey, "") };
          }
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
          docSearching: false,
          closed: false,
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
      // the `message` handler below goes on to check. Amendement 2026-10-08
      // (lot B1): raised from MAX_MESSAGE_BYTES to MAX_IMAGE_MESSAGE_BYTES
      // (1.5 MiB) + 4 KiB slack, so a legitimate chat+image frame (up to
      // ~1.37 MiB of base64 for a 1 MiB decoded image, plus the rest of the
      // envelope) can still reach the `message` handler below, which is
      // where the finer-grained 256 KiB-vs-1.5 MiB distinction actually
      // lives (docs/PROTOCOL.md §5) — this is only the hard backstop.
      maxPayloadLength: MAX_IMAGE_MESSAGE_BYTES + 4096,
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
        // BEFORE any UTF-8 decoding or JSON.parse. `websocket.maxPayloadLength`
        // above is the hard backstop at the Bun protocol layer, closing the
        // socket before this handler even runs for anything past that; the
        // checks below catch the remaining gap.
        const rawByteLength = typeof raw === "string" ? Buffer.byteLength(raw, "utf8") : raw.byteLength;

        // Pre-auth: hello/auth never carry an image (docs/PROTOCOL.md §5,
        // amendement 2026-10-08) — the raised cap below only ever applies
        // post-auth, to a chat+image. Unauthenticated connections keep the
        // original, unconditional 256 KiB gate, no JSON parsed on a breach.
        if (!ws.data.authed) {
          if (rawByteLength > MAX_MESSAGE_BYTES) {
            console.error(`coati-broker: reject stage=oversized origin=${sanitizeLogValue(ws.data.origin)}`);
            // No `error` frame — same as every other handshake rejection
            // (docs/PROTOCOL.md "Journalisation"/rejectHandshake).
            rejectHandshake(ws, ws.data.origin, "oversized message before auth");
            return;
          }
          const text = typeof raw === "string" ? raw : Buffer.from(raw).toString("utf8");
          handleHandshakeMessage(ws, text, nativeKey, getLegacySecret, legacyPairingEnabled, () => releaseUnauthSlot(ws));
          return;
        }

        // Authenticated: a frame past MAX_IMAGE_MESSAGE_BYTES is refused
        // outright regardless of content — same oversized+close(1009)
        // treatment as every message beyond MAX_MESSAGE_BYTES that isn't a
        // legitimate chat+image (docs/PROTOCOL.md §5). Defense in depth:
        // websocket.maxPayloadLength above normally stops a frame this
        // large from ever reaching this handler.
        if (rawByteLength > MAX_IMAGE_MESSAGE_BYTES) {
          console.error(`coati-broker: reject stage=oversized origin=${sanitizeLogValue(ws.data.origin)}`);
          send(ws, {
            type: "error",
            id: "oversized",
            code: "bad-request",
            message: `message exceeds ${MAX_IMAGE_MESSAGE_BYTES} byte cap`,
          });
          ws.close(1009, "oversized");
          return;
        }
        const text = typeof raw === "string" ? raw : Buffer.from(raw).toString("utf8");
        const result = parseClientMessage(text);
        if (!result.ok) {
          // Amendement 2026-10-08 (lot B1): the two-tier oversized rejection
          // (> MAX_MESSAGE_BYTES and not a legitimate chat+image) also
          // closes the connection — same policy as the raw-byte-length gate
          // this generalises (docs/PROTOCOL.md §5).
          if (result.error.oversized) {
            console.error(`coati-broker: reject stage=oversized origin=${sanitizeLogValue(ws.data.origin)}`);
            send(ws, { type: "error", id: result.error.id ?? "oversized", code: result.error.code, message: result.error.message });
            ws.close(1009, "oversized");
            return;
          }
          if (result.error.id) {
            send(ws, { type: "error", id: result.error.id, code: result.error.code, message: result.error.message });
          }
          return;
        }
        handleMessage(
          ws,
          result.message,
          ws.data.active,
          promptsDirs,
          settingsCtx(ws.data.lang),
          ws.data.lang,
          dirs.dataDir,
          ws.data,
        );
      },
      close(ws) {
        if (ws.data.helloTimer) clearTimeout(ws.data.helloTimer);
        releaseUnauthSlot(ws);
        ws.data.closed = true; // security review (L9) — see ConnData.closed's own doc
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
