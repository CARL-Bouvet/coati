// Coati side panel — connection/provider/model status, lot F3 split of
// panel.js. Pill + menu next to "Connected", connection banner,
// provider.status round trip, Ollama warm-up/slow-model advice, and the
// handleBrokerMessage sub-handlers that belong to this state
// (model.warmup-result/settings/models/provider.status-result, plus
// interceptOwnError() for the "error" case's own request ids).
import { t } from "../lib/i18n-page.js";
import { api } from "../lib/browser-compat.js";
import { els } from "./dom-refs.js";
import { panelState, newId } from "./panel-state.js";
import { providerLabel, CONNECTION_STATUS_LABELS } from "../lib/labels.js";
import {
  groupModels,
  isCurrentLocal,
  moduleLabelsFrom,
  renderModelList,
  renderStaleBrokerMenu,
  isSlowLocalModel,
  sameModel,
  shortModelName,
} from "../lib/model-list.js";
import { isSlowFirstWord, slowTipFor, sharedModelNoticeText, OLLAMA_SPEEDUP_PATH } from "./model-advice.js";
import { getProviderLinks } from "../lib/setup-data.js";
import { setStreamingUi } from "./request-watch.js";
import { addMessage } from "./message-render.js";
import { persistConversation } from "./conversation-store.js";
import { renderFirstRun, renderNeverConnected, openModelTutorial } from "./first-run-wiring.js";
import { updateDevModeUi } from "./dev-mode.js";

// Lot A2 (plan-montrer-voir-chercher-08-10.md §3A) — "Montrer du doigt".
// Mirrors the latest `hello-ok.features` relayed by service-worker.js on its
// "coati:status" broadcast; an old broker that predates the amendment never
// sets it, so this stays `[]` and `context.elements` is simply never sent
// (§2: "Absent = aucune"). Reset to `[]` whenever the connection drops — a
// feature negotiated on a PREVIOUS connection must not survive past a
// reconnect to a possibly older broker.
let brokerFeatures = [];
export function hasFeature(name) {
  return brokerFeatures.includes(name);
}

// Current connection state, kept so a later provider.status-result (which
// arrives asynchronously) can be folded into the status line without
// recomputing/duplicating the connection label above it.
export let currentConnState = "unknown";
// Short factual French text from the last provider.status-result, or "" when
// there is nothing to add (state "ok", or no check done yet this panel
// session) — see maybeRequestProviderStatus()/renderStatusLabel() below.
let providerStatusSuffix = "";
// Amendement 2026-10-07 bis: true when the last provider.status-result's
// `reason` is "model-missing" — the one case the status text also doubles
// as a button opening the model menu (see renderStatusLabel()).
let providerStatusActionable = false;

/** `brokerFeatures` (hello-ok.features, A2/B3/C2) from ANY status source —
 * the "coati:status" broadcast (handleBrokerMessage's hello-ok branch in
 * service-worker.js) or a direct "coati:panel-ready"/"coati:get-status"
 * response (retryConnection() below). Bug fix (lot F review, 08/10): a
 * panel opened AFTER the connection already settled only ever saw the
 * broadcast path before this — never connected (or an older broker) means
 * [], exactly as if freshly disconnected, never "trust the last known
 * list". */
export function applyBrokerFeatures(state, features) {
  brokerFeatures = state === "connected" && Array.isArray(features) ? features.filter((f) => typeof f === "string") : [];
  updateDevModeUi();
}

/** Same "are you there?" message the panel already sends once at startup
 * (connectIfNeeded() on the service-worker side) — reused as the "Retry"
 * action on the connection banner (program not found / not responding) so
 * the user doesn't have to close and reopen the panel to re-check. */
export async function retryConnection() {
  const status = await api.runtime.sendMessage({ type: "coati:panel-ready" }).catch(() => null);
  applyStatus(status?.state ?? "unknown");
  applyBrokerFeatures(status?.state ?? "unknown", status?.features);
}

export function applyStatus(state) {
  // A dropped connection must not leave the panel permanently locked: any
  // in-flight request will never get its "done"/"error" reply now.
  if ((state === "disconnected" || state === "no-token" || state === "pairing-retry") && panelState.activeRequestId) {
    setStreamingUi(false);
  }

  currentConnState = state;
  if (state !== "connected") providerStatusSuffix = ""; // stale once disconnected
  els.status.className = `status status--${state}`;
  renderStatusLabel();
  applyConnectionBanner(state);
  if (state === "connected") {
    maybeRequestProviderStatus();
    if (!modelsReply && !modelsRequestId) {
      requestModels();
      // Read-only: the human names of modules (e.g. claude-cli) for the
      // menu's online entries live only in `settings.available`.
      api.runtime.sendMessage({ type: "coati:client-message", payload: { type: "settings.get", id: newId() } });
    }
  } else {
    closeModelMenu(false);
    els.modelPicker.hidden = true;
    modelsReply = null;
    // A restarted local program (or Ollama) starts cold: warm up again.
    warmedModel = null;
    warmupRequestId = null;
  }
  renderFirstRun();
}

export function renderStatusLabel() {
  const labels = {
    ...CONNECTION_STATUS_LABELS,
    "no-token": t("panel_status_no_token"),
    "pairing-retry": t("panel_status_pairing_retry"),
  };
  let text = labels[currentConnState] ?? currentConnState;
  if (currentConnState === "connected" && providerStatusSuffix) text += ` · ${providerStatusSuffix}`;
  els.statusLabel.textContent = text;
  // Amendement 2026-10-07 bis: a model-missing problem (the only
  // providerStatusSuffix case with an actual fix) also makes the status
  // text clickable, opening the same model menu as the pill.
  const actionable = currentConnState === "connected" && providerStatusActionable && !!providerStatusSuffix;
  els.statusLabel.classList.toggle("status-label--action", actionable);
  if (actionable) {
    els.statusLabel.setAttribute("role", "button");
    els.statusLabel.tabIndex = 0;
    els.statusLabel.setAttribute("aria-label", `${text} — ${t("panel_status_action_hint")}`);
  } else {
    els.statusLabel.removeAttribute("role");
    els.statusLabel.tabIndex = -1;
    els.statusLabel.removeAttribute("aria-label");
  }
}

// Five connection-level states share this one banner (deliverable G4,
// docs/PROTOCOL.md amendement 2026-09-30, "États et bandeaux" and
// amendement 2026-10-02, "pairing-retry"):
// - "no-host": can't reach the local program — fix: install, or manual pair.
// - "pairing-retry": the program refused; automatic spaced retries in progress.
// - "broker-untrusted" / "no-token": terminal refusal — Retry button.
// - "disconnected": program presumably installed but not running — Retry.
export function applyConnectionBanner(state) {
  els.installDocLink.hidden = true;
  els.connectCoati.hidden = true;
  els.connectionBannerRetry.hidden = true;

  if (state === "no-host") {
    // "Program missing": offer both the install page and an immediate retry
    // (it may just have finished installing/starting while this was shown).
    els.connectionBannerText.textContent = t("panel_banner_no_host");
    els.installDocLink.hidden = false;
    els.connectionBannerRetry.hidden = false;
    els.connectCoati.hidden = false;
    els.connectionBanner.hidden = false;
    return;
  }
  if (state === "pairing-retry") {
    // Automatic spaced retry in progress — inform but don't offer a manual
    // retry button (it would duplicate or race the scheduled attempt).
    els.connectionBannerText.textContent = t("panel_banner_pairing_retry");
    els.connectionBanner.hidden = false;
    return;
  }
  if (state === "broker-untrusted" || state === "no-token") {
    // Terminal refusal after all retries, each with a key freshly read from
    // the native host. "no-token" (4401): do NOT claim a specific cause
    // (anti-oracle: the broker sends the same 4401 for every rejection
    // reason — docs/PROTOCOL.md "Handshake failure: one generic message").
    // "broker-untrusted" (4000): the EXTENSION itself rejected the broker's
    // proof even with a fresh key — that is a real signal (something else
    // answers on the port), so it keeps its own warning.
    // Both offer a manual Retry.
    els.connectionBannerText.textContent = t(
      state === "broker-untrusted" ? "panel_banner_broker_untrusted" : "panel_banner_pairing_refused",
    );
    els.connectionBannerRetry.hidden = false;
    els.connectionBanner.hidden = false;
    return;
  }
  if (state === "disconnected") {
    // "Program not responding": it is presumably installed already, just
    // not running right now — only a retry, no install link.
    els.connectionBannerText.textContent = t("panel_banner_disconnected");
    els.connectionBannerRetry.hidden = false;
    els.connectionBanner.hidden = false;
    return;
  }
  els.connectionBanner.hidden = true;
}

// --- Provider availability (docs/PROTOCOL.md "provider.status") ------------
//
// Sent once per panel open, on a user gesture (opening the panel), the first
// time this panel reaches "connected" — never from the service worker, never
// on a timer. One exception (T51): while the first-launch card still shows
// "model" missing, the panel regaining focus (the user coming back from the
// settings tab) asks again, at most every PROVIDER_RECHECK_MIN_MS.

let providerStatusRequested = false;
let providerStatusRequestId = null;
// Last provider.status-result `state` ("ok" | "ko" | "unknown"), null = none yet.
export let providerState = null;
// Last provider.status-result `reason` (docs/PROTOCOL.md "Provider
// availability"), null = none yet — read by first-run-wiring.js's Ollama copy command.
export let lastProviderReason = null;
let providerRecheckAt = 0;
const PROVIDER_RECHECK_MIN_MS = 10_000;

function maybeRequestProviderStatus() {
  if (providerStatusRequested) return;
  providerStatusRequested = true;
  sendProviderStatus();
}

export function maybeRecheckProviderForFirstRun() {
  if (els.firstRun.hidden || currentConnState !== "connected" || providerState === "ok" || panelState.modelAnswered) return;
  if (providerStatusRequestId || Date.now() - providerRecheckAt < PROVIDER_RECHECK_MIN_MS) return;
  providerRecheckAt = Date.now();
  sendProviderStatus();
}

function sendProviderStatus() {
  const id = newId();
  providerStatusRequestId = id;
  api.runtime.sendMessage({
    type: "coati:client-message",
    payload: { type: "provider.status", id },
  });
}

// Reason codes are a closed, stable, English list read by this code only
// (docs/PROTOCOL.md "Provider availability") — never shown as-is.
// `state: "ok"` is shown too: the point of the check is that the user sees,
// before any click, whether the model will answer (goal 2026-09-25, Q5).
// Provider display names come from lib/labels.js — the single shared table
// with options.js (bug report gap 4: names must match everywhere).

const PROVIDER_STATUS_REASON_TEXT = {
  "ready": t("panel_provider_ready"),
  "logged-in": t("panel_provider_logged_in"),
  "no-key": t("panel_provider_no_key"),
  "key-unverified": t("panel_provider_key_unverified"),
  "cli-missing": t("panel_provider_cli_missing"),
  "not-logged-in": t("panel_provider_not_logged_in"),
  "probe-failed": t("panel_provider_probe_failed"),
  "ollama-unreachable": t("panel_provider_ollama_unreachable"),
  "model-missing": t("panel_provider_model_missing"),
  "no-model-installed": t("panel_provider_no_model_installed"),
  "key-rejected": t("panel_provider_key_rejected"),
};

function formatProviderStatus(message) {
  // Amendment 2026-10-07 bis: when the provider is ready, the pill next to
  // "Connected" already names the model — nothing left to add here. A
  // suffix is shown only for a real problem (anything but "ok").
  if (message.state === "ok") return "";
  const label = providerLabel(message.provider, t("panel_provider_default_label"));
  const reasonText = PROVIDER_STATUS_REASON_TEXT[message.reason] ?? t("panel_provider_unknown_state");
  return t("panel_provider_status_line", [label, reasonText]);
}

// --- Active model: pill + menu (amendment 2026-10-07, models.list) ----------
//
// The pill next to "Connected" names the model that will answer, before any
// question. Asked when the panel reaches "connected" (opening the panel),
// again whenever a `settings` message reports another provider/model (a
// switch made here, in the settings page or in the tutorial), and when the
// panel regains focus — at most every MODELS_REFRESH_MIN_MS. Never on a
// timer. One click in the menu = settings.set {provider, model}, applied to
// all of Coati (the local program's config), no reload.

let modelsRequestId = null;
export let modelsReply = null;
let modelsRequestedAt = 0;
let modelSwitchRequestId = null;
let modelMenuItems = [];
// Amendement 2026-10-07 bis: true once an older local program has answered
// `error` to models.list — the pill then shows a calm "update the local
// program" state (renderStaleBrokerPill()) instead of hiding.
let modelsUnsupported = false;
// Best-known {provider, model} from the last `settings` message, kept even
// when models.list isn't supported — the only way renderStaleBrokerPill()
// can still name the current model in that case.
let lastSettingsModel = null;
// Module labels from the last `settings` (moduleLabelsFrom), for the menu.
let modelProviderLabels = {};
const MODELS_REFRESH_MIN_MS = 10_000;

// --- Ollama: warm-up and slow-model advice (plan-ollama-rapide-07-10.md) ---
//
// Warm-up (point 1): once the panel knows the current model is Ollama, ask
// the local program to load it (model.warmup) — once per model per
// connection, again after a switch to another Ollama model. Nothing on
// screen, nothing waits on it; an older local program answers `error`,
// swallowed in handleBrokerMessage().
let warmupRequestId = null;
let warmedModel = null;
// id -> {at, entry}: when each request left and which model answers it.
export const requestStarts = new Map();
// Models whose "doesn't fully fit…" line was already shown during
// this panel session (point 3: never twice for the same model).
const sharedNoticeShown = new Set();

/** The `models` entry of the current model, or a bare {provider, model}
 * when the list doesn't hold it (older local program, no reply yet). */
export function currentModelEntry() {
  if (!modelsReply) return currentProvider ? { provider: currentProvider } : null;
  const grouped = groupModels(modelsReply);
  return grouped.currentEntry ?? (grouped.current.provider ? grouped.current : null);
}

export function currentGroupedModels() {
  return groupModels(modelsReply);
}

export function maybeWarmup() {
  if (currentConnState !== "connected" || !modelsReply) return;
  const { current } = groupModels(modelsReply);
  if (current.provider !== "ollama" || !current.model) return;
  if (warmedModel && sameModel(warmedModel, current.model)) return;
  warmedModel = current.model;
  warmupRequestId = newId();
  api.runtime
    .sendMessage({ type: "coati:client-message", payload: { type: "model.warmup", id: warmupRequestId } })
    .catch(() => {});
}

/** First word of an answer: the waiting line goes, and a late one on a
 * model that doesn't fit the card earns the tip (point 6). */
export function onFirstWord(msg) {
  msg.progress = undefined;
  const start = requestStarts.get(msg.id);
  if (msg.role !== "assistant" || !start || msg.slowTip) return;
  if (isSlowFirstWord(Date.now() - start.at, start.entry)) {
    msg.slowTip = slowTipFor(start.entry, currentGroupedModels()) ?? undefined;
  }
}

/** Point 3: picking a model that doesn't fit the card switches anyway,
 * with one calm line in the conversation — once per model per session. */
export function maybeShowSharedNotice(entry) {
  if (!isSlowLocalModel(entry)) return;
  const key = `${entry.provider}\n${shortModelName(entry.model)}`;
  if (sharedNoticeShown.has(key)) return;
  sharedNoticeShown.add(key);
  addMessage({ id: newId(), role: "notice", text: sharedModelNoticeText(entry, currentGroupedModels(), t) });
  persistConversation();
}

/** "Switch to …" under a slow answer: same path as a pick in the menu. */
export function switchFromTip(model) {
  if (!modelsReply) return;
  const known = modelsReply.current ?? {};
  if (known.provider === "ollama" && sameModel(known.model, model)) return;
  pickModel({ provider: "ollama", model, current: false });
}

export function openOllamaSpeedup() {
  api.tabs.create({ url: api.runtime.getURL(OLLAMA_SPEEDUP_PATH) });
}

export function requestModels() {
  if (currentConnState !== "connected") return;
  const id = newId();
  modelsRequestId = id;
  modelsRequestedAt = Date.now();
  api.runtime.sendMessage({ type: "coati:client-message", payload: { type: "models.list", id } });
}

export function maybeRefreshModels() {
  if (currentConnState !== "connected" || modelsRequestId) return;
  if (Date.now() - modelsRequestedAt < MODELS_REFRESH_MIN_MS) return;
  requestModels();
}

/** The status suffix ("Ollama (local): ready") named the previous provider, and
 * the list's checkmark the previous model: ask both again. */
function afterModelChange() {
  requestModels();
  if (!providerStatusRequestId) sendProviderStatus();
}

/** A `settings` broadcast this panel didn't ask for (settings page,
 * tutorial): follow it only when it names another provider/model. */
function onSettingsOverheard(message) {
  if (!modelsReply || typeof message.provider !== "string") return;
  const model = typeof message.model === "string" && message.model ? message.model : null;
  const known = modelsReply.current ?? {};
  if (known.provider === message.provider && (known.model === model || sameModel(known.model, model))) return;
  modelsReply = { ...modelsReply, current: { provider: message.provider, model } };
  renderModelPicker();
  afterModelChange();
}

/** Older local program, no models.list (amendement 2026-10-07 bis): the pill
 * stays visible, naming the current model when `lastSettingsModel` (from a
 * `settings` reply) gives one, with a calm "update the local program" label
 * otherwise. The menu explains why and offers "Open settings". */
export function renderStaleBrokerPill() {
  const model = lastSettingsModel?.model ?? null;
  const staleLabel = t("model_pill_stale_broker");
  // Bug report (320 px): the "where" suffix (normally one short word, "local"
  // / "en ligne") never shrinks (`flex: none`, no overflow handling) — it
  // isn't built to carry this longer label. Everything goes in the name
  // instead, which the CSS lets wrap onto a second line for this state
  // (`.model-pill[data-where="stale"] .model-pill-name`) so the pill GROWS
  // rather than clipping or overflowing past its own border.
  els.modelPillName.textContent = model ? `${shortModelName(model)} · ${staleLabel}` : staleLabel;
  els.modelPillWhere.textContent = "";
  els.modelPillWhere.hidden = true;
  els.modelPill.dataset.where = "stale";
  els.modelPill.title = model ?? "";
  els.modelPill.setAttribute("aria-label", t("model_pill_stale_broker_label"));

  modelMenuItems = renderStaleBrokerMenu(els.modelMenu, {
    t,
    onOpenSettings: () => {
      closeModelMenu(false);
      api.runtime.openOptionsPage();
    },
  });
  els.modelPicker.hidden = false;
}

export function renderModelPicker() {
  updateDevModeUi();
  if (currentConnState !== "connected" || (!modelsReply && !modelsUnsupported)) {
    els.modelPicker.hidden = true;
    return;
  }
  if (modelsUnsupported) {
    renderStaleBrokerPill();
    return;
  }
  const grouped = groupModels(modelsReply);
  const model = grouped.current.model;
  const where = model ? t(isCurrentLocal(grouped) ? "model_pill_local" : "model_pill_online") : "";
  els.modelPillName.textContent = model ? shortModelName(model) : t("model_pill_none");
  els.modelPillWhere.textContent = where;
  els.modelPillWhere.hidden = !where;
  els.modelPill.dataset.where = model ? (isCurrentLocal(grouped) ? "local" : "online") : "none";
  els.modelPill.title = model ?? "";
  if (model) els.modelPill.setAttribute("aria-label", t("model_pill_label", [model, where]));
  else els.modelPill.removeAttribute("aria-label");

  // Re-rendered while open (a fresh reply): keep focus on the same item.
  const focused = els.modelMenu.contains(document.activeElement) ? document.activeElement : null;
  const focusedKey = focused ? `${focused.dataset.provider}\n${focused.dataset.model}\n${focused.className}` : null;
  modelMenuItems = renderModelList(els.modelMenu, modelsReply, {
    t,
    providerLabel,
    moduleLabels: modelProviderLabels,
    baseUrl: currentProviderBaseUrl,
    mode: "menu",
    idPrefix: "modelMenu",
    onPick: pickModel,
    onAdd: () => {
      closeModelMenu(false);
      openModelTutorial();
    },
  });
  if (focusedKey) {
    const same = modelMenuItems.find(
      (item) => `${item.dataset.provider}\n${item.dataset.model}\n${item.className}` === focusedKey,
    );
    (same ?? modelMenuItems[0])?.focus();
  }
  els.modelPicker.hidden = false;
}

export function pickModel(entry) {
  closeModelMenu(true);
  if (entry.current) return;
  const id = newId();
  modelSwitchRequestId = id;
  // Immediate: the pill and the checkmark follow the click; the local
  // program's `settings` reply then triggers afterModelChange().
  modelsReply = { ...modelsReply, current: { provider: entry.provider, model: entry.model } };
  renderModelPicker();
  api.runtime.sendMessage({
    type: "coati:client-message",
    payload: { type: "settings.set", id, provider: entry.provider, model: entry.model },
  });
  maybeShowSharedNotice(entry);
}

export function openModelMenu(which = "current") {
  if (modelMenuItems.length === 0) return;
  els.modelMenu.hidden = false;
  els.modelPill.setAttribute("aria-expanded", "true");
  const target =
    which === "last"
      ? modelMenuItems[modelMenuItems.length - 1]
      : (els.modelMenu.querySelector('[aria-checked="true"]') ?? modelMenuItems[0]);
  target?.focus();
  document.addEventListener("click", onModelMenuOutsideClick, true);
}

export function closeModelMenu(refocus) {
  if (els.modelMenu.hidden) return;
  els.modelMenu.hidden = true;
  els.modelPill.setAttribute("aria-expanded", "false");
  document.removeEventListener("click", onModelMenuOutsideClick, true);
  if (refocus) els.modelPill.focus();
}

function onModelMenuOutsideClick(event) {
  if (!els.modelPicker.contains(event.target)) closeModelMenu(false);
}

/** The status text next to the dot is a button only while
 * `.status-label--action` is set (renderStatusLabel()) — a model-missing
 * problem, the one providerStatusSuffix case with an actual fix. */
export function wireStatusLabel() {
  const isActionable = () => els.statusLabel.classList.contains("status-label--action");
  els.statusLabel.addEventListener("click", () => {
    if (isActionable()) openModelMenu();
  });
  els.statusLabel.addEventListener("keydown", (event) => {
    if (!isActionable()) return;
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      openModelMenu();
    }
  });
}

export function wireModelPicker() {
  els.modelPill.addEventListener("click", () => {
    if (els.modelMenu.hidden) openModelMenu();
    else closeModelMenu(false);
  });
  els.modelPill.addEventListener("keydown", (event) => {
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      openModelMenu(event.key === "ArrowUp" ? "last" : "current");
    }
  });
  els.modelMenu.addEventListener("keydown", (event) => {
    const items = modelMenuItems;
    const index = items.indexOf(document.activeElement);
    let next = null;
    if (event.key === "Escape") {
      event.preventDefault();
      closeModelMenu(true);
      return;
    }
    if (event.key === "Tab") {
      closeModelMenu(false);
      return;
    }
    if (event.key === "ArrowDown") next = items[(index + 1) % items.length];
    else if (event.key === "ArrowUp") next = items[(index - 1 + items.length) % items.length];
    else if (event.key === "Home") next = items[0];
    else if (event.key === "End") next = items[items.length - 1];
    if (next) {
      event.preventDefault();
      next.focus();
    }
  });
}
export const SESSION_AUTH_PROVIDERS = new Set(["claude-cli"]);
// Provider id from the last provider.status-result, null until one arrives.
export let currentProvider = null;
// openai-compat's configured address, from the broker's own `settings`
// message (docs/PROTOCOL.md) — broadcast to every extension page whenever
// the options page requests it, see handleBrokerMessage()'s "settings" case
// below. undefined until one arrives, or for any other provider (the field
// is only ever sent "if the active provider is openai-compat"). Needed
// because getProviderLinks() can't tell OpenRouter/Mistral/DeepSeek apart
// from the broker id alone — they all answer as "openai-compat".
let currentProviderBaseUrl;

/** {keysUrl, billingUrl, name} for the current provider, or undefined when
 * unknown/unrecognised — every caller below falls back to generic wording. */
export function currentProviderLinks() {
  return currentProvider ? getProviderLinks(currentProvider, currentProviderBaseUrl) : undefined;
}

/** Opens the options page scrolled to `providerId`'s own card, which also
 * auto-runs its FREE settings.test (options.js's applyProviderHash()) — the
 * provider-aware equivalent of openModelTutorial() for every error that
 * names a specific provider (amendement 2026-10-02, goal-j2FJ-kI7). Falls
 * back to the generic tutorial when the provider isn't known yet (no
 * provider.status-result received this session). */
export function openProviderSettings(providerId) {
  if (!providerId) return openModelTutorial();
  api.tabs.create({ url: api.runtime.getURL(`options.html#provider-${providerId}`) });
}

// --- handleBrokerMessage sub-handlers (lot F3 dispatch) --------------------
//
// interceptOwnError() reproduces the "error" case's first four guard blocks
// from the original switch (model.warmup/models.list/provider.status/
// settings.set own request ids) — same checks, same order. The
// modelSwitchRequestId block does NOT `break` in the original (it falls
// through to the generic error text), so this returns `false` after it
// (not `true`) and chat-stream.js's onError() continues to
// describeBrokerError() for that one case; every other case returns `true`
// (nothing else to show for it).
export function interceptOwnError(message) {
  // docs/PROTOCOL.md "Provider availability": an older broker that
  // doesn't know provider.status answers some generic error for this id
  // instead of provider.status-result — show nothing for it, per spec.
  if (message.id === providerStatusRequestId) {
    providerStatusRequestId = null;
    return true;
  }
  // Older local program without model.warmup, or a failed warm-up: the next
  // question loads the model as before — never shown.
  if (message.id === warmupRequestId) {
    warmupRequestId = null;
    return true;
  }
  // Same for an older local program that doesn't know models.list
  // (amendement 2026-10-07 bis): the pill STAYS, in a calm "update the local
  // program" state (renderModelPicker()), instead of hiding.
  if (message.id === modelsRequestId) {
    modelsRequestId = null;
    if (!modelsReply) {
      modelsUnsupported = true;
      renderModelPicker();
    }
    return true;
  }
  if (message.id === modelSwitchRequestId) {
    modelSwitchRequestId = null;
    requestModels();
    return false;
  }
  return false;
}

export function onModelWarmupResult(message) {
  if (message.id === warmupRequestId) warmupRequestId = null; // nothing to show, whatever the state
}

// docs/PROTOCOL.md "settings" — a response to the options page's own
// request, broadcast here like every other broker message (U2); this panel
// never asks for it itself, but opportunistically keeps the openai-compat
// baseUrl when it overhears one, for currentProviderLinks() above
// (amendement 2026-10-02, goal-j2FJ-kI7). No secret in this message
// (docs/PROTOCOL.md: "never a secret").
export function onSettingsMessage(message) {
  currentProviderBaseUrl = typeof message.baseUrl === "string" ? message.baseUrl : undefined;
  if (Array.isArray(message.available)) modelProviderLabels = moduleLabelsFrom(message);
  // Amendement 2026-10-07 bis: kept even when models.list itself isn't
  // supported (older local program) — the only way that case can still name
  // the current model in the pill (bug report, part 1).
  if (typeof message.provider === "string") {
    lastSettingsModel = {
      provider: message.provider,
      model: typeof message.model === "string" && message.model ? message.model : null,
    };
  }
  if (modelsReply || modelsUnsupported) renderModelPicker();
  if (message.id && message.id === modelSwitchRequestId) {
    modelSwitchRequestId = null;
    afterModelChange();
  } else {
    onSettingsOverheard(message);
  }
}

export function onModelsMessage(message) {
  if (message.id !== modelsRequestId) return; // another page's request
  modelsRequestId = null;
  modelsUnsupported = false;
  // Amendement 2026-10-07 bis: a fresh `current` naming another
  // provider/model than what this panel still had (changed from elsewhere
  // between two refreshes) means the status suffix next to "Connected" may
  // be stale too — re-check it.
  const prevCurrent = modelsReply?.current;
  modelsReply = message;
  renderModelPicker();
  // After a switch too: the `models` reply that follows names the new one.
  maybeWarmup();
  const nowCurrent = message.current ?? {};
  const sameCurrent =
    prevCurrent &&
    prevCurrent.provider === nowCurrent.provider &&
    (prevCurrent.model === nowCurrent.model || sameModel(prevCurrent.model, nowCurrent.model));
  if (prevCurrent && !sameCurrent && !providerStatusRequestId) sendProviderStatus();
}

export function onProviderStatusResult(message) {
  if (message.id !== providerStatusRequestId) return; // stale/unrelated — ignore
  providerStatusRequestId = null;
  providerStatusSuffix = formatProviderStatus(message);
  // Amendement 2026-10-07 bis: a model-missing problem gets an action —
  // clicking the status text opens the model menu (see renderStatusLabel()).
  providerStatusActionable = message.reason === "model-missing";
  providerState = ["ok", "ko", "unknown"].includes(message.state) ? message.state : "unknown";
  currentProvider = typeof message.provider === "string" ? message.provider : null;
  // openai-compat's address (docs/PROTOCOL.md "provider.status", amendement
  // 2026-10-02 ter) — the reliable source for currentProviderLinks(); the
  // overheard `settings` case above only refreshes it.
  if (typeof message.baseUrl === "string") currentProviderBaseUrl = message.baseUrl;
  else if (currentProvider !== "openai-compat") currentProviderBaseUrl = undefined;
  // Kept so the first-run card's "model" step can offer the exact copy
  // command for the two Ollama cases (not running / no usable model).
  lastProviderReason = typeof message.reason === "string" ? message.reason : null;
  renderStatusLabel();
  renderFirstRun();
}
