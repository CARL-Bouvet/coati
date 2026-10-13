// Extraction probe: opens a URL in the development browser and prints exactly
// what `content/extract.js` extracts from it — i.e. what the model would receive.
//
// Why this script: the published manifest grants no host permission, so
// extraction cannot be triggered without a human click. The development copy
// (scripts/dev-extension.sh) lifts that constraint, and this probe uses it to
// test a page without any manual interaction.
//
// Prerequisites: a browser launched with the development copy and a debug port
// open —
//   COATI_DEV=1 COATI_HEADLESS=0 COATI_CHROME=/usr/bin/brave ./scripts/smoke.sh
//
// Usage:
//   bun scripts/extract-probe.js <url> [port] [--full]
//
// Without --full, text is truncated to 1200 characters for readability.

import { EXTRACT_FILES } from "../extension/content/extract-files.js";

const url = process.argv[2];
const port = process.argv.find((a) => /^\d+$/.test(a)) ?? "9222";
const full = process.argv.includes("--full");

// content/extract.js is now split across several files, injected
// together and in order (see extract-files.js) — same contract panel.js
// uses, applied here through the service worker's own chrome.scripting
// call (no leading slash needed: this probe's `files` path is relative to
// the dev-extension copy's root the same way "content/extract.js" was).
const EXTRACT_FILE_PATHS = EXTRACT_FILES;

if (!url) {
  console.error("usage: bun scripts/extract-probe.js <url> [port] [--full]");
  process.exit(2);
}

const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
const worker = targets.find(
  (t) => t.type === "service_worker" && t.url.endsWith("background/service-worker.js"),
);
if (!worker) {
  console.error(
    "Coati service worker not found. Is the browser running with the extension loaded?",
  );
  process.exit(1);
}

const ws = new WebSocket(worker.webSocketDebuggerUrl);
let nextId = 1;
const pending = new Map();

ws.onmessage = (ev) => {
  const msg = JSON.parse(ev.data);
  const resolve = pending.get(msg.id);
  if (resolve) {
    pending.delete(msg.id);
    resolve(msg);
  }
};

await new Promise((resolve, reject) => {
  ws.onopen = resolve;
  ws.onerror = reject;
});

function evaluate(expression) {
  const id = nextId++;
  return new Promise((resolve, reject) => {
    pending.set(id, (msg) => {
      if (msg.result?.exceptionDetails) {
        reject(
          new Error(
            msg.result.exceptionDetails.exception?.description ??
              JSON.stringify(msg.result.exceptionDetails),
          ),
        );
        return;
      }
      resolve(msg.result?.result?.value);
    });
    ws.send(
      JSON.stringify({
        id,
        method: "Runtime.evaluate",
        params: { expression, awaitPromise: true, returnByValue: true, userGesture: true },
      }),
    );
  });
}

// The service worker orchestrates: it opens the tab, waits for the page to
// settle, injects the extraction script, then closes it. Everything happens in
// the browser — this script only reads the result.
const script = `
(async () => {
  const tab = await chrome.tabs.create({ url: ${JSON.stringify(url)}, active: true });
  try {
    // Wait for "complete" status, then allow extra time for pages that paint
    // their content after load (React, hydration, lazy loading).
    await new Promise((resolve) => {
      const started = Date.now();
      const poll = setInterval(async () => {
        const t = await chrome.tabs.get(tab.id).catch(() => null);
        if (!t || t.status === "complete" || Date.now() - started > 25000) {
          clearInterval(poll);
          resolve();
        }
      }, 500);
    });
    await new Promise((r) => setTimeout(r, 3500));

    const results = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      files: ${JSON.stringify(EXTRACT_FILE_PATHS)},
    });
    return JSON.stringify(results?.[0]?.result ?? { error: "no result" });
  } finally {
    await chrome.tabs.remove(tab.id).catch(() => {});
  }
})()
`;

let raw;
try {
  raw = await evaluate(script);
} catch (err) {
  console.error("FAILED:", err.message);
  ws.close();
  process.exit(1);
}
ws.close();

const result = JSON.parse(raw);
const text = result.text ?? "";

console.log("──────────────────────────────────────────");
console.log("type      :", result.kind);
console.log("title     :", result.title);
console.log("url       :", result.url);
if (result.videoId) console.log("video     :", result.videoId);
if (result.needsTranscript) console.log("⚠ transcript not opened — nothing to summarize");
console.log("chars     :", text.length);
console.log("lines     :", text ? text.split("\n").length : 0);
console.log("──────────────────────────────────────────");
console.log(full || text.length <= 1200 ? text : text.slice(0, 1200) + "\n…(truncated, use --full for all)");
