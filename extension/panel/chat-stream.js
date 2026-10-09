// Coati side panel — chat streaming (chunk/progress/search.status/done/
// error), lot F3 split of panel.js. Handler bodies moved verbatim from
// handleBrokerMessage's switch in panel.js; only the "error" case's first
// four guard blocks (which touch model-status.js's own request ids) were
// extracted into model-status.js's interceptOwnError(), called first here —
// same checks, same order, same fall-through for modelSwitchRequestId.
import { t } from "../lib/i18n-page.js";
import { formatTokensK } from "../lib/labels.js";
import { readProgressStage, COATI_VISIBLE_MS, slowTipFor } from "./model-advice.js";
import { panelState } from "./panel-state.js";
import { els } from "./dom-refs.js";
import { renderMessage, addMessage } from "./message-render.js";
import { armRequestDeadline, setStreamingUi } from "./request-watch.js";
import { persistConversation } from "./conversation-store.js";
import { updateHistoryNotice } from "./message-render.js";
import { onFirstWord, currentModelEntry, currentGroupedModels, interceptOwnError, requestStarts, currentProvider } from "./model-status.js";
import { describeBrokerError, authKindFor } from "./recovery-blocks.js";
import { renderFirstRun, renderNeverConnected } from "./first-run-wiring.js";
import { MODEL_EVER_ANSWERED_KEY } from "./first-run.js";
import { api } from "../lib/browser-compat.js";
import { clearPendingPageExtraction } from "./composer-send.js";

// Replay payloads for the "I restarted it, retry" recovery button
// (deliverable D1) — keyed by request id, in-memory only (never persisted to
// chrome.storage.local: it can hold page content). Only kept for a request
// that ended in "auth-required" or "rate-limited": any other terminal
// outcome drops its entry, so this never grows unbounded over a long session.
export const pendingRetries = new Map();

// Amendement 2026-10-08 bis ("historique", docs/PROTOCOL.md §4). Last
// `done.historyKept` seen, across requests — in-memory only.
export let lastHistoryKept;

export function onChunk(message) {
  const msg = panelState.conversation.find((m) => m.id === message.id);
  if (msg) {
    if (!msg.text && message.delta) {
      onFirstWord(msg);
      // The "Reading the page…" status (page-request.js) is a stand-in for
      // the empty bubble, same lifetime as the progress stage it sits
      // alongside — real text arriving ends it.
      msg.pageReading = undefined;
    }
    msg.text += message.delta ?? "";
    renderMessage(msg);
  }
  if (panelState.activeRequestId === message.id) armRequestDeadline(message.id, 70_000);
}

export function onProgress(message) {
  const stage = readProgressStage(message.stage);
  const msg = panelState.conversation.find((m) => m.id === message.id);
  if (stage && msg?.streaming && !msg.text) {
    msg.progress = stage;
    if (!msg.progressStartedAt) {
      msg.progressStartedAt = Date.now();
      setTimeout(() => {
        if (msg.progress) renderMessage(msg);
      }, COATI_VISIBLE_MS);
    }
    renderMessage(msg);
  }
  if (panelState.activeRequestId === message.id) armRequestDeadline(message.id, 310_000);
}

export function onSearchStatus(message) {
  const msg = panelState.conversation.find((m) => m.id === message.id);
  if (msg) {
    msg.searchStatus = {
      stage: message.stage,
      scope: typeof message.scope === "string" ? message.scope : null,
      engine: message.engine,
      sources: Array.isArray(message.sources) ? message.sources : msg.searchStatus?.sources,
      query: typeof message.query === "string" ? message.query : msg.searchStatus?.query,
    };
    renderMessage(msg);
  }
  if (panelState.activeRequestId === message.id) armRequestDeadline(message.id, 310_000);
}

/** docs/PROTOCOL.md "Page on demand", point 5 of the task brief — the
 * discreet mention line under a finished answer. Only ever set on a message
 * that took the metadata-only path (`msg.pageOnDemand`, composer-send.js) —
 * never for summarize/act (no such path exists for them) nor for the
 * no-"pageOnDemand"-feature fallback (full `context` sent directly: `done
 * .page` is then structurally absent broker-side, and "Did not read the
 * page" would be a misleading thing to say about an answer that in fact had
 * the whole page from the start). */
function buildPageMention(msg, message) {
  if (!msg.pageOnDemand) return undefined;
  const usage = message.usage || {};
  const kTokens = formatTokensK((usage.inputTokens || 0) + (usage.outputTokens || 0));
  if (!message.page) return t("panel_page_mention_not_read", [kTokens]);
  const base =
    message.page.level === "dev"
      ? t("panel_page_mention_read_dev", [kTokens])
      : t("panel_page_mention_read_text", [kTokens]);
  if (!message.page.truncated || !message.page.chars) return base;
  const percent = Math.round((message.page.sentChars / message.page.chars) * 100);
  return base + t("panel_page_mention_truncated_suffix", [percent]);
}

export function onDone(message) {
  pendingRetries.delete(message.id);
  requestStarts.delete(message.id);
  clearPendingPageExtraction(message.id);
  if (typeof message.historyKept === "number") lastHistoryKept = message.historyKept;
  const msg = panelState.conversation.find((m) => m.id === message.id);
  if (msg) {
    msg.streaming = false;
    msg.progress = undefined;
    msg.pageReading = undefined;
    msg.pageMention = buildPageMention(msg, message);
    renderMessage(msg);
    updateHistoryNotice();
    if (msg.role === "assistant" && msg.text && !panelState.modelAnswered) {
      panelState.modelAnswered = true;
      renderFirstRun();
    }
    if (msg.role === "assistant" && msg.text && !panelState.modelEverAnswered) {
      panelState.modelEverAnswered = true;
      api.storage.local.set({ [MODEL_EVER_ANSWERED_KEY]: true }).catch(() => {});
      renderNeverConnected();
    }
  }
  if (panelState.activeRequestId === message.id) setStreamingUi(false);
  persistConversation();
}

export function onError(message) {
  if (interceptOwnError(message)) return;

  const text = describeBrokerError(message);
  const authRequired = message.code === "auth-required";
  const authKind = authRequired ? authKindFor(currentProvider) : undefined;
  const quotaExceeded = message.code === "quota-exceeded";
  const rateLimited = message.code === "rate-limited";
  const modelUnavailable = message.code === "model-unavailable";
  const providerOverloaded = message.code === "provider-overloaded";
  const modelMissing = message.code === "model-missing";
  const modelStalled = message.code === "model-stalled" || message.code === "model-timeout";
  const searchNotConfigured = message.code === "search-not-configured";
  const start = requestStarts.get(message.id);
  requestStarts.delete(message.id);
  const slowTip = modelStalled ? (slowTipFor(start?.entry ?? currentModelEntry(), currentGroupedModels()) ?? undefined) : undefined;
  const retryAfterSec =
    rateLimited && Number.isFinite(message.retryAfterSec) && message.retryAfterSec > 0 ? message.retryAfterSec : undefined;
  const keepsRetryPayload =
    authRequired || rateLimited || quotaExceeded || providerOverloaded || modelUnavailable || modelStalled;
  if (!keepsRetryPayload) {
    pendingRetries.delete(message.id);
    // A kept retry payload may still need its stashed extraction for a
    // future `page.request` text-level answer — only drop it once nothing
    // will ever retry this id again.
    clearPendingPageExtraction(message.id);
  }
  if (panelState.activeRequestId === message.id) setStreamingUi(false);
  const msg = panelState.conversation.find((m) => m.id === message.id);
  if (msg) {
    msg.streaming = false;
    msg.progress = undefined;
    msg.pageReading = undefined;
    if (modelStalled && msg.text) msg.cutNotice = text;
    msg.text = msg.text || text;
    msg.modelStalled = modelStalled;
    if (slowTip) msg.slowTip = slowTip;
    msg.authRequired = authRequired;
    msg.authKind = authKind;
    msg.quotaExceeded = quotaExceeded;
    msg.rateLimited = rateLimited;
    msg.retryAfterSec = retryAfterSec;
    msg.modelUnavailable = modelUnavailable;
    msg.providerOverloaded = providerOverloaded;
    msg.modelMissing = modelMissing;
    msg.searchNotConfigured = searchNotConfigured;
    renderMessage(msg);
  } else {
    addMessage({
      id: message.id,
      role: "system",
      text,
      authRequired,
      authKind,
      searchNotConfigured,
      quotaExceeded,
      rateLimited,
      retryAfterSec,
      modelUnavailable,
      providerOverloaded,
      modelMissing,
      modelStalled,
      slowTip,
    });
  }
  persistConversation();
}
