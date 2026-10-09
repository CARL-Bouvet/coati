// chat / summarize / act streaming — gating (size/budget/concurrency/vision),
// the provider stream loop, and the `chat.docSearch` pipeline. Split out of
// server.ts (lot F5).

import { send } from "../ws-send.ts";
import { logRequestReceived, logRequestCompleted, contextTooLarge, contextBudgetError } from "../logging.ts";
import { DEFAULT_OLLAMA_URL, resolveSearchApiKey } from "../config.ts";
import { fetchPsEntries, matchesModel } from "../providers/ollama.ts";
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
  type BuiltPrompt,
} from "../model.ts";
import type { Context, ChatImage, HistoryEntry } from "../protocol.ts";
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
