// Pure "Mes prompts" board logic (plan-mes-prompts-28-09.md, lot 4). No DOM,
// no chrome.* — importable from prompts.js and from bun test, same pattern
// as panel/encart-items.js and panel/card-state.js.

import { applyOrder, labelForPrompt } from "../panel/encart-items.js";

/** Coati's own items for a site key: [] for "*" and for any user site — only
 * the five popular `sites` entries carry built-in suggestions. */
export function coatiItemsForSite(sites, siteKey) {
  if (siteKey === "*") return [];
  const site = sites.find((s) => `@${s.id}` === siteKey);
  return site ? site.items : [];
}

/**
 * Every item of one case (Coati suggestions minus removed, plus the user's
 * own prompts for that site), in the case's tolerant order — the exact same
 * rule the panel's encart uses (encart-items.js's applyOrder()), so the page
 * and the panel never disagree on ordering.
 * @param {{ siteKey: string, prompts: Array, prefsSites: Record<string, {order?:string[], removed?:string[]}>, sites: Array }} args
 */
export function computeCaseItems({ siteKey, prompts, prefsSites, sites }) {
  const coatiItems = coatiItemsForSite(sites, siteKey);
  const removed = new Set(prefsSites[siteKey]?.removed ?? []);
  const entries = [
    ...coatiItems
      .filter((item) => !removed.has(item.id))
      .map((item) => ({ key: item.id, kind: "coati", label: item.label, body: item.prompt, action: item.action })),
    ...prompts
      .filter((prompt) => prompt.site === siteKey)
      .map((prompt) => ({ key: prompt.id, kind: "user", label: labelForPrompt(prompt), body: prompt.body, title: prompt.title ?? "" })),
  ];
  return applyOrder(entries, prefsSites[siteKey]?.order);
}

/**
 * Fixed board order: the head case ("*" + "@unsorted", `kind: "head"`), then
 * the five popular sites in `sites`' own order, then the user's own sites
 * alphabetically. `alwaysShow` marks the cases that exist even empty (the
 * head case and the five popular ones) — a user site case only exists while
 * it has at least one prompt (checked by the caller against
 * computeCaseItems()'s result, not here).
 *
 * The head descriptor's `key` stays `"*"` (its first, titled part —
 * plan-activation-28-09.md "Points tranchés" 1) so a caller that only reads
 * `.key` still finds the same fixed board order as before this case grew a
 * second, unlabelled `"@unsorted"` part; that second part never gets its own
 * descriptor here — it is never picked from a list of cases, only shown
 * (or not) inside the head case.
 * @param {{ prompts: Array, sites: Array }} args
 */
export function buildCaseDescriptors({ prompts, sites }) {
  const userSiteKeys = new Set();
  for (const prompt of prompts) {
    if (prompt.site === "*" || prompt.site.startsWith("@")) continue;
    userSiteKeys.add(prompt.site);
  }
  const sortedUserSites = [...userSiteKeys].sort((a, b) => a.localeCompare(b));
  return [
    { key: "*", kind: "head", alwaysShow: true },
    ...sites.map((site) => ({ key: `@${site.id}`, title: site.name, alwaysShow: true })),
    ...sortedUserSites.map((key) => ({ key, title: key, alwaysShow: false })),
  ];
}

/**
 * Replaces `oldKey` with `newKey` at `oldKey`'s position in `keys`, dropping
 * any separate occurrence of `newKey` already present. Used when a Coati
 * suggestion is turned into a user prompt (prompts.js's
 * saveEditingCoatiPrompt): prompts.save's tolerant "not in order -> appended
 * at the end" rule already put the freshly created prompt last; this places
 * it exactly where the suggestion it replaces used to be instead.
 * @param {string[]} keys
 * @param {string} oldKey
 * @param {string} newKey
 * @returns {string[]}
 */
export function replaceInOrder(keys, oldKey, newKey) {
  return keys.filter((key) => key !== newKey).map((key) => (key === oldKey ? newKey : key));
}
