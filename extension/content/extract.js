// Coati content script — entry point (split).
//
// This content script is loaded as several classic (non-module) files,
// injected together and in order via chrome.scripting.executeScript({
// files: [...] }) — see content/extract-files.js for the authoritative,
// ordered list (sanitising, dom visibility, article/YouTube, the
// page-kind pipeline, the clickable-elements table, then this file last).
// All of them run in the same global scope (the tab's isolated world),
// same as content/pointer.js — every bare function/constant referenced
// below (getYouTubeVideoId, buildPageKindContext, buildElementsContext…)
// is defined in one of the files loaded earlier.
//
// This file is listed LAST in that `files` array: chrome.scripting
// .executeScript's result, for a multi-file injection, is the completion
// value of the LAST file executed — exactly what panel.js's
// extractFromTab() reads back (results?.[0]?.result), same contract as
// when this whole content script was a single file.
//
// Everything below dispatches to the right `kind`/`pageKind` and used to be
// the IIFE's own completion value directly; now wrapped in a function so a
// single merge point (right before the real `return` at the very end) can
// attach `elements`/`extractionId`/`elementsFrameLimited` to whichever
// shape comes out, without touching each of its internal `return`s.
(() => {
  function runExtraction() {
    const videoId = getYouTubeVideoId();

    if (videoId) {
      const transcript = getYouTubeTranscript();
      const text = truncate(formatYouTubeText(readYouTubeMeta(), transcript));
      return {
        kind: "youtube",
        url: safePageUrl(),
        title: document.title || "",
        videoId,
        text,
        // Without the transcript the text is only title, channel, description
        // and chapters: the caller opens the transcript on the user's gesture
        // and reads again.
        ...(transcript ? {} : { needsTranscript: true }),
        hasVideoElement: hasVideoElement(),
        hasArticleMarkup: false,
        readability: text.trim() ? "ok" : "empty",
      };
    }

    try {
      return buildPageKindContext();
    } catch {
      // docs/PROTOCOL.md: an exception during pageKind/facts/items detection
      // never fails the extraction — degrade to today's plain text.
      const fallbackText = truncate(articleText());
      return {
        kind: "page",
        url: safePageUrl(),
        title: document.title || "",
        text: fallbackText,
        hasVideoElement: hasVideoElement(),
        hasArticleMarkup: hasArticleMarkup(),
        readability: computeReadability(fallbackText, undefined, undefined),
      };
    }
  }

  const result = runExtraction();
  // Merged in last, after whichever shape above ran: an exception
  // while numbering elements must never take down the extraction itself
  // (same "never fails the extraction" promise as buildPageKindContext()).
  try {
    const elementsCtx = buildElementsContext();
    result.extractionId = elementsCtx.extractionId;
    result.elements = elementsCtx.elements;
    result.elementsFrameLimited = elementsCtx.elementsFrameLimited;
  } catch {
    result.elements = [];
  }
  return result;
})();
