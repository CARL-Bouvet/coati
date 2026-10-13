// Coati side panel — request lifecycle: cancel, erase conversation, auth
// recovery, the client-message send + deadline/heartbeat watch (split of panel.js).
import { t } from "../lib/i18n-page.js";
import { api } from "../lib/browser-compat.js";
import { els } from "./dom-refs.js";
import { panelState, newId, STORAGE_KEY } from "./panel-state.js";
import { renderMessage, addMessage, renderAll, updateHistoryNotice } from "./message-render.js";
import { persistConversation } from "./conversation-store.js";
import { pendingRetries } from "./chat-stream.js";
import { currentModelEntry, currentProvider, currentProviderLinks, requestStarts, openProviderSettings } from "./model-status.js";
import { copyCommand } from "./first-run-wiring.js";
import { buildExternalLink, AUTH_REQUIRED_TEXT } from "./recovery-blocks.js";

// The correct claude-cli login command (modules/claude-cli/index.ts,
// AUTH_REQUIRED_MESSAGE) — not the REPL slash "/login" nor "--console" (that's
// for API-key accounts, not the subscription module).
const CLAUDE_CLI_LOGIN_COMMAND = "claude auth login --claudeai";

// Cancelling clears the in-flight state right away rather than waiting on the
// broker's "error"/cancelled reply (deliverable B1): that reply is exactly
// what might never arrive if we're cancelling because the connection is
// stuck. The protocol does define a "cancel" message (docs/PROTOCOL.md), so
// it is still sent best-effort in case the broker is in fact listening.
export function cancelActive() {
  if (!panelState.activeRequestId) return;
  const id = panelState.activeRequestId;
  pendingRetries.delete(id);
  api.runtime.sendMessage({
    type: "coati:client-message",
    payload: { type: "cancel", id: newId(), target: id },
  });
  const msg = panelState.conversation.find((m) => m.id === id);
  if (msg) {
    msg.streaming = false;
    // extension/panel/history.js reads this to exclude a cancelled turn from
    // the conversation memory sent to the model — set unconditionally, even
    // when a partial answer already streamed in (its text stays displayed,
    // it just never counts as a completed exchange).
    msg.cancelled = true;
    if (!msg.text) msg.text = t("panel_request_cancelled");
    renderMessage(msg);
  }
  setStreamingUi(false);
  persistConversation();
}

// --- Erase conversation ----------------------------------------------------
//
// One click erases at once; the history notice then offers "Undo" for
// ERASE_UNDO_MS. The erased array and retry map are held in memory only until
// the notice goes away (any re-render of the notice, or the timeout).
const ERASE_UNDO_MS = 10_000;
let erasedUndoTimer = null;

function clearUndoNotice() {
  clearTimeout(erasedUndoTimer);
  erasedUndoTimer = null;
  updateHistoryNotice();
}

function showUndoNotice(erased, erasedRetries) {
  const label = document.createElement("span");
  label.textContent = `${t("panel_conversation_cleared")} · `;
  const undo = document.createElement("button");
  undo.type = "button";
  undo.className = "link-button";
  undo.textContent = t("panel_undo");
  undo.addEventListener("click", () => {
    clearTimeout(erasedUndoTimer);
    erasedUndoTimer = null;
    if (panelState.conversation.length > 0) return updateHistoryNotice();
    panelState.conversation = erased;
    for (const [id, retry] of erasedRetries) pendingRetries.set(id, retry);
    persistConversation();
    renderAll();
  });
  els.historyNotice.replaceChildren(label, undo);
  els.historyNotice.hidden = false;
  clearTimeout(erasedUndoTimer);
  erasedUndoTimer = setTimeout(clearUndoNotice, ERASE_UNDO_MS);
}

export async function eraseConversation() {
  // Nothing to erase: a second click (double click) must not re-render the
  // notice and take the Undo button away.
  if (panelState.conversation.length === 0 && !panelState.activeRequestId) return;
  // Cancel any in-flight request first — its "chunk"/"done" replies must not
  // repopulate the conversation we are about to wipe.
  cancelActive();
  panelState.activeRequestId = null;
  setStreamingUi(false);

  const erased = panelState.conversation;
  const erasedRetries = new Map(pendingRetries);
  panelState.conversation = [];
  pendingRetries.clear();
  await api.storage.local.remove(STORAGE_KEY);
  persistConversation();
  renderAll();
  if (erased.length > 0) showUndoNotice(erased, erasedRetries);
}

// --- Auth recovery (deliverable D1) ---------------------------------------
//
// The broker's `auth-required` error (docs/PROTOCOL.md, "Model provider")
// means the local `claude` CLI session expired. We deliberately do
// NOT relay or drive the interactive `claude /login` flow (that decision is
// final, see the task brief) — the panel only makes the manual fix as cheap
// as possible: the exact command to copy, and a button that replays the
// request that just failed once the user says they ran it.

/** Builds the actionable block appended under an assistant/system message
 * whose terminal error was `auth-required`. No innerHTML — real DOM nodes,
 * same discipline as linkifyTimestamps() above. */
export function buildAuthRecoveryBlock(msg) {
  const block = document.createElement("div");
  block.className = "recovery-block";
  // Messages persisted before authKind existed were all claude-cli sessions.
  const kind = msg.authKind ?? "session";

  if (kind === "session") {
    // "claude auth login --claudeai"
    // — see modules/claude-cli/index.ts's AUTH_REQUIRED_MESSAGE, same command
    // (never the old REPL-only "/login" slash command, nor "--console",
    // which is for an API-key/console account, not this subscription module).
    const commandRow = document.createElement("div");
    commandRow.className = "recovery-command";
    const code = document.createElement("code");
    code.textContent = CLAUDE_CLI_LOGIN_COMMAND;
    const copyBtn = document.createElement("button");
    copyBtn.type = "button";
    copyBtn.className = "recovery-copy";
    copyBtn.textContent = AUTH_REQUIRED_TEXT.copy;
    copyBtn.addEventListener("click", () => copyLoginCommand(copyBtn));
    commandRow.appendChild(code);
    commandRow.appendChild(copyBtn);
    block.appendChild(commandRow);
    // Spec: also offer "Open settings", deep-linked to claude-cli's own
    // card (#provider-claude-cli) — the copy block alone used to be the only
    // way back in.
    const settingsBtn = document.createElement("button");
    settingsBtn.type = "button";
    settingsBtn.className = "recovery-copy";
    settingsBtn.textContent = AUTH_REQUIRED_TEXT.openSettings;
    settingsBtn.addEventListener("click", () => openProviderSettings("claude-cli"));
    block.appendChild(settingsBtn);
  } else {
    // API key (or unknown provider): the key lives in the broker, set from
    // the options page's own provider card — deep-linked directly rather than the generic tutorial.
    const settingsBtn = document.createElement("button");
    settingsBtn.type = "button";
    settingsBtn.className = "recovery-copy";
    settingsBtn.textContent = AUTH_REQUIRED_TEXT.openSettings;
    settingsBtn.addEventListener("click", () => openProviderSettings(currentProvider));
    block.appendChild(settingsBtn);
    // Spec: "Create a key at [Provider]" external link, when known.
    const links = currentProviderLinks();
    if (links?.keysUrl) block.appendChild(buildExternalLink(t("panel_create_key_at", [links.name]), links.keysUrl));
  }

  // Only offered when we still hold the payload to replay — lost across a
  // panel reload (pendingRetries is in-memory only), in which case the copy
  // button above remains the fallback: rerun the question by hand.
  if (pendingRetries.has(msg.id)) {
    const retryBtn = document.createElement("button");
    retryBtn.type = "button";
    retryBtn.className = "recovery-retry";
    retryBtn.textContent = kind === "session" ? AUTH_REQUIRED_TEXT.retrySession : AUTH_REQUIRED_TEXT.retryKey;
    retryBtn.disabled = !!panelState.activeRequestId;
    retryBtn.addEventListener("click", () => retryRequest(msg));
    block.appendChild(retryBtn);
  }

  return block;
}

export async function copyLoginCommand(button) {
  return copyCommand(button, CLAUDE_CLI_LOGIN_COMMAND);
}

/** Replays the request that ended in `auth-required`, reusing its own id —
 * by the time this can be clicked that id already reached a terminal state,
 * so the broker/service-worker no longer track anything under it. Sending it
 * again goes through the exact same path (sendToBroker's one-slot pending
 * queue, panel.js's request-watch deadline) as any first-time request —
 * no separate replay machinery (task brief, D1). */
export async function retryRequest(msg) {
  if (panelState.activeRequestId) return;
  const payload = pendingRetries.get(msg.id);
  if (!payload) return;

  msg.authRequired = false;
  msg.authKind = undefined;
  msg.rateLimited = false;
  msg.retryAfterSec = undefined;
  msg.slowTip = undefined;
  msg.cutNotice = undefined;
  msg.progress = undefined;
  msg.progressStartedAt = undefined; // same msg object restreams: the coati's 2s window starts over
  msg.text = "";
  msg.streaming = true;
  renderMessage(msg);

  panelState.activeRequestId = msg.id;
  setStreamingUi(true);
  persistConversation();

  await sendClientMessage({ ...payload, id: msg.id });
}

export function setStreamingUi(streaming) {
  els.send.disabled = streaming;
  els.cancel.hidden = !streaming;
  // Encart buttons and every "Relancer" already in the conversation: a
  // gesture-driven read must not overlap another in-flight request.
  for (const button of els.siteCardSuggestions.querySelectorAll("button")) button.disabled = streaming;
  for (const button of els.messages.querySelectorAll(".message-relaunch")) button.disabled = streaming;
  if (!streaming) {
    panelState.activeRequestId = null;
    clearRequestWatch();
  }
}

// --- Request watch (deliverables B1 + B4) ---------------------------------
//
// Armed right after a request is sent to the background, disarmed the moment
// streaming stops for any reason (done, error, cancel, or a disconnect — see
// setStreamingUi). Two independent guards run in parallel:
//   - a deadline, just past the broker's own 120s model timeout, for the
//     case where no reply — not even the broker's own error — ever arrives;
//   - a heartbeat that notices the service worker instance changed under us,
//     which means it was killed by the MV3 lifecycle mid-request and nothing
//     is coming for this id no matter how long we wait.

// Request-watch state (deliverables B1 + B4) — armed by startRequestWatch()
// right after a request is sent, disarmed by clearRequestWatch() whenever
// setStreamingUi(false) runs (done/error/cancel/disconnect all funnel there).
let requestDeadlineTimer = null;
let requestHeartbeatTimer = null;
let requestWorkerInstanceId = null; // service worker instance that accepted the current request, or null

/** Sends a `coati:client-message` request to the service worker and arms
 * the request-watch deadline with whatever `workerInstanceId` comes back in
 * the ack (or null if the send itself failed) — the shared tail of every
 * place that kicks off a chat/summarize request or replays one. */
export async function sendClientMessage(payload) {
  // When it left and which model answers it: the slow-answer tip
  // (model-advice.js) needs both once the first word or an error arrives.
  requestStarts.set(payload.id, { at: Date.now(), entry: currentModelEntry() });
  const ack = await api.runtime.sendMessage({ type: "coati:client-message", payload }).catch(() => null);
  startRequestWatch(payload.id, ack?.workerInstanceId ?? null);
}

export function startRequestWatch(id, workerInstanceId) {
  clearRequestWatch();
  requestWorkerInstanceId = workerInstanceId;
  // Client-side deadline for an in-flight request (deliverable B1), set just
  // PAST the local program's own delays (point
  // 7: up to 300 s before the first word) so its specific error wins the
  // race — this generic deadline only fires for an answer that never arrives
  // at all (socket dropped mid-request). Re-armed by every `progress`/`chunk`
  // (chat-stream.js), same 310_000/70_000 ms split as there.
  armRequestDeadline(id, 310_000);
  // How often the panel checks that the service worker instance which
  // accepted the current request is still the same one (deliverable B4).
  requestHeartbeatTimer = setInterval(() => checkWorkerAlive(id), 5_000);
}

/** (Re)starts the generic deadline — a `progress` or `chunk` proves the
 * local program is still there. */
export function armRequestDeadline(id, ms) {
  clearTimeout(requestDeadlineTimer);
  requestDeadlineTimer = setTimeout(() => onRequestDeadline(id), ms);
}

export function clearRequestWatch() {
  clearTimeout(requestDeadlineTimer);
  clearInterval(requestHeartbeatTimer);
  requestDeadlineTimer = null;
  requestHeartbeatTimer = null;
  requestWorkerInstanceId = null;
}

async function checkWorkerAlive(id) {
  if (panelState.activeRequestId !== id) return;
  const status = await api.runtime.sendMessage({ type: "coati:get-status" }).catch(() => null);
  if (!status || panelState.activeRequestId !== id) return;
  if (
    requestWorkerInstanceId &&
    status.workerInstanceId &&
    status.workerInstanceId !== requestWorkerInstanceId
  ) {
    failActiveRequest(id, t("panel_worker_restarted"));
  }
}

function onRequestDeadline(id) {
  if (panelState.activeRequestId !== id) return;
  failActiveRequest(id, t("panel_no_response"));
}

function failActiveRequest(id, text) {
  const msg = panelState.conversation.find((m) => m.id === id);
  if (msg) {
    msg.streaming = false;
    if (!msg.text) msg.text = `⚠ ${text}`;
    renderMessage(msg);
  } else {
    addMessage({ id: newId(), role: "system", text: `⚠ ${text}` });
  }
  if (panelState.activeRequestId === id) setStreamingUi(false);
  persistConversation();
}
