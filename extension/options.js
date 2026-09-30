// Coati options page — model, page reading default, shortcut, sites,
// history, about, and the legacy pairing-secret paste field (Flatpak/Snap
// browsers with no native messaging — docs/PROTOCOL.md amendement
// 2026-09-30, "Mode hérité: legacyPairing").
//
// The pasted key is a secret: it MUST live in chrome.storage.session (wiped
// when the browser closes), never chrome.storage.local (unencrypted on disk).

import { api, IS_GECKO } from "./lib/browser-compat.js";
import { providerLabel, describeProviderUnavailable, CONNECTION_STATUS_LABELS } from "./lib/labels.js";
import { RETENTION_DAYS_KEY, parseStoredRetentionDays } from "./panel/retention.js";
import { shortcutKeys, actionShortcut } from "./lib/shortcut.js";
import { computeCodeFingerprint } from "./lib/build-fingerprint.js";
import { MODEL_PROVIDER_PRESETS, isAllowedBaseUrl } from "./lib/model-provider-presets.js";
import { t, applyI18n } from "./lib/i18n.js";

applyI18n(document);

// Same key and value semantics as extension/panel/panel.js (ATTACH_PAGE_KEY,
// attachPagePreference): a boolean once the user chose, null/absent = never
// chosen, which the panel treats as "on".
const ATTACH_PAGE_KEY = "coati:attachPage";

// Fixed suggestions offered even when not yet granted (deliverable 4 —
// "Sites où Coati se reconnaît tout seul"). Any origin already granted is
// added on top of these when rendering, read fresh from
// chrome.permissions.getAll() every time — never a cached copy.
const SUGGESTED_HOST_PATTERNS = ["https://www.youtube.com/*"];

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
  siteToggles: document.getElementById("siteToggles"),
  modelSection: document.getElementById("modelSection"),
  modelDisconnected: document.getElementById("modelDisconnected"),
  providerList: document.getElementById("providerList"),
  modelField: document.getElementById("modelField"),
  modelSelect: document.getElementById("modelSelect"),
  modelInput: document.getElementById("modelInput"),
  modelSave: document.getElementById("modelSave"),
  siteTogglesHelp: document.getElementById("siteTogglesHelp"),
};

// One-line French descriptions, understandable by a non-developer (task
// brief, deliverable D2). Keyed by BUILT-IN provider id only —
// `settings.available` is broker-driven, this is purely cosmetic and never
// gates behaviour. A provider not listed here (an externally loaded module,
// see docs/MODULES.md) simply gets no description line.
const PROVIDER_DESCRIPTIONS = {
  "claude-api": t("options_provider_desc_claude_api"),
  ollama: t("options_provider_desc_ollama"),
  "openai-compat": t("options_provider_desc_openai_compat"),
};

// "settings.test" is fire-and-forget per provider (deliverable D2) — these
// track in-flight state and the DOM nodes to update when the matching
// "settings.test-result" comes back, since that reply does not itself
// trigger a full renderModelSection() re-render (only a fresh "settings"
// message does, see requestSettings()/setProvider()).
const testingProviders = new Set();
const testButtonsByProvider = new Map();
const testResultsByProvider = new Map();

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

  const data = await api.storage.local.get([RETENTION_DAYS_KEY, ATTACH_PAGE_KEY]);
  const retentionDays = parseStoredRetentionDays(data[RETENTION_DAYS_KEY]);
  els.retention.value = retentionDays === null ? "never" : String(retentionDays);
  // Same default as the panel: never chosen (null/absent) reads as "on".
  els.attachPage.checked = typeof data[ATTACH_PAGE_KEY] === "boolean" ? data[ATTACH_PAGE_KEY] : true;
  els.attachPage.addEventListener("change", () => {
    api.storage.local.set({ [ATTACH_PAGE_KEY]: els.attachPage.checked });
  });

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
  els.modelSelect.addEventListener("change", () => setProvider(undefined, els.modelSelect.value));
  els.modelSave.addEventListener("click", () => setProvider(undefined, els.modelInput.value.trim()));
  api.runtime.onMessage.addListener((message) => {
    if (message?.type === "coati:status") {
      applyStatus(message.state);
      if (message.state === "connected") requestSettings();
    }
    if (message?.type === "coati:broker-message" && message.message?.type === "settings") {
      renderModelSection(message.message);
    }
    if (message?.type === "coati:broker-message" && message.message?.type === "settings.test-result") {
      applyTestResult(message.message);
    }
  });

  const status = await api.runtime.sendMessage({ type: "coati:get-status" }).catch(() => null);
  applyStatus(status?.state ?? "unknown");
  if (status?.state === "connected") requestSettings();

  await renderSiteToggles();
  api.permissions.onAdded.addListener(renderSiteToggles);
  api.permissions.onRemoved.addListener(renderSiteToggles);
}

function newId() {
  return `opt-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

// 64 lowercase hex chars — same shape as the broker's own key (docs/PROTOCOL.md
// "Poignée de main v: 2"). Checked here too (defense in depth; the service
// worker validates again) so a mistyped paste gets an immediate, specific
// French message instead of silently doing nothing.
const PASTED_KEY_RE = /^[0-9a-f]{64}$/i;

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
  const label = CONNECTION_STATUS_LABELS[state] ?? state;
  els.status.className = `status status--${state}`;
  els.statusLabel.textContent = label;
  els.headerStatus.className = `status status--${state}`;
  els.headerStatusLabel.textContent = label;

  // "no-host" (native messaging unreachable) and "no-token" (Chromium id
  // unknown, or a legacy secret refused) are the two states where the
  // Flatpak/Snap paste field is the actual fix — don't leave it folded away.
  if (state === "no-host" || state === "no-token") els.legacyPairing.open = true;

  if (state !== "connected") {
    // Never show a stale provider/model choice while we can't confirm it
    // against the broker — explain instead (deliverable 3's requirement).
    renderModelSection(null);
  }
}

// --- Model provider section (broker/src/providers/, docs/PROTOCOL.md
// "Fournisseur de modèle") ----------------------------------------------

function requestSettings() {
  api.runtime.sendMessage({
    type: "coati:client-message",
    payload: { type: "settings.get", id: newId() },
  });
}

function setProvider(provider, model) {
  const payload = { type: "settings.set", id: newId() };
  if (provider !== undefined) payload.provider = provider;
  if (model !== undefined) payload.model = model;
  api.runtime.sendMessage({ type: "coati:client-message", payload });
}

// Write-only: the broker stores `apiKey` and never returns it (contract with
// the backend worker implementing settings.set). An empty string means
// "forget the stored key" — see the "Effacer la clé" button below. The key
// must never touch chrome.storage or the console — it goes straight into
// this one runtime.sendMessage call.
function setApiKey(apiKey) {
  api.runtime.sendMessage({
    type: "coati:client-message",
    payload: { type: "settings.set", id: newId(), apiKey },
  });
}

// baseUrl is NOT a secret (docs/PROTOCOL.md, amendement 2026-09-30 bis) —
// unlike setApiKey above, the broker echoes it back in the next `settings`
// message, so it is safe (and expected) to keep it visible in the address
// input rather than clearing it after every save.
function setBaseUrl(baseUrl) {
  api.runtime.sendMessage({
    type: "coati:client-message",
    payload: { type: "settings.set", id: newId(), baseUrl },
  });
}

function testProvider(providerId) {
  if (testingProviders.has(providerId)) return;
  testingProviders.add(providerId);
  const button = testButtonsByProvider.get(providerId);
  if (button) {
    button.disabled = true;
    button.textContent = t("options_test_in_progress");
  }
  const result = testResultsByProvider.get(providerId);
  if (result) {
    result.textContent = "";
    result.className = "test-result";
  }
  api.runtime.sendMessage({
    type: "coati:client-message",
    payload: { type: "settings.test", id: newId(), provider: providerId },
  });
}

function applyTestResult(message) {
  testingProviders.delete(message.provider);
  const button = testButtonsByProvider.get(message.provider);
  if (button) {
    button.disabled = false;
    button.textContent = t("options_test_connection");
  }
  const result = testResultsByProvider.get(message.provider);
  if (result) {
    // `message` is the broker's own sentence (docs/PROTOCOL.md,
    // settings.test-result, still French/English from the broker — see G6
    // follow-up on broker `lang`), a plain fallback if it is ever missing.
    result.textContent = message.message || (message.ok ? t("options_test_ok") : t("options_test_failed"));
    result.className = `test-result ${message.ok ? "test-result--ok" : "test-result--error"}`;
  }
}

/** Renders the provider radio list + model field from the broker's latest
 * `settings` message, or the "not connected" explainer when `settings` is
 * null. No innerHTML — every node built with createElement, per the
 * extension's CSP (no inline styles/handlers either; all of that lives in
 * options.css and addEventListener calls below). */
function renderModelSection(settings) {
  els.modelDisconnected.hidden = settings !== null;
  // #modelField lives inside the selected provider's card (moved below);
  // park it back in its section before the list is emptied.
  els.modelSection.appendChild(els.modelField);
  clearChildren(els.providerList);
  testButtonsByProvider.clear();
  testResultsByProvider.clear();

  if (!settings) {
    els.modelField.hidden = true;
    return;
  }

  for (const provider of settings.available) {
    const item = document.createElement("li");
    item.className = provider.id === settings.provider ? "provider-item provider-item--selected" : "provider-item";

    const label = document.createElement("label");
    const radio = document.createElement("input");
    radio.type = "radio";
    radio.name = "provider";
    radio.value = provider.id;
    radio.checked = provider.id === settings.provider;
    radio.disabled = !provider.available;
    radio.addEventListener("change", () => {
      if (radio.checked) setProvider(provider.id, undefined);
    });

    const name = document.createElement("span");
    // lib/labels.js — shared with panel.js (bug report gap 4: one provider
    // name everywhere), not the broker's own `provider.label`.
    name.textContent = providerLabel(provider.id, provider.label);

    label.appendChild(radio);
    label.appendChild(name);

    // Right-aligned on the name line (options.css, margin-left: auto).
    if (provider.configured) {
      const configured = document.createElement("span");
      configured.className = "provider-configured";
      configured.textContent = provider.id === "claude-api" ? t("options_key_saved") : t("options_configured");
      label.appendChild(configured);
    }
    item.appendChild(label);

    const description = document.createElement("p");
    description.className = "provider-description";
    description.textContent = PROVIDER_DESCRIPTIONS[provider.id] ?? "";
    item.appendChild(description);

    if (!provider.available && provider.reason) {
      // `provider.reason` is free-text English straight from the broker
      // (broker/src/providers/*.ts) — never shown alone. describeProviderUnavailable()
      // gives it a French label and demotes the broker's own words to a
      // secondary "Détail : …" line (bug report gap 3).
      // First line = French label (danger colour), the rest = the broker's
      // own "Détail : …" words, demoted to a muted line.
      const [headline, ...detailLines] = describeProviderUnavailable(provider.reason).split("\n");
      const reason = document.createElement("span");
      reason.className = "provider-reason";
      reason.textContent = headline;
      item.appendChild(reason);
      if (detailLines.length > 0) {
        const detail = document.createElement("span");
        detail.className = "provider-reason-detail";
        detail.textContent = detailLines.join("\n");
        item.appendChild(detail);
      }
    }

    if (provider.id === "openai-compat") {
      // baseUrl is only ever present on `settings` for the currently active
      // provider (docs/PROTOCOL.md) — for the openai-compat card when it's
      // NOT selected, there is nothing to prefill with, same as the model
      // field's own behaviour just below.
      item.appendChild(buildBaseUrlField(provider.id === settings.provider ? settings.baseUrl : undefined));
    }

    if (provider.id === "claude-api" || provider.id === "openai-compat") {
      item.appendChild(buildApiKeyField(provider.id === "openai-compat"));
    }

    // The model name belongs to the selected provider: show it in its card.
    if (provider.id === settings.provider) item.appendChild(els.modelField);

    item.appendChild(buildTestRow(provider.id));

    els.providerList.appendChild(item);
  }

  renderModelField(settings);
}

/** Password field + Enregistrer/Effacer, shared by `claude-api` and
 * `openai-compat` (deliverable D2, extended goal G5). The field starts empty
 * on every load and after every save — the broker never echoes the key back
 * (write-only by contract), so there is nothing to prefill it with.
 * `optional` (true for openai-compat: LM Studio/Ollama need no key) only
 * changes the placeholder text — the save/clear mechanics are identical. */
function buildApiKeyField(optional) {
  const wrap = document.createElement("div");
  wrap.className = "apikey-field";

  const input = document.createElement("input");
  input.type = "password";
  input.autocomplete = "off";
  input.placeholder = optional ? t("options_apikey_placeholder_optional") : t("options_apikey_placeholder_anthropic");

  const saveBtn = document.createElement("button");
  saveBtn.type = "button";
  saveBtn.textContent = t("options_save");
  saveBtn.addEventListener("click", () => {
    const value = input.value.trim();
    if (!value) return;
    setApiKey(value);
    input.value = "";
  });

  // Two-step confirm, no native dialog (options.html can be embedded by
  // Firefox — window.confirm() is unreliable there, same reasoning as
  // panel.js's eraseConversation button). First click arms the button for
  // ~5s; a second click within that window actually clears. Closure state
  // (not module-level) is fine: buildApiKeyField() is called fresh on every
  // renderModelSection(), so a stale timer never outlives its own button.
  const CLEAR_CONFIRM_MS = 5000;
  let clearConfirmPending = false;
  let clearConfirmTimer = null;
  const clearBtn = document.createElement("button");
  clearBtn.type = "button";
  clearBtn.className = "apikey-clear";
  clearBtn.textContent = t("options_apikey_clear");
  clearBtn.addEventListener("click", () => {
    if (!clearConfirmPending) {
      clearConfirmPending = true;
      clearBtn.textContent = t("options_apikey_clear_confirm");
      clearBtn.classList.add("apikey-clear--confirm");
      clearConfirmTimer = setTimeout(() => {
        clearConfirmPending = false;
        clearBtn.textContent = t("options_apikey_clear");
        clearBtn.classList.remove("apikey-clear--confirm");
      }, CLEAR_CONFIRM_MS);
      return;
    }
    clearConfirmPending = false;
    clearTimeout(clearConfirmTimer);
    clearBtn.textContent = t("options_apikey_clear");
    clearBtn.classList.remove("apikey-clear--confirm");
    setApiKey("");
    input.value = "";
  });

  wrap.appendChild(input);
  wrap.appendChild(saveBtn);
  wrap.appendChild(clearBtn);
  return wrap;
}

/** Preset select + address field + Enregistrer, for the `openai-compat`
 * provider only (goal G5). `baseUrl` is NOT a secret (docs/PROTOCOL.md) —
 * unlike buildApiKeyField(), the field IS prefilled from the broker's last
 * answer and stays filled after a save (the broker echoes it back). */
function buildBaseUrlField(baseUrl) {
  const wrap = document.createElement("div");
  wrap.className = "baseurl-field";

  const presetSelect = document.createElement("select");
  const customOption = document.createElement("option");
  customOption.value = "";
  customOption.textContent = t("options_other_address");
  presetSelect.appendChild(customOption);
  for (const preset of MODEL_PROVIDER_PRESETS) {
    const option = document.createElement("option");
    option.value = preset.baseUrl;
    option.textContent = preset.label;
    presetSelect.appendChild(option);
  }

  const input = document.createElement("input");
  input.type = "text";
  input.autocomplete = "off";
  input.placeholder = "http://localhost:1234/v1";
  input.value = baseUrl ?? "";

  // Reflect the current value in the preset select when it matches one
  // exactly — otherwise leave "Autre adresse" selected (a custom address, or
  // none yet).
  presetSelect.value = MODEL_PROVIDER_PRESETS.some((p) => p.baseUrl === baseUrl) ? baseUrl : "";

  const error = document.createElement("span");
  error.className = "baseurl-error";
  error.setAttribute("role", "status");

  presetSelect.addEventListener("change", () => {
    if (!presetSelect.value) return; // custom address — leave the field as is
    input.value = presetSelect.value;
    error.textContent = "";
    setBaseUrl(input.value);
  });

  const saveBtn = document.createElement("button");
  saveBtn.type = "button";
  saveBtn.textContent = t("options_save_address");
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

  wrap.appendChild(presetSelect);
  wrap.appendChild(input);
  wrap.appendChild(saveBtn);
  wrap.appendChild(error);
  return wrap;
}

/** "Tester la connexion" button + result line, shared by all three
 * providers (deliverable D2). */
function buildTestRow(providerId) {
  const row = document.createElement("div");
  row.className = "test-row";

  const button = document.createElement("button");
  button.type = "button";
  button.className = "test-button";
  button.textContent = t("options_test_connection");
  button.addEventListener("click", () => testProvider(providerId));
  testButtonsByProvider.set(providerId, button);

  const result = document.createElement("span");
  result.className = "test-result";
  result.setAttribute("role", "status");
  testResultsByProvider.set(providerId, result);

  row.appendChild(button);
  row.appendChild(result);
  return row;
}

function renderModelField(settings) {
  els.modelField.hidden = false;

  if (Array.isArray(settings.models) && settings.models.length > 0) {
    els.modelSelect.hidden = false;
    els.modelInput.hidden = true;
    els.modelSave.hidden = true;

    clearChildren(els.modelSelect);
    const placeholder = document.createElement("option");
    placeholder.value = "";
    placeholder.textContent = t("options_choose_model");
    els.modelSelect.appendChild(placeholder);
    for (const name of settings.models) {
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
    els.modelInput.value = settings.model ?? "";
    els.modelInput.placeholder =
      settings.provider === "claude-api"
        ? t("options_model_placeholder_claude")
        : settings.provider === "openai-compat"
          ? t("options_model_placeholder_openai_compat")
          : t("options_model_name_placeholder");
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
