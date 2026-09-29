// Pure logic for the site card (T27-T29, docs/DECISIONS.md) — extracted so it
// can be unit-tested without a DOM, same pattern as scroll.js/retention.js.
//
// The card has exactly four visual states:
//   - "detecting": classification is in flight and taking a while — see
//     spinnerVisible() below.
//   - "known": the current page's URL matched a site in suggestions.js.
//   - "unknown": the URL is readable (we hold a host permission, or a page
//     read just happened) but no site matched — generic suggestions, host
//     name shown instead of a site name.
//   - "unreadable": no URL is known at all (no host permission for this tab
//     yet) — generic suggestions, no favicon, no host. panel.js keeps
//     offering "Activer Coati sur ce site" through redetectTab()'s own
//     tabs.get() fallback (T47), unchanged by this module.

/** panel.js waits this long after starting a (re)detection before showing
 * the small spinner — short enough to feel responsive, long enough that a
 * normal metadata-only redetect (near-instant) never flashes it. */
export const SPINNER_DELAY_MS = 150;

/**
 * @param {number} elapsedMs - time since detection started.
 * @param {number} [delayMs]
 * @returns {boolean} whether the spinner should be visible by now.
 */
export function spinnerVisible(elapsedMs, delayMs = SPINNER_DELAY_MS) {
  return elapsedMs >= delayMs;
}

/**
 * @param {{ url: string|null, site: {id: string, name: string}|null }} args
 *   `url` is the page's full URL when known (from a granted host permission,
 *   metadata only, or from a completed extraction) — null when nothing is
 *   known yet, or Chrome hid it for lack of permission.
 *   `site` is `suggestionsFor(...).site`, or null.
 * @returns {"unreadable"|"known"|"unknown"}
 */
export function cardState({ url, site }) {
  if (!url) return "unreadable";
  return site ? "known" : "unknown";
}

/**
 * @param {string|null|undefined} url
 * @returns {string|null} the hostname, or null when `url` is absent/invalid.
 */
export function hostFromUrl(url) {
  if (!url) return null;
  try {
    return new URL(url).hostname || null;
  } catch {
    return null;
  }
}

/**
 * Where the card's icon comes from (T28) — never a request to an address the
 * page chose. Chromium serves the site's icon from its own cache through the
 * extension's `_favicon/` endpoint ("favicon" permission, no install warning
 * without `tabs` or required host permissions). Firefox has no such endpoint:
 * only an inline `data:` favicon is shown there, anything else is skipped.
 * @param {{ pageUrl: string|null|undefined, favIconUrl: string|null|undefined,
 *           isGecko: boolean, getURL: (path: string) => string }} args
 * @returns {string|null}
 */
export function faviconSrc({ pageUrl, favIconUrl, isGecko, getURL }) {
  if (!pageUrl) return null;
  if (isGecko) {
    return typeof favIconUrl === "string" && favIconUrl.startsWith("data:") ? favIconUrl : null;
  }
  return getURL(`/_favicon/?pageUrl=${encodeURIComponent(pageUrl)}&size=32`);
}
