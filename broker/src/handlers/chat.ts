// chat / summarize / act streaming — gating (size/budget/concurrency/vision),
// the provider stream loop, and the `chat.docSearch` pipeline. Split out of
// server.ts (lot F5).

import { send } from "../ws-send.ts";
import {
  logRequestReceived,
  logRequestCompleted,
  contextTooLarge,
  contextBudgetError,
  MAX_CONTEXT_CHARS,
  MAX_DEV_CONTEXT_CHARS,
} from "../logging.ts";
import { DEFAULT_OLLAMA_URL, resolveSearchApiKey } from "../config.ts";
import { fetchPsEntries, matchesModel, listModelEntries as listOllamaModelEntries } from "../providers/ollama.ts";
import type { ModelProvider, ProviderRuntimeOptions } from "../providers/types.ts";
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
  PageMarkerDetector,
  type BuiltPrompt,
} from "../model.ts";
import type { Context, ChatImage, HistoryEntry, PageMeta, ErrorCode } from "../protocol.ts";
import {
  runDocSearch,
  isSearchNotConfiguredError,
  isSearchUnavailableError,
  type DocSearchStatusEvent,
} from "../search/doc-search.ts";
import { reformulateSearchQuery } from "../search/reformulate.ts";
import { registrableDomain } from "../search/discover.ts";
import type { Lang } from "../messages.ts";
import type { SettingsCtx } from "./settings.ts";

// Per-connection cap on simultaneously in-flight model streams. Without it, an
// authenticated client sending N chat/summarize/act messages back to back
// spawns N provider calls with no limit. See docs/PROTOCOL.md "Limites".
export const MAX_CONCURRENT_STREAMS = 3;

/** Maps a thrown provider error to the wire error code / log outcome —
 * factored out of runStream's own catch block so the page-on-demand loop
 * (handleChatPageOnDemand below) classifies a provider failure the exact
 * same way, for any provider, without duplicating the branching chain. */
function classifyProviderError(err: unknown): { code: ErrorCode; retryAfterSec?: number; outcome: string; message: string } {
  const message = err instanceof Error ? err.message : String(err);
  const code: ErrorCode = isAuthRequiredError(err)
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
              : isVisionUnsupportedError(err)
                ? "vision-unsupported"
                : isModelUnavailableError(err)
                  ? "model-unavailable"
                  : "internal";
  const retryAfterSec = err instanceof RateLimitedError ? err.retryAfterSec : undefined;
  const outcome = err instanceof ModelTimeoutError ? "timeout" : isModelStalledError(err) ? "stalled" : `error:${code}`;
  return { code, retryAfterSec, outcome, message };
}

/** Handle a provider call's own in-flight `progress` notifications
 * (Ollama-only, docs/PROTOCOL.md's `progress` message) — factored out of
 * runStream so the page-on-demand loop (runOnDemandCall below) gets the
 * exact same loading/reading/thinking behaviour for every provider call it
 * makes, without duplicating the polling logic. A no-op shell (every method
 * is a harmless no-op) for any non-Ollama provider. */
interface ProgressTracker {
  /** Call on the first real content event of the stream (before forwarding
   * it) — stops the /api/ps poll. Idempotent. */
  markFirstChunk(): void;
  /** Call on a `thinking` event, before any content chunk — emits
   * progress:thinking at most once, never after a content chunk. */
  markThinking(): void;
  /** Call once the stream is done/erroring/cancelled — stops the poll loop
   * for good, whichever way the call ended. */
  stop(): void;
}

/** Amendement 2026-10-07 (bis): progress notifications (Ollama only). Checks
 * /api/ps before the stream starts, emits loading/reading, then polls every
 * 1 s until the model appears in /api/ps or the caller reports the first
 * chunk. Awaited before the stream loop starts, same as the inline version
 * this replaces, so the initial loading/reading notification always
 * precedes any chunk. */
async function startProgressTracking(
  ws: { send(data: string): unknown },
  id: string,
  provider: ModelProvider,
  providerOpts: ProviderRuntimeOptions,
  signal: AbortSignal,
): Promise<ProgressTracker> {
  let firstChunkSent = false;
  let progressPollingDone = false;
  // Amendement 2026-10-07 (bis): thinking stage — sent at most once, before
  // any content, when the provider emits a thinking event (thinking-only model).
  let thinkingProgressSent = false;

  if (provider.id === "ollama") {
    const ollamaUrl = providerOpts.ollamaUrl ?? DEFAULT_OLLAMA_URL;
    const model = providerOpts.model ?? "";
    const psEntries = await fetchPsEntries({ ollamaUrl, signal }).catch(() => [] as Awaited<ReturnType<typeof fetchPsEntries>>);
    if (!signal.aborted) {
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
            const ps = await fetchPsEntries({ ollamaUrl, signal }).catch(() => [] as Awaited<ReturnType<typeof fetchPsEntries>>);
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

  return {
    markFirstChunk() {
      firstChunkSent = true;
      progressPollingDone = true;
    },
    markThinking() {
      if (!thinkingProgressSent && !firstChunkSent) {
        thinkingProgressSent = true;
        send(ws, { type: "progress", id, stage: "thinking" });
      }
    },
    stop() {
      progressPollingDone = true;
    },
  };
}

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
  const progress = await startProgressTracking(ws, id, provider, providerOpts, controller.signal);

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
        progress.markThinking();
        continue;
      }
      progress.markFirstChunk();
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
    progress.stop();
    if (controller.signal.aborted) {
      send(ws, { type: "error", id, code: "cancelled", message: "request cancelled" });
      logRequestCompleted(id, "cancelled", Date.now() - startedAt);
    } else {
      const { code, retryAfterSec, outcome, message } = classifyProviderError(err);
      send(ws, { type: "error", id, code, message, ...(retryAfterSec !== undefined ? { retryAfterSec } : {}) });
      logRequestCompleted(id, outcome, Date.now() - startedAt, message);
    }
  } finally {
    progress.stop();
    active.delete(id);
  }
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
export function handleStreamingRequest(
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
export function handleChatDocSearch(
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

// ---------------------------------------------------------------------------
// Lot 7, "page on demand" — docs/PROTOCOL.md "Page on demand". A `chat` that
// carries `page` and no `context` at all shows the model only the page's
// metadata (title/url/kind/chars); if the model's own streamed answer
// matches one of the two markers (model/page-marker.ts), the broker asks
// the client for the real content (or accepts a decline), re-runs the exact
// same question with it, and repeats — up to two round trips total, at most
// one per level. See handleMessage's own "chat" case (handlers/dispatch.ts)
// for the branch that only ever reaches this file when `context` is absent.
// ---------------------------------------------------------------------------

/** How long the broker waits for a `page.content`/`page.decline` after
 * sending a `page.request`, before failing the request outright with
 * `page-unavailable` (docs/PROTOCOL.md "Page on demand"). */
export const PAGE_REQUEST_TIMEOUT_MS = 120_000;

// Amendement 2026-10-09 (lot 7): fits dev-level content (already bounded to
// MAX_DEV_CONTEXT_CHARS by the protocol) to the ACTIVE model's own context
// window — "whatever models.ts/ollama.ts already know", i.e. Ollama's own
// contextTokens tier when the active provider is ollama, else a per-provider
// fixed fallback (no other provider reports a context size to this broker
// today). ~3.5 chars/token is the same rough English-prose ratio used
// nowhere else numerically in this codebase but is the standard rule of
// thumb for Latin-script text; kept local to this one estimate, never
// presented to a human as exact.
const DEV_CHARS_PER_TOKEN = 3.5;
const DEV_ANSWER_RESERVE_TOKENS = 2000;
// Ollama-lookup-failure fallback only (daemon unreachable, model not found) —
// distinct from the non-Ollama fallbacks below, which are per-provider.
const DEV_DEFAULT_CONTEXT_TOKENS = 8192;
const DEV_MIN_USABLE_TOKENS = 1000;
// Amendement (lot 7 fix): claude-api/claude-cli both front large-context
// Anthropic models — 200k tokens is Claude's own documented window, not a
// guess. Every other non-Ollama provider (openai-compat, an external
// module) reports no context size to this broker at all, so 32768 is a
// conservative placeholder, well short of most modern remote models but far
// above the old 8192 default dev mode is meant to exceed.
const DEV_CLAUDE_CONTEXT_TOKENS = 200_000;
const DEV_OTHER_PROVIDER_CONTEXT_TOKENS = 32_768;

/** Exported for tests. Pure: the character budget dev-level content is fit
 * to, given the active model's own context size in tokens (undefined when
 * unknown — see resolveActiveContextTokens below). Always ≤
 * MAX_DEV_CONTEXT_CHARS. */
export function devContentCharBudget(contextTokens: number | undefined): number {
  const tokens = contextTokens ?? DEV_DEFAULT_CONTEXT_TOKENS;
  const usable = Math.max(tokens - DEV_ANSWER_RESERVE_TOKENS, DEV_MIN_USABLE_TOKENS);
  return Math.min(Math.floor(usable * DEV_CHARS_PER_TOKEN), MAX_DEV_CONTEXT_CHARS);
}

/** The active model's own context window, in tokens, when this broker can
 * tell — Ollama reports a real per-model figure (models.list/model.warmup
 * use the same lookup), `undefined` on any lookup failure (daemon
 * unreachable, model not found), in which case devContentCharBudget's own
 * DEV_DEFAULT_CONTEXT_TOKENS fallback applies. Every other provider gets a
 * fixed per-provider estimate (DEV_CLAUDE_CONTEXT_TOKENS/
 * DEV_OTHER_PROVIDER_CONTEXT_TOKENS above) — never `undefined`, since none
 * of them can fail this lookup (nothing is actually probed). Never throws.
 * Exported for tests. */
export async function resolveActiveContextTokens(
  provider: ModelProvider,
  providerOpts: ProviderRuntimeOptions,
): Promise<number | undefined> {
  if (provider.id !== "ollama") {
    return provider.id === "claude-api" || provider.id === "claude-cli"
      ? DEV_CLAUDE_CONTEXT_TOKENS
      : DEV_OTHER_PROVIDER_CONTEXT_TOKENS;
  }
  try {
    const ollamaUrl = providerOpts.ollamaUrl ?? DEFAULT_OLLAMA_URL;
    const entries = await listOllamaModelEntries({ ollamaUrl });
    const entry = entries.find((e) => matchesModel(e.name, providerOpts.model ?? ""));
    return entry?.contextTokens;
  } catch {
    return undefined;
  }
}

type PageAnswer = { kind: "content"; level: "text" | "dev"; context: Context } | { kind: "decline" };

/** Per-connection state this module needs beyond `active` — a slice of
 * handshake.ts's ConnData, kept narrow so tests can pass a bare object
 * literal rather than a full connection. */
export interface PageOnDemandConnState {
  closed: boolean;
  pageRequests: Map<string, (answer: PageAnswer) => void>;
}

/** Resolves once a `page.content`/`page.decline` naming `id` as its `target`
 * arrives (dispatch.ts calls the resolver this registers), the wait times
 * out (PAGE_REQUEST_TIMEOUT_MS), or `signal` aborts (connection closed, or a
 * `cancel` for this id). Removes its own entry from `pageRequests` exactly
 * once, however it resolves — never leaves a stale resolver behind. */
function awaitPageAnswer(
  connState: PageOnDemandConnState,
  id: string,
  signal: AbortSignal,
): Promise<PageAnswer | "timeout" | "aborted"> {
  return new Promise((resolve) => {
    let settled = false;
    const timer = setTimeout(() => finish("timeout"), PAGE_REQUEST_TIMEOUT_MS);
    function finish(result: PageAnswer | "timeout" | "aborted"): void {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      connState.pageRequests.delete(id);
      resolve(result);
    }
    function onAbort(): void {
      finish("aborted");
    }
    signal.addEventListener("abort", onAbort);
    connState.pageRequests.set(id, (answer) => finish(answer));
  });
}

/** Validates and, for level "dev", fits the client-supplied page content
 * before it is spliced into a re-run prompt. Returns an error message
 * (never thrown) when the content breaches a size bound — "the broker
 * refuses, it never truncates" for a protocol-level breach (level "text"'s
 * existing MAX_CONTEXT_CHARS/contextBudgetError, or level "dev" past
 * MAX_DEV_CONTEXT_CHARS) — distinct from the dev-only fit-to-model-context
 * truncation below, which is expected/routine and always reported via
 * `report.truncated`, never refused. */
async function fitPageContent(
  level: "text" | "dev",
  context: Context,
  provider: ModelProvider,
  providerOpts: ProviderRuntimeOptions,
): Promise<
  | { error: string }
  | { error?: undefined; context: Context; report: { level: "text" | "dev"; chars: number; sentChars: number; truncated: boolean } }
> {
  const chars = context.text?.length ?? 0;
  if (level === "text") {
    if (contextTooLarge(context.text)) return { error: `text exceeds ${MAX_CONTEXT_CHARS} characters` };
    const budgetError = contextBudgetError(context);
    if (budgetError) return { error: budgetError };
    return { context, report: { level, chars, sentChars: chars, truncated: false } };
  }
  // level === "dev": the protocol's own hard cap first (a breach refuses,
  // same stance as every other numeric wire bound in this codebase).
  if (chars > MAX_DEV_CONTEXT_CHARS) {
    return { error: `page content exceeds ${MAX_DEV_CONTEXT_CHARS} characters` };
  }
  const contextTokens = await resolveActiveContextTokens(provider, providerOpts);
  const budget = devContentCharBudget(contextTokens);
  if (chars <= budget) {
    return { context, report: { level, chars, sentChars: chars, truncated: false } };
  }
  // Truncates from the end, reports it — never a refusal: fitting dev
  // content to the model's own window is routine, not a client breach.
  return {
    context: { ...context, text: (context.text ?? "").slice(0, budget) },
    report: { level, chars, sentChars: budget, truncated: true },
  };
}

interface OnDemandCallResult {
  outcome: "ok" | "cancelled" | "error" | "marker";
  usage: { inputTokens: number; outputTokens: number };
  historyKept?: number;
  marker?: { level: "text" | "dev"; position: "start" | "mid" };
  err?: unknown;
}

/**
 * Runs exactly ONE provider call for the page-on-demand loop below, through
 * the shared marker detector (model/page-marker.ts) — the ONE place a
 * streamed answer is scanned for either marker, regardless of which
 * provider is active (docs/PROTOCOL.md "Page on demand": "all providers,
 * one shared place — not per provider"). Thinking/reasoning events are
 * never fed to the detector (never scanned, per the same spec line) — same
 * treatment as the plain chat path above. `canTrigger` is the caller's own
 * read-cap policy (at most one read per level, two per question): a marker
 * this returns false for is still never forwarded as text, but does NOT
 * abort the stream — it is simply stripped, and the rest of the stream
 * keeps flowing normally ("a marker beyond that is stripped and ignored").
 * Amendement (lot 7 fix): Ollama's loading/reading/thinking `progress`
 * notifications (startProgressTracking above) fire for THIS call exactly as
 * they do in the plain chat path — every provider call the on-demand loop
 * makes (the metadata-only call and any re-run) gets its own tracker.
 */
async function runOnDemandCall(
  ws: { send(data: string): unknown },
  active: Map<string, AbortController>,
  id: string,
  built: BuiltPrompt,
  provider: ModelProvider,
  providerOpts: ProviderRuntimeOptions,
  allowDevMarker: boolean,
  canTrigger: (level: "text" | "dev") => boolean,
): Promise<OnDemandCallResult> {
  const controller = new AbortController();
  active.set(id, controller);
  const progress = await startProgressTracking(ws, id, provider, providerOpts, controller.signal);
  const detector = new PageMarkerDetector({ allowDev: allowDevMarker });
  let usage = { inputTokens: 0, outputTokens: 0 };
  let historyKept: number | undefined;
  try {
    for await (const event of provider.streamAnswer(built, { signal: controller.signal, ...providerOpts })) {
      if (controller.signal.aborted) break;
      if (event.kind === "usage") {
        usage = event.usage;
        historyKept = event.historyKept;
        continue;
      }
      if (event.kind === "thinking") {
        progress.markThinking();
        continue; // never scanned, never forwarded
      }
      progress.markFirstChunk();
      for (const ev of detector.feed(event.text)) {
        if (ev.kind === "text") {
          if (ev.text.length > 0) send(ws, { type: "chunk", id, delta: ev.text });
          continue;
        }
        if (canTrigger(ev.level)) {
          controller.abort();
          return { outcome: "marker", usage, historyKept, marker: { level: ev.level, position: ev.position } };
        }
        // Beyond the read caps: stripped and ignored — keep consuming the
        // rest of this same stream, never aborting, never requesting again.
      }
    }
    if (controller.signal.aborted) return { outcome: "cancelled", usage, historyKept };
    for (const ev of detector.flush()) {
      if (ev.kind === "text" && ev.text.length > 0) send(ws, { type: "chunk", id, delta: ev.text });
    }
    return { outcome: "ok", usage, historyKept };
  } catch (err) {
    if (controller.signal.aborted) return { outcome: "cancelled", usage, historyKept };
    return { outcome: "error", usage, historyKept, err };
  } finally {
    progress.stop();
    if (active.get(id) === controller) active.delete(id);
  }
}

function addUsage(
  a: { inputTokens: number; outputTokens: number },
  b: { inputTokens: number; outputTokens: number },
): { inputTokens: number; outputTokens: number } {
  return { inputTokens: a.inputTokens + b.inputTokens, outputTokens: a.outputTokens + b.outputTokens };
}

/**
 * Entry point for a `chat` carrying `page` and no `context` — see
 * handleMessage's "chat" case (handlers/dispatch.ts), the only caller. Gates
 * exactly like any other chat/summarize/act (size, concurrency, provider),
 * then hands off to the async loop below.
 */
export function handleChatPageOnDemand(
  ws: { send(data: string): unknown },
  message: { id: string; text: string; page: PageMeta; devMode?: boolean; history?: HistoryEntry[] },
  active: Map<string, AbortController>,
  settingsCtx: SettingsCtx,
  lang: Lang,
  connState: PageOnDemandConnState,
): void {
  const gated = gateStreamingRequest(ws, message, active, settingsCtx, {
    logType: "chat",
    logContextKind: "page",
    logTextLength: message.text.length,
    logPageKind: message.page.kind,
    logFactsCount: 0,
    logItemsCount: 0,
    hasImage: false,
    tooLargeText: message.text,
  });
  if (!gated) return;
  const { provider, providerOpts, startedAt } = gated;
  void runChatPageOnDemandLoop(ws, message, active, provider, providerOpts, lang, connState, startedAt);
}

async function runChatPageOnDemandLoop(
  ws: { send(data: string): unknown },
  message: { id: string; text: string; page: PageMeta; devMode?: boolean; history?: HistoryEntry[] },
  active: Map<string, AbortController>,
  provider: ModelProvider,
  providerOpts: ProviderRuntimeOptions,
  lang: Lang,
  connState: PageOnDemandConnState,
  startedAt: number,
): Promise<void> {
  const devMode = message.devMode === true;
  let totalUsage = { inputTokens: 0, outputTokens: 0 };
  let historyKept: number | undefined;
  let reads = 0;
  const usedLevels = new Set<"text" | "dev">();
  const canTrigger = (level: "text" | "dev") => reads < 2 && !usedLevels.has(level);

  let built = buildPrompt(
    { kind: "chat", text: message.text, page: message.page, devMode, history: message.history },
    lang,
  );
  let pageReport: { level: "text" | "dev"; chars: number; sentChars: number; truncated: boolean } | undefined;

  // At most two round trips (reads<2 above already enforces this at the
  // policy level) — this outer bound is belt-and-braces against a runaway
  // loop should canTrigger ever be miscomputed.
  for (let turn = 0; turn < 4; turn++) {
    const result = await runOnDemandCall(ws, active, message.id, built, provider, providerOpts, devMode, canTrigger);
    totalUsage = addUsage(totalUsage, result.usage);
    if (result.historyKept !== undefined) historyKept = result.historyKept;

    if (result.outcome === "cancelled") {
      if (!connState.closed) send(ws, { type: "error", id: message.id, code: "cancelled", message: "request cancelled" });
      logRequestCompleted(message.id, "cancelled", Date.now() - startedAt);
      return;
    }
    if (result.outcome === "error") {
      const { code, retryAfterSec, outcome, message: msg } = classifyProviderError(result.err);
      send(ws, { type: "error", id: message.id, code, message: msg, ...(retryAfterSec !== undefined ? { retryAfterSec } : {}) });
      logRequestCompleted(message.id, outcome, Date.now() - startedAt, msg);
      return;
    }
    if (result.outcome === "ok") {
      send(ws, {
        type: "done",
        id: message.id,
        usage: totalUsage,
        ...(historyKept !== undefined ? { historyKept } : {}),
        ...(pageReport ? { page: pageReport } : {}),
      });
      logRequestCompleted(message.id, "ok", Date.now() - startedAt);
      return;
    }

    // result.outcome === "marker": ask the client for the page.
    const marker = result.marker!;
    reads++;
    usedLevels.add(marker.level);
    if (connState.closed) {
      logRequestCompleted(message.id, "cancelled", Date.now() - startedAt);
      return;
    }
    send(ws, { type: "page.request", id: message.id, level: marker.level, ...(marker.position === "mid" ? { discard: true as const } : {}) });

    const waitController = new AbortController();
    active.set(message.id, waitController);
    const answer = await awaitPageAnswer(connState, message.id, waitController.signal);
    if (active.get(message.id) === waitController) active.delete(message.id);

    if (answer === "timeout") {
      send(ws, { type: "error", id: message.id, code: "page-unavailable", message: "the client did not answer the page request in time" });
      logRequestCompleted(message.id, "error:page-unavailable", Date.now() - startedAt);
      return;
    }
    if (answer === "aborted" || connState.closed) {
      if (!connState.closed) send(ws, { type: "error", id: message.id, code: "cancelled", message: "request cancelled" });
      logRequestCompleted(message.id, "cancelled", Date.now() - startedAt);
      return;
    }
    if (answer.kind === "decline") {
      built = buildPrompt({ kind: "chat", text: message.text, declinedPageRead: true, history: message.history }, lang);
      continue;
    }

    // Protocol breach: the client answered with a level other than the one
    // the broker actually requested (`marker.level`, sent in page.request
    // above) — never silently accepted or coerced, same stance as every
    // other wire-shape mismatch (docs/PROTOCOL.md "bad-request").
    if (answer.level !== marker.level) {
      send(ws, {
        type: "error",
        id: message.id,
        code: "bad-request",
        message: `page.content level "${answer.level}" does not match the requested level "${marker.level}"`,
      });
      logRequestCompleted(message.id, "error:bad-request", Date.now() - startedAt);
      return;
    }

    const fit = await fitPageContent(answer.level, answer.context, provider, providerOpts);
    if (fit.error) {
      send(ws, { type: "error", id: message.id, code: "context-too-large", message: fit.error });
      logRequestCompleted(message.id, "error:context-too-large", Date.now() - startedAt);
      return;
    }
    pageReport = fit.report;
    // Amendement (lot 7 fix): after a TEXT read, still offer the dev marker
    // when devMode allows it and dev hasn't been used yet — canTrigger("dev")
    // already encodes both conditions (and naturally returns false right
    // after a DEV read itself, since usedLevels now has "dev" — symmetric,
    // no instruction offered at all in that case).
    built = buildPrompt(
      {
        kind: "chat",
        text: message.text,
        context: fit.context,
        history: message.history,
        offerDevRead: devMode && canTrigger("dev"),
      },
      lang,
    );
  }
}
