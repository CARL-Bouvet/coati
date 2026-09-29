#!/usr/bin/env bun
// Sonde de bout en bout (task C2) — rend permanente la sonde jetable écrite
// par l'admin le 2026-09-21 (voir scripts/ws-probe.js, qui reste pour les
// essais manuels au clavier). Répond à "toute la chaîne est-elle vivante ?"
// sans ouvrir de navigateur : lit le jeton de pairage et l'id d'extension
// depuis les mêmes fichiers que le broker et l'extension, ouvre le
// WebSocket, fait la poignée de main, envoie un `summarize` avec un faux
// transcript YouTube, et affiche le résultat.
//
// Usage : bun scripts/probe-summarize.ts
// Sortie : 0 si un `done` est reçu, non nul sinon (poignée de main refusée,
// `error`, timeout). Les lignes destinées à un humain sont en français ; le
// code reste en anglais, comme le reste du dépôt (voir CLAUDE.md).

import { homedir } from "node:os";
import { join } from "node:path";

const TIMEOUT_MS = 150_000;

const FAKE_TRANSCRIPT = [
  "0:00 Bonjour et bienvenue dans cette vidéo de démonstration.",
  "0:08 Aujourd'hui nous allons parler du protocole Coati entre l'extension et le broker.",
  "0:19 Le broker écoute exclusivement sur 127.0.0.1 et vérifie l'origine avant tout traitement.",
  "0:31 Cette sonde sert justement à vérifier que toute la chaîne répond, sans ouvrir de navigateur.",
  "0:45 Merci d'avoir regardé cette fausse vidéo de test.",
].join("\n");

function fail(message: string): never {
  console.error(`✗ ${message}`);
  process.exit(1);
}

async function main(): Promise<void> {
  const dataDir = join(homedir(), ".local", "share", "coati");
  const configDir = join(homedir(), ".config", "coati");
  const pairingPath = join(dataDir, "pairing.txt");
  const configPath = join(configDir, "config.json");

  let token: string;
  try {
    token = (await Bun.file(pairingPath).text()).trim();
  } catch {
    fail(`Jeton de pairage introuvable : ${pairingPath} (le broker a-t-il déjà tourné une fois ?).`);
  }
  if (!token) fail(`Jeton de pairage vide : ${pairingPath}`);

  let config: { port?: number; allowedExtensionIds?: string[] };
  try {
    config = await Bun.file(configPath).json();
  } catch {
    fail(`Config introuvable ou invalide : ${configPath}`);
  }
  const extensionId = config.allowedExtensionIds?.[0];
  if (!extensionId) {
    fail(`Aucun "allowedExtensionIds" dans ${configPath} — le broker refusera l'Origin de toute façon.`);
  }
  const port = config.port ?? 8787;
  const url = `ws://127.0.0.1:${port}/ws`;
  const origin = `chrome-extension://${extensionId}`;

  console.error(`→ connexion à ${url} (Origin: ${origin})`);

  await new Promise<void>((resolve, reject) => {
    const ws = new WebSocket(url, { headers: { Origin: origin } } as ConstructorParameters<typeof WebSocket>[1]);
    let handshakeDone = false;
    let answer = "";
    let settled = false;

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      ws.close();
      reject(new Error(`Timeout après ${TIMEOUT_MS / 1000} s — aucune réponse terminale (done/error) reçue.`));
    }, TIMEOUT_MS);

    const finish = (err?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      ws.close();
      if (err) reject(err);
      else resolve();
    };

    ws.onopen = () => {
      console.error("→ connecté, envoi du hello");
      ws.send(JSON.stringify({ type: "hello", secret: token, v: 1 }));
    };

    ws.onmessage = (event) => {
      let msg: any;
      try {
        msg = JSON.parse(event.data as string);
      } catch {
        finish(new Error(`Réponse non-JSON reçue du broker : ${String(event.data).slice(0, 200)}`));
        return;
      }

      if (msg.type === "hello-ok") {
        handshakeDone = true;
        console.error(`← hello-ok, capabilities: ${msg.capabilities?.join(",")}`);
        console.error("→ envoi d'un summarize (faux transcript YouTube)");
        ws.send(
          JSON.stringify({
            type: "summarize",
            id: "probe-summarize-1",
            context: {
              kind: "youtube",
              url: "https://www.youtube.com/watch?v=probe0000000",
              title: "Vidéo de test — sonde Coati",
              videoId: "probe0000000",
              text: FAKE_TRANSCRIPT,
            },
          }),
        );
        return;
      }
      if (msg.type === "chunk") {
        answer += msg.delta;
        process.stdout.write(msg.delta);
        return;
      }
      if (msg.type === "done") {
        console.error(`\n← done (${answer.length} caractères, usage ${JSON.stringify(msg.usage)})`);
        finish();
        return;
      }
      if (msg.type === "error") {
        finish(new Error(`Le broker a répondu une erreur ${msg.code} : ${msg.message}`));
        return;
      }
      // Anything else (e.g. a settings/prompts reply) is unexpected here but
      // not fatal on its own — keep waiting for our own id's terminal.
    };

    ws.onerror = () => {
      finish(new Error(`Connexion WebSocket impossible vers ${url} — le broker tourne-t-il ? (systemctl --user status coati-broker)`));
    };

    ws.onclose = (event) => {
      if (settled) return;
      if (!handshakeDone) {
        finish(
          new Error(
            `Poignée de main refusée (fermeture code ${event.code}) — jeton ou Origin invalide. ` +
              `Vérifiez ${pairingPath} et ${configPath}.`,
          ),
        );
        return;
      }
      if (event.code !== 1000) {
        finish(new Error(`Connexion fermée de façon inattendue (code ${event.code}, raison "${event.reason}").`));
      }
    };
  });

  console.error("✓ Chaîne extension↔broker↔modèle opérationnelle.");
}

main()
  .then(() => process.exit(0))
  .catch((err) => fail(err instanceof Error ? err.message : String(err)));
