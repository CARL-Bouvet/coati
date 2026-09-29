// Site-aware suggestion lookup — pure ESM, no DOM, no chrome.*.
// Importable by the panel (extension context) and by bun test (Node/Bun).
//
// Amendement 2026-09-28 ("Mes prompts par site" — docs/DECISIONS.md T27, T30, T31): no more
// generic fallback set. An unknown host, or a known popular-site host outside the path where
// Coati has something to say (e.g. a YouTube channel page, not a video), gets `items: []` — the
// panel shows only the user's own prompts for that site (T27 amendment).
import { SITES } from "./suggestions-data.js";

/**
 * Returns true if `host` matches `pattern`:
 *   - exact match (youtube.com === youtube.com), or
 *   - subdomain match (www.youtube.com ends with ".youtube.com").
 * Never matches a plain suffix (evil-youtube.com must NOT match youtube.com).
 * @param {string} host - lower-cased hostname from the URL.
 * @param {string} pattern - one entry from a site's `hosts` array.
 */
function hostMatches(host, pattern) {
  return host === pattern || host.endsWith("." + pattern);
}

/**
 * Find the SITES entry whose hosts array matches `host` — host only, no path.
 * @param {string} host
 * @returns {import("./suggestions-data.js").SiteEntry | null}
 */
function findSiteByHost(host) {
  for (const site of SITES) {
    for (const pattern of site.hosts) {
      if (hostMatches(host, pattern)) return site;
    }
  }
  return null;
}

/** @param {import("./suggestions-data.js").SiteEntry} site
 * @param {string} pathname */
function pathMatches(site, pathname) {
  if (!site.paths) return true; // no restriction (e.g. YouTube)
  return site.paths.some((re) => re.test(pathname));
}

/** `www.` stripped once, lower-cased. `crisco4.unicaen.fr` and `unicaen.fr`
 * stay two distinct site keys — see docs/PROTOCOL.md "PromptEntry". */
function userSiteKey(host) {
  return host.startsWith("www.") ? host.slice(4) : host;
}

/**
 * Parses `url` into `{ host, pathname }`, or null for a falsy/unparsable/
 * non-http(s) url.
 * @param {string | null | undefined} url
 * @returns {{ host: string, pathname: string } | null}
 */
function parseUrl(url) {
  if (!url) return null;
  let u;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") return null;
  return { host: u.hostname.toLowerCase(), pathname: u.pathname };
}

/**
 * The site key for `url`: one of the five popular-site keys (`@youtube`,
 * `@google`, `@wikipedia`, `@reddit`, `@amazon`) when the host belongs to
 * that site (any path), otherwise the lower-cased hostname with a leading
 * `www.` stripped, otherwise `null` (no url, unparsable, or non-http(s)).
 * Mirrors the broker's validation in protocol.ts's isValidSiteKey — see
 * docs/PROTOCOL.md "PromptEntry".
 * @param {string | null | undefined} url
 * @returns {string | null}
 */
export function siteKeyFor(url) {
  const parsed = parseUrl(url);
  if (!parsed) return null;
  const site = findSiteByHost(parsed.host);
  return site ? "@" + site.id : userSiteKey(parsed.host);
}

/**
 * @param {{ url: string | null | undefined, pageKind?: string }} opts -
 *   `pageKind` is accepted for signature stability but unused: the five
 *   popular sites no longer branch on it (no more `byKind`).
 * @returns {{ site: { id: string, name: string } | null, siteKey: string | null, items: import("./suggestions-data.js").Item[] }}
 */
export function suggestionsFor({ url }) {
  const parsed = parseUrl(url);
  if (!parsed) return { site: null, siteKey: null, items: [] };

  const site = findSiteByHost(parsed.host);
  const siteKey = site ? "@" + site.id : userSiteKey(parsed.host);
  if (!site) return { site: null, siteKey, items: [] };

  const items = pathMatches(site, parsed.pathname) ? site.items : [];
  return { site: { id: site.id, name: site.name }, siteKey, items };
}
