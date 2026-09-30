// Per-site suggestion data (Coati's free tier — docs/DECISIONS.md T30 amendement 2026-09-28,
// T31, plan-mes-prompts-28-09.md §4). Exactly five sites: no generic fallback and no niche sites
// (real estate, Leboncoin, shopping) anymore — those moved to paid (P25/T30).
//
// Each SITES entry's `id` also doubles as the popular-site key suffix used by
// suggestions.js's siteKeyFor(): "@" + id (e.g. "@youtube").
//
// Shape:
//   SiteEntry = { id, name, hosts: string[], paths: RegExp[] | null, items: Item[] }
//   Item = { id: string, label: string, prompt: string }
//        | { id: string, label: string, action: "summarize" } // YouTube only, see below
//
// `id` on an Item is a stable Coati suggestion id, `coati:<site>:<slug>`, referenced from
// prefs.json's order/removed (docs/PROTOCOL.md "Identifiants dans order et removed"). Never
// renamed once shipped — renaming would silently detach it from a user's saved order.

import { t } from "./i18n.js";

/** @typedef {{ id: string, label: string, prompt?: string, action?: "summarize" }} Item */
/** @typedef {{ id: string, name: string, hosts: string[], paths: RegExp[] | null, items: Item[] }} SiteEntry */

// Labels and prompt texts below come from _locales/<lang>/messages.json
// (sugg_* keys) so the model receives the question in the user's own
// language too, not just the label. Item `id`s are a stable identifier
// referenced from prefs.json's order/removed — NEVER translated, NEVER
// renamed.

/** @type {SiteEntry[]} */
export const SITES = [
  {
    id: "youtube",
    name: "YouTube",
    hosts: ["youtube.com", "youtu.be"],
    // No path restriction — any page under these hosts keeps today's matching.
    paths: null,
    items: [
      // Not a chat prompt: the panel's existing summarize/transcript action
      // (panel.js's "Résumer" path). Not editable in "Mes prompts" — the page
      // (lot 4) must special-case `action` items and skip the edit/delete UI
      // that applies to prompt-backed items.
      { id: "coati:youtube:summarize", label: t("panel_summarize_video"), action: "summarize" },
      {
        id: "coati:youtube:key-points",
        label: t("sugg_youtube_key_points_label"),
        prompt: t("sugg_youtube_key_points_prompt"),
      },
      {
        id: "coati:youtube:fact-check",
        label: t("sugg_youtube_fact_check_label"),
        prompt: t("sugg_youtube_fact_check_prompt"),
      },
    ],
  },
  {
    id: "google",
    name: "Google",
    // Assumption (worker, 28/09): explicit TLD list, same size/spirit as the
    // Amazon list given in the brief — not exhaustive of every Google ccTLD.
    hosts: ["google.com", "google.fr", "google.de", "google.co.uk", "google.es", "google.it", "google.ca", "google.be", "google.nl"],
    paths: [/^\/search$/],
    items: [
      {
        id: "coati:google:refine",
        label: t("sugg_google_refine_label"),
        prompt: t("sugg_google_refine_prompt"),
      },
      {
        id: "coati:google:compare",
        label: t("sugg_google_compare_label"),
        prompt: t("sugg_google_compare_prompt"),
      },
      {
        id: "coati:google:sources",
        label: t("sugg_google_sources_label"),
        prompt: t("sugg_google_sources_prompt"),
      },
    ],
  },
  {
    id: "wikipedia",
    name: t("sugg_wikipedia_name"),
    hosts: ["wikipedia.org"],
    paths: [/^\/wiki\//],
    items: [
      {
        id: "coati:wikipedia:essentials",
        label: t("sugg_wikipedia_essentials_label"),
        prompt: t("sugg_wikipedia_essentials_prompt"),
      },
      {
        id: "coati:wikipedia:explain",
        label: t("sugg_wikipedia_explain_label"),
        prompt: t("sugg_wikipedia_explain_prompt"),
      },
      {
        id: "coati:wikipedia:dates",
        label: t("sugg_wikipedia_dates_label"),
        prompt: t("sugg_wikipedia_dates_prompt"),
      },
    ],
  },
  {
    id: "reddit",
    name: "Reddit",
    hosts: ["reddit.com"],
    paths: [/^\/r\/[^/]+\/comments\//],
    items: [
      {
        id: "coati:reddit:thread-gist",
        label: t("sugg_reddit_thread_gist_label"),
        prompt: t("sugg_reddit_thread_gist_prompt"),
      },
      {
        id: "coati:reddit:opposing",
        label: t("sugg_reddit_opposing_label"),
        prompt: t("sugg_reddit_opposing_prompt"),
      },
    ],
  },
  {
    id: "amazon",
    name: "Amazon",
    hosts: ["amazon.com", "amazon.fr", "amazon.de", "amazon.co.uk", "amazon.es", "amazon.it", "amazon.ca", "amazon.be", "amazon.nl"],
    paths: [/\/dp\//, /\/gp\/product\//],
    items: [
      {
        id: "coati:amazon:reviews",
        label: t("sugg_amazon_reviews_label"),
        prompt: t("sugg_amazon_reviews_prompt"),
      },
      {
        id: "coati:amazon:weaknesses",
        label: t("sugg_amazon_weaknesses_label"),
        prompt: t("sugg_amazon_weaknesses_prompt"),
      },
    ],
  },
];

// Hosts that never carry a subdomain in practice (short-link domains). Wildcarding them
// (`https://*.host/*`) would ask for a needlessly broad permission for a pattern real traffic
// never uses. Everything else gets `*.host` so that both the bare domain and any subdomain
// (including `www.`) are covered — mirrors suggestions.js's hostMatches().
const NO_SUBDOMAIN_HOSTS = new Set(["youtu.be"]);

// EXPLICIT schemes only, never `*://`: the manifest's optional_host_permissions declare
// `http://*/*` and `https://*/*` as two separate patterns, and Chrome refuses any requested
// pattern that no single declared pattern contains — `*://…` is rejected with « Only
// permissions specified in the manifest may be requested » (bug of 28/09: nothing but YouTube,
// granted earlier by the old per-origin link, could ever be activated).
/** @param {string} host @param {string} scheme */
function permissionPatternForHost(host, scheme) {
  return NO_SUBDOMAIN_HOSTS.has(host) ? `${scheme}://${host}/*` : `${scheme}://*.${host}/*`;
}

/**
 * Match patterns to request/check with chrome.permissions for a given site key
 * (docs/DECISIONS.md T42/T43, internal design plan, 28/09, lot 1). Pure — no chrome.*.
 *
 * - A popular-site key (`@youtube`, `@google`, `@wikipedia`, `@reddit`, `@amazon`): an `https://`
 *   pattern for every host of that site, so activating a popular site covers all its domains at
 *   once (Google/Amazon: every TLD already in SITES). These sites are HTTPS-only.
 * - A user hostname key (e.g. `crisco4.unicaen.fr`): `https://` and `http://` patterns matching
 *   that host and its subdomains, including `www.` (the key has `www.` stripped, but the granted
 *   permission still covers `www.<key>`); a small site may still be served over plain HTTP.
 * - `"*"` (tous les sites), `"@unsorted"` (page d'adresse inconnue), `null`/`undefined`/anything
 *   else not a non-empty string: no host to request a permission for — `[]`.
 * @param {string | null | undefined} siteKey
 * @returns {string[]}
 */
export function permissionPatternsFor(siteKey) {
  if (typeof siteKey !== "string" || siteKey === "") return [];
  if (siteKey === "*" || siteKey === "@unsorted") return [];
  if (siteKey.startsWith("@")) {
    const site = SITES.find((s) => s.id === siteKey.slice(1));
    return site ? site.hosts.map((host) => permissionPatternForHost(host, "https")) : [];
  }
  return [permissionPatternForHost(siteKey, "https"), permissionPatternForHost(siteKey, "http")];
}
