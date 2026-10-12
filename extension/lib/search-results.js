// Web search helpers (docs/PROTOCOL.md "Search"): reading a results page and
// building the sources list. No chrome.* and no module state, so the first
// function can be injected as-is with scripting.executeScript({ func }).

/**
 * Runs inside a results page of any engine. An organic result is an `a[href]`
 * with a title: a heading or a `*title*` class inside the link (Google, Brave
 * Search), or a heading wrapping the link (Bing, DuckDuckGo). It looks in
 * `#search` (Google) or, failing that, `main` / `body`. Links back to the
 * engine's own site are dropped, except redirect wrappers (`/url?q=…`,
 * `/l/?uddg=…`, Bing's `/ck/a?u=a1<base64>`), which are unwrapped.
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
  const engine = brand(location.hostname);
  const root = document.querySelector("#search") || document.querySelector("main") || document.body;
  const found = [];
  const seen = new Set();
  for (const a of root.querySelectorAll("a[href]")) {
    const heading = titleOf(a);
    if (!heading) continue;
    const title = clean(heading.textContent).slice(0, 200);
    let url;
    try {
      url = new URL(a.href);
      if (brand(url.hostname) === engine) url = unwrap(url);
    } catch {
      continue;
    }
    if (!url || !title || (url.protocol !== "https:" && url.protocol !== "http:") || seen.has(url.href)) continue;
    seen.add(url.href);
    found.push({ a, title, url });
    if (found.length >= limit) break;
  }
  const results = [];
  for (const { a, title, url } of found) {
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
    results.push({ title, url: url.href, snippet });
  }
  return results;
}

/**
 * The sources list under an answer: only URLs Coati itself found (the results
 * it sent to the model), never one the model wrote. It grows with every search
 * of the question: `prior` is the list so far, `results` the new search's
 * (numbered after the `offset` results already sent), `pages` the pages just
 * read (matched by `n`). `check(url)` is the open-guard verdict; a blocked
 * address stays listed as text, not a link.
 * @returns {Array<{ n: number, title: string, url: string, read: boolean, verdict: string }>}
 */
export function sourcesFromSearch(prior, results, pages, check, offset = 0) {
  const readNumbers = new Set(pages.map((p) => p.n));
  const sources = prior.map((s) => (readNumbers.has(s.n) ? { ...s, read: true } : s));
  for (const r of results) {
    let verdict;
    try {
      verdict = check(r.url).verdict;
    } catch {
      continue;
    }
    const n = offset + r.n;
    sources.push({ n, title: r.title || r.url, url: r.url, read: readNumbers.has(n), verdict });
  }
  return sources;
}

/** A source is clickable when it is on the list and its address passed the open guard. */
export function isClickableSource(source) {
  return !!source && source.verdict !== "blocked";
}
