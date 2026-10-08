// Shared types between the two search-engine adapters (brave.ts, tavily.ts)
// and the orchestrator (doc-search.ts) — kept in their own file so neither
// adapter has to import the other, and doc-search.ts can import both
// adapters plus these types without a cycle.

/** One organic web result from a search call, before any page is read. */
export interface SearchResult {
  url: string;
  title: string;
  /** Tavily's `include_raw_content` can return the page body inline, saving
   * a safeFetch round trip for that result — absent for Brave (which never
   * returns page bodies) and for a Tavily result that didn't get one. */
  rawContent?: string;
}

// Mirrors docs/PROTOCOL.md §8's `search-unavailable` reasons exactly —
// doc-search.ts maps this straight onto the wire's ErrorMessage.reason.
export type SearchFailureReason = "auth" | "quota" | "rate" | "network" | "no-result";

export type SearchCallResult =
  | { ok: true; results: SearchResult[] }
  | { ok: false; reason: SearchFailureReason };

export type SearchTestResult =
  | { ok: true }
  | { ok: false; reason: SearchFailureReason };

/** The two engines a user can configure — docs/PROTOCOL.md §9. */
export type SearchProviderId = "brave" | "tavily";
export function isSearchProviderId(v: unknown): v is SearchProviderId {
  return v === "brave" || v === "tavily";
}
