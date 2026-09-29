// Pure page-type classifier. NO DOM access, NO chrome.* calls — this is what
// makes it unit-testable outside a browser (see broker/test/detect.test.ts,
// run via `cd broker && bun test`).
//
// Gathering the raw signals below *does* require the DOM (a <video> element,
// a transcript, an <article> tag…), so that part stays in extract.js, which
// runs as a content script. This module only turns those signals into a
// decision, so the decision logic can be tested without mocking a page.
//
// The page-kind rules (pageKind, facts/items caps, overlay exclusion) live
// only in content/extract.js now — this module used to carry a second,
// unused copy for testing purposes (KISS audit 2026-09-26, item 1); it was
// never imported by anything shipped, only exercised by its own tests.

const YOUTUBE_WATCH_HOSTS = new Set(["www.youtube.com", "youtube.com", "m.youtube.com"]);

// Below this length, a dense-looking block of text isn't a strong enough
// signal on its own — lots of ordinary pages (a long nav, a cookie banner)
// clear a smaller threshold. Chosen empirically, not a protocol constant.
const ARTICLE_TEXT_THRESHOLD = 1200;

function isYouTubeWatchUrl(url) {
  if (typeof url !== "string" || !url) return false;
  try {
    const parsed = new URL(url);
    if (YOUTUBE_WATCH_HOSTS.has(parsed.hostname) && parsed.pathname === "/watch") return true;
    if (parsed.hostname === "youtu.be" && parsed.pathname.length > 1) return true;
  } catch {
    // Not a parseable absolute URL — can't be a YouTube link.
  }
  return false;
}

/**
 * Decides the page type used to pick the main button's label and payload.
 *
 * @param {object} signals
 * @param {string} [signals.url] - the tab's URL.
 * @param {string} [signals.title] - the tab's title (unused today, accepted
 *   for forward compatibility — a future heuristic may look at it).
 * @param {number} [signals.textLength] - length of the extracted body text.
 * @param {boolean} [signals.hasTranscript] - a YouTube transcript was read.
 * @param {boolean} [signals.hasVideoElement] - a <video> element is present.
 * @param {boolean} [signals.hasArticleMarkup] - <article>, [role="main"], or
 *   a `<meta property="og:type" content="article">` tag is present.
 * @returns {"video"|"article"|"page"}
 */
export function classifyPageType(signals = {}) {
  const {
    url = "",
    textLength = 0,
    hasTranscript = false,
    hasVideoElement = false,
    hasArticleMarkup = false,
  } = signals;

  if (isYouTubeWatchUrl(url)) return "video";
  if (hasVideoElement && hasTranscript) return "video";
  if (hasArticleMarkup || textLength > ARTICLE_TEXT_THRESHOLD) return "article";
  return "page";
}

/**
 * Classifies from `tab.url`/`tab.title` alone — no DOM, no page read. Used on
 * tab switch, where the règle du geste (CLAUDE.md rule 5) forbids injecting
 * the content script just because the active tab changed.
 *
 * Only signals that are genuinely legible from the URL/title alone are
 * trusted here. A YouTube watch URL is one — the rest (an article, a plain
 * page) cannot be told apart without reading the page, so this returns
 * `null` ("unknown") rather than guess. Guessing "article" from a URL shape
 * would be wrong often enough to mislabel the main button dishonestly.
 *
 * @param {object} signals
 * @param {string} [signals.url] - the tab's URL.
 * @param {string} [signals.title] - the tab's title (unused today, accepted
 *   for forward compatibility).
 * @returns {"video"|null}
 */
export function classifyPageTypeFromMetadata(signals = {}) {
  const { url = "" } = signals;
  if (isYouTubeWatchUrl(url)) return "video";
  return null;
}
