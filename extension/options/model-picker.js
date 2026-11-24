// Coati options page — the online model picker: a search field, the models
// already used, then the service's catalog grouped by maker (newest first),
// with a "Free only" switch when the service gives prices. Coati reads no
// model name: it orders the service's own facts (docs/PROTOCOL.md `catalog`).

import { t } from "../lib/i18n-page.js";
import { pageLang } from "../lib/labels.js";
import { usdPerQuestion } from "../lib/setup-data.js";
import { formatUsd } from "../options-setup.js";
import { els } from "./dom-refs.js";
import { el, buttonEl } from "./dom-helpers.js";

/** Models shown per maker before "Other versions (N)". */
export const GROUP_HEAD = 3;

/** Newest first by `created`; undated models after, in the service's order. */
function byDate(a, b) {
  if (a.created === undefined || b.created === undefined) return (a.created === undefined) - (b.created === undefined);
  return b.created - a.created;
}

/**
 * Orders a catalog for display.
 * @param {{ id: string, name?: string, maker?: string, created?: number, price?: string }[]} entries
 * @param {{ used?: string[], freeOnly?: boolean, query?: string }} opts
 * @returns {{ used: object[], groups: { maker: string, models: object[] }[] } | { matches: object[] }}
 *   groups in alphabetical order (models without a maker last, under ""), each newest first;
 *   with a query, the matches (id or name) in the same order, used ones first.
 */
export function arrangeModels(entries, { used = [], freeOnly = false, query = "" } = {}) {
  const kept = entries.filter((entry) => !freeOnly || entry.price === "free");
  const byMaker = new Map();
  for (const entry of kept) {
    const maker = entry.maker ?? "";
    if (!byMaker.has(maker)) byMaker.set(maker, []);
    byMaker.get(maker).push(entry);
  }
  const groups = [...byMaker.entries()]
    .sort(([a], [b]) => (a === "") - (b === "") || a.localeCompare(b, undefined, { sensitivity: "base" }))
    .map(([maker, models]) => ({ maker, models: models.sort(byDate) }));
  // A model already used stays reachable even when "Free only" hides it from its group.
  const usedEntries = used.map((id) => entries.find((entry) => entry.id === id) ?? { id });
  const needle = query.trim().toLowerCase();
  if (!needle) return { used: usedEntries, groups };
  const hit = (entry) => entry.id.toLowerCase().includes(needle) || Boolean(entry.name?.toLowerCase().includes(needle));
  const rest = groups.flatMap((group) => group.models).filter((entry) => hit(entry) && !used.includes(entry.id));
  return { matches: [...usedEntries.filter(hit), ...rest] };
}

// Kept across re-renders (each `settings` reply repaints): the groups the
// user unfolded and their own "Free only" choice, per service.
const openGroups = new Set();
const freeOnlyChoice = new Map();
let current = null; // { serviceKey, entries, used, model, account, groupLabel }
let onPick = () => {};

const monthYear = (seconds) => new Date(seconds * 1000).toLocaleDateString(pageLang(), { month: "short", year: "numeric" });

function freeOnly() {
  if (!current) return false;
  return freeOnlyChoice.get(current.serviceKey) ?? current.account?.boughtCredit === false;
}

function modelButton(entry) {
  const chosen = entry.id === current.model;
  const button = buttonEl(null, chosen ? "c-row model-item model-item--current" : "c-row model-item");
  button.setAttribute("aria-pressed", String(chosen));
  button.dataset.model = entry.id;
  const check = el("span", "model-item-check", chosen ? "✓" : ""); // i18n-allow: symbol
  check.setAttribute("aria-hidden", "true");
  const text = el("span", "model-item-text");
  text.append(el("span", "model-item-name", entry.name ?? entry.id));
  const facts = [];
  // Price as the service gives it; a priced catalog says so for a model without a fixed price.
  if (entry.price === "free") facts.push(t("options_model_free"));
  else if (entry.usdPerToken) facts.push(t("options_model_cost_question", [formatUsd(usdPerQuestion(entry.usdPerToken))]));
  else if (current.priced) facts.push(t("options_model_price_unknown"));
  if (entry.created !== undefined) facts.push(monthYear(entry.created));
  // The id may wrap anywhere; each fact after it stays on one line.
  const detail = el("span", "model-item-detail");
  if (entry.name && entry.name !== entry.id) detail.append(entry.id);
  for (const fact of facts) {
    if (detail.firstChild) detail.append(" · "); // i18n-allow: separator
    detail.append(el("span", "model-picker-fact", fact));
  }
  if (detail.firstChild) text.append(detail);
  button.append(check, text);
  button.addEventListener("click", () => onPick(entry.id));
  return button;
}

function section(title, models) {
  const block = el("section", "model-picker-group");
  block.append(el("h4", "model-picker-heading", title), ...models.map(modelButton));
  return block;
}

function makerSection(group) {
  const block = section(group.maker || current.groupLabel, group.models.slice(0, GROUP_HEAD));
  const rest = group.models.slice(GROUP_HEAD);
  if (rest.length === 0) return block;
  const key = `${current.serviceKey}\n${group.maker}`;
  const open = openGroups.has(key);
  if (open) block.append(...rest.map(modelButton));
  const toggle = buttonEl(
    open ? t("options_model_fewer_versions") : t("options_model_other_versions", [String(rest.length)]),
    "c-link model-picker-more",
  );
  toggle.setAttribute("aria-expanded", String(open));
  toggle.addEventListener("click", () => {
    if (open) openGroups.delete(key);
    else openGroups.add(key);
    paint();
    // The list was rebuilt: keep the focus on this group's button.
    els.modelPickerList.querySelector(`[data-group-toggle="${CSS.escape(key)}"]`)?.focus();
  });
  toggle.dataset.groupToggle = key;
  block.append(toggle);
  return block;
}

function paint() {
  const list = els.modelPickerList;
  els.modelFreeRow.hidden = !current.priced;
  els.modelFreeOnly.setAttribute("aria-checked", String(freeOnly()));
  els.modelFreeOnly.classList.toggle("c-switch--on", freeOnly());
  els.modelNoCredit.hidden = current.account?.boughtCredit !== false;

  const query = els.modelSearch.value;
  const arranged = arrangeModels(current.entries, { used: current.used, freeOnly: freeOnly(), query });
  const blocks = [];
  if (arranged.matches) {
    if (arranged.matches.length > 0) blocks.push(section(t("options_model_matches"), arranged.matches));
    else blocks.push(el("p", "model-list-note", t("options_model_no_match", [query.trim()])));
  } else {
    if (arranged.used.length > 0) blocks.push(section(t("options_model_used"), arranged.used));
    blocks.push(...arranged.groups.map(makerSection));
  }
  list.replaceChildren(...blocks);
}

/**
 * Shows the picker for the active online service.
 * @param {{ serviceKey: string, entries: object[], used: string[], model?: string, account?: object, groupLabel: string }} state
 */
export function renderModelPicker(state) {
  current = { ...state, priced: state.entries.some((entry) => entry.price) };
  paint();
}

/** Arrow keys move between the search field and the models; Enter on the field picks a lone match. */
function onKeyDown(event) {
  const items = [...els.modelPickerList.querySelectorAll("button")];
  const at = items.indexOf(document.activeElement);
  let next = null;
  if (event.key === "ArrowDown") next = at < 0 ? items[0] : items[at + 1];
  else if (event.key === "ArrowUp") next = at <= 0 ? els.modelSearch : items[at - 1];
  else if (event.key === "Enter" && event.target === els.modelSearch) {
    const models = items.filter((item) => item.dataset.model);
    if (models.length === 1) models[0].click();
    return;
  } else return;
  if (!next) return;
  event.preventDefault();
  next.focus();
}

/** Wires the picker once (options.js init); `pick(id)` saves the chosen model. */
export function wireModelPicker(pick) {
  onPick = pick;
  els.modelSearch.addEventListener("input", () => current && paint());
  els.modelFreeOnly.addEventListener("click", () => {
    if (!current) return;
    freeOnlyChoice.set(current.serviceKey, !freeOnly());
    paint();
  });
  els.modelSearch.addEventListener("keydown", onKeyDown);
  els.modelPickerList.addEventListener("keydown", onKeyDown);
}
