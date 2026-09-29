// Integration test for Firefox pairing (server.ts's evaluateOrigin +
// handleHandshakeMessage, config.ts's loadFirefoxPins / recordFirefoxSeen).
//
// Firefox gives every install a random moz-extension://<uuid> origin the
// broker cannot know ahead of time, so it must be learned on first
// successful pairing (valid secret over that origin) and pinned from then
// on — see docs comment on evaluateOrigin in server.ts. Amendement
// 2026-09-25: the pin store is a LIST (several profiles/installs/temporary
// loads can each pin their own uuid, none excluding the others), re-read
// from disk at every WebSocket open — see docs/PROTOCOL.md "Cas Firefox".

import { describe, expect, test, afterEach } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { startServer } from "../src/server.ts";
import { loadFirefoxPins } from "../src/config.ts";
import { makeTmpDir } from "./helpers/tmp-dir.ts";

const ALLOWED_ID = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const SECRET = "0123456789abcdef0123456789abcdef";
const FIREFOX_UUID = "12345678-1234-1234-1234-123456789abc";
const OTHER_FIREFOX_UUID = "87654321-4321-4321-4321-cba987654321";

let servers: ReturnType<typeof startServer>[] = [];

function boot(dataDir: string) {
  const server = startServer({ port: 0, allowedExtensionIds: [ALLOWED_ID] }, SECRET, { dataDir });
  servers.push(server);
  return server;
}

function pinnedUuids(dataDir: string): string[] {
  return loadFirefoxPins({ dataDir }).map((p) => p.uuid);
}

afterEach(() => {
  for (const s of servers) s.stop(true);
  servers = [];
});

/** Opens a raw ws to `server` with the given Origin, sends `hello` with
 * `secret` (omitted when undefined), and resolves with the first message
 * received (hello-ok or, after the server closes the socket, the close
 * event's code/reason). */
async function connect(
  server: ReturnType<typeof startServer>,
  origin: string,
  secret?: string,
): Promise<{ helloOk: boolean; closeCode?: number }> {
  const ws = new WebSocket(`ws://127.0.0.1:${server.port}/ws`, { headers: { Origin: origin } } as any);

  return new Promise((resolve) => {
    ws.addEventListener("open", () => {
      const hello: Record<string, unknown> = { type: "hello", v: 1 };
      if (secret !== undefined) hello.secret = secret;
      ws.send(JSON.stringify(hello));
    });
    ws.addEventListener("message", (event) => {
      const msg = JSON.parse(event.data as string);
      if (msg.type === "hello-ok") {
        resolve({ helloOk: true });
        ws.close();
      }
    });
    ws.addEventListener("close", (event) => {
      resolve({ helloOk: false, closeCode: event.code });
    });
  });
}

describe("Firefox pairing — moz-extension:// origin", () => {
  test("a moz-extension origin with a valid secret is accepted and its uuid pinned", async () => {
    const dataDir = makeTmpDir("coati-firefox-pair-");
    const server = boot(dataDir);

    const result = await connect(server, `moz-extension://${FIREFOX_UUID}`, SECRET);
    expect(result.helloOk).toBe(true);
    expect(pinnedUuids(dataDir)).toEqual([FIREFOX_UUID]);
  });

  test("a moz-extension origin with an invalid secret is rejected and nothing is pinned", async () => {
    const dataDir = makeTmpDir("coati-firefox-pair-");
    const server = boot(dataDir);

    const result = await connect(server, `moz-extension://${FIREFOX_UUID}`, "wrong-secret-wrong-secret-wrong!");
    expect(result.helloOk).toBe(false);
    expect(result.closeCode).toBe(4401);
    expect(pinnedUuids(dataDir)).toEqual([]);
  });

  // Amendement 2026-09-25: pins are a LIST — pinning a second uuid does not
  // evict or exclude the first (replaces the old single-value behaviour).
  test("once one uuid is pinned, a second moz-extension uuid with a valid secret is ALSO accepted and pinned", async () => {
    const dataDir = makeTmpDir("coati-firefox-pair-");
    const server = boot(dataDir);

    const first = await connect(server, `moz-extension://${FIREFOX_UUID}`, SECRET);
    expect(first.helloOk).toBe(true);

    const second = await connect(server, `moz-extension://${OTHER_FIREFOX_UUID}`, SECRET);
    expect(second.helloOk).toBe(true);

    // Both pins survive — neither excludes the other.
    expect(new Set(pinnedUuids(dataDir))).toEqual(new Set([FIREFOX_UUID, OTHER_FIREFOX_UUID]));
  });

  test("once one uuid is pinned, a second, DIFFERENT uuid with no secret is refused (silent grant needs pinning first)", async () => {
    const dataDir = makeTmpDir("coati-firefox-pair-");
    const server = boot(dataDir);

    const first = await connect(server, `moz-extension://${FIREFOX_UUID}`, SECRET);
    expect(first.helloOk).toBe(true);

    const second = await connect(server, `moz-extension://${OTHER_FIREFOX_UUID}`, undefined);
    expect(second.helloOk).toBe(false);
    expect(second.closeCode).toBe(4401);
    expect(pinnedUuids(dataDir)).toEqual([FIREFOX_UUID]);
  });

  test("once pinned, the same uuid keeps connecting normally, including with no secret (silent grant)", async () => {
    const dataDir = makeTmpDir("coati-firefox-pair-");
    const server = boot(dataDir);

    const first = await connect(server, `moz-extension://${FIREFOX_UUID}`, SECRET);
    expect(first.helloOk).toBe(true);

    const second = await connect(server, `moz-extension://${FIREFOX_UUID}`, SECRET);
    expect(second.helloOk).toBe(true);

    const third = await connect(server, `moz-extension://${FIREFOX_UUID}`, undefined);
    expect(third.helloOk).toBe(true);
  });

  test("a pin recorded by a previous broker process is honoured after a restart, without needing a restart to see it", async () => {
    const dataDir = makeTmpDir("coati-firefox-pair-");
    const first = boot(dataDir);
    await connect(first, `moz-extension://${FIREFOX_UUID}`, SECRET);
    first.stop(true);

    const second = boot(dataDir);
    const stillKnown = await connect(second, `moz-extension://${FIREFOX_UUID}`, undefined);
    expect(stillKnown.helloOk).toBe(true);
  });

  // Amendement 2026-09-25: the pin file is re-read at EVERY WebSocket open —
  // a hand-edit (here: simulated by a second broker process on the same
  // dataDir pinning a new uuid) takes effect on the very next connection of
  // the FIRST process, no restart needed.
  test("a pin added by another process on the same dataDir is honoured on the next connection, without a restart", async () => {
    const dataDir = makeTmpDir("coati-firefox-pair-");
    const server = boot(dataDir);

    // Not yet pinned on `server`'s in-memory view (it has none — the store
    // is always read fresh from disk, so there is no in-memory view to be
    // stale in the first place).
    const before = await connect(server, `moz-extension://${OTHER_FIREFOX_UUID}`, undefined);
    expect(before.helloOk).toBe(false);

    // Pin it out-of-band, directly via config.ts's own write path (stands in
    // for "the user hand-edited firefox-extension-uuids.txt").
    const other = boot(dataDir);
    await connect(other, `moz-extension://${OTHER_FIREFOX_UUID}`, SECRET);

    const after = await connect(server, `moz-extension://${OTHER_FIREFOX_UUID}`, undefined);
    expect(after.helloOk).toBe(true);
  });

  test("an unrelated origin is never accepted, pinned or not", async () => {
    const dataDir = makeTmpDir("coati-firefox-pair-");
    const server = boot(dataDir);

    const result = await connect(server, "https://example.com", SECRET);
    expect(result.helloOk).toBe(false);
    expect(result.closeCode).toBe(4401);
  });

  test("chrome-extension pairing still works unchanged alongside Firefox support", async () => {
    const dataDir = makeTmpDir("coati-firefox-pair-");
    const server = boot(dataDir);

    const result = await connect(server, `chrome-extension://${ALLOWED_ID}`, SECRET);
    expect(result.helloOk).toBe(true);
  });
});

// L1 (lot7 security review): the origin decision recorded at open() can go
// stale — a pin deleted by hand during the up-to-3s window before hello
// arrives must not still be honoured. handleHandshakeMessage now re-reads the
// pin list and re-evaluates the origin fresh at hello time, instead of
// trusting the value computed at open().
describe("L1 — pin list re-evaluated fresh at hello time, not trusted from open()", () => {
  test("a pin removed by hand between open() and hello is refused, even though it was pinned when the socket opened", async () => {
    const dataDir = makeTmpDir("coati-firefox-pair-");
    const server = boot(dataDir);

    // Pin it first — a normal successful pairing.
    const first = await connect(server, `moz-extension://${FIREFOX_UUID}`, SECRET);
    expect(first.helloOk).toBe(true);
    expect(pinnedUuids(dataDir)).toEqual([FIREFOX_UUID]);

    // Open a second connection to the SAME (now pinned) origin, but hold the
    // hello back until the pin has been deleted by hand — simulating the
    // race the review describes (open() sees "firefox-known", the file
    // changes before hello arrives).
    const ws = new WebSocket(`ws://127.0.0.1:${server.port}/ws`, {
      headers: { Origin: `moz-extension://${FIREFOX_UUID}` },
    } as any);
    await new Promise<void>((resolve) => ws.addEventListener("open", () => resolve()));

    // Hand-delete the pin (same mechanism as config.ts's own "line deleted by
    // hand" test — truncate the pins file to empty).
    writeFileSync(join(dataDir, "firefox-extension-uuids.txt"), "", { mode: 0o600 });
    expect(pinnedUuids(dataDir)).toEqual([]);

    const closeCode = await new Promise<number | undefined>((resolve) => {
      ws.addEventListener("message", (event) => {
        if (JSON.parse(event.data as string).type === "hello-ok") resolve(undefined);
      });
      ws.addEventListener("close", (event) => resolve(event.code));
      // No-secret silent-grant attempt: would have succeeded under the STALE
      // open()-time decision (firefox-known), must be refused under the
      // fresh, re-evaluated one (firefox-provisional — not yet pinned).
      ws.send(JSON.stringify({ type: "hello", v: 1 }));
    });

    expect(closeCode).toBe(4401);
    // The failed silent-grant attempt must not resurrect the pin either.
    expect(pinnedUuids(dataDir)).toEqual([]);
  });
});

// L2 (lot7 security review): grant() itself is wrapped in try/catch — a
// throw while finalizing a grant (e.g. recording the Firefox pin) must
// reject the handshake, not leave the socket silently unauthenticated with
// its hello timer already cleared (which used to mean it would never time
// out either).
describe("L2 — grant() fails closed", () => {
  test("a throw while finalizing the grant rejects the handshake instead of leaving the socket half-open", async () => {
    const dataDir = makeTmpDir("coati-firefox-pair-");
    const server = boot(dataDir);

    // grant() computes `new Date().toISOString()` before recording the
    // Firefox pin — forcing THAT to throw exercises grant()'s own try/catch
    // deterministically, without depending on a particular fs failure mode.
    const original = Date.prototype.toISOString;
    Date.prototype.toISOString = () => {
      throw new Error("boom (test double)");
    };
    let result: { helloOk: boolean; closeCode?: number };
    try {
      result = await connect(server, `moz-extension://${FIREFOX_UUID}`, SECRET);
    } finally {
      Date.prototype.toISOString = original;
    }

    expect(result.helloOk).toBe(false);
    expect(result.closeCode).toBe(4401);
    expect(pinnedUuids(dataDir)).toEqual([]); // never pinned — the grant never completed
  });
});
