// v: 2 handshake — docs/PROTOCOL.md "Poignée de main `v: 2`" (amendement
// 2026-09-30, G4). No pinning, no session tokens, no v: 1: the key (native or
// the legacy-mode permanent secret S) is what authenticates a connection.

import { describe, expect, test, afterEach } from "bun:test";
import { checkOrigin, isOriginAllowed, parseMozExtensionOrigin, startServer } from "../src/server.ts";
import { makeTmpDir } from "./helpers/tmp-dir.ts";
import { connectAndAuthV2 } from "./helpers/handshake-v2.ts";

describe("checkOrigin", () => {
  const allowed = ["aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"];

  test("refuses wrong origin", () => {
    expect(checkOrigin("chrome-extension://ccccccccccccccccccccccccccccccc", allowed)).toBe(false);
  });

  test("refuses missing origin", () => {
    expect(checkOrigin(null, allowed)).toBe(false);
    expect(checkOrigin(undefined, allowed)).toBe(false);
  });

  test("refuses non chrome-extension origin", () => {
    expect(checkOrigin("https://example.com", allowed)).toBe(false);
  });

  test("accepts an allowed extension origin", () => {
    expect(checkOrigin(`chrome-extension://${allowed[0]}`, allowed)).toBe(true);
  });
});

describe("parseMozExtensionOrigin", () => {
  test("extracts the uuid from a well-formed moz-extension:// origin", () => {
    expect(parseMozExtensionOrigin("moz-extension://12345678-1234-1234-1234-123456789abc")).toBe(
      "12345678-1234-1234-1234-123456789abc",
    );
  });

  test("lower-cases the uuid", () => {
    expect(parseMozExtensionOrigin("moz-extension://ABCDEF12-1234-1234-1234-123456789ABC")).toBe(
      "abcdef12-1234-1234-1234-123456789abc",
    );
  });

  test("returns null for non moz-extension origins", () => {
    expect(parseMozExtensionOrigin("chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa")).toBeNull();
    expect(parseMozExtensionOrigin("https://example.com")).toBeNull();
    expect(parseMozExtensionOrigin(null)).toBeNull();
    expect(parseMozExtensionOrigin(undefined)).toBeNull();
  });

  test("returns null for a malformed uuid", () => {
    expect(parseMozExtensionOrigin("moz-extension://not-a-uuid")).toBeNull();
  });
});

// Amendement 2026-09-30 (G4): no pinning — ANY well-formed moz-extension uuid
// passes this step; the key (not the origin) authenticates.
describe("isOriginAllowed", () => {
  const allowed = ["aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"];
  const uuid = "12345678-1234-1234-1234-123456789abc";

  test("accepts a chrome-extension origin on the allowlist", () => {
    expect(isOriginAllowed(`chrome-extension://${allowed[0]}`, allowed)).toBe(true);
  });

  test("rejects a chrome-extension origin NOT on the allowlist", () => {
    expect(isOriginAllowed(`chrome-extension://cccccccccccccccccccccccccccccccc`, allowed)).toBe(false);
  });

  test("accepts any well-formed moz-extension origin", () => {
    expect(isOriginAllowed(`moz-extension://${uuid}`, allowed)).toBe(true);
  });

  test("rejects an unrelated origin outright", () => {
    expect(isOriginAllowed("https://example.com", allowed)).toBe(false);
    expect(isOriginAllowed(null, allowed)).toBe(false);
  });
});

describe("v: 2 handshake — integration", () => {
  const ALLOWED_ID = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
  const KEY = Buffer.alloc(32, 0xab);
  const FIREFOX_UUID = "12345678-1234-1234-1234-123456789abc";

  let servers: ReturnType<typeof startServer>[] = [];
  afterEach(() => {
    for (const s of servers) s.stop(true);
    servers = [];
  });

  function boot(overrides: Partial<Parameters<typeof startServer>[0]> = {}) {
    const dataDir = makeTmpDir("coati-handshake-v2-");
    const server = startServer({ port: 0, allowedExtensionIds: [ALLOWED_ID], ...overrides }, KEY, { dataDir });
    servers.push(server);
    return server;
  }

  test("a valid native handshake on a chrome-extension origin succeeds", async () => {
    const server = boot();
    const result = await connectAndAuthV2(`ws://127.0.0.1:${server.port}/ws`, `chrome-extension://${ALLOWED_ID}`, KEY);
    expect(result.ok).toBe(true);
    result.ws.close();
  });

  test("a valid native handshake on any well-formed moz-extension origin succeeds (no pinning)", async () => {
    const server = boot();
    const result = await connectAndAuthV2(`ws://127.0.0.1:${server.port}/ws`, `moz-extension://${FIREFOX_UUID}`, KEY);
    expect(result.ok).toBe(true);
    result.ws.close();
  });

  test("a chrome-extension origin NOT in allowedExtensionIds never reaches hello — rejected at Origin", async () => {
    const server = boot();
    const result = await connectAndAuthV2(
      `ws://127.0.0.1:${server.port}/ws`,
      "chrome-extension://cccccccccccccccccccccccccccccccc",
      KEY,
    );
    expect(result.closeCode).toBe(4401);
    expect(result.ok).toBe(false);
  });

  test("a wrong extension proof is rejected (4401), never an exception", async () => {
    const server = boot();
    const result = await connectAndAuthV2(`ws://127.0.0.1:${server.port}/ws`, `chrome-extension://${ALLOWED_ID}`, KEY, {
      authProofOverride: "b".repeat(64),
    });
    expect(result.closeCode).toBe(4401);
  });

  for (const badProof of ["c".repeat(63), "c".repeat(65), "C".repeat(64), "z".repeat(64)]) {
    test(`a malformed proof (${badProof.length} chars, "${badProof[0]}") is rejected, not an exception`, async () => {
      const server = boot();
      const result = await connectAndAuthV2(`ws://127.0.0.1:${server.port}/ws`, `chrome-extension://${ALLOWED_ID}`, KEY, {
        authProofOverride: badProof,
      });
      expect(result.closeCode).toBe(4401);
    });
  }

  test("the broker's own proof, replayed back as the extension's auth proof, is rejected", async () => {
    const server = boot();
    const result = await connectAndAuthV2(`ws://127.0.0.1:${server.port}/ws`, `chrome-extension://${ALLOWED_ID}`, KEY, {
      authProofOverride: undefined,
    });
    // Sanity: the plain flow already succeeds; now redo it but hand back the
    // broker's own challenge proof as our auth proof.
    expect(result.ok).toBe(true);
    result.ws.close();

    const ws = new WebSocket(`ws://127.0.0.1:${server.port}/ws`, {
      headers: { Origin: `chrome-extension://${ALLOWED_ID}` },
    } as any);
    const cNonce = "d".repeat(64);
    const outcome = await new Promise<{ ok: boolean; closeCode?: number }>((resolve) => {
      ws.addEventListener("open", () => ws.send(JSON.stringify({ type: "hello", v: 2, nonce: cNonce })));
      ws.addEventListener("message", (event) => {
        const msg = JSON.parse(event.data as string);
        if (msg.type === "challenge") {
          ws.send(JSON.stringify({ type: "auth", v: 2, proof: msg.proof }));
        } else if (msg.type === "hello-ok") {
          resolve({ ok: true });
        }
      });
      ws.addEventListener("close", (event) => resolve({ ok: false, closeCode: event.code }));
    });
    expect(outcome.ok).toBe(false);
    expect(outcome.closeCode).toBe(4401);
  });

  test("Origin-only, no hello sent at all: the handshake timeout (3s) eventually closes 4401", async () => {
    const server = boot();
    const ws = new WebSocket(`ws://127.0.0.1:${server.port}/ws`, {
      headers: { Origin: `chrome-extension://${ALLOWED_ID}` },
    } as any);
    const code = await new Promise<number>((resolve) => {
      ws.addEventListener("close", (event) => resolve(event.code));
    });
    expect(code).toBe(4401);
  }, 4000);

  test('key: "pasted" while legacyPairing is off is rejected (reason logged, never on the wire)', async () => {
    const server = boot({ legacyPairing: false });
    const result = await connectAndAuthV2(`ws://127.0.0.1:${server.port}/ws`, `chrome-extension://${ALLOWED_ID}`, KEY, {
      keyLabel: "pasted",
    });
    expect(result.closeCode).toBe(4401);
  });

  test('key: "pasted" with legacyPairing on and the correct secret S succeeds', async () => {
    const dataDir = makeTmpDir("coati-handshake-legacy-");
    const { loadOrCreatePairingSecret } = await import("../src/broker-key.ts");
    const legacySecret = loadOrCreatePairingSecret({ dataDir });
    const server = startServer({ port: 0, allowedExtensionIds: [ALLOWED_ID], legacyPairing: true }, KEY, { dataDir });
    servers.push(server);
    const result = await connectAndAuthV2(
      `ws://127.0.0.1:${server.port}/ws`,
      `chrome-extension://${ALLOWED_ID}`,
      legacySecret,
      { keyLabel: "pasted" },
    );
    expect(result.ok).toBe(true);
    result.ws.close();
  });

  test('key: "pasted" with legacyPairing on but the WRONG secret is rejected', async () => {
    const server = boot({ legacyPairing: true });
    const wrongSecret = Buffer.alloc(32, 0xee);
    const result = await connectAndAuthV2(
      `ws://127.0.0.1:${server.port}/ws`,
      `chrome-extension://${ALLOWED_ID}`,
      wrongSecret,
      { keyLabel: "pasted" },
    );
    expect(result.closeCode).toBe(4401);
  });
});

// L2-equivalent (amendement 2026-09-30, G4): open() no longer does any file
// I/O for the origin check (it's pure now — no Firefox pin list to read), so
// there is nothing left to "fail closed" against at that step. This is a
// regression guard: an unrelated origin must still be rejected outright.
describe("origin check has no I/O left to fail on", () => {
  const ALLOWED_ID = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
  let servers: ReturnType<typeof startServer>[] = [];
  afterEach(() => {
    for (const s of servers) s.stop(true);
    servers = [];
  });

  test("an unrelated origin is rejected at open(), even against a dataDir that cannot be written to further", async () => {
    const dataDir = makeTmpDir("coati-l2-open-");
    const server = startServer({ port: 0, allowedExtensionIds: [ALLOWED_ID] }, Buffer.alloc(32, 1), { dataDir });
    servers.push(server);

    const ws = new WebSocket(`ws://127.0.0.1:${server.port}/ws`, {
      headers: { Origin: "https://example.com" },
    } as any);
    const closeCode = await new Promise<number>((resolve) => {
      ws.addEventListener("close", (event) => resolve(event.code));
      ws.addEventListener("message", (event) => {
        if (JSON.parse(event.data as string).type === "hello-ok") {
          throw new Error("must never reach hello-ok — open() should have rejected first");
        }
      });
    });
    expect(closeCode).toBe(4401);
  });
});
