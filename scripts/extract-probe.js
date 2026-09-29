// Sonde d'extraction : ouvre une URL dans le navigateur de développement et
// affiche exactement ce que `content/extract.js` en tire — c'est-à-dire ce que
// le modèle recevrait.
//
// Pourquoi ce script : le manifest publié n'accorde aucune permission d'hôte,
// donc l'extraction ne peut pas être déclenchée sans clic humain. La copie de
// développement (scripts/dev-extension.sh) lève cette contrainte, et cette
// sonde s'en sert pour éprouver une page sans mobiliser personne.
//
// Prérequis : un navigateur lancé avec la copie de développement et un port de
// débogage ouvert —
//   COATI_DEV=1 COATI_HEADLESS=0 COATI_CHROME=/usr/bin/brave ./scripts/smoke.sh
//
// Usage :
//   bun scripts/extract-probe.js <url> [port] [--full]
//
// Sans --full, le texte est tronqué à 1200 caractères pour rester lisible.

const url = process.argv[2];
const port = process.argv.find((a) => /^\d+$/.test(a)) ?? "9222";
const full = process.argv.includes("--full");

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
    "Service worker Coati introuvable. Le navigateur est-il lancé avec l'extension ?",
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

// Le service worker orchestre : il ouvre l'onglet, attend que la page soit
// stable, injecte le script d'extraction, puis referme. Tout se passe dans le
// navigateur — ce script ne fait que lire le résultat.
const script = `
(async () => {
  const tab = await chrome.tabs.create({ url: ${JSON.stringify(url)}, active: true });
  try {
    // Attend l'état "complete", puis laisse une marge aux pages qui peignent
    // leur contenu après le chargement (React, hydratation, lazy loading).
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
      files: ["content/extract.js"],
    });
    return JSON.stringify(results?.[0]?.result ?? { error: "aucun résultat" });
  } finally {
    await chrome.tabs.remove(tab.id).catch(() => {});
  }
})()
`;

let raw;
try {
  raw = await evaluate(script);
} catch (err) {
  console.error("ÉCHEC :", err.message);
  ws.close();
  process.exit(1);
}
ws.close();

const result = JSON.parse(raw);
const text = result.text ?? "";

console.log("──────────────────────────────────────────");
console.log("type      :", result.kind);
console.log("titre     :", result.title);
console.log("url       :", result.url);
if (result.videoId) console.log("vidéo     :", result.videoId);
if (result.needsTranscript) console.log("⚠ transcription non ouverte — rien à résumer");
console.log("caractères:", text.length);
console.log("lignes    :", text ? text.split("\n").length : 0);
console.log("──────────────────────────────────────────");
console.log(full || text.length <= 1200 ? text : text.slice(0, 1200) + "\n…(tronqué, --full pour tout)");
