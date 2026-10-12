// Coati side panel — answers the broker's `search.request` and `open.request`
// (docs/PROTOCOL.md "Search"). A query runs in the browser's default engine in
// one background tab reused for the whole question; the results are sent as
// they are. Pages the model asks to open (after the open guard) load one after
// another in a second reused tab and are read with their structured data
// first. Both tabs are left open. Needs the "all sites" permission; without it
// the answer is `search.decline` / `open.decline` "no-access".
import { api } from "../lib/browser-compat.js";
import { checkOpen } from "../lib/open-guard.js";
import { openedPageReadable } from "../lib/link-safety.js";
import { collectSearchResults, sourcesFromSearch } from "../lib/search-results.js";
import { readStructuredData } from "../lib/structured-data.js";
import { panelState, newId } from "./panel-state.js";
import { renderMessage } from "./message-render.js";
import { pageReadIn } from "./history.js";
import { sendClientMessage, armRequestDeadline } from "./request-watch.js";
import { extractFromTab } from "./page-extract.js";
import { currentPageUrl } from "./page-detect.js";
import { ALL_SITES_ORIGINS } from "./read-button.js";

const SEARCH_MAX_RESULTS = 8;
const SEARCH_MAX_PER_QUESTION = 4;
const OPEN_PAGE_MAX_CHARS = 6000;
const TAB_LOAD_TIMEOUT_MS = 15_000;
// How long the card waits for the user; the broker waits longer (docs/PROTOCOL.md "Search").
const SEARCH_CONFIRM_TIMEOUT_MS = 180_000;

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

/** Loads `url` in the reused tab and reads it, or returns null when the page
 * the tab ended on (after redirects) fails `mayRead`. */
async function readPage(url, slots, mayRead) {
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
  if (!mayRead((await liveTab(tab.id))?.url)) return null;
  const page = await extractFromTab(tab.id);
  const injected = await api.scripting.executeScript({ target: { tabId: tab.id }, func: readStructuredData }).catch(() => undefined);
  const data = injected?.[0]?.result;
  const text = `${typeof data === "string" && data ? `${data}\n\n` : ""}${page.text || ""}`.slice(0, OPEN_PAGE_MAX_CHARS);
  const finalUrl = (await liveTab(tab.id))?.url;
  return mayRead(finalUrl) ? { title: page.title || "", text, finalUrl } : null;
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

// Searches waiting for the user's answer, by message id (never persisted).
const pendingConfirms = new Map();

/** The query a card is asking about for this message, or undefined. */
export function pendingSearchQuery(id) {
  return pendingConfirms.get(id)?.query;
}

/** The card's buttons: resolves the wait of `confirmSearch`. */
export function answerSearchConfirm(id, allowed) {
  pendingConfirms.get(id)?.resolve(allowed);
}

/** Once a page was read in this conversation, the model's page-derived words
 * could carry its content out in a query: the user decides each search. */
async function confirmSearch(msg, query) {
  armRequestDeadline(msg.id, SEARCH_CONFIRM_TIMEOUT_MS + 70_000);
  const answer = new Promise((resolve) => {
    const timer = setTimeout(() => resolve(false), SEARCH_CONFIRM_TIMEOUT_MS);
    pendingConfirms.set(msg.id, {
      query,
      resolve: (allowed) => {
        clearTimeout(timer);
        pendingConfirms.delete(msg.id);
        resolve(allowed);
      },
    });
  });
  renderMessage(msg);
  const allowed = await answer;
  renderMessage(msg);
  armRequestDeadline(msg.id, 70_000);
  return allowed;
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

  if (msg?.approvedSearch !== query && pageReadIn(panelState.conversation)) {
    const allowed = msg ? await confirmSearch(msg, query) : false;
    if (panelState.activeRequestId !== id) return;
    if (!allowed) {
      await decline("search.decline", id, "blocked");
      return;
    }
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
        const page = await readPage(ref.url, slots, (final) => openedPageReadable(check, ref.url, final));
        if (page?.text) pages.push({ n: ref.n, url: page.finalUrl, title: page.title || ref.url, text: page.text });
      } catch {
        // an unreadable page is simply not read
      }
    }
    if (msg) {
      if (pages.length > 0) msg.pageRead = true;
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
