// Coati side panel — answers the broker's `search.request` and `open.request`
// (docs/PROTOCOL.md "Search"). A query runs in the browser's default engine in
// one background tab reused for the whole question; the results are sent as
// they are. Pages the model asks to open (after the open guard) load one after
// another in a second reused tab and are read with their structured data
// first. Both tabs are left open. Needs the "all sites" permission; without it
// the answer is `search.decline` / `open.decline` "no-access".
import { api } from "../lib/browser-compat.js";
import { checkOpen } from "../lib/open-guard.js";
import { collectSearchResults, sourcesFromSearch } from "../lib/search-results.js";
import { readStructuredData } from "../lib/structured-data.js";
import { panelState, newId } from "./panel-state.js";
import { renderMessage } from "./message-render.js";
import { sendClientMessage } from "./request-watch.js";
import { extractFromTab } from "./page-extract.js";
import { currentPageUrl } from "./page-detect.js";
import { ALL_SITES_ORIGINS } from "./read-button.js";

const SEARCH_MAX_RESULTS = 8;
const SEARCH_MAX_PER_QUESTION = 4;
const OPEN_PAGE_MAX_CHARS = 6000;
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

// The two reused tabs of the question being answered.
let session = { id: "", search: undefined, pages: undefined };

function tabsFor(id) {
  if (session.id !== id) session = { id, search: undefined, pages: undefined };
  return session;
}

async function liveTab(tabId) {
  if (tabId === undefined) return undefined;
  return api.tabs.get(tabId).catch(() => undefined);
}

async function readResults(query, slots) {
  const tab = (await liveTab(slots.search)) ?? (await api.tabs.create({ active: false }));
  slots.search = tab.id;
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

async function readPage(url, slots) {
  const existing = await liveTab(slots.pages);
  let tab = existing;
  if (existing) {
    const loaded = waitForLoad(existing.id, TAB_LOAD_TIMEOUT_MS, true);
    await api.tabs.update(existing.id, { url });
    await loaded;
  } else {
    tab = await api.tabs.create({ url, active: false });
    await waitForLoad(tab.id, TAB_LOAD_TIMEOUT_MS, false);
  }
  slots.pages = tab.id;
  const page = await extractFromTab(tab.id);
  const injected = await api.scripting.executeScript({ target: { tabId: tab.id }, func: readStructuredData }).catch(() => undefined);
  const data = injected?.[0]?.result;
  const text = `${typeof data === "string" && data ? `${data}\n\n` : ""}${page.text || ""}`.slice(0, OPEN_PAGE_MAX_CHARS);
  const final = (await liveTab(tab.id))?.url;
  return { title: page.title || "", text, finalUrl: /^https?:\/\//i.test(final || "") ? final : url };
}

async function decline(type, id, reason) {
  await sendClientMessage({ type, id: newId(), target: id, reason });
}

/** Honours the broker's `discard` (the marker came mid-answer) and reports
 * whether the "all sites" permission is held; without it the message offers
 * the grant button, carrying the query to re-run once granted. */
async function begin(message, retryQuery) {
  const msg = panelState.conversation.find((m) => m.id === message.id);
  if (message.discard && msg) {
    msg.text = "";
    renderMessage(msg);
  }
  const allSites = await api.permissions.contains({ origins: ALL_SITES_ORIGINS }).catch(() => false);
  if (!allSites && msg) {
    msg.searchAccess = retryQuery(msg);
    renderMessage(msg);
  }
  return { msg, allSites };
}

function setStatus(msg, status) {
  if (!msg) return;
  msg.pageReading = status;
  renderMessage(msg);
}

export async function onSearchRequest(message) {
  const { id, query } = message;
  const { msg, allSites } = await begin(message, () => query);
  if (!allSites) {
    await decline("search.decline", id, "no-access");
    return;
  }

  if (msg) {
    msg.searchRuns = (msg.searchRuns ?? 0) + 1;
    msg.lastQuery = query;
    setStatus(msg, { searchQuery: query, searchIndex: msg.searchRuns, searchMax: SEARCH_MAX_PER_QUESTION });
  }
  try {
    const results = await readResults(query, tabsFor(id));
    if (results.length === 0) {
      await decline("search.decline", id, "no-result");
      return;
    }
    if (msg) {
      const level = panelState.devModePreference ? "dev" : "text";
      msg.sources = sourcesFromSearch(msg.sources ?? [], results, [], (url) => checkOpen(currentPageUrl, url, level), msg.resultTotal ?? 0);
      msg.resultTotal = (msg.resultTotal ?? 0) + results.length;
    }
    await sendClientMessage({ type: "search.content", id: newId(), target: id, query, results });
  } catch {
    await decline("search.decline", id, "failed");
  } finally {
    setStatus(msg, undefined);
  }
}

export async function onOpenRequest(message) {
  const { id, refs } = message;
  const { msg, allSites } = await begin(message, (m) => m.lastQuery || m.question || refs[0]?.url || "…");
  if (!allSites) {
    await decline("open.decline", id, "no-access");
    return;
  }

  const level = panelState.devModePreference ? "dev" : "text";
  const check = (url) => checkOpen(currentPageUrl, url, level);
  const allowed = refs.filter((r) => check(r.url).verdict !== "blocked");
  if (allowed.length === 0) {
    await decline("open.decline", id, "blocked");
    return;
  }
  setStatus(msg, { openCount: allowed.length });
  try {
    const slots = tabsFor(id);
    const pages = [];
    for (const ref of allowed) {
      try {
        const page = await readPage(ref.url, slots);
        const url = check(page.finalUrl).verdict === "blocked" ? ref.url : page.finalUrl;
        if (page.text) pages.push({ n: ref.n, url, title: page.title || ref.url, text: page.text });
      } catch {
        // an unreadable page is simply not read
      }
    }
    if (msg) {
      msg.sources = sourcesFromSearch(msg.sources ?? [], [], pages, check);
      msg.openedPages = [...(msg.openedPages ?? []), ...pages.map((p) => ({ n: p.n, title: p.title, url: p.url }))];
    }
    await sendClientMessage({ type: "open.content", id: newId(), target: id, pages });
  } catch {
    await decline("open.decline", id, "failed");
  } finally {
    setStatus(msg, undefined);
  }
}
