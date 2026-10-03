// Thin wrapper around the WebExtension i18n API (`_locales/<lang>/messages.json`).
// Two jobs: expose `t(key, substitutions)` for JS-built strings, and
// `applyI18n(root)` to fill static HTML via `data-i18n*` attributes.
//
// U1 (the language selector design notes, "Technique du
// sélecteur"): `chrome.i18n` cannot switch locale at runtime — it's fixed to
// the browser's own UI language for the extension's whole lifetime. So this
// file also loads `_locales/<lang>/messages.json` itself, over `fetch()`,
// for whichever language `uiLang` (chrome.storage.local, see lib/ui-lang.js)
// resolves to, and re-renders every page that called applyI18n()/
// onLanguageChange() when that preference changes (chrome.storage.onChanged)
// — live, no reload. `t()`/`applyI18n()`/`setDocumentLanguage()` keep their
// exact prior signatures so no caller moves; `onLanguageChange()` and
// `getUiLangState()` are new.
//
// The manifest's own `name`/`description` (and the Chrome Web Store
// listing) are NOT covered by any of this — `__MSG_extName__` etc. in
// manifest.json can only ever follow the browser's own UI language
// (platform limitation, no runtime hook), documented in
// the language selector design notes, "Points tranchés par
// défaut".
//
// Security rule 3 (no innerHTML from untrusted data): this file only ever
// writes via `textContent` / attribute setters, never `innerHTML`.
import { api } from "./browser-compat.js";
import { DEFAULT_LANG, SUPPORTED_LANGS, UI_LANG_AUTO, UI_LANG_STORAGE_KEY, normalizeLang, resolveUiLang } from "./ui-lang.js";

// Pure-JS unit tests (`bun test`, e.g. scripts/lab/g5-panel-state.test.ts,
// broker/test/ui-*.test.ts) import panel/lib modules directly, with no
// `chrome`/`browser` global at all — there is no extension runtime to ask.
// Rather than returning bare keys there (which would break every existing
// test asserting on real wording), fall back to reading
// `_locales/fr/messages.json` straight off disk via Node's `fs`, lazily and
// once. This path is only ever reachable under Bun/Node (real browsers have
// no `process`/`require`), so it can never fire inside the shipped extension.
let testMessages = null;

function loadTestMessages() {
  if (testMessages) return testMessages;
  testMessages = {};
  try {
    if (typeof process === "undefined" || !process.versions?.bun) return testMessages;
    // No `import.meta` here on purpose: scripts/lab/build-lab.ts bundles
    // this file into a classic (non-module) IIFE script for the state lab,
    // and a bare `import.meta` token is a SyntaxError there even inside an
    // unreachable branch — parsing a classic script, browsers reject the
    // token on sight, before any code runs. `process.cwd()` gives the same
    // answer without that token: `bun test` runs from this repo's root or
    // from broker/ (CI), so "<cwd or its parent>/extension/_locales/fr/
    // messages.json" resolves the same way
    // every test file already resolves EXT/ROOT paths (join(import.meta.dir,
    // "..", "..") in scripts/lab/*.test.ts) — cwd-based here instead only
    // because it's the one option with no `import.meta` token at all.
    // eslint-disable-next-line no-undef -- Bun/Node only, guarded above.
    const { readFileSync, existsSync } = require("node:fs");
    // eslint-disable-next-line no-undef -- Bun/Node only, guarded above.
    const { join } = require("node:path");
    // `bun test` may run from the repo root (public/) or from a subdirectory
    // (public/broker/ when the CI workflow sets working-directory: broker).
    // Try cwd first, then its parent, so both invocation styles work.
    const rel = join("extension", "_locales", "fr", "messages.json");
    const path = [join(process.cwd(), rel), join(process.cwd(), "..", rel)].find(existsSync);
    if (!path) return testMessages;
    testMessages = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    testMessages = {};
  }
  return testMessages;
}

function applyPlaceholders(text, substitutions) {
  if (substitutions == null) return text;
  const values = Array.isArray(substitutions) ? substitutions : [substitutions];
  let i = 0;
  return text.replace(/\$[A-Z][A-Z0-9_]*\$/g, () => {
    const value = values[i++];
    return value == null ? "" : String(value);
  });
}

// --- Runtime loader (U1) ----------------------------------------------------
//
// Resolves placeholders the same way chrome.i18n.getMessage() does: each
// `$NAME$` token in `message` is looked up (case-insensitively) in the
// entry's own `placeholders` map, whose `content` is either a positional
// reference ("$1", "$2"…) into `substitutions`, or — rarely — a literal
// string. `$$` is a literal `$`. This differs from applyPlaceholders() above
// (which just substitutes in encounter order) in that it honours the actual
// `placeholders` declarations, so reordered named placeholders resolve
// correctly too.
function resolvePlaceholderContent(content, substitutions) {
  const values = Array.isArray(substitutions) ? substitutions : substitutions == null ? [] : [substitutions];
  const positional = /^\$(\d+)$/.exec(typeof content === "string" ? content : "");
  if (!positional) return typeof content === "string" ? content : "";
  const value = values[Number(positional[1]) - 1];
  return value == null ? "" : String(value);
}

function renderMessageEntry(entry, substitutions) {
  const defs = entry.placeholders || {};
  return entry.message.replace(/\$\$|\$([A-Za-z][A-Za-z0-9_]*)\$/g, (full, name) => {
    if (full === "$$") return "$";
    const def = defs[name.toLowerCase()];
    return def ? resolvePlaceholderContent(def.content, substitutions) : full;
  });
}

// Module-level cache: one in-flight/settled load at a time, keyed by nothing
// (only one "current" UI language per page) — re-triggered by
// reloadForLanguageChange() below, never by re-importing (ESM modules are
// singletons per page, which is exactly what's wanted here).
const runtimeState = {
  lang: null, // resolved effective language once loaded (one of SUPPORTED_LANGS), else null
  messages: null, // this language's catalog
  enMessages: null, // English catalog, kept alongside as the documented en-then-key fallback
  loadPromise: null,
};

const changeListeners = new Set();
const renderedRoots = new Set();

function hasRuntime() {
  return Boolean(api?.runtime?.getURL) && typeof fetch === "function";
}

async function fetchMessages(lang) {
  const res = await fetch(api.runtime.getURL(`_locales/${lang}/messages.json`));
  if (!res.ok) throw new Error(`i18n: ${lang} messages.json: HTTP ${res.status}`);
  return res.json();
}

async function resolveEffectiveLang() {
  const browserLang = api?.i18n?.getUILanguage?.();
  try {
    const stored = await api?.storage?.local?.get?.(UI_LANG_STORAGE_KEY);
    return resolveUiLang(stored?.[UI_LANG_STORAGE_KEY], browserLang);
  } catch {
    return normalizeLang(browserLang);
  }
}

function loadRuntimeMessages() {
  if (!hasRuntime()) return Promise.resolve();
  if (runtimeState.loadPromise) return runtimeState.loadPromise;
  runtimeState.loadPromise = (async () => {
    const lang = await resolveEffectiveLang();
    const [messages, enMessages] = await Promise.all([
      fetchMessages(lang).catch(() => null),
      lang === DEFAULT_LANG ? Promise.resolve(null) : fetchMessages(DEFAULT_LANG).catch(() => null),
    ]);
    runtimeState.lang = lang;
    runtimeState.messages = messages;
    runtimeState.enMessages = lang === DEFAULT_LANG ? messages : enMessages;
  })();
  return runtimeState.loadPromise;
}

function rerenderEverything() {
  setDocumentLanguage();
  for (const root of renderedRoots) renderInto(root);
  for (const cb of changeListeners) cb(runtimeState.lang);
}

if (hasRuntime()) {
  // Fire-and-forget kick-off for every context, including the service
  // worker (no document there — see the document-gated branch below for
  // that one). This is what service-worker.js's own t() calls (e.g.
  // sw_request_superseded) end up relying on to have settled by the time a
  // request comes in; it cannot be a top-level await there (forbidden in
  // MV3 service workers), so it stays best-effort async.
  loadRuntimeMessages().then(rerenderEverything);
  api.storage?.onChanged?.addListener?.((changes, areaName) => {
    if (areaName !== "local" || !changes[UI_LANG_STORAGE_KEY]) return;
    runtimeState.loadPromise = null; // force a fresh fetch, the preference moved
    loadRuntimeMessages().then(rerenderEverything);
  });
}

// No top-level await in THIS file: the service worker imports it, and a
// module graph containing top-level await — even behind a branch that never
// runs — makes Chrome refuse the MV3 service worker. Pages and page-side
// modules import lib/i18n-page.js instead, which awaits the catalog.

/** Resolves once the runtime catalog (U1) has loaded — already awaited at
 * module load time in document contexts (see above), so callers that just
 * need to know "is it ready yet" (rather than depend on it at import time)
 * can await this instead of reaching into loadRuntimeMessages() directly. */
export function i18nReady() {
  return loadRuntimeMessages();
}

/** Register a callback fired every time the resolved UI language changes
 * (called once immediately if already loaded). For pages that build their
 * text in JS without going through `applyI18n()`'s `data-i18n*` scaffolding
 * (e.g. welcome.js) — re-run `t()` and re-paint in the callback. */
export function onLanguageChange(callback) {
  changeListeners.add(callback);
  if (runtimeState.lang) callback(runtimeState.lang);
  return () => changeListeners.delete(callback);
}

/** Reload the current page when the user changes `uiLang` afterwards — and
 * only then. Never use onLanguageChange() for this: it fires immediately
 * once the catalog is loaded (always the case in a page, see the top-level
 * await above), which would reload the page in a loop. */
export function reloadOnLanguageChange() {
  api?.storage?.onChanged?.addListener?.((changes, areaName) => {
    if (areaName === "local" && changes[UI_LANG_STORAGE_KEY]) location.reload();
  });
}

/** `{ lang, preference }` — `lang` is the resolved language in use right now
 * (SUPPORTED_LANGS, or null before the first load settles); `preference` is
 * the raw stored value ("auto" by default). Used by lib/language-selector.js
 * to highlight the current choice. */
export async function getUiLangState() {
  const stored = await api?.storage?.local?.get?.(UI_LANG_STORAGE_KEY).catch(() => ({}));
  return { lang: runtimeState.lang, preference: stored?.[UI_LANG_STORAGE_KEY] ?? UI_LANG_AUTO };
}

/** Persists the user's choice ("auto" or one of SUPPORTED_LANGS). Writing
 * triggers chrome.storage.onChanged in every open page, including this one —
 * that's the one and only re-render trigger, here and in the service worker
 * (hello.lang reconnect). */
export async function setUiLangPreference(lang) {
  const value = lang === UI_LANG_AUTO || SUPPORTED_LANGS.includes(lang) ? lang : UI_LANG_AUTO;
  await api.storage.local.set({ [UI_LANG_STORAGE_KEY]: value });
}

/** Look up a message by key. `substitutions` matches the `placeholders` order
 * declared in messages.json (string or array of strings).
 *
 * Falls back to `_locales/fr/messages.json`, read directly (see above), when
 * there is no extension runtime — i.e. under `bun test`. Real extension
 * pages always have `api.i18n`, so that fallback never fires there. */
export function t(key, substitutions) {
  // Preferred: this file's own runtime-loaded catalog (U1) — the only one
  // that can ever disagree with the browser's fixed UI language. Falls back
  // to the catalog's own English entry, then to chrome.i18n (covers the
  // short window before the first load settles), then the test-only disk
  // read, then the bare key.
  const entry = runtimeState.messages?.[key];
  if (entry) return renderMessageEntry(entry, substitutions);
  if (runtimeState.messages) {
    const enEntry = runtimeState.enMessages?.[key];
    if (enEntry) return renderMessageEntry(enEntry, substitutions);
  }
  if (api?.i18n?.getMessage) return api.i18n.getMessage(key, substitutions) || key;
  const testEntry = loadTestMessages()[key];
  return testEntry ? applyPlaceholders(testEntry.message, substitutions) : key;
}

/** Set `<html lang>` from the resolved UI language (falls back to the
 * browser's own, before the first load settles). Call once per page.
 * No-op without an extension runtime (see t()'s fallback comment). */
export function setDocumentLanguage() {
  if (typeof document === "undefined") return;
  const lang = runtimeState.lang ?? api?.i18n?.getUILanguage?.();
  if (lang) document.documentElement.lang = lang;
}

const ATTR_MAP = [
  ["data-i18n", null],
  ["data-i18n-aria-label", "aria-label"],
  ["data-i18n-placeholder", "placeholder"],
  ["data-i18n-title", "title"],
  ["data-i18n-alt", "alt"],
];

function renderInto(root) {
  for (const [attr, targetAttr] of ATTR_MAP) {
    for (const el of root.querySelectorAll(`[${attr}]`)) {
      const key = el.getAttribute(attr);
      const msg = key ? t(key) : "";
      if (!msg) continue;
      if (targetAttr) el.setAttribute(targetAttr, msg);
      else el.textContent = msg;
    }
  }
}

/** Fill every `data-i18n*` attribute found under `root` (default: whole
 * document) with the matching message, then set `<html lang>`. Text content
 * goes through `textContent`, never `innerHTML`.
 *
 * `root` is remembered (U1): once the runtime catalog finishes loading, and
 * again on every later `uiLang` change, this same subtree is re-rendered
 * automatically — callers don't need to call applyI18n() a second time. */
export function applyI18n(root = document) {
  renderedRoots.add(root);
  setDocumentLanguage();
  renderInto(root);
}
