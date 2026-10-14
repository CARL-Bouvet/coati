// Coati side panel — message rendering: bubbles, recovery blocks,
// timestamp/element-ref linkification, relaunch (split of panel.js).
//
// Each user message carries enough metadata (`msg.relaunch`) to resend it:
// a chat message replays through the exact same path as a fresh sendChat()
// (reading the page per the switch's CURRENT state, never a stale copy of
// what it read the first time), a summarize-triggered one re-runs
// summarize(). A message stored before this feature shipped (or restored
// from an older session) has no `relaunch` — inferRelaunch() below treats it
// as chat text, stripping the "attached page" marker sendChatMessage() adds.
import { t } from "../lib/i18n-page.js";
import { els } from "./dom-refs.js";
import { panelState, MAX_PERSISTED_MESSAGES } from "./panel-state.js";
import { ACCESS_DENIED_HINT } from "../lib/labels.js";
import { renderMarkdown } from "./markdown.js";
import { buildProgress, buildSlowTip } from "./model-advice.js";
import { isNearBottom } from "./scroll.js";
import { parseTimestamps } from "./timestamps.js";
import { parseElementRefs, resolveElementClick } from "./element-refs.js";
import { buildHistoryForWire, historyAlertState, readUntrustedIn } from "./history.js";
import { extractForChat, sendChatMessage } from "./composer-send.js";
import { summarize, reportExtractionError } from "./page-extract.js";
import { pendingRetries, lastHistoryKept } from "./chat-stream.js";
import { currentConnState, modelsReply, switchFromTip, openOllamaSpeedup, hasFeature } from "./model-status.js";
import { buildAuthRecoveryBlock } from "./request-watch.js";
import { api } from "../lib/browser-compat.js";
import { isClickableSource } from "../lib/search-results.js";
import { linkContext } from "../lib/link-safety.js";
import { currentPageUrl } from "./page-detect.js";
import { ALL_SITES_ORIGINS } from "./read-button.js";
import { pendingSearchQuery, answerSearchConfirm } from "./web-search.js";
import { refreshAllSitesGranted, refreshReadButton } from "./first-run-wiring.js";
import {
  buildQuotaRecoveryBlock,
  buildModelUnavailableRecoveryBlock,
  buildProviderOverloadRecoveryBlock,
  buildModelMissingRecoveryBlock,
  buildRateLimitRecoveryBlock,
} from "./recovery-blocks.js";
import { onPointButtonClick, buildPointLevelSlider, seekActiveVideoTab } from "./point-at.js";

export const PAGE_CONTENT_MARKER_SUFFIX = `\n\n${t("panel_with_page_content_marker")}`;

function inferRelaunch(text) {
  const stripped = text.endsWith(PAGE_CONTENT_MARKER_SUFFIX)
    ? text.slice(0, -PAGE_CONTENT_MARKER_SUFFIX.length)
    : text;
  return { type: "chat", text: stripped };
}

async function relaunchMessage(msg) {
  if (panelState.activeRequestId) return;
  const relaunch = msg.relaunch ?? inferRelaunch(msg.text);

  if (relaunch.type === "summarize") {
    await summarize();
    return;
  }

  let context;
  try {
    context = await extractForChat();
  } catch (err) {
    reportExtractionError(err, {
      accessDenied: t("panel_access_denied_relaunch", [ACCESS_DENIED_HINT]),
      other: (e) => t("panel_read_error_relaunch", [e.message]),
    });
    return;
  }
  // Same page-on-demand branch as sendChat() (composer-send.js) — a relaunch
  // reads the CURRENT page fresh and re-decides, never replays whatever the
  // original send happened to use.
  if (context && hasFeature("pageOnDemand")) {
    await sendChatMessage(relaunch.text, undefined, context);
  } else {
    await sendChatMessage(relaunch.text, context);
  }
}

/** Real DOM node, no innerHTML (CLAUDE.md rule #3). Sits below the bubble
 * (see the `.message-user-bubble` wrapper in renderMessage()), visible on
 * hover/keyboard focus, always in the tab order (card.css). */
function buildRelaunchButton(msg) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "message-relaunch";
  button.textContent = t("panel_relaunch");
  button.title = t("panel_relaunch_title");
  button.disabled = !!panelState.activeRequestId;
  button.addEventListener("click", () => relaunchMessage(msg));
  return button;
}

// --- Web search ---------------------------------------------------------

function appendLine(node, className, text) {
  const p = document.createElement("p");
  p.className = className;
  p.textContent = text;
  node.appendChild(p);
}

function buildSearchButton(msg, query) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "c-button search-suggest-button";
  button.textContent = t("panel_search_button", [query]);
  button.addEventListener("click", () => {
    if (panelState.activeRequestId) return;
    msg.suggestSearch = undefined;
    renderMessage(msg);
    sendChatMessage(msg.question || query, undefined, undefined, query);
  });
  return button;
}

/** The model asked for a search but "all sites" is not granted: the click is
 * the gesture the permission prompt needs. */
function buildSearchAccessBlock(msg) {
  const wrap = document.createElement("div");
  wrap.className = "search-access";
  appendLine(wrap, "search-status-line", t("panel_search_needs_access"));
  const button = document.createElement("button");
  button.type = "button";
  button.className = "c-button";
  button.textContent = t("panel_search_allow");
  button.addEventListener("click", async () => {
    const granted = await api.permissions.request({ origins: ALL_SITES_ORIGINS }).catch(() => false);
    if (!granted) return;
    msg.suggestSearch = msg.searchAccess;
    msg.searchAccess = undefined;
    renderMessage(msg);
    await refreshAllSitesGranted();
    await refreshReadButton();
  });
  wrap.appendChild(button);
  return wrap;
}

/** The model's search waits for the user: the full query as text, then Allow / Refuse. */
function buildSearchConfirmBlock(msg, query) {
  const wrap = document.createElement("div");
  wrap.className = "search-access search-confirm";
  appendLine(wrap, "search-status-line search-confirm-query", t("panel_search_confirm", [query]));
  for (const [allowed, key] of [[true, "panel_search_confirm_allow"], [false, "panel_search_confirm_refuse"]]) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = allowed ? "c-button c-button--primary" : "c-button";
    button.textContent = t(key);
    button.addEventListener("click", () => answerSearchConfirm(msg.id, allowed));
    wrap.appendChild(button);
  }
  return wrap;
}

/** "Web search · 3 searches · 5 pages · 14 k tokens", expandable to the
 * queries and the pages opened (title and domain). */
function buildSearchMentionBlock(msg) {
  const { text, queries, capped } = msg.searchMention;
  const details = document.createElement("details");
  details.className = "search-mention";
  const summary = document.createElement("summary");
  summary.className = "search-status-line";
  summary.textContent = capped ? `${text} · ${t("panel_search_capped")}` : text;
  details.appendChild(summary);
  const addList = (title, items) => {
    if (items.length === 0) return;
    appendLine(details, "c-section-title search-sources-title", title);
    const list = document.createElement("ul");
    list.className = "search-sources-list";
    for (const item of items) {
      const li = document.createElement("li");
      li.className = "search-sources-item";
      li.textContent = item;
      list.appendChild(li);
    }
    details.appendChild(list);
  };
  addList(t("panel_search_queries_title"), queries);
  addList(
    t("panel_search_pages_title"),
    (msg.openedPages ?? []).map((p) => {
      let host = "";
      try {
        host = new URL(p.url).hostname.replace(/^www\./, "");
      } catch {
        // no domain to show
      }
      return host ? `${p.title} — ${host}` : p.title;
    }),
  );
  if (capped) appendLine(details, "search-status-line", t("panel_search_capped_detail"));
  return details;
}

/** Only the results Coati found itself are listed; a blocked address is text,
 * not a link, and plain http carries a warning. */
function buildSourcesBlock(sources) {
  const wrap = document.createElement("div");
  wrap.className = "search-sources";
  appendLine(wrap, "c-section-title search-sources-title", t("panel_sources_title"));
  const list = document.createElement("ul");
  list.className = "search-sources-list";
  for (const source of sources) {
    const li = document.createElement("li");
    li.className = "search-sources-item";
    li.appendChild(document.createTextNode(`[S${source.n}] `));
    if (isClickableSource(source)) {
      const a = document.createElement("a");
      a.href = source.url;
      a.target = "_blank";
      a.rel = "noopener noreferrer";
      a.textContent = source.title;
      li.appendChild(a);
    } else {
      li.appendChild(document.createTextNode(source.title));
    }
    if (source.verdict === "warn-http") li.appendChild(document.createTextNode(` — ${t("panel_source_http_warning")}`));
    list.appendChild(li);
  }
  wrap.appendChild(list);
  return wrap;
}

// --- Rendering ----------------------------------------------------------

export function addMessage(msg) {
  panelState.conversation.push(msg.ts == null ? { ...msg, ts: Date.now() } : msg);
  if (panelState.conversation.length > MAX_PERSISTED_MESSAGES) {
    panelState.conversation = panelState.conversation.slice(-MAX_PERSISTED_MESSAGES);
  }
  renderAll();
}

export function renderAll() {
  els.messages.replaceChildren();
  for (const msg of panelState.conversation) renderMessage(msg, { append: true });
  els.messages.scrollTop = els.messages.scrollHeight;
  updateHistoryNotice();
}

// Recomputes
// from `conversation` + `lastHistoryKept` on every renderAll() (addMessage,
// init's first render, eraseConversation, a relaunch/retry replay) — always
// in sync, cheap enough (conversation is capped at MAX_PERSISTED_MESSAGES).
// Muted, never the error style — same family as .prompt-saved-notice.
export function updateHistoryNotice() {
  if (!els.historyNotice) return;
  const { totalExchanges, sentExchanges } = buildHistoryForWire(panelState.conversation);
  const state = historyAlertState({ totalExchanges, sentExchanges, historyKept: lastHistoryKept });
  if (state === "dropped") {
    els.historyNotice.textContent = t("panel_history_dropped");
    els.historyNotice.hidden = false;
  } else if (state === "long") {
    els.historyNotice.textContent = t("panel_history_long");
    els.historyNotice.hidden = false;
  } else {
    els.historyNotice.textContent = "";
    els.historyNotice.hidden = true;
  }
}

export function wasNearBottom() {
  const el = els.messages;
  return isNearBottom(el.scrollHeight, el.scrollTop, el.clientHeight);
}

/** What an answer's links are checked against (docs/DECISIONS.md T61): the
 * sources found so far in the conversation, the current page, and whether this
 * answer or an earlier one read the page or searched, and the page titles sent
 * with the questions (untrusted page data). */
function answerLinks(msg) {
  const conversation = panelState.conversation;
  const idx = conversation.indexOf(msg);
  const upTo = [...conversation.slice(0, idx === -1 ? conversation.length : idx), msg];
  const readUntrusted = readUntrustedIn(upTo);
  const urls = upTo.flatMap((m) => (m.sources ?? []).map((s) => s.url));
  const titles = upTo.map((m) => m.offeredTitle ?? "").join(" ");
  return { ctx: linkContext(urls, currentPageUrl, readUntrusted, titles), t };
}

export function renderMessage(msg, { append = false } = {}) {
  let node = document.getElementById(`msg-${msg.id}`);
  // Capture BEFORE mutating the DOM: appending/growing the node can itself
  // change scrollHeight, which would make the "near bottom" check below
  // always true if read after the fact.
  const shouldFollow = wasNearBottom();
  if (!node) {
    if (!append) return;
    node = document.createElement("div");
    node.id = `msg-${msg.id}`;
    els.messages.appendChild(node);
  }
  // "Reading the page…" (page-request.js) takes priority over the ordinary
  // progress stage while both could apply — it's a MORE specific thing
  // Coati is doing right now than "thinking"/"loading".
  const reading = msg.streaming && !!msg.pageReading;
  const waiting = !reading && msg.streaming && !msg.text && !!msg.progress;
  node.className = `message message--${msg.role}${msg.streaming ? " message--streaming" : ""}${waiting || reading ? " message--progress" : ""}`;

  if (msg.role === "notice") {
    // A calm line from Coati itself ("shared" model picked): plain text,
    // the model name never goes through the markdown renderer.
    node.replaceChildren(document.createTextNode(msg.text));
  } else if (msg.role === "user") {
    // The bubble's own background/padding live on an inner node so
    // "Relancer" (card.css) can sit below it, not inside it (plan-mes-
    // prompts-28-09.md, "under the bubble") — .message--user only aligns the
    // pair. User messages are never re-streamed, so building this once is
    // safe (no later renderMessage() call ever mutates one).
    node.replaceChildren();
    const bubble = document.createElement("div");
    bubble.className = "message-user-bubble";
    bubble.appendChild(renderMarkdown(document, msg.text));
    node.appendChild(bubble);
    node.appendChild(buildRelaunchButton(msg));
  } else {
    node.replaceChildren(renderMarkdown(document, msg.text, msg.role === "assistant" ? answerLinks(msg) : undefined));
    if (reading) {
      const line = document.createElement("p");
      line.className = "search-status-line message-page-reading";
      const r = msg.pageReading;
      line.textContent = r.searchQuery
        ? t("panel_search_status", [String(r.searchIndex), String(r.searchMax), r.searchQuery])
        : r.openCount
          ? t("panel_open_status", [String(r.openCount)])
          : t("panel_page_reading_status", [r.kTokens]);
      node.appendChild(line);
    }
    if (waiting) {
      node.appendChild(
        buildProgress(document, {
          stage: msg.progress,
          readsPage: msg.readsPage === true,
          t,
          iconSrc: "../illustrations/coati-sniff.webp",
          iconStillSrc: "../illustrations/coati-sniff-still.png",
          reducedMotion: window.matchMedia("(prefers-reduced-motion: reduce)").matches,
          startedAt: msg.progressStartedAt,
          now: Date.now(),
        }),
      );
    }
    // Only a YouTube-context assistant message carries a videoId (set in
    // summarize()) — an ordinary article summary that happens to contain
    // "[1:23]" has none, so its timestamps stay plain text (deliverable 4).
    if (msg.role === "assistant" && msg.videoId) linkifyTimestamps(node, msg.videoId);
    // Bug fix — THIS message's own snapshot (see its comment above),
    // never a shared "current" one: an older message keeps resolving its
    // own refs against the extraction it was actually answered from.
    if (msg.role === "assistant" && msg.elementsSnapshot && msg.elementsSnapshot.elements.length) {
      renderElementRefs(node, msg.elementsSnapshot);
    }
    if (msg.authRequired) node.appendChild(buildAuthRecoveryBlock(msg));
    if (msg.quotaExceeded) node.appendChild(buildQuotaRecoveryBlock(msg));
    if (msg.modelUnavailable) node.appendChild(buildModelUnavailableRecoveryBlock(msg));
    if (msg.providerOverloaded) node.appendChild(buildProviderOverloadRecoveryBlock(msg));
    if (msg.modelMissing) node.appendChild(buildModelMissingRecoveryBlock());
    // No retry payload survives a panel reload (pendingRetries is in-memory
    // only, same limitation as buildAuthRecoveryBlock() above) — in that case
    // the message text alone (already telling the user to try again) is the
    // fallback, rather than a button permanently stuck disabled.
    if (msg.rateLimited && pendingRetries.has(msg.id)) node.appendChild(buildRateLimitRecoveryBlock(msg));
    // Cut answer (model-stalled): the words stay, the reason follows, then
    // "Retry" — same bare retry block as rate-limited.
    if (msg.cutNotice) {
      const notice = document.createElement("p");
      notice.className = "message-cut-notice";
      notice.textContent = msg.cutNotice;
      node.appendChild(notice);
    }
    if (msg.modelStalled && pendingRetries.has(msg.id)) node.appendChild(buildRateLimitRecoveryBlock(msg));
    // docs/PROTOCOL.md "Page on demand", task brief point 5 — discreet, one
    // line, only on a finished metadata-path chat answer (buildPageMention(),
    // chat-stream.js's onDone, gates this to msg.pageOnDemand already).
    const confirming = msg.streaming ? pendingSearchQuery(msg.id) : undefined;
    if (confirming !== undefined) node.appendChild(buildSearchConfirmBlock(msg, confirming));
    if (msg.pageMention && !msg.streaming) {
      const mention = document.createElement("p");
      mention.className = "search-status-line message-page-mention";
      mention.textContent = msg.pageMention;
      node.appendChild(mention);
    }
    if (!msg.streaming) {
      if (msg.searchMention) node.appendChild(buildSearchMentionBlock(msg));
      if (msg.sources?.length) node.appendChild(buildSourcesBlock(msg.sources));
      if (msg.searchAccess) node.appendChild(buildSearchAccessBlock(msg));
      else if (msg.suggestSearch) node.appendChild(buildSearchButton(msg, msg.suggestSearch));
    }
    if (msg.slowTip && !msg.streaming) {
      node.appendChild(
        buildSlowTip(document, msg.slowTip, {
          t,
          canSwitch: currentConnState === "connected" && !!modelsReply,
          onSwitch: switchFromTip,
          onSpeedup: openOllamaSpeedup,
        }),
      );
    }
  }
  // Only follow the stream to the bottom if the user was already there
  // (or close enough) — a user scrolled up to read must not be yanked back
  // down by every incoming chunk (bug report, symptom 2).
  if (shouldFollow) els.messages.scrollTop = els.messages.scrollHeight;
}

/**
 * Walks a rendered message's text nodes and turns `[mm:ss]`/`[h:mm:ss]`
 * timestamps into clickable <button>s. Built as real DOM nodes
 * (createElement/textContent), never via string-concatenated HTML — the
 * text driving this is model output, and CLAUDE.md rule #3 says page/model
 * content is data, never markup, full stop.
 */
export function linkifyTimestamps(container, videoId) {
  const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT);
  const textNodes = [];
  let n;
  while ((n = walker.nextNode())) textNodes.push(n);

  for (const textNode of textNodes) {
    const tokens = parseTimestamps(textNode.data);
    if (tokens.length === 1 && tokens[0].type === "text") continue; // nothing to link

    const fragment = document.createDocumentFragment();
    for (const token of tokens) {
      if (token.type === "text") {
        fragment.appendChild(document.createTextNode(token.value));
        continue;
      }
      const button = document.createElement("button");
      button.type = "button";
      button.className = "timestamp-link";
      button.textContent = token.raw;
      button.title = t("panel_seek_timestamp_title");
      button.addEventListener("click", () => seekActiveVideoTab(videoId, token.seconds));
      fragment.appendChild(button);
    }
    textNode.parentNode.replaceChild(fragment, textNode);
  }
}

/**
 * Walks a
 * rendered message's text nodes and turns known `[[eN]]` tokens into
 * "Montrer : …" <button>s, same split as linkifyTimestamps() above. The
 * button's visible label always comes from `elements` (the extraction),
 * never from the model's surrounding text — see element-refs.js's own
 * header. No innerHTML anywhere (CLAUDE.md rule #3).
 *
 * `elementsSnapshot` is THIS message's own `{extractionId, elements}` (see
 * its field's comment on the assistant message object) — every button
 * built here captures its full click payload (resolveElementClick(),
 * element-refs.js) from THIS snapshot, at render time, into the closure.
 * Bug a shared "current" snapshot used to let a
 * SECOND question silently repoint an OLDER message's button at whatever
 * the new extraction's same ref number happened to mean.
 */
export function renderElementRefs(container, elementsSnapshot) {
  const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT);
  const textNodes = [];
  let n;
  while ((n = walker.nextNode())) textNodes.push(n);

  let firstButton = null;
  for (const textNode of textNodes) {
    const tokens = parseElementRefs(textNode.data, elementsSnapshot.elements);
    if (tokens.length === 1 && tokens[0].type === "text" && tokens[0].value === textNode.data) continue; // nothing changed

    const fragment = document.createDocumentFragment();
    for (const token of tokens) {
      if (token.type === "text") {
        fragment.appendChild(document.createTextNode(token.value));
        continue;
      }
      const button = document.createElement("button");
      button.type = "button";
      button.className = "element-point-button";
      button.textContent = t("panel_point_button", [token.label]);
      button.setAttribute("aria-pressed", "false");
      const clickPayload = resolveElementClick(elementsSnapshot, token.ref);
      button.addEventListener("click", () => onPointButtonClick(button, clickPayload));
      fragment.appendChild(button);
      if (!firstButton) {
        firstButton = button;
        fragment.appendChild(buildPointLevelSlider(button, clickPayload));
      }
    }
    textNode.parentNode.replaceChild(fragment, textNode);
  }
}
