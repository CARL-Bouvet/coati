// Lot C1 — search/doc-search.ts: the exact bounds of plan §3C ("≤ 2 search
// calls, 5 results, ≤ 3 pages read, 8 000 chars/page, 24 000 total, no link
// followed from a read page"), llms.txt short-circuit, and the two typed
// errors (search-not-configured / search-unavailable).

import { describe, expect, test, afterEach } from "bun:test";
import {
  runDocSearch,
  matchLlmsTxt,
  isSearchNotConfiguredError,
  isSearchUnavailableError,
  DOC_SEARCH_MAX_PAGES,
  DOC_SEARCH_MAX_CHARS_PER_PAGE,
  DOC_SEARCH_MAX_TOTAL_CHARS,
  DOC_SEARCH_QUERY_MAX_CHARS,
  DOC_SEARCH_TITLE_MAX_CHARS,
  DOC_SEARCH_URL_MAX_CHARS,
  capAtWordBoundary,
} from "../src/search/doc-search.ts";
import type { DocSiteResult } from "../src/search/discover.ts";
import { __setFetchImplForTests as __setBraveFetch, __resetFetchImplForTests as __resetBraveFetch } from "../src/search/brave.ts";
import {
  __setFetchImplForTests as __setSafeFetchFetch,
  __resetFetchImplForTests as __resetSafeFetchFetch,
  __setLookupImplForTests,
  __resetLookupImplForTests,
} from "../src/search/safe-fetch.ts";
import { makeTmpDir } from "./helpers/tmp-dir.ts";

afterEach(() => {
  __resetBraveFetch();
  __resetSafeFetchFetch();
  __resetLookupImplForTests();
});

function fakeDiscover(result: DocSiteResult) {
  return async () => result;
}

function allowAllLookup() {
  __setLookupImplForTests(async () => [{ address: "93.184.216.34", family: 4 as const }]);
}

function htmlPage(bodyText: string): string {
  return `<html><body><nav>skip me</nav><p>${bodyText}</p><script>var x=1;</script></body></html>`;
}

describe("runDocSearch — configuration gate", () => {
  test("throws SearchNotConfiguredError when no provider/key given", async () => {
    const dataDir = makeTmpDir("coati-docsearch-");
    let caught: unknown;
    try {
      await runDocSearch({
        origin: "https://app.example.com",
        question: "how to export",
        dataDir,
        searchProvider: undefined,
        apiKey: undefined,
      });
    } catch (err) {
      caught = err;
    }
    expect(isSearchNotConfiguredError(caught)).toBe(true);
  });
});

describe("runDocSearch — llms.txt short-circuit", () => {
  test("uses llms.txt matches without any search-engine call", async () => {
    allowAllLookup();
    let braveCalled = false;
    __setBraveFetch(async () => {
      braveCalled = true;
      return new Response("{}");
    });
    __setSafeFetchFetch(async (url) => new Response(htmlPage(`Content of ${url}`), { status: 200 }));

    const dataDir = makeTmpDir("coati-docsearch-");
    const result = await runDocSearch({
      origin: "https://app.example.com",
      question: "how do I export a video",
      dataDir,
      searchProvider: "brave",
      apiKey: "key",
      __discoverOverride: fakeDiscover({
        scope: "help.example.com",
        llmsText: "- [Export a video](https://help.example.com/export) - guide\n",
      }),
    });

    expect(braveCalled).toBe(false);
    expect(result.engine).toBe("llms.txt");
    expect(result.sources[0]?.url).toBe("https://help.example.com/export");
  });
});

describe("matchLlmsTxt", () => {
  test("matches entries whose title contains a significant question word", () => {
    const llms = "- [Export a video](https://help.example.com/export)\n- [Billing FAQ](https://help.example.com/billing)\n";
    expect(matchLlmsTxt(llms, "how do I export my video", "help.example.com")).toEqual([
      { url: "https://help.example.com/export", title: "Export a video" },
    ]);
  });
  test("returns [] when nothing matches", () => {
    const llms = "- [Billing FAQ](https://help.example.com/billing)\n";
    expect(matchLlmsTxt(llms, "how do I export", "help.example.com")).toEqual([]);
  });
});

describe("runDocSearch — search call bounds", () => {
  test("filtered call first; unfiltered fallback only on zero results — ≤ 2 calls", async () => {
    allowAllLookup();
    const queries: string[] = [];
    __setBraveFetch(async (url) => {
      const u = new URL(String(url));
      queries.push(u.searchParams.get("q")!);
      const filtered = u.searchParams.get("q")!.startsWith("site:");
      const results = filtered ? [] : [{ url: "https://web.example.com/a", title: "A" }];
      return new Response(JSON.stringify({ web: { results } }), { status: 200 });
    });
    __setSafeFetchFetch(async (url) => new Response(htmlPage(`text for ${url}`), { status: 200 }));

    const dataDir = makeTmpDir("coati-docsearch-");
    const result = await runDocSearch({
      origin: "https://app.example.com",
      question: "q",
      dataDir,
      searchProvider: "brave",
      apiKey: "key",
      __discoverOverride: fakeDiscover({ scope: "help.example.com" }),
    });

    expect(queries.length).toBe(2); // ≤ 2 calls, never more
    expect(queries[0]).toMatch(/^site:help\.example\.com /);
    expect(queries[1]).not.toMatch(/^site:/);
    expect(result.engine).toBe("brave");
    expect(result.sources[0]?.url).toBe("https://web.example.com/a");
  });

  test("does not attempt an unfiltered call when scope is already null", async () => {
    allowAllLookup();
    let calls = 0;
    __setBraveFetch(async () => {
      calls++;
      return new Response(JSON.stringify({ web: { results: [{ url: "https://x/a", title: "A" }] } }), { status: 200 });
    });
    __setSafeFetchFetch(async () => new Response(htmlPage("text"), { status: 200 }));
    const dataDir = makeTmpDir("coati-docsearch-");
    await runDocSearch({
      origin: "https://app.example.com",
      question: "q",
      dataDir,
      searchProvider: "brave",
      apiKey: "key",
      __discoverOverride: fakeDiscover({ scope: null }),
    });
    expect(calls).toBe(1);
  });

  test("throws search-unavailable(no-result) when both calls come back empty", async () => {
    allowAllLookup();
    __setBraveFetch(async () => new Response(JSON.stringify({ web: { results: [] } }), { status: 200 }));
    const dataDir = makeTmpDir("coati-docsearch-");
    let caught: unknown;
    try {
      await runDocSearch({
        origin: "https://app.example.com",
        question: "q",
        dataDir,
        searchProvider: "brave",
        apiKey: "key",
        __discoverOverride: fakeDiscover({ scope: "help.example.com" }),
      });
    } catch (err) {
      caught = err;
    }
    expect(isSearchUnavailableError(caught) && (caught as { reason: string }).reason).toBe("no-result");
  });

  test("throws search-unavailable immediately on an auth failure, never tries a second call", async () => {
    allowAllLookup();
    let calls = 0;
    __setBraveFetch(async () => {
      calls++;
      return new Response("unauthorized", { status: 401 });
    });
    const dataDir = makeTmpDir("coati-docsearch-");
    let caught: unknown;
    try {
      await runDocSearch({
        origin: "https://app.example.com",
        question: "q",
        dataDir,
        searchProvider: "brave",
        apiKey: "key",
        __discoverOverride: fakeDiscover({ scope: "help.example.com" }),
      });
    } catch (err) {
      caught = err;
    }
    expect(isSearchUnavailableError(caught) && (caught as { reason: string }).reason).toBe("auth");
    expect(calls).toBe(1);
  });
});

describe("runDocSearch — page-read bounds", () => {
  test("reads at most DOC_SEARCH_MAX_PAGES pages even with more results", async () => {
    allowAllLookup();
    const resultUrls = Array.from({ length: 5 }, (_, i) => ({ url: `https://h.example.com/p${i}`, title: `P${i}` }));
    __setBraveFetch(async () => new Response(JSON.stringify({ web: { results: resultUrls } }), { status: 200 }));
    let pagesFetched = 0;
    __setSafeFetchFetch(async (url) => {
      pagesFetched++;
      return new Response(htmlPage(`body of ${url}`), { status: 200 });
    });
    const dataDir = makeTmpDir("coati-docsearch-");
    const result = await runDocSearch({
      origin: "https://app.example.com",
      question: "q",
      dataDir,
      searchProvider: "brave",
      apiKey: "key",
      __discoverOverride: fakeDiscover({ scope: "h.example.com" }),
    });
    expect(pagesFetched).toBe(DOC_SEARCH_MAX_PAGES);
    expect(result.sources.length).toBe(DOC_SEARCH_MAX_PAGES);
  });

  test("caps each page at DOC_SEARCH_MAX_CHARS_PER_PAGE and the total at DOC_SEARCH_MAX_TOTAL_CHARS", async () => {
    allowAllLookup();
    const resultUrls = Array.from({ length: 3 }, (_, i) => ({ url: `https://h.example.com/p${i}`, title: `P${i}` }));
    __setBraveFetch(async () => new Response(JSON.stringify({ web: { results: resultUrls } }), { status: 200 }));
    __setSafeFetchFetch(async () => new Response(htmlPage("x".repeat(50_000)), { status: 200 }));
    const dataDir = makeTmpDir("coati-docsearch-");
    const result = await runDocSearch({
      origin: "https://app.example.com",
      question: "q",
      dataDir,
      searchProvider: "brave",
      apiKey: "key",
      __discoverOverride: fakeDiscover({ scope: "h.example.com" }),
    });
    for (const s of result.sources) expect(s.text.length).toBeLessThanOrEqual(DOC_SEARCH_MAX_CHARS_PER_PAGE);
    const total = result.sources.reduce((sum, s) => sum + s.text.length, 0);
    expect(total).toBeLessThanOrEqual(DOC_SEARCH_MAX_TOTAL_CHARS);
  });

  test("Tavily's rawContent skips the safeFetch round trip entirely", async () => {
    allowAllLookup();
    let safeFetchCalled = false;
    __setSafeFetchFetch(async () => {
      safeFetchCalled = true;
      return new Response(htmlPage("should not be used"), { status: 200 });
    });
    const { __setFetchImplForTests: setTavilyFetch, __resetFetchImplForTests: resetTavilyFetch } = await import(
      "../src/search/tavily.ts"
    );
    setTavilyFetch(async () =>
      new Response(
        JSON.stringify({ results: [{ url: "https://h.example.com/a", title: "A", raw_content: "inline text" }] }),
        { status: 200 },
      ),
    );
    const dataDir = makeTmpDir("coati-docsearch-");
    const result = await runDocSearch({
      origin: "https://app.example.com",
      question: "q",
      dataDir,
      searchProvider: "tavily",
      apiKey: "key",
      __discoverOverride: fakeDiscover({ scope: "h.example.com" }),
    });
    expect(safeFetchCalled).toBe(false);
    expect(result.sources[0]?.text).toBe("inline text");
    resetTavilyFetch();
  });

  test("skips a page that fails to fetch, keeps the others — never follows a link from a read page", async () => {
    allowAllLookup();
    const resultUrls = [
      { url: "https://h.example.com/bad", title: "Bad" },
      { url: "https://h.example.com/good", title: "Good" },
    ];
    __setBraveFetch(async () => new Response(JSON.stringify({ web: { results: resultUrls } }), { status: 200 }));
    __setSafeFetchFetch(async (url) => {
      if (String(url).includes("/bad")) return new Response(null, { status: 500 });
      return new Response(htmlPage("good content, with a <a href=\"https://evil.example.com\">link</a> never followed"), {
        status: 200,
      });
    });
    const dataDir = makeTmpDir("coati-docsearch-");
    const result = await runDocSearch({
      origin: "https://app.example.com",
      question: "q",
      dataDir,
      searchProvider: "brave",
      apiKey: "key",
      __discoverOverride: fakeDiscover({ scope: "h.example.com" }),
    });
    expect(result.sources.length).toBe(1);
    expect(result.sources[0]?.url).toBe("https://h.example.com/good");
    expect(result.sources[0]?.text).not.toContain("evil.example.com");
  });
});

describe("runDocSearch — search.status emission", () => {
  test("emits discovering, searching, reading in order, sources only at reading", async () => {
    allowAllLookup();
    __setBraveFetch(async () =>
      new Response(JSON.stringify({ web: { results: [{ url: "https://h.example.com/a", title: "A" }] } }), { status: 200 }),
    );
    __setSafeFetchFetch(async () => new Response(htmlPage("content"), { status: 200 }));
    const events: Array<{ stage: string; hasSources: boolean }> = [];
    const dataDir = makeTmpDir("coati-docsearch-");
    await runDocSearch({
      origin: "https://app.example.com",
      question: "q",
      dataDir,
      searchProvider: "brave",
      apiKey: "key",
      __discoverOverride: fakeDiscover({ scope: "h.example.com" }),
      onStatus: (e) => events.push({ stage: e.stage, hasSources: e.sources !== undefined }),
    });
    expect(events.map((e) => e.stage)).toEqual(["discovering", "searching", "reading"]);
    expect(events[0]?.hasSources).toBe(false);
    expect(events[1]?.hasSources).toBe(false);
    expect(events[2]?.hasSources).toBe(true);
  });
});

describe("security review 2026-10-08 — H1/M2 fixes", () => {
  test("H1: a 256 KiB line of '[' parses in well under 100ms (no catastrophic backtracking)", () => {
    const evil = "[".repeat(256 * 1024);
    const start = performance.now();
    const result = matchLlmsTxt(evil, "export video", "help.example.com");
    const elapsed = performance.now() - start;
    expect(result).toEqual([]);
    expect(elapsed).toBeLessThan(100);
  });

  test("M2: a cross-domain link in llms.txt is never treated as this site's own documentation", () => {
    const llms = "- [Export a video](https://evil-tracker.example/export) - guide\n";
    const matches = matchLlmsTxt(llms, "how do I export my video", "help.example.com");
    expect(matches).toEqual([]);
  });

  test("M2: a same-domain link in llms.txt is kept", () => {
    const llms = "- [Export a video](https://help.example.com/export) - guide\n";
    const matches = matchLlmsTxt(llms, "how do I export my video", "help.example.com");
    expect(matches).toEqual([{ url: "https://help.example.com/export", title: "Export a video" }]);
  });

  test("M2: with scope null (open-web fallback), no llms.txt entry is ever kept", () => {
    const llms = "- [Export a video](https://help.example.com/export) - guide\n";
    expect(matchLlmsTxt(llms, "how do I export my video", null)).toEqual([]);
  });
});

describe("security review 2026-10-08 — INFO: query/title/url caps", () => {
  test("capAtWordBoundary cuts at the last space, never mid-word", () => {
    expect(capAtWordBoundary("hello world foo", 11)).toBe("hello world");
    expect(capAtWordBoundary("short", 100)).toBe("short");
    expect(capAtWordBoundary("nospaceshereatall", 5)).toBe("nospa");
  });

  test("a huge question is capped to 400 chars before reaching the search engine", async () => {
    allowAllLookup();
    let sentQuery = "";
    __setBraveFetch(async (url) => {
      sentQuery = new URL(String(url)).searchParams.get("q") ?? "";
      return new Response(JSON.stringify({ web: { results: [{ url: "https://h/a", title: "A" }] } }), { status: 200 });
    });
    __setSafeFetchFetch(async () => new Response(htmlPage("text"), { status: 200 }));
    const dataDir = makeTmpDir("coati-docsearch-");
    await runDocSearch({
      // Not a discoverable origin (no registrable domain) — this test is
      // about capAtWordBoundary on `question` alone, not the ladder's
      // site-domain rung (see "ladder" describe block below for that).
      origin: "https://localhost",
      question: "word ".repeat(200),
      dataDir,
      searchProvider: "brave",
      apiKey: "key",
      __discoverOverride: fakeDiscover({ scope: null }),
    });
    expect(sentQuery.length).toBeLessThanOrEqual(DOC_SEARCH_QUERY_MAX_CHARS);
  });

  test("source title/url are capped", async () => {
    allowAllLookup();
    const hugeTitle = "T ".repeat(200);
    const hugeUrl = "https://h.example.com/" + "p".repeat(3000);
    __setBraveFetch(async () =>
      new Response(JSON.stringify({ web: { results: [{ url: hugeUrl, title: hugeTitle }] } }), { status: 200 }),
    );
    __setSafeFetchFetch(async () => new Response(htmlPage("text"), { status: 200 }));
    const dataDir = makeTmpDir("coati-docsearch-");
    const result = await runDocSearch({
      origin: "https://app.example.com",
      question: "q",
      dataDir,
      searchProvider: "brave",
      apiKey: "key",
      __discoverOverride: fakeDiscover({ scope: "h.example.com" }),
    });
    expect(result.sources[0]?.title.length).toBeLessThanOrEqual(DOC_SEARCH_TITLE_MAX_CHARS);
    expect(result.sources[0]?.url.length).toBeLessThanOrEqual(DOC_SEARCH_URL_MAX_CHARS);
  });
});

// Bug fix (2026-10-08): the ladder was "discovered doc host → open web" —
// skipping the site's own registrable domain entirely when no doc
// sub-host/llms.txt was discovered. Now: discovered host → site's
// registrable domain (site:<domain>) → open web, in that order, open web
// tried only once the previous rung came back with 0 results.
describe("runDocSearch — ladder (discovered host → site domain → open web)", () => {
  test("no discovered scope: first call is filtered on the site's registrable domain, not open web", async () => {
    allowAllLookup();
    const queries: string[] = [];
    __setBraveFetch(async (url) => {
      const u = new URL(String(url));
      queries.push(u.searchParams.get("q")!);
      return new Response(JSON.stringify({ web: { results: [{ url: "https://klingai.com/a", title: "A" }] } }), { status: 200 });
    });
    __setSafeFetchFetch(async () => new Response(htmlPage("text"), { status: 200 }));
    const dataDir = makeTmpDir("coati-docsearch-");
    const result = await runDocSearch({
      origin: "https://www.klingai.com",
      question: "how to export",
      dataDir,
      searchProvider: "brave",
      apiKey: "key",
      __discoverOverride: fakeDiscover({ scope: null }),
    });
    expect(queries.length).toBe(1);
    expect(queries[0]).toMatch(/^site:klingai\.com /);
    expect(result.scope).toBe("klingai.com");
  });

  test("site-domain rung empty: falls back to the open web as the second (last) call", async () => {
    allowAllLookup();
    const queries: string[] = [];
    __setBraveFetch(async (url) => {
      const u = new URL(String(url));
      const q = u.searchParams.get("q")!;
      queries.push(q);
      const results = q.startsWith("site:") ? [] : [{ url: "https://web.example/a", title: "A" }];
      return new Response(JSON.stringify({ web: { results } }), { status: 200 });
    });
    __setSafeFetchFetch(async () => new Response(htmlPage("text"), { status: 200 }));
    const dataDir = makeTmpDir("coati-docsearch-");
    const result = await runDocSearch({
      origin: "https://www.klingai.com",
      question: "how to export",
      dataDir,
      searchProvider: "brave",
      apiKey: "key",
      __discoverOverride: fakeDiscover({ scope: null }),
    });
    expect(queries.length).toBe(2);
    expect(queries[0]).toMatch(/^site:klingai\.com /);
    expect(queries[1]).not.toMatch(/^site:/);
    expect(result.scope).toBe(null); // open web actually used — reported as such
  });

  test("neither site-domain nor open web found anything: no-result, exactly 2 calls", async () => {
    allowAllLookup();
    let calls = 0;
    __setBraveFetch(async () => {
      calls++;
      return new Response(JSON.stringify({ web: { results: [] } }), { status: 200 });
    });
    const dataDir = makeTmpDir("coati-docsearch-");
    let caught: unknown;
    try {
      await runDocSearch({
        origin: "https://www.klingai.com",
        question: "how to export",
        dataDir,
        searchProvider: "brave",
        apiKey: "key",
        __discoverOverride: fakeDiscover({ scope: null }),
      });
    } catch (err) {
      caught = err;
    }
    expect(isSearchUnavailableError(caught)).toBe(true);
    expect(calls).toBe(2);
  });

  test("non-discoverable origin (no registrable domain): straight to open web, 1 call", async () => {
    allowAllLookup();
    let calls = 0;
    __setBraveFetch(async () => {
      calls++;
      return new Response(JSON.stringify({ web: { results: [{ url: "https://web.example/a", title: "A" }] } }), { status: 200 });
    });
    __setSafeFetchFetch(async () => new Response(htmlPage("text"), { status: 200 }));
    const dataDir = makeTmpDir("coati-docsearch-");
    const result = await runDocSearch({
      origin: "https://localhost",
      question: "how to export",
      dataDir,
      searchProvider: "brave",
      apiKey: "key",
      __discoverOverride: fakeDiscover({ scope: null }),
    });
    expect(calls).toBe(1);
    expect(result.scope).toBe(null);
  });
});
