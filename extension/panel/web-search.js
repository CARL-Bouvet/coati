// Coati side panel — answers the broker's `search.request` (docs/PROTOCOL.md
// "Search"): the query runs in the browser's default engine in a background
// tab, the results list is read, then the first SEARCH_MAX_PAGES results are
// opened (after the open guard) and read. Every tab is left open. Needs the
// "all sites" permission; without it the answer is `search.decline`.
import { api } from "../lib/browser-compat.js";
import { checkOpen } from "../lib/open-guard.js";
import { collectSearchResults, sourcesFromSearch } from "../lib/search-results.js";
import { panelState, newId } from "./panel-state.js";
import { renderMessage } from "./message-render.js";
import { sendClientMessage } from "./request-watch.js";
import { extractFromTab } from "./page-extract.js";
import { currentPageUrl } from "./page-detect.js";
import { ALL_SITES_ORIGINS } from "./read-button.js";

const SEARCH_MAX_RESULTS = 8;
const SEARCH_MAX_PAGES = 2;
const SEARCH_MAX_TOTAL_CHARS = 24_000;
const TAB_LOAD_TIMEOUT_MS = 15_000;

/** True when the browser can run a query in its default engine. */
export function canSearch() {
  return typeof chrome !== "undefined" && typeof chrome.search?.query === "function";
}

/** Resolves true on `status: "complete"`, false after `ms`. With
 * `afterNavigation`, only a load that starts after this call counts (the
 * results tab is blank and "complete" before the query navigates it). */
function waitForLoad(tabId, ms, afterNavigation) {
  return new Promise((resolve) => {
    let loading = !afterNavigation;
    let timer;
    const finish = (ok) => {
      clearTimeout(timer);
      api.tabs.onUpdated.removeListener(listener);
      resolve(ok);
    };
    const listener = (id, info) => {
      if (id !== tabId) return;
      if (info.status === "loading") loading = true;
      if (info.status === "complete" && loading) finish(true);
    };
    api.tabs.onUpdated.addListener(listener);
    timer = setTimeout(() => finish(false), ms);
    if (!afterNavigation) {
      api.tabs
        .get(tabId)
        .then((tab) => {
          if (tab.status === "complete") finish(true);
        })
        .catch(() => {});
    }
  });
}

async function readResults(query) {
  const tab = await api.tabs.create({ active: false });
  const loaded = waitForLoad(tab.id, TAB_LOAD_TIMEOUT_MS, true);
  await api.search.query({ text: query, tabId: tab.id });
  await loaded;
  const injected = await api.scripting.executeScript({
    target: { tabId: tab.id },
    func: collectSearchResults,
    args: [SEARCH_MAX_RESULTS],
  });
  const found = injected?.[0]?.result;
  return Array.isArray(found) ? found.map((r, i) => ({ n: i + 1, ...r })) : [];
}

async function readPage(url, maxChars) {
  const tab = await api.tabs.create({ url, active: false });
  await waitForLoad(tab.id, TAB_LOAD_TIMEOUT_MS, false);
  const page = await extractFromTab(tab.id);
  return { title: page.title || "", text: (page.text || "").slice(0, maxChars) };
}

async function decline(id, reason) {
  await sendClientMessage({ type: "search.decline", id: newId(), target: id, reason });
}

export async function onSearchRequest(message) {
  const { id, query, discard } = message;
  const msg = panelState.conversation.find((m) => m.id === id);
  if (discard && msg) {
    msg.text = "";
    renderMessage(msg);
  }

  const allSites = await api.permissions.contains({ origins: ALL_SITES_ORIGINS }).catch(() => false);
  if (!allSites) {
    if (msg) {
      msg.searchAccess = query;
      renderMessage(msg);
    }
    await decline(id, "no-access");
    return;
  }

  if (msg) {
    msg.pageReading = { searchQuery: query };
    renderMessage(msg);
  }
  try {
    const results = await readResults(query);
    if (results.length === 0) {
      await decline(id, "no-result");
      return;
    }
    const level = panelState.devModePreference ? "dev" : "text";
    const check = (url) => checkOpen(currentPageUrl, url, level);
    const snippetChars = results.reduce((sum, r) => sum + r.snippet.length, 0);
    const perPage = Math.max(0, Math.floor((SEARCH_MAX_TOTAL_CHARS - snippetChars) / SEARCH_MAX_PAGES));
    if (results.every((r) => check(r.url).verdict === "blocked")) {
      await decline(id, "blocked");
      return;
    }
    const pages = [];
    for (const r of results.slice(0, SEARCH_MAX_PAGES)) {
      if (check(r.url).verdict === "blocked") continue;
      try {
        const page = await readPage(r.url, perPage);
        if (page.text) pages.push({ n: r.n, url: r.url, title: page.title || r.title, text: page.text });
      } catch {
        // an unreadable page is simply not read
      }
    }
    if (msg) msg.sources = sourcesFromSearch(results, pages, check);
    await sendClientMessage({ type: "search.content", id: newId(), target: id, query, results, pages });
  } catch {
    await decline(id, "failed");
  }
}
