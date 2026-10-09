// Coati side panel — conversation persistence (lot F3 split of panel.js).
// Conversation state lives HERE (persisted to chrome.storage.local), never
// only in the background service worker's memory: the service worker can be
// killed and restarted at any time (see background/service-worker.js).
import { api } from "../lib/browser-compat.js";
import { applyRetention, RETENTION_DAYS_KEY, parseStoredRetentionDays } from "./retention.js";
import { panelState, STORAGE_KEY, ATTACH_PAGE_KEY, ATTACH_SCREEN_KEY } from "./panel-state.js";

export async function loadConversation() {
  const data = await api.storage.local.get([STORAGE_KEY, ATTACH_PAGE_KEY, ATTACH_SCREEN_KEY, RETENTION_DAYS_KEY]);
  panelState.attachPagePreference = typeof data[ATTACH_PAGE_KEY] === "boolean" ? data[ATTACH_PAGE_KEY] : null;
  panelState.attachScreenPreference = data[ATTACH_SCREEN_KEY] === true;
  const retentionDays = parseStoredRetentionDays(data[RETENTION_DAYS_KEY]);
  const raw = Array.isArray(data[STORAGE_KEY]) ? data[STORAGE_KEY] : [];
  const filtered = applyRetention(raw, retentionDays);
  if (filtered.length !== raw.length || filtered.some((msg, i) => msg.ts !== raw[i]?.ts)) {
    // Persist the migration (stamped timestamps) and the expiry (dropped
    // messages) right away, so a crash before the next save doesn't re-show
    // messages that should have expired.
    api.storage.local.set({ [STORAGE_KEY]: filtered });
  }
  return filtered;
}

export function persistConversation() {
  // `elementsSnapshot` (Lot A2) is page-derived (element labels are text
  // read off the page) and tab/extraction-specific — kept in memory only,
  // same reasoning as `context`/`pendingRetries` (CLAUDE.md rule #1). Strip
  // it from the COPY written to chrome.storage.local; the in-memory
  // `conversation` objects (and their buttons, already rendered) keep it.
  const toStore = panelState.conversation.map((msg) => {
    if (!msg.elementsSnapshot) return msg;
    const { elementsSnapshot, ...rest } = msg;
    return rest;
  });
  api.storage.local.set({
    [STORAGE_KEY]: toStore,
    [ATTACH_PAGE_KEY]: panelState.attachPagePreference,
    [ATTACH_SCREEN_KEY]: panelState.attachScreenPreference,
  });
}
