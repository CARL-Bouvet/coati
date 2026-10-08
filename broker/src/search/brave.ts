// Brave Search adapter — docs/PROTOCOL.md "Consulter la doc officielle".
// The API key is sent ONLY to api.search.brave.com, in the
// `X-Subscription-Token` header — never logged, never echoed anywhere else
// (CLAUDE.md rule #1, config.ts's searchKeys doc). This file never reaches
// an attacker-influenceable URL — the endpoint is this one hard-coded
// constant — so it calls `fetch` directly rather than through
// safe-fetch.ts's SSRF machinery, which exists for URLs this feature does
// NOT control (doc subdomains, search *results*, see discover.ts/
// doc-search.ts).

import type { SearchCallResult, SearchFailureReason, SearchResult, SearchTestResult } from "./types.ts";
import { COATI_USER_AGENT } from "./safe-fetch.ts";

const BRAVE_SEARCH_URL = "https://api.search.brave.com/res/v1/web/search";
export const BRAVE_DEFAULT_TIMEOUT_MS = 8000;

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
  if (status === 402) return "quota";
  return "network";
}

export interface BraveSearchOptions {
  /** When set, the query is prefixed with `site:<domain> ` — docs/PROTOCOL.md
   * §C "Recherche" (filtered call). Omitted for the unfiltered fallback. */
  domain?: string;
  maxResults?: number;
  timeoutMs?: number;
}

/** One call to Brave's Web Search API. Never throws. `results` is always an
 * array on success, even empty — doc-search.ts decides what an empty result
 * set across both calls (filtered + unfiltered) means. */
export async function braveSearch(
  query: string,
  apiKey: string,
  opts: BraveSearchOptions = {},
): Promise<SearchCallResult> {
  const q = opts.domain ? `site:${opts.domain} ${query}` : query;
  const url = new URL(BRAVE_SEARCH_URL);
  url.searchParams.set("q", q);
  url.searchParams.set("count", String(opts.maxResults ?? 5));

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? BRAVE_DEFAULT_TIMEOUT_MS);
  try {
    let res: Response;
    try {
      res = await fetchImpl(url.toString(), {
        headers: {
          Accept: "application/json",
          "X-Subscription-Token": apiKey,
          "User-Agent": COATI_USER_AGENT,
        },
        signal: controller.signal,
        // Security review (L3): this is a fixed, hard-coded, authenticated
        // API host — a redirect here is always unexpected (never a normal
        // part of Brave's contract) and would otherwise carry the
        // `X-Subscription-Token` header to wherever it points. Fail instead
        // of silently following it.
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
    const items = (body as { web?: { results?: unknown[] } } | null)?.web?.results;
    const results: SearchResult[] = Array.isArray(items)
      ? items
          .filter(
            (it): it is { url: string; title: string } =>
              !!it &&
              typeof (it as Record<string, unknown>).url === "string" &&
              typeof (it as Record<string, unknown>).title === "string",
          )
          .map((it) => ({ url: it.url, title: it.title }))
      : [];
    return { ok: true, results };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Brave has no free key-check endpoint (docs/PROTOCOL.md §C "Questions
 * ouvertes" #6) — this spends one real search call, same as the extension's
 * "Vérifier la clé" button already tells the user it will.
 */
export async function braveTestConnection(apiKey: string, timeoutMs?: number): Promise<SearchTestResult> {
  const result = await braveSearch("coati browser extension documentation search", apiKey, {
    maxResults: 1,
    timeoutMs,
  });
  if (result.ok) return { ok: true };
  return { ok: false, reason: result.reason };
}
