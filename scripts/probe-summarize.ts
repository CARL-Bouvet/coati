#!/usr/bin/env bun
// End-to-end probe (task C2) — makes permanent the throwaway probe written
// by the admin on 2026-09-21 (see scripts/ws-probe.js, kept for interactive
// manual tests). Answers "is the whole chain alive?" without opening a
// browser: reads the pairing token and extension id from the same files the
// broker and extension use, opens the WebSocket, performs the handshake,
// sends a `summarize` with a fake YouTube transcript, and prints the result.
//
// Usage: bun scripts/probe-summarize.ts
// Exit: 0 if a `done` is received, non-zero otherwise (handshake refused,
// `error`, timeout).

import { createHmac, randomBytes } from "node:crypto";
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
  // Handshake v2 (docs/PROTOCOL.md, amendment 2026-09-30): the broker key
  // K is read from the file the running broker writes, as ws-probe.js does.
  const keyPath = join(process.env.COATI_DATA_DIR ?? dataDir, "broker-key.json");
  const configPath = join(configDir, "config.json");

  let key: Buffer;
  try {
    const keyFile = await Bun.file(keyPath).json();
    if (typeof keyFile?.key !== "string" || !/^[0-9a-f]{64}$/.test(keyFile.key)) throw new Error("bad key");
    key = Buffer.from(keyFile.key, "hex");
  } catch {
    fail(`Broker key not found or invalid: ${keyPath} (is the broker running?).`);
  }
  const cNonce = randomBytes(32).toString("hex");
  const hmacHex = (message: string) => createHmac("sha256", key).update(message, "utf8").digest("hex");

  let config: { port?: number; allowedExtensionIds?: string[] };
  try {
    config = await Bun.file(configPath).json();
  } catch {
    fail(`Config not found or invalid: ${configPath}`);
  }
  const extensionId = config.allowedExtensionIds?.[0];
  if (!extensionId) {
    fail(`No "allowedExtensionIds" in ${configPath} — the broker will reject any Origin.`);
  }
  const port = config.port ?? 8787;
  const url = `ws://127.0.0.1:${port}/ws`;
  const origin = `chrome-extension://${extensionId}`;

  console.error(`→ connecting to ${url} (Origin: ${origin})`);

  await new Promise<void>((resolve, reject) => {
    const ws = new WebSocket(url, { headers: { Origin: origin } } as ConstructorParameters<typeof WebSocket>[1]);
    let handshakeDone = false;
    let answer = "";
    let settled = false;

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      ws.close();
      reject(new Error(`Timeout after ${TIMEOUT_MS / 1000} s — no terminal message (done/error) received.`));
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
      console.error("→ connected, sending hello (v: 2)");
      ws.send(JSON.stringify({ type: "hello", v: 2, nonce: cNonce }));
    };

    ws.onmessage = (event) => {
      let msg: any;
      try {
        msg = JSON.parse(event.data as string);
      } catch {
        finish(new Error(`Non-JSON response from broker: ${String(event.data).slice(0, 200)}`));
        return;
      }

      if (msg.type === "challenge") {
        if (msg.proof !== hmacHex(`coati-v2-broker:${cNonce}:${msg.nonce}`)) {
          finish(new Error("Invalid broker proof — key mismatch or broker impersonation."));
          return;
        }
        ws.send(JSON.stringify({ type: "auth", v: 2, proof: hmacHex(`coati-v2-extension:${cNonce}:${msg.nonce}`) }));
        return;
      }

      if (msg.type === "hello-ok") {
        handshakeDone = true;
        console.error("← hello-ok (v: 2)");
        console.error("→ sending summarize (fake YouTube transcript)");
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
        console.error(`\n← done (${answer.length} chars, usage ${JSON.stringify(msg.usage)})`);
        finish();
        return;
      }
      if (msg.type === "error") {
        finish(new Error(`Broker returned error ${msg.code}: ${msg.message}`));
        return;
      }
      // Anything else (e.g. a settings/prompts reply) is unexpected here but
      // not fatal on its own — keep waiting for our own id's terminal.
    };

    ws.onerror = () => {
      finish(new Error(`WebSocket connection failed to ${url} — is the broker running? (systemctl --user status coati-broker)`));
    };

    ws.onclose = (event) => {
      if (settled) return;
      if (!handshakeDone) {
        finish(
          new Error(
            `Handshake rejected (close code ${event.code}) — key or Origin invalid. ` +
              `Check ${keyPath} and ${configPath}.`,
          ),
        );
        return;
      }
      if (event.code !== 1000) {
        finish(new Error(`Connection closed unexpectedly (code ${event.code}, reason "${event.reason}").`));
      }
    };
  });

  console.error("✓ Extension↔broker↔model chain is working.");
}

main()
  .then(() => process.exit(0))
  .catch((err) => fail(err instanceof Error ? err.message : String(err)));
