// Lot C1 ("Consulter la doc officielle") — SSRF-safety unit tests for
// search/safe-fetch.ts: docs/PROTOCOL.md §C "Sécurité" / plan §3C "Tests".
// No real network: `fetch` and DNS resolution are both injected.

import { describe, expect, test, afterEach } from "bun:test";
import {
  safeFetch,
  isPrivateIPv4,
  isPrivateIPv6,
  isBlockedHostnameShape,
  __setFetchImplForTests,
  __resetFetchImplForTests,
  __setLookupImplForTests,
  __resetLookupImplForTests,
  __setHttpsRequestImplForTests,
  __resetHttpsRequestImplForTests,
  type DnsAddress,
} from "../src/search/safe-fetch.ts";

afterEach(() => {
  __resetFetchImplForTests();
  __resetLookupImplForTests();
  __resetHttpsRequestImplForTests();
});

function lookupReturning(addrs: DnsAddress[]) {
  return async (_hostname: string) => addrs;
}

describe("isPrivateIPv4", () => {
  test.each([
    ["127.0.0.1", true],
    ["10.1.2.3", true],
    ["172.16.0.5", true],
    ["172.31.255.255", true],
    ["172.32.0.1", false],
    ["192.168.1.1", true],
    ["169.254.169.254", true], // cloud metadata
    ["100.64.0.1", true], // CGNAT
    ["8.8.8.8", false],
    ["1.1.1.1", false],
    ["203.0.113.5", true], // TEST-NET-3
  ] as const)("%s -> %s", (ip, expected) => {
    expect(isPrivateIPv4(ip)).toBe(expected);
  });
});

describe("isPrivateIPv6", () => {
  test.each([
    ["::1", true],
    ["::", true],
    ["fe80::1", true], // link-local
    ["fc00::1", true], // unique local
    ["fd12:3456:789a::1", true], // fd00::/8, within fc00::/7
    ["ff02::1", true], // multicast
    ["2001:4860:4860::8888", false], // public (Google DNS)
    ["::ffff:169.254.169.254", true], // IPv4-mapped metadata address
    ["::ffff:8.8.8.8", false], // IPv4-mapped public
  ] as const)("%s -> %s", (ip, expected) => {
    expect(isPrivateIPv6(ip)).toBe(expected);
  });
});

describe("isBlockedHostnameShape", () => {
  test("blocks IPv4 literals", () => expect(isBlockedHostnameShape("8.8.8.8")).toBe(true));
  test("blocks bracketed IPv6 literals", () => expect(isBlockedHostnameShape("[::1]")).toBe(true));
  test("blocks localhost", () => expect(isBlockedHostnameShape("localhost")).toBe(true));
  test("blocks .local suffix", () => expect(isBlockedHostnameShape("printer.local")).toBe(true));
  test("blocks .internal suffix", () => expect(isBlockedHostnameShape("svc.internal")).toBe(true));
  test("allows a plain domain", () => expect(isBlockedHostnameShape("help.kling.ai")).toBe(false));
});

describe("safeFetch", () => {
  test("refuses http:// outright", async () => {
    const result = await safeFetch("http://help.kling.ai/");
    expect(result.ok).toBe(false);
    expect(result.error).toBe("blocked-host");
  });

  test("refuses an IP-literal URL without ever resolving DNS", async () => {
    let lookupCalled = false;
    __setLookupImplForTests(async () => {
      lookupCalled = true;
      return [];
    });
    const result = await safeFetch("https://169.254.169.254/latest/meta-data/");
    expect(result.ok).toBe(false);
    expect(result.error).toBe("blocked-host");
    expect(lookupCalled).toBe(false);
  });

  test("refuses when DNS resolves to a private address", async () => {
    __setLookupImplForTests(lookupReturning([{ address: "10.0.0.5", family: 4 }]));
    __setFetchImplForTests(async () => {
      throw new Error("must never be called — blocked before fetch");
    });
    const result = await safeFetch("https://internal.example.com/");
    expect(result.ok).toBe(false);
    expect(result.error).toBe("blocked-host");
  });

  test("refuses when ANY resolved address (not just the first) is private", async () => {
    __setLookupImplForTests(
      lookupReturning([
        { address: "203.0.0.9", family: 4 }, // looks public
        { address: "127.0.0.1", family: 4 }, // but this one isn't
      ]),
    );
    const result = await safeFetch("https://rebind.example.com/");
    expect(result.ok).toBe(false);
    expect(result.error).toBe("blocked-host");
  });

  test("allows a public address and returns the body", async () => {
    __setLookupImplForTests(lookupReturning([{ address: "203.0.0.9", family: 4 }]));
    __setFetchImplForTests(async (url) => {
      expect(String(url)).toBe("https://docs.example.com/");
      return new Response("hello docs", { status: 200 });
    });
    const result = await safeFetch("https://docs.example.com/");
    expect(result.ok).toBe(true);
    expect(result.bodyText).toBe("hello docs");
  });

  test("sends an honest, Coati-naming User-Agent", async () => {
    __setLookupImplForTests(lookupReturning([{ address: "203.0.0.9", family: 4 }]));
    let sentUA: string | null = null;
    __setFetchImplForTests(async (_url, init) => {
      sentUA = new Headers(init?.headers).get("user-agent");
      return new Response("ok");
    });
    await safeFetch("https://docs.example.com/");
    expect(sentUA).toMatch(/Coati/);
  });

  test("HEAD never reads a body", async () => {
    __setLookupImplForTests(lookupReturning([{ address: "203.0.0.9", family: 4 }]));
    __setFetchImplForTests(async (_url, init) => {
      expect(init?.method).toBe("HEAD");
      return new Response(null, { status: 200 });
    });
    const result = await safeFetch("https://docs.example.com/", { method: "HEAD" });
    expect(result.ok).toBe(true);
    expect(result.bodyText).toBeUndefined();
  });

  test("follows a safe redirect, revalidating the new host", async () => {
    __setLookupImplForTests(async (hostname: string) => {
      if (hostname === "old.example.com") return [{ address: "203.0.0.1", family: 4 }];
      if (hostname === "new.example.com") return [{ address: "203.0.0.2", family: 4 }];
      return [];
    });
    __setFetchImplForTests(async (url) => {
      if (String(url) === "https://old.example.com/") {
        return new Response(null, { status: 302, headers: { location: "https://new.example.com/" } });
      }
      return new Response("final body", { status: 200 });
    });
    const result = await safeFetch("https://old.example.com/");
    expect(result.ok).toBe(true);
    expect(result.url).toBe("https://new.example.com/");
    expect(result.bodyText).toBe("final body");
  });

  test("blocks a redirect that points at a private address", async () => {
    __setLookupImplForTests(async (hostname: string) => {
      if (hostname === "old.example.com") return [{ address: "203.0.0.1", family: 4 }];
      if (hostname === "evil.example.com") return [{ address: "127.0.0.1", family: 4 }];
      return [];
    });
    __setFetchImplForTests(async (url) => {
      if (String(url) === "https://old.example.com/") {
        return new Response(null, { status: 302, headers: { location: "https://evil.example.com/" } });
      }
      throw new Error("must never reach the redirect target");
    });
    const result = await safeFetch("https://old.example.com/");
    expect(result.ok).toBe(false);
    expect(result.error).toBe("blocked-host");
  });

  test("gives up after more than maxRedirects hops", async () => {
    __setLookupImplForTests(lookupReturning([{ address: "203.0.0.1", family: 4 }]));
    let hop = 0;
    __setFetchImplForTests(async () => {
      hop++;
      return new Response(null, { status: 302, headers: { location: `https://step${hop}.example.com/` } });
    });
    __setLookupImplForTests(lookupReturning([{ address: "203.0.0.1", family: 4 }]));
    const result = await safeFetch("https://start.example.com/", { maxRedirects: 3 });
    expect(result.ok).toBe(false);
    expect(result.error).toBe("too-many-redirects");
    expect(hop).toBe(4); // initial + 3 allowed hops, 4th rejected
  });

  test("refuses a body larger than maxBytes", async () => {
    __setLookupImplForTests(lookupReturning([{ address: "203.0.0.1", family: 4 }]));
    __setFetchImplForTests(async () => new Response("x".repeat(1000), { status: 200 }));
    const result = await safeFetch("https://docs.example.com/", { maxBytes: 100 });
    expect(result.ok).toBe(false);
    expect(result.error).toBe("too-large");
  });

  test("times out when fetch hangs past timeoutMs", async () => {
    __setLookupImplForTests(lookupReturning([{ address: "203.0.0.1", family: 4 }]));
    __setFetchImplForTests(
      (_url, init) =>
        new Promise((_resolve, reject) => {
          const signal = init?.signal as AbortSignal | undefined;
          signal?.addEventListener("abort", () => reject(new Error("aborted")));
        }),
    );
    const result = await safeFetch("https://docs.example.com/", { timeoutMs: 20 });
    expect(result.ok).toBe(false);
    expect(result.error).toBe("timeout");
  });
});

describe("security review 2026-10-08 — L1: more IPv4-in-IPv6 encodings", () => {
  test.each([
    ["::0.0.0.1", true], // IPv4-compatible, embeds 0.0.0.1 (0.0.0.0/8)
    ["::203.0.0.9", false], // IPv4-compatible, embeds a genuinely public v4
    ["64:ff9b::169.254.169.254", true], // NAT64 embedding cloud metadata
    ["64:ff9b::203.0.0.9", false], // NAT64 embedding a public v4
    ["2002:c0a8:0101::", true], // 6to4 embedding 192.168.1.1
    ["2002:cb00:0009::", false], // 6to4 embedding 203.0.0.9 (public)
    ["fec0::1", true], // site-local
    ["100::1", true], // discard-only prefix
  ] as const)("%s -> %s", (ip, expected) => {
    expect(isPrivateIPv6(ip)).toBe(expected);
  });
});

describe("security review 2026-10-08 — L2: hostname normalisation + suffixes", () => {
  test.each([
    ["EXAMPLE.COM", false],
    ["localhost.", true],
    ["LOCALHOST", true],
    ["printer.localhost", true],
    ["box.home.arpa", true],
    ["server.lan", true],
    ["help.example.com.", false], // trailing dot stripped, still a normal domain
  ] as const)("%s -> blocked=%s", (host, expected) => {
    expect(isBlockedHostnameShape(host)).toBe(expected);
  });
});

describe("security review 2026-10-08 — M1: DNS-rebinding fix (production transport)", () => {
  function fakeClientRequest(statusCode: number, bodyChunks: string[] = []) {
    const { EventEmitter } = require("node:events");
    const req = new EventEmitter() as any;
    req.end = () => {
      setTimeout(() => {
        const res = new EventEmitter() as any;
        res.statusCode = statusCode;
        res.headers = {};
        res.resume = () => {};
        res.destroy = () => {};
        req.emit("response", res);
        // A real socket's "data"/"end" always arrive on later ticks than
        // "response" — emitting them synchronously in the same tick would
        // fire before the awaiting code (which resolves on a microtask) has
        // a chance to attach its own "data"/"end" listeners. Scheduling
        // them one tick later mirrors real streaming behaviour.
        setTimeout(() => {
          for (const chunk of bodyChunks) res.emit("data", Buffer.from(chunk));
          res.emit("end");
        }, 0);
      }, 0);
    };
    return req;
  }

  test("the pinned lookup callback returns EXACTLY the address safeFetch already validated, never re-resolving", async () => {
    __setLookupImplForTests(async (hostname: string) => {
      // The validating lookup sees a SAFE address...
      if (hostname === "rebind.example.com") return [{ address: "93.184.216.34", family: 4 as const }];
      return [];
    });
    let lookupCallbackAddress: string | undefined;
    __setHttpsRequestImplForTests((options: any) => {
      // ...and the actual connect-time lookup the transport uses must be
      // pinned to that SAME address, never asking the resolver again (which
      // — on a rebinding DNS setup — could now answer 127.0.0.1).
      options.lookup("rebind.example.com", {}, (_err: unknown, address: string) => {
        lookupCallbackAddress = address;
      });
      return fakeClientRequest(200, ["safe body"]);
    });
    const result = await safeFetch("https://rebind.example.com/");
    expect(lookupCallbackAddress).toBe("93.184.216.34");
    expect(result).toEqual({ ok: true, status: 200, url: "https://rebind.example.com/", bodyText: "safe body" });
    __resetHttpsRequestImplForTests();
  });

  test("still refuses outright when the VALIDATING lookup itself returns a private address (no connection even attempted)", async () => {
    __setLookupImplForTests(async () => [{ address: "127.0.0.1", family: 4 as const }]);
    let requested = false;
    __setHttpsRequestImplForTests(() => {
      requested = true;
      return fakeClientRequest(200);
    });
    const result = await safeFetch("https://rebind.example.com/");
    expect(result).toEqual({ ok: false, error: "blocked-host" });
    expect(requested).toBe(false);
    __resetHttpsRequestImplForTests();
  });

  test("streams the body through the pinned transport with the same byte cap", async () => {
    __setLookupImplForTests(async () => [{ address: "93.184.216.34", family: 4 as const }]);
    __setHttpsRequestImplForTests(() => fakeClientRequest(200, ["x".repeat(50), "y".repeat(50)]));
    const result = await safeFetch("https://docs.example.com/", { maxBytes: 60 });
    expect(result).toEqual({ ok: false, error: "too-large" });
    __resetHttpsRequestImplForTests();
  });
});

describe("security review 2026-10-08 — L10: DNS lookup raced against abort", () => {
  test("a hanging DNS lookup is bounded by timeoutMs, not left to hang forever", async () => {
    __setLookupImplForTests(() => new Promise(() => {})); // never resolves
    const start = performance.now();
    const result = await safeFetch("https://docs.example.com/", { timeoutMs: 30 });
    expect(result).toEqual({ ok: false, error: "timeout" });
    expect(performance.now() - start).toBeLessThan(1000);
  });
});
