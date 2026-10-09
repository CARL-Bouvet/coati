// Coati side panel — chat send path: page/screen attachment, the shared
// sendChatMessage() tail, site-card suggestions (lot F3 split of panel.js).
import { t } from "../lib/i18n-page.js";
import { api } from "../lib/browser-compat.js";
import { els } from "./dom-refs.js";
import { panelState, newId } from "./panel-state.js";
import { ACCESS_DENIED_HINT } from "../lib/labels.js";
import { currentTabId, resizeComposer } from "./panel.js";
import { isAttachPageChecked, isAttachScreenChecked, setAttachScreenChecked } from "./attach-toggle.js";
import { extractReadableFromTab, extractFromTab, reportExtractionError, openYouTubeTranscript } from "./page-extract.js";
import { addMessage } from "./message-render.js";
import { persistConversation } from "./conversation-store.js";
import { setStreamingUi, sendClientMessage } from "./request-watch.js";
import { hasFeature } from "./model-status.js";
import { buildHistoryForWire } from "./history.js";
import { prepareContextForWire } from "./element-refs.js";
import { pendingRetries } from "./chat-stream.js";
import { updateSavePromptEnabled } from "./prompts-wiring.js";
import { stripReadability } from "./unreadable.js";
import { PAGE_CONTENT_MARKER_SUFFIX } from "./message-render.js";
import {
  captureScreen,
  captureNeedsGesture,
  isInternalBrowserUrl,
  ScreenshotTooBigError,
} from "./screenshot.js";

// Lot B3 — `message` is already the ready-to-display, localized text
// (captureScreenIfChecked() picks it per failure kind); never the raw
// English chrome.tabs.captureVisibleTab() rejection.
class ScreenCaptureDeniedError extends Error {
  constructor(message) {
    super(message);
    this.name = "ScreenCaptureDeniedError";
  }
}

// Shown at most once per panel session (plan: "main frame only:
// iframes are not numbered — announced limitation").
let frameLimitNoticeShown = false;

// --- Chat ---------------------------------------------------------------

/** Reads the page when "Read the page" is on right now, else resolves
 * to `undefined` — the shared "should we attach" check for sendChat() and
 * relaunchMessage() (both read the switch's CURRENT state, never whatever it
 * was at the original send). Throws on an extraction failure; the caller
 * reports it via reportExtractionError(). */
export async function extractIfAttaching() {
  const attach = !els.attachPage.disabled && isAttachPageChecked() && currentTabId != null;
  return attach ? extractReadableFromTab(currentTabId) : undefined;
}

/** Resolves the `permissions.request()` fired synchronously by the click
 * handler above. Refused → revert the optimistic checked state, a short
 * localized message, and don't persist the now-false preference as a user
 * choice (so turning the toggle on again re-asks instead of silently
 * staying off). Granted → persist, same shape as attachPage's preference. */
export async function finishAttachScreenToggle(asked) {
  const granted = await Promise.resolve(asked).catch(() => false);
  if (!granted) {
    setAttachScreenChecked(false);
    addMessage({ id: newId(), role: "system", text: t("panel_screen_need_gesture") });
    return;
  }
  panelState.attachScreenPreference = true;
  persistConversation();
}

/** "See the screen" — captures when checked; STAYS checked after sending
 * (sticky, superseded the B3-era "unchecked after each send" — same
 * persisted-preference shape as attachPage). Returns `null` when unchecked/
 * unavailable; throws ScreenCaptureDeniedError (ready-to-display message)
 * on any failure, which callers treat exactly like reportExtractionError:
 * abort the send, nothing half-sent. */
export async function captureScreenIfChecked() {
  if (!isAttachScreenChecked() || els.attachScreen.disabled) return null;
  if (currentTabId == null) throw new ScreenCaptureDeniedError(t("panel_screen_denied"));

  let tab = null;
  try {
    tab = await api.tabs.get(currentTabId);
  } catch {
    tab = null;
  }
  if (isInternalBrowserUrl(tab?.url)) throw new ScreenCaptureDeniedError(t("panel_screen_denied"));

  try {
    const image = await captureScreen(tab?.windowId);
    return { image, marker: t("panel_screen_attached", [`${image.width}×${image.height}`]) };
  } catch (err) {
    if (err instanceof ScreenshotTooBigError) throw new ScreenCaptureDeniedError(t("panel_screen_too_big"));
    // The <all_urls> grant (requested when the switch turned on) can still
    // be revoked later (chrome://extensions, the "Mes prompts" page). When
    // that's what captureVisibleTab is rejecting with, turn the switch back
    // off — leaving it checked would retry and fail the same way forever.
    if (captureNeedsGesture(err)) {
      panelState.attachScreenPreference = false;
      setAttachScreenChecked(false);
      persistConversation();
      throw new ScreenCaptureDeniedError(t("panel_screen_need_gesture"));
    }
    throw new ScreenCaptureDeniedError(t("panel_screen_denied"));
  }
}

/** Amendement 2026-10-08 bis ("recherche sur demande explicite" —
 * docs/PROTOCOL.md §6, no more "Search the docs" button): origin only
 * (§6 — "never the path nor the query string"), and only for an http(s) tab
 * (a chrome://, file:// or extension page has no "doc site" to search).
 * Resolved fresh at SEND time (called from sendChatMessage() below), same
 * simplification as captureScreenIfChecked()'s internal-page check above —
 * no extra page-detection wiring kept live for this alone. */
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

export async function sendChat() {
  const text = els.input.value.trim();
  if (!text || panelState.activeRequestId) return;

  // Extract at send time only — never on every keystroke. Never send the
  // question alone when the user asked for the page to be attached: a blind
  // answer looks like a working feature and wastes a turn.
  let context;
  try {
    context = await extractIfAttaching();
  } catch (err) {
    reportExtractionError(err, {
      accessDenied: t("panel_access_denied_question", [ACCESS_DENIED_HINT]),
      other: (e) => t("panel_read_error_question", [e.message]),
    });
    return;
  }

  let screen = null;
  try {
    screen = await captureScreenIfChecked();
  } catch (err) {
    addMessage({ id: newId(), role: "system", text: err.message });
    return;
  }

  const text0 = text;
  els.input.value = "";
  resizeComposer();
  updateSavePromptEnabled();
  await sendChatMessage(text0, context, screen);
}

/** Shared tail of "send a chat message, with or without the page attached" —
 * used by sendChat() (the composer's Send button, attach depending on the
 * "Coati reads this page" toggle) and runSuggestion() (a site-card
 * suggestion click, always attached — see its own comment). `screen` (Lot
 * B3, only ever set by sendChat() itself — runSuggestion() never attaches
 * one) is `{ image, marker } | null`, see captureScreenIfChecked().
 *
 * Amendement 2026-10-08 bis ("recherche sur demande explicite" —
 * docs/PROTOCOL.md): there is no more "Search the docs" button, so
 * `chat.docSearch` is no longer a caller-supplied param — it's resolved
 * fresh HERE, on every chat, straight from the current tab
 * (activeTabDocSearchOrigin(), same "origin only, http(s) tab only" rule as
 * before). It no longer requests a search; it only tells the broker a
 * search is ALLOWED for this origin — whether one actually runs is decided
 * broker-side, from the question text alone. */
export async function sendChatMessage(text, context, screen = null) {
  const id = newId();
  // Amendement 2026-10-08 bis ("historique", docs/PROTOCOL.md): computed
  // from `conversation` BEFORE the two addMessage() calls below push this
  // turn's own user/assistant placeholders onto it — history is the PAST
  // exchanges only, never this one. Gated on the negotiated capability,
  // same pattern as `elements`/`vision`/`docsearch` above/below.
  const history = hasFeature("history") ? buildHistoryForWire(panelState.conversation) : null;
  const note = (context ? PAGE_CONTENT_MARKER_SUFFIX : "") + (screen ? ` ${screen.marker}` : "");
  // `relaunch` (plan-mes-prompts-28-09.md, "Relancer"): resending this exact
  // message means resending `text` through this same function, reading the
  // page per the switch's state AT THE TIME OF THE RELAUNCH — never a cached
  // copy of `context`, which can hold page content (kept out of
  // chrome.storage.local, same reasoning as context.url elsewhere). Never a
  // cached screenshot either (plan B3: "Retry never resends the old
  // image") — `relaunch` below carries no `image` at all, on purpose.
  addMessage({ id: `${id}-u`, role: "user", text: `${text}${note}`, relaunch: { type: "chat", text } });
  // elementsSnapshot: see its own comment above `frameLimitNoticeShown` —
  // THIS message's own {extractionId, elements}, computed now, never read
  // back from a shared variable later.
  addMessage({
    id,
    role: "assistant",
    text: "",
    streaming: true,
    readsPage: !!context,
    elementsSnapshot: buildElementsSnapshot(context),
  });

  panelState.activeRequestId = id;
  setStreamingUi(true);
  persistConversation();

  const wireContext = prepareContextForWire(context, hasFeature("elements"));
  // Gated the same way as `elements` above, defensively — the checkbox is
  // only ever visible/checkable when hasFeature("vision") in the first
  // place (updateAttachScreenUi()), so this should already be true here.
  const image = screen && hasFeature("vision") ? screen.image : undefined;
  // Gated the same way, defensively — never sent at all when the broker
  // build doesn't even understand the field.
  const origin = hasFeature("docsearch") ? await activeTabDocSearchOrigin() : null;
  const wireDocSearch = origin ? { origin } : undefined;
  // Amendment 2026-10-08 bis: omitted entirely (never an empty array) when
  // there is nothing eligible yet — "the panel sends history only when
  // present" (docs/PROTOCOL.md).
  const wireHistory = history && history.entries.length > 0 ? history.entries : undefined;

  pendingRetries.set(id, { type: "chat", text, context: wireContext, image, docSearch: wireDocSearch, history: wireHistory });
  await sendClientMessage({ type: "chat", id, text, context: wireContext, image, docSearch: wireDocSearch, history: wireHistory });
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
