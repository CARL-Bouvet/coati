// Integration test: spins up the real Bun.serve server and drives it over an
// actual WebSocket, to check that handshake failures emit the `unauthorized`
// error message the protocol promises (docs/PROTOCOL.md:87-88) before the
// close(4401) — see ARCHITECTURE.md §7 "codes d'erreur morts".

import { describe, expect, test, afterEach } from "bun:test";
import { startServer } from "../src/server.ts";
import type { ServerMessage } from "../src/protocol.ts";
import { makeTmpDir } from "./helpers/tmp-dir.ts";
import { connectAndAuthV2, connectAndAuthV2OrThrow } from "./helpers/handshake-v2.ts";

const ALLOWED_ID = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const KEY = Buffer.from("0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcd", "hex");

let servers: ReturnType<typeof startServer>[] = [];

function boot() {
  const dataDir = makeTmpDir("coati-errors-");
  const server = startServer(
    { port: 0, allowedExtensionIds: [ALLOWED_ID] },
    KEY,
    { dataDir },
  );
  servers.push(server);
  return { server, dataDir };
}

afterEach(() => {
  for (const s of servers) s.stop(true);
  servers = [];
});

/** Collects every ServerMessage received until the socket closes, plus the close code. */
function collectUntilClose(ws: WebSocket): Promise<{ messages: ServerMessage[]; code: number }> {
  const messages: ServerMessage[] = [];
  return new Promise((resolve) => {
    ws.addEventListener("message", (event) => {
      messages.push(JSON.parse(event.data as string));
    });
    ws.addEventListener("close", (event) => {
      resolve({ messages, code: event.code });
    });
  });
}

describe("unauthorized error emission on bad handshake", () => {
  test("wrong Origin: emits error(unauthorized) then closes 4401", async () => {
    const { server } = boot();
    const ws = new WebSocket(`ws://127.0.0.1:${server.port}/ws`, {
      headers: { Origin: "chrome-extension://wrong-id-wrong-id-wrong-id-wro" },
    } as any);
    const { messages, code } = await collectUntilClose(ws);
    expect(code).toBe(4401);
    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({ type: "error", code: "unauthorized" });
  });

  // A wrong `auth` proof: 4401 generic failure — docs/PROTOCOL.md "Poignée
  // de main `v: 2`".
  test("wrong auth proof: emits error(unauthorized) then closes 4401", async () => {
    const { server } = boot();
    const result = await connectAndAuthV2(
      `ws://127.0.0.1:${server.port}/ws`,
      `moz-extension://00000000-0000-4000-8000-000000000000`,
      KEY,
      { authProofOverride: "0".repeat(64) },
    );
    expect(result.closeCode).toBe(4401);
    expect(result.ok).toBe(false);
  });

  test("correct handshake: no error, gets hello-ok", async () => {
    const { server } = boot();
    const result = await connectAndAuthV2(`ws://127.0.0.1:${server.port}/ws`, `chrome-extension://${ALLOWED_ID}`, KEY);
    expect(result.ok).toBe(true);
    result.ws.close();
  });

  // Oversized message BEFORE authentication: still the generic handshake
  // failure (4401), same as any other malformed hello — see
  // docs/PROTOCOL.md "Limites côté broker". Sized between MAX_MESSAGE_BYTES
  // (256 KiB) and the server's `websocket.maxPayloadLength` (final security
  // review: MAX_MESSAGE_BYTES + 4 KiB slack, server.ts) so the frame still
  // reaches the app-level size check exercised here, rather than being
  // dropped by Bun itself first (see the next test for that case).
  test("an oversized message during the handshake gets the generic unauthorized/4401, not a distinct oversized error", async () => {
    const { server } = boot();
    const ws = new WebSocket(`ws://127.0.0.1:${server.port}/ws`, {
      headers: { Origin: `chrome-extension://${ALLOWED_ID}` },
    } as any);
    const donePromise = collectUntilClose(ws);
    await new Promise<void>((resolve) => ws.addEventListener("open", () => resolve()));
    ws.send(JSON.stringify({ type: "hello", v: 2, nonce: "x".repeat(264_000) }));
    const { messages, code } = await donePromise;
    expect(code).toBe(4401);
    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({ type: "error", id: "hello", code: "unauthorized" });
  });

  // Final security review: a frame past `websocket.maxPayloadLength` itself
  // (not just past the app-level MAX_MESSAGE_BYTES check above) is dropped
  // by Bun at the protocol layer before the `message` handler ever runs —
  // closed, never delivered, and the server keeps serving other connections
  // afterwards (no crash).
  test("a frame past maxPayloadLength before auth is closed outright, server survives", async () => {
    const { server } = boot();
    const ws = new WebSocket(`ws://127.0.0.1:${server.port}/ws`, {
      headers: { Origin: `chrome-extension://${ALLOWED_ID}` },
    } as any);
    const donePromise = collectUntilClose(ws);
    await new Promise<void>((resolve) => ws.addEventListener("open", () => resolve()));
    ws.send(JSON.stringify({ type: "hello", v: 2, nonce: "x".repeat(2_000_000) }));
    const { code } = await donePromise;
    expect(code).toBeGreaterThan(0); // closed one way or another — never hangs

    // Server itself is unaffected: a normal connection right after still
    // completes the handshake.
    const result = await connectAndAuthV2(`ws://127.0.0.1:${server.port}/ws`, `chrome-extension://${ALLOWED_ID}`, KEY);
    expect(result.ok).toBe(true);
    result.ws.close();
  });
});

// docs/PROTOCOL.md "Limites côté broker" (amendement 2026-09-25, audit écart
// n°11): AFTER authentication, an oversized message gets a DISTINCT `error`
// with id "oversized", then close(1009) — not the generic 4401. The message
// is never parsed (its own `id`, if any, is never looked for).
describe("oversized message, post-authentication", () => {
  async function connectAndAuth(server: ReturnType<typeof startServer>): Promise<WebSocket> {
    return connectAndAuthV2OrThrow(`ws://127.0.0.1:${server.port}/ws`, `chrome-extension://${ALLOWED_ID}`, KEY);
  }

  test("an oversized message after auth gets error id=oversized then close(1009)", async () => {
    const { server } = boot();
    const ws = await connectAndAuth(server);

    const closeCode = new Promise<number>((resolve) => {
      ws.addEventListener("close", (event) => resolve(event.code));
    });
    const errorMsg = new Promise<ServerMessage>((resolve) => {
      ws.addEventListener("message", (event) => resolve(JSON.parse(event.data as string)));
    });

    // Over the 256 KiB cap (MAX_MESSAGE_BYTES) but still under the server's
    // websocket.maxPayloadLength (final security review: MAX_MESSAGE_BYTES +
    // 4 KiB slack, server.ts) — otherwise Bun itself drops the frame before
    // this app-level check/response ever runs (see errors.test.ts's
    // "maxPayloadLength" test for that separate case). Otherwise a
    // syntactically valid chat message with a real `id` — that `id` must NOT
    // be echoed back (the spec says the message is never analyzed for
    // oversized).
    const oversized = JSON.stringify({ type: "chat", id: "should-never-be-echoed", text: "x".repeat(264_000) });
    ws.send(oversized);

    const msg = await errorMsg;
    expect(msg).toEqual({
      type: "error",
      id: "oversized",
      code: "bad-request",
      message: "message exceeds 262144 byte cap",
    });
    expect(await closeCode).toBe(1009);
  });
});
