// Shared v: 2 handshake client for tests — docs/PROTOCOL.md "Poignée de main
// `v: 2`" (amendement 2026-09-30, G4). Every test suite that needs an
// authenticated WebSocket connection uses connectAndAuthV2 instead of
// hand-rolling the hello/challenge/auth exchange.

import { randomBytes, createHmac } from "node:crypto";

export function hmacHex(key: Buffer, message: string): string {
  return createHmac("sha256", key).update(message, "utf8").digest("hex");
}

export function freshNonceHex(): string {
  return randomBytes(32).toString("hex");
}

export interface ConnectV2Options {
  /** Defaults to "native". */
  keyLabel?: "native" | "pasted";
  /** Override the client nonce sent in `hello` (default: fresh random). */
  cNonce?: string;
  /** If set, sent instead of the correctly computed `auth` proof. */
  authProofOverride?: string;
  /** Skip sending `auth` entirely after the challenge (to test timeout/etc). */
  skipAuth?: boolean;
  /** Raw BCP 47 tag sent as `hello.lang` (Goal G6 — docs/PROTOCOL.md "Langue
   * de la connexion"). Omitted means no `lang` field at all, same as a real
   * client that doesn't (yet) send one. */
  lang?: string;
}

export interface ConnectV2Result {
  ws: WebSocket;
  /** True iff a `hello-ok` was received. */
  ok: boolean;
  closeCode?: number;
  /** The broker's own proof from the `challenge` message, if received. */
  brokerProof?: string;
  challengeNonce?: string;
}

/**
 * Opens a WebSocket to `wsUrl` with the given Origin, performs the full v: 2
 * handshake against `key` (the expected broker key — native key or legacy
 * secret S, whichever `keyLabel` designates), and resolves once either
 * `hello-ok` or a `close` event arrives.
 */
export function connectAndAuthV2(
  wsUrl: string,
  origin: string,
  key: Buffer,
  opts: ConnectV2Options = {},
): Promise<ConnectV2Result> {
  const cNonce = opts.cNonce ?? freshNonceHex();
  const ws = new WebSocket(wsUrl, { headers: { Origin: origin } } as any);
  return new Promise((resolve) => {
    let brokerProof: string | undefined;
    let challengeNonce: string | undefined;
    ws.addEventListener("open", () => {
      const hello: Record<string, unknown> = { type: "hello", v: 2, nonce: cNonce };
      if (opts.keyLabel) hello.key = opts.keyLabel;
      if (opts.lang !== undefined) hello.lang = opts.lang;
      ws.send(JSON.stringify(hello));
    });
    ws.addEventListener("message", (event) => {
      const msg = JSON.parse(event.data as string);
      if (msg.type === "challenge") {
        brokerProof = msg.proof;
        challengeNonce = msg.nonce;
        if (opts.skipAuth) return;
        const proof =
          opts.authProofOverride ?? hmacHex(key, `coati-v2-extension:${cNonce}:${msg.nonce}`);
        ws.send(JSON.stringify({ type: "auth", v: 2, proof }));
        return;
      }
      if (msg.type === "hello-ok") {
        resolve({ ws, ok: true, brokerProof, challengeNonce });
      }
    });
    ws.addEventListener("close", (event) => {
      resolve({ ws, ok: false, closeCode: event.code, brokerProof, challengeNonce });
    });
  });
}

/** Convenience: connects, requires success (throws if not), returns the raw
 * WebSocket only — for suites whose body only cares about the authed socket. */
export async function connectAndAuthV2OrThrow(wsUrl: string, origin: string, key: Buffer): Promise<WebSocket> {
  const result = await connectAndAuthV2(wsUrl, origin, key);
  if (!result.ok) throw new Error(`handshake failed, closeCode=${result.closeCode}`);
  return result.ws;
}
