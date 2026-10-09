// Part of the content/extract.js content script (lot F4 split) — see
// content/extract-files.js for the load order. Generic article-text
// fallback, YouTube transcript reading, and small page signals.

// Picks the element that most likely holds the article body.
//
// Semantic containers win outright when they carry enough text. Otherwise we
// score candidates by text density — characters of rendered text per
// descendant element. A navigation column is long but tag-heavy; an article
// body is long and tag-light. Raw length alone would always elect the
// outermost wrapper, which is the whole page.
function articleText() {
  for (const el of document.querySelectorAll("article, main, [role='main']")) {
    if (!isRenderedCandidate(el)) continue;
    const text = textExcludingEditable(el);
    if (text.trim().length > 200) return text;
  }

  let best = null;
  let bestScore = 0;
  const candidates = document.body ? document.body.querySelectorAll("div, section") : [];
  for (const el of candidates) {
    // A container that IS an editable region (not just one that contains
    // one) is skipped outright, same as nav/footer/header/aside.
    if (el.closest("nav, footer, header, aside, [contenteditable]")) continue;
    if (!isRenderedCandidate(el)) continue;
    const text = textExcludingEditable(el);
    const length = text.trim().length;
    if (length < 200) continue;
    const density = length / (el.getElementsByTagName("*").length + 1);
    if (density > bestScore) {
      bestScore = density;
      best = el;
    }
  }

  return best ? textExcludingEditable(best) : textExcludingEditable(document.body);
}

function getYouTubeVideoId() {
  try {
    const url = new URL(location.href);
    if (url.hostname.includes("youtube.com") && url.pathname === "/watch") {
      return url.searchParams.get("v") || undefined;
    }
    if (url.hostname === "youtu.be") {
      return url.pathname.slice(1) || undefined;
    }
  } catch {
    // Not a URL we understand; treat the page as an ordinary one.
  }
  return undefined;
}

// Reads the transcript only if it is already open in the DOM: either the
// user opened the transcript panel themselves, or the panel's own "Summarize
// this video" button did it on their behalf, in direct response to their
// click — the one documented exception to the gesture rule (DECISIONS.md,
// "Hard constraint — the gesture rule"). Either way this function itself
// never opens the panel and never calls YouTube's internal endpoints.
function getYouTubeTranscript() {
  // YouTube migrated its transcript to the "view model" architecture; the
  // older custom element is kept as a fallback for slower rollouts.
  // Measured 2026-09-18: transcript-segment-view-model yields 133 segments on
  // a 17-minute video, ytd-transcript-segment-renderer yields none.
  const segments = document.querySelectorAll(
    "transcript-segment-view-model, ytd-transcript-segment-renderer",
  );
  if (!segments.length) return undefined;

  const lines = [];
  let previous = null;
  for (const segment of segments) {
    // A segment renders as three lines: the timestamp, a screen-reader
    // duplicate of it ("7 secondes"), then the spoken text. Keep the
    // timestamp — it lets the model cite a moment — and drop the duplicate.
    const parts = visibleText(segment)
      .split("\n")
      .map((part) => part.trim())
      .filter(Boolean);

    const stamp = parts.find((part) => /^\d{1,2}:\d{2}(:\d{2})?$/.test(part));
    const spoken = parts
      .filter(
        (part) =>
          part !== stamp &&
          !/^\d+\s+(seconde|secondes|minute|minutes|heure|heures|second|seconds|minute|minutes|hour|hours)\b/i.test(
            part,
          ),
      )
      .join(" ")
      .trim();

    if (!spoken || spoken === previous) continue;
    previous = spoken;
    lines.push(stamp ? `${stamp} ${spoken}` : spoken);
  }

  return lines.length ? lines.join("\n") : undefined;
}

// The query string and hash can carry session tokens (?token=…,
// #access_token=…). The model, the broker, and its logs never need them —
// only origin + path identify "which page", so that's all that leaves the
// page. Falls back to the raw href if location is somehow not a URL (should
// not happen in a browser tab, but truncate() elsewhere shows the same
// defensive style).
function safePageUrl() {
  try {
    return location.origin + location.pathname;
  } catch {
    return location.href;
  }
}

// Extra signals for the page-type classifier (extension/content/detect.js).
// Gathering them needs the DOM, so it happens here; deciding what they mean
// does not, which is why that logic lives in a separate, DOM-free module.
function hasVideoElement() {
  return !!document.querySelector("video");
}

function hasArticleMarkup() {
  if (document.querySelector("article, [role='main']")) return true;
  const ogType = document.querySelector('meta[property="og:type"]');
  return !!ogType && ogType.getAttribute("content") === "article";
}
