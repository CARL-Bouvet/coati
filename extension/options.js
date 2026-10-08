// Coati options page — model (current model + two tabs « Sur cet
// ordinateur » / « En ligne », redesign 08/10), page reading default,
// shortcut, sites, history, about, and the legacy pairing-secret paste field
// (Flatpak/Snap browsers with no native messaging — docs/PROTOCOL.md
// amendement 2026-09-30, "Mode hérité: legacyPairing").
//
// The pasted key is a secret: it MUST live in chrome.storage.session (wiped
// when the browser closes), never chrome.storage.local (unencrypted on disk).

import { api, IS_GECKO } from "./lib/browser-compat.js";
import { providerLabel, CONNECTION_STATUS_LABELS } from "./lib/labels.js";
import { RETENTION_DAYS_KEY, parseStoredRetentionDays } from "./panel/retention.js";
import { POINT_EFFECT_KEY, parseStoredPointEffect } from "./panel/point-effect.js";
import { shortcutKeys, actionShortcut } from "./lib/shortcut.js";
import { computeCodeFingerprint } from "./lib/build-fingerprint.js";
import { MODEL_PROVIDER_PRESETS, isAllowedBaseUrl } from "./lib/model-provider-presets.js";
import { t, applyI18n, reloadOnLanguageChange } from "./lib/i18n-page.js";
import { mountLanguageSelector } from "./lib/language-selector.js";
import { createKeyInput } from "./lib/key-input.js";
import { ONLINE_PROVIDERS, SEARCH_PROVIDERS } from "./lib/setup-data.js";
import { mountSetupGuide } from "./options-setup.js";
import {
  fitNoteKey,
  groupModels,
  moduleLabelsFrom,
  providerDisplayName,
  renderModelList,
  sameModel,
  shortModelName,
} from "./lib/model-list.js";

applyI18n(document);
// Same compact selector (FR/EN/中) as the panel's header, in the page's
// anthracite band — the « Langue » section is gone (redesign 08/10).
mountLanguageSelector(document.getElementById("languageSelectorMount"), { compact: true });

// U1 — live language switch: this page also has module-level t() tables
// (labels.js, model-provider-presets.js, shortcut.js) in its import graph;
// a reload re-runs them all with the new catalog already loaded (see
// lib/i18n.js's top-level await), simpler than repainting each in place.
reloadOnLanguageChange();

// Same key and value semantics as extension/panel/panel.js (ATTACH_PAGE_KEY,
// attachPagePreference): a boolean once the user chose, null/absent = never
// chosen, which the panel treats as "on".
const ATTACH_PAGE_KEY = "coati:attachPage";

// Fixed suggestions offered even when not yet granted (deliverable 4 —
// "Sites où Coati se reconnaît tout seul"). Any origin already granted is
// added on top of these when rendering, read fresh from
// chrome.permissions.getAll() every time — never a cached copy.
const SUGGESTED_HOST_PATTERNS = ["https://www.youtube.com/*"];

// « Retirer » asks for a second click within this delay (same two-step
// pattern as the key component's « Supprimer la clé », no native dialog).
const REMOVE_CONFIRM_MS = 5000;

// Theme variant hook, screenshots only — inert unless the page is opened with
// e.g. "?variant=b". See notes/PLAN_goal_panneau_v2.md, "Contrat commun".
const variant = new URLSearchParams(location.search).get("variant");
if (variant) document.documentElement.dataset.variant = variant;

const els = {
  token: document.getElementById("token"),
  save: document.getElementById("save"),
  status: document.getElementById("status"),
  statusLabel: document.querySelector("#status .status-label"),
  headerStatus: document.getElementById("headerStatus"),
  headerStatusLabel: document.querySelector("#headerStatus .status-label"),
  legacyPairing: document.getElementById("legacyPairing"),
  attachPage: document.getElementById("attachPage"),
  shortcutKeys: document.getElementById("shortcutKeys"),
  shortcutEdit: document.getElementById("shortcutEdit"),
  shortcutHelp: document.getElementById("shortcutHelp"),
  openPrompts: document.getElementById("openPrompts"),
  aboutVersion: document.getElementById("aboutVersion"),
  aboutFingerprint: document.getElementById("aboutFingerprint"),
  retention: document.getElementById("retention"),
  pointEffectInputs: [...document.querySelectorAll('#pointEffectChoice input[name="pointEffect"]')],
  siteToggles: document.getElementById("siteToggles"),
  siteTogglesHelp: document.getElementById("siteTogglesHelp"),
  // « Modèle »
  modelSection: document.getElementById("modelSection"),
  modelDisconnected: document.getElementById("modelDisconnected"),
  setupIntro: document.getElementById("setupIntro"),
  currentModel: document.getElementById("currentModel"),
  currentModelName: document.getElementById("currentModelName"),
  currentModelWhere: document.getElementById("currentModelWhere"),
  currentModelState: document.getElementById("currentModelState"),
  currentTest: document.getElementById("currentTest"),
  currentTestResult: document.getElementById("currentTestResult"),
  tabs: [...document.querySelectorAll("#modelTabs [role=tab]")],
  panelLocal: document.getElementById("panelLocal"),
  panelOnline: document.getElementById("panelOnline"),
  installedBlock: document.getElementById("h-installed").closest(".tab-block"),
  modelsRefresh: document.getElementById("modelsRefresh"),
  modelsAvailableList: document.getElementById("modelsAvailableList"),
  modelsLoading: document.getElementById("modelsLoading"),
  modelFieldSlotLocal: document.getElementById("modelFieldSlotLocal"),
  setupLocal: document.getElementById("setupLocal"),
  servicesBlock: document.getElementById("h-services").closest(".tab-block"),
  serviceList: document.getElementById("serviceList"),
  servicesEmpty: document.getElementById("servicesEmpty"),
  addService: document.getElementById("addService"),
  addServiceReplaces: document.getElementById("addServiceReplaces"),
  setupOnline: document.getElementById("setupOnline"),
  otherAddressBody: document.getElementById("otherAddressBody"),
  capLinks: document.getElementById("capLinks"),
  searchBlock: document.getElementById("search"),
  searchRadios: [...document.querySelectorAll("input[name=searchProvider]")],
  searchKeySlot: document.getElementById("searchKeySlot"),
  searchTest: document.getElementById("searchTest"),
  searchGuideBody: document.getElementById("searchGuideBody"),
  modelField: document.getElementById("modelField"),
  modelSelect: document.getElementById("modelSelect"),
  modelInput: document.getElementById("modelInput"),
  modelSave: document.getElementById("modelSave"),
};

const sendClientMessage = (payload) => api.runtime.sendMessage({ type: "coati:client-message", payload });

// Connection state of the local program ("connected", "disconnected", …).
let status = "unknown";
// Latest `settings` and `models` replies (docs/PROTOCOL.md). `models` lists
// every usable model whatever the active provider (amendement 2026-10-07).
let lastSettings = null;
let modelsReply = null;
let modelsRequestId = null;
// An older local program without models.list: the « Nom du modèle » field
// stands in for the installed list.
let modelsUnsupported = false;

// The setup guide (goal U2), merged into the tabs (options-setup.js).
const setupGuide = mountSetupGuide({
  localRoot: els.setupLocal,
  onlineRoot: els.setupOnline,
  send: sendClientMessage,
  newId,
  onModels: (reply) => acceptModels(reply),
});

// --- Tests (settings.test) -----------------------------------------------------
//
// "settings.test" is fire-and-forget per provider; its reply does not itself
// re-render anything. Two places can start one: the current-model line
// ("current") and a service row ("row"). The result shows where the click
// was, and is repainted after a re-render.
const testTargets = new Map(); // `${kind}:${provider}` -> { button, result }
const testsInFlight = new Map(); // provider -> kind that started the test
const lastTestResults = new Map(); // `${kind}:${provider}` -> settings.test-result
// Ids of the settings.test requests sent by the « Tester » buttons — a key
// component's own verification (lib/key-input.js) also sends settings.test,
// and shows its result itself.
const testRequestIds = new Set();

// One key component per provider (lib/key-input.js), kept across re-renders
// so an in-flight save/verification is not lost when a fresh `settings`
// rebuilds the service rows.
const keyInputs = new Map();

// Service rows: settings fold open state and armed « Retirer » buttons,
// both kept across re-renders.
const openServiceDetails = new Set();
const removeArmed = new Map(); // provider -> timer

// Tabs: the page opens on the side of the active model, once; after that the
// user's (or a deep link's) choice holds.
let tabChosen = false;

// « Ajouter un service › Autre adresse compatible OpenAI » (built once).
const baseUrlField = buildBaseUrlField();

init();

async function init() {
  // docs/PROTOCOL.md "Mode hérité: legacyPairing": write-only field, never
  // pre-filled with the key/secret in memory — nothing read from
  // chrome.storage.session here.

  // Bug report gap 7: this help text used to say "Chrome" unconditionally,
  // wrong under Firefox — same IS_GECKO detection panel.js already uses for
  // its own browser-specific text (see applyConnectionBanner()).
  els.siteTogglesHelp.textContent = IS_GECKO
    ? t("options_sites_help_gecko")
    : t("options_sites_help_chrome");

  const data = await api.storage.local.get([RETENTION_DAYS_KEY, ATTACH_PAGE_KEY, POINT_EFFECT_KEY]);
  const retentionDays = parseStoredRetentionDays(data[RETENTION_DAYS_KEY]);
  els.retention.value = retentionDays === null ? "never" : String(retentionDays);
  // Same default as the panel: never chosen (null/absent) reads as "on".
  els.attachPage.checked = typeof data[ATTACH_PAGE_KEY] === "boolean" ? data[ATTACH_PAGE_KEY] : true;
  els.attachPage.addEventListener("change", () => {
    api.storage.local.set({ [ATTACH_PAGE_KEY]: els.attachPage.checked });
  });

  const pointEffect = parseStoredPointEffect(data[POINT_EFFECT_KEY]);
  for (const input of els.pointEffectInputs) {
    input.checked = input.value === pointEffect;
    input.addEventListener("change", () => {
      if (input.checked) api.storage.local.set({ [POINT_EFFECT_KEY]: input.value });
    });
  }

  els.openPrompts.addEventListener("click", (event) => {
    // Same opening path as the panel's "Mes prompts" entry: a new tab.
    event.preventDefault();
    api.tabs.create({ url: api.runtime.getURL("prompts/prompts.html") });
  });

  setupShortcut();
  showAbout();

  els.save.addEventListener("click", () => applyPastedKey(els.token.value.trim()));
  // The primary flow is a paste (Flatpak/Snap browsers only; a browser with
  // native messaging never needs this field). Read the value on the next
  // tick — the "paste" event fires before the input's own value is updated —
  // and apply it right away, without waiting for a click on "Enregistrer".
  els.token.addEventListener("paste", () => {
    setTimeout(() => applyPastedKey(els.token.value.trim()), 0);
  });
  els.retention.addEventListener("change", saveRetention);

  // « Modèle »
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
  setupSearch();
  setupOpenOnHash();

  api.runtime.onMessage.addListener((message) => {
    if (message?.type === "coati:status") {
      applyStatus(message.state);
      if (message.state === "connected") requestSettings();
    }
    if (message?.type !== "coati:broker-message") return;
    const reply = message.message;
    for (const keyInput of keyInputs.values()) keyInput.handleBrokerMessage(reply);
    setupGuide.onBrokerMessage(reply);
    if (reply?.type === "settings") {
      lastSettings = reply;
      renderModelSection();
      setupGuide.onSettings(reply);
      // Any settings change (here, in the panel's model menu, a new key) can
      // add or move entries: re-read the full list (amendement 2026-10-07).
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
  });

  const initial = await api.runtime.sendMessage({ type: "coati:get-status" }).catch(() => null);
  applyStatus(initial?.state ?? "unknown");
  if (initial?.state === "connected") requestSettings();

  await renderSiteToggles();
  api.permissions.onAdded.addListener(renderSiteToggles);
  api.permissions.onRemoved.addListener(renderSiteToggles);
}

function newId() {
  return `opt-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

/** Tiny DOM helper (this file): no innerHTML, text via textContent. */
function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

function buttonEl(text, className) {
  const button = el("button", className, text);
  button.type = "button";
  return button;
}

// 64 lowercase hex chars — same shape as the broker's own key (docs/PROTOCOL.md
// "Poignée de main v: 2"). Checked here too (defense in depth; the service
// worker validates again) so a mistyped paste gets an immediate, specific
// message instead of silently doing nothing.
const PASTED_KEY_RE = /^[0-9a-f]{64}$/i;

// claude-cli's own reconnect command (modules/claude-cli/index.ts,
// AUTH_REQUIRED_MESSAGE — amendement 2026-10-02, goal-j2FJ-kI7): kept as one
// constant here so the copy button and the displayed text can never drift
// apart from each other.
const CLAUDE_CLI_LOGIN_COMMAND = "claude auth login --claudeai";

// docs/PROTOCOL.md "Mode hérité: legacyPairing": a valid 64-hex value is
// stored and reconnects immediately (cancelling any backoff in progress); an
// empty value clears the stored key instead of storing "". Delegated to the
// service worker (message "coati:set-pasted-key") rather than writing
// chrome.storage.session directly here, so the same force-reconnect path
// always runs right after — see service-worker.js.
async function applyPastedKey(value) {
  if (value && !PASTED_KEY_RE.test(value)) {
    els.statusLabel.textContent = t("options_invalid_secret");
    return;
  }
  await api.runtime.sendMessage({ type: "coati:set-pasted-key", key: value.toLowerCase() }).catch(() => null);
  // I4 (lot7 security review): clear the field once applied — nothing left
  // sitting visible/selectable in the DOM after the secret has done its job.
  els.token.value = "";
}

async function saveRetention() {
  const raw = els.retention.value;
  const retentionDays = raw === "never" ? null : Number(raw);
  await api.storage.local.set({ [RETENTION_DAYS_KEY]: retentionDays });
}

function applyStatus(state) {
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
  // Amendement 2026-10-02 (goal-j2FJ-kI7): "no-token" (Chromium id unknown,
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

function setupOpenOnHash() {
  const openIfAsked = () => {
    if (location.hash === "#setup") openSetup();
    // The panel's search-not-configured remedy (lot C3).
    else if (location.hash === "#search") openSearch();
    // The panel's slow-answer tip (plan-ollama-rapide-07-10.md, point 6).
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
 * Ollama steps (local) or « Ajouter un service » (online). */
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

// Deep link from the panel's error banner (amendement 2026-10-02,
// goal-j2FJ-kI7, "parcours panne modèle"): options.html#provider-<id> shows
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
    // Not configured and not active: the way in is « Ajouter un service ».
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

// --- Tabs « Sur cet ordinateur » / « En ligne » (WAI-ARIA tabs) -----------------

function setupTabs() {
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

function selectTab(name, { focus = false } = {}) {
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
// "Fournisseur de modèle") ----------------------------------------------

function requestSettings() {
  sendClientMessage({ type: "settings.get", id: newId() });
}

function requestModels() {
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
function isLocalProvider(providerId, settings) {
  if (providerId === "ollama") return true;
  if (providerId !== "openai-compat") return false;
  if (settings?.provider === providerId && settings.baseUrl) return isLoopbackUrl(settings.baseUrl);
  const entries = (modelsReply?.entries ?? []).filter((entry) => entry?.provider === providerId);
  return entries.length > 0 && entries.every((entry) => entry.local === true);
}

function providerEntry(settings, providerId) {
  return (settings?.available ?? []).find((entry) => entry?.id === providerId) ?? null;
}

/** Human name of a provider: the service (OpenRouter, Mistral…) when
 * openai-compat's address is known, the built-in label, a module's own
 * label — never the raw id unless nothing else exists. */
function serviceName(providerId, settings) {
  if (providerId === "ollama") return "Ollama"; // i18n-allow: product name
  return providerDisplayName(providerId, {
    providerLabel,
    moduleLabels: moduleLabelsFrom(settings),
    baseUrl: settings?.provider === providerId ? settings.baseUrl : undefined,
    fallback: providerId,
  });
}

/** One short state, in the UI language — never the broker's free-text
 * `reason` (English diagnostic; bug « détail d'indisponibilité en anglais »).
 * `tone`: "ok" | "todo". */
function serviceState(entry) {
  if (entry.id === "claude-api" && !entry.configured) return { text: t("options_state_key_missing"), tone: "todo" };
  if (entry.id === "openai-compat" && !entry.configured) return { text: t("options_state_address_missing"), tone: "todo" };
  if (entry.id === "ollama" && !entry.available) return { text: t("model_list_ollama_unreachable"), tone: "todo" };
  if (!entry.available) return { text: t("options_state_check"), tone: "todo" };
  if (entry.id === "claude-api") return { text: t("options_state_key_saved"), tone: "ok" };
  return { text: t("options_state_ready"), tone: "ok" };
}

/** Online services shown as rows: the active one when it is online, plus
 * every configured one. An unconfigured service is not listed — « Ajouter un
 * service » is the way in (redesign 08/10, decision 4). */
function onlineServices(settings) {
  const services = (settings?.available ?? []).filter((entry) => {
    if (!entry || typeof entry.id !== "string" || entry.id === "ollama") return false;
    if (isLocalProvider(entry.id, settings)) return false;
    if (entry.id === settings.provider) return true;
    if (entry.id === "claude-api" || entry.id === "openai-compat") return Boolean(entry.configured);
    return Boolean(entry.configured || entry.available); // a module (docs/MODULES.md)
  });
  return services.sort((a, b) => Number(b.id === settings.provider) - Number(a.id === settings.provider));
}

let lastServicesSignature = null;
// « Ajouter un service » follows the services list (open only while there is
// none) until the user toggles it or a deep link opens it: then it holds.
let addServiceHeld = false;

/** Repaints the « Modèle » section from the latest `settings` / `models`. A
 * `models` reply alone only rebuilds the service rows when their set changed
 * (a rebuild re-parents the key field, which would drop the user's focus). */
function renderModelSection({ fromModels = false } = {}) {
  const settings = status === "connected" ? lastSettings : null;
  renderCurrent(settings);
  renderInstalled(settings);
  const signature = settings ? `${settings.provider}|${onlineServices(settings).map((e) => e.id).join(",")}` : "";
  if (!fromModels || signature !== lastServicesSignature) renderServices(settings);
  lastServicesSignature = signature;
  placeModelField(settings);
  renderAddService(settings);
  renderSearch(settings);
  if (!settings) return;
  if (!tabChosen) {
    tabChosen = true;
    selectTab(isLocalProvider(settings.provider, settings) ? "local" : "online");
  }
  // No online service yet: « Ajouter un service » is the whole tab. With one
  // or more, it stays folded under the list.
  if (!addServiceHeld) els.addService.open = onlineServices(settings).length === 0;
  if (setupHashPending && location.hash === "#setup") openSetup();
  if (searchHashPending && location.hash === "#search") openSearch();
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
  // Nothing answers anywhere yet: the one-line « why » with the coati icon.
  const anyModel = grouped && grouped.local.length + grouped.online.length > 0;
  els.setupIntro.hidden = Boolean(entry?.available || anyModel);

  els.currentModel.hidden = false;
  // No model named: a local server has none chosen yet; an online service
  // answers with its own default.
  const noModel = local ? t("options_current_no_model") : t("options_current_default_model");
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

// --- Tab « Sur cet ordinateur »: installed models (zone Z2c) -----------------
//
// Same list as the panel's model menu (lib/model-list.js), as toggle buttons
// (aria-pressed) with the « fits the graphics card » note; one click =
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

// --- Tab « En ligne »: configured services (zone Z2d) ------------------------

function renderServices(settings) {
  // The model field and the key components are re-parented below: park the
  // field first, remember the focus to give it back after the rebuild.
  const focused = els.serviceList.contains(document.activeElement) ? document.activeElement : null;
  els.modelSection.appendChild(els.modelField);
  els.serviceList.replaceChildren();
  for (const key of [...testTargets.keys()]) if (key.startsWith("row:")) testTargets.delete(key);

  els.servicesBlock.hidden = !settings;
  if (!settings) return;
  const services = onlineServices(settings);
  els.servicesEmpty.hidden = services.length > 0;
  for (const entry of services) els.serviceList.appendChild(buildServiceRow(entry, settings));
  if (focused?.isConnected && document.activeElement !== focused) focused.focus({ preventScroll: true });
}

/** One row: name, « En service » tag, state; Utiliser / Tester / Retirer;
 * the active row folds its settings (key, model) underneath. */
function buildServiceRow(entry, settings) {
  const active = entry.id === settings.provider;
  const row = el("li", active ? "service service--active" : "service");
  // Stable anchor for the panel's deep link (#provider-<id>).
  row.id = `provider-${entry.id}`;

  const head = el("div", "service-head");
  head.append(el("span", "service-name", serviceName(entry.id, settings)));
  if (active) head.append(el("span", "service-tag", t("options_service_active")));
  const state = serviceState(entry);
  const stateNode = el("span", "service-state", state.text);
  stateNode.dataset.tone = state.tone;
  head.append(stateNode);

  const actions = el("div", "service-actions");
  const connected = status === "connected";
  if (!active) {
    const use = buttonEl(t("options_service_use"), "button-small service-use");
    use.disabled = !connected;
    use.addEventListener("click", () => setProvider(entry.id, undefined));
    actions.append(use);
  }
  const test = buttonEl(t("options_test_short"), "button-secondary button-small test-button");
  test.addEventListener("click", () => testProvider(entry.id, "row"));
  actions.append(test);
  if (entry.id === "claude-api" || entry.id === "openai-compat") actions.append(buildRemoveButton(entry));

  const result = el("span", "test-result service-result");
  result.setAttribute("role", "status");
  row.append(head, actions, result);
  registerTestTarget("row", entry.id, test, result);

  if (active) {
    const details = el("details", "fold fold--inner service-details");
    details.open = openServiceDetails.has(entry.id) || !entry.configured;
    details.addEventListener("toggle", () => {
      if (details.open) openServiceDetails.add(entry.id);
      else openServiceDetails.delete(entry.id);
    });
    const body = el("div", "fold-body");
    const hasKey = entry.id === "claude-api" || entry.id === "openai-compat";
    if (hasKey) {
      const keyInput = keyInputFor(entry.id);
      keyInput.update(entry);
      body.append(keyInput.element);
    }
    body.append(els.modelField);
    details.append(el("summary", null, t(hasKey ? "options_service_settings" : "options_model_name_label")), body);
    row.append(details);
  }
  return row;
}

function buildRemoveButton(entry) {
  const button = buttonEl(t("options_service_remove"), "button-small apikey-clear service-remove");
  button.disabled = status !== "connected";
  const paintArmed = (armed) => {
    button.textContent = armed ? t("options_service_remove_confirm") : t("options_service_remove");
    button.classList.toggle("apikey-clear--confirm", armed);
  };
  paintArmed(removeArmed.has(entry.id));
  button.addEventListener("click", () => {
    if (!removeArmed.has(entry.id)) {
      const timer = setTimeout(() => {
        removeArmed.delete(entry.id);
        if (button.isConnected) paintArmed(false);
      }, REMOVE_CONFIRM_MS);
      removeArmed.set(entry.id, timer);
      paintArmed(true);
      return;
    }
    clearTimeout(removeArmed.get(entry.id));
    removeArmed.delete(entry.id);
    removeService(entry.id);
  });
  return button;
}

/** « Retirer »: the local program forgets the service's key without
 * touching the active provider or model (`clearKey`, docs/PROTOCOL.md
 * amendement 2026-10-08 §9bis). openai-compat also drops its address: an
 * empty `baseUrl` is what makes the row go away (its `configured` means « an
 * address is set »), and it clears the key bound to that origin too. */
function removeService(providerId) {
  if (!lastSettings || status !== "connected") return;
  const patch = { type: "settings.set", id: newId(), clearKey: providerId };
  if (providerId === "openai-compat") patch.baseUrl = "";
  sendClientMessage(patch);
}

/** The shared key component (lib/key-input.js) for `providerId`. The
 * monthly spending cap is the tab's own block (« Plafond de dépense »), not
 * repeated under the field. */
function keyInputFor(providerId) {
  let keyInput = keyInputs.get(providerId);
  if (!keyInput) {
    keyInput = createKeyInput({
      provider: providerId,
      send: sendClientMessage,
      newId,
      placeholder:
        providerId === "openai-compat" ? t("options_apikey_placeholder_optional") : t("options_apikey_placeholder_anthropic"),
    });
    keyInput.setConnected(status === "connected");
    keyInputs.set(providerId, keyInput);
  }
  return keyInput;
}

/** « Ajouter un service »: one OpenAI-compatible service at a time — say so
 * when adding another would replace the configured one. */
function renderAddService(settings) {
  const compat = providerEntry(settings, "openai-compat");
  const replaces = Boolean(settings && compat?.configured && !isLocalProvider("openai-compat", settings));
  els.addServiceReplaces.hidden = !replaces;
  els.addServiceReplaces.textContent = replaces
    ? t("options_add_service_replaces", [serviceName("openai-compat", settings)])
    : "";
  baseUrlField.setValue(settings?.provider === "openai-compat" ? settings.baseUrl : undefined);
}

/** « Plafond de dépense »: the paid services' own cap pages
 * (lib/setup-data.js); free and prepaid services need none. */
function renderCapLinks() {
  const paid = ONLINE_PROVIDERS.filter((service) => service.limitsUrl && service.group !== "free" && !service.prepaid);
  paid.forEach((service, index) => {
    if (index > 0) els.capLinks.append(" · ");
    const link = el("a", "link", service.name);
    link.href = service.limitsUrl;
    link.target = "_blank";
    link.rel = "noopener noreferrer";
    els.capLinks.append(link);
  });
}

// --- Model name field (active provider) ---------------------------------------

/** Online: inside the active service's settings fold (buildServiceRow).
 * Local: the installed list is the chooser; the field stands in only when
 * the local program cannot list models (older version). */
function placeModelField(settings) {
  if (!settings) {
    els.modelField.hidden = true;
    els.modelSection.appendChild(els.modelField);
    return;
  }
  if (isLocalProvider(settings.provider, settings)) {
    if (modelsUnsupported) {
      els.modelFieldSlotLocal.appendChild(els.modelField);
      renderModelField(settings);
    } else {
      els.modelField.hidden = true;
      els.modelSection.appendChild(els.modelField);
    }
    return;
  }
  if (els.modelField.closest(".service")) renderModelField(settings);
  else els.modelField.hidden = true;
}

/** Model names for the selected provider's own select: the `settings` list
 * plus whatever models.list found for that provider (Ollama answers there
 * even when `settings.models` was empty). */
function modelNamesFor(settings) {
  const names = Array.isArray(settings.models) ? [...settings.models] : [];
  for (const entry of modelsReply?.entries ?? []) {
    if (entry?.provider !== settings.provider || typeof entry.model !== "string") continue;
    if (!names.some((name) => sameModel(name, entry.model))) names.push(entry.model);
  }
  return names;
}

function renderModelField(settings) {
  els.modelField.hidden = false;
  const names = modelNamesFor(settings);

  if (names.length > 0) {
    els.modelSelect.hidden = false;
    els.modelInput.hidden = true;
    els.modelSave.hidden = true;

    clearChildren(els.modelSelect);
    const placeholder = document.createElement("option");
    placeholder.value = "";
    placeholder.textContent = t("options_choose_model");
    els.modelSelect.appendChild(placeholder);
    for (const name of names) {
      const option = document.createElement("option");
      option.value = name;
      option.textContent = name;
      els.modelSelect.appendChild(option);
    }
    els.modelSelect.value = settings.model ?? "";
  } else {
    els.modelSelect.hidden = true;
    els.modelInput.hidden = false;
    els.modelSave.hidden = false;
    if (document.activeElement !== els.modelInput) els.modelInput.value = settings.model ?? "";
    els.modelInput.placeholder =
      settings.provider === "claude-api"
        ? t("options_model_placeholder_claude")
        : settings.provider === "openai-compat"
          ? t("options_model_placeholder_openai_compat")
          : t("options_model_name_placeholder");
  }
}

function setProvider(provider, model) {
  const payload = { type: "settings.set", id: newId() };
  if (provider !== undefined) payload.provider = provider;
  if (model !== undefined) payload.model = model;
  sendClientMessage(payload);
}

// baseUrl is NOT a secret (docs/PROTOCOL.md, amendement 2026-09-30 bis) —
// unlike apiKey (lib/key-input.js), the broker echoes it back in the next `settings`
// message, so it is safe (and expected) to keep it visible in the address
// input rather than clearing it after every save. Sent without `provider`:
// saving an address never switches the active model.
function setBaseUrl(baseUrl) {
  sendClientMessage({ type: "settings.set", id: newId(), baseUrl });
}

/** Preset select + address field + Enregistrer, for the `openai-compat`
 * provider (goal G5), under « Ajouter un service › Autre adresse ».
 * `baseUrl` is NOT a secret (docs/PROTOCOL.md) — prefilled from the broker's
 * last answer when openai-compat is active, kept after a save. */
function buildBaseUrlField() {
  const wrap = el("div", "baseurl-field");

  const presetSelect = document.createElement("select");
  presetSelect.setAttribute("aria-label", t("options_other_address_title"));
  const customOption = el("option", null, t("options_other_address"));
  customOption.value = "";
  presetSelect.appendChild(customOption);
  for (const preset of MODEL_PROVIDER_PRESETS) {
    const option = el("option", null, preset.label);
    option.value = preset.baseUrl;
    presetSelect.appendChild(option);
  }

  const input = document.createElement("input");
  input.type = "text";
  input.autocomplete = "off";
  input.placeholder = "http://localhost:1234/v1";
  input.setAttribute("aria-label", t("options_other_address_title"));

  const error = el("span", "baseurl-error");
  error.setAttribute("role", "status");

  presetSelect.addEventListener("change", () => {
    if (!presetSelect.value) return; // custom address — leave the field as is
    input.value = presetSelect.value;
    error.textContent = "";
    setBaseUrl(input.value);
  });

  const saveBtn = buttonEl(t("options_save_address"), "button-secondary");
  saveBtn.addEventListener("click", () => {
    const value = input.value.trim();
    if (!value) return;
    // Client-side copy of the broker's own security rule (see
    // lib/model-provider-presets.js's own doc) — an immediate, specific
    // message instead of a silent round trip to a broker that will reject it
    // anyway.
    if (!isAllowedBaseUrl(value)) {
      error.textContent = t("options_address_refused");
      return;
    }
    error.textContent = "";
    setBaseUrl(value);
  });

  wrap.append(presetSelect, input, saveBtn, error);
  return {
    element: wrap,
    /** Reflects the broker's address; a preset when it matches one exactly,
     * else « Autre adresse ». Never overwrites what the user is typing. */
    setValue(baseUrl) {
      if (document.activeElement !== input) input.value = baseUrl ?? "";
      presetSelect.value = MODEL_PROVIDER_PRESETS.some((p) => p.baseUrl === baseUrl) ? baseUrl : "";
    },
  };
}

// --- « Recherche dans la doc » (lot C3) ----------------------------------------------
//
// The search service (Brave Search first, or Tavily) and its key, kept by the
// local program: the key goes once through lib/key-input.js (kind "search")
// and only `settings.search.configured` ever comes back. « Vérifier » is on
// demand: it spends one request of the free quota.

let selectedSearch = null;
let searchHashPending = false;

function setupSearch() {
  for (const radio of els.searchRadios) {
    radio.addEventListener("change", () => {
      if (!radio.checked) return;
      selectedSearch = radio.value;
      if (status === "connected") sendClientMessage({ type: "settings.set", id: newId(), searchProvider: radio.value });
      renderSearch(status === "connected" ? lastSettings : null);
    });
  }
  els.searchTest.addEventListener("click", () => searchKeyInputFor(selectedSearch ?? "brave").verify());

  const brave = SEARCH_PROVIDERS.find((service) => service.id === "brave");
  const steps = el("ol", "setup-os-list search-guide-steps");
  const braveStep = el("li", null, t("setup_search_brave"));
  if (brave?.keysUrl) {
    const link = el("a", "link", t("setup_search_brave_link"));
    link.href = brave.keysUrl;
    link.target = "_blank";
    link.rel = "noopener noreferrer";
    braveStep.append(" ", link);
  }
  steps.append(braveStep, el("li", null, t("setup_search_tavily")));
  els.searchGuideBody.append(el("p", "setup-text", t("setup_search_intro")), steps, el("p", "setup-text", t("setup_search_paste")));
  renderSearch(null);
}

function searchKeyInputFor(providerId) {
  const cacheKey = `search:${providerId}`;
  let keyInput = keyInputs.get(cacheKey);
  if (!keyInput) {
    const service = SEARCH_PROVIDERS.find((entry) => entry.id === providerId);
    keyInput = createKeyInput({
      provider: providerId,
      kind: "search",
      send: sendClientMessage,
      newId,
      placeholder: t("options_search_placeholder", [service?.name ?? providerId]),
    });
    keyInput.setConnected(status === "connected");
    keyInputs.set(cacheKey, keyInput);
  }
  return keyInput;
}

function renderSearch(settings) {
  const search = settings?.search ?? null;
  // The service the local program uses wins until the user picks another.
  if (search?.provider && (selectedSearch === null || !settings)) selectedSearch = search.provider;
  const chosen = selectedSearch ?? "brave";
  for (const radio of els.searchRadios) {
    radio.checked = radio.value === chosen;
    radio.disabled = !settings;
  }
  const keyInput = searchKeyInputFor(chosen);
  const configured = Boolean(search && search.provider === chosen && search.configured);
  keyInput.update({ configured });
  if (keyInput.element.parentNode !== els.searchKeySlot) els.searchKeySlot.replaceChildren(keyInput.element);
  els.searchTest.disabled = !(settings && configured);
}

/** options.html#search: the « En ligne » tab, scrolled to this block. */
function openSearch() {
  tabChosen = true;
  searchHashPending = !lastSettings;
  selectTab("online");
  els.searchBlock.scrollIntoView?.({ block: "start" });
  const radio = els.searchRadios.find((input) => input.checked) ?? els.searchRadios[0];
  radio?.focus({ preventScroll: true });
}

// --- « Tester » ------------------------------------------------------------------

function registerTestTarget(kind, providerId, button, result) {
  testTargets.set(`${kind}:${providerId}`, { button, result });
  paintTestTarget(kind, providerId);
}

function paintTestTarget(kind, providerId) {
  const target = testTargets.get(`${kind}:${providerId}`);
  if (!target) return;
  const runningKind = testsInFlight.get(providerId);
  target.button.disabled = Boolean(runningKind) || status !== "connected";
  target.button.textContent = runningKind === kind ? t("options_test_in_progress") : t("options_test_short");
  const last = lastTestResults.get(`${kind}:${providerId}`);
  if (last) renderTestResult(target.result, last);
  else {
    clearChildren(target.result);
    target.result.classList.remove("test-result--ok", "test-result--error");
  }
}

function testProvider(providerId, kind) {
  if (testsInFlight.has(providerId) || status !== "connected") return;
  testsInFlight.set(providerId, kind);
  lastTestResults.delete(`${kind}:${providerId}`);
  paintTestTarget("current", providerId);
  paintTestTarget("row", providerId);
  const id = newId();
  testRequestIds.add(id);
  sendClientMessage({ type: "settings.test", id, provider: providerId });
}

function applyTestResult(message) {
  // A key component's own verification: it shows its result itself.
  if (message.id && !testRequestIds.has(message.id)) return;
  testRequestIds.delete(message.id);
  const kind = testsInFlight.get(message.provider) ?? "row";
  testsInFlight.delete(message.provider);
  lastTestResults.set(`${kind}:${message.provider}`, message);
  paintTestTarget("current", message.provider);
  paintTestTarget("row", message.provider);
}

/**
 * Fills `result` (a « Tester » result <span>) with the outcome of a
 * settings.test — amendement 2026-10-02 (goal-j2FJ-kI7, "parcours panne
 * modèle"): a successful check says « connecté » up front (not just the
 * broker's own full sentence) and, when the broker couldn't see the
 * account's remaining credit (`creditUnchecked`), adds a dedicated second
 * line rather than leaving that limit implicit. A claude-cli session failure
 * additionally gets a copyable `claude auth login --claudeai` line — the
 * actual remedy, which no ordinary "check your settings" link can offer for
 * a CLI subscription. No innerHTML: every node built with
 * createElement/textContent, per the extension's CSP.
 */
function renderTestResult(result, message) {
  clearChildren(result);
  result.classList.remove("test-result--ok", "test-result--error");
  result.classList.add(message.ok ? "test-result--ok" : "test-result--error");

  const headline = el("span", "test-result-headline");
  // `message.message` is the broker's own sentence (docs/PROTOCOL.md,
  // settings.test-result, in the language sent with hello.lang), a plain
  // fallback if it is ever missing.
  const sentence = message.message || (message.ok ? t("options_test_ok") : t("options_test_failed"));
  headline.textContent = message.ok ? `${t("options_test_connected")} — ${sentence}` : sentence;
  result.appendChild(headline);

  if (message.ok && message.creditUnchecked) {
    result.appendChild(el("span", "test-result-detail", t("options_credit_unchecked")));
  }

  // claude-cli (external module, docs/MODULES.md) reports a session failure
  // the same way claude-api reports a key failure (code "auth-required") —
  // but (a) the broker's generic sentence for auth-required says "Clé API
  // refusée" which is wrong for a CLI subscription, and (b) the remedy is a
  // terminal command, not a settings field.  Both are special-cased here.
  if (!message.ok && message.provider === "claude-cli" && message.code === "auth-required") {
    headline.textContent = t("options_claude_cli_auth_required");
    result.appendChild(el("span", "test-result-detail", t("options_claude_cli_paste_hint")));

    const command = el("code", "test-result-command", CLAUDE_CLI_LOGIN_COMMAND);
    command.tabIndex = 0;
    result.appendChild(command);

    const copyBtn = buttonEl(t("options_copy_command"), "button-secondary button-small test-result-copy");
    copyBtn.addEventListener("click", () => {
      navigator.clipboard?.writeText(CLAUDE_CLI_LOGIN_COMMAND).catch(() => {});
    });
    result.appendChild(copyBtn);
  }
}

// --- Keyboard shortcut ------------------------------------------------------
//
// Read-only here: no browser lets an extension set its own shortcut, so the
// button only opens the browser's own shortcut page.

function setupShortcut() {
  renderShortcut();
  // Coming back from the shortcut page (another tab): re-read the value.
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") renderShortcut();
  });
  api.commands?.onChanged?.addListener?.(renderShortcut);

  if (IS_GECKO) {
    // commands.openShortcutSettings() exists from Firefox 137; older
    // versions get the one-line manual path instead of a dead button.
    if (typeof api.commands?.openShortcutSettings === "function") {
      els.shortcutEdit.hidden = false;
      els.shortcutEdit.addEventListener("click", () => api.commands.openShortcutSettings());
    } else {
      els.shortcutHelp.hidden = false;
    }
  } else {
    // An <a href="chrome://…"> is blocked from an extension page; tabs.create
    // is allowed. Brave redirects chrome:// to brave:// by itself.
    els.shortcutEdit.hidden = false;
    els.shortcutEdit.addEventListener("click", () => api.tabs.create({ url: "chrome://extensions/shortcuts" }));
  }
}

async function renderShortcut() {
  const commands = await api.commands?.getAll?.().catch(() => []);
  const keys = shortcutKeys(actionShortcut(commands));
  clearChildren(els.shortcutKeys);
  if (keys.length === 0) {
    const none = document.createElement("span");
    none.className = "shortcut-none";
    none.textContent = t("options_shortcut_not_set");
    els.shortcutKeys.appendChild(none);
    return;
  }
  keys.forEach((key, index) => {
    if (index > 0) {
      const plus = document.createElement("span");
      plus.className = "shortcut-plus";
      plus.textContent = "+";
      els.shortcutKeys.appendChild(plus);
    }
    const kbd = document.createElement("kbd");
    kbd.textContent = key;
    els.shortcutKeys.appendChild(kbd);
  });
}

// --- About ------------------------------------------------------------------

async function showAbout() {
  els.aboutVersion.textContent = api.runtime.getManifest().version;
  const fingerprint = await computeCodeFingerprint(api).catch(() => null);
  els.aboutFingerprint.textContent = fingerprint ?? t("panel_unavailable");
}

// --- Per-site activation (deliverable 4) -----------------------------------
//
// chrome.permissions.request() below is called directly from a checkbox
// "change" listener — a click in an extension page is a genuine user
// gesture, so this is allowed to run without going through activeTab or a
// content-script round trip.

function friendlyHostname(pattern) {
  try {
    return new URL(pattern.replace(/\*+$/, "")).hostname;
  } catch {
    return pattern;
  }
}

function clearChildren(node) {
  while (node.firstChild) node.removeChild(node.firstChild);
}

async function renderSiteToggles() {
  const granted = await api.permissions.getAll();
  const grantedOrigins = (granted.origins ?? []).filter(
    (origin) => origin.startsWith("http://") || origin.startsWith("https://"),
  );
  const patterns = [...new Set([...SUGGESTED_HOST_PATTERNS, ...grantedOrigins])];

  clearChildren(els.siteToggles);
  for (const pattern of patterns) {
    const item = document.createElement("li");
    item.className = "site-toggle";

    const label = document.createElement("label");
    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    checkbox.checked = grantedOrigins.includes(pattern);
    checkbox.addEventListener("change", () => onSiteToggleChange(pattern, checkbox));

    const name = document.createElement("span");
    name.textContent = friendlyHostname(pattern);

    label.appendChild(checkbox);
    label.appendChild(name);
    item.appendChild(label);
    els.siteToggles.appendChild(item);
  }
}

async function onSiteToggleChange(pattern, checkbox) {
  checkbox.disabled = true;
  try {
    if (checkbox.checked) {
      const granted = await api.permissions.request({ origins: [pattern] }).catch(() => false);
      if (!granted) checkbox.checked = false;
    } else {
      await api.permissions.remove({ origins: [pattern] }).catch(() => false);
    }
  } finally {
    // Re-render from chrome.permissions.getAll() rather than trusting the
    // request()/remove() return value alone — reflects the real state.
    await renderSiteToggles();
  }
}
