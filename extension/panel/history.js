// Coati side panel — "historique" (conversation memory), docs/PROTOCOL.md.
//
// Pure, DOM-free: builds the `chat.history` wire payload from the panel's
// own `conversation` array, and decides when to show the discreet "long
// conversation" / "dropped" notice above the composer. Kept separate from
// panel.js the same way element-refs.js already is (plan-montrer-voir-
// chercher-08-10.md's own split) — no chrome.*, no DOM, unit-testable with a
// plain array of plain objects.
//
// Only `chat` (sendChatMessage) ever ATTACHES `history` on the wire — a
// summarize request never does (docs/PROTOCOL.md). This module's own
// scan of `conversation`, though, is generic: a summarize- or act-triggered
// exchange counts exactly like a chat one for pairing/alert purposes, since
// the product decision is "the model remembers the conversation SHOWN in
// the panel" — not "the chat messages only".

/** Panel-side cap, in EXCHANGES (user+assistant pairs) — the wire's own
 * HISTORY_MAX_ENTRIES (20, broker/src/protocol.ts) is twice this, a
 * backstop that should never actually trigger given this cap runs first. */
export const HISTORY_MAX_EXCHANGES = 10;

/** From this many exchanges onward (inclusive), the "conversation longue"
 * notice shows even if nothing has been dropped yet. */
export const LONG_CONVERSATION_FROM_EXCHANGES = 8;

/** True when `msg` (an assistant/system turn from `conversation`) is a
 * terminal FAILURE or an in-progress/cancelled turn — never eligible as the
 * answer half of a history exchange (docs/PROTOCOL.md: "a cancelled or
 * failed answer is not sent"). Mirrors the flags panel.js's own
 * handleBrokerMessage sets on the "error" case, plus `cancelled`
 * (cancelActive()) and `streaming` (still running). */
function isFailedOrPending(msg) {
  return !!(
    msg.streaming ||
    msg.cancelled ||
    msg.authRequired ||
    msg.quotaExceeded ||
    msg.rateLimited ||
    msg.modelUnavailable ||
    msg.providerOverloaded ||
    msg.modelMissing ||
    msg.modelStalled
  );
}

/** The clean, displayed-marker-free text of a user turn. Prefers
 * `msg.relaunch.text` (the exact original argument to sendChatMessage(),
 * stored BEFORE the "+page"/"+screen" note suffix was appended to
 * `msg.text` for display — see panel.js's sendChatMessage/
 * PAGE_CONTENT_MARKER_SUFFIX) over `msg.text` itself. Falls back to
 * `msg.text` verbatim for a summarize-triggered turn (relaunch.type ===
 * "summarize", already clean — no note is ever appended to it) or for a
 * legacy/relaunch-less message (rare: predates the "Relancer" feature) —
 * that fallback may still carry the note suffix, a known, accepted
 * approximation (stripping it here would need panel.js's own i18n'd
 * PAGE_CONTENT_MARKER_SUFFIX, which this pure module deliberately does not
 * import). */
function userTextOf(msg) {
  if (msg.relaunch && msg.relaunch.type === "chat" && typeof msg.relaunch.text === "string") {
    return msg.relaunch.text;
  }
  return msg.text;
}

/**
 * Walks `conversation` once, pairing each "user" message with the NEXT
 * "assistant" message (notice/system messages in between are skipped,
 * never break a pending pair). A pair is kept only when the assistant half
 * completed successfully with non-empty text (isFailedOrPending false) —
 * a failed/cancelled/still-streaming answer still CONSUMES the pending user
 * turn (it closes the exchange either way), it just isn't added to the
 * result.
 *
 * @param {Array<object>} conversation
 * @returns {Array<{userText: string, assistantText: string}>} oldest first
 */
export function extractExchanges(conversation) {
  const exchanges = [];
  let pendingUserText = null;
  for (const msg of conversation ?? []) {
    if (!msg || typeof msg !== "object") continue;
    if (msg.role === "user") {
      pendingUserText = userTextOf(msg);
      continue;
    }
    if (msg.role === "assistant") {
      if (pendingUserText != null && !isFailedOrPending(msg) && msg.text) {
        exchanges.push({ userText: pendingUserText, assistantText: msg.text });
      }
      pendingUserText = null;
    }
    // Any other role (notice/system): ignored, pendingUserText untouched.
  }
  return exchanges;
}

/**
 * Builds the `chat.history` wire payload (docs/PROTOCOL.md) from the panel's `conversation` — capped to the last
 * HISTORY_MAX_EXCHANGES exchanges, oldest dropped first. `entries` is `[]`
 * (never attach the field at all — see panel.js's sendChatMessage) when
 * there is nothing eligible yet.
 *
 * @param {Array<object>} conversation
 * @returns {{entries: Array<{role: "user"|"assistant", text: string}>, totalExchanges: number, sentExchanges: number}}
 */
export function buildHistoryForWire(conversation) {
  const exchanges = extractExchanges(conversation);
  const kept = exchanges.slice(-HISTORY_MAX_EXCHANGES);
  const entries = [];
  for (const ex of kept) {
    entries.push({ role: "user", text: ex.userText });
    entries.push({ role: "assistant", text: ex.assistantText });
  }
  return { entries, totalExchanges: exchanges.length, sentExchanges: kept.length };
}

/**
 * Decides which discreet notice (if any) belongs above the composer right
 * now (docs/PROTOCOL.md). `historyKept` is the broker's own last-known
 * `done.historyKept` (undefined if no chat with history has completed yet,
 * or the feature isn't negotiated).
 *
 * - "dropped": either the panel's own 10-exchange cap already left some
 *   out (`totalExchanges > sentExchanges`), or the broker's last answer
 *   reports it kept fewer entries than were sent.
 * - "long": `totalExchanges` has reached LONG_CONVERSATION_FROM_EXCHANGES,
 *   and nothing above already applies (dropped implies long too, but gets
 *   the more specific wording).
 * - null: neither — notice stays hidden.
 *
 * @param {{totalExchanges: number, sentExchanges: number, historyKept?: number}} state
 * @returns {"dropped" | "long" | null}
 */
export function historyAlertState({ totalExchanges, sentExchanges, historyKept }) {
  const sentEntries = sentExchanges * 2;
  const droppedByPanelCap = totalExchanges > sentExchanges;
  const droppedByProvider = typeof historyKept === "number" && historyKept < sentEntries;
  if (droppedByPanelCap || droppedByProvider) return "dropped";
  if (totalExchanges >= LONG_CONVERSATION_FROM_EXCHANGES) return "long";
  return null;
}

/** True when page content or search results reached the model in `messages`
 * (a title offered on demand does not count: see `linkContext`). */
export function readUntrustedIn(messages) {
  return messages.some(
    (m) => m.readsPage === true || m.pageRead === true || m.readContent === true || !!m.pageReading || !!m.sources?.length || !!m.searchMention,
  );
}

/** True when a page's content was read in `messages`: attached up front,
 * read on request, or an opened result. */
export function pageReadIn(messages) {
  return messages.some((m) => m.readsPage === true || m.pageRead === true);
}
