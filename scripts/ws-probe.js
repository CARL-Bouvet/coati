// Minimal WebSocket client to probe the broker without going through the browser.
//
// Useful to isolate failures: if this script gets an answer but the extension
// doesn't, the problem is on the extension side, and vice versa.
//
// Reads the broker key (broker-key.json) and runs
// the v: 2 HMAC-SHA256 handshake — see docs/PROTOCOL.md.
//
// Usage: bun scripts/ws-probe.js "my question"

import { createHmac, randomBytes } from "node:crypto";

// os.homedir() reads $HOME on POSIX but $USERPROFILE on Windows (same idiom
// as .github/workflows/tests.yml and scripts/ci/e2e.sh) — COATI_DATA_DIR
// always wins when set (e2e.sh always sets it), so this fallback only
// matters for a bare manual run.
const home = process.env.HOME ?? process.env.USERPROFILE;
const dataDir = process.env.COATI_DATA_DIR ?? `${home}/.local/share/coati`;
const keyFile = await Bun.file(`${dataDir}/broker-key.json`).json().catch(() => null);
if (!keyFile?.key) {
  console.error(
    `No broker key readable at ${dataDir}/broker-key.json — is the broker running? ` +
      "(docs/PROTOCOL.md \"Broker key\")",
  );
  process.exit(2);
}
const key = Buffer.from(keyFile.key, "hex");

const config = await Bun.file(`${home}/.config/coati/config.json`).json();
const extensionId = config.allowedExtensionIds?.[0];
if (!extensionId) {
  console.error("No allowedExtensionIds in config — the broker will reject any Origin.");
  process.exit(2);
}

function hmacHex(k, message) {
  return createHmac("sha256", k).update(message, "utf8").digest("hex");
}

const question = process.argv[2] ?? "Reply exactly: PONG";
const ws = new WebSocket(`ws://127.0.0.1:${config.port ?? 8787}/ws`, {
  headers: { Origin: `chrome-extension://${extensionId}` },
});

let answer = "";
const timeout = setTimeout(() => {
  console.error("\nTIMEOUT after 90 s — no terminal message received.");
  process.exit(1);
}, 90000);

const cNonce = randomBytes(32).toString("hex");

ws.onopen = () => {
  console.error("→ connected, sending hello (v: 2)");
  ws.send(JSON.stringify({ type: "hello", v: 2, nonce: cNonce }));
};

ws.onmessage = (ev) => {
  const msg = JSON.parse(ev.data);
  if (msg.type === "challenge") {
    const expectedBrokerProof = hmacHex(key, `coati-v2-broker:${cNonce}:${msg.nonce}`);
    if (msg.proof !== expectedBrokerProof) {
      console.error("← challenge: invalid broker proof — key mismatch or broker impersonation. Aborting.");
      ws.close();
      process.exit(1);
    }
    const proof = hmacHex(key, `coati-v2-extension:${cNonce}:${msg.nonce}`);
    ws.send(JSON.stringify({ type: "auth", v: 2, proof }));
    return;
  }
  if (msg.type === "hello-ok") {
    console.error("← hello-ok (v: 2)");
    ws.send(JSON.stringify({ type: "chat", id: "probe-1", text: question }));
    return;
  }
  if (msg.type === "chunk") {
    answer += msg.delta;
    process.stdout.write(msg.delta);
    return;
  }
  if (msg.type === "done") {
    clearTimeout(timeout);
    console.error(`\n← done (${answer.length} chars, usage ${JSON.stringify(msg.usage)})`);
    ws.close();
    process.exit(0);
  }
  if (msg.type === "error") {
    clearTimeout(timeout);
    console.error(`\n← error ${msg.code}: ${msg.message}`);
    ws.close();
    process.exit(1);
  }
};

ws.onclose = (ev) => {
  if (ev.code !== 1000) {
    console.error(`\nClosed ${ev.code}: ${ev.reason}`);
    process.exit(1);
  }
};
