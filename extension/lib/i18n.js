// Thin wrapper around the WebExtension i18n API (`_locales/<lang>/messages.json`).
// Two jobs: expose `t(key, substitutions)` for JS-built strings, and
// `applyI18n(root)` to fill static HTML via `data-i18n*` attributes.
//
// Security rule 3 (no innerHTML from untrusted data): this file only ever
// writes via `textContent` / attribute setters, never `innerHTML`.
import { api } from "./browser-compat.js";

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
    // answer without that token: `bun test`/CI always run from this repo's
    // public/ root (see CLAUDE.md / the G6 mission brief), so
    // "<cwd>/extension/_locales/fr/messages.json" resolves the same way
    // every test file already resolves EXT/ROOT paths (join(import.meta.dir,
    // "..", "..") in scripts/lab/*.test.ts) — cwd-based here instead only
    // because it's the one option with no `import.meta` token at all.
    // eslint-disable-next-line no-undef -- Bun/Node only, guarded above.
    const { readFileSync } = require("node:fs");
    // eslint-disable-next-line no-undef -- Bun/Node only, guarded above.
    const { join } = require("node:path");
    const path = join(process.cwd(), "extension", "_locales", "fr", "messages.json");
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

/** Look up a message by key. `substitutions` matches the `placeholders` order
 * declared in messages.json (string or array of strings).
 *
 * Falls back to `_locales/fr/messages.json`, read directly (see above), when
 * there is no extension runtime — i.e. under `bun test`. Real extension
 * pages always have `api.i18n`, so that fallback never fires there. */
export function t(key, substitutions) {
  if (api?.i18n?.getMessage) return api.i18n.getMessage(key, substitutions) || key;
  const entry = loadTestMessages()[key];
  return entry ? applyPlaceholders(entry.message, substitutions) : key;
}

/** Set `<html lang>` from the browser's UI language. Call once per page.
 * No-op without an extension runtime (see t()'s fallback comment). */
export function setDocumentLanguage() {
  if (!api?.i18n?.getUILanguage || typeof document === "undefined") return;
  document.documentElement.lang = api.i18n.getUILanguage();
}

const ATTR_MAP = [
  ["data-i18n", null],
  ["data-i18n-aria-label", "aria-label"],
  ["data-i18n-placeholder", "placeholder"],
  ["data-i18n-title", "title"],
  ["data-i18n-alt", "alt"],
];

/** Fill every `data-i18n*` attribute found under `root` (default: whole
 * document) with the matching message, then set `<html lang>`. Text content
 * goes through `textContent`, never `innerHTML`. */
export function applyI18n(root = document) {
  setDocumentLanguage();
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
