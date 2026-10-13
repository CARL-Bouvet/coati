// Corpus probe: feeds a list of URLs to an already-running browser (debug port)
// and writes, for each URL, what `content/extract.js` extracts from it — which
// is exactly what the model would receive.
//
// Why this script: `scripts/extract-probe.js` processes one URL at a time and
// shows a truncated excerpt. Comparing a before/after across a dozen pages
// requires stable output written to disk, with enough information to judge what
// was lost (page text size, extraction size, presence of an overlay layer).
//
// Prerequisites: a browser running the development copy of the extension
// (scripts/dev-extension.sh) with a debug port open.
//
// Usage:
//   bun scripts/corpus-probe.ts <urls-file> <port> <output-dir>
//
// The URL file contains one entry per line, `<key> <url>`, blank lines and
// lines starting with # are ignored.

import { mkdir, writeFile, readFile } from "node:fs/promises";
import { join } from "node:path";
import { EXTRACT_FILES } from "../extension/content/extract-files.js";

// content/extract.js is now split across several files, injected
// together and in order (see extract-files.js) — same contract panel.js
// uses, applied here through the dev extension's own service worker.
const EXTRACT_FILE_PATHS = EXTRACT_FILES.map((f) => `/${f}`);

const [urlsFile, portArg, outDir] = process.argv.slice(2);
if (!urlsFile || !portArg || !outDir) {
  console.error("usage: bun scripts/corpus-probe.ts <urls-file> <port> <output-dir>");
  process.exit(2);
}
const port = Number(portArg);

type Entry = { key: string; url: string };

async function readEntries(path: string): Promise<Entry[]> {
  const text = await readFile(path, "utf8");
  return text
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith("#"))
    .map((l) => {
      const i = l.indexOf(" ");
      return { key: l.slice(0, i), url: l.slice(i + 1).trim() };
    });
}

async function cdp(wsUrl: string, expression: string, timeoutMs = 45_000): Promise<any> {
  const ws = new WebSocket(wsUrl);
  try {
    return await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`CDP timeout after ${timeoutMs}ms`)), timeoutMs);
      ws.onerror = () => { clearTimeout(timer); reject(new Error("CDP socket error")); };
      ws.onopen = () =>
        ws.send(JSON.stringify({ id: 1, method: "Runtime.evaluate", params: { expression, awaitPromise: true, returnByValue: true } }));
      ws.onmessage = (ev) => {
        const m = JSON.parse(String(ev.data));
        if (m.id !== 1) return;
        clearTimeout(timer);
        if (m.result?.exceptionDetails) reject(new Error(JSON.stringify(m.result.exceptionDetails).slice(0, 400)));
        else resolve(m.result?.result?.value);
      };
    });
  } finally {
    try { ws.close(); } catch {}
  }
}

/** Runs in the page: what the extraction gets, plus what the page actually holds. */
const PAGE_REPORT = `(() => {
  const body = document.body ? document.body.innerText || "" : "";
  const overlays = [];
  for (const el of document.querySelectorAll("*")) {
    let cs;
    try { cs = getComputedStyle(el); } catch (e) { continue; }
    const txt = el.innerText || "";
    const isOverlay = cs.position === "fixed" || cs.position === "sticky";
    const isDialog = el.getAttribute("role") === "dialog" || el.getAttribute("aria-modal") === "true" || el.tagName === "DIALOG";
    if ((isOverlay || isDialog) && txt.length > 120 && el.offsetHeight > 60) {
      overlays.push({ tag: el.tagName, id: el.id, cls: String(el.className).slice(0, 50), position: cs.position, dialog: isDialog, len: txt.length, head: txt.slice(0, 100).replace(/\\s+/g, " ") });
    }
  }
  const labelled = [];
  for (const dt of document.querySelectorAll("dt")) {
    const dd = dt.nextElementSibling;
    if (dd && dd.tagName === "DD") labelled.push([(dt.innerText || "").trim(), (dd.innerText || "").trim()]);
  }
  return JSON.stringify({ title: document.title, bodyLen: body.length, overlays: overlays.slice(0, 8), definitionPairs: labelled.slice(0, 20) });
})()`;

async function main() {
  await mkdir(outDir, { recursive: true });
  const entries = await readEntries(urlsFile);
  const index: any[] = [];

  for (const { key, url } of entries) {
    process.stderr.write(`→ ${key}\n`);
    const row: any = { key, url };
    try {
      const target = await (await fetch(`http://127.0.0.1:${port}/json/new?${url}`, { method: "PUT" })).json();
      await new Promise((r) => setTimeout(r, 9000)); // let client-side rendering settle
      const pageJson = await cdp(target.webSocketDebuggerUrl, PAGE_REPORT);
      const page = JSON.parse(pageJson);

      // The extraction itself: same call the panel makes, via the dev copy's
      // scripting permission, run from the extension's service worker.
      const sw = (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()).find(
        (t: any) => t.type === "service_worker" && t.url.endsWith("background/service-worker.js"),
      );
      if (!sw) throw new Error("extension service worker not found");
      const extractExpr = `(async () => {
        const tabs = await chrome.tabs.query({});
        const tab = tabs.find(t => t.url === ${JSON.stringify(url)}) || tabs[tabs.length - 1];
        const [res] = await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ${JSON.stringify(EXTRACT_FILE_PATHS)} });
        return JSON.stringify(res && res.result ? res.result : { error: "no result" });
      })()`;
      const extracted = JSON.parse(await cdp(sw.webSocketDebuggerUrl, extractExpr));

      const text = extracted.text || "";
      row.title = page.title;
      row.bodyLen = page.bodyLen;
      row.extractedLen = text.length;
      row.kept = page.bodyLen ? +((text.length / page.bodyLen) * 100).toFixed(1) : null;
      row.overlayCount = page.overlays.length;
      row.overlayHeads = page.overlays.map((o: any) => o.head);
      row.definitionPairs = page.definitionPairs.length;
      row.extractedType = extracted.type ?? extracted.kind ?? null;
      // Page-type fields (docs/PROTOCOL.md, « types de page »). An
      // older extract.js returns none of them: the probe then reports "—".
      const facts: Array<{ label: string; value: string }> = Array.isArray(extracted.facts) ? extracted.facts : [];
      const items: Array<Record<string, string>> = Array.isArray(extracted.items) ? extracted.items : [];
      row.pageKind = extracted.pageKind ?? null;
      row.facts = facts.length;
      row.items = items.length;

      await writeFile(
        join(outDir, `${key}.txt`),
        [
          `# ${key}`,
          `url        : ${url}`,
          `title      : ${page.title}`,
          `type       : ${row.extractedType ?? "?"}`,
          `pageKind   : ${row.pageKind ?? "—"}  (facts: ${facts.length}, items: ${items.length})`,
          ...facts.map((f) => `  fact  · ${f.label}: ${f.value}`),
          ...items.map((it) => `  item  · ${[it.title, it.price, it.location, it.detail].filter(Boolean).join(" | ")}`),
          `page       : ${page.bodyLen} visible chars`,
          `extraction : ${text.length} chars (${row.kept}% of page)`,
          `overlay layers detected: ${page.overlays.length}`,
          ...page.overlays.map((o: any) => `  - ${o.tag}${o.id ? "#" + o.id : ""} [${o.position}${o.dialog ? ", dialog" : ""}] ${o.len} chars: ${o.head}`),
          `label/value pairs (dl): ${page.definitionPairs.length}`,
          ...page.definitionPairs.map(([l, v]: [string, string]) => `  - ${l}: ${v}`),
          "",
          "--- extracted text ---",
          text,
        ].join("\n") + "\n",
        "utf8",
      );
    } catch (err: any) {
      row.error = String(err?.message ?? err).slice(0, 300);
      await writeFile(join(outDir, `${key}.txt`), `# ${key}\nurl  : ${url}\nERROR: ${row.error}\n`, "utf8");
    }
    index.push(row);
  }

  await writeFile(join(outDir, "index.json"), JSON.stringify(index, null, 2) + "\n", "utf8");
  for (const r of index) {
    console.log(
      r.error
        ? `${r.key.padEnd(18)} ERROR ${r.error.slice(0, 80)}`
        : `${r.key.padEnd(18)} page ${String(r.bodyLen).padStart(6)} → text ${String(r.extractedLen).padStart(6)} (${r.kept}%)  pageKind:${r.pageKind ?? "—"}  facts:${r.facts}  items:${r.items}  layers:${r.overlayCount}`,
    );
  }
}

main().catch((err) => {
  console.error("corpus-probe FATAL:", err);
  process.exit(1);
});
