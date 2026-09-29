// Pure, DOM-free parsing for `[mm:ss]`/`[h:mm:ss]` timestamps the broker asks
// the model to prefix summary bullets with (see broker/src/model.ts's
// summarizeInstruction). Kept separate from the rendering path in panel.js so
// it can be unit-tested the same way extension/content/detect.js is (see
// broker/test/detect.test.ts) — no chrome.* here, no DOM.
//
// This module only decides WHAT the text means; panel.js decides whether and
// how to turn a timestamp token into a clickable element.

// `[m:ss]`, `[mm:ss]` or `[h:mm:ss]`. Minutes/seconds must be 0-59; hours has
// no upper bound. Anything else (99:99, [1:2:3:4], [abc]) is left as plain
// text — a malformed bracket is far more likely to be something else the
// model wrote than a broken timestamp.
const TIMESTAMP_RE = /\[(\d{1,2}(?::[0-5]?\d){1,2})\]/g;

/**
 * Parses one already-matched `h:mm:ss`/`m:ss` body (no brackets) into total
 * seconds, or returns null if a part is out of range.
 * @param {string} body
 * @returns {number|null}
 */
function toSeconds(body) {
  const parts = body.split(":").map((p) => Number(p));
  if (parts.some((n) => !Number.isInteger(n) || n < 0)) return null;
  if (parts.length === 2) {
    const [m, s] = parts;
    if (s >= 60) return null;
    return m * 60 + s;
  }
  if (parts.length === 3) {
    const [h, m, s] = parts;
    if (m >= 60 || s >= 60) return null;
    return h * 3600 + m * 60 + s;
  }
  return null;
}

/**
 * Splits an assistant message's text into a token list of plain-text runs
 * and timestamp tokens.
 *
 * @param {string} text
 * @returns {Array<{type: 'text', value: string} | {type: 'timestamp', raw: string, label: string, seconds: number}>}
 */
export function parseTimestamps(text) {
  const input = text ?? "";
  const tokens = [];
  let lastIndex = 0;
  TIMESTAMP_RE.lastIndex = 0;
  let match;
  while ((match = TIMESTAMP_RE.exec(input))) {
    const [raw, body] = match;
    const seconds = toSeconds(body);
    if (seconds === null) continue; // not a valid timestamp — leave it in the surrounding text run

    if (match.index > lastIndex) {
      tokens.push({ type: "text", value: input.slice(lastIndex, match.index) });
    }
    tokens.push({ type: "timestamp", raw, label: body, seconds });
    lastIndex = match.index + raw.length;
  }
  if (lastIndex < input.length) {
    tokens.push({ type: "text", value: input.slice(lastIndex) });
  }
  if (tokens.length === 0) tokens.push({ type: "text", value: input });
  return tokens;
}

const YOUTUBE_WATCH_HOSTS = new Set(["www.youtube.com", "youtube.com", "m.youtube.com"]);

/**
 * Extracts a YouTube video id from a URL, or undefined if it isn't a
 * watch/short-link URL. Mirrors extract.js's getYouTubeVideoId() so the
 * "same video" check at click time (panel.js) uses identical logic to the
 * one that captured context.videoId at summarize time.
 * @param {string} url
 * @returns {string|undefined}
 */
export function getYouTubeVideoIdFromUrl(url) {
  try {
    const parsed = new URL(url);
    if (YOUTUBE_WATCH_HOSTS.has(parsed.hostname) && parsed.pathname === "/watch") {
      return parsed.searchParams.get("v") || undefined;
    }
    if (parsed.hostname === "youtu.be") {
      return parsed.pathname.slice(1) || undefined;
    }
  } catch {
    // Not a parseable absolute URL.
  }
  return undefined;
}
