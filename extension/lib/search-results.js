// Web search helpers (docs/PROTOCOL.md "Search"): reading a results page and
// building the sources list. No chrome.* and no module state, so the first
// function can be injected as-is with scripting.executeScript({ func }).

/**
 * Runs inside a results page. An organic result is an `a[href]` that contains a
 * heading, inside `#search` (Google) or, failing that, anywhere in `main` /
 * `body` (other engines). Links back to the engine's own site are dropped,
 * except redirect wrappers (`/url?q=…`, `/l/?uddg=…`), which are unwrapped.
 * Everything it needs is declared inside: it is serialised by the browser.
 */
export function collectSearchResults(limit) {
  const clean = (s) => (s || "").replace(/\s+/g, " ").trim();
  const brand = (host) => {
    const parts = host.replace(/^www\./, "").split(".");
    return parts.length >= 3 && parts[parts.length - 2].length <= 3 ? parts[parts.length - 3] : parts[parts.length - 2];
  };
  const engine = brand(location.hostname);
  const root = document.querySelector("#search") || document.querySelector("main") || document.body;
  const results = [];
  const seen = new Set();
  for (const a of root.querySelectorAll("a[href]")) {
    const heading = a.querySelector("h1, h2, h3, h4, [role=heading]");
    if (!heading) continue;
    const title = clean(heading.textContent).slice(0, 200);
    let url;
    try {
      url = new URL(a.href);
      if (brand(url.hostname) === engine) {
        const inner = ["q", "url", "uddg"].map((k) => url.searchParams.get(k)).find((v) => v && /^https?:\/\//i.test(v));
        if (!inner || !/^\/(url|l)\/?$/.test(url.pathname)) continue;
        url = new URL(inner);
      }
    } catch {
      continue;
    }
    if (!title || (url.protocol !== "https:" && url.protocol !== "http:") || seen.has(url.href)) continue;
    seen.add(url.href);
    let snippet = "";
    let box = a;
    for (let i = 0; i < 4 && box.parentElement; i++) {
      box = box.parentElement;
      if (box.querySelectorAll("a[href] h1, a[href] h2, a[href] h3, a[href] h4").length > 1) break;
      const text = clean(box.textContent).replace(title, "");
      if (text.length > 40) {
        snippet = text.slice(0, 300);
        break;
      }
    }
    results.push({ title, url: url.href, snippet });
    if (results.length >= limit) break;
  }
  return results;
}

/**
 * The sources list under an answer: only URLs Coati itself found (the results
 * it sent to the model), never one the model wrote. `check(url)` is the
 * open-guard verdict; a blocked address stays listed as text, not a link.
 * @returns {Array<{ n: number, title: string, url: string, read: boolean, verdict: string }>}
 */
export function sourcesFromSearch(results, pages, check) {
  const readUrls = new Set(pages.map((p) => p.url));
  const sources = [];
  for (const r of results) {
    let verdict;
    try {
      verdict = check(r.url).verdict;
    } catch {
      continue;
    }
    sources.push({ n: r.n, title: r.title || r.url, url: r.url, read: readUrls.has(r.url), verdict });
  }
  return sources;
}

/** A source is clickable when it is on the list and its address passed the open guard. */
export function isClickableSource(source) {
  return !!source && source.verdict !== "blocked";
}
