#!/usr/bin/env bun
// Coati state lab — regenerates .tmp/lab/{light,dark}/{panel,options}.html
// from the REAL extension/ source, every run, from scratch. Never edits
// extension/ (task constraint 1); only ever writes under .tmp/lab (constraint
// 2). Run with: `bun scripts/lab/build-lab.ts`.
//
// What it does, in order:
//   1. bundles panel.js / options.js (ES modules) into two classic IIFE
//      scripts with Bun's bundler — file:// refuses <script type="module">
//      (constraint 3).
//   2. builds a light tree and a dark tree (constraint 5): CSS copied
//      verbatim into light/, rewritten (dark media query forced always-on,
//      color-scheme:dark injected) into dark/.
//   3. writes panel.html / options.html per tree: same markup as the real
//      pages, module <script> swapped for stub + fixtures + bundle + harness
//      (constraint 3/4/7).
//   4. writes .tmp/lab/index.html linking every state, in both trees.
//
// Lab-only additions to the panel bundle / page (never in extension/):
//   - LAB_EXTRA_SITES: one extra recognised site with an EMPTY suggestion
//     list, appended to suggestions-data.js at bundle time, so the "site
//     reconnu sans prompt" card state is reachable through the real code.
//   - panel-zones.js: the workflow-front zone map (data-zone / data-rank),
//     applied at runtime — the shipped extension carries no annotation.
//   - a neutral grey square as the fake site favicon.

import { existsSync, mkdirSync, readFileSync, writeFileSync, rmSync, cpSync } from "fs";
import { join, dirname } from "path";

const ROOT = join(import.meta.dir, "..", ".."); // repo root
const EXT = join(ROOT, "extension");
const LAB_SRC = join(ROOT, "scripts", "lab");
// COATI_LAB_OUT: optional override, so two parallel sessions never wipe
// each other's tree (default unchanged).
const OUT = process.env.COATI_LAB_OUT ?? join(ROOT, ".tmp", "lab");
const FONTS_SRC = join(ROOT, ".tmp", "fonts");

function stateIdsFromFixtureFile(path: string): string[] {
  const src = readFileSync(path, "utf8");
  const ids: string[] = [];
  // Matches `  idle: {` / `  "not-activated": {` — top-level fixture keys,
  // 4-space indented directly under the assigned object literal. Also
  // `"id": helper({` (options-fixtures.js builds the U2 guide states with a
  // small factory).
  const re = /^\s{4}(?:"([^"]+)"|([a-zA-Z][\w-]*)):\s*(?:[a-zA-Z]\w*\()?\{/gm;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src))) ids.push(m[1] || m[2]);
  return ids;
}

function rewriteCssForDark(css: string): string {
  // Force the existing `prefers-color-scheme: dark` block to always apply —
  // headless Chromium always reports "light", pyr-inspect can't emulate
  // media (task constraint 5) — and declare the scheme so native controls
  // (scrollbars, checkboxes) follow along, and this keeps working the day
  // theme.css moves to CSS light-dark().
  return css.replace(/@media\s*\(\s*prefers-color-scheme\s*:\s*dark\s*\)/g, "@media screen") + "\n:root{color-scheme:dark;}\n";
}

function ensureDir(path: string) {
  mkdirSync(path, { recursive: true });
}

function writeFile(path: string, content: string) {
  ensureDir(dirname(path));
  writeFileSync(path, content);
}

// Lab-only recognised site with no suggestion at all (plan 28/09, lot 1).
// Appended to extension/lib/suggestions-data.js inside the bundle only.
const LAB_EXTRA_SITES = `
// --- lab-only (scripts/lab/build-lab.ts), never shipped ---
SITES.push({ id: "lab-no-suggestion", name: "Site reconnu", hosts: ["site-reconnu.example"], items: [] });
`;

const labSuggestionsPlugin: import("bun").BunPlugin = {
  name: "coati-lab-suggestions",
  setup(build) {
    build.onLoad({ filter: /[\\/]extension[\\/]lib[\\/]suggestions-data\.js$/ }, (args) => ({
      contents: readFileSync(args.path, "utf8") + LAB_EXTRA_SITES,
      loader: "js",
    }));
  },
};

// The lab bundles as IIFE, which cannot hold a top-level await: lib/i18n-page.js
// (await i18nReady()) becomes a plain re-export of lib/i18n.js here. The lab's
// stub answers t() synchronously, so nothing needs awaiting.
const labI18nPagePlugin: import("bun").BunPlugin = {
  name: "coati-lab-i18n-page",
  setup(build) {
    build.onLoad({ filter: /[\\/]extension[\\/]lib[\\/]i18n-page\.js$/ }, () => ({
      contents: 'export * from "./i18n.js";\n',
      loader: "js",
    }));
  },
};

// Stand-in for a site's favicon, generated here: a blue square with a white
// dot. Must NOT be grey — the panel's "no icon" placeholder is a grey square
// (plan-suggestions Lot 1), and captures must tell the two apart.
const NEUTRAL_FAVICON_SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32" width="32" height="32">' +
  '<rect width="32" height="32" rx="6" fill="#2B6CB0"/><circle cx="16" cy="16" r="6" fill="#FFFFFF"/></svg>\n';

// `withLabExtraSite`: the extra "Site reconnu" entry is a panel-only fixture
// (the "site reconnu sans prompt" card state) — leaking it into the prompts
// bundle would add a phantom 7th always-shown case to every "Mes prompts"
// board, contradicting the page fixtures' documented case counts.
async function bundle(entry: string, outfile: string, opts: { withLabExtraSite?: boolean } = {}) {
  const result = await Bun.build({
    entrypoints: [entry],
    format: "iife",
    target: "browser",
    minify: false,
    naming: "[dir]/[name].[ext]",
    plugins: opts.withLabExtraSite === false ? [labI18nPagePlugin] : [labI18nPagePlugin, labSuggestionsPlugin],
  });
  if (!result.success) {
    for (const log of result.logs) console.error(log);
    throw new Error(`bundling failed for ${entry}`);
  }
  const output = result.outputs.find((o) => o.path.endsWith(".js")) ?? result.outputs[0];
  const code = await output.text();
  writeFile(outfile, code);
}

/** Builds a panel.html / options.html copy: real markup, module <script>
 * swapped for [stub, fixtures, bundle, harness] classic scripts, plus the
 * determinism stylesheet. CSS <link> paths are left untouched — they resolve
 * the same way in every tree because the CSS files themselves are copied to
 * the exact same relative locations as in extension/. */
function buildHtmlPage(opts: {
  srcHtmlPath: string;
  outHtmlPath: string;
  moduleScriptSrc: string; // e.g. "panel.js" or "options.js" (as written in the source HTML)
  bundleRelPath: string; // relative path, from the generated HTML, to its bundle
  stubRelPath: string;
  fixturesRelPath: string;
  harnessRelPath: string;
  determinismRelPath: string;
  identityPairsRelPath: string;
  labPairRelPath: string;
  extraScriptRelPaths?: string[]; // lab-only scripts appended last (e.g. the zone map)
}) {
  let html = readFileSync(opts.srcHtmlPath, "utf8");

  const moduleTagRe = new RegExp(`<script src="${opts.moduleScriptSrc}" type="module"></script>`);
  if (!moduleTagRe.test(html)) {
    throw new Error(`could not find the module <script> tag for ${opts.moduleScriptSrc} in ${opts.srcHtmlPath}`);
  }
  html = html.replace(
    moduleTagRe,
    [
      // Fixtures FIRST: browser-stub.js reads window.__COATI_LAB_FIXTURES__
      // (and, G6, window.__COATI_LAB_MESSAGES__) synchronously at its own top
      // level, so both must already exist.
      `<script src="${opts.fixturesRelPath}"></script>`,
      `<script src="${opts.stubRelPath.replace("browser-stub.js", "lab-messages.js")}"></script>`,
      `<script src="${opts.stubRelPath}"></script>`,
      `<script src="${opts.bundleRelPath}"></script>`,
      `<script src="${opts.harnessRelPath}"></script>`,
      // Identity board support (task: "?pair=" override) — no-op unless the
      // URL carries a `pair` param.
      `<script src="${opts.identityPairsRelPath}"></script>`,
      `<script src="${opts.labPairRelPath}"></script>`,
      ...(opts.extraScriptRelPaths ?? []).map((src) => `<script src="${src}"></script>`),
    ].join("\n  "),
  );

  // Determinism stylesheet (constraint 6), loaded after the page's own CSS.
  html = html.replace("</head>", `  <link rel="stylesheet" href="${opts.determinismRelPath}" />\n</head>`);

  writeFile(opts.outHtmlPath, html);
}

function copyCss(relPath: string, tree: "light" | "dark") {
  const src = join(EXT, relPath);
  const dest = join(OUT, tree, relPath);
  const css = readFileSync(src, "utf8");
  writeFile(dest, tree === "dark" ? rewriteCssForDark(css) : css);
}

async function main() {
  console.log("[lab] cleaning", OUT);
  if (existsSync(OUT)) rmSync(OUT, { recursive: true, force: true });
  ensureDir(OUT);

  // --- 1. Bundle the two ES-module entry points once (shared by both trees:
  // the bundle's content doesn't depend on light/dark). -------------------
  const bundleDir = join(OUT, "_bundle");
  await bundle(join(EXT, "panel", "panel.js"), join(bundleDir, "panel.bundle.js"));
  await bundle(join(EXT, "options.js"), join(bundleDir, "options.bundle.js"));
  await bundle(join(EXT, "prompts", "prompts.js"), join(bundleDir, "prompts.bundle.js"), { withLabExtraSite: false });
  await bundle(join(EXT, "welcome", "welcome.js"), join(bundleDir, "welcome.bundle.js"), { withLabExtraSite: false });

  // --- 2. Shared assets: favicon sample, lab support scripts, fixtures ---
  const assetsDir = join(OUT, "assets");
  ensureDir(assetsDir);
  writeFile(join(assetsDir, "favicon-sample.svg"), NEUTRAL_FAVICON_SVG);

  const labDir = join(OUT, "lab");
  ensureDir(labDir);
  cpSync(join(LAB_SRC, "static", "browser-stub.js"), join(labDir, "browser-stub.js"));
  cpSync(join(LAB_SRC, "static", "lab-runtime.js"), join(labDir, "lab-runtime.js"));
  cpSync(join(LAB_SRC, "static", "lab-determinism.css"), join(labDir, "lab-determinism.css"));
  cpSync(join(LAB_SRC, "fixtures", "panel-fixtures.js"), join(labDir, "panel-fixtures.js"));
  cpSync(join(LAB_SRC, "fixtures", "panel-zones.js"), join(labDir, "panel-zones.js"));
  cpSync(join(LAB_SRC, "fixtures", "panel-annotate.js"), join(labDir, "panel-annotate.js"));
  cpSync(join(LAB_SRC, "fixtures", "options-fixtures.js"), join(labDir, "options-fixtures.js"));
  cpSync(join(LAB_SRC, "fixtures", "identity-pairs.js"), join(labDir, "identity-pairs.js"));
  cpSync(join(LAB_SRC, "static", "lab-pair.js"), join(labDir, "lab-pair.js"));

  // i18n (G6): embed the REAL _locales/<lang>/messages.json files so
  // browser-stub.js's chrome.i18n.getMessage() reflects real wording per
  // `?lang=en|fr|zh_CN` (default fr — see browser-stub.js) instead of a
  // hand-duplicated copy that could drift.
  const langMessages: Record<string, unknown> = {};
  for (const lang of ["en", "fr", "zh_CN"]) {
    langMessages[lang] = JSON.parse(readFileSync(join(EXT, "_locales", lang, "messages.json"), "utf8"));
  }
  writeFile(
    join(labDir, "lab-messages.js"),
    `window.__COATI_LAB_MESSAGES__ = ${JSON.stringify(langMessages)};\n`,
  );

  // --- Identity board: fonts + board page --------------------------------
  const fontsDir = join(assetsDir, "fonts");
  ensureDir(fontsDir);
  for (const font of ["manrope", "inter", "figtree", "geist"]) {
    // Identity-board fonts are a local download, not versioned: a fresh
    // checkout lacks them. Skip with a warning so the panel/options lab
    // still builds; only the identity board falls back to system fonts.
    const src = join(FONTS_SRC, `${font}.woff2`);
    if (!existsSync(src)) {
      console.warn(`[lab] identity font missing, skipped: ${src}`);
      continue;
    }
    cpSync(src, join(fontsDir, `${font}.woff2`));
  }
  const identityDir = join(OUT, "identity");
  cpSync(join(LAB_SRC, "static", "board.html"), join(identityDir, "board.html"));
  cpSync(join(LAB_SRC, "static", "board.js"), join(identityDir, "board.js"));
  cpSync(join(LAB_SRC, "static", "comparatif.html"), join(identityDir, "comparatif.html"));
  cpSync(join(LAB_SRC, "static", "comparatif.js"), join(identityDir, "comparatif.js"));

  cpSync(join(LAB_SRC, "fixtures", "prompts-fixtures.js"), join(labDir, "prompts-fixtures.js"));
  cpSync(join(LAB_SRC, "fixtures", "welcome-fixtures.js"), join(labDir, "welcome-fixtures.js"));

  const panelStates = stateIdsFromFixtureFile(join(LAB_SRC, "fixtures", "panel-fixtures.js"));
  const optionsStates = stateIdsFromFixtureFile(join(LAB_SRC, "fixtures", "options-fixtures.js"));
  const promptsStates = stateIdsFromFixtureFile(join(LAB_SRC, "fixtures", "prompts-fixtures.js"));
  const welcomeStates = stateIdsFromFixtureFile(join(LAB_SRC, "fixtures", "welcome-fixtures.js"));
  console.log("[lab] panel states:", panelStates.join(", "));
  console.log("[lab] options states:", optionsStates.join(", "));
  console.log("[lab] prompts states:", promptsStates.join(", "));
  console.log("[lab] welcome states:", welcomeStates.join(", "));

  for (const tree of ["light", "dark"] as const) {
    // CSS, copied verbatim (light) or dark-rewritten (dark) into the exact
    // same relative paths the real pages already use.
    copyCss("lib/theme.css", tree);
    copyCss("panel/panel.css", tree);
    copyCss("panel/card.css", tree);
    copyCss("options.css", tree);
    copyCss("prompts/prompts.css", tree);
    copyCss("welcome/welcome.css", tree);
    // Same-origin assets the CSS / markup reference by relative path: the
    // shipped Figtree font (lib/theme.css -> ../fonts/).
    cpSync(join(EXT, "fonts"), join(OUT, tree, "fonts"), { recursive: true });
    // The extension's own icons (panel: first-launch logo and the read
    // button's fallback icon; welcome page: fixed logo) — ../icons/ from
    // panel/ and welcome/, same layout as extension/.
    cpSync(join(EXT, "icons"), join(OUT, tree, "icons"), { recursive: true });
    cpSync(join(EXT, "illustrations"), join(OUT, tree, "illustrations"), { recursive: true });

    // Bundles + lab support files, at fixed relative locations reused by
    // both panel.html (in <tree>/panel/) and options.html (in <tree>/).
    cpSync(join(bundleDir, "panel.bundle.js"), join(OUT, tree, "panel", "panel.bundle.js"));
    cpSync(join(bundleDir, "options.bundle.js"), join(OUT, tree, "options.bundle.js"));
    cpSync(join(bundleDir, "prompts.bundle.js"), join(OUT, tree, "prompts", "prompts.bundle.js"));
    cpSync(join(bundleDir, "welcome.bundle.js"), join(OUT, tree, "welcome", "welcome.bundle.js"));

    buildHtmlPage({
      srcHtmlPath: join(EXT, "panel", "panel.html"),
      outHtmlPath: join(OUT, tree, "panel", "panel.html"),
      moduleScriptSrc: "panel.js",
      bundleRelPath: "panel.bundle.js",
      stubRelPath: "../../lab/browser-stub.js",
      fixturesRelPath: "../../lab/panel-fixtures.js",
      harnessRelPath: "../../lab/lab-runtime.js",
      determinismRelPath: "../../lab/lab-determinism.css",
      identityPairsRelPath: "../../lab/identity-pairs.js",
      labPairRelPath: "../../lab/lab-pair.js",
      extraScriptRelPaths: ["../../lab/panel-zones.js", "../../lab/panel-annotate.js"],
    });

    buildHtmlPage({
      srcHtmlPath: join(EXT, "options.html"),
      outHtmlPath: join(OUT, tree, "options.html"),
      moduleScriptSrc: "options.js",
      bundleRelPath: "options.bundle.js",
      stubRelPath: "../lab/browser-stub.js",
      fixturesRelPath: "../lab/options-fixtures.js",
      harnessRelPath: "../lab/lab-runtime.js",
      determinismRelPath: "../lab/lab-determinism.css",
      identityPairsRelPath: "../lab/identity-pairs.js",
      labPairRelPath: "../lab/lab-pair.js",
    });

    buildHtmlPage({
      srcHtmlPath: join(EXT, "prompts", "prompts.html"),
      outHtmlPath: join(OUT, tree, "prompts", "prompts.html"),
      moduleScriptSrc: "prompts.js",
      bundleRelPath: "prompts.bundle.js",
      stubRelPath: "../../lab/browser-stub.js",
      fixturesRelPath: "../../lab/prompts-fixtures.js",
      harnessRelPath: "../../lab/lab-runtime.js",
      determinismRelPath: "../../lab/lab-determinism.css",
      identityPairsRelPath: "../../lab/identity-pairs.js",
      labPairRelPath: "../../lab/lab-pair.js",
    });

    buildHtmlPage({
      srcHtmlPath: join(EXT, "welcome", "welcome.html"),
      outHtmlPath: join(OUT, tree, "welcome", "welcome.html"),
      moduleScriptSrc: "welcome.js",
      bundleRelPath: "welcome.bundle.js",
      stubRelPath: "../../lab/browser-stub.js",
      fixturesRelPath: "../../lab/welcome-fixtures.js",
      harnessRelPath: "../../lab/lab-runtime.js",
      determinismRelPath: "../../lab/lab-determinism.css",
      identityPairsRelPath: "../../lab/identity-pairs.js",
      labPairRelPath: "../../lab/lab-pair.js",
    });
  }

  rmSync(bundleDir, { recursive: true, force: true });

  // --- Propositions page (Romain-facing, static mock fragments + the real
  // panel CSS/markup) — copied verbatim, never generated: it has no fixture
  // dependency, just links into ../light/panel/panel.html. ----------------
  const propositionsSrc = join(LAB_SRC, "propositions");
  if (existsSync(propositionsSrc)) {
    cpSync(propositionsSrc, join(OUT, "propositions"), { recursive: true });
  }

  // --- Human-clickable index -------------------------------------------
  const rows = (tree: "light" | "dark") => {
    const panelLinks = panelStates
      .map((id) => `<li><a href="${tree}/panel/panel.html?state=${id}">panel · ${id}</a></li>`)
      .join("\n      ");
    const optionsLinks = optionsStates
      .map((id) => `<li><a href="${tree}/options.html?state=${id}">options · ${id}</a></li>`)
      .join("\n      ");
    const promptsLinks = promptsStates
      .map((id) => `<li><a href="${tree}/prompts/prompts.html?state=${id}">prompts · ${id}</a></li>`)
      .join("\n      ");
    const welcomeLinks = welcomeStates
      .map((id) => `<li><a href="${tree}/welcome/welcome.html?state=${id}">welcome · ${id}</a></li>`)
      .join("\n      ");
    // G5 (T50): the read button's motion, which the determinism stylesheet
    // freezes everywhere else — live, and frozen at a mid-halo frame.
    const motionLinks = [
      ["read-invite", "live"],
      ["read-invite", "500"],
      ["read-invite-known", "500"],
      ["read-reading", "live"],
      ["read-reading", "200"],
    ]
      .map(
        ([id, motion]) =>
          `<li><a href="${tree}/panel/panel.html?state=${id}&amp;motion=${motion}">panel · ${id} · motion=${motion}</a></li>`,
      )
      .join("\n      ");
    return `<h2>${tree}</h2>\n    <ul>\n      ${panelLinks}\n      ${optionsLinks}\n      ${promptsLinks}\n      ${welcomeLinks}\n    </ul>\n    <h3>${tree} — mouvement (G5, bouton de l'encart)</h3>\n    <ul>\n      ${motionLinks}\n    </ul>`;
  };
  writeFile(
    join(OUT, "index.html"),
    `<!DOCTYPE html>
<html lang="fr">
<head><meta charset="UTF-8" /><title>Coati — state lab</title></head>
<body>
  <h1>Coati — state lab</h1>
  <p>Régénéré par <code>bun scripts/lab/build-lab.ts</code> — jamais édité à la main.</p>
  <p><a href="propositions/index.html"><strong>→ Propositions (pour Romain)</strong></a></p>
  <main>
    ${rows("light")}
    ${rows("dark")}
  </main>
</body>
</html>
`,
  );

  console.log("[lab] done ->", OUT);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
