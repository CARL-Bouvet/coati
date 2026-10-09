// SSRF-safe bounded fetch — the only way anything in broker/src/search/*
// ever reaches a URL that did not come from this broker's own hard-coded
// list of hosts (api.search.brave.com, api.tavily.com — see brave.ts/
// tavily.ts, which call fetch directly for those two fixed, authenticated
// hosts and do NOT go through this file). Every OTHER address this feature
// touches — a doc subdomain guessed by discover.ts, a page URL returned by a
// search engine or read from an llms.txt file — is attacker-influenceable in
// principle (a malicious or compromised search index, a doc site that
// redirects somewhere unexpected), so it goes through safeFetch(), which
// enforces docs/PROTOCOL.md:
//
//  - https:// only, never http:// (a plain downgrade would also leak nothing
//    since no secret is ever attached to these requests, but it's one less
//    thing to reason about and matches the rest of this feature's https-only
//    stance).
//  - No IP literal host (v4 or v6) — discovery/search only ever deal in
//    domain names; an IP literal is refused outright, never resolved.
//  - No "localhost", no ".local"/".internal" suffix.
//  - The hostname's OWN DNS resolution (every address it resolves to, not
//    just the first) must avoid loopback, private, link-local, CGNAT,
//    benchmarking/test-net, multicast/reserved and IPv4-mapped-into-IPv6
//    equivalents of all of the above — covers 169.254.169.254 (cloud
//    metadata) via the link-local range, and the IPv6 metadata-equivalents
//    (fc00::/7, fe80::/10, ::1, ::ffff:<private v4>).
//  - Re-validated at EVERY redirect hop (≤ 3) — a safe host redirecting to an
//    unsafe one is caught exactly like fetching the unsafe host directly; a
//    DNS answer could legitimately differ between the first lookup and the
//    one `fetch()` would perform internally, so this module does its own
//    lookup and keeps `redirect: "manual"` throughout rather than trusting
//    fetch() to follow redirects on its own.
//  - Bounded: 2 MiB of raw response body (GET only — HEAD never reads a
//    body), 8 s wall-clock covering the whole call including every hop.
//  - An honest User-Agent naming Coati (never a browser UA).

import * as dns from "node:dns";
import * as net from "node:net";
import { request as httpsRequestReal, type RequestOptions as HttpsRequestOptions } from "node:https";
import type { ClientRequest, IncomingMessage } from "node:http";

export const SAFE_FETCH_DEFAULT_TIMEOUT_MS = 8000;
export const SAFE_FETCH_MAX_BYTES = 2 * 1024 * 1024;
export const SAFE_FETCH_MAX_REDIRECTS = 3;

export const COATI_USER_AGENT =
  "Coati-DocSearch/0.1 (+https://github.com/CARL-Bouvet/coati; local browsing assistant, documentation search)";

export interface SafeFetchOptions {
  method?: "GET" | "HEAD";
  /** Wall-clock deadline for the ENTIRE call, including every redirect hop. */
  timeoutMs?: number;
  /** GET only — HEAD never reads a body. */
  maxBytes?: number;
  maxRedirects?: number;
  headers?: Record<string, string>;
}

export type SafeFetchErrorCode =
  | "invalid-url"
  | "blocked-host"
  | "dns"
  | "timeout"
  | "too-large"
  | "too-many-redirects"
  | "network"
  | "bad-status";

export interface SafeFetchResult {
  ok: boolean;
  status?: number;
  /** Final URL actually fetched, after following any redirect. */
  url?: string;
  /** GET only, present when ok. UTF-8 decoded, bounded to maxBytes raw. */
  bodyText?: string;
  /** GET only, present when ok and the response carried a `Content-Type`
   * header — lowercased, parameters (e.g. `; charset=`) stripped. */
  contentType?: string;
  error?: SafeFetchErrorCode;
}

type FetchFn = typeof fetch;
export interface DnsAddress {
  address: string;
  family: 4 | 6;
}
type LookupFn = (hostname: string) => Promise<DnsAddress[]>;

async function defaultLookup(hostname: string): Promise<DnsAddress[]> {
  const results = await dns.promises.lookup(hostname, { all: true, verbatim: true });
  return results.map((r) => ({ address: r.address, family: r.family as 4 | 6 }));
}

let fetchImpl: FetchFn = fetch;
let lookupImpl: LookupFn = defaultLookup;
// Security review (M1): `fetchImpl` (the Fetch API) is now ONLY used by
// tests that explicitly opt into it via __setFetchImplForTests — real
// traffic always goes through httpsRequestImpl (below), which pins the
// connection to the SAME address `lookupImpl` already validated. `fetch()`
// does its OWN internal DNS resolution at connect time, independent of
// whatever `lookupImpl` answered a moment earlier — on a hostile/rebinding
// DNS setup, the two resolutions can legitimately differ (TOCTOU), so
// `fetch()` is no longer trustworthy as the real transport. Kept only for
// the many existing tests (discover/brave/tavily/doc-search) that fake a
// generic HTTP response and don't themselves exercise the rebinding fix —
// see search-safe-fetch.test.ts's own dedicated httpsRequestImpl tests for
// that.
let fetchImplOverridden = false;

/** Test-only seam. Routes safeFetch through the Fetch API instead of the
 * pinned-lookup node:https transport — never active in production (see
 * comment above `fetchImplOverridden`). */
export function __setFetchImplForTests(f: FetchFn): void {
  fetchImpl = f;
  fetchImplOverridden = true;
}
export function __resetFetchImplForTests(): void {
  fetchImpl = fetch;
  fetchImplOverridden = false;
}
export function __setLookupImplForTests(f: LookupFn): void {
  lookupImpl = f;
}
export function __resetLookupImplForTests(): void {
  lookupImpl = defaultLookup;
}

// --- Hostname shape: literal IPs and obviously-local names are refused
// outright, before any DNS lookup — discovery/search only ever deal in
// public domain names. ------------------------------------------------------

// Security review (L2): a DNS label is case-insensitive and a trailing dot
// ("example.com.") names the exact same host — normalising BOTH before any
// comparison closes an "EXAMPLE.COM" / "localhost." bypass of the checks
// below (and of every suffix check in discover.ts/the blocklist here).
export function normalizeHostname(hostname: string): string {
  return hostname.toLowerCase().replace(/\.$/, "");
}

const BLOCKED_HOSTNAME_SUFFIXES = [".localhost", ".local", ".internal", ".home.arpa", ".lan"];

export function isBlockedHostnameShape(hostname: string): boolean {
  const normalized = normalizeHostname(hostname);
  const bare = normalized.replace(/^\[/, "").replace(/\]$/, "");
  if (net.isIP(bare) !== 0) return true;
  if (normalized === "localhost") return true;
  if (BLOCKED_HOSTNAME_SUFFIXES.some((suffix) => normalized.endsWith(suffix))) return true;
  return false;
}

// --- IPv4 reserved/private ranges -------------------------------------------

function ipv4ToInt(ip: string): number | null {
  const parts = ip.split(".");
  if (parts.length !== 4) return null;
  let n = 0;
  for (const p of parts) {
    if (!/^\d{1,3}$/.test(p)) return null;
    const v = Number(p);
    if (v > 255) return null;
    n = (n << 8) | v;
  }
  return n >>> 0;
}

function inCidr4(ip: number, base: string, bits: number): boolean {
  const b = ipv4ToInt(base);
  if (b === null) return false;
  const mask = bits === 0 ? 0 : (~0 << (32 - bits)) >>> 0;
  return (ip & mask) >>> 0 === (b & mask) >>> 0;
}

// 0.0.0.0/8 (unspecified), 10/8, 100.64/10 (CGNAT), 127/8 (loopback),
// 169.254/16 (link-local — includes the 169.254.169.254 cloud metadata
// address), 172.16/12, 192.0.0.0/24 + 192.0.2.0/24 (IETF/test-net),
// 192.168/16, 198.18.0.0/15 (benchmarking), 198.51.100.0/24, 203.0.113.0/24
// (test-net), 224/4 (multicast), 240/4 (reserved).
const IPV4_BLOCKED: Array<[string, number]> = [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.0.2.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 4],
  ["240.0.0.0", 4],
];

export function isPrivateIPv4(ip: string): boolean {
  const n = ipv4ToInt(ip);
  if (n === null) return true; // malformed — fail closed
  return IPV4_BLOCKED.some(([base, bits]) => inCidr4(n, base, bits));
}

// --- IPv6 reserved/private ranges, including the IPv4-mapped equivalents ---

function expandIPv6(ip: string): number[] | null {
  let addr = ip;
  let embeddedV4: number | null = null;
  const v4Match = /(?:^|:)(\d+\.\d+\.\d+\.\d+)$/.exec(addr);
  if (v4Match) {
    embeddedV4 = ipv4ToInt(v4Match[1]);
    if (embeddedV4 === null) return null;
    addr = addr.slice(0, addr.length - v4Match[1].length) + "0:0";
  }
  const segments = addr.split("::");
  if (segments.length > 2) return null;
  const head = segments[0] ? segments[0].split(":").filter((s) => s.length > 0) : [];
  const tail = segments.length === 2 && segments[1] ? segments[1].split(":").filter((s) => s.length > 0) : [];
  let groups: string[];
  if (segments.length === 2) {
    const missing = 8 - (head.length + tail.length);
    if (missing < 0) return null;
    groups = [...head, ...Array(missing).fill("0"), ...tail];
  } else {
    groups = head;
  }
  if (groups.length !== 8) return null;
  const nums = groups.map((g) => Number.parseInt(g, 16));
  if (nums.some((n) => Number.isNaN(n) || n < 0 || n > 0xffff)) return null;
  if (embeddedV4 !== null) {
    nums[6] = (embeddedV4 >>> 16) & 0xffff;
    nums[7] = embeddedV4 & 0xffff;
  }
  return nums;
}

function nums16ToV4(hi: number, lo: number): string {
  return `${(hi >> 8) & 0xff}.${hi & 0xff}.${(lo >> 8) & 0xff}.${lo & 0xff}`;
}

export function isPrivateIPv6(ip: string): boolean {
  const clean = ip.replace(/^\[/, "").replace(/\]$/, "");
  const nums = expandIPv6(clean);
  if (!nums) return true; // malformed — fail closed

  // ::ffff:0:0/96 — IPv4-mapped: check the embedded IPv4 address instead.
  if (nums[0] === 0 && nums[1] === 0 && nums[2] === 0 && nums[3] === 0 && nums[4] === 0 && nums[5] === 0xffff) {
    return isPrivateIPv4(nums16ToV4(nums[6], nums[7]));
  }
  // ::1/128 (loopback) and ::/128 (unspecified) — checked BEFORE the
  // IPv4-compatible range below, since ::1 would otherwise also match its
  // all-zero-prefix shape (harmless in outcome — 0.0.0.1 is still caught by
  // isPrivateIPv4's 0.0.0.0/8 — but wrong reasoning; checked first for
  // clarity and to not depend on that coincidence).
  if (nums.slice(0, 7).every((n) => n === 0) && (nums[7] === 1 || nums[7] === 0)) return true;
  // Security review (L1): three more IPv4-in-IPv6 encodings, each checked
  // via the SAME embedded-v4 recursion as the mapped form above — a
  // resolver/stack that still honours any of these must never be trusted
  // just because the outer address "looks IPv6".
  // ::0.0.0.0/96 (IPv4-compatible, deprecated but still parsed by some
  // stacks) — first 6 groups zero, no ffff marker.
  if (nums.slice(0, 6).every((n) => n === 0)) {
    return isPrivateIPv4(nums16ToV4(nums[6], nums[7]));
  }
  // 64:ff9b::/96 (NAT64 well-known prefix).
  if (nums[0] === 0x0064 && nums[1] === 0xff9b && nums[2] === 0 && nums[3] === 0 && nums[4] === 0 && nums[5] === 0) {
    return isPrivateIPv4(nums16ToV4(nums[6], nums[7]));
  }
  // 2002::/16 (6to4) — embedded v4 is the next 32 bits (nums[1]/nums[2]).
  if (nums[0] === 0x2002) {
    return isPrivateIPv4(nums16ToV4(nums[1], nums[2]));
  }
  // fc00::/7 (unique local — covers fd00::/8).
  if ((nums[0] & 0xfe00) === 0xfc00) return true;
  // fe80::/10 (link-local).
  if ((nums[0] & 0xffc0) === 0xfe80) return true;
  // fec0::/10 (site-local — deprecated by RFC 3879, still occasionally
  // configured on legacy/internal networks).
  if ((nums[0] & 0xffc0) === 0xfec0) return true;
  // 100::/64 (discard-only prefix, RFC 6666 — never a legitimate server).
  if (nums[0] === 0x0100 && nums.slice(1, 4).every((n) => n === 0)) return true;
  // ff00::/8 (multicast).
  if ((nums[0] & 0xff00) === 0xff00) return true;
  return false;
}

export function isPrivateAddress(addr: DnsAddress): boolean {
  return addr.family === 4 ? isPrivateIPv4(addr.address) : isPrivateIPv6(addr.address);
}

// --- M1: DNS-rebinding fix — the production transport pins the TCP
// connection to the address already validated, instead of letting the HTTP
// client re-resolve (and potentially get a different, unvalidated answer)
// at connect time. ----------------------------------------------------------

type HttpsRequestFn = (options: HttpsRequestOptions) => ClientRequest;
let httpsRequestImpl: HttpsRequestFn = httpsRequestReal;
/** Test-only seam for the pinned-lookup transport itself (distinct from
 * __setFetchImplForTests's legacy Fetch-API seam above). */
export function __setHttpsRequestImplForTests(f: HttpsRequestFn): void {
  httpsRequestImpl = f;
}
export function __resetHttpsRequestImplForTests(): void {
  httpsRequestImpl = httpsRequestReal;
}

/**
 * Security review (L10): races the DNS lookup against the SAME abort
 * signal driving the overall timeout — without this, a lookup that hangs
 * (a slow/unresponsive resolver) is not bounded by `timeoutMs` at all,
 * since `dns.promises.lookup` has no signal of its own.
 */
function lookupRaced(hostname: string, signal: AbortSignal): Promise<DnsAddress[]> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(new Error("aborted"));
      return;
    }
    const onAbort = () => reject(new Error("aborted"));
    signal.addEventListener("abort", onAbort, { once: true });
    lookupImpl(hostname).then(
      (addrs) => {
        signal.removeEventListener("abort", onAbort);
        resolve(addrs);
      },
      (err) => {
        signal.removeEventListener("abort", onAbort);
        reject(err);
      },
    );
  });
}

interface PinnedResponse {
  statusCode: number;
  headers: Record<string, string | string[] | undefined>;
  stream: IncomingMessage;
}

/**
 * Issues ONE HTTPS request (no redirect handling — the caller's own loop
 * does that, revalidating each hop) pinned to `addr` via a custom `lookup`
 * — Bun 1.4.2's node:https `request()` honours this option (reviewer
 * verified): the TCP connection is made to EXACTLY the address passed here,
 * never a fresh resolution of `hostname`. TLS SNI/certificate hostname
 * verification still uses `hostname` normally (only the connect-time
 * address is pinned), so a legitimate cert for the real domain still
 * validates correctly.
 */
function pinnedHttpsRequest(
  url: URL,
  addr: DnsAddress,
  method: string,
  headers: Record<string, string>,
  signal: AbortSignal,
): Promise<PinnedResponse | { error: "network" | "timeout" }> {
  return new Promise((resolve) => {
    const req = httpsRequestImpl({
      method,
      hostname: url.hostname,
      port: url.port ? Number(url.port) : 443,
      path: `${url.pathname}${url.search}`,
      protocol: "https:",
      headers,
      signal,
      // The runtime may call lookup with { all: true } and then expects an
      // array (admin, 08/10: answering with a bare address made every real
      // request fail with "network" while the mocked tests stayed green).
      lookup: (
        _hostname: string,
        options: { all?: boolean } | number | undefined,
        callback: (err: NodeJS.ErrnoException | null, address: unknown, family?: number) => void,
      ) => {
        if (typeof options === "object" && options?.all) {
          callback(null, [{ address: addr.address, family: addr.family }]);
        } else {
          callback(null, addr.address, addr.family);
        }
      },
    } as HttpsRequestOptions);
    req.on("response", (res: IncomingMessage) => {
      resolve({ statusCode: res.statusCode ?? 0, headers: res.headers as PinnedResponse["headers"], stream: res });
    });
    req.on("error", () => {
      resolve({ error: signal.aborted ? "timeout" : "network" });
    });
    req.end();
  });
}

/** Reads `stream` fully, bounded to `maxBytes` raw — destroys the stream and
 * reports "too-large" rather than ever buffering past the cap. */
function readStreamBounded(stream: IncomingMessage, maxBytes: number, signal: AbortSignal): Promise<{ ok: true; text: string } | { ok: false; error: SafeFetchErrorCode }> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let received = 0;
    let settled = false;
    const finish = (result: { ok: true; text: string } | { ok: false; error: SafeFetchErrorCode }) => {
      if (settled) return;
      settled = true;
      resolve(result);
    };
    stream.on("data", (chunk: Buffer) => {
      received += chunk.length;
      if (received > maxBytes) {
        stream.destroy();
        finish({ ok: false, error: "too-large" });
        return;
      }
      chunks.push(chunk);
    });
    stream.on("end", () => finish({ ok: true, text: Buffer.concat(chunks).toString("utf8") }));
    stream.on("error", () => finish({ ok: false, error: signal.aborted ? "timeout" : "network" }));
  });
}

/**
 * Bounded, SSRF-safe fetch. `redirect: "manual"` throughout — every hop's
 * hostname is independently re-validated (shape + fresh DNS lookup) before
 * it is ever fetched, exactly like the initial URL. Never throws; every
 * failure comes back as `{ ok: false, error }`.
 */
export async function safeFetch(rawUrl: string, opts: SafeFetchOptions = {}): Promise<SafeFetchResult> {
  const method = opts.method ?? "GET";
  const timeoutMs = opts.timeoutMs ?? SAFE_FETCH_DEFAULT_TIMEOUT_MS;
  const maxBytes = opts.maxBytes ?? SAFE_FETCH_MAX_BYTES;
  const maxRedirects = opts.maxRedirects ?? SAFE_FETCH_MAX_REDIRECTS;

  let currentUrl = rawUrl;
  let hops = 0;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    // eslint-disable-next-line no-constant-condition
    while (true) {
      let u: URL;
      try {
        u = new URL(currentUrl);
      } catch {
        return { ok: false, error: "invalid-url" };
      }
      if (u.protocol !== "https:") return { ok: false, error: "blocked-host" };
      if (isBlockedHostnameShape(u.hostname)) return { ok: false, error: "blocked-host" };

      let addrs: DnsAddress[];
      try {
        // Security review (L10): bounded by the same abort signal as
        // everything else in this call — a hung resolver can no longer
        // outlast timeoutMs.
        addrs = await lookupRaced(u.hostname, controller.signal);
      } catch {
        return { ok: false, error: controller.signal.aborted ? "timeout" : "dns" };
      }
      if (addrs.length === 0) return { ok: false, error: "dns" };
      if (addrs.some(isPrivateAddress)) return { ok: false, error: "blocked-host" };

      const requestHeaders = { "user-agent": COATI_USER_AGENT, host: u.hostname, ...opts.headers };

      if (fetchImplOverridden) {
        // Legacy test-only path — see fetchImplOverridden's own comment.
        let res: Response;
        try {
          res = await fetchImpl(currentUrl, { method, redirect: "manual", signal: controller.signal, headers: requestHeaders });
        } catch {
          return { ok: false, error: controller.signal.aborted ? "timeout" : "network" };
        }
        if (res.status >= 300 && res.status < 400) {
          const loc = res.headers.get("location");
          if (!loc) return { ok: false, error: "network" };
          hops++;
          if (hops > maxRedirects) return { ok: false, error: "too-many-redirects" };
          try {
            currentUrl = new URL(loc, currentUrl).toString();
          } catch {
            return { ok: false, error: "invalid-url" };
          }
          continue;
        }
        if (!res.ok) return { ok: false, status: res.status, url: currentUrl, error: "bad-status" };
        if (method === "HEAD" || !res.body) return { ok: true, status: res.status, url: currentUrl };
        const reader = res.body.getReader();
        let received = 0;
        const chunks: Uint8Array[] = [];
        try {
          // eslint-disable-next-line no-constant-condition
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            if (value) {
              received += value.byteLength;
              if (received > maxBytes) {
                await reader.cancel().catch(() => {});
                return { ok: false, error: "too-large" };
              }
              chunks.push(value);
            }
          }
        } catch {
          return { ok: false, error: controller.signal.aborted ? "timeout" : "network" };
        }
        const buf = Buffer.concat(chunks.map((c) => Buffer.from(c)));
        const ct = res.headers.get("content-type");
        return {
          ok: true,
          status: res.status,
          url: currentUrl,
          bodyText: buf.toString("utf8"),
          contentType: ct ? ct.split(";")[0]!.trim().toLowerCase() : undefined,
        };
      }

      // Production path — pinned to the address just validated above.
      const pinned = await pinnedHttpsRequest(u, addrs[0], method, requestHeaders, controller.signal);
      if ("error" in pinned) return { ok: false, error: pinned.error };

      if (pinned.statusCode >= 300 && pinned.statusCode < 400) {
        pinned.stream.resume(); // discard the redirect's own (irrelevant) body
        const loc = pinned.headers.location;
        const locStr = Array.isArray(loc) ? loc[0] : loc;
        if (!locStr) return { ok: false, error: "network" };
        hops++;
        if (hops > maxRedirects) return { ok: false, error: "too-many-redirects" };
        try {
          currentUrl = new URL(locStr, currentUrl).toString();
        } catch {
          return { ok: false, error: "invalid-url" };
        }
        continue;
      }

      if (pinned.statusCode < 200 || pinned.statusCode >= 300) {
        pinned.stream.resume();
        return { ok: false, status: pinned.statusCode, url: currentUrl, error: "bad-status" };
      }
      if (method === "HEAD") {
        pinned.stream.resume();
        return { ok: true, status: pinned.statusCode, url: currentUrl };
      }
      const body = await readStreamBounded(pinned.stream, maxBytes, controller.signal);
      if (!body.ok) return { ok: false, error: body.error };
      const pinnedCt = pinned.headers["content-type"];
      const pinnedCtStr = Array.isArray(pinnedCt) ? pinnedCt[0] : pinnedCt;
      return {
        ok: true,
        status: pinned.statusCode,
        url: currentUrl,
        bodyText: body.text,
        contentType: pinnedCtStr ? pinnedCtStr.split(";")[0]!.trim().toLowerCase() : undefined,
      };
    }
  } finally {
    clearTimeout(timer);
  }
}
