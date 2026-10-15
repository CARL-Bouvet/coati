// Coati side panel — contextual summarize, page extraction (gesture-gated
// read), unreadable-page handling (split of panel.js).
import { t } from "../lib/i18n-page.js";
import { api } from "../lib/browser-compat.js";
import { withDeadline } from "../lib/deadline.js";
import { ACCESS_DENIED_HINT, EXTRACTION_TIMEOUT_LABEL } from "../lib/labels.js";
import { panelState, newId } from "./panel-state.js";
import { currentTabId } from "./panel.js";
import { isPdfUrl, isInternalPageUrl, isInternalPageFailure, readabilityMessage, stripReadability, PDF_MESSAGE } from "./unreadable.js";
import { addMessage } from "./message-render.js";
import { persistConversation } from "./conversation-store.js";
import { setStreamingUi, sendClientMessage } from "./request-watch.js";
import { hasFeature } from "./model-status.js";
import { prepareContextForWire } from "./element-refs.js";
import { pendingRetries } from "./chat-stream.js";
import { applyDetectedContext } from "./page-detect.js";
import { mainButtonLabel } from "./attach-toggle.js";
import { openTranscriptIfNeeded, reportMissingTranscript, buildElementsSnapshot } from "./composer-send.js";
import { EXTRACT_FILES } from "../content/extract-files.js";

// chrome.scripting.executeScript has
// no deadline of its own, so a hostile or pathologically heavy page could
// leave the panel awaiting page content forever. EXTRACTION_DEADLINE_MS is
// deliberately generous — no measurement in notes/corpus/ approaches even a
// few seconds — so it never fires on a real page; it only bounds the
// pathological case. This must NOT be used to cap the extraction loops
// themselves (extract.js): that would change results on heavy real pages,
// which is out of scope for this fix.
const EXTRACTION_DEADLINE_MS = 20000;

class ExtractionTimeoutError extends Error {
  constructor() {
    super(EXTRACTION_TIMEOUT_LABEL);
    this.name = "ExtractionTimeoutError";
  }
}

/** Thrown by extractReadableFromTab (never by extractFromTab itself) when the
 * page cannot usefully be read even though the injection succeeded: a PDF
 * shown by the browser's own viewer (extraction never runs there), or
 * extract.js reporting `readability: "canvas" | "empty"` — see "Unreadable
 * pages" below. `message` is the ready-to-display French text. */
class UnreadablePageError extends Error {
  constructor(message, internal = false) {
    super(message);
    this.name = "UnreadablePageError";
    this.internal = internal;
  }
}

// --- Summarize ------------------------------------------------------------

export async function summarize() {
  if (panelState.activeRequestId) return;
  panelState.activeRequestId = "pending"; // in-flight guard until the real id is known below; also drives the disabled buttons
  setStreamingUi(true);

  if (currentTabId == null) {
    addMessage({ id: newId(), role: "system", text: t("panel_no_active_tab") });
    setStreamingUi(false);
    return;
  }

  let context;
  try {
    context = await extractReadableFromTab(currentTabId);
  } catch (err) {
    reportExtractionError(err, {
      accessDenied: t("panel_access_denied_generic", [ACCESS_DENIED_HINT]),
      other: (e) => t("panel_read_error_generic", [e.message]),
    });
    setStreamingUi(false);
    return;
  }

  context = await openTranscriptIfNeeded(context);
  if (context.needsTranscript) {
    reportMissingTranscript();
    setStreamingUi(false);
    return;
  }

  if (!context.text || context.text.trim().length < 40) {
    addMessage({
      id: newId(),
      role: "system",
      text: t("panel_nothing_readable"),
    });
    setStreamingUi(false);
    return;
  }

  applyDetectedContext(context);

  const id = newId();
  const label = mainButtonLabel();
  // Never the URL here: it is persisted to chrome.storage.local unencrypted
  // (project rule 17) and a URL can carry a session token. Title only, with
  // a neutral fallback rather than reaching for context.url.
  const description = (context.title || "").trim() || t("common_this_page_lowercase");
  addMessage({ id: `${id}-u`, role: "user", text: `${label} : ${description}`, relaunch: { type: "summarize" } });
  // videoId only — never context.url (rule #1: chrome.storage.local is
  // unencrypted, and a URL can carry a session token; a bare video id can't).
  // It's what lets a rendered timestamp be tied back to "the video this
  // summary was made from" without ever persisting that video's URL.
  const videoId = context.kind === "youtube" ? context.videoId : undefined;
  addMessage({
    id,
    role: "assistant",
    text: "",
    streaming: true,
    videoId,
    readsPage: true,
    elementsSnapshot: buildElementsSnapshot(context),
  });

  panelState.activeRequestId = id;
  setStreamingUi(true);
  persistConversation();

  const wireContext = prepareContextForWire(context, hasFeature("elements"));

  pendingRetries.set(id, { type: "summarize", context: wireContext });
  await sendClientMessage({ type: "summarize", id, context: wireContext });
}

export async function activeTabId() {
  const [tab] = await api.tabs.query({ active: true, currentWindow: true });
  if (!tab || !tab.id) throw new Error(t("common_no_active_tab_internal"));
  return tab.id;
}

/** Classifies a page-read failure (an unreadable page / a browser permission
 * refusal / anything else) and reports it as a system message, with the
 * phrasing appropriate to the caller (sendChat vs. summarize word things
 * slightly differently). Callers still do their own cleanup (setStreamingUi,
 * return) after calling this — that part isn't shared because it differs
 * between callers. */
export function reportExtractionError(err, { accessDenied, other }) {
  if (err instanceof UnreadablePageError) {
    addMessage({ id: newId(), role: "system", text: err.message });
  } else if (isInternalPageFailure(err)) {
    addMessage({ id: newId(), role: "system", text: t("panel_internal_page") });
  } else if (looksLikeAccessDenied(err)) {
    addMessage({ id: newId(), role: "system", text: accessDenied });
  } else {
    addMessage({ id: newId(), role: "system", text: other(err) });
  }
}

// T47 (docs/DECISIONS.md): the two browsers' error texts —
// Chrome/Brave: "Cannot access contents of the page. Extension manifest must
// request permission to access the respective host." Firefox: "Missing host
// permission for the tab" / "…for the tab or frames" (Firefox source).
// Neither embeds the page address, so this only classifies, it never mines
// an origin (that used to be extractOriginFromError/NoAccessError, removed).
/** True when the failure looks like the browser refusing access for lack of
 * a host permission. */
export function looksLikeAccessDenied(err) {
  const message = err && typeof err.message === "string" ? err.message : "";
  return /cannot access|permission|extension manifest/i.test(message);
}

export async function extractFromTab(tabId) {
  const results = await withDeadline(
    api.scripting.executeScript({
      target: { tabId },
      // Leading slash, and it matters: Chrome resolves an injected file path
      // against the extension root, Firefox against the calling document — the
      // panel lives in panel/, so "content/extract.js" became
      // moz-extension://…/panel/content/extract.js and failed to load.
      // Measured in Firefox. Root-relative works on both.
      files: EXTRACT_FILES.map((f) => `/${f}`),
    }),
    EXTRACTION_DEADLINE_MS,
    () => new ExtractionTimeoutError(),
  );

  const result = results?.[0]?.result;
  if (!result || typeof result !== "object") throw new Error(t("common_extraction_empty"));
  return result;
}

// --- Unreadable pages (T46 point 3) ----------------------------------------
//
// Wraps extractFromTab() for every caller that is about to SEND the page to
// the broker (extractIfAttaching, runSuggestion, summarize — never
// openYouTubeTranscript's own internal re-read, which just reuses whatever
// context already passed this check). Two cases short-circuit BEFORE a
// question is sent: a PDF (the browser's own viewer refuses script
// injection, so this must be caught from the tab URL, before attempting
// extraction at all) and extract.js's own `readability: "canvas" | "empty"`
// verdict (caught after a successful extraction). `context.readability`
// itself must never reach the broker (docs/PROTOCOL.md's Context has no such
// field) — stripReadability() below strips it from every context this
// function returns.
export async function extractReadableFromTab(tabId) {
  let tab = null;
  try {
    tab = await api.tabs.get(tabId);
  } catch {
    tab = null;
  }
  if (isInternalPageUrl(tab?.url)) throw new UnreadablePageError(isPdfUrl(tab.url) ? PDF_MESSAGE : t("panel_internal_page"), true);

  const context = await extractFromTab(tabId);
  // YouTube has its own path: without a transcript the text is only the
  // header (the caller opens the transcript on the user's gesture and reads
  // again), and a short video has a short transcript that is still the whole
  // content. The unreadable-page check is for ordinary pages only.
  const message =
    context.kind === "youtube" || context.needsTranscript ? null : readabilityMessage(context.readability);
  if (message) throw new UnreadablePageError(message);
  return stripReadability(context);
}

// Named exception to the gesture rule (DECISIONS.md). One
// click, on the button YouTube already shows, only in response to the user
// clicking "Summarize this video", a video suggestion, or asking a question
// the model answers by reading the page, on the tab they are watching. Never
// on load, never in a loop, never on another video. This is not automated
// browsing: it tools the user's gesture.
export async function openYouTubeTranscript(tabId) {
  const results = await api.scripting.executeScript({
    target: { tabId },
    func: async () => {
      const button = [...document.querySelectorAll("button")].find((el) =>
        /afficher la transcription|show transcript/i.test(
          el.getAttribute("aria-label") || el.innerText || "",
        ),
      );
      if (!button) return false;

      button.click();

      // The panel fills asynchronously; measured between 1 and 10 s.
      const deadline = Date.now() + 15000;
      while (Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 500));
        if (
          document.querySelector(
            "transcript-segment-view-model, ytd-transcript-segment-renderer",
          )
        ) {
          return true;
        }
      }
      return false;
    },
  });
  return results?.[0]?.result === true;
}
