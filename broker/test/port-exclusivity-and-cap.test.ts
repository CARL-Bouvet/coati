// docs/PROTOCOL.md "Écoute exclusive du port" and "Plafond de connexions non
// authentifiées" (amendement 2026-09-30, G4).

import { describe, expect, test, afterEach, mock } from "bun:test";
import { startServer, MAX_UNAUTH_CONNECTIONS } from "../src/server.ts";
import { makeTmpDir } from "./helpers/tmp-dir.ts";

const ALLOWED_ID = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const KEY = Buffer.alloc(32, 0x5a);

let servers: ReturnType<typeof startServer>[] = [];
afterEach(() => {
  for (const s of servers) s.stop(true);
  servers = [];
});

describe("exclusive port listen", () => {
  test("a second startServer on the same already-bound port fails to listen", () => {
    const dataDir1 = makeTmpDir("coati-portex-1-");
    const first = startServer({ port: 0, allowedExtensionIds: [ALLOWED_ID] }, KEY, { dataDir: dataDir1 });
    servers.push(first);

    const dataDir2 = makeTmpDir("coati-portex-2-");
    expect(() => {
      const second = startServer({ port: first.port, allowedExtensionIds: [ALLOWED_ID] }, KEY, { dataDir: dataDir2 });
      servers.push(second);
    }).toThrow();
  });
});

describe("MAX_UNAUTH_CONNECTIONS cap", () => {
  test(`a connection beyond the ${MAX_UNAUTH_CONNECTIONS} cap is refused (4401) before any message, without affecting the first ${MAX_UNAUTH_CONNECTIONS}`, async () => {
    const dataDir = makeTmpDir("coati-cap-");
    const server = startServer({ port: 0, allowedExtensionIds: [ALLOWED_ID] }, KEY, { dataDir });
    servers.push(server);

    // Open MAX_UNAUTH_CONNECTIONS sockets and leave them unauthenticated
    // (never send hello) — they still count toward the cap.
    const held: WebSocket[] = [];
    for (let i = 0; i < MAX_UNAUTH_CONNECTIONS; i++) {
      const ws = new WebSocket(`ws://127.0.0.1:${server.port}/ws`, {
        headers: { Origin: `chrome-extension://${ALLOWED_ID}` },
      } as any);
      await new Promise<void>((resolve, reject) => {
        ws.addEventListener("open", () => resolve());
        ws.addEventListener("close", (e) => reject(new Error(`closed early, code=${e.code}`)));
      });
      held.push(ws);
    }

    const overCap = new WebSocket(`ws://127.0.0.1:${server.port}/ws`, {
      headers: { Origin: `chrome-extension://${ALLOWED_ID}` },
    } as any);
    const closeCode = await new Promise<number>((resolve) => {
      overCap.addEventListener("close", (e) => resolve(e.code));
      overCap.addEventListener("message", () => {
        throw new Error("the 17th connection must never receive any message, per docs/PROTOCOL.md");
      });
    });
    expect(closeCode).toBe(4401);

    for (const ws of held) ws.close();
  }, 10000);

  test("cap rejections are logged with rate limiting — not one line per rejection", async () => {
    const dataDir = makeTmpDir("coati-cap-log-");
    const server = startServer({ port: 0, allowedExtensionIds: [ALLOWED_ID] }, KEY, { dataDir });
    servers.push(server);

    const errorSpy = mock(() => {});
    const originalError = console.error;
    console.error = errorSpy as unknown as typeof console.error;

    const held: WebSocket[] = [];
    try {
      for (let i = 0; i < MAX_UNAUTH_CONNECTIONS; i++) {
        const ws = new WebSocket(`ws://127.0.0.1:${server.port}/ws`, {
          headers: { Origin: `chrome-extension://${ALLOWED_ID}` },
        } as any);
        await new Promise<void>((resolve) => ws.addEventListener("open", () => resolve()));
        held.push(ws);
      }

      // Fire several over-cap connections back to back.
      const overCapCloses: Promise<number>[] = [];
      for (let i = 0; i < 5; i++) {
        const ws = new WebSocket(`ws://127.0.0.1:${server.port}/ws`, {
          headers: { Origin: `chrome-extension://${ALLOWED_ID}` },
        } as any);
        overCapCloses.push(new Promise((resolve) => ws.addEventListener("close", (e) => resolve(e.code))));
      }
      const codes = await Promise.all(overCapCloses);
      expect(codes.every((c) => c === 4401)).toBe(true);

      const capLines = errorSpy.mock.calls
        .map((call: unknown[]) => String(call[0]))
        .filter((l) => l.includes("stage=unauth-cap"));
      // Rate-limited: at most one log line for this whole burst (all within
      // the same 10s window), never one per rejection.
      expect(capLines.length).toBeLessThanOrEqual(1);
      if (capLines.length === 1) {
        expect(capLines[0]).toMatch(/count=\d+/);
      }
    } finally {
      console.error = originalError;
      for (const ws of held) ws.close();
    }
  }, 10000);
});
