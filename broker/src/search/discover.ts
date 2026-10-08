// Finds a site's official documentation host, so a later search can be
// scoped to it (`site:help.kling.ai …`) instead of the open web —
// docs/PROTOCOL.md "Consulter la doc officielle", step 1. Cached 7 days per
// registrable domain in `~/.local/share/coati/doc-sites.json` (dataDir —
// never config.json: this is NOT a secret, docs/PROTOCOL.md says so
// explicitly). Bounded to ≤ 5 outgoing requests per (uncached) discovery: a
// `HEAD` on each of docs./help./support./developer.<domain>, in parallel,
// 3 s each, then one `GET …/llms.txt` on whichever host actually answered
// (first match in that priority order) — or, if none did, on the site's own
// origin, so a site that serves `llms.txt` straight from its own root
// without a doc subdomain is still found.

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { hardenDir, atomicWriteFileSync } from "../fs-atomic.ts";
import { safeFetch, isBlockedHostnameShape } from "./safe-fetch.ts";

export const DOC_SUBDOMAINS = ["docs", "help", "support", "developer"] as const;
export const DISCOVERY_CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const DISCOVERY_REQUEST_TIMEOUT_MS = 3000;

export interface DocSiteResult {
  /** Hostname search should be scoped to (e.g. "help.kling.ai"), or null —
   * "repli sur le web": no doc host found at all, docs/PROTOCOL.md §7. */
  scope: string | null;
  /** Content of `/llms.txt` when found on the scope (or on the plain site
   * when no subdomain answered), undefined otherwise. */
  llmsText?: string;
}

interface CacheEntry extends DocSiteResult {
  checkedAt: number;
}

type CacheFile = Record<string, CacheEntry>;

function cachePath(dataDir: string): string {
  return join(dataDir, "doc-sites.json");
}

function readCache(dataDir: string): CacheFile {
  const path = cachePath(dataDir);
  if (!existsSync(path)) return {};
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    return parsed as CacheFile;
  } catch {
    return {};
  }
}

// INFO (security review): unbounded growth guard — a connection asking about
// many distinct sites over time must never make doc-sites.json grow without
// bound. Oldest entries (by `checkedAt`) are dropped first once past the cap.
export const DOC_SITES_CACHE_MAX_DOMAINS = 200;

function pruneCache(cache: CacheFile): CacheFile {
  const entries = Object.entries(cache);
  if (entries.length <= DOC_SITES_CACHE_MAX_DOMAINS) return cache;
  entries.sort((a, b) => b[1].checkedAt - a[1].checkedAt); // newest first
  return Object.fromEntries(entries.slice(0, DOC_SITES_CACHE_MAX_DOMAINS));
}

function writeCache(dataDir: string, cache: CacheFile): void {
  try {
    hardenDir(dataDir);
    const pruned = pruneCache(cache);
    // Not a secret (docs/PROTOCOL.md) — 0644 is fine; atomicWriteFileSync
    // still gives us the symlink/partial-write safety, mode is our choice.
    atomicWriteFileSync(cachePath(dataDir), JSON.stringify(pruned, null, 2) + "\n", 0o644);
  } catch {
    // Best-effort cache — a write failure (read-only FS, race) must never
    // fail discovery itself, only cost the next call its cache hit.
  }
}

/**
 * Minimal eTLD+1 ("registrable domain") extraction — the broker ships no
 * Public Suffix List (no dependency, CLAUDE.md), so this is a small,
 * documented heuristic covering the common two-label ccTLD second-levels
 * (co.uk, com.cn…) and defaulting to "last two labels" otherwise. A
 * false-wide result (treating a three-label domain as if label 2 were the
 * TLD) only ever makes the 7-day CACHE KEY coarser — never a security
 * boundary: safe-fetch.ts's own per-request SSRF checks apply regardless.
 */
const TWO_LABEL_SUFFIXES = new Set([
  "co.uk", "org.uk", "gov.uk", "ac.uk", "me.uk", "ltd.uk", "plc.uk",
  "co.jp", "or.jp", "ne.jp", "ac.jp", "go.jp",
  "com.cn", "net.cn", "org.cn", "gov.cn", "edu.cn",
  "co.kr", "or.kr", "go.kr",
  "com.au", "net.au", "org.au", "gov.au", "edu.au",
  "co.nz", "org.nz", "govt.nz",
  "com.br", "net.br", "org.br", "gov.br",
  "co.in", "net.in", "org.in", "gov.in",
  "com.mx", "org.mx", "gob.mx",
  "co.za", "org.za", "gov.za",
  "com.tw", "org.tw", "gov.tw",
  "com.hk", "org.hk", "gov.hk",
  "com.sg", "org.sg", "gov.sg",
]);

export function registrableDomain(hostname: string): string | null {
  const host = hostname.toLowerCase().replace(/\.$/, "");
  const labels = host.split(".").filter((l) => l.length > 0);
  if (labels.length < 2) return null; // "au moins un point" — a bare name has none
  const lastTwo = labels.slice(-2).join(".");
  if (labels.length >= 3 && TWO_LABEL_SUFFIXES.has(lastTwo)) {
    return labels.slice(-3).join(".");
  }
  return lastTwo;
}

/** True iff `origin` names a public, registrable domain we're willing to
 * probe at all — no IP literal, no localhost/.local/.internal, at least one
 * dot. Does NOT perform any DNS lookup — safeFetch's own checks do that at
 * request time; this is only the cheap shape gate. */
export function isDiscoverableOrigin(origin: string): { hostname: string; domain: string } | null {
  let u: URL;
  try {
    u = new URL(origin);
  } catch {
    return null;
  }
  if (isBlockedHostnameShape(u.hostname)) return null;
  const domain = registrableDomain(u.hostname);
  if (!domain) return null;
  return { hostname: u.hostname, domain };
}

// Security review (L4): discovery promises "≤ 5 requests" — a redirect hop
// is itself an extra request against a THIRD host safeFetch would otherwise
// follow. `maxRedirects: 0` keeps every one of the 5 calls below to exactly
// one request each, no exceptions.
async function probeSubdomain(domain: string, sub: string): Promise<string | null> {
  const host = `${sub}.${domain}`;
  const result = await safeFetch(`https://${host}/`, {
    method: "HEAD",
    timeoutMs: DISCOVERY_REQUEST_TIMEOUT_MS,
    maxRedirects: 0,
  });
  return result.ok ? host : null;
}

// INFO (security review): llms.txt content is cached to disk — capped at
// 64 KiB stored (down from the 256 KiB read cap), so a hostile/huge
// `llms.txt` cannot bloat doc-sites.json.
const LLMS_TXT_MAX_STORED_BYTES = 64 * 1024;

// Security/correctness review (bug report): a site with no real /llms.txt
// commonly answers the GET with a 200 "soft 404" — its normal HTML shell
// (SPA catch-all, custom error page) rather than an HTTP error status.
// safeFetch only sees `ok: true` in that case, so it must be rejected here
// by CONTENT: accepted content-types are "absent" (some static hosts omit
// the header entirely for a plain-text file) or text/plain / text/markdown,
// AND the body must not start with "<" (covers "<!DOCTYPE", "<html",
// stray leading whitespace is trimmed first) — an HTML page always does.
const LLMS_TXT_ACCEPTED_CONTENT_TYPES = new Set(["text/plain", "text/markdown"]);

function looksLikeHtml(bodyText: string): boolean {
  return bodyText.trimStart().startsWith("<");
}

async function fetchLlmsTxt(host: string): Promise<string | undefined> {
  const result = await safeFetch(`https://${host}/llms.txt`, {
    method: "GET",
    timeoutMs: DISCOVERY_REQUEST_TIMEOUT_MS,
    maxBytes: LLMS_TXT_MAX_STORED_BYTES,
    maxRedirects: 0,
  });
  if (!result.ok || !result.bodyText) return undefined;
  if (result.contentType !== undefined && !LLMS_TXT_ACCEPTED_CONTENT_TYPES.has(result.contentType)) return undefined;
  if (looksLikeHtml(result.bodyText)) return undefined;
  return result.bodyText.slice(0, LLMS_TXT_MAX_STORED_BYTES);
}

/**
 * Discovers (or reads from cache) the documentation host for `origin`.
 * ≤ 5 outgoing requests total on a cache miss: 4 parallel `HEAD`s (one per
 * DOC_SUBDOMAINS entry) + 1 `GET /llms.txt`. Never throws — an origin that
 * doesn't name a discoverable domain, or every request failing, resolves to
 * `{ scope: null }` (repli sur le web), exactly like a genuine "no doc site
 * found".
 */
export async function discoverDocSite(origin: string, dataDir: string): Promise<DocSiteResult> {
  const discoverable = isDiscoverableOrigin(origin);
  if (!discoverable) return { scope: null };
  const { hostname, domain } = discoverable;

  const cache = readCache(dataDir);
  const cached = cache[domain];
  if (cached && Date.now() - cached.checkedAt < DISCOVERY_CACHE_TTL_MS) {
    return { scope: cached.scope, llmsText: cached.llmsText };
  }

  const probes = await Promise.all(DOC_SUBDOMAINS.map((sub) => probeSubdomain(domain, sub)));
  // First match in DOC_SUBDOMAINS' own priority order (docs > help > support
  // > developer), never "whichever resolved first" (requests race in
  // parallel, but the CHOICE among successes stays deterministic).
  const scopeHost = probes.find((h): h is string => h !== null) ?? null;

  const llmsTargetHost = scopeHost ?? hostname;
  const llmsText = await fetchLlmsTxt(llmsTargetHost);

  // If no doc subdomain answered but the plain site itself serves
  // `llms.txt`, scope the search to that site rather than falling back to
  // the open web — it IS the site's own documentation entry point.
  const scope = scopeHost ?? (llmsText !== undefined ? hostname : null);

  const result: DocSiteResult = { scope, llmsText };
  cache[domain] = { ...result, checkedAt: Date.now() };
  writeCache(dataDir, cache);
  return result;
}
