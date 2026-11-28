// Colour theme preference ("uiTheme" in storage.local), shared by every page
// that loads lib/theme.css. initTheme() applies it and follows changes made on
// another page; buildThemeMenu() is the radio group used by Settings and the
// welcome page. No top-level await: the lab bundles pages as classic scripts.

import { api } from "./browser-compat.js";

export const THEMES = ["masque", "pelage", "caramel", "ardoise"];
export const DEFAULT_THEME = "masque";
export const THEME_STORAGE_KEY = "uiTheme";

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

export function applyTheme(name) {
  document.documentElement.dataset.theme = THEMES.includes(name) ? name : DEFAULT_THEME;
}

export async function initTheme() {
  const stored = await api.storage.local.get(THEME_STORAGE_KEY).catch(() => ({}));
  applyTheme(stored[THEME_STORAGE_KEY]);
  api.storage.onChanged?.addListener((changes, area) => {
    if (area !== "local" || !changes[THEME_STORAGE_KEY]) return;
    const name = changes[THEME_STORAGE_KEY].newValue;
    applyTheme(name);
    const radio = document.querySelector(`input[name="${THEME_STORAGE_KEY}"][value="${name}"]`);
    if (radio) radio.checked = true;
  });
}

export function buildThemeMenu(t) {
  const current = THEMES.includes(document.documentElement.dataset.theme)
    ? document.documentElement.dataset.theme
    : DEFAULT_THEME;
  const menu = el("fieldset", "theme-menu");
  menu.append(el("legend", "theme-menu-title", t("theme_menu_label")));
  for (const name of THEMES) {
    const row = el("label", "c-row theme-option");
    const input = el("input");
    input.type = "radio";
    input.name = THEME_STORAGE_KEY;
    input.value = name;
    input.checked = name === current;
    input.addEventListener("change", () => {
      applyTheme(name);
      api.storage.local.set({ [THEME_STORAGE_KEY]: name });
    });
    row.append(input, el("span", "theme-option-name", t(`theme_name_${name}`)), el("span", "theme-option-desc", t(`theme_desc_${name}`)));
    menu.append(row);
  }
  menu.append(el("p", "theme-note", t("theme_follows_system")));
  return menu;
}
