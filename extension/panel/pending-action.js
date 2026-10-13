// Coati side panel — context-menu "act" actions stashed by service-worker.js
// (split of panel.js).
import { t } from "../lib/i18n-page.js";
import { api } from "../lib/browser-compat.js";
import { panelState, newId, PENDING_ACTION_KEY } from "./panel-state.js";
import { addMessage } from "./message-render.js";
import { persistConversation } from "./conversation-store.js";
import { setStreamingUi, sendClientMessage } from "./request-watch.js";
import { pendingRetries } from "./chat-stream.js";

/** Reads and clears the stash left by the context-menu click, then runs it.
 * See the comment above chrome.contextMenus.onClicked in service-worker.js:
 * called both on panel load and on the "coati:pending-action" broadcast,
 * whichever comes first — reading it here removes it, so the other caller
 * finds nothing and no-ops. */
export async function drainPendingAction() {
  const data = await api.storage.session.get(PENDING_ACTION_KEY);
  const pending = data[PENDING_ACTION_KEY];
  if (!pending) return;
  await api.storage.session.remove(PENDING_ACTION_KEY);
  runAct(pending);
}

export async function runAct(pending) {
  const { action, label, params, selectionText } = pending;
  if (!selectionText) return;
  if (panelState.activeRequestId) {
    addMessage({ id: newId(), role: "system", text: t("panel_request_in_progress") });
    return;
  }

  const id = newId();
  addMessage({ id: `${id}-u`, role: "user", text: `${label} : « ${truncateForDisplay(selectionText)} »` });
  addMessage({ id, role: "assistant", text: "", streaming: true });

  panelState.activeRequestId = id;
  setStreamingUi(true);
  persistConversation();

  pendingRetries.set(id, { type: "act", action, text: selectionText, params });
  await sendClientMessage({ type: "act", id, action, text: selectionText, params });
}

export function truncateForDisplay(text, max = 220) {
  const trimmed = text.trim();
  return trimmed.length > max ? `${trimmed.slice(0, max)}…` : trimmed;
}
