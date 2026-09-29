// GET /pair — Firefox-only pairing page, see docs/PROTOCOL.md "Page `/pair`
// (Firefox seulement)" (amendement 2026-09-25, replaces "Appairage en un
// clic"). Verifies: the page shows the permanent secret and the read-only
// pinned-uuid list, no extension id/button/script anywhere, the route table
// (405 on non-GET, 404 elsewhere), the security headers, and the bind
// address stays 127.0.0.1 (CLAUDE.md non-negotiable rule #2).

import { describe, expect, test, afterEach } from "bun:test";
import { startServer } from "../src/server.ts";
import { renderPairPage } from "../src/pair.ts";
import { makeTmpDir } from "./helpers/tmp-dir.ts";

const ALLOWED_ID = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const SECRET = "0123456789abcdef0123456789abcdef";

// L5 (lot7 security review), amendement 2026-09-25 ter: /pair only answers a
// top-level navigation now — every real browser navigation sends both of
// these. A plain `fetch()` (used by every OTHER test in this file to probe
// non-2026-09-25-ter behaviour) sends neither, so those pre-existing tests
// double as the "rejected" case for anything not explicitly opted in here.
const NAVIGATE_HEADERS = { "Sec-Fetch-Mode": "navigate", "Sec-Fetch-Dest": "document" };

let servers: ReturnType<typeof startServer>[] = [];

function boot(allowedExtensionIds: string[] = [ALLOWED_ID]) {
  const dataDir = makeTmpDir("coati-pair-");
  const server = startServer({ port: 0, allowedExtensionIds }, SECRET, { dataDir });
  servers.push(server);
  return server;
}

afterEach(() => {
  for (const s of servers) s.stop(true);
  servers = [];
});

describe("GET /pair", () => {
  test("returns 200 html with the permanent secret embedded", async () => {
    const server = boot();
    const res = await fetch(`http://127.0.0.1:${server.port}/pair`, { headers: NAVIGATE_HEADERS });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    const body = await res.text();
    expect(body).toContain(SECRET);
    expect(body).toContain("Connecter Coati");
  });

  // Amendement 2026-09-25: no extension id, no button, no script anywhere on
  // this page — see "Chemin « un clic » retiré" (audit écart n°2).
  test("contains no extension id, no button, and no script", async () => {
    const server = boot();
    const res = await fetch(`http://127.0.0.1:${server.port}/pair`, { headers: NAVIGATE_HEADERS });
    const body = await res.text();
    expect(body).not.toContain(ALLOWED_ID);
    expect(body).not.toContain("<button");
    expect(body).not.toContain("<script");
  });

  test("lists pinned Firefox uuids read-only, with pinnedAt/lastSeen and the pins file path", async () => {
    const dataDir = makeTmpDir("coati-pair-");
    const server = startServer({ port: 0, allowedExtensionIds: [ALLOWED_ID] }, SECRET, { dataDir });
    servers.push(server);

    const uuid = "12345678-1234-1234-1234-123456789abc";
    const ws = new WebSocket(`ws://127.0.0.1:${server.port}/ws`, {
      headers: { Origin: `moz-extension://${uuid}` },
    } as any);
    await new Promise<void>((resolve) => {
      ws.addEventListener("open", () => ws.send(JSON.stringify({ type: "hello", secret: SECRET, v: 1 })));
      ws.addEventListener("message", (event) => {
        if (JSON.parse(event.data as string).type === "hello-ok") resolve();
      });
    });
    ws.close();

    const res = await fetch(`http://127.0.0.1:${server.port}/pair`, { headers: NAVIGATE_HEADERS });
    const body = await res.text();
    expect(body).toContain(uuid);
    expect(body).toContain("firefox-extension-uuids.txt");
  });

  test("shows a placeholder row when no Firefox uuid is pinned yet", async () => {
    const server = boot();
    const res = await fetch(`http://127.0.0.1:${server.port}/pair`, { headers: NAVIGATE_HEADERS });
    const body = await res.text();
    expect(body).toContain("Aucune extension Firefox épinglée");
  });

  test("only the pinned bind address is used — never 0.0.0.0", async () => {
    const server = boot();
    expect(server.hostname).toBe("127.0.0.1");
  });

  test("any other path still 404s", async () => {
    const server = boot();
    for (const path of ["/", "/pair/", "/pair/x", "/pairing", "/unknown"]) {
      const res = await fetch(`http://127.0.0.1:${server.port}${path}`);
      expect(res.status).toBe(404);
    }
  });

  // docs/PROTOCOL.md "Admission HTTP et WebSocket" route table.
  test("POST /pair is 405 with Allow: GET — the route is GET only", async () => {
    const server = boot();
    const res = await fetch(`http://127.0.0.1:${server.port}/pair`, { method: "POST" });
    expect(res.status).toBe(405);
    expect(res.headers.get("allow")).toBe("GET");
  });

  // docs/PROTOCOL.md "Page `/pair`": Cache-Control, Referrer-Policy, CSP,
  // X-Content-Type-Options.
  test("sets the security headers the spec requires", async () => {
    const server = boot();
    const res = await fetch(`http://127.0.0.1:${server.port}/pair`, { headers: NAVIGATE_HEADERS });
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(res.headers.get("referrer-policy")).toBe("no-referrer");
    expect(res.headers.get("content-security-policy")).toBe(
      "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'",
    );
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("cross-origin-resource-policy")).toBe("same-origin");
  });

  // L5 (lot7 security review), amendement 2026-09-25 ter: /pair only answers
  // a top-level navigation now — a same-origin fetch() (what another
  // extension's service worker with a 127.0.0.1 host permission would use)
  // no longer reads the permanent secret this way.
  describe("L5 — Sec-Fetch-Mode/Dest gate", () => {
    test("a plain fetch() with neither Sec-Fetch header is 403, not the page", async () => {
      const server = boot();
      const res = await fetch(`http://127.0.0.1:${server.port}/pair`);
      expect(res.status).toBe(403);
      const body = await res.text();
      expect(body).not.toContain(SECRET);
    });

    test("Sec-Fetch-Mode: navigate alone, without Sec-Fetch-Dest: document, is still 403", async () => {
      const server = boot();
      const res = await fetch(`http://127.0.0.1:${server.port}/pair`, {
        headers: { "Sec-Fetch-Mode": "navigate", "Sec-Fetch-Dest": "empty" },
      });
      expect(res.status).toBe(403);
    });

    test("Sec-Fetch-Dest: document alone, without Sec-Fetch-Mode: navigate, is still 403", async () => {
      const server = boot();
      const res = await fetch(`http://127.0.0.1:${server.port}/pair`, {
        headers: { "Sec-Fetch-Mode": "cors", "Sec-Fetch-Dest": "document" },
      });
      expect(res.status).toBe(403);
    });

    test("both headers present, as a real top-level navigation sends, is 200", async () => {
      const server = boot();
      const res = await fetch(`http://127.0.0.1:${server.port}/pair`, { headers: NAVIGATE_HEADERS });
      expect(res.status).toBe(200);
    });
  });

  // Silent pairing (server.ts's handleHandshakeMessage) and /pair both come
  // from the exact same `pairingSecret` startServer was given — there is
  // only ever one permanent secret. If the two ever diverged, /pair would
  // show a token that no longer pairs, or vice versa; guard the invariant
  // here, at the source of the page's token.
  test("embeds the exact secret startServer was given", async () => {
    const server = boot();
    const res = await fetch(`http://127.0.0.1:${server.port}/pair`, { headers: NAVIGATE_HEADERS });
    const body = await res.text();
    expect(body).toContain(SECRET);
  });
});

describe("renderPairPage — escaping", () => {
  test("escapes a hostile token", () => {
    const hostile = '</style><script>alert(1)</script>"\'';
    const html = renderPairPage({ port: 8787, token: hostile, pinned: [], pinsFilePath: "/tmp/x.txt" });
    expect(html).not.toContain(hostile);
    expect(html).not.toContain("<script>");
  });

  test("escapes a hostile pinned uuid/date the same way", () => {
    const hostile = '</style><script>alert(1)</script>';
    const html = renderPairPage({
      port: 8787,
      token: SECRET,
      pinned: [{ uuid: hostile, pinnedAt: hostile, lastSeen: hostile }],
      pinsFilePath: "/tmp/x.txt",
    });
    expect(html).not.toContain(hostile);
    expect(html).not.toContain("<script>");
  });

  test("escapes a hostile pins file path", () => {
    const hostile = '</style><script>alert(1)</script>';
    const html = renderPairPage({ port: 8787, token: SECRET, pinned: [], pinsFilePath: hostile });
    expect(html).not.toContain(hostile);
    expect(html).not.toContain("<script>");
  });
});
