// Coati side panel — chat send path: page extraction/attachment (now always
// attempted when a tab is open — see extractForChat()'s own comment, the
// "Read the page" switch it used to be gated on is gone), the shared
// sendChatMessage() tail, site-card suggestions (lot F3 split of panel.js).
import { t } from "../lib/i18n-page.js";
import { api } from "../lib/browser-compat.js";
import { els } from "./dom-refs.js";
import { panelState, newId } from "./panel-state.js";
import { ACCESS_DENIED_HINT } from "../lib/labels.js";
import { currentTabId, resizeComposer } from "./panel.js";
import { extractReadableFromTab, extractFromTab, reportExtractionError, openYouTubeTranscript } from "./page-extract.js";
import { stripReadability } from "./unreadable.js";
import { addMessage } from "./message-render.js";
import { persistConversation } from "./conversation-store.js";
import { setStreamingUi, sendClientMessage } from "./request-watch.js";
import { hasFeature } from "./model-status.js";
import { buildHistoryForWire } from "./history.js";
import { prepareContextForWire } from "./element-refs.js";
import { pendingRetries } from "./chat-stream.js";
import { updateSavePromptEnabled } from "./prompts-wiring.js";
import { PAGE_CONTENT_MARKER_SUFFIX } from "./message-render.js";

// Shown at most once per panel session (plan: "main frame only:
// iframes are not numbered — announced limitation").
let frameLimitNoticeShown = false;

// --- Chat ---------------------------------------------------------------

/** Full extraction kept in memory, keyed by the `chat` id it was sent for
 * (lot "page on demand" — docs/PROTOCOL.md "Page on demand") — only the
 * metadata (`page: {title,url,kind,chars}`) goes on the wire up front; this
 * is what answers a later `page.request { level: "text" }` without reading
 * the page a second time. Never persisted to chrome.storage.local (CLAUDE.md
 * rule #1: it can hold the page's own text) — in-memory only, same
 * reasoning as `pendingRetries` (chat-stream.js). */
export const pendingPageExtractions = new Map();

/** Drops a stashed extraction once it can no longer be needed: the question
 * reached a terminal state that isn't being retried (done, or an error that
 * doesn't keep a retry payload — see chat-stream.js's onDone/onError). */
export function clearPendingPageExtraction(id) {
  pendingPageExtractions.delete(id);
}

/** Reads the page when a tab is open, else resolves to `undefined` — the
 * shared "do we have a page to offer" check for sendChat() and
 * relaunchMessage() (both read the CURRENT tab, never a cached copy from the
 * original send). Throws on an extraction failure; the caller reports it via
 * reportExtractionError(). No more "Read the page" switch to gate this on
 * (removed, see docs/PROTOCOL.md "Page on demand" — a chat now always offers
 * the page it can see, and the model decides whether it actually needs it). */
export async function extractForChat() {
  return currentTabId != null ? extractReadableFromTab(currentTabId) : undefined;
}

export async function sendChat() {
  const text = els.input.value.trim();
  if (!text || panelState.activeRequestId) return;

  // Extract at send time only — never on every keystroke.
  let context;
  try {
    context = await extractForChat();
  } catch (err) {
    // No switch to turn page reading off any more: an unreadable tab must
    // never block a question. Say why the page is out of reach, then send
    // the question without it (the model answers, or says it needs the page).
    reportExtractionError(err, {
      accessDenied: t("panel_access_denied_sent", [ACCESS_DENIED_HINT]),
      other: (e) => t("panel_read_error_sent", [e.message]),
    });
    context = undefined;
  }

  const text0 = text;
  els.input.value = "";
  resizeComposer();
  updateSavePromptEnabled();
  // Page-on-demand branch (docs/PROTOCOL.md "Page on demand"): only the
  // composer's own Send button takes it — summarize()/runSuggestion()/a
  // relaunch keep attaching `context` directly ("exactly as today"), by
  // simply never passing a 3rd argument to sendChatMessage() below.
  if (context && hasFeature("pageOnDemand")) {
    await sendChatMessage(text0, undefined, context);
  } else {
    await sendChatMessage(text0, context);
  }
}

/** Amendement 2026-10-08 bis ("recherche sur demande explicite" —
 * docs/PROTOCOL.md §6, no more "Search the docs" button): origin only
 * (§6 — "never the path nor the query string"), and only for an http(s) tab
 * (a chrome://, file:// or extension page has no "doc site" to search).
 * Resolved fresh at SEND time (called from sendChatMessage() below). */
export async function activeTabDocSearchOrigin() {
  if (currentTabId == null) return null;
  let tab = null;
  try {
    tab = await api.tabs.get(currentTabId);
  } catch {
    return null;
  }
  try {
    const url = new URL(tab?.url ?? "");
    return url.protocol === "http:" || url.protocol === "https:" ? url.origin : null;
  } catch {
    return null;
  }
}

/** Builds the `page` metadata-only payload (docs/PROTOCOL.md "Page on
 * demand") from a full extraction — `kind` is the PageMeta variant
 * (list/listing/article/other), never Context.kind ("page"/"youtube"): a
 * YouTube extraction has no such field, so `kind` is simply omitted (the
 * broker's own parsePageMeta treats it as optional). */
function pageMetaFor(context) {
  const meta = { title: context.title || "", url: context.url || "", chars: (context.text || "").length };
  if (context.kind === "page" && typeof context.pageKind === "string") meta.kind = context.pageKind;
  return meta;
}

/** Shared tail of "send a chat message, with or without the page attached" —
 * used by sendChat() (the composer's Send button), runSuggestion() (a
 * site-card suggestion click, always attached — see its own comment) and
 * relaunchMessage() (message-render.js). `context` is sent as-is (today's
 * behaviour, full page content up front) UNLESS the broker offers
 * "pageOnDemand" and the caller passed none of its own screen/image —
 * sendChat() is the only caller that takes that branch, by never reaching
 * here with a direct `context` in the first place (see below).
 *
 * `extraction`, only ever set by sendChat() (summarize/suggestions/relaunch
 * never pass it — they keep sending `context` directly, "exactly as
 * today"), is the FULL extraction `context` came from; when `hasFeature
 * ("pageOnDemand")` is true, the wire gets `page` (metadata only) instead of
 * `context`, and `extraction` is stashed for a later `page.request`. */
export async function sendChatMessage(text, context, extraction) {
  const id = newId();
  // Amendement 2026-10-08 bis ("historique", docs/PROTOCOL.md): computed
  // from `conversation` BEFORE the two addMessage() calls below push this
  // turn's own user/assistant placeholders onto it — history is the PAST
  // exchanges only, never this one. Gated on the negotiated capability,
  // same pattern as `elements`/`vision`/`docsearch` above/below.
  const history = hasFeature("history") ? buildHistoryForWire(panelState.conversation) : null;

  // The page-on-demand branch: only sendChat() ever passes `extraction`, and
  // only when the broker actually understands it — otherwise `context` (set
  // by sendChat() itself in that case) carries the page exactly as before.
  const pageOnDemand = !!extraction && hasFeature("pageOnDemand");
  const wirePage = pageOnDemand ? pageMetaFor(extraction) : undefined;
  const wireContext = pageOnDemand ? undefined : prepareContextForWire(context, hasFeature("elements"));
  if (pageOnDemand) pendingPageExtractions.set(id, extraction);

  // No marker for the page-on-demand branch: the page's content wasn't
  // actually attached, only offered — the done.page mention line under the
  // finished answer (chat-stream.js) says what actually happened instead.
  const note = wireContext ? PAGE_CONTENT_MARKER_SUFFIX : "";
  // `relaunch` (plan-mes-prompts-28-09.md, "Relancer"): resending this exact
  // message means resending `text` through this same function, reading the
  // CURRENT page fresh — never a cached copy of `context`, which can hold
  // page content (kept out of chrome.storage.local, same reasoning as
  // context.url elsewhere).
  addMessage({ id: `${id}-u`, role: "user", text: `${text}${note}`, relaunch: { type: "chat", text } });
  // elementsSnapshot: see its own comment above `frameLimitNoticeShown` —
  // THIS message's own {extractionId, elements}, computed now, never read
  // back from a shared variable later. `pageOnDemand` gates the done.page
  // mention line (chat-stream.js's onDone) — never shown for a message that
  // got the page directly (today's always-attach fallback, summarize, a
  // suggestion): done.page is structurally absent for those broker-side, so
  // showing "Did not read the page" there would be misleading, not useful.
  addMessage({
    id,
    role: "assistant",
    text: "",
    streaming: true,
    readsPage: !pageOnDemand && !!context,
    pageOnDemand,
    elementsSnapshot: buildElementsSnapshot(context),
  });

  panelState.activeRequestId = id;
  setStreamingUi(true);
  persistConversation();

  // Amendment "page on demand": offers the dev marker on top of the text
  // one — meaningless without `page`, so only ever sent alongside it.
  const wireDevMode = pageOnDemand ? panelState.devModePreference : undefined;
  // Amendement 2026-10-08 bis: there is no more "Search the docs" button, so
  // `chat.docSearch` is no longer a caller-supplied param — it's resolved
  // fresh HERE, on every chat, straight from the current tab. It no longer
  // requests a search; it only tells the broker a search is ALLOWED for this
  // origin — whether one actually runs is decided broker-side.
  const origin = hasFeature("docsearch") ? await activeTabDocSearchOrigin() : null;
  const wireDocSearch = origin ? { origin } : undefined;
  // Amendment 2026-10-08 bis: omitted entirely (never an empty array) when
  // there is nothing eligible yet — "the panel sends history only when
  // present" (docs/PROTOCOL.md).
  const wireHistory = history && history.entries.length > 0 ? history.entries : undefined;

  pendingRetries.set(id, {
    type: "chat",
    text,
    context: wireContext,
    page: wirePage,
    devMode: wireDevMode,
    docSearch: wireDocSearch,
    history: wireHistory,
  });
  await sendClientMessage({
    type: "chat",
    id,
    text,
    context: wireContext,
    page: wirePage,
    devMode: wireDevMode,
    docSearch: wireDocSearch,
    history: wireHistory,
  });
}

/** Lot A2 (plan-montrer-voir-chercher-08-10.md §3A) — builds the
 * `{extractionId, elements}` snapshot to attach to the ONE assistant message
 * this `context` is answering (see `elementsSnapshot`'s comment above).
 * Also surfaces, at most once per panel session, the "iframes aren't
 * numbered" notice (the plan's own stated limitation: "cadre principal
 * seulement") — only when it would actually matter, i.e. the page DOES have
 * elements to show and ALSO has an iframe. Returns `null` when there is
 * nothing to attach (no page read, or an extraction that predates this lot). */
export function buildElementsSnapshot(context) {
  if (!context || typeof context.extractionId !== "string") return null;
  const elements = Array.isArray(context.elements) ? context.elements : [];
  if (context.elementsFrameLimited && elements.length && !frameLimitNoticeShown) {
    frameLimitNoticeShown = true;
    addMessage({ id: newId(), role: "system", text: t("panel_point_frame_limit") });
  }
  return { extractionId: context.extractionId, elements };
}

// --- Site card suggestions (T27-T30) ---------------------------------------
//
// A suggestion click sends its prompt WITH the page content, through the
// exact same path as a library prompt used with "Coati reads this page"
// checked (sendChatMessage above) — the click itself is the gesture that
// justifies the read (rule 5), same as the main button's summarize(). On a
// YouTube video, the click may open YouTube's own transcript panel once, like
// summarize() (named exception, widened on 26/09 — openTranscriptIfNeeded()).

// YouTube loads its transcript asynchronously. After a user click (summarize
// or video suggestion), we open the transcript panel once — named exception
// to the gesture rule — then re-read. Without the transcript only the
// description and comments would be available, which produces a plausible but
// wrong answer: callers stop on reportMissingTranscript() in that case.
export async function openTranscriptIfNeeded(context) {
  if (!context.needsTranscript) return context;
  const opened = await openYouTubeTranscript(currentTabId).catch(() => false);
  // Re-extraction here reuses extractFromTab, not extractReadableFromTab: the
  // page's readability can't have changed between the two reads (only the
  // transcript panel opened), so this just strips the field again rather than
  // re-running the PDF/canvas/empty checks a second time.
  return opened ? stripReadability(await extractFromTab(currentTabId).catch(() => context)) : context;
}

// Factual message, no legal qualification: either YouTube changed its page, or
// the video has no captions. Also the break signal specified in T19.
export function reportMissingTranscript() {
  addMessage({
    id: newId(),
    role: "system",
    text: t("panel_transcript_missing"),
  });
}

export async function runSuggestion(promptText) {
  if (panelState.activeRequestId || currentTabId == null) return;
  panelState.activeRequestId = "pending"; // in-flight guard until sendChatMessage sets the real id
  setStreamingUi(true);

  let context;
  try {
    context = await extractReadableFromTab(currentTabId);
  } catch (err) {
    setStreamingUi(false);
    reportExtractionError(err, {
      accessDenied: t("panel_access_denied_generic", [ACCESS_DENIED_HINT]),
      other: (e) => t("panel_read_error_generic", [e.message]),
    });
    return;
  }

  context = await openTranscriptIfNeeded(context);
  if (context.needsTranscript) {
    reportMissingTranscript();
    setStreamingUi(false);
    return;
  }

  await sendChatMessage(promptText, context);
}
