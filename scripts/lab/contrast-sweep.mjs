#!/usr/bin/env bun
// Coati contrast sweep — walks every lab state (panel + options), both
// themes, both widths, and measures text-vs-background contrast for every
// visible interactive element in four conditions: default, hover, keyboard
// focus, active (mouse down). Never a screenshot: the DOM/CSSOM already
// carries everything WCAG needs (computed colour + composed background).
//
// Requires `bun scripts/lab/build-lab.ts` to have run first (reads
// .tmp/lab/index.html for the list of states — never edits extension/ or
// re-derives the fixture list itself, to stay in sync with the real build).
//
// Usage: bun scripts/lab/contrast-sweep.mjs
// Exit code: 0 if no violation, 1 otherwise.

import { chromium } from "playwright";
import { readFileSync, existsSync } from "fs";
import { join } from "path";

const ROOT = join(import.meta.dir, "..", "..");
const LAB_OUT = process.env.COATI_LAB_OUT ?? join(ROOT, ".tmp", "lab"); // same override as build-lab.ts
const INDEX_HTML = join(LAB_OUT, "index.html");

if (!existsSync(INDEX_HTML)) {
  console.error("[contrast-sweep] .tmp/lab/index.html missing — run `bun scripts/lab/build-lab.ts` first.");
  process.exit(1);
}

// --- 1. Collect every (tree, page, state) triple from the generated index. -
function collectStates() {
  const html = readFileSync(INDEX_HTML, "utf8");
  const re = /href="(light|dark)\/(panel\/panel\.html|options\.html|prompts\/prompts\.html)\?state=([\w-]+)"/g;
  const states = [];
  let m;
  while ((m = re.exec(html))) {
    const [, theme, page, state] = m;
    const kind = page.startsWith("panel") ? "panel" : page.startsWith("prompts") ? "prompts" : "options";
    states.push({ theme, page: kind, state });
  }
  return states;
}

const WIDTHS = { panel: [320, 520], options: [520, 800], prompts: [800, 1280] };
const VIEWPORT_HEIGHT = 900;

// Interactive elements in scope (task spec): button, link, role=button,
// summary, select, input, label wrapping a checkbox.
const SELECTOR = [
  "button",
  "a[href]",
  '[role="button"]',
  "summary",
  "select",
  "input",
  "label:has(input[type='checkbox'])",
].join(", ");

// Non-text UI elements checked for the WCAG 1.4.11 "graphical object"
// contrast (>= 3:1 against their background) rather than the text-vs-bg
// rule above — the "Lire la page" switch track (Lot 2) has no text of its
// own to measure.
const UI_SELECTOR = [".switch-track"].join(", ");

// --- 2. In-page contrast machinery (runs inside the browser context). ------
const PAGE_SCRIPT = `
function parseColor(str) {
  const m = str.match(/rgba?\\(([^)]+)\\)/);
  if (!m) return null;
  const parts = m[1].split(",").map((s) => parseFloat(s.trim()));
  return { r: parts[0], g: parts[1], b: parts[2], a: parts.length > 3 ? parts[3] : 1 };
}

function composite(fg, bg) {
  // fg over bg, both {r,g,b,a}. Returns {r,g,b,a} (alpha must survive: the
  // caller may composite the result again against a further ancestor).
  const a = fg.a + bg.a * (1 - fg.a);
  if (a === 0) return { r: 255, g: 255, b: 255, a: 0 };
  const chan = (c) => (fg[c] * fg.a + bg[c] * bg.a * (1 - fg.a)) / a;
  return { r: chan("r"), g: chan("g"), b: chan("b"), a };
}

function effectiveBackground(el) {
  // Walk ancestors, composing every non-transparent background found, until
  // fully opaque or we run out of ancestors (fall back to white — the page
  // background theme.css always guarantees via --bg on <body>/<html>).
  let node = el;
  let acc = { r: 255, g: 255, b: 255, a: 0 };
  while (node && acc.a < 1) {
    const cs = getComputedStyle(node);
    const bg = parseColor(cs.backgroundColor);
    if (bg && bg.a > 0) {
      acc = composite(acc, bg);
    }
    node = node.parentElement;
  }
  if (acc.a < 1) acc = composite(acc, { r: 255, g: 255, b: 255, a: 1 });
  return acc;
}

function relLuminance({ r, g, b }) {
  const f = (c) => {
    c = c / 255;
    return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
  };
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
}

function contrastRatio(c1, c2) {
  const l1 = relLuminance(c1) + 0.05;
  const l2 = relLuminance(c2) + 0.05;
  return l1 > l2 ? l1 / l2 : l2 / l1;
}

window.__coatiMeasure = function (el) {
  const cs = getComputedStyle(el);
  const fgParsed = parseColor(cs.color) || { r: 0, g: 0, b: 0, a: 1 };
  const bg = effectiveBackground(el);
  const fg = composite(fgParsed, bg); // in case the text colour itself has alpha
  const ratio = contrastRatio(fg, bg);
  const fontSize = parseFloat(cs.fontSize);
  const fontWeight = parseInt(cs.fontWeight, 10) || 400;
  const isLarge = fontSize >= 24 || (fontSize >= 18.66 && fontWeight >= 700);
  const threshold = isLarge ? 3 : 4.5;
  return {
    ratio: Math.round(ratio * 100) / 100,
    threshold,
    isLarge,
    fg: \`rgb(\${Math.round(fg.r)},\${Math.round(fg.g)},\${Math.round(fg.b)})\`,
    bg: \`rgb(\${Math.round(bg.r)},\${Math.round(bg.g)},\${Math.round(bg.b)})\`,
    disabled: el.disabled === true || el.getAttribute("aria-disabled") === "true",
  };
};

// Non-text UI contrast (WCAG 1.4.11): the element's own background colour
// against whatever sits behind it (its parent's effective background,
// since the element itself is excluded from that walk) — always a flat
// 3:1 threshold, no "large text" exception.
window.__coatiMeasureUI = function (el) {
  const own = parseColor(getComputedStyle(el).backgroundColor) || { r: 0, g: 0, b: 0, a: 0 };
  const behind = effectiveBackground(el.parentElement);
  const fg = composite(own, behind);
  const ratio = contrastRatio(fg, behind);
  return {
    ratio: Math.round(ratio * 100) / 100,
    threshold: 3,
    isLarge: true,
    fg: \`rgb(\${Math.round(fg.r)},\${Math.round(fg.g)},\${Math.round(fg.b)})\`,
    bg: \`rgb(\${Math.round(behind.r)},\${Math.round(behind.g)},\${Math.round(behind.b)})\`,
    disabled: el.closest("button")?.disabled === true,
  };
};

window.__coatiVisible = function (el) {
  if (el.hidden) return false;
  if (el.closest("[hidden]")) return false;
  const rect = el.getBoundingClientRect();
  if (rect.width <= 0 || rect.height <= 0) return false;
  const cs = getComputedStyle(el);
  if (cs.visibility === "hidden" || cs.display === "none") return false;
  if (el.offsetParent === null && cs.position !== "fixed") return false;
  return true;
};
`;

function describeElement(handle) {
  return handle.evaluate((el) => {
    const parts = [el.tagName.toLowerCase()];
    if (el.id) parts.push("#" + el.id);
    if (el.className && typeof el.className === "string") {
      parts.push("." + el.className.trim().split(/\s+/).join("."));
    }
    const text = (el.textContent || "").trim().replace(/\s+/g, " ").slice(0, 24);
    return parts.join("") + (text ? ` "${text}"` : "");
  });
}

async function focusViaTab(page, handle) {
  // Real keyboard focus (Tab), so :focus-visible actually matches — not
  // el.focus() from script, which Chromium does not treat as keyboard focus.
  await page.evaluate(() => document.body.focus());
  for (let i = 0; i < 60; i++) {
    await page.keyboard.press("Tab");
    const isTarget = await handle.evaluate((el) => document.activeElement === el);
    if (isTarget) return true;
  }
  return false;
}

async function measureUI(page) {
  const handles = await page.$$(UI_SELECTOR);
  const results = [];
  for (const handle of handles) {
    const visible = await handle.evaluate((el) => window.__coatiVisible(el));
    if (!visible) continue;
    const label = await describeElement(handle);
    const m = await handle.evaluate((el) => window.__coatiMeasureUI(el));
    results.push({ label, conditions: { default: m } });
  }
  return results;
}

async function measureAll(page) {
  await page.evaluate(new Function(PAGE_SCRIPT));
  const handles = await page.$$(SELECTOR);
  const results = [];
  for (const handle of handles) {
    const visible = await handle.evaluate((el) => window.__coatiVisible(el));
    if (!visible) continue;
    const label = await describeElement(handle);

    const conditions = {};
    conditions.default = await handle.evaluate((el) => window.__coatiMeasure(el));

    // hover
    try {
      await handle.hover({ timeout: 2000 });
      conditions.hover = await handle.evaluate((el) => window.__coatiMeasure(el));
      await page.mouse.move(0, 0);
    } catch {
      conditions.hover = null;
    }

    // keyboard focus
    try {
      const focused = await focusViaTab(page, handle);
      conditions.focus = focused ? await handle.evaluate((el) => window.__coatiMeasure(el)) : null;
      await page.evaluate(() => document.activeElement && document.activeElement.blur());
    } catch {
      conditions.focus = null;
    }

    // active (mouse down, not released)
    try {
      const box = await handle.boundingBox();
      if (box) {
        await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
        await page.mouse.down();
        conditions.active = await handle.evaluate((el) => window.__coatiMeasure(el));
        await page.mouse.up();
      } else {
        conditions.active = null;
      }
    } catch {
      conditions.active = null;
    }

    results.push({ label, conditions });
  }
  return results;
}

async function main() {
  const states = collectStates();
  const browser = await chromium.launch();
  const violations = [];
  const disabledInfo = [];
  let totalChecks = 0;

  for (const { theme, page: pageKind, state } of states) {
    const relPath =
      pageKind === "panel"
        ? `panel/panel.html?state=${state}`
        : pageKind === "prompts"
          ? `prompts/prompts.html?state=${state}`
          : `options.html?state=${state}`;
    const url = `file://${join(LAB_OUT, theme, relPath)}`;
    for (const width of WIDTHS[pageKind]) {
      const page = await browser.newPage({ viewport: { width, height: VIEWPORT_HEIGHT } });
      const consoleErrors = [];
      page.on("console", (msg) => {
        if (msg.type() === "error") consoleErrors.push(msg.text());
      });
      page.on("pageerror", (err) => consoleErrors.push(String(err)));

      await page.goto(url);
      await page.waitForTimeout(50);

      const results = [...(await measureAll(page)), ...(await measureUI(page))];
      for (const { label, conditions } of results) {
        for (const [condName, m] of Object.entries(conditions)) {
          if (!m) continue;
          totalChecks++;
          const where = `${theme}/${pageKind}/${state}@${width} :: ${label} [${condName}]`;
          if (m.disabled) {
            disabledInfo.push({ where, ratio: m.ratio });
            continue;
          }
          if (m.ratio < m.threshold) {
            violations.push({ where, ratio: m.ratio, threshold: m.threshold, fg: m.fg, bg: m.bg });
          }
        }
      }

      if (consoleErrors.length) {
        violations.push({ where: `${theme}/${pageKind}/${state}@${width}`, ratio: "-", threshold: "-", fg: "console-error", bg: consoleErrors.join(" | ") });
      }

      await page.close();
    }
  }

  await browser.close();

  console.log(`[contrast-sweep] ${totalChecks} checks across ${states.length} states x widths.`);
  if (disabledInfo.length) {
    console.log(`\n[info] ${disabledInfo.length} disabled-element measurements (not counted as violations):`);
    for (const d of disabledInfo.slice(0, 10)) console.log(`  - ${d.where} (ratio ${d.ratio})`);
    if (disabledInfo.length > 10) console.log(`  ... and ${disabledInfo.length - 10} more`);
  }

  if (violations.length === 0) {
    console.log("\n[contrast-sweep] 0 violations.");
    process.exit(0);
  }

  console.log(`\n[contrast-sweep] ${violations.length} violation(s):\n`);
  console.log("ratio".padEnd(8) + "threshold".padEnd(11) + "fg".padEnd(18) + "bg".padEnd(18) + "where");
  for (const v of violations) {
    console.log(String(v.ratio).padEnd(8) + String(v.threshold).padEnd(11) + String(v.fg).padEnd(18) + String(v.bg).padEnd(18) + v.where);
  }
  process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
