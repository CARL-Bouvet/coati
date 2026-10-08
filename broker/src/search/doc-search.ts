// Orchestrates "Consulter la doc officielle" end to end — docs/PROTOCOL.md
// §C and plan §3C's exact bounds, enforced here and nowhere else:
//   - ≤ 2 search-engine calls (filtered by the discovered doc domain first,
//     unfiltered only if that came back empty) — 0 calls at all when
//     llms.txt already named a matching page.
//   - ≤ 5 results requested per call.
//   - ≤ 3 pages actually read.
//   - ≤ 8 000 chars of page text kept per page, ≤ 24 000 total.
//   - No link is ever followed from a page that was read (html-text.ts only
//     ever extracts text, never hrefs — there is nothing here that COULD
//     crawl).
// "Une seule recherche en cours par connexion" is enforced by the CALLER
// (server.ts), not here — this module has no notion of "a connection".

import { discoverDocSite, isDiscoverableOrigin, registrableDomain } from "./discover.ts";
import { braveSearch } from "./brave.ts";
import { tavilySearch } from "./tavily.ts";
import { safeFetch } from "./safe-fetch.ts";
import { extractReadableText } from "./html-text.ts";
import type { SearchFailureReason, SearchProviderId, SearchResult } from "./types.ts";

export const DOC_SEARCH_MAX_RESULTS = 5;
export const DOC_SEARCH_MAX_PAGES = 3;
export const DOC_SEARCH_MAX_CHARS_PER_PAGE = 8000;
export const DOC_SEARCH_MAX_TOTAL_CHARS = 24_000;
export const DOC_SEARCH_MAX_CALLS = 2;

/** Thrown when `chat.docSearch` was sent but no search provider/key is
 * configured — docs/PROTOCOL.md §8, error code `search-not-configured`. */
export class SearchNotConfiguredError extends Error {
  constructor() {
    super("chat.docSearch present but no search provider is configured");
    this.name = "SearchNotConfiguredError";
  }
}
export function isSearchNotConfiguredError(err: unknown): boolean {
  return err instanceof SearchNotConfiguredError;
}

/** Thrown when a provider/key IS configured but the search itself failed —
 * docs/PROTOCOL.md §8, error code `search-unavailable`. `reason` goes
 * straight onto the wire's ErrorMessage. */
export class SearchUnavailableError extends Error {
  readonly reason: SearchFailureReason;
  constructor(reason: SearchFailureReason, message?: string) {
    super(message ?? `search unavailable: ${reason}`);
    this.name = "SearchUnavailableError";
    this.reason = reason;
  }
}
export function isSearchUnavailableError(err: unknown): err is SearchUnavailableError {
  return err instanceof SearchUnavailableError;
}

export type SearchEngine = "brave" | "tavily" | "llms.txt";

export interface DocSearchSource {
  n: number;
  url: string;
  title: string;
  text: string;
}

export interface DocSearchStatusEvent {
  stage: "discovering" | "searching" | "reading";
  scope: string | null;
  engine?: SearchEngine;
  sources?: Array<{ n: number; url: string; title: string }>;
}

export interface DocSearchOptions {
  origin: string;
  question: string;
  dataDir: string;
  searchProvider: SearchProviderId | undefined;
  apiKey: string | undefined;
  onStatus?: (event: DocSearchStatusEvent) => void;
  /** Test-only override — real discovery (network) is skipped when provided. */
  __discoverOverride?: typeof discoverDocSite;
}

export interface DocSearchResult {
  scope: string | null;
  engine: SearchEngine;
  sources: DocSearchSource[];
}

/**
 * Picks llms.txt entries whose title loosely matches the question's own
 * significant (≥ 4 letters) words — docs/PROTOCOL.md §C step 2, "pages
 * choisies par recoupement des titres". llms.txt's own convention is a
 * markdown link list (`- [Title](https://url) - description`); unrecognised
 * lines are simply skipped, never an error — same tolerance as every other
 * best-effort page parser in this project.
 */
// Security review (2026-10-08, H1): the previous pattern
// `/\[([^\]]+)\]\((https:\/\/[^)\s]+)\)/g` has an unbounded `[^\]]+` right
// after a literal `[` — on an adversarial line of thousands of `[`
// characters with no closing `]`, the regex engine's backtracking makes
// this quadratic (seconds on a 256 KiB line of `[`, llms.txt content is
// page data, fully attacker-controlled). Both capture groups are now
// explicitly bounded (title ≤ 300 chars, no `[`/`]`/newline inside; URL
// ≤ 2048 chars, no `(`/`)`/whitespace inside) — a bounded quantifier cannot
// backtrack past its own cap, closing the blowup.
const LLMS_LINK_RE = /\[([^[\]\n]{1,300})\]\((https:\/\/[^()\s]{1,2048})\)/g;

/**
 * Security review (M2): only entries whose URL shares the SAME registrable
 * domain as `scope` are kept — an `llms.txt` is page-controlled data; a
 * cross-domain link inside it must never be treated as "this site's own
 * documentation" (that trust is exactly what justifies skipping Brave/
 * Tavily's filtered call). `scope` is already a discovered HOSTNAME (e.g.
 * "help.kling.ai"), so comparison is by registrableDomain() on both sides.
 */
function sameRegistrableDomain(url: string, scopeHostname: string): boolean {
  let hostname: string;
  try {
    hostname = new URL(url).hostname;
  } catch {
    return false;
  }
  const a = registrableDomain(hostname);
  const b = registrableDomain(scopeHostname);
  return a !== null && a === b;
}

export function matchLlmsTxt(llmsText: string, question: string, scopeHostname: string | null): SearchResult[] {
  const entries: SearchResult[] = [];
  for (const line of llmsText.split("\n")) {
    LLMS_LINK_RE.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = LLMS_LINK_RE.exec(line))) {
      entries.push({ url: m[2], title: m[1].trim() });
    }
  }
  const scoped = scopeHostname === null ? [] : entries.filter((e) => sameRegistrableDomain(e.url, scopeHostname));
  const words = question
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length >= 4);
  if (words.length === 0 || scoped.length === 0) return [];
  return scoped.filter((e) => {
    const title = e.title.toLowerCase();
    return words.some((w) => title.includes(w));
  });
}

// INFO (security review): bounds on values that flow into a third-party API
// request (query) or get stored/rendered (title, url) — none of this is a
// security boundary on its own (the real bounds are DOC_SEARCH_MAX_* above),
// just defence against a pathological question/page wasting bandwidth or
// bloating the prompt with a single huge field.
export const DOC_SEARCH_QUERY_MAX_CHARS = 400;
export const DOC_SEARCH_TITLE_MAX_CHARS = 200;
export const DOC_SEARCH_URL_MAX_CHARS = 2048;

/** Caps `text` to `maxChars`, backing off to the last word boundary rather
 * than cutting mid-word — exported for tests. */
export function capAtWordBoundary(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  const cut = text.slice(0, maxChars);
  // The cap itself already lands on a word boundary (next char is a space)
  // — no need to back off further.
  if (text[maxChars] === " ") return cut.trimEnd();
  const lastSpace = cut.lastIndexOf(" ");
  return (lastSpace > 0 ? cut.slice(0, lastSpace) : cut).trimEnd();
}

async function runSearchCall(
  provider: SearchProviderId,
  question: string,
  apiKey: string,
  domain: string | undefined,
): Promise<{ ok: true; results: SearchResult[] } | { ok: false; reason: SearchFailureReason }> {
  const opts = { domain, maxResults: DOC_SEARCH_MAX_RESULTS, includeRawContent: true };
  const result =
    provider === "brave" ? await braveSearch(question, apiKey, opts) : await tavilySearch(question, apiKey, opts);
  return result;
}

/** Reads one page's text, bounded to `maxChars`. Prefers a search result's
 * own `rawContent` (Tavily's `include_raw_content` — "évite ces requêtes",
 * docs/PROTOCOL.md §C step 3) over a fresh safeFetch GET. Returns undefined
 * on any failure — the caller skips that source rather than failing the
 * whole request, EXCEPT when every attempted page fails (see runDocSearch). */
async function readPageText(result: SearchResult, maxChars: number): Promise<string | undefined> {
  if (result.rawContent) {
    return result.rawContent.replace(/\s+/g, " ").trim().slice(0, maxChars);
  }
  const fetched = await safeFetch(result.url, { method: "GET", timeoutMs: 8000 });
  if (!fetched.ok || !fetched.bodyText) return undefined;
  const text = await extractReadableText(fetched.bodyText);
  return text.length > 0 ? text.slice(0, maxChars) : undefined;
}

/**
 * Runs the full discover → search → read pipeline for one `chat.docSearch`
 * request. Throws SearchNotConfiguredError / SearchUnavailableError; never
 * throws anything else (a page-read failure for one result just drops that
 * one source, see readPageText).
 */
export async function runDocSearch(opts: DocSearchOptions): Promise<DocSearchResult> {
  if (!opts.searchProvider || !opts.apiKey) {
    throw new SearchNotConfiguredError();
  }
  const provider = opts.searchProvider;
  const apiKey = opts.apiKey;
  // INFO (security review): capped once, at the top, so every downstream
  // use (llms.txt title matching, the search call itself) sees the same
  // bounded question — never an unbounded string handed to a third-party API.
  const question = capAtWordBoundary(opts.question, DOC_SEARCH_QUERY_MAX_CHARS);

  opts.onStatus?.({ stage: "discovering", scope: null });
  const discover = opts.__discoverOverride ?? discoverDocSite;
  const { scope, llmsText } = await discover(opts.origin, opts.dataDir);

  let engine: SearchEngine;
  let candidateResults: SearchResult[];

  // `scope` so far is a DISCOVERED doc host (e.g. "help.kling.ai") or null.
  // Ladder (bug fix, docs/PROTOCOL.md §C step 2): discovered doc host first;
  // when none was discovered, fall back to the SITE'S OWN registrable
  // domain (`site:klingai.com` / `include_domains`) rather than jumping
  // straight to the open web; the open web is tried only if that still
  // comes back empty. `effectiveScope` is what was actually used to filter
  // — reported on the wire instead of the (possibly null) discovered scope,
  // so the panel's "Recherche dans <scope>" reflects reality.
  const siteDomain = isDiscoverableOrigin(opts.origin)?.domain ?? null;
  let effectiveScope: string | null = scope;

  const llmsMatches = llmsText ? matchLlmsTxt(llmsText, question, scope) : [];
  if (llmsMatches.length > 0) {
    engine = "llms.txt";
    candidateResults = llmsMatches.slice(0, DOC_SEARCH_MAX_RESULTS);
    opts.onStatus?.({ stage: "searching", scope: effectiveScope, engine });
  } else {
    engine = provider;
    const firstDomain = scope ?? siteDomain ?? undefined;
    effectiveScope = firstDomain ?? null;
    opts.onStatus?.({ stage: "searching", scope: effectiveScope, engine });

    let calls = 0;
    let results: SearchResult[] = [];
    const first = await runSearchCall(provider, question, apiKey, firstDomain);
    calls++;
    if (!first.ok) throw new SearchUnavailableError(first.reason);
    results = first.results;

    if (results.length === 0 && firstDomain !== undefined && calls < DOC_SEARCH_MAX_CALLS) {
      // "sans filtre seulement si zéro résultat" — docs/PROTOCOL.md §C step 2.
      const second = await runSearchCall(provider, question, apiKey, undefined);
      calls++;
      if (!second.ok) throw new SearchUnavailableError(second.reason);
      results = second.results;
      if (results.length > 0) effectiveScope = null; // open web rung actually used
    }

    if (results.length === 0) throw new SearchUnavailableError("no-result");
    candidateResults = results;
  }

  // ≤ 3 pages read — never more attempts than DOC_SEARCH_MAX_PAGES regardless
  // of how many candidates came back.
  const toRead = candidateResults.slice(0, DOC_SEARCH_MAX_PAGES);
  const sources: DocSearchSource[] = [];
  let remainingBudget = DOC_SEARCH_MAX_TOTAL_CHARS;
  for (const result of toRead) {
    if (remainingBudget <= 0) break;
    const perPageCap = Math.min(DOC_SEARCH_MAX_CHARS_PER_PAGE, remainingBudget);
    const text = await readPageText(result, perPageCap);
    if (text === undefined) continue; // this one source dropped, others still tried
    remainingBudget -= text.length;
    sources.push({
      n: sources.length + 1,
      url: result.url.slice(0, DOC_SEARCH_URL_MAX_CHARS),
      title: capAtWordBoundary(result.title, DOC_SEARCH_TITLE_MAX_CHARS),
      text,
    });
  }

  if (sources.length === 0) {
    // We had candidates (a search/llms.txt match) but could not read a
    // single one of them — report it as the network reason rather than
    // silently answering with no sources at all.
    throw new SearchUnavailableError("network", "none of the candidate pages could be read");
  }

  opts.onStatus?.({
    stage: "reading",
    scope: effectiveScope,
    engine,
    sources: sources.map((s) => ({ n: s.n, url: s.url, title: s.title })),
  });

  return { scope: effectiveScope, engine, sources };
}
