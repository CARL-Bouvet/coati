// Shared UI-language constants and normalisation (U1 — see
// the language selector design notes, "Technique du
// sélecteur"). Pure logic, no `document`/`chrome` access here, so it is safe
// to import from the service worker, every page's i18n bootstrap, and
// extension/lib/language-selector.js alike.
//
// normalizeLang() mirrors broker/src/messages.ts's normalizeLang() byte for
// byte (JS can't import that .ts file at runtime): fr* -> fr; zh* -> zh_CN
// EXCEPT the Traditional-leaning subtags (Hant/TW/HK/MO); everything else,
// including empty/missing, -> en. Keep the two in sync by hand if either
// changes — docs/PROTOCOL.md amendement 2026-09-30 ter is the contract both
// follow.

export const DEFAULT_LANG = "en";
export const SUPPORTED_LANGS = ["en", "fr", "zh_CN"];

/** `"auto"` means "follow the browser's own UI language" — the historical,
 * pre-selector behaviour, and the default so nobody's language changes
 * underneath them on upgrade. */
export const UI_LANG_AUTO = "auto";

/** chrome.storage.local key for the user's explicit choice ("auto" | one of
 * SUPPORTED_LANGS). Never storage.session: this is a preference, not a
 * secret (CLAUDE.md rule #1 doesn't apply — storage.local is fine here). */
export const UI_LANG_STORAGE_KEY = "uiLang";

export function normalizeLang(raw) {
  if (typeof raw !== "string") return DEFAULT_LANG;
  const lower = raw.trim().toLowerCase();
  if (lower.length === 0) return DEFAULT_LANG;
  if (lower.startsWith("fr")) return "fr";
  if (lower.startsWith("zh")) {
    if (/-(hant|tw|hk|mo)(-|$)/.test(lower)) return DEFAULT_LANG;
    return "zh_CN";
  }
  return DEFAULT_LANG;
}

/** Resolves the effective UI language from the stored preference (possibly
 * "auto" or missing/invalid) and the browser's raw UI language tag. */
export function resolveUiLang(uiLangPref, browserUiLanguage) {
  if (typeof uiLangPref === "string" && uiLangPref !== UI_LANG_AUTO && SUPPORTED_LANGS.includes(uiLangPref)) {
    return uiLangPref;
  }
  return normalizeLang(browserUiLanguage);
}
