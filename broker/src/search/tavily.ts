// Tavily Search adapter — docs/PROTOCOL.md "Consulter la doc officielle".
// The API key is sent ONLY to api.tavily.com, in the POST body (Tavily's own
// contract — no header-based auth) — never logged, never echoed anywhere
// else (CLAUDE.md rule #1). Same "direct fetch, not safe-fetch.ts" reasoning
// as brave.ts: this endpoint is a hard-coded constant, not an
// attacker-influenceable URL.

import type { SearchCallResult, SearchFailureReason, SearchResult, SearchTestResult } from "./types.ts";
import { COATI_USER_AGENT } from "./safe-fetch.ts";

const TAVILY_SEARCH_URL = "https://api.tavily.com/search";
export const TAVILY_DEFAULT_TIMEOUT_MS = 8000;

type FetchFn = typeof fetch;
let fetchImpl: FetchFn = fetch;
export function __setFetchImplForTests(f: FetchFn): void {
  fetchImpl = f;
}
export function __resetFetchImplForTests(): void {
  fetchImpl = fetch;
}

function reasonForStatus(status: number): SearchFailureReason {
  if (status === 401 || status === 403) return "auth";
  if (status === 429) return "rate";
  // Tavily's own usage-cap responses (plan quota exhausted).
  if (status === 432 || status === 433) return "quota";
  return "network";
}

export interface TavilySearchOptions {
  /** When set, passed as `include_domains: [domain]` — docs/PROTOCOL.md §C
   * "Recherche" (filtered call). Omitted for the unfiltered fallback. */
  domain?: string;
  maxResults?: number;
  timeoutMs?: number;
  /**
   * Asks Tavily to fetch each result's page body inline — when it does,
   * doc-search.ts can skip its own safeFetch round trip for that result
   * entirely (docs/PROTOCOL.md §C: "Tavily `include_raw_content` évite ces
   * requêtes").
   */
  includeRawContent?: boolean;
}

/** One call to Tavily's /search endpoint. Never throws. */
export async function tavilySearch(
  query: string,
  apiKey: string,
  opts: TavilySearchOptions = {},
): Promise<SearchCallResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? TAVILY_DEFAULT_TIMEOUT_MS);
  try {
    let res: Response;
    try {
      res = await fetchImpl(TAVILY_SEARCH_URL, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "User-Agent": COATI_USER_AGENT,
        },
        body: JSON.stringify({
          api_key: apiKey,
          query,
          max_results: opts.maxResults ?? 5,
          include_domains: opts.domain ? [opts.domain] : undefined,
          include_raw_content: opts.includeRawContent ?? false,
        }),
        signal: controller.signal,
        // Security review (L3): same reasoning as brave.ts — a fixed,
        // authenticated, hard-coded API host should never redirect; fail
        // rather than silently follow one.
        redirect: "error",
      });
    } catch {
      return { ok: false, reason: "network" };
    }
    if (!res.ok) return { ok: false, reason: reasonForStatus(res.status) };

    let body: unknown;
    try {
      body = await res.json();
    } catch {
      return { ok: false, reason: "network" };
    }
    const items = (body as { results?: unknown[] } | null)?.results;
    const results: SearchResult[] = Array.isArray(items)
      ? items
          .filter(
            (it): it is { url: string; title: string; raw_content?: string } =>
              !!it &&
              typeof (it as Record<string, unknown>).url === "string" &&
              typeof (it as Record<string, unknown>).title === "string",
          )
          .map((it) => ({
            url: it.url,
            title: it.title,
            ...(typeof it.raw_content === "string" && it.raw_content.length > 0
              ? { rawContent: it.raw_content }
              : {}),
          }))
      : [];
    return { ok: true, results };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * No confirmed free key-check endpoint for Tavily (docs/PROTOCOL.md §C
 * "Questions ouvertes" #6: "Tavily `/usage` à confirmer") — falls back to
 * the same real-call probe as Brave's testConnection.
 */
export async function tavilyTestConnection(apiKey: string, timeoutMs?: number): Promise<SearchTestResult> {
  const result = await tavilySearch("coati browser extension documentation search", apiKey, {
    maxResults: 1,
    timeoutMs,
  });
  if (result.ok) return { ok: true };
  return { ok: false, reason: result.reason };
}
