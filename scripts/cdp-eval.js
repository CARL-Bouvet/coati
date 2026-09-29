// Minimal CDP helper: evaluates an expression inside the Coati service worker.
//
// Why this exists: the extension's only observable behaviour lives in an MV3
// service worker, which has no UI and cannot be driven from a shell. This
// attaches to Chrome's debugging port, finds our worker, and runs an expression
// in it — enough to seed the pairing token and to read connection state during
// a smoke test.
//
// Usage: bun scripts/cdp-eval.js '<javascript expression>' [debugPort]
// The expression is awaited if it returns a promise.

const expression = process.argv[2];
const port = process.argv[3] ?? "9222";
if (!expression) {
  console.error("usage: bun scripts/cdp-eval.js '<expression>' [port]");
  process.exit(2);
}

const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
const target = targets.find(
  (t) => t.type === "service_worker" && t.url.endsWith("background/service-worker.js"),
);
if (!target) {
  console.error("Coati service worker not found among CDP targets. Is the extension loaded?");
  process.exit(1);
}

const ws = new WebSocket(target.webSocketDebuggerUrl);
const result = await new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error("CDP timeout after 15s")), 15000);
  ws.onopen = () => {
    ws.send(
      JSON.stringify({
        id: 1,
        method: "Runtime.evaluate",
        // userGesture: certaines API d'extension (chrome.sidePanel.open) exigent
        // un geste utilisateur et refusent tout appel programmatique sans lui.
        params: { expression, awaitPromise: true, returnByValue: true, userGesture: true },
      }),
    );
  };
  ws.onmessage = (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.id !== 1) return;
    clearTimeout(timer);
    resolve(msg.result);
  };
  ws.onerror = (err) => {
    clearTimeout(timer);
    reject(err);
  };
});
ws.close();

if (result.exceptionDetails) {
  console.error("EXCEPTION:", JSON.stringify(result.exceptionDetails.exception ?? result.exceptionDetails));
  process.exit(1);
}
console.log(JSON.stringify(result.result?.value ?? result.result));
