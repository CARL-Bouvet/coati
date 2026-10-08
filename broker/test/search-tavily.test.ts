// Lot C1 — search/tavily.ts: POST body shape, key in body (not a header),
// include_domains, status → reason mapping. Fake local server, same
// approach as search-brave.test.ts.

import { describe, expect, test, afterEach, beforeAll, afterAll } from "bun:test";
import {
  tavilySearch,
  tavilyTestConnection,
  __setFetchImplForTests,
  __resetFetchImplForTests,
} from "../src/search/tavily.ts";

let server: ReturnType<typeof Bun.serve>;
let lastBody: Record<string, unknown> | null = null;
let nextStatus = 200;
let nextBody: unknown = { results: [{ url: "https://help.kling.ai/a", title: "A" }] };

beforeAll(() => {
  server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(req) {
      lastBody = (await req.json().catch(() => null)) as Record<string, unknown> | null;
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
  nextBody = { results: [{ url: "https://help.kling.ai/a", title: "A" }] };
});

function redirectToFakeServer() {
  __setFetchImplForTests((_url, init) => fetch(`http://127.0.0.1:${server.port}/search`, init));
}

describe("tavilySearch", () => {
  test("sends the key in the JSON body, never a header", async () => {
    redirectToFakeServer();
    await tavilySearch("how to export", "my-tavily-key");
    expect(lastBody?.api_key).toBe("my-tavily-key");
  });

  test("passes include_domains when a domain is given", async () => {
    redirectToFakeServer();
    await tavilySearch("q", "key", { domain: "help.kling.ai" });
    expect(lastBody?.include_domains).toEqual(["help.kling.ai"]);
  });

  test("omits include_domains when no domain is given", async () => {
    redirectToFakeServer();
    await tavilySearch("q", "key");
    expect(lastBody?.include_domains).toBeUndefined();
  });

  test("parses results, including rawContent when present", async () => {
    redirectToFakeServer();
    nextBody = { results: [{ url: "https://help.kling.ai/a", title: "A", raw_content: "full text" }] };
    const result = await tavilySearch("q", "key", { includeRawContent: true });
    expect(result).toEqual({ ok: true, results: [{ url: "https://help.kling.ai/a", title: "A", rawContent: "full text" }] });
    expect(lastBody?.include_raw_content).toBe(true);
  });

  test("maps 401 to reason 'auth'", async () => {
    redirectToFakeServer();
    nextStatus = 401;
    const result = await tavilySearch("q", "key");
    expect(result).toEqual({ ok: false, reason: "auth" });
  });

  test("maps 432 to reason 'quota'", async () => {
    redirectToFakeServer();
    nextStatus = 432;
    const result = await tavilySearch("q", "key");
    expect(result).toEqual({ ok: false, reason: "quota" });
  });

  test("maps a network failure to reason 'network'", async () => {
    __setFetchImplForTests(async () => {
      throw new Error("ECONNREFUSED");
    });
    const result = await tavilySearch("q", "key");
    expect(result).toEqual({ ok: false, reason: "network" });
  });
});

describe("tavilyTestConnection", () => {
  test("ok on a successful probe", async () => {
    redirectToFakeServer();
    const result = await tavilyTestConnection("key");
    expect(result).toEqual({ ok: true });
  });

  test("surfaces the failure reason", async () => {
    redirectToFakeServer();
    nextStatus = 401;
    const result = await tavilyTestConnection("key");
    expect(result).toEqual({ ok: false, reason: "auth" });
  });
});

describe("security review 2026-10-08 — L3: redirect: error", () => {
  test("never follows a redirect from the Tavily host", async () => {
    __setFetchImplForTests(async () => new Response(null, { status: 302, headers: { location: "https://evil.example.com" } }));
    const result = await tavilySearch("q", "key");
    expect(result).toEqual({ ok: false, reason: "network" });
  });
});
