// Mesure de la lecture générique de Coati sur un corpus de pages réelles (étude
// interne du 29/09). Navigateur isolé, profil jetable, copie de
// l'extension SANS `key` (autre ID : aucun appairage possible avec le vrai broker). Une visite
// par adresse ; un seul clic automatique, sur « Tout accepter » d'un bandeau de consentement.
// Usage : node scripts/lecture/measure.mjs [clé1,clé2…]   (Playwright, `bun install` à la racine
// du dépôt d'abord). Navigateur : $COATI_BROWSER (défaut /usr/bin/brave sous Linux).
// Sortie : $OUT (défaut .tmp/lecture/out) : <clé>.txt, <clé>.png, index.json. Sans fenêtre par
// défaut ; HEADFUL=1 xvfb-run -a node … pour un navigateur « visible » hors écran.
// Diagnostic d'un raté : node scripts/lecture/why.mjs <clé1,clé2…> (lit $OUT, écrit why.json).
import { chromium } from "playwright";
import { mkdtempSync, rmSync, cpSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
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
  return { title: document.title, url: location.href, bodyLen: body.length, shadowHosts, shadowText, bigIframes: iframes.length, crossOriginIframes: crossOrigin, canvasShare: +canvasShare.toFixed(2), screens: +(scrollH / innerHeight).toFixed(1), contentType: document.contentType };
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
    const ex = await sw.evaluate(async (u) => {
      const tabs = await chrome.tabs.query({});
      const tab = tabs.find(t => t.url === u) || tabs.find(t => t.active);
      try {
        const [res] = await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ["/content/extract.js"] });
        return res && res.result ? res.result : { error: "no result" };
      } catch (err) { return { error: err.message }; }
    }, page.url());
    row.extractMs = Date.now() - t0;
    const text = ex.text || "";
    Object.assign(row, { extractError: ex.error ?? null, kind: ex.kind ?? null, pageKind: ex.pageKind ?? null, extractedLen: text.length,
      kept: row.bodyLen ? +((text.length / row.bodyLen) * 100).toFixed(1) : null,
      facts: Array.isArray(ex.facts) ? ex.facts.length : 0, items: Array.isArray(ex.items) ? ex.items.length : 0, truncated: text.length >= 40000 });
    const facts = (ex.facts || []).map(f => `  fait   · ${f.label} : ${f.value}`);
    const items = (ex.items || []).map(it => `  entrée · ${[it.title, it.price, it.location, it.detail].filter(Boolean).join(" | ")}`);
    writeFileSync(`${OUT}/${e.key}.txt`, [`# ${e.key}`, `url finale : ${row.url}`, `titre : ${row.title}`,
      `kind/pageKind : ${row.kind}/${row.pageKind}  faits ${row.facts}  entrées ${row.items}`,
      `page visible (body.innerText) : ${row.bodyLen} car. ; ombre (shadow DOM) : ${row.shadowHosts} hôtes, ${row.shadowText} car. ; iframes ${row.bigIframes} (dont ${row.crossOriginIframes} d'une autre origine) ; canvas ${row.canvasShare} de l'écran ; hauteur ${row.screens} écrans`,
      `extraction : ${row.extractedLen} car. (${row.kept} %), ${row.extractMs} ms${row.extractError ? " — ERREUR " + row.extractError : ""}`,
      `consentement cliqué : ${row.consent ?? "non"}`, ...facts, ...items, "", "--- texte extrait ---", text].join("\n"));
  } catch (err) { row.error = String(err.message).split("\n")[0]; }
  index.push(row);
  await page.close();
}
writeFileSync(`${OUT}/index.json`, JSON.stringify(index, null, 1));
for (const r of index) console.log(`${r.key.padEnd(20)} ${r.error || r.extractError ? "ERR " + (r.error || r.extractError).slice(0, 70) : `page ${String(r.bodyLen).padStart(6)} → ${String(r.extractedLen).padStart(6)} (${r.kept}%) ${r.kind}/${r.pageKind} f${r.facts} e${r.items} ombre ${r.shadowHosts}/${r.shadowText} ifr ${r.bigIframes}/${r.crossOriginIframes} cv ${r.canvasShare} ${r.extractMs}ms`}  | ${(r.title || "").slice(0, 45)}`);
await ctx.close(); rmSync(dir, { recursive: true, force: true }); rmSync(ext, { recursive: true, force: true });
