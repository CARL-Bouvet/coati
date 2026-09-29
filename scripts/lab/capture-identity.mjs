#!/usr/bin/env node
// Coati state lab — identity board captures.
//
// Screenshots .tmp/lab/identity/board.html?pair=<id> (once per pairing) and
// .tmp/lab/identity/comparatif.html?pairs=... (once per pairing set) into
// the private design tree (see OUT_DIR below). Rebuild the
// lab first (`bun scripts/lab/build-lab.ts`) — this script only reads
// .tmp/lab, it never regenerates it.
//
// Checks, per capture: document.fonts.check('15px <family>') is true (the
// pairing's font really loaded, no fallback) and the page logged zero
// console errors.
//
// Run: node scripts/lab/capture-identity.mjs

import { chromium } from "playwright";
import { mkdirSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..", "..");
const LAB = join(ROOT, ".tmp", "lab");
const OUT_DIR = join(process.env.COATI_INTERNE ?? join(ROOT, "..", "interne"), "design", "identite");

const PAIRS = [
  { id: "p1", file: "p1-manrope-lavande.png", fontFamily: "Manrope" },
  { id: "p2", file: "p2-inter-ocean.png", fontFamily: "Inter" },
  { id: "p3", file: "p3-figtree-foret.png", fontFamily: "Figtree" },
  { id: "p4", file: "p4-geist-roux.png", fontFamily: "Geist" },
];

// Round 2: Ubuntu-like identity — figtree + warm greys, one accent per pair.
const GRIS_PAIRS = [
  { id: "g1", file: "g1-caramel.png", fontFamily: "Figtree" },
  { id: "g2", file: "g2-noisette.png", fontFamily: "Figtree" },
  { id: "g3", file: "g3-cuivre.png", fontFamily: "Figtree" },
  { id: "g4", file: "g4-caramel-fond-gris.png", fontFamily: "Figtree" },
];

// Round 3: the validated Coati palette (private design notes).
const COATI_PAIRS = [{ id: "c1", file: "c1-coati.png", fontFamily: "Figtree" }];

// `node capture-identity.mjs c1` captures only the named boards (no
// comparatifs); no argument = every board and both comparatifs, as before.
const ONLY = process.argv.slice(2);

mkdirSync(OUT_DIR, { recursive: true });

let anyProblem = false;

async function withPage(browser, fn) {
  const context = await browser.newContext({ deviceScaleFactor: 2 });
  const page = await context.newPage();
  const consoleErrors = [];
  page.on("console", (msg) => {
    if (msg.type() === "error") consoleErrors.push(msg.text());
  });
  page.on("pageerror", (err) => consoleErrors.push(String(err)));
  const result = await fn(page);
  await context.close();
  return { ...result, consoleErrors };
}

async function fontLoadedInFrames(page, fontFamily) {
  // The pairing's font is registered by lab-pair.js inside each iframe
  // (real panel.html) document, not in the top page — check there.
  const results = [];
  for (const frame of page.frames()) {
    if (frame === page.mainFrame()) continue;
    results.push(
      await frame.evaluate((family) => document.fonts.check(`15px '${family}'`), fontFamily),
    );
  }
  return results.length > 0 && results.every(Boolean);
}

async function captureBoard(browser, pair) {
  return withPage(browser, async (page) => {
    const url = `file://${join(LAB, "identity", "board.html")}?pair=${pair.id}`;
    await page.goto(url);
    await page.evaluate(() => document.fonts.ready);
    // Give the two iframes (real panel pages) time to load and apply fonts.
    await page.waitForTimeout(300);
    for (const frame of page.frames()) {
      if (frame !== page.mainFrame()) await frame.evaluate(() => document.fonts.ready);
    }
    const fontLoaded = await fontLoadedInFrames(page, pair.fontFamily);
    const outPath = join(OUT_DIR, pair.file);
    await page.screenshot({ path: outPath, fullPage: true });
    return { outPath, fontLoaded };
  });
}

async function captureComparatif(browser, pairs, outName) {
  return withPage(browser, async (page) => {
    const idsParam = pairs.map((p) => p.id).join(",");
    const url = `file://${join(LAB, "identity", "comparatif.html")}?pairs=${idsParam}`;
    await page.goto(url);
    await page.evaluate(() => document.fonts.ready);
    await page.waitForTimeout(300);
    for (const frame of page.frames()) {
      if (frame !== page.mainFrame()) await frame.evaluate(() => document.fonts.ready);
    }
    const fontChecks = {};
    for (const pair of pairs) {
      const frame = page.frames().find((f) => f.url().includes(`pair=${pair.id}`));
      fontChecks[pair.id] = frame
        ? await frame.evaluate((family) => document.fonts.check(`15px '${family}'`), pair.fontFamily)
        : false;
    }
    const outPath = join(OUT_DIR, outName);
    await page.screenshot({ path: outPath, fullPage: true });
    return { outPath, fontChecks };
  });
}

async function main() {
  const browser = await chromium.launch();

  const boards = [...PAIRS, ...GRIS_PAIRS, ...COATI_PAIRS].filter(
    (p) => ONLY.length === 0 || ONLY.includes(p.id),
  );
  for (const pair of boards) {
    const { outPath, fontLoaded, consoleErrors } = await captureBoard(browser, pair);
    console.log(`[capture] ${pair.id} -> ${outPath} | font loaded: ${fontLoaded} | console errors: ${consoleErrors.length}`);
    if (!fontLoaded || consoleErrors.length > 0) {
      anyProblem = true;
      for (const e of consoleErrors) console.error(`  [console] ${e}`);
    }
  }

  const comparatifs = ONLY.length > 0 ? [] : [
    [PAIRS, "comparatif.png"],
    [GRIS_PAIRS, "comparatif-gris.png"],
  ];
  for (const [pairs, outName] of comparatifs) {
    const { outPath, fontChecks, consoleErrors } = await captureComparatif(browser, pairs, outName);
    console.log(`[capture] ${outName} -> ${outPath} | fonts: ${JSON.stringify(fontChecks)} | console errors: ${consoleErrors.length}`);
    if (Object.values(fontChecks).some((v) => !v) || consoleErrors.length > 0) {
      anyProblem = true;
      for (const e of consoleErrors) console.error(`  [console] ${e}`);
    }
  }

  await browser.close();

  if (anyProblem) {
    console.error("[capture] one or more checks failed — see above");
    process.exit(1);
  }
  console.log("[capture] all checks passed");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
