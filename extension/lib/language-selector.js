// Language selector (U1 — the language selector design notes,
// "Forme du sélecteur de langue" / "Technique du sélecteur"). One shared
// component mounted twice: compact in the panel header (next to the gear
// button, same size/style), full-width in the options page.
//
// No flag (a flag names a country, not a language — see the plan). Each
// language is written in its own name (English, Français, 简体中文) plus a
// translated "Browser language" entry for "auto". Keyboard-accessible:
// button + menu ARIA roles, arrow keys move focus, Esc closes and returns
// focus to the button.
//
// Security rule 3 (no innerHTML from untrusted data): every node here is
// built with createElement/textContent — the strings come from our own
// messages.json, never from page content, but the rule is kept uniformly.
import { api } from "./browser-compat.js";
import { t, getUiLangState, setUiLangPreference, onLanguageChange } from "./i18n-page.js";
import { SUPPORTED_LANGS, UI_LANG_AUTO, UI_LANG_STORAGE_KEY } from "./ui-lang.js";

// Short code shown on the compact button: the target language's OWN label
// for itself, language-invariant by design (English is always "EN" — it
// never gets translated into the current UI language, same as the "Français"
// menu entry below). Not routed through messages.json: it carries no accent
// and nothing here is prose — see i18n.js's test for what actually gets
// scanned.
const CODE_LABEL = { en: "EN", fr: "FR", zh_CN: "中" };
const NAME_KEY = { en: "lang_name_en", fr: "lang_name_fr", zh_CN: "lang_name_zh_cn" };

function itemLabel(lang) {
  return lang === UI_LANG_AUTO ? t("lang_name_auto") : t(NAME_KEY[lang]);
}

/** The resolved language's own endonym ("Français", "English", "简体中文") —
 * used by panel.js's first-run card's one-line language mention. */
export function currentLanguageName(state) {
  return itemLabel(state.lang ?? "en");
}

/** Mounts a compact button + menu into `container` (appended as its last
 * child). Returns `{ refresh() }` to re-read the current preference (e.g.
 * after a storage round-trip elsewhere) — menus already self-refresh on
 * every uiLang change via onLanguageChange(). */
export function mountLanguageSelector(container, { compact = true } = {}) {
  const wrapper = document.createElement("div");
  wrapper.className = compact ? "lang-selector" : "lang-selector lang-selector--full";

  const button = document.createElement("button");
  button.type = "button";
  button.id = compact ? "langSelectorButton" : "languageSelectorButton";
  button.className = compact ? "icon-button lang-button" : "lang-button lang-button--full";
  button.setAttribute("aria-haspopup", "menu");
  button.setAttribute("aria-expanded", "false");

  const menu = document.createElement("div");
  menu.className = "lang-menu";
  menu.setAttribute("role", "menu");
  menu.hidden = true;

  const items = new Map(); // lang -> element
  for (const lang of [...SUPPORTED_LANGS, UI_LANG_AUTO]) {
    const item = document.createElement("button");
    item.type = "button";
    item.className = "lang-menu-item";
    item.setAttribute("role", "menuitemradio");
    item.textContent = itemLabel(lang);
    item.addEventListener("click", () => {
      setUiLangPreference(lang);
      closeMenu(true);
    });
    items.set(lang, item);
    menu.appendChild(item);
  }

  wrapper.appendChild(button);
  wrapper.appendChild(menu);
  container.appendChild(wrapper);

  function paint(state) {
    const current = state.lang ?? state.preference;
    const preferenceLabel = state.preference === UI_LANG_AUTO ? itemLabel(UI_LANG_AUTO) : itemLabel(current);
    button.textContent = compact ? CODE_LABEL[current] ?? CODE_LABEL.en : preferenceLabel;
    button.title = t("lang_selector_label");
    button.setAttribute("aria-label", t("lang_selector_label"));
    for (const [lang, item] of items) {
      item.textContent = itemLabel(lang);
      const selected = lang === state.preference;
      item.setAttribute("aria-checked", String(selected));
      item.classList.toggle("lang-menu-item--active", selected);
    }
  }

  async function refresh() {
    paint(await getUiLangState());
  }

  function openMenu() {
    menu.hidden = false;
    button.setAttribute("aria-expanded", "true");
    const active = menu.querySelector(".lang-menu-item--active") || menu.firstElementChild;
    active?.focus();
    document.addEventListener("click", onDocClick, true);
  }

  function closeMenu(refocus) {
    menu.hidden = true;
    button.setAttribute("aria-expanded", "false");
    document.removeEventListener("click", onDocClick, true);
    if (refocus) button.focus();
  }

  function onDocClick(event) {
    if (!wrapper.contains(event.target)) closeMenu(false);
  }

  button.addEventListener("click", () => {
    if (menu.hidden) openMenu();
    else closeMenu(false);
  });

  button.addEventListener("keydown", (event) => {
    if (event.key === "ArrowDown" || event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      openMenu();
    }
  });

  menu.addEventListener("keydown", (event) => {
    const focusables = [...items.values()];
    const index = focusables.indexOf(document.activeElement);
    if (event.key === "Escape") {
      event.preventDefault();
      closeMenu(true);
    } else if (event.key === "ArrowDown") {
      event.preventDefault();
      focusables[(index + 1) % focusables.length]?.focus();
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      focusables[(index - 1 + focusables.length) % focusables.length]?.focus();
    } else if (event.key === "Tab") {
      closeMenu(false);
    }
  });

  onLanguageChange(() => refresh());
  refresh();

  // Live update if the preference changes from elsewhere (another open page,
  // or this component's own click above already repaints via onLanguageChange
  // once the fetch settles, but the *preference* radio-state should flip
  // immediately too).
  api.storage?.onChanged?.addListener?.((changes, areaName) => {
    if (areaName === "local" && UI_LANG_STORAGE_KEY in changes) refresh();
  });

  return { refresh, open: openMenu };
}
