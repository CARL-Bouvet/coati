// Coati side panel — conversation persistence (split of panel.js).
// Conversation state lives HERE (persisted to chrome.storage.local), never
// only in the background service worker's memory: the service worker can be
// killed and restarted at any time (see background/service-worker.js).
import { api } from "../lib/browser-compat.js";
import { applyRetention, RETENTION_DAYS_KEY, parseStoredRetentionDays } from "./retention.js";
import { panelState, STORAGE_KEY } from "./panel-state.js";
import { DEV_MODE_KEY, parseStoredDevMode } from "./dev-mode.js";

export async function loadConversation() {
  const data = await api.storage.local.get([STORAGE_KEY, DEV_MODE_KEY, RETENTION_DAYS_KEY]);
  panelState.devModePreference = parseStoredDevMode(data[DEV_MODE_KEY]);
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
  // `elementsSnapshot` is page-derived (element labels are text
  // read off the page) and tab/extraction-specific — kept in memory only,
  // same reasoning as `context`/`pendingRetries` (CLAUDE.md rule #1). Strip
  // it from the COPY written to chrome.storage.local; the in-memory
  // `conversation` objects (and their buttons, already rendered) keep it.
  // `pageReading` (page-request.js's transient "Reading the page…" status)
  // is mid-request-only, meaningless after a reload (activeRequestId itself
  // isn't persisted either) — stripped same as elementsSnapshot.
  const toStore = panelState.conversation.map(({ elementsSnapshot, pageReading, ...rest }) => rest);
  api.storage.local.set({
    [STORAGE_KEY]: toStore,
    [DEV_MODE_KEY]: panelState.devModePreference,
  });
}
