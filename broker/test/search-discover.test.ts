// Lot C1 — search/discover.ts: registrable-domain extraction, ≤ 5-request
// bound, 7-day cache, "domaine non public refusé" (plan §3C "Tests").
// Underlying network calls go through safe-fetch.ts's own injected
// fetch/lookup — no real network.

import { describe, expect, test, afterEach } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  discoverDocSite,
  registrableDomain,
  isDiscoverableOrigin,
  DOC_SUBDOMAINS,
} from "../src/search/discover.ts";
import {
  __setFetchImplForTests,
  __resetFetchImplForTests,
  __setLookupImplForTests,
  __resetLookupImplForTests,
} from "../src/search/safe-fetch.ts";
import { makeTmpDir } from "./helpers/tmp-dir.ts";

afterEach(() => {
  __resetFetchImplForTests();
  __resetLookupImplForTests();
});

// Every host used below resolves to one fixed public address — the point of
// these tests is discover.ts's own request-count/priority/cache logic, not
// safe-fetch's SSRF checks (covered separately).
function allowAllLookup() {
  __setLookupImplForTests(async () => [{ address: "203.0.0.9", family: 4 as const }]);
}

describe("registrableDomain", () => {
  test("simple two-label domain", () => expect(registrableDomain("app.klingai.com")).toBe("klingai.com"));
  test("bare domain, no subdomain", () => expect(registrableDomain("klingai.com")).toBe("klingai.com"));
  test("known two-label suffix (co.uk)", () => expect(registrableDomain("www.example.co.uk")).toBe("example.co.uk"));
  test("a bare name with no dot is not discoverable", () => expect(registrableDomain("localhost")).toBeNull());
});

describe("isDiscoverableOrigin", () => {
  test("accepts a normal https origin", () => {
    expect(isDiscoverableOrigin("https://app.klingai.com")).toEqual({
      hostname: "app.klingai.com",
      domain: "klingai.com",
    });
  });
  test("refuses an IP-literal origin", () => {
    expect(isDiscoverableOrigin("https://8.8.8.8")).toBeNull();
  });
  test("refuses localhost", () => {
    expect(isDiscoverableOrigin("http://localhost:3000")).toBeNull();
  });
  test("refuses a malformed origin", () => {
    expect(isDiscoverableOrigin("not a url")).toBeNull();
  });
});

describe("discoverDocSite", () => {
  test("picks the first matching subdomain in priority order, ≤ 5 requests", async () => {
    allowAllLookup();
    const requested: string[] = [];
    __setFetchImplForTests(async (url) => {
      requested.push(String(url));
      const u = new URL(String(url));
      // "help" and "support" both answer — "docs" must win (priority order).
      if (u.hostname === "help.example.com" || u.hostname === "support.example.com") {
        return new Response(u.pathname === "/llms.txt" ? "# llms\n" : null, { status: 200 });
      }
      return new Response(null, { status: 404 });
    });
    const dataDir = makeTmpDir("coati-discover-");
    const result = await discoverDocSite("https://app.example.com", dataDir);
    expect(result.scope).toBe("help.example.com"); // before "support" — DOC_SUBDOMAINS order
    expect(requested.length).toBeLessThanOrEqual(5);
    expect(requested.length).toBe(DOC_SUBDOMAINS.length + 1); // 4 HEADs + 1 llms.txt GET
  });

  test("falls back to the plain site's own llms.txt when no subdomain answers", async () => {
    allowAllLookup();
    __setFetchImplForTests(async (url) => {
      const u = new URL(String(url));
      if (u.hostname === "app.example.com" && u.pathname === "/llms.txt") {
        return new Response("# llms\n", { status: 200 });
      }
      return new Response(null, { status: 404 });
    });
    const dataDir = makeTmpDir("coati-discover-");
    const result = await discoverDocSite("https://app.example.com", dataDir);
    expect(result.scope).toBe("app.example.com");
    expect(result.llmsText).toBe("# llms\n");
  });

  test("falls back to web (scope: null) when nothing answers at all", async () => {
    allowAllLookup();
    __setFetchImplForTests(async () => new Response(null, { status: 404 }));
    const dataDir = makeTmpDir("coati-discover-");
    const result = await discoverDocSite("https://app.example.com", dataDir);
    expect(result.scope).toBeNull();
    expect(result.llmsText).toBeUndefined();
  });

  test("a non-discoverable origin (IP literal) never makes a request", async () => {
    let called = false;
    __setFetchImplForTests(async () => {
      called = true;
      return new Response(null, { status: 404 });
    });
    const dataDir = makeTmpDir("coati-discover-");
    const result = await discoverDocSite("https://8.8.8.8", dataDir);
    expect(result.scope).toBeNull();
    expect(called).toBe(false);
  });

  test("caches the result for 7 days — a second call makes no new requests", async () => {
    allowAllLookup();
    let calls = 0;
    __setFetchImplForTests(async (url) => {
      calls++;
      const u = new URL(String(url));
      if (u.hostname === "docs.example.com") return new Response(null, { status: 200 });
      return new Response(null, { status: 404 });
    });
    const dataDir = makeTmpDir("coati-discover-");
    const first = await discoverDocSite("https://app.example.com", dataDir);
    const callsAfterFirst = calls;
    expect(callsAfterFirst).toBeGreaterThan(0);
    const second = await discoverDocSite("https://app.example.com", dataDir);
    expect(calls).toBe(callsAfterFirst); // no new requests — served from cache
    expect(second).toEqual(first);

    const cacheRaw = readFileSync(join(dataDir, "doc-sites.json"), "utf8");
    const cache = JSON.parse(cacheRaw);
    expect(cache["example.com"].scope).toBe("docs.example.com");
  });

  test("cache is keyed per registrable domain, not per subdomain/origin", async () => {
    allowAllLookup();
    __setFetchImplForTests(async (url) => {
      const u = new URL(String(url));
      if (u.hostname === "docs.example.com") return new Response(null, { status: 200 });
      return new Response(null, { status: 404 });
    });
    const dataDir = makeTmpDir("coati-discover-");
    await discoverDocSite("https://app.example.com", dataDir);
    let calls = 0;
    __setFetchImplForTests(async (url) => {
      calls++;
      const u = new URL(String(url));
      if (u.hostname === "docs.example.com") return new Response(null, { status: 200 });
      return new Response(null, { status: 404 });
    });
    const result = await discoverDocSite("https://other.sub.example.com", dataDir);
    expect(calls).toBe(0);
    expect(result.scope).toBe("docs.example.com");
  });
});

describe("security review 2026-10-08 — L4/INFO fixes", () => {
  test("L4: probeSubdomain never follows a redirect (maxRedirects 0)", async () => {
    allowAllLookup();
    let followedRedirectTarget = false;
    __setFetchImplForTests(async (url) => {
      const u = new URL(String(url));
      if (u.hostname === "docs.example.com") {
        return new Response(null, { status: 302, headers: { location: "https://other.example.com/" } });
      }
      if (u.hostname === "other.example.com") {
        followedRedirectTarget = true;
        return new Response(null, { status: 200 });
      }
      return new Response(null, { status: 404 });
    });
    const dataDir = makeTmpDir("coati-discover-");
    const result = await discoverDocSite("https://app.example.com", dataDir);
    expect(followedRedirectTarget).toBe(false);
    expect(result.scope).toBeNull();
  });

  test("INFO: doc-sites.json never grows past DOC_SITES_CACHE_MAX_DOMAINS, drops the oldest", async () => {
    allowAllLookup();
    __setFetchImplForTests(async () => new Response(null, { status: 404 }));
    const { DOC_SITES_CACHE_MAX_DOMAINS } = await import("../src/search/discover.ts");
    const dataDir = makeTmpDir("coati-discover-");
    for (let i = 0; i < DOC_SITES_CACHE_MAX_DOMAINS + 5; i++) {
      await discoverDocSite(`https://app.example${i}.com`, dataDir);
    }
    const cache = JSON.parse(readFileSync(join(dataDir, "doc-sites.json"), "utf8"));
    expect(Object.keys(cache).length).toBeLessThanOrEqual(DOC_SITES_CACHE_MAX_DOMAINS);
    // The very first domain (oldest) was evicted.
    expect(cache["example0.com"]).toBeUndefined();
  });

  test("INFO: an llms.txt far over 64 KiB is rejected outright (fail-closed), never stored oversized", async () => {
    allowAllLookup();
    __setFetchImplForTests(async (url) => {
      const u = new URL(String(url));
      if (u.hostname === "docs.example.com" && u.pathname === "/llms.txt") {
        return new Response("x".repeat(200_000), { status: 200 });
      }
      if (u.hostname === "docs.example.com") return new Response(null, { status: 200 });
      return new Response(null, { status: 404 });
    });
    const dataDir = makeTmpDir("coati-discover-");
    const result = await discoverDocSite("https://app.example.com", dataDir);
    expect(result.llmsText).toBeUndefined();
  });

  test("INFO: an llms.txt within the 64 KiB cap is kept verbatim", async () => {
    allowAllLookup();
    const body = "x".repeat(1000);
    __setFetchImplForTests(async (url) => {
      const u = new URL(String(url));
      if (u.hostname === "docs.example.com" && u.pathname === "/llms.txt") {
        return new Response(body, { status: 200 });
      }
      if (u.hostname === "docs.example.com") return new Response(null, { status: 200 });
      return new Response(null, { status: 404 });
    });
    const dataDir = makeTmpDir("coati-discover-");
    const result = await discoverDocSite("https://app.example.com", dataDir);
    expect(result.llmsText).toBe(body);
  });
});

// Bug fix (2026-10-08): a site with no real /llms.txt commonly answers the
// GET with a 200 "soft 404" — its normal HTML shell — rather than an HTTP
// error status. Only content-type absent/text/plain/text/markdown AND a
// body not starting with "<" is accepted as a genuine llms.txt.
describe("discoverDocSite — llms.txt HTML soft-404 rejection", () => {
  test("a 200 HTML page (text/html) at /llms.txt is rejected, not stored as llmsText", async () => {
    allowAllLookup();
    __setFetchImplForTests(async (url) => {
      const u = new URL(String(url));
      if (u.hostname === "docs.example.com" && u.pathname === "/llms.txt") {
        return new Response("<!DOCTYPE html><html><body>Not Found</body></html>", {
          status: 200,
          headers: { "content-type": "text/html; charset=utf-8" },
        });
      }
      if (u.hostname === "docs.example.com") return new Response(null, { status: 200 });
      return new Response(null, { status: 404 });
    });
    const dataDir = makeTmpDir("coati-discover-");
    const result = await discoverDocSite("https://app.example.com", dataDir);
    expect(result.llmsText).toBeUndefined();
  });

  test("a 200 page starting with '<' but no content-type header is still rejected (body shape wins)", async () => {
    allowAllLookup();
    __setFetchImplForTests(async (url) => {
      const u = new URL(String(url));
      if (u.hostname === "docs.example.com" && u.pathname === "/llms.txt") {
        return new Response("<html>oops</html>", { status: 200, headers: {} });
      }
      if (u.hostname === "docs.example.com") return new Response(null, { status: 200 });
      return new Response(null, { status: 404 });
    });
    const dataDir = makeTmpDir("coati-discover-");
    const result = await discoverDocSite("https://app.example.com", dataDir);
    expect(result.llmsText).toBeUndefined();
  });

  test("text/markdown content-type with a genuine body is accepted", async () => {
    allowAllLookup();
    __setFetchImplForTests(async (url) => {
      const u = new URL(String(url));
      if (u.hostname === "docs.example.com" && u.pathname === "/llms.txt") {
        return new Response("# Docs\n- [Guide](https://docs.example.com/guide)\n", {
          status: 200,
          headers: { "content-type": "text/markdown" },
        });
      }
      if (u.hostname === "docs.example.com") return new Response(null, { status: 200 });
      return new Response(null, { status: 404 });
    });
    const dataDir = makeTmpDir("coati-discover-");
    const result = await discoverDocSite("https://app.example.com", dataDir);
    expect(result.llmsText).toContain("Guide");
  });

  test("an unrelated content-type (e.g. application/json) is rejected even with plain-looking text", async () => {
    allowAllLookup();
    __setFetchImplForTests(async (url) => {
      const u = new URL(String(url));
      if (u.hostname === "docs.example.com" && u.pathname === "/llms.txt") {
        return new Response("- [Guide](https://docs.example.com/guide)\n", {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      if (u.hostname === "docs.example.com") return new Response(null, { status: 200 });
      return new Response(null, { status: 404 });
    });
    const dataDir = makeTmpDir("coati-discover-");
    const result = await discoverDocSite("https://app.example.com", dataDir);
    expect(result.llmsText).toBeUndefined();
  });
});
