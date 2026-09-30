// Native Messaging call to the local broker's helper host
// (docs/PROTOCOL.md, amendement 2026-09-30, "Cadrage et échange avec
// l'hôte"). One-shot: the browser starts a fresh host process per call and
// tears it down after the reply — no `connectNative`, nothing kept open.
//
// This module never touches chrome.storage itself (the caller — the service
// worker — decides where the key goes); it only turns
// `runtime.sendNativeMessage` into "a 64-hex key, or a rejection", with a
// hard 5s deadline so a hung/missing host never stalls the handshake.

import { isHex64 } from "./handshake-crypto.js";

export const NATIVE_HOST_NAME = "com.getcoati.broker";
export const NATIVE_HOST_TIMEOUT_MS = 5000;

const KEY_GET_REQUEST = { type: "key.get", v: 1 };

/**
 * @param {{ runtime: { sendNativeMessage(app: string, message: unknown): Promise<unknown> } }} api
 * @param {number} [timeoutMs]
 * @returns {Promise<string>} the 64-hex broker key.
 * @throws whenever the call doesn't produce a valid key — host not
 *   installed/running, wrong id, `{"type":"error",...}` (any code —
 *   "broker-not-running", "forbidden-caller", "bad-request", "internal"),
 *   malformed reply, or the 5s deadline. The caller treats every rejection
 *   the same way: state "no-host" (see service-worker.js), never inspecting
 *   the browser's own rejection message — it varies by browser/version
 *   (docs/PROTOCOL.md: "Les messages d'erreur des navigateurs ne sont pas
 *   analysés").
 */
export async function requestBrokerKeyFromHost(api, timeoutMs = NATIVE_HOST_TIMEOUT_MS) {
  const reply = await Promise.race([
    api.runtime.sendNativeMessage(NATIVE_HOST_NAME, KEY_GET_REQUEST),
    new Promise((_, reject) => setTimeout(() => reject(new Error("native-host-timeout")), timeoutMs)),
  ]);

  if (!reply || typeof reply !== "object" || reply.type !== "key" || !isHex64(reply.key)) {
    throw new Error("native-host-bad-reply");
  }
  return reply.key;
}
