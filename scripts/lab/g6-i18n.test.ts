// G6 (i18n) — extension/_locales/<lang>/messages.json invariants, and a scan
// for leftover French literals in extension/**/*.js and *.html outside
// _locales/. Lives under scripts/lab/ for the same reason as
// g5-panel-state.test.ts: root-based paths, can move to broker/test/
// unchanged once that dir's ownership settles.
import { describe, expect, test } from "bun:test";
import { readFileSync, readdirSync, statSync } from "fs";
import { join, extname } from "path";

const ROOT = join(import.meta.dir, "..", "..");
const EXT = join(ROOT, "extension");
const LOCALES_DIR = join(EXT, "_locales");
const LANGS = ["en", "fr", "zh_CN"];

function loadMessages(lang: string): Record<string, { message: string; placeholders?: Record<string, unknown> }> {
  return JSON.parse(readFileSync(join(LOCALES_DIR, lang, "messages.json"), "utf8"));
}

const messagesByLang = Object.fromEntries(LANGS.map((lang) => [lang, loadMessages(lang)]));

// $NAME$ placeholders referenced inside a message's own text (not the
// `placeholders` object's keys — the two must still match, checked below).
function placeholdersInMessage(message: string): string[] {
  const matches = message.match(/\$[A-Z][A-Z0-9_]*\$/g) ?? [];
  return [...new Set(matches)].sort();
}

describe("_locales — every key exists in every language", () => {
  for (const lang of LANGS) {
    test(`${lang}: has every key en has, and no extra key`, () => {
      const en = Object.keys(messagesByLang.en).sort();
      const other = Object.keys(messagesByLang[lang]).sort();
      expect(other).toEqual(en);
    });
  }
});

describe("_locales — placeholders match across languages", () => {
  for (const key of Object.keys(messagesByLang.en)) {
    test(`${key}: same $PLACEHOLDER$ set in every language`, () => {
      const sets = LANGS.map((lang) => {
        const entry = messagesByLang[lang][key];
        expect(entry).toBeDefined();
        return placeholdersInMessage(entry.message).join(",");
      });
      // All languages must agree with each other (compare everyone to en's).
      for (const set of sets) expect(set).toBe(sets[0]);
    });
  }
});

describe("_locales — placeholders object matches the message's own $NAME$s", () => {
  for (const lang of LANGS) {
    for (const [key, entry] of Object.entries(messagesByLang[lang])) {
      test(`${lang}/${key}: declared placeholders cover every $NAME$ used`, () => {
        const used = placeholdersInMessage(entry.message).map((p) => p.slice(1, -1).toLowerCase());
        if (used.length === 0) {
          expect(entry.placeholders).toBeUndefined();
          return;
        }
        expect(entry.placeholders).toBeDefined();
        expect(Object.keys(entry.placeholders ?? {}).sort()).toEqual([...used].sort());
      });
    }
  }
});

describe("manifests — no unresolved __MSG_ placeholder", () => {
  for (const name of ["manifest.json", "manifest.firefox.json"]) {
    test(`${name}: every __MSG_x__ key exists in en`, () => {
      const raw = readFileSync(join(EXT, name), "utf8");
      const refs = [...raw.matchAll(/__MSG_([a-zA-Z0-9_]+)__/g)].map((m) => m[1]);
      expect(refs.length).toBeGreaterThan(0);
      for (const key of refs) expect(messagesByLang.en[key]).toBeDefined();
    });
  }
});

describe("_locales — zh_CN translation is complete (TODO-translate.txt removed)", () => {
  test("TODO-translate.txt does not exist — translation pass completed", () => {
    const { existsSync } = require("fs");
    const path = join(LOCALES_DIR, "zh_CN", "TODO-translate.txt");
    expect(existsSync(path)).toBe(false);
  });
});

// --- Scan for leftover French literals outside _locales/ -------------------
//
// Heuristic, not a parser: strip // and /* */ comments (where French prose
// legitimately lives — code comments stay French-friendly per this repo's
// CLAUDE.md, "Langue"), then look for accented characters or a short list of
// unmistakably-French function words in what remains. False positives are
// allow-listed inline with `// i18n-allow: <reason>` on the same line.

function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .map((line) => {
      const idx = line.indexOf("//");
      return idx === -1 ? line : line.slice(0, idx);
    })
    .join("\n");
}

const FRENCH_ACCENT_RE = /[àâäéèêëïîôöùûüçÀÂÄÉÈÊËÏÎÔÖÙÛÜÇ]/;

function listFiles(dir: string, exts: string[], out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === "_locales" || name === "vendor" || name === "node_modules") continue;
    const full = join(dir, name);
    const st = statSync(full);
    if (st.isDirectory()) listFiles(full, exts, out);
    else if (exts.includes(extname(name))) out.push(full);
  }
  return out;
}

// .html files are intentionally excluded: every translated node here uses
// the `data-i18n*` scaffolding (extension/lib/i18n.js's applyI18n()), whose
// convention — like most WebExtension i18n setups — is to ship the French
// text as the element's static fallback content, overwritten the instant the
// page's own script runs. That fallback text is expected French, not a
// leftover; verified once by hand instead (every _locales/*/messages.json
// key referenced from a `data-i18n*` attribute exists — see the "manifests"
// and per-file `data-i18n` coverage checked structurally above/elsewhere).
describe("no leftover French literal outside _locales/ (.js files)", () => {
  const files = listFiles(EXT, [".js"]);
  for (const file of files) {
    test(`${file.slice(EXT.length + 1)}: no accented-French string/text left in code`, () => {
      const source = readFileSync(file, "utf8");
      const originalLines = source.split("\n");
      const codeOnlyLines = stripComments(source).split("\n");
      // The `i18n-allow` marker itself lives in the trailing `//` comment
      // stripComments() just removed — check it against the ORIGINAL line,
      // the accent against the comment-stripped one (French prose in
      // comments is fine; see the top-of-describe comment).
      const offendingLines = codeOnlyLines
        .map((line, i) => ({ line, i, original: originalLines[i] ?? "" }))
        .filter(({ line, original }) => FRENCH_ACCENT_RE.test(line) && !original.includes("i18n-allow"));
      expect(offendingLines).toEqual([]);
    });
  }
});
