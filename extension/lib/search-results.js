// Web search helpers (docs/PROTOCOL.md "Search"): reading a results page and
// building the sources list. No chrome.* and no module state, so the first
// function can be injected as-is with scripting.executeScript({ func }).

/**
 * Runs inside a results page of any engine. An organic result is an `a[href]`
 * with a title: a heading or a `*title*` class inside the link (Google, Brave
 * Search), or a heading wrapping the link (Bing, DuckDuckGo). It looks in
 * `#search` (Google) or, failing that, `main` / `body`. Links back to the
 * engine's own site are dropped, except redirect wrappers (`/url?q=…`,
 * `/l/?uddg=…`, Bing's `/ck/a?u=a1<base64>`), which are unwrapped. A link the
 * engine hides behind its own address (Brave Search's `/go/v1#<token>`) is kept
 * when the result shows another site in a `<cite>`: its `url` is that site's
 * origin, `via` the engine link that leads to the page.
 * Everything it needs is declared inside: it is serialised by the browser.
 */
export function collectSearchResults(limit) {
  const clean = (s) => (s || "").replace(/\s+/g, " ").trim();
  const brand = (host) => {
    const parts = host.replace(/^www\./, "").split(".");
    return parts.length >= 3 && parts[parts.length - 2].length <= 3 ? parts[parts.length - 3] : parts[parts.length - 2];
  };
  const TITLE = "h1, h2, h3, h4, [role=heading], [class~=title], [class*=-title], [class*=__title], [class*=_title]";
  const titleOf = (a) => {
    const inner = a.querySelector(TITLE);
    if (inner) return inner;
    const outer = a.parentElement?.closest(TITLE);
    return outer && outer.querySelectorAll("a[href]").length === 1 && clean(outer.textContent).length <= 300 ? outer : null;
  };
  const unwrap = (url) => {
    const inner = ["q", "url", "uddg"].map((k) => url.searchParams.get(k)).find((v) => v && /^https?:\/\//i.test(v));
    if (inner && /^\/(url|l)\/?$/.test(url.pathname)) return new URL(inner);
    const u = url.searchParams.get("u");
    if (u?.startsWith("a1") && /^\/ck\/a\/?$/.test(url.pathname)) {
      const decoded = atob(u.slice(2).replace(/-/g, "+").replace(/_/g, "/"));
      if (/^https?:\/\//i.test(decoded)) return new URL(decoded);
    }
    return null;
  };
  // The site shown in a `<cite>` of the link's own result box (no link elsewhere in it).
  const shownSite = (a) => {
    const own = (box) => [...box.querySelectorAll("a[href]")].every((l) => l.href === a.href);
    for (let i = 0, box = a; i < 3 && box && own(box); i++, box = box.parentElement) {
      const shown = clean(box.querySelector("cite")?.textContent).split(/[\s›»]/)[0];
      if (!shown) continue;
      try {
        const site = new URL(/^https?:\/\//i.test(shown) ? shown : `https://${shown}`);
        return site.hostname.includes(".") && brand(site.hostname) !== engine ? new URL(site.origin) : null;
      } catch {
        return null;
      }
    }
    return null;
  };
  const engine = brand(location.hostname);
  const root = document.querySelector("#search") || document.querySelector("main") || document.body;
  const found = [];
  const seen = new Set();
  for (const a of root.querySelectorAll("a[href]")) {
    const heading = titleOf(a);
    if (!heading) continue;
    const title = clean(heading.textContent).slice(0, 200);
    let url;
    let via;
    try {
      url = new URL(a.href);
      if (brand(url.hostname) === engine) {
        const own = url;
        url = unwrap(own);
        if (!url && (url = shownSite(a))) via = own.href;
      }
    } catch {
      continue;
    }
    const key = via ?? url?.href;
    if (!url || !title || (url.protocol !== "https:" && url.protocol !== "http:") || seen.has(key)) continue;
    seen.add(key);
    found.push({ a, title, url, via });
    if (found.length >= limit * 3) break;
  }
  // One result per site first, in page order, then the rest: an engine's
  // sub-links under one result do not fill the list.
  const kept = new Set();
  const sites = new Set();
  for (const f of found) {
    const site = brand(f.url.hostname);
    if (kept.size >= limit || sites.has(site)) continue;
    kept.add(f);
    sites.add(site);
  }
  for (const f of found) if (kept.size < limit) kept.add(f);
  const results = [];
  for (const { a, title, url, via } of found.filter((f) => kept.has(f))) {
    let snippet = "";
    let box = a;
    for (let i = 0; i < 4 && box.parentElement; i++) {
      box = box.parentElement;
      if (found.filter((f) => box.contains(f.a)).length > 1) break;
      const text = clean(box.textContent).replace(title, "");
      if (text.length > 40) {
        snippet = text.slice(0, 300);
        break;
      }
    }
    results.push(via ? { title, url: url.href, snippet, via } : { title, url: url.href, snippet });
  }
  return results;
}

/**
 * Runs inside the opened page. The HTTP status of its own navigation (read from
 * the Performance API, no extra request, no extra permission); 0 when the
 * browser does not expose it.
 */
export function navigationStatus() {
  const status = performance.getEntriesByType("navigation")[0]?.responseStatus;
  return typeof status === "number" ? status : 0;
}

/**
 * The sources list under an answer: only URLs Coati itself found (the results
 * it sent to the model), never one the model wrote. It grows with every search
 * of the question: `prior` is the list so far, `results` the new search's
 * (numbered after the `offset` results already sent), `pages` the pages just
 * read and `failed` the ones that could not be (both matched by `n`; a read
 * source takes the page's final address, a failed one stays listed, marked
 * `unreachable`). `check(url)` is the open-guard
 * verdict; a blocked address stays listed as text, not a link.
 * @returns {Array<{ n: number, title: string, url: string, read: boolean, verdict: string, unreachable?: true }>}
 */
export function sourcesFromSearch(prior, results, pages, check, offset = 0, failed = []) {
  const read = new Map(pages.map((p) => [p.n, p.url]));
  const failedNumbers = new Set(failed.map((f) => f.n));
  const sources = prior.map((s) => (read.has(s.n) ? { ...s, url: read.get(s.n), read: true } : failedNumbers.has(s.n) ? { ...s, unreachable: true } : s));
  for (const r of results) {
    let verdict;
    try {
      verdict = check(r.url).verdict;
    } catch {
      continue;
    }
    const n = offset + r.n;
    sources.push({ n, title: r.title || r.url, url: r.url, read: read.has(n), verdict });
  }
  return sources;
}

/** A source is clickable when it is on the list and its address passed the open guard. */
export function isClickableSource(source) {
  return !!source && source.verdict !== "blocked";
}
