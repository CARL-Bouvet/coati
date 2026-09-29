import { chromium } from "playwright";
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
const ROOT = path.resolve(fileURLToPath(import.meta.url), "../../..");
const OUT = process.env.OUT || path.join(ROOT, ".tmp/lecture/out");
import { mkdtempSync, rmSync } from "node:fs";
const idx = JSON.parse(readFileSync(`${OUT}/index.json`));
const keys = process.argv[2].split(",");
const dir = mkdtempSync("/tmp/coati-prof-");
const ctx = await chromium.launchPersistentContext(dir, { executablePath: process.env.COATI_BROWSER || "/usr/bin/brave", headless: false, locale: "fr-FR", viewport: { width: 1280, height: 900 },
  userAgent: "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/154.0.0.0 Safari/537.36" });
const out = {};
for (const k of keys) {
  const row = idx.find(r => r.key === k);
  const txt = readFileSync(`${OUT}/${k}.txt`, "utf8").split("--- texte extrait ---\n")[1] || "";
  const prefix = txt.replace(/\s+/g, " ").trim().slice(0, 50);
  const page = await ctx.newPage();
  await page.goto(row.url, { waitUntil: "domcontentloaded", timeout: 40000 }).catch(() => {});
  await page.waitForTimeout(7000);
  out[k] = await page.evaluate((prefix) => {
    const norm = s => (s || "").replace(/\s+/g, " ").trim();
    const desc = el => { const r = el.getBoundingClientRect(); const cs = getComputedStyle(el);
      return { el: el.tagName.toLowerCase() + (el.id ? "#" + el.id : "") + (el.className && typeof el.className === "string" ? "." + el.className.trim().split(/\s+/).slice(0, 3).join(".") : ""),
        rect: [Math.round(r.x), Math.round(r.y), Math.round(r.width), Math.round(r.height)], textLen: (el.innerText || "").length,
        opacity: cs.opacity, visibility: cs.visibility, position: cs.position, transform: cs.transform === "none" ? "" : cs.transform.slice(0, 40), ariaHidden: el.closest("[aria-hidden=true]") ? true : false, inert: !!el.closest("[inert]") }; };
    let chosen = null;
    for (const el of document.querySelectorAll("body *")) { const t = norm(el.innerText); if (t.startsWith(prefix) && (!chosen || t.length <= norm(chosen.innerText).length)) chosen = el; }
    const chain = []; for (let e = chosen; e && e !== document.body && chain.length < 6; e = e.parentElement) chain.push(desc(e));
    const landmarks = [...document.querySelectorAll("main, article, [role=main], #content, #mainContent, .content")].slice(0, 6).map(desc);
    return { prefix, chosenChain: chain, landmarks };
  }, prefix).catch(e => ({ error: e.message }));
  await page.close();
}
writeFileSync(`${OUT}/why.json`, JSON.stringify(out, null, 1));
for (const [k, v] of Object.entries(out)) {
  console.log("=== " + k);
  if (v.error) { console.log(v.error); continue; }
  for (const c of (v.chosenChain || []).slice(0, 4)) console.log("  choisi  ", JSON.stringify(c));
  for (const l of v.landmarks) console.log("  repère  ", JSON.stringify(l));
}
await ctx.close(); rmSync(dir, { recursive: true, force: true });
