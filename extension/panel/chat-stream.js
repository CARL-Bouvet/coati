// Coati side panel — chat streaming (chunk/progress/done/
// error), split of panel.js. Handler bodies moved verbatim from
// handleBrokerMessage's switch in panel.js; only the "error" case's first
// four guard blocks (which touch model-status.js's own request ids) were
// extracted into model-status.js's interceptOwnError(), called first here —
// same checks, same order, same fall-through for modelSwitchRequestId.
import { t } from "../lib/i18n-page.js";
import { formatTokensK, estimateTokensFromChars, buildPageMention, nextReadPart } from "../lib/labels.js";
import { readProgressStage, slowTipFor } from "./model-advice.js";
import { panelState, ownRequests } from "./panel-state.js";
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

// What "Read the rest" resends, keyed by the id of the answer that left a part
// unread: `{ type, text, context }`. In-memory only (rule 17: the context is
// the page's own text), newest 3 kept — after a reload the button is absent.
export const readParts = new Map();
const MAX_READ_PARTS = 3;

export function rememberReadPart(id, { type, text, context }) {
  readParts.delete(id);
  readParts.set(id, { type, text, context });
  while (readParts.size > MAX_READ_PARTS) readParts.delete(readParts.keys().next().value);
}

// Last `done.historyKept` seen, across requests — in-memory only.
export let lastHistoryKept;

export function onChunk(message) {
  const msg = panelState.conversation.find((m) => m.id === message.id);
  if (msg) {
    if (!msg.text && message.delta) onFirstWord(msg);
    // The "Reading the page…" / "Searching…" status (page-request.js,
    // web-search.js) lasts until the model writes again. `readContent` keeps
    // the fact that something was read: its links are checked as such (T61).
    if (message.delta && msg.pageReading) {
      msg.pageReading = undefined;
      msg.readContent = true;
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
    renderMessage(msg);
  }
  if (panelState.activeRequestId === message.id) armRequestDeadline(message.id, 310_000);
}

/** Count and details under an answer that used a web search (docs/PROTOCOL.md "Search"). */
function buildSearchMention(message) {
  const s = message.search;
  if (!s) return undefined;
  const queries = Array.isArray(s.queries) ? s.queries : [];
  const text = t("panel_search_mention", [String(queries.length), String(s.pages), formatTokensK(estimateTokensFromChars(s.chars))]);
  return { text, queries, capped: s.capped === true };
}

export function onDone(message) {
  const sent = pendingRetries.get(message.id);
  pendingRetries.delete(message.id);
  ownRequests.delete(message.id);
  requestStarts.delete(message.id);
  clearPendingPageExtraction(message.id);
  if (typeof message.historyKept === "number") lastHistoryKept = message.historyKept;
  const msg = panelState.conversation.find((m) => m.id === message.id);
  if (msg) {
    msg.streaming = false;
    msg.progress = undefined;
    msg.pageReading = undefined;
    msg.pageMention = buildPageMention(msg.pageOnDemand === true, message);
    msg.readMore = nextReadPart(message.page);
    if (msg.readMore && sent?.context) rememberReadPart(message.id, sent);
    msg.searchMention = buildSearchMention(message);
    msg.suggestSearch = typeof message.suggest?.search === "string" ? message.suggest.search : undefined;
    renderMessage(msg);
    updateHistoryNotice();
    // modelEverAnswered first: the first-run card reads it to hide its "no model" subtitle.
    if (msg.role === "assistant" && msg.text && !panelState.modelEverAnswered) {
      panelState.modelEverAnswered = true;
      api.storage.local.set({ [MODEL_EVER_ANSWERED_KEY]: true }).catch(() => {});
      renderNeverConnected();
    }
    if (msg.role === "assistant" && msg.text && !panelState.modelAnswered) {
      panelState.modelAnswered = true;
      renderFirstRun();
    }
  }
  if (panelState.activeRequestId === message.id) setStreamingUi(false);
  persistConversation();
}

export function onError(message) {
  if (interceptOwnError(message)) return;
  if (!ownRequests.has(message.id)) return;
  ownRequests.delete(message.id);

  const text = describeBrokerError(message);
  const authRequired = message.code === "auth-required";
  const authKind = authRequired ? authKindFor(currentProvider) : undefined;
  const quotaExceeded = message.code === "quota-exceeded";
  const rateLimited = message.code === "rate-limited";
  const modelUnavailable = message.code === "model-unavailable";
  const providerOverloaded = message.code === "provider-overloaded";
  const modelMissing = message.code === "model-missing";
  const modelStalled = message.code === "model-stalled" || message.code === "model-timeout";
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
    renderMessage(msg);
  } else {
    addMessage({
      id: message.id,
      role: "system",
      text,
      authRequired,
      authKind,
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
