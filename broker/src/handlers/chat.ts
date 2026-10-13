// chat / summarize / act streaming — gating (size/budget/concurrency/vision),
// the provider stream loop, and the page-on-demand loop.

import { send } from "../ws-send.ts";
import {
  logRequestReceived,
  logRequestCompleted,
  contextTooLarge,
  contextBudgetError,
  MAX_CONTEXT_CHARS,
  MAX_DEV_CONTEXT_CHARS,
} from "../logging.ts";
import { DEFAULT_OLLAMA_URL } from "../config.ts";
import { fetchPsEntries, matchesModel, listModelEntries as listOllamaModelEntries } from "../providers/ollama.ts";
import { isLoopbackHost } from "../providers/openai-compat.ts";
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
  type PageMarker,
  type PageMarkerPosition,
  type SearchRun,
  searchDeclinedNote,
  openFailedNote,
  SEARCH_BUDGET_NOTE,
} from "../model.ts";
import {
  SEARCH_MAX_PER_QUESTION,
  SEARCH_MAX_OPENED,
  SEARCH_BUDGET_LOCAL_CHARS,
  SEARCH_BUDGET_ONLINE_CHARS,
  CHAT_MAX_MODEL_TURNS,
  searchContentError,
  openContentError,
  type Context,
  type ChatImage,
  type ChatAbility,
  type HistoryEntry,
  type PageMeta,
  type ErrorCode,
  type SearchBody,
  type SearchDeclineReason,
  type SearchPageEntry,
  type OpenDeclineReason,
} from "../protocol.ts";
import type { Lang } from "../messages.ts";
import type { SettingsCtx } from "./settings.ts";

// Per-connection cap on simultaneously in-flight model streams. Without it, an
// authenticated client sending N chat/summarize messages back to back
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

/** Progress notifications (Ollama only). Checks
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
  // Thinking stage — sent at most once, before
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
    // "historique": forwarded verbatim as
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
      // Thinking event — emit progress:thinking
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
 * (docs/PROTOCOL.md §4): resolves whether
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
 * (chat/summarize): log receipt, reject an
 * oversized payload, reject a full concurrency cap, reject an unknown
 * configured provider. Returns the resolved provider/opts/startedAt on
 * success, or `undefined` once it has already sent an error and logged the
 * outcome itself (caller just returns in that case). */
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
  // docs/PROTOCOL.md: a configured provider that
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

/** Gates a request carrying `image` on
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
 * (summarize, and a `chat` with no `page`): gate, then optionally
 * gate vision, then buildPrompt/runStream. */
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

// ---------------------------------------------------------------------------
// The marker loop — docs/PROTOCOL.md "Page on demand" and "Search". A
// `chat` that carries `page` and no `context` shows the model only the page's
// metadata; a `chat` with abilities may search, open results, or act. When the
// model's streamed answer holds a marker (model/page-marker.ts), the broker asks
// the client (page, search, open), re-runs the same question with the
// answer, and repeats within the per-question caps and CHAT_MAX_MODEL_TURNS.
// ---------------------------------------------------------------------------

/** How long the broker waits for a `page.content`/`page.decline` after
 * sending a `page.request`, before failing the request outright with
 * `page-unavailable` (docs/PROTOCOL.md "Page on demand"). */
export const PAGE_REQUEST_TIMEOUT_MS = 120_000;

/** Same wait for a `search.request`, long enough for the user to answer the
 * panel's Allow / Refuse card (docs/PROTOCOL.md "Search"). */
export const SEARCH_REQUEST_TIMEOUT_MS = 300_000;

// Fits dev-level content (already bounded to
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
// claude-api/claude-cli both front large-context
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

/** What the client answered to a `page.request`, `search.request` or `open.request`. */
export type ClientAnswer =
  | { kind: "content"; level: "text" | "dev"; context: Context }
  | { kind: "decline" }
  | { kind: "search"; content: SearchBody }
  | { kind: "search-decline"; reason: SearchDeclineReason }
  | { kind: "open"; pages: SearchPageEntry[] }
  | { kind: "open-decline"; reason: OpenDeclineReason };

/** Per-connection state this module needs beyond `active` — a slice of
 * handshake.ts's ConnData, kept narrow so tests can pass a bare object
 * literal rather than a full connection. */
export interface PageOnDemandConnState {
  closed: boolean;
  clientRequests: Map<string, (answer: ClientAnswer) => void>;
}

/** Resolves once an answer naming `id` as its `target` arrives (dispatch.ts
 * calls the resolver this registers), the wait times out
 * (`timeoutMs`), or `signal` aborts (connection closed, or a
 * `cancel` for this id). Removes its own entry from `clientRequests` exactly
 * once, however it resolves — never leaves a stale resolver behind. */
function awaitClientAnswer(
  connState: PageOnDemandConnState,
  id: string,
  signal: AbortSignal,
  timeoutMs: number,
): Promise<ClientAnswer | "timeout" | "aborted"> {
  return new Promise((resolve) => {
    let settled = false;
    const timer = setTimeout(() => finish("timeout"), timeoutMs);
    function finish(result: ClientAnswer | "timeout" | "aborted"): void {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      connState.clientRequests.delete(id);
      resolve(result);
    }
    function onAbort(): void {
      finish("aborted");
    }
    signal.addEventListener("abort", onAbort);
    connState.clientRequests.set(id, (answer) => finish(answer));
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
  marker?: { marker: PageMarker; position: PageMarkerPosition };
  err?: unknown;
  /** "ok" with no visible text: the reply was only markers that were stripped. */
  empty?: boolean;
}

/**
 * Runs exactly ONE provider call for the page-on-demand loop below, through
 * the shared marker detector (model/page-marker.ts) — the ONE place a
 * streamed answer is scanned for markers, regardless of which provider is
 * active (docs/PROTOCOL.md "Page on demand": "all providers, one shared
 * place — not per provider"). Thinking/reasoning events are never fed to
 * the detector — same treatment as the plain chat path above. `canTrigger`
 * is the caller's own cap policy: a marker it returns false for is still
 * never forwarded as text, but does NOT abort the stream — it is stripped,
 * handed to `onIgnored`, and the rest of the stream keeps flowing. Ollama's
 * `progress` notifications (startProgressTracking above) fire for every
 * call the on-demand loop makes.
 */
async function runOnDemandCall(
  ws: { send(data: string): unknown },
  active: Map<string, AbortController>,
  id: string,
  built: BuiltPrompt,
  provider: ModelProvider,
  providerOpts: ProviderRuntimeOptions,
  detectorOpts: { allowDev: boolean; allowSearch: boolean; refs?: ReadonlySet<string> },
  canTrigger: (marker: PageMarker) => boolean,
  onIgnored: (marker: PageMarker) => void,
): Promise<OnDemandCallResult> {
  const controller = new AbortController();
  active.set(id, controller);
  const progress = await startProgressTracking(ws, id, provider, providerOpts, controller.signal);
  const detector = new PageMarkerDetector(detectorOpts);
  let usage = { inputTokens: 0, outputTokens: 0 };
  let historyKept: number | undefined;
  let sent = false;
  const sendText = (text: string) => {
    if (text.length === 0) return;
    if (text.trim()) sent = true;
    send(ws, { type: "chunk", id, delta: text });
  };
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
          sendText(ev.text);
          continue;
        }
        if (canTrigger(ev.marker)) {
          controller.abort();
          return { outcome: "marker", usage, historyKept, marker: { marker: ev.marker, position: ev.position } };
        }
        // Beyond the caps: stripped and ignored — keep consuming the rest of
        // this same stream, never aborting, never requesting again.
        onIgnored(ev.marker);
      }
    }
    if (controller.signal.aborted) return { outcome: "cancelled", usage, historyKept };
    for (const ev of detector.flush()) {
      if (ev.kind === "text") sendText(ev.text);
    }
    return { outcome: "ok", usage, historyKept, empty: !sent };
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

/** What the page-on-demand loop needs from a `chat`. */
export interface OnDemandChat {
  id: string;
  text: string;
  page?: PageMeta;
  context?: Context;
  devMode?: boolean;
  history?: HistoryEntry[];
  abilities?: ChatAbility[];
  searchQuery?: string;
  pageUnreadable?: boolean;
}

/**
 * Entry point for a `chat` the model may answer by asking for the page or a
 * web search — see handleMessage's "chat" case (handlers/dispatch.ts), the
 * only caller. Gates exactly like any other chat/summarize (size,
 * concurrency, provider), then hands off to the async loop below.
 */
export function handleChatPageOnDemand(
  ws: { send(data: string): unknown },
  message: OnDemandChat,
  active: Map<string, AbortController>,
  settingsCtx: SettingsCtx,
  lang: Lang,
  connState: PageOnDemandConnState,
): void {
  const gated = gateStreamingRequest(ws, message, active, settingsCtx, {
    logType: "chat",
    logContextKind: message.context ? message.context.kind : "page",
    logTextLength: message.text.length,
    logPageKind: message.page?.kind ?? message.context?.pageKind,
    logFactsCount: 0,
    logItemsCount: 0,
    hasImage: false,
    tooLargeText: message.text,
  });
  if (!gated) return;
  const { provider, providerOpts, startedAt } = gated;
  void runChatPageOnDemandLoop(ws, message, active, provider, providerOpts, lang, connState, startedAt);
}

type PageReport = { level: "text" | "dev"; chars: number; sentChars: number; truncated: boolean };
type SearchReport = { queries: string[]; results: number; pages: number; chars: number; capped?: true };

/** The per-question budget of snippet and page characters: the smaller one for
 * a local model (Ollama, or an openai-compat server on a loopback address).
 * Exported for tests. */
export function searchCharBudget(provider: ModelProvider, providerOpts: ProviderRuntimeOptions): number {
  const local = provider.id === "ollama" || (provider.id === "openai-compat" && isLoopbackHost(providerOpts.baseUrl ?? ""));
  return local ? SEARCH_BUDGET_LOCAL_CHARS : SEARCH_BUDGET_ONLINE_CHARS;
}

/** Keeps the entries that still fit in `room` characters, in order; never cuts one. */
function fitBudget<T>(items: readonly T[], size: (t: T) => number, room: number): { kept: T[]; used: number; dropped: number } {
  const kept: T[] = [];
  let used = 0;
  for (const it of items) {
    if (used + size(it) > room) continue;
    kept.push(it);
    used += size(it);
  }
  return { kept, used, dropped: items.length - kept.length };
}

async function runChatPageOnDemandLoop(
  ws: { send(data: string): unknown },
  message: OnDemandChat,
  active: Map<string, AbortController>,
  provider: ModelProvider,
  providerOpts: ProviderRuntimeOptions,
  lang: Lang,
  connState: PageOnDemandConnState,
  startedAt: number,
): Promise<void> {
  const devMode = message.devMode === true;
  const canSearch = message.abilities?.includes("search") === true || message.searchQuery !== undefined;
  let totalUsage = { inputTokens: 0, outputTokens: 0 };
  let historyKept: number | undefined;
  let calls = 0;
  let reads = 0;
  let searches = 0;
  const usedLevels = new Set<"text" | "dev">();

  // Search state: S<n> numbers are the broker's, continuous over the question.
  const budget = searchCharBudget(provider, providerOpts);
  let searchChars = 0;
  const runs: SearchRun[] = [];
  const pages: SearchPageEntry[] = [];
  const queries: string[] = [];
  const resultUrls = new Map<number, string>();
  let resultCount = 0;
  const opened = new Set<number>();
  const searchNotes: string[] = [];
  let capped = false;

  // The last model call allowed is offered no marker, and any it writes is stripped.
  // `answerNow`: a reply made only of stripped markers gets one more call, offered none.
  let answerNow = false;
  const turnsLeft = () => !answerNow && calls < CHAT_MAX_MODEL_TURNS - 1;
  const roomLeft = () => searchChars < budget;
  const canTriggerRead = (level: "text" | "dev") => reads < 2 && !usedLevels.has(level);
  const openable = (refs: readonly number[]) =>
    refs.filter((n) => resultUrls.has(n) && !opened.has(n)).slice(0, Math.max(0, SEARCH_MAX_OPENED - opened.size));
  const canTrigger = (m: PageMarker) => {
    if (!turnsLeft()) return false;
    if (m.type === "read") return canTriggerRead(m.level);
    if (m.type === "search") return searches < SEARCH_MAX_PER_QUESTION && roomLeft();
    return openable(m.refs).length > 0 && roomLeft();
  };

  // What the re-run prompt is made of; every answer below updates one field.
  let pageContext = message.context;
  let pageRead = false;
  let declinedPageRead = false;
  let pageReport: PageReport | undefined;
  let suggest: string | undefined;

  const noteBudget = () => {
    if (!searchNotes.includes(SEARCH_BUDGET_NOTE)) searchNotes.push(SEARCH_BUDGET_NOTE);
  };

  const rebuild = () =>
    buildPrompt(
      {
        kind: "chat",
        text: message.text,
        page: pageContext || declinedPageRead ? undefined : message.page,
        context: pageContext,
        devMode,
        declinedPageRead,
        // After a text read, still offer the dev marker when devMode allows
        // it and dev hasn't been used yet; never after a dev read.
        offerDevRead: turnsLeft() && pageRead && devMode && canTriggerRead("dev"),
        search: runs.length > 0 ? { searches: runs, pages } : undefined,
        searchNotes,
        offerSearch: canSearch && turnsLeft() && searches < SEARCH_MAX_PER_QUESTION && roomLeft(),
        offerOpen: canSearch && turnsLeft() && openable([...resultUrls.keys()]).length > 0 && roomLeft(),
        history: message.history,
        pageUnreadable: message.pageUnreadable,
      },
      lang,
    );

  // A search the user asked for (the button) skips the first model call.
  let forced: PageMarker | undefined = message.searchQuery !== undefined ? { type: "search", query: message.searchQuery } : undefined;
  let built = rebuild();

  while (calls < CHAT_MAX_MODEL_TURNS) {
    let marker: PageMarker;
    let position: PageMarkerPosition = "start";
    if (forced) {
      marker = forced;
      forced = undefined;
    } else {
      const result = await runOnDemandCall(
        ws,
        active,
        message.id,
        built,
        provider,
        providerOpts,
        { allowDev: devMode, allowSearch: canSearch },
        canTrigger,
        (ignored) => {
          if (ignored.type === "search") {
            capped = true;
            if (suggest === undefined) suggest = ignored.query;
          } else if (ignored.type === "open" && ignored.refs.some((n) => resultUrls.has(n) && !opened.has(n))) {
            capped = true;
          }
        },
      );
      calls++;
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
      if (result.outcome === "ok" && result.empty && !answerNow && calls < CHAT_MAX_MODEL_TURNS && (runs.length > 0 || pageRead)) {
        answerNow = true;
        built = rebuild();
        continue;
      }
      if (result.outcome === "ok") {
        const searchReport: SearchReport | undefined =
          queries.length > 0
            ? { queries, results: resultUrls.size, pages: pages.length, chars: searchChars, ...(capped ? { capped: true as const } : {}) }
            : undefined;
        send(ws, {
          type: "done",
          id: message.id,
          usage: totalUsage,
          ...(historyKept !== undefined ? { historyKept } : {}),
          ...(pageReport ? { page: pageReport } : {}),
          ...(searchReport ? { search: searchReport } : {}),
          ...(suggest !== undefined ? { suggest: { search: suggest } } : {}),
        });
        logRequestCompleted(message.id, "ok", Date.now() - startedAt);
        return;
      }
      marker = result.marker!.marker;
      position = result.marker!.position;
    }

    // A marker: ask the client for the page, the search or the pages.
    let openRefs: number[] = [];
    let searchQuery = "";
    if (marker.type === "read") {
      reads++;
      usedLevels.add(marker.level);
    } else if (marker.type === "search") {
      searches++;
      searchQuery = marker.query;
    } else {
      openRefs = openable(marker.refs);
      for (const n of openRefs) opened.add(n);
    }
    if (connState.closed) {
      logRequestCompleted(message.id, "cancelled", Date.now() - startedAt);
      return;
    }
    const discard = position === "mid" ? { discard: true as const } : {};
    send(
      ws,
      marker.type === "read"
        ? { type: "page.request", id: message.id, level: marker.level, ...discard }
        : marker.type === "search"
          ? { type: "search.request", id: message.id, query: marker.query, ...discard }
          : { type: "open.request", id: message.id, refs: openRefs.map((n) => ({ n, url: resultUrls.get(n)! })), ...discard },
    );

    const waitController = new AbortController();
    active.set(message.id, waitController);
    const answer = await awaitClientAnswer(
      connState,
      message.id,
      waitController.signal,
      marker.type === "search" ? SEARCH_REQUEST_TIMEOUT_MS : PAGE_REQUEST_TIMEOUT_MS,
    );
    if (active.get(message.id) === waitController) active.delete(message.id);

    if (answer === "timeout") {
      send(ws, { type: "error", id: message.id, code: "page-unavailable", message: "the client did not answer the request in time" });
      logRequestCompleted(message.id, "error:page-unavailable", Date.now() - startedAt);
      return;
    }
    if (answer === "aborted" || connState.closed) {
      if (!connState.closed) send(ws, { type: "error", id: message.id, code: "cancelled", message: "request cancelled" });
      logRequestCompleted(message.id, "cancelled", Date.now() - startedAt);
      return;
    }

    // Protocol breach: an answer of the wrong kind, or a page level other than
    // the one requested — never silently accepted or coerced, same stance as
    // every other wire-shape mismatch (docs/PROTOCOL.md "bad-request").
    const mismatch =
      marker.type === "read"
        ? answer.kind === "content"
          ? answer.level !== marker.level && `page.content level "${answer.level}" does not match the requested level "${marker.level}"`
          : answer.kind !== "decline" && "expected page.content or page.decline"
        : marker.type === "search"
          ? answer.kind !== "search" && answer.kind !== "search-decline" && "expected search.content or search.decline"
          : answer.kind !== "open" && answer.kind !== "open-decline" && "expected open.content or open.decline";
    if (mismatch) {
      send(ws, { type: "error", id: message.id, code: "bad-request", message: mismatch });
      logRequestCompleted(message.id, "error:bad-request", Date.now() - startedAt);
      return;
    }

    if (answer.kind === "decline") {
      declinedPageRead = true;
    } else if (answer.kind === "search-decline") {
      searchNotes.push(searchDeclinedNote(answer.reason));
    } else if (answer.kind === "open-decline") {
      searchNotes.push(openFailedNote(openRefs, answer.reason));
    } else if (answer.kind === "search") {
      const error = searchContentError(answer.content);
      if (error) {
        send(ws, { type: "error", id: message.id, code: "context-too-large", message: error });
        logRequestCompleted(message.id, "error:context-too-large", Date.now() - startedAt);
        return;
      }
      // Every result received takes a number, shown or not, so the client
      // can number its sources the same way (results received so far + rank).
      const numbered = answer.content.results.map((r, i) => ({ ...r, n: resultCount + i + 1 }));
      resultCount += numbered.length;
      const fit = fitBudget(numbered, (r) => r.snippet.length, budget - searchChars);
      searchChars += fit.used;
      if (fit.dropped > 0) noteBudget();
      const results = fit.kept;
      for (const r of results) resultUrls.set(r.n, r.url);
      runs.push({ query: searchQuery, results });
      if (results.length > 0) queries.push(searchQuery);
    } else if (answer.kind === "open") {
      const error = openContentError(answer.pages, openRefs);
      if (error) {
        send(ws, { type: "error", id: message.id, code: error.code, message: error.message });
        logRequestCompleted(message.id, `error:${error.code}`, Date.now() - startedAt);
        return;
      }
      const fit = fitBudget(answer.pages, (p) => p.text.length, budget - searchChars);
      searchChars += fit.used;
      pages.push(...fit.kept);
      if (fit.dropped > 0) noteBudget();
      const missing = openRefs.filter((n) => !answer.pages.some((p) => p.n === n));
      if (missing.length > 0) searchNotes.push(openFailedNote(missing, "not read"));
    } else {
      const fit = await fitPageContent(answer.level, answer.context, provider, providerOpts);
      if (fit.error) {
        send(ws, { type: "error", id: message.id, code: "context-too-large", message: fit.error });
        logRequestCompleted(message.id, "error:context-too-large", Date.now() - startedAt);
        return;
      }
      pageReport = fit.report;
      pageContext = fit.context;
      pageRead = true;
    }
    built = rebuild();
  }
  // Unreachable: the last allowed call can trigger nothing, so it ends the loop above.
  send(ws, { type: "error", id: message.id, code: "internal", message: "too many model calls for one question" });
  logRequestCompleted(message.id, "error:internal", Date.now() - startedAt);
}
