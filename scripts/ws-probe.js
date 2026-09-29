// Client WebSocket minimal pour éprouver le broker sans passer par le navigateur.
//
// Sert à isoler les pannes : si ce script obtient une réponse et que l'extension
// n'en obtient pas, le problème est côté extension, et réciproquement.
//
// Usage: bun scripts/ws-probe.js "ma question"

const token = (await Bun.file(`${process.env.HOME}/.local/share/coati/pairing.txt`).text()).trim();
const config = await Bun.file(`${process.env.HOME}/.config/coati/config.json`).json();
const extensionId = config.allowedExtensionIds?.[0];
if (!extensionId) {
  console.error("Aucun allowedExtensionIds dans la config — le broker refusera l'Origin.");
  process.exit(2);
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

ws.onopen = () => {
  console.error("→ connecté, envoi du hello");
  ws.send(JSON.stringify({ type: "hello", secret: token, v: 1 }));
};

ws.onmessage = (ev) => {
  const msg = JSON.parse(ev.data);
  if (msg.type === "hello-ok") {
    console.error("← hello-ok, capabilities:", msg.capabilities?.join(","));
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
