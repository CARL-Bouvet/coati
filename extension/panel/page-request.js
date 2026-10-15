// Coati side panel — answers the broker's `page.request` (docs/PROTOCOL.md
// "Page on demand"): level "text" replays the extraction already stashed by
// composer-send.js's sendChatMessage() (free — the page was read once, at
// send time); level "dev" runs a fresh content script (content/extract-
// dev.js) for the page's cleaned HTML. `page.decline` whenever either comes
// up empty — never leaves the broker waiting past its own timeout.
import { api } from "../lib/browser-compat.js";
import { estimateTokensFromChars, formatTokensK } from "../lib/labels.js";
import { panelState, newId } from "./panel-state.js";
import { renderMessage } from "./message-render.js";
import { sendClientMessage } from "./request-watch.js";
import { pendingPageExtractions, buildElementsSnapshot, openTranscriptIfNeeded } from "./composer-send.js";
import { prepareContextForWire } from "./element-refs.js";
import { hasFeature, currentGroupedModels } from "./model-status.js";
import { isCurrentLocal } from "../lib/model-list.js";
import { currentTabId } from "./panel.js";
import { scanForSensitiveData } from "../lib/sensitive-scan.js";
import { confirmSendSensitivePage } from "./sensitive-dialog.js";

/** Injected on its own (never alongside content/extract-files.js's
 * pipeline — a different reading level, not a refinement of it). Returns
 * `null` on any failure, same contract as its own header comment. */
async function runDevExtraction(tabId) {
  const results = await api.scripting.executeScript({
    target: { tabId },
    files: ["/content/extract-dev.js"],
  });
  const result = results?.[0]?.result;
  return result && typeof result === "object" && typeof result.text === "string" ? result : null;
}

async function declinePage(target) {
  await sendClientMessage({ type: "page.decline", id: newId(), target });
}

/** Sets the transient "Reading the page (~N k tokens)…" status the message
 * bubble shows until the re-run's first chunk arrives (chat-stream.js's
 * onChunk clears it) — a client-synthesized line, not a broker `progress`
 * stage: the broker has no token count to give us yet at this point. */
function showReadingStatus(msg, chars) {
  if (!msg) return;
  msg.pageRead = true;
  msg.pageReading = { kTokens: formatTokensK(estimateTokensFromChars(chars)) };
  renderMessage(msg);
}

export async function onPageRequest(message) {
  const { id, level, discard } = message;
  const msg = panelState.conversation.find((m) => m.id === id);

  // Marker appearing mid-answer: whatever of it was already shown must be
  // cleared (docs/PROTOCOL.md) — the re-run starts the answer over.
  if (discard && msg) {
    msg.text = "";
    renderMessage(msg);
  }

  if (level === "text") {
    let extraction = pendingPageExtractions.get(id);
    // At most one read per level (docs/PROTOCOL.md) — the stash is single-use.
    pendingPageExtractions.delete(id);
    if (!extraction) {
      await declinePage(id);
      return;
    }
    // YouTube without its transcript open: the user's own question is the
    // gesture for the one click that opens it (the named exception in
    // DECISIONS.md), then the page is read again. If it stays closed, the
    // text says "Transcript: not open" and is sent as is.
    extraction = await openTranscriptIfNeeded(extraction);
    const wireContext = prepareContextForWire(extraction, hasFeature("elements"));
    // The element list the model will see: what "Show" links and actions resolve against.
    if (msg) msg.elementsSnapshot = buildElementsSnapshot(extraction);
    showReadingStatus(msg, (extraction.text || "").length);
    await sendClientMessage({ type: "page.content", id: newId(), target: id, level: "text", context: wireContext });
    return;
  }

  // level === "dev"
  if (currentTabId == null) {
    await declinePage(id);
    return;
  }
  let devContext = null;
  try {
    devContext = await runDevExtraction(currentTabId);
  } catch {
    devContext = null;
  }
  if (!devContext) {
    await declinePage(id);
    return;
  }
  // project rule 8 ("warn, never mask"): only worth asking when
  // the HTML is about to leave the machine — a local model never sends it
  // anywhere.
  if (!isCurrentLocal(currentGroupedModels())) {
    const kinds = scanForSensitiveData(devContext.text);
    if (kinds.length > 0) {
      const kTokens = formatTokensK(estimateTokensFromChars(devContext.text.length));
      const send = await confirmSendSensitivePage(document, kinds, kTokens);
      if (!send) {
        await declinePage(id);
        return;
      }
    }
  }
  const wireContext = prepareContextForWire(devContext, hasFeature("elements"));
  showReadingStatus(msg, devContext.text.length);
  await sendClientMessage({ type: "page.content", id: newId(), target: id, level: "dev", context: wireContext });
}
