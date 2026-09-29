// Pure ordering logic for the site card's prompt buttons (plan-mes-prompts,
// lot 3). No DOM, no chrome.* — importable from panel.js and from bun test,
// same pattern as card-state.js.
//
// docs/PROTOCOL.md "Bibliothèque de prompts et préférences par site":
//   - `PromptEntry` = { id, site, title?, body }.
//   - `prefs.sites[site]` = { order?: string[], removed?: string[] } — ids
//     mix Coati suggestion ids (`coati:<site>:<slug>`) and prompt ids
//     (`p_…`). "Lecture tolérante": an id in `order` that matches nothing is
//     skipped; an item missing from `order` is appended at the end, in a
//     fixed default order (Coati suggestions in suggestions-data.js order,
//     then user prompts in list order) — see applyOrder() below, which
//     mirrors that same rule client-side (the broker only tolerates ITS OWN
//     order/removed shape; the panel decides the ON-SCREEN order from data
//     the broker never sorts).

const LABEL_MAX = 40;

/** Cuts `text` at a word boundary at or before `max` characters, appending
 * "…" when it was actually cut. Never cuts mid-word when a space exists in
 * range; falls back to a hard cut only for a single very long word. */
export function truncateLabel(text, max = LABEL_MAX) {
  const trimmed = (text ?? "").trim();
  if (trimmed.length <= max) return trimmed;
  const slice = trimmed.slice(0, max);
  const lastSpace = slice.lastIndexOf(" ");
  const cut = lastSpace > 0 ? slice.slice(0, lastSpace) : slice;
  return `${cut.trimEnd()}…`;
}

/** A button's label: the prompt's title when non-empty, otherwise its body
 * truncated at a word boundary (~40 chars) + "…" (plan-mes-prompts-28-09.md,
 * "Un bouton affiche le titre du prompt ; sans titre, le début du texte").
 * Exported for reuse by prompts/prompts.js (row label — same rule, same
 * page-4 "case" ordering source of truth). */
export function labelForPrompt(prompt) {
  const title = (prompt.title ?? "").trim();
  if (title) return title;
  return truncateLabel(prompt.body);
}

/** Orders `entries` (each already carrying a stable `.key`) per `order`
 * (tolerant rule): ids present in `order` come first, in that order, skipping
 * any id that matches nothing in `entries`; every entry not mentioned in
 * `order` is appended afterwards, in its original `entries` position.
 * Exported for reuse by prompts/prompts.js — the page's "Mes prompts" grid
 * (lot 4) sorts each site's case with the exact same tolerant rule as the
 * panel's encart, so a case never shows a different order in the two
 * places. */
export function applyOrder(entries, order) {
  const byKey = new Map(entries.map((entry) => [entry.key, entry]));
  const seen = new Set();
  const ordered = [];
  for (const key of order ?? []) {
    const entry = byKey.get(key);
    if (entry && !seen.has(key)) {
      ordered.push(entry);
      seen.add(key);
    }
  }
  for (const entry of entries) {
    if (!seen.has(entry.key)) {
      ordered.push(entry);
      seen.add(entry.key);
    }
  }
  return ordered;
}

function toButton(entry) {
  const button = { key: entry.key, kind: entry.kind, label: entry.label };
  if (entry.kind === "coati" && entry.action) button.action = entry.action;
  else button.prompt = entry.prompt;
  return button;
}

/**
 * @param {{
 *   siteKey: string|null,
 *   coatiItems: Array<{id:string, label:string, prompt?:string, action?:string}>,
 *   prompts: Array<{id:string, site:string, title?:string, body:string}>,
 *   prefsSites: Record<string, {order?:string[], removed?:string[]}>,
 * }} args
 * @returns {Array<{key:string, kind:"coati"|"user", label:string, prompt?:string, action?:string}>}
 *   Ordered buttons: the site's own case (Coati suggestions minus removed,
 *   plus the user's prompts for that site, in the case's order), then the
 *   prompts of "*" (Tous les sites), in "*"'s own order. Empty/null siteKey
 *   (T44 — an unreadable page address, no site case at all) → the unnamed
 *   "@unsorted" part of the head case instead, in ITS order, still followed
 *   by "*". A known site never shows "@unsorted" prompts, and vice versa.
 */
export function encartItems({ siteKey, coatiItems = [], prompts = [], prefsSites = {} }) {
  const buttons = [];

  if (siteKey) {
    const sitePrefs = prefsSites[siteKey] ?? {};
    const removed = new Set(sitePrefs.removed ?? []);
    const siteEntries = [
      ...coatiItems
        .filter((item) => !removed.has(item.id))
        .map((item) => ({ key: item.id, kind: "coati", label: item.label, prompt: item.prompt, action: item.action })),
      ...prompts
        .filter((prompt) => prompt.site === siteKey)
        .map((prompt) => ({ key: prompt.id, kind: "user", label: labelForPrompt(prompt), prompt: prompt.body })),
    ];
    buttons.push(...applyOrder(siteEntries, sitePrefs.order).map(toButton));
  } else {
    const unsortedPrefs = prefsSites["@unsorted"] ?? {};
    const unsortedEntries = prompts
      .filter((prompt) => prompt.site === "@unsorted")
      .map((prompt) => ({ key: prompt.id, kind: "user", label: labelForPrompt(prompt), prompt: prompt.body }));
    buttons.push(...applyOrder(unsortedEntries, unsortedPrefs.order).map(toButton));
  }

  const starPrefs = prefsSites["*"] ?? {};
  const starEntries = prompts
    .filter((prompt) => prompt.site === "*")
    .map((prompt) => ({ key: prompt.id, kind: "user", label: labelForPrompt(prompt), prompt: prompt.body }));
  buttons.push(...applyOrder(starEntries, starPrefs.order).map(toButton));

  return buttons;
}
