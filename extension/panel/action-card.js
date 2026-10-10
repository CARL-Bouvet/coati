// Coati side panel — answers the broker's `action.request` (docs/PROTOCOL.md
// "Acting"): checks the target on the live page, shows a confirmation card
// with the element highlighted, performs the click or typing only on
// "Allow", then re-reads the page at text level. The user can also click the
// highlighted element himself: that counts as the action done (`by: "user"`).
// Page text on the card goes through textContent only.
import { t } from "../lib/i18n-page.js";
import { api } from "../lib/browser-compat.js";
import { checkOpen } from "../lib/open-guard.js";
import { panelState, newId } from "./panel-state.js";
import { renderMessage } from "./message-render.js";
import { armRequestDeadline, sendClientMessage } from "./request-watch.js";
import { extractFromTab } from "./page-extract.js";
import { stripReadability } from "./unreadable.js";
import { prepareContextForWire, resolveElementClick } from "./element-refs.js";
import { buildElementsSnapshot } from "./composer-send.js";
import { hasFeature } from "./model-status.js";
import { currentPageUrl } from "./page-detect.js";
import { currentTabId } from "./panel.js";
import { POINTER_FILES, pointAtElement, clearPointer } from "./point-at.js";
import { ALL_SITES_ORIGINS } from "./read-button.js";
import { refreshAllSitesGranted, refreshReadButton } from "./first-run-wiring.js";

const SETTLE_MS = 1500;
const NAVIGATION_MAX_MS = 15_000;
const CARD_WAIT_DEADLINE_MS = 310_000;
const REFUSAL_CODES = new Set(["sensitive-field", "not-editable", "form-submit", "forbidden-label", "link-target"]);

/** Requests waiting for the user, by chat id: `{ entry, request, finish }`. */
const pending = new Map();

/** Drops a waiting card when its chat ends (answer, error, cancel). */
export function dropActionCard(id) {
  const p = pending.get(id);
  if (!p) return;
  pending.delete(id);
  p.finish({ kind: "dropped" });
  clearPointer(currentTabId);
  const msg = panelState.conversation.find((m) => m.id === id);
  if (msg?.actionCard?.state === "asking") {
    msg.actionCard = undefined;
    renderMessage(msg);
  }
}

async function report(id, result) {
  await sendClientMessage({ type: "action.result", id: newId(), target: id, ...result });
}

function setCard(msg, card) {
  if (!msg) return;
  msg.actionCard = card;
  msg.pageReading = undefined;
  renderMessage(msg);
}

async function runOnTab(tabId, entry, action, text) {
  await api.scripting.executeScript({ target: { tabId }, files: POINTER_FILES });
  const results = await api.scripting.executeScript({
    target: { tabId },
    func: (opts) => (typeof globalThis.__coatiAct === "function" ? globalThis.__coatiAct(opts) : { status: "stale" }),
    args: [{ ...entry, action, text }],
  });
  return results?.[0]?.result ?? { status: "stale" };
}

/** Resolves once the tab has navigated and loaded, or after SETTLE_MS without a navigation. */
function waitStable(tabId) {
  return new Promise((resolve) => {
    let navigating = false;
    const finish = () => {
      clearTimeout(settleTimer);
      clearTimeout(maxTimer);
      api.tabs.onUpdated.removeListener(listener);
      resolve();
    };
    const listener = (id, info) => {
      if (id !== tabId) return;
      if (info.status === "loading") navigating = true;
      if (info.status === "complete" && navigating) finish();
    };
    api.tabs.onUpdated.addListener(listener);
    // A click by the user may have started the navigation already.
    api.tabs
      .get(tabId)
      .then((tab) => {
        if (tab.status === "loading") navigating = true;
      })
      .catch(() => {});
    const settleTimer = setTimeout(() => {
      if (!navigating) finish();
    }, SETTLE_MS);
    const maxTimer = setTimeout(finish, NAVIGATION_MAX_MS);
  });
}

/** Re-reads the page at text level and swaps the message's element list for the new one. */
async function rereadPage(msg, tabId) {
  const context = stripReadability(await extractFromTab(tabId));
  if (msg) msg.elementsSnapshot = buildElementsSnapshot(context);
  return prepareContextForWire(context, hasFeature("elements"));
}

/** After a gesture was made (by Coati or by the user): wait, re-read, answer the broker. */
async function finishDone(id, msg, tabId, settled, by) {
  await settled;
  try {
    const context = await rereadPage(msg, tabId);
    await report(id, { status: "done", by, context });
  } catch {
    setCard(msg, { state: "access" });
    await report(id, { status: "no-access", reason: "page unreadable after the action" });
  }
}

export async function onActionRequest(message) {
  const { id, action, ref, text, discard } = message;
  const msg = panelState.conversation.find((m) => m.id === id);
  if (discard && msg) {
    msg.text = "";
    renderMessage(msg);
  }
  const tabId = currentTabId;
  const entry = resolveElementClick(msg?.elementsSnapshot, ref);
  if (!entry || tabId == null) {
    await report(id, { status: "stale" });
    return;
  }

  let check;
  try {
    check = await runOnTab(tabId, entry, "check");
  } catch {
    setCard(msg, { state: "access" });
    await report(id, { status: "no-access" });
    return;
  }
  if (check.status === "ok" && check.href) {
    const level = panelState.devModePreference ? "dev" : "text";
    if (checkOpen(currentPageUrl, check.href, level).verdict === "blocked") {
      check = { status: "blocked", reason: "link-target" };
    }
  }
  if (check.status === "stale") {
    await report(id, { status: "stale" });
    return;
  }
  if (check.status === "blocked") {
    setCard(msg, { state: "refused", reason: check.reason });
    await report(id, { status: "blocked", reason: check.reason });
    return;
  }

  // Confirmation card. The highlight also reports the user's own click on the element.
  setCard(msg, { state: "asking", action, label: entry.label, text });
  armRequestDeadline(id, CARD_WAIT_DEADLINE_MS);
  pointAtElement(tabId, entry, true);

  const answer = await new Promise((resolve) => pending.set(id, { entry, finish: resolve }));
  if (!pending.delete(id)) return;
  await clearPointer(tabId);
  if (answer.kind === "refuse") {
    setCard(msg, undefined);
    await report(id, { status: "refused", reason: "the user declined" });
    return;
  }

  const settled = waitStable(tabId);
  if (answer.kind === "allow") {
    let result;
    try {
      result = await runOnTab(tabId, entry, action, text);
    } catch {
      result = { status: "stale" };
    }
    setCard(msg, undefined);
    if (result.status !== "done") {
      await report(id, result.status === "blocked" ? { status: "blocked", reason: result.reason } : { status: "stale" });
      return;
    }
    await finishDone(id, msg, tabId, settled, undefined);
    return;
  }
  setCard(msg, undefined);
  await finishDone(id, msg, tabId, settled, "user");
}

/** The user clicked the highlighted element himself (content script message). */
export function onUserClicked(message) {
  for (const [, p] of pending) {
    if (p.entry.ref === message.ref && p.entry.extractionId === message.extractionId) {
      p.finish({ kind: "user" });
      return;
    }
  }
}

function resolveCard(msg, kind) {
  pending.get(msg.id)?.finish({ kind });
}

function line(className, text) {
  const p = document.createElement("p");
  p.className = className;
  p.textContent = text;
  return p;
}

function button(className, text, onClick) {
  const b = document.createElement("button");
  b.type = "button";
  b.className = `toolbar-button ${className}`;
  b.textContent = text;
  b.addEventListener("click", onClick);
  return b;
}

/** The card shown under an assistant message, from `msg.actionCard`. */
export function buildActionCard(msg) {
  const card = msg.actionCard;
  const wrap = document.createElement("div");
  wrap.className = `action-card action-card--${card.state}`;
  if (card.state === "asking") {
    const title =
      card.action === "type"
        ? t("panel_action_type", [card.text ?? "", card.label])
        : t("panel_action_click", [card.label]);
    wrap.appendChild(line("action-card-title", title));
    wrap.appendChild(line("search-status-line action-card-hint", t("panel_action_hint")));
    const buttons = document.createElement("div");
    buttons.className = "action-card-buttons";
    buttons.appendChild(button("toolbar-button--primary action-card-allow", t("panel_action_allow"), () => resolveCard(msg, "allow")));
    buttons.appendChild(button("action-card-refuse", t("panel_action_refuse"), () => resolveCard(msg, "refuse")));
    wrap.appendChild(buttons);
  } else if (card.state === "refused") {
    wrap.appendChild(line("action-card-title", t(`panel_action_refused_${REFUSAL_CODES.has(card.reason) ? card.reason.replaceAll("-", "_") : "other"}`)));
  } else {
    wrap.appendChild(line("action-card-title", t("panel_action_needs_access")));
    wrap.appendChild(
      button("action-card-access", t("panel_search_allow"), async () => {
        const granted = await api.permissions.request({ origins: ALL_SITES_ORIGINS }).catch(() => false);
        if (!granted) return;
        msg.actionCard = undefined;
        renderMessage(msg);
        await refreshAllSitesGranted();
        await refreshReadButton();
      }),
    );
  }
  return wrap;
}
