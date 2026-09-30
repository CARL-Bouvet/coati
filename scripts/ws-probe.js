// Client WebSocket minimal pour éprouver le broker sans passer par le navigateur.
//
// Sert à isoler les pannes : si ce script obtient une réponse et que l'extension
// n'en obtient pas, le problème est côté extension, et réciproquement.
//
// Lit la clé de broker (broker-key.json, amendement 2026-09-30 G4) et déroule
// la poignée de main v: 2 en HMAC-SHA256 — voir docs/PROTOCOL.md "Poignée de
// main `v: 2`".
//
// Usage: bun scripts/ws-probe.js "ma question"

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
    `Aucune clé de broker lisible sous ${dataDir}/broker-key.json — le broker tourne-t-il ? ` +
      "(docs/PROTOCOL.md « Clé de broker »)",
  );
  process.exit(2);
}
const key = Buffer.from(keyFile.key, "hex");

const config = await Bun.file(`${home}/.config/coati/config.json`).json();
const extensionId = config.allowedExtensionIds?.[0];
if (!extensionId) {
  console.error("Aucun allowedExtensionIds dans la config — le broker refusera l'Origin.");
  process.exit(2);
}

function hmacHex(k, message) {
  return createHmac("sha256", k).update(message, "utf8").digest("hex");
}

const question = process.argv[2] ?? "Réponds exactement: PONG";
const ws = new WebSocket(`ws://127.0.0.1:${config.port ?? 8787}/ws`, {
  headers: { Origin: `chrome-extension://${extensionId}` },
});

let answer = "";
const timeout = setTimeout(() => {
  console.error("\nTIMEOUT après 90 s — aucun terminal reçu.");
  process.exit(1);
}, 90000);

const cNonce = randomBytes(32).toString("hex");

ws.onopen = () => {
  console.error("→ connecté, envoi du hello (v: 2)");
  ws.send(JSON.stringify({ type: "hello", v: 2, nonce: cNonce }));
};

ws.onmessage = (ev) => {
  const msg = JSON.parse(ev.data);
  if (msg.type === "challenge") {
    const expectedBrokerProof = hmacHex(key, `coati-v2-broker:${cNonce}:${msg.nonce}`);
    if (msg.proof !== expectedBrokerProof) {
      console.error("← challenge: preuve du broker invalide — clé périmée ou broker usurpé. Abandon.");
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
    console.error(`\n← done (${answer.length} caractères, usage ${JSON.stringify(msg.usage)})`);
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
    console.error(`\nFermeture ${ev.code}: ${ev.reason}`);
    process.exit(1);
  }
};
