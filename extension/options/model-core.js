// Coati options page — connection status, tabs, deep links (#setup,
// #provider-<id>), settings.get/models.list, and the "Model"
// section's current-model + installed-list rendering (split of
// options.js). Owns the shared connection/model state that
// model-services.js and provider-tests.js only ever read.

import { providerLabel, CONNECTION_STATUS_LABELS } from "../lib/labels.js";
import { t } from "../lib/i18n-page.js";
import { mountSetupGuide } from "../options-setup.js";
import {
  fitNoteKey,
  groupModels,
  moduleLabelsFrom,
  providerDisplayName,
  renderModelList,
  shortModelName,
} from "../lib/model-list.js";
import { els } from "./dom-refs.js";
import { newId, sendClientMessage } from "./dom-helpers.js";
import { testTargets, registerTestTarget, testProvider, applyTestResult } from "./provider-tests.js";
import {
  renderServices,
  placeModelField,
  renderAddService,
  setProvider,
  renderCapLinks,
  baseUrlField,
} from "./model-services.js";

// Connection state of the local program ("connected", "disconnected", …).
export let status = "unknown";
// Latest `settings` and `models` replies (docs/PROTOCOL.md). `models` lists
// every usable model whatever the active provider.
export let lastSettings = null;
export let modelsReply = null;
let modelsRequestId = null;
// An older local program without models.list: the "Model name" field
// stands in for the installed list.
export let modelsUnsupported = false;

// One key component per provider (lib/key-input.js), kept across re-renders
// so an in-flight save/verification is not lost when a fresh `settings`
// rebuilds the service rows.
export const keyInputs = new Map();
// Service rows: settings fold open state, kept across re-renders.
export const openServiceDetails = new Set();

// Tabs: the page opens on the side of the active model, once; after that the
// user's (or a deep link's) choice holds.
let tabChosen = false;
// "Add a service" follows the services list (open only while there is
// none) until the user toggles it or a deep link opens it: then it holds.
let addServiceHeld = false;

// The setup guide, merged into the tabs (options-setup.js).
const setupGuide = mountSetupGuide({
  localRoot: els.setupLocal,
  onlineRoot: els.setupOnline,
  send: sendClientMessage,
  newId,
  onModels: (reply) => acceptModels(reply),
});

export function applyStatus(state) {
  status = state;
  const label = CONNECTION_STATUS_LABELS[state] ?? state;
  els.status.className = `status status--${state}`;
  els.statusLabel.textContent = label;
  els.headerStatus.className = `status status--${state}`;
  els.headerStatusLabel.textContent = label;
  setupGuide.onStatus(state);
  for (const keyInput of keyInputs.values()) keyInput.setConnected(state === "connected");

  // "no-host" (native messaging unreachable) is the state where the
  // Flatpak/Snap paste field is the actual fix — don't leave it folded away.
  // "no-token" (Chromium id unknown,
  // or a legacy secret refused) no longer force-expands it — pasting another
  // secret isn't the remedy for that state, it was a leftover over-trigger.
  if (state === "no-host") els.legacyPairing.open = true;

  // Never show a stale provider/model choice while we can't confirm it
  // against the broker — explain instead (deliverable 3's requirement).
  if (state !== "connected") lastSettings = null;
  renderModelSection();
}

// --- Deep links: #setup, #setup-ollama-speedup, #provider-<id> ------------------

// #setup arrived before the first `settings`: the side is not known yet;
// opened on the local side now, re-aimed once `settings` arrives.
let setupHashPending = false;

export function setupOpenOnHash() {
  const openIfAsked = () => {
    if (location.hash === "#setup") openSetup();
    // The panel's slow-answer tip.
    else if (location.hash === "#setup-ollama-speedup") {
      tabChosen = true;
      selectTab("local");
      setupGuide.openSpeedup();
    } else applyProviderHash();
  };
  openIfAsked();
  window.addEventListener("hashchange", openIfAsked);
}

/** options.html#setup: the guide on the side of the active model — the
 * Ollama steps (local) or "Add a service" (online). */
function openSetup() {
  tabChosen = true;
  setupHashPending = !lastSettings;
  const side = lastSettings && !isLocalProvider(lastSettings.provider, lastSettings) ? "online" : "local";
  selectTab(side);
  if (side === "local") {
    setupGuide.openLocalGuide();
    return;
  }
  addServiceHeld = true;
  els.addService.open = true;
  els.addService.scrollIntoView?.({ block: "start" });
  els.addService.querySelector("summary")?.focus({ preventScroll: true });
}

// Deep link from the panel's error banner ("model failure flow"): options.html#provider-<id> shows
// that provider (its service row, or the current-model line for a local
// one), focuses its most relevant control, and auto-runs the FREE
// settings.test once — never replayed on a later re-render of the same
// target, and never on a provider the broker hasn't reported yet.
let lastAutoTestedHash = null;

function applyProviderHash() {
  const match = /^#provider-(.+)$/.exec(location.hash);
  if (!match) {
    lastAutoTestedHash = null;
    return;
  }
  const settings = lastSettings;
  if (!settings || lastAutoTestedHash === location.hash) return;
  const providerId = match[1];
  if (!settings.available?.some((entry) => entry?.id === providerId)) return;
  lastAutoTestedHash = location.hash;
  tabChosen = true;

  if (isLocalProvider(providerId, settings)) {
    selectTab("local");
    els.currentModel.scrollIntoView?.({ behavior: "smooth", block: "start" });
    els.currentTest.focus({ preventScroll: true });
    if (providerId === settings.provider) testProvider(providerId, "current");
    return;
  }

  selectTab("online");
  const row = document.getElementById(`provider-${providerId}`);
  if (!row) {
    // Not configured and not active: the way in is "Add a service".
    addServiceHeld = true;
    els.addService.open = true;
    els.addService.scrollIntoView?.({ block: "start" });
    return;
  }
  openServiceDetails.add(providerId);
  const details = row.querySelector(".service-details");
  if (details) details.open = true;
  row.scrollIntoView?.({ behavior: "smooth", block: "start" });
  const focusTarget =
    row.querySelector(".service-details input:not([type=radio]):not([hidden]), .service-details select:not([hidden])") ??
    row.querySelector(".test-button");
  focusTarget?.focus({ preventScroll: true });
  // Free (settings.test never bills the model) — safe to run without
  // asking, and does not replay whatever the panel request that surfaced
  // the error actually was.
  testProvider(providerId, "row");
}

// --- Tabs "On this computer" / "Online" (WAI-ARIA tabs) -----------------

export function setupTabs() {
  const order = els.tabs.map((tab) => tab.dataset.tab);
  for (const tab of els.tabs) {
    tab.addEventListener("click", () => {
      tabChosen = true;
      selectTab(tab.dataset.tab);
    });
    tab.addEventListener("keydown", (event) => {
      const index = order.indexOf(tab.dataset.tab);
      let next = null;
      if (event.key === "ArrowRight") next = order[(index + 1) % order.length];
      else if (event.key === "ArrowLeft") next = order[(index - 1 + order.length) % order.length];
      else if (event.key === "Home") next = order[0];
      else if (event.key === "End") next = order[order.length - 1];
      if (!next) return;
      event.preventDefault();
      tabChosen = true;
      selectTab(next, { focus: true });
    });
  }
}

export function selectTab(name, { focus = false } = {}) {
  for (const tab of els.tabs) {
    const selected = tab.dataset.tab === name;
    tab.setAttribute("aria-selected", String(selected));
    tab.tabIndex = selected ? 0 : -1;
    if (selected && focus) tab.focus();
  }
  els.panelLocal.hidden = name !== "local";
  els.panelOnline.hidden = name !== "online";
  setupGuide.setLocalVisible(name === "local");
}

// --- Model provider section (broker/src/providers/, docs/PROTOCOL.md
// "Model provider") ----------------------------------------------

export function requestSettings() {
  sendClientMessage({ type: "settings.get", id: newId() });
}

export function requestModels() {
  if (modelsRequestId || status !== "connected") return;
  modelsRequestId = newId();
  sendClientMessage({ type: "models.list", id: modelsRequestId });
}

function applyModels(reply) {
  if (reply.id !== modelsRequestId) return; // another page's (or the guide's) request
  modelsRequestId = null;
  acceptModels(reply);
  setupGuide.onModels(reply);
}

/** A fresh `models` reply, from this page's request or the guide's. */
let guideAutoOpened = false;
function acceptModels(reply) {
  modelsReply = reply;
  modelsUnsupported = false;
  // Ollama missing or empty: the guide is the next step — opened once, the
  // user may close it.
  const grouped = groupModels(reply);
  if (!guideAutoOpened && (grouped.ollamaUnreachable || grouped.local.length === 0)) {
    guideAutoOpened = true;
    setupGuide.openLocalGuide({ scroll: false });
  }
  renderModelSection({ fromModels: true });
}

function isLoopbackUrl(value) {
  try {
    const host = new URL(value).hostname;
    return host === "localhost" || host === "127.0.0.1" || host === "[::1]";
  } catch {
    return false;
  }
}

/** true when `providerId` runs on this computer: Ollama, or an
 * OpenAI-compatible server on the loopback address (LM Studio…). Its address
 * is only known while it is active; otherwise models.list says (`local`). */
export function isLocalProvider(providerId, settings) {
  if (providerId === "ollama") return true;
  if (providerId !== "openai-compat") return false;
  if (settings?.provider === providerId && settings.baseUrl) return isLoopbackUrl(settings.baseUrl);
  const entries = (modelsReply?.entries ?? []).filter((entry) => entry?.provider === providerId);
  return entries.length > 0 && entries.every((entry) => entry.local === true);
}

export function providerEntry(settings, providerId) {
  return (settings?.available ?? []).find((entry) => entry?.id === providerId) ?? null;
}

/** Human name of a provider: the service (OpenRouter, Mistral…) when
 * openai-compat's address is known, the built-in label, a module's own
 * label — never the raw id unless nothing else exists. */
export function serviceName(providerId, settings, baseUrl = settings?.provider === providerId ? settings.baseUrl : undefined) {
  if (providerId === "ollama") return "Ollama"; // i18n-allow: product name
  return providerDisplayName(providerId, {
    providerLabel,
    moduleLabels: moduleLabelsFrom(settings),
    baseUrl,
    fallback: providerId,
  });
}

/** One short state, in the UI language — never the broker's free-text
 * `reason` (English diagnostic; bug "unavailability detail in English").
 * `tone`: "ok" | "todo". */
export function serviceState(entry) {
  // A configured openai-compat service that is not the active one: only its stored key is known.
  if (entry.id === "openai-compat" && entry.active === false) {
    return entry.hasKey ? { text: t("options_state_key_saved"), tone: "ok" } : { text: t("options_state_ready"), tone: "ok" };
  }
  if (entry.id === "claude-api" && !entry.configured) return { text: t("options_state_key_missing"), tone: "todo" };
  if (entry.id === "openai-compat" && !entry.configured) return { text: t("options_state_address_missing"), tone: "todo" };
  if (entry.id === "ollama" && !entry.available) return { text: t("model_list_ollama_unreachable"), tone: "todo" };
  if (!entry.available) return { text: t("options_state_check"), tone: "todo" };
  if (entry.id === "claude-api") return { text: t("options_state_key_saved"), tone: "ok" };
  return { text: t("options_state_ready"), tone: "ok" };
}

/** Online services shown as rows, active first: the active one when it is online, plus every
 * configured one. Each configured openai-compat service (OpenRouter, Mistral, another address…)
 * is its own row, `{ ...entry, key, active, baseUrl, hasKey }`. An unconfigured service is not
 * listed — "Add a service" is the way in (decision 4). */
export function onlineServices(settings) {
  const rows = [];
  for (const entry of settings?.available ?? []) {
    if (!entry || typeof entry.id !== "string" || entry.id === "ollama") continue;
    if (entry.id === "openai-compat") {
      for (const svc of settings.services ?? []) {
        if (isLoopbackUrl(svc.baseUrl)) continue;
        const active = settings.provider === entry.id && settings.baseUrl === svc.baseUrl;
        rows.push({ ...entry, key: `${entry.id}|${svc.baseUrl}`, active, baseUrl: svc.baseUrl, hasKey: svc.hasKey });
      }
      continue;
    }
    const active = entry.id === settings.provider;
    if (isLocalProvider(entry.id, settings)) continue;
    if (!active && !(entry.id === "claude-api" ? entry.configured : entry.configured || entry.available)) continue;
    rows.push({ ...entry, key: entry.id, active });
  }
  return rows.sort((a, b) => Number(b.active) - Number(a.active));
}

let lastServicesSignature = null;

/** Repaints the "Model" section from the latest `settings` / `models`. A
 * `models` reply alone only rebuilds the service rows when their set changed
 * (a rebuild re-parents the key field, which would drop the user's focus). */
function renderModelSection({ fromModels = false } = {}) {
  const settings = status === "connected" ? lastSettings : null;
  renderCurrent(settings);
  renderInstalled(settings);
  const signature = settings
    ? `${settings.provider}|${onlineServices(settings).map((e) => `${e.key}:${e.active}:${e.hasKey}`).join(",")}`
    : "";
  if (!fromModels || signature !== lastServicesSignature) renderServices(settings);
  lastServicesSignature = signature;
  placeModelField(settings);
  renderAddService(settings);
  if (!settings) return;
  if (!tabChosen) {
    tabChosen = true;
    selectTab(isLocalProvider(settings.provider, settings) ? "local" : "online");
  }
  // No online service yet: "Add a service" is the whole tab. With one
  // or more, it stays folded under the list.
  if (!addServiceHeld) els.addService.open = onlineServices(settings).length === 0;
  if (setupHashPending && location.hash === "#setup") openSetup();
  applyProviderHash();
}

// --- Current model (zone Z2a) -----------------------------------------------

function renderCurrent(settings) {
  els.modelDisconnected.hidden = status === "connected";
  if (!settings) {
    els.currentModel.hidden = true;
    els.setupIntro.hidden = true;
    return;
  }
  const entry = providerEntry(settings, settings.provider);
  const local = isLocalProvider(settings.provider, settings);
  const grouped = modelsReply
    ? groupModels({ ...modelsReply, current: { provider: settings.provider, model: settings.model ?? null } })
    : null;
  // Nothing answers anywhere yet: the one-line "why" with the coati icon.
  const anyModel = grouped && grouped.local.length + grouped.online.length > 0;
  els.setupIntro.hidden = Boolean(entry?.available || anyModel);

  els.currentModel.hidden = false;
  // No model named: a local server has none chosen yet; an online service
  // answers with its own default.
  const noModel = local ? t("options_current_no_model") : t("options_current_default_model");
  // The card's background (options.css): a pale "?" until a model answers.
  els.currentModel.dataset.model = entry?.available && (settings.model || !local) ? "set" : "none";
  els.currentModelName.textContent = settings.model ? shortModelName(settings.model) : noModel;
  els.currentModelName.title = settings.model ?? "";
  fitCurrentName();
  const where = [t(local ? "model_list_local" : "model_list_online"), serviceName(settings.provider, settings)];
  const current = grouped?.currentEntry;
  const fitKey = local && current ? fitNoteKey(current) : null;
  if (fitKey) where.push(fitKey === "model_fit_loaded_percent" ? t(fitKey, [String(current.gpuPercent)]) : t(fitKey));
  els.currentModelWhere.textContent = where.filter(Boolean).join(" · ");

  const state = entry && !entry.available ? serviceState(entry) : null;
  els.currentModelState.hidden = !state;
  els.currentModelState.textContent = state?.text ?? "";
  els.currentModelState.dataset.tone = state?.tone ?? "";

  for (const key of [...testTargets.keys()]) if (key.startsWith("current:")) testTargets.delete(key);
  registerTestTarget("current", settings.provider, els.currentTest, els.currentTestResult);
}

/** The model id stays on one line — never broken at its hyphens — unless
 * it is wider than the line: only then may it wrap (options.css,
 * .current-name--wrap). Re-checked when the card's width changes. */
function fitCurrentName() {
  const name = els.currentModelName;
  name.classList.remove("current-name--wrap");
  if (name.scrollWidth > name.clientWidth + 1) name.classList.add("current-name--wrap");
}

let currentModelWidth = 0;
new ResizeObserver(([entry]) => {
  const width = Math.round(entry.contentRect.width);
  if (width === currentModelWidth) return;
  currentModelWidth = width;
  fitCurrentName();
}).observe(els.currentModel);

// --- Tab "On this computer": installed models (zone Z2c) -----------------
//
// Same list as the panel's model menu (lib/model-list.js), as toggle buttons
// (aria-pressed) with the "fits the graphics card" note; one click =
// settings.set.

function renderInstalled(settings) {
  els.installedBlock.hidden = !settings;
  els.modelsLoading.hidden = !(settings && !modelsReply && !modelsUnsupported);
  if (!settings || !modelsReply) {
    els.modelsAvailableList.replaceChildren();
    return;
  }
  const focused = els.modelsAvailableList.contains(document.activeElement) ? document.activeElement : null;
  const focusedKey = focused ? `${focused.dataset.provider}\n${focused.dataset.model}` : null;
  // The checkmark follows the latest `settings`, fresher than the reply.
  const reply = { ...modelsReply, current: { provider: settings.provider, model: settings.model ?? null } };
  const items = renderModelList(els.modelsAvailableList, reply, {
    t,
    providerLabel,
    moduleLabels: moduleLabelsFrom(settings),
    baseUrl: settings.baseUrl,
    mode: "list",
    localOnly: true,
    idPrefix: "optionsModels",
    onPick: (entry) => {
      if (!entry.current) setProvider(entry.provider, entry.model);
    },
  });
  if (focusedKey) items.find((item) => `${item.dataset.provider}\n${item.dataset.model}` === focusedKey)?.focus();
}

// --- Broker message dispatch + wiring (called once from options.js) --------

/** Every `coati:broker-message` reply this page cares about — moved here
 * verbatim from options.js's init() so main stays a thin bootstrap. */
export function handleBrokerMessage(reply) {
  for (const keyInput of keyInputs.values()) keyInput.handleBrokerMessage(reply);
  setupGuide.onBrokerMessage(reply);
  if (reply?.type === "settings") {
    lastSettings = reply;
    renderModelSection();
    setupGuide.onSettings(reply);
    // Any settings change (here, in the panel's model menu, a new key) can
    // add or move entries: re-read the full list.
    requestModels();
  }
  if (reply?.type === "models") applyModels(reply);
  if (reply?.type === "error" && modelsRequestId && reply.id === modelsRequestId) {
    // Older local program without models.list.
    modelsRequestId = null;
    modelsUnsupported = true;
    renderModelSection();
  }
  if (reply?.type === "settings.test-result") applyTestResult(reply);
}

/** "Model" tab/services wiring, moved here verbatim from
 * options.js's init(). */
export function wireModelSettings() {
  setupTabs();
  selectTab("local");
  els.addService.querySelector("summary").addEventListener("click", () => {
    addServiceHeld = true;
  });
  els.currentTest.addEventListener("click", () => {
    if (lastSettings) testProvider(lastSettings.provider, "current");
  });
  els.modelsRefresh.addEventListener("click", () => requestModels());
  els.modelSelect.addEventListener("change", () => setProvider(undefined, els.modelSelect.value));
  els.modelSave.addEventListener("click", () => setProvider(undefined, els.modelInput.value.trim()));
  els.otherAddressBody.append(baseUrlField.element);
  renderCapLinks();
  setupOpenOnHash();
}
