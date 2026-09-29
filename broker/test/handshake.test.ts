import { describe, expect, test, afterEach } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { checkOrigin, checkSecret, evaluateOrigin, parseMozExtensionOrigin, startServer } from "../src/server.ts";
import { makeTmpDir } from "./helpers/tmp-dir.ts";

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

describe("evaluateOrigin", () => {
  const allowed = ["aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"];
  const uuid = "12345678-1234-1234-1234-123456789abc";
  const otherUuid = "87654321-4321-4321-4321-cba987654321";

  test("accepts a chrome-extension origin on the allowlist", () => {
    expect(evaluateOrigin(`chrome-extension://${allowed[0]}`, allowed, [])).toEqual({
      ok: true,
      kind: "chrome",
    });
  });

  test("accepts an unpaired moz-extension origin as provisional, not yet authenticated", () => {
    expect(evaluateOrigin(`moz-extension://${uuid}`, allowed, [])).toEqual({
      ok: true,
      kind: "firefox-provisional",
      uuid,
    });
  });

  test("accepts a moz-extension origin matching an already-pinned uuid", () => {
    expect(evaluateOrigin(`moz-extension://${uuid}`, allowed, [uuid])).toEqual({
      ok: true,
      kind: "firefox-known",
    });
  });

  // Amendement 2026-09-25: pins are a LIST, not a single value — a second
  // uuid pinning does not exclude the first. An uuid absent from the list is
  // always "firefox-provisional" (eligible for pairing via the permanent
  // secret), regardless of what else is already pinned.
  test("an uuid not in the pin list is provisional even when another uuid is already pinned", () => {
    expect(evaluateOrigin(`moz-extension://${otherUuid}`, allowed, [uuid])).toEqual({
      ok: true,
      kind: "firefox-provisional",
      uuid: otherUuid,
    });
  });

  test("both of two pinned uuids are recognized as firefox-known", () => {
    expect(evaluateOrigin(`moz-extension://${uuid}`, allowed, [uuid, otherUuid])).toEqual({
      ok: true,
      kind: "firefox-known",
    });
    expect(evaluateOrigin(`moz-extension://${otherUuid}`, allowed, [uuid, otherUuid])).toEqual({
      ok: true,
      kind: "firefox-known",
    });
  });

  test("rejects an unrelated origin outright", () => {
    expect(evaluateOrigin("https://example.com", allowed, [])).toEqual({ ok: false, kind: "rejected" });
    expect(evaluateOrigin(null, allowed, [])).toEqual({ ok: false, kind: "rejected" });
  });
});

describe("checkSecret", () => {
  const expected = "0123456789abcdef0123456789abcdef";

  test("refuses missing secret", () => {
    expect(checkSecret(undefined, expected)).toBe(false);
    expect(checkSecret(null, expected)).toBe(false);
  });

  test("refuses wrong secret", () => {
    expect(checkSecret("wrong-secret-wrong-secret-wrong!", expected)).toBe(false);
  });

  test("accepts the correct secret", () => {
    expect(checkSecret(expected, expected)).toBe(true);
  });
});

// Integration tests for CHANGE 1 (2026-09-21): silent-pairing auto-grant for
// an already-trusted chrome-extension:// origin. See docs/PROTOCOL.md
// "Appairage silencieux".
describe("silent pairing — hello with no secret", () => {
  const ALLOWED_ID = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
  const SECRET = "0123456789abcdef0123456789abcdef";
  const FIREFOX_UUID = "12345678-1234-1234-1234-123456789abc";

  let servers: ReturnType<typeof startServer>[] = [];
  afterEach(() => {
    for (const s of servers) s.stop(true);
    servers = [];
  });

  function boot() {
    const dataDir = makeTmpDir("coati-silent-pair-");
    const server = startServer({ port: 0, allowedExtensionIds: [ALLOWED_ID] }, SECRET, { dataDir });
    servers.push(server);
    return server;
  }

  /** Opens a raw ws with the given Origin, sends a hello (secret omitted when
   * `undefined`), and resolves with the parsed hello-ok message (if any) and
   * the close code (if the server closed the socket instead). */
  function connect(
    server: ReturnType<typeof startServer>,
    origin: string,
    secret?: string,
  ): Promise<{ helloOk?: { token?: string }; closeCode?: number }> {
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
          resolve({ helloOk: msg });
          ws.close();
        }
      });
      ws.addEventListener("close", (event) => {
        resolve({ closeCode: event.code });
      });
    });
  }

  // Amendement 2026-09-25: hello-ok.token is now ALWAYS a fresh session
  // token (64 hex chars), never the permanent secret itself — see
  // docs/PROTOCOL.md "Poignée de main" / "Jeton de session".
  const SESSION_TOKEN_RE = /^[0-9a-f]{64}$/;

  test("a known chrome-extension origin with no secret is auto-granted a fresh session token", async () => {
    const server = boot();
    const result = await connect(server, `chrome-extension://${ALLOWED_ID}`, undefined);
    expect(result.helloOk?.token).toMatch(SESSION_TOKEN_RE);
    expect(result.helloOk?.token).not.toBe(SECRET);
  });

  test("the permanent secret is never echoed back by GET /pair's page as the granted token", async () => {
    // /pair does show the permanent secret itself (by design) — this checks
    // the auto-granted session token specifically is NOT that same value.
    const server = boot();
    const result = await connect(server, `chrome-extension://${ALLOWED_ID}`, undefined);
    expect(result.helloOk?.token).not.toBe(SECRET);
  });

  test("a chrome-extension origin NOT in allowedExtensionIds never reaches hello — rejected at Origin", async () => {
    const server = boot();
    const result = await connect(server, "chrome-extension://cccccccccccccccccccccccccccccccc", undefined);
    expect(result.closeCode).toBe(4401);
    expect(result.helloOk).toBeUndefined();
  });

  // Amendement 2026-09-25 (quater): a known origin could get a token with NO
  // secret anyway, so refusing a wrong or stale one protected nothing and
  // locked honest clients out after every broker restart. It now gets a fresh
  // session token — never the one it presented, never the permanent secret.
  test("a known chrome-extension origin with a stale or wrong secret gets a FRESH session token", async () => {
    const server = boot();
    const stale = "wrong-secret-wrong-secret-wrong!";
    const result = await connect(server, `chrome-extension://${ALLOWED_ID}`, stale);
    expect(result.helloOk).toBeDefined();
    expect(result.helloOk?.token).toMatch(SESSION_TOKEN_RE);
    expect(result.helloOk?.token).not.toBe(stale);
    expect(result.helloOk?.token).not.toBe(SECRET);
  });

  test("an UNKNOWN origin with a wrong secret is still rejected", async () => {
    const server = boot();
    const result = await connect(server, `moz-extension://00000000-0000-4000-8000-000000000000`, "wrong-secret-wrong-secret-wrong!");
    expect(result.closeCode).toBe(4401);
  });

  test("a known chrome-extension origin with the correct secret also gets a fresh session token", async () => {
    const server = boot();
    const result = await connect(server, `chrome-extension://${ALLOWED_ID}`, SECRET);
    expect(result.helloOk).toBeDefined();
    expect(result.helloOk?.token).toMatch(SESSION_TOKEN_RE);
  });

  // Amendement 2026-09-25: silent pairing is extended to PINNED Firefox
  // uuids — the first connection pins via the permanent secret, every later
  // connection (including with no secret) is auto-granted.
  test("a pinned Firefox uuid is auto-granted a token with no secret, once pinned", async () => {
    const server = boot();
    const first = await connect(server, `moz-extension://${FIREFOX_UUID}`, SECRET);
    expect(first.helloOk).toBeDefined();

    const second = await connect(server, `moz-extension://${FIREFOX_UUID}`, undefined);
    expect(second.helloOk?.token).toMatch(SESSION_TOKEN_RE);
    expect(second.closeCode).toBeUndefined();
  });

  test("an unpinned Firefox uuid is never auto-granted", async () => {
    const server = boot();
    const result = await connect(server, `moz-extension://${FIREFOX_UUID}`, undefined);
    expect(result.closeCode).toBe(4401);
    expect(result.helloOk).toBeUndefined();
  });

  // Amendement 2026-09-25 (quater), Firefox side: a pinned uuid presenting a
  // stale session token (from a previous broker process, now gone) is not
  // locked out — same treatment as a known chrome-extension origin above.
  test("a pinned Firefox uuid with a stale session token gets a FRESH session token (silent-renew)", async () => {
    const server = boot();
    const first = await connect(server, `moz-extension://${FIREFOX_UUID}`, SECRET);
    expect(first.helloOk).toBeDefined();

    const stale = "0".repeat(64); // well-formed shape, but never issued
    const result = await connect(server, `moz-extension://${FIREFOX_UUID}`, stale);
    expect(result.helloOk).toBeDefined();
    expect(result.helloOk?.token).toMatch(SESSION_TOKEN_RE);
    expect(result.helloOk?.token).not.toBe(stale);
  });

  // Companion to the above: once the uuid is REVOKED (unpinned again), its
  // old — previously valid — session token must no longer work. Unlike the
  // stale-token case, this origin is no longer "known" at all (back to
  // firefox-provisional), so PROTOCOL's decision table says refus, not
  // silent-renew.
  test("a revoked Firefox uuid presenting its old session token is refused", async () => {
    const dataDir = makeTmpDir("coati-silent-pair-");
    const server = startServer({ port: 0, allowedExtensionIds: [ALLOWED_ID] }, SECRET, { dataDir });
    servers.push(server);

    const first = await connect(server, `moz-extension://${FIREFOX_UUID}`, SECRET);
    const oldToken = first.helloOk?.token;
    expect(oldToken).toMatch(SESSION_TOKEN_RE);

    // Revoke: remove the pin by hand (same mechanism as
    // firefox-pairing.test.ts's L1 test — truncate the pins file to empty).
    writeFileSync(join(dataDir, "firefox-extension-uuids.txt"), "", { mode: 0o600 });

    const result = await connect(server, `moz-extension://${FIREFOX_UUID}`, oldToken);
    expect(result.closeCode).toBe(4401);
    expect(result.helloOk).toBeUndefined();
  });
});

// L2 (lot7 security review): open() must fail closed — a failure to even
// READ the Firefox pin list (unreadable file, EISDIR, a chmod EPERM) must
// never fall through to "origin unknown, treat it as if nothing were
// pinned"; it is rejected outright, same as an explicitly rejected origin.
describe("L2 — open() fails closed when evaluating the origin throws", () => {
  const ALLOWED_ID = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

  let servers: ReturnType<typeof startServer>[] = [];
  afterEach(() => {
    for (const s of servers) s.stop(true);
    servers = [];
  });

  test("a dataDir that makes loadFirefoxPins throw rejects every connection at open(), even a normally-allowed chrome origin", async () => {
    // A NUL byte makes every node:fs call on a path built from this dataDir
    // throw synchronously (ERR_INVALID_ARG_VALUE) — a reliable, dependency-free
    // way to force config.ts's ensureDir0700()/loadFirefoxPins() to throw.
    const dataDir = makeTmpDir("coati-l2-open-") + "\0bad";
    const server = startServer({ port: 0, allowedExtensionIds: [ALLOWED_ID] }, "0123456789abcdef0123456789abcdef", { dataDir });
    servers.push(server);

    const ws = new WebSocket(`ws://127.0.0.1:${server.port}/ws`, {
      headers: { Origin: `chrome-extension://${ALLOWED_ID}` },
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
