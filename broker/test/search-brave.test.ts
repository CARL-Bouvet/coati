// Lot C1 — search/brave.ts: query shape, key header, status → reason
// mapping. Uses a REAL local HTTP server (Bun.serve on 127.0.0.1, random
// port — "faux serveur", plan §3C "Tests") — braveSearch's own fetchImpl is
// redirected to it, so the adapter's actual request (headers, query string)
// is exercised end to end, without ever reaching the real Brave host.

import { describe, expect, test, afterEach, beforeAll, afterAll } from "bun:test";
import { braveSearch, braveTestConnection, __setFetchImplForTests, __resetFetchImplForTests } from "../src/search/brave.ts";

let server: ReturnType<typeof Bun.serve>;
let lastRequest: { url: URL; headers: Headers } | null = null;
let nextStatus = 200;
let nextBody: unknown = { web: { results: [{ url: "https://help.kling.ai/a", title: "A" }] } };

beforeAll(() => {
  server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch(req) {
      lastRequest = { url: new URL(req.url), headers: req.headers };
      return new Response(JSON.stringify(nextBody), {
        status: nextStatus,
        headers: { "content-type": "application/json" },
      });
    },
  });
});
afterAll(() => server.stop(true));

afterEach(() => {
  __resetFetchImplForTests();
  nextStatus = 200;
  nextBody = { web: { results: [{ url: "https://help.kling.ai/a", title: "A" }] } };
});

/** Redirects Brave's fixed hostname to the local fake server, keeping path
 * and query intact — the adapter itself never learns the difference. */
function redirectToFakeServer() {
  __setFetchImplForTests((url, init) => {
    const u = new URL(String(url));
    const target = new URL(`http://127.0.0.1:${server.port}${u.pathname}${u.search}`);
    return fetch(target, init);
  });
}

describe("braveSearch", () => {
  test("sends the key in X-Subscription-Token, never elsewhere", async () => {
    redirectToFakeServer();
    await braveSearch("how to export", "my-brave-key");
    expect(lastRequest?.headers.get("x-subscription-token")).toBe("my-brave-key");
  });

  test("prefixes the query with site: when a domain is given", async () => {
    redirectToFakeServer();
    await braveSearch("how to export", "key", { domain: "help.kling.ai" });
    expect(lastRequest?.url.searchParams.get("q")).toBe("site:help.kling.ai how to export");
  });

  test("omits the site: prefix when no domain is given", async () => {
    redirectToFakeServer();
    await braveSearch("how to export", "key");
    expect(lastRequest?.url.searchParams.get("q")).toBe("how to export");
  });

  test("parses results", async () => {
    redirectToFakeServer();
    const result = await braveSearch("q", "key");
    expect(result).toEqual({ ok: true, results: [{ url: "https://help.kling.ai/a", title: "A" }] });
  });

  test("maps 401 to reason 'auth'", async () => {
    redirectToFakeServer();
    nextStatus = 401;
    const result = await braveSearch("q", "key");
    expect(result).toEqual({ ok: false, reason: "auth" });
  });

  test("maps 429 to reason 'rate'", async () => {
    redirectToFakeServer();
    nextStatus = 429;
    const result = await braveSearch("q", "key");
    expect(result).toEqual({ ok: false, reason: "rate" });
  });

  test("maps a network failure to reason 'network'", async () => {
    __setFetchImplForTests(async () => {
      throw new Error("ECONNREFUSED");
    });
    const result = await braveSearch("q", "key");
    expect(result).toEqual({ ok: false, reason: "network" });
  });
});

describe("braveTestConnection", () => {
  test("ok on a successful probe", async () => {
    redirectToFakeServer();
    const result = await braveTestConnection("key");
    expect(result).toEqual({ ok: true });
  });

  test("surfaces the failure reason", async () => {
    redirectToFakeServer();
    nextStatus = 401;
    const result = await braveTestConnection("key");
    expect(result).toEqual({ ok: false, reason: "auth" });
  });
});

describe("security review 2026-10-08 — L3: redirect: error", () => {
  test("never follows a redirect from the Brave host", async () => {
    __setFetchImplForTests(async () => new Response(null, { status: 302, headers: { location: "https://evil.example.com" } }));
    const result = await braveSearch("q", "key");
    expect(result).toEqual({ ok: false, reason: "network" });
  });
});
