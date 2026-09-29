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

/** @typedef {{ id: string, label: string, prompt?: string, action?: "summarize" }} Item */
/** @typedef {{ id: string, name: string, hosts: string[], paths: RegExp[] | null, items: Item[] }} SiteEntry */

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
      { id: "coati:youtube:summarize", label: "Résumer cette vidéo", action: "summarize" },
      {
        id: "coati:youtube:key-points",
        label: "Points clés minutés",
        prompt: "Liste les points clés de la vidéo, chacun avec son horodatage.",
      },
      {
        id: "coati:youtube:fact-check",
        label: "À vérifier",
        prompt: "Relève les affirmations de la vidéo qui mériteraient d'être vérifiées, et dis pourquoi.",
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
        label: "Affiner ma recherche",
        prompt:
          "Transforme ma recherche visible sur cette page en recherche avancée : guillemets pour une expression exacte, site:, filetype:, exclusions avec -, et une borne before:/after: si une période est pertinente.",
      },
      {
        id: "coati:google:compare",
        label: "Comparer ces résultats",
        prompt: "Compare les résultats de cette page : ce qu'ils ont en commun, ce qui les distingue, et lequel répond le mieux à ma recherche.",
      },
      {
        id: "coati:google:sources",
        label: "Qui sont ces sources ?",
        prompt: "Pour chaque résultat de cette page, dis qui est la source et si elle semble fiable sur ce sujet.",
      },
    ],
  },
  {
    id: "wikipedia",
    name: "Wikipédia",
    hosts: ["wikipedia.org"],
    paths: [/^\/wiki\//],
    items: [
      {
        id: "coati:wikipedia:essentials",
        label: "L'essentiel en 5 points",
        prompt: "Résume cet article en 5 points essentiels, dans l'ordre d'importance.",
      },
      {
        id: "coati:wikipedia:explain",
        label: "Expliquer simplement",
        prompt: "Explique le sujet de cet article simplement, comme à quelqu'un qui le découvre.",
      },
      {
        id: "coati:wikipedia:dates",
        label: "Dates clés",
        prompt: "Liste les dates clés mentionnées dans cet article, avec ce qui s'est passé à chacune.",
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
        label: "Ce que le fil en dit",
        prompt: "Résume ce que dit ce fil : l'opinion qui domine et les points les plus commentés.",
      },
      {
        id: "coati:reddit:opposing",
        label: "Avis qui s'opposent",
        prompt: "Relève les avis qui s'opposent dans ce fil, et l'argument principal de chaque côté.",
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
        label: "Ce que disent les avis",
        prompt: "Résume les avis de cette fiche produit : les points forts et les défauts qui reviennent le plus souvent.",
      },
      {
        id: "coati:amazon:weaknesses",
        label: "Points faibles signalés",
        prompt: "Relève les points faibles signalés dans les avis de cette fiche produit, même minoritaires.",
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
