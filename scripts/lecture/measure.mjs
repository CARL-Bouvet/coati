// Measures Coati's generic page reading on a corpus of real pages (internal
// study). Isolated browser, throwaway profile, extension copy
// WITHOUT `key` (different ID: no pairing with the real broker possible). One
// visit per URL; one automatic click on "Accept all" consent banners.
// Usage: node scripts/lecture/measure.mjs [key1,key2…]  (Playwright, run `bun install`
// at the repo root first). Browser: $COATI_BROWSER (default /usr/bin/brave on Linux).
// LEVEL=text (default) injects the text pipeline; LEVEL=dev injects /content/extract-dev.js alone.
// Output: $OUT (default .tmp/lecture/out): <key>.<level>.txt, <key>.png, index.json. Headless
// by default; HEADFUL=1 xvfb-run -a node … for a "visible" browser off-screen.
// Diagnose a miss: node scripts/lecture/why.mjs <key1,key2…> (reads $OUT, writes why.json).
import { chromium } from "playwright";
import { mkdtempSync, rmSync, cpSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { EXTRACT_FILES } from "../../extension/content/extract-files.js";
// content/extract.js is now split across several files, injected
// together and in order (see extract-files.js) — same contract panel.js
// uses, applied here to the extension copy this script loads into Brave.
const LEVEL = process.env.LEVEL || "text";
if (LEVEL !== "text" && LEVEL !== "dev") throw new Error("LEVEL must be text or dev");
const EXTRACT_FILE_PATHS = LEVEL === "dev" ? ["/content/extract-dev.js"] : EXTRACT_FILES.map((f) => `/${f}`);
const ROOT = path.resolve(fileURLToPath(import.meta.url), "../../..");
const OUT = process.env.OUT || path.join(ROOT, ".tmp/lecture/out");
mkdirSync(OUT, { recursive: true });
const only = process.argv[2] ? new Set(process.argv[2].split(",")) : null;
const entries = readFileSync(new URL("./urls.txt", import.meta.url), "utf8").split("\n").map(l => l.trim()).filter(l => l && !l.startsWith("#"))
  .map(l => { const [key, url, ...sel] = l.split(" "); return { key, url, follow: sel.join(" ") || null }; })
  .filter(e => !only || only.has(e.key));
const ext = mkdtempSync("/tmp/coati-ext-");
cpSync(path.join(ROOT, "extension"), ext, { recursive: true });
const m = JSON.parse(readFileSync(ext + "/manifest.json"));
delete m.key; m.name = "Coati (mesure)"; m.host_permissions = ["http://*/*", "https://*/*"]; delete m.optional_host_permissions;
writeFileSync(ext + "/manifest.json", JSON.stringify(m));
const dir = mkdtempSync("/tmp/coati-prof-");
const ctx = await chromium.launchPersistentContext(dir, {
  executablePath: process.env.COATI_BROWSER || "/usr/bin/brave", headless: process.env.HEADFUL !== "1", locale: "fr-FR", viewport: { width: 1280, height: 900 },
  userAgent: "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/154.0.0.0 Safari/537.36",
  args: [`--disable-extensions-except=${ext}`, `--load-extension=${ext}`, "--lang=fr-FR"] });
let [sw] = ctx.serviceWorkers(); if (!sw) sw = await ctx.waitForEvent("serviceworker", { timeout: 15000 });

const PAGE_REPORT = () => {
  const body = document.body ? document.body.innerText || "" : "";
  let shadowHosts = 0, shadowText = 0;
  const walk = (root) => { for (const el of root.querySelectorAll("*")) { if (el.shadowRoot) { shadowHosts++; for (const c of el.shadowRoot.children) shadowText += (c.innerText || "").length; walk(el.shadowRoot); } } };
  try { walk(document); } catch {}
  const iframes = [...document.querySelectorAll("iframe")].filter(f => f.offsetWidth * f.offsetHeight > 40000);
  let crossOrigin = 0; for (const f of iframes) { try { void f.contentDocument.body; } catch { crossOrigin++; } }
  const vp = innerWidth * innerHeight;
  const canvasShare = Math.max(0, ...[...document.querySelectorAll("canvas")].map(c => (c.offsetWidth * c.offsetHeight) / vp));
  const scrollH = document.documentElement.scrollHeight;
  const consentPage = /(^|\.)consent\.(google|youtube)\.com$/.test(location.hostname) || /^(avant d.acc|before you continue)/i.test(document.title);
  const serpResults = document.querySelectorAll("a[href] h3").length;
  const transcriptSegments = document.querySelectorAll("ytd-transcript-segment-renderer").length;
  const tracks = window.ytInitialPlayerResponse?.captions?.playerCaptionsTracklistRenderer?.captionTracks;
  const captionsAvailable = Array.isArray(tracks) ? tracks.length > 0 : null;
  return { consentPage, serpResults, transcriptSegments, captionsAvailable, title: document.title, url: location.href, bodyLen: body.length, shadowHosts, shadowText, bigIframes: iframes.length, crossOriginIframes: crossOrigin, canvasShare: +canvasShare.toFixed(2), screens: +(scrollH / innerHeight).toFixed(1), contentType: document.contentType };
};
async function acceptConsent(page) {
  const re = /^(tout accepter|accepter (et fermer|tout)|accept all( cookies)?|j'accepte|accepter|agree|i agree|autoriser tous les cookies|allow all( cookies)?)$/i;
  for (const frame of page.frames()) {
    try {
      const btns = await frame.$$("button, a[role=button], [role=button], input[type=submit]");
      for (const b of btns) {
        const t = ((await b.innerText().catch(() => "")) || (await b.getAttribute("value")) || "").trim();
        if (re.test(t) && await b.isVisible()) { await b.click({ timeout: 3000 }); await page.waitForTimeout(2500); return t; }
      }
    } catch {}
  }
  return null;
}
const index = [];
for (const e of entries) {
  process.stderr.write(`→ ${e.key}\n`);
  const row = { key: e.key, startUrl: e.url };
  const page = await ctx.newPage();
  try {
    await page.goto(e.url, { waitUntil: "domcontentloaded", timeout: 40000 }).catch(err => { row.gotoError = err.message.split("\n")[0]; });
    await page.waitForTimeout(6000);
    row.consent = await acceptConsent(page);
    if (e.follow) {
      const href = await page.$eval(e.follow, a => a.href).catch(() => null);
      row.followed = href;
      if (href) { await page.goto(href, { waitUntil: "domcontentloaded", timeout: 40000 }).catch(err => { row.gotoError = err.message.split("\n")[0]; }); await page.waitForTimeout(6000); const c2 = await acceptConsent(page); if (c2) row.consent = c2; }
    }
    Object.assign(row, await page.evaluate(PAGE_REPORT).catch(err => ({ reportError: err.message.split("\n")[0] })));
    await page.screenshot({ path: `${OUT}/${e.key}.png` }).catch(() => {});
    await page.bringToFront();
    const t0 = Date.now();
    const ex = await sw.evaluate(async ({ u, files }) => {
      const tabs = await chrome.tabs.query({});
      const tab = tabs.find(t => t.url === u) || tabs.find(t => t.active);
      try {
        const [res] = await chrome.scripting.executeScript({ target: { tabId: tab.id }, files });
        return res && res.result ? res.result : { error: "no result" };
      } catch (err) { return { error: err.message }; }
    }, { u: page.url(), files: EXTRACT_FILE_PATHS });
    row.extractMs = Date.now() - t0;
    const text = ex.text || "";
    Object.assign(row, { extractError: ex.error ?? null, kind: ex.kind ?? null, pageKind: ex.pageKind ?? null, extractedLen: text.length,
      kept: row.bodyLen ? +((text.length / row.bodyLen) * 100).toFixed(1) : null,
      facts: Array.isArray(ex.facts) ? ex.facts.length : 0, items: Array.isArray(ex.items) ? ex.items.length : 0, truncated: text.length >= 40000 });
    const facts = (ex.facts || []).map(f => `  fait   · ${f.label} : ${f.value}`);
    const items = (ex.items || []).map(it => `  item  · ${[it.title, it.price, it.location, it.detail].filter(Boolean).join(" | ")}`);
    writeFileSync(`${OUT}/${e.key}.${LEVEL}.txt`, [`# ${e.key}`, `final url   : ${row.url}`, `title       : ${row.title}`,
      `kind/pageKind: ${row.kind}/${row.pageKind}  facts ${row.facts}  items ${row.items}`,
      `visible page (body.innerText): ${row.bodyLen} chars; shadow DOM: ${row.shadowHosts} hosts, ${row.shadowText} chars; iframes ${row.bigIframes} (${row.crossOriginIframes} cross-origin); canvas ${row.canvasShare} of viewport; height ${row.screens} screens`,
      `extraction: ${row.extractedLen} chars (${row.kept}%), ${row.extractMs} ms${row.extractError ? " — ERROR " + row.extractError : ""}`,
      `consent clicked: ${row.consent ?? "none"}  consent page: ${row.consentPage}  serp results: ${row.serpResults}  transcript segments: ${row.transcriptSegments}  captions: ${row.captionsAvailable}`, ...facts, ...items, "", "--- extracted text ---", text].join("\n"));
  } catch (err) { row.error = String(err.message).split("\n")[0]; }
  index.push(row);
  await page.close();
}
writeFileSync(`${OUT}/index.json`, JSON.stringify(index, null, 1));
for (const r of index) console.log(`${r.key.padEnd(20)} ${r.error || r.extractError ? "ERR " + (r.error || r.extractError).slice(0, 70) : `page ${String(r.bodyLen).padStart(6)} → ${String(r.extractedLen).padStart(6)} (${r.kept}%) ${r.kind}/${r.pageKind} f${r.facts} e${r.items} ombre ${r.shadowHosts}/${r.shadowText} ifr ${r.bigIframes}/${r.crossOriginIframes} cv ${r.canvasShare} ${r.extractMs}ms`}  | ${(r.title || "").slice(0, 45)}`);
await ctx.close(); rmSync(dir, { recursive: true, force: true }); rmSync(ext, { recursive: true, force: true });
