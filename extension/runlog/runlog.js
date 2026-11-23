// Run-log page: asks the broker for the run of `?id=<chat id>` (run.get) and
// draws the reply. Same transport as prompts.js: coati:client-message out via
// the service worker, coati:broker-message back.

import { api } from "../lib/browser-compat.js";
import { applyI18n, reloadOnLanguageChange } from "../lib/i18n-page.js";
import { DEV_MODE_KEY, parseStoredDevMode } from "../lib/dev-mode-pref.js";
import { renderNote, renderRuns } from "./runlog-render.js";

applyI18n(document);

const REPLY_TIMEOUT_MS = 8000;
const chatIds = (new URLSearchParams(location.search).get("id") || "").split(",").filter(Boolean);
const els = {
  refresh: document.getElementById("refresh"),
  content: document.getElementById("content"),
};
const waiting = new Map();

function nextId() {
  return `rl-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function onRuntimeMessage(message) {
  if (message?.type !== "coati:broker-message") return;
  const reply = message.message;
  if (reply?.type !== "run") return;
  const resolve = waiting.get(reply.id);
  if (!resolve) return;
  waiting.delete(reply.id);
  resolve(reply);
}

function requestRun(chatId) {
  const id = nextId();
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      waiting.delete(id);
      resolve(null);
    }, REPLY_TIMEOUT_MS);
    waiting.set(id, (reply) => {
      clearTimeout(timer);
      resolve(reply);
    });
    api.runtime.sendMessage({ type: "coati:client-message", payload: { type: "run.get", id, target: chatId } }).catch(() => {
      clearTimeout(timer);
      waiting.delete(id);
      resolve(null);
    });
  });
}

async function load() {
  els.refresh.disabled = true;
  renderNote(document, els.content, "runlog_loading");
  const status = await api.runtime.sendMessage({ type: "coati:get-status" }).catch(() => null);
  if (status?.state !== "connected") {
    renderNote(document, els.content, "runlog_offline");
  } else if (!(status.features ?? []).includes("run-log")) {
    renderNote(document, els.content, "runlog_unsupported");
  } else {
    const replies = await Promise.all(chatIds.map(requestRun));
    if (replies.every((reply) => !reply)) renderNote(document, els.content, "runlog_offline");
    else renderRuns(document, els.content, replies.map((reply) => (reply?.found && reply.run ? reply.run : null)));
  }
  els.refresh.disabled = false;
}

async function applyDevMode() {
  const data = await api.storage.local.get(DEV_MODE_KEY).catch(() => ({}));
  document.documentElement.classList.toggle("mode-dev", parseStoredDevMode(data?.[DEV_MODE_KEY]));
}

api.runtime.onMessage.addListener(onRuntimeMessage);
els.refresh.addEventListener("click", load);
applyDevMode();
load();
reloadOnLanguageChange();
