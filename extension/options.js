// Coati options page — pairing token entry.
//
// The token is a secret: it MUST live in chrome.storage.session (wiped when
// the browser closes), never chrome.storage.local (unencrypted on disk).

import { api, IS_GECKO } from "./lib/browser-compat.js";
import { providerLabel, describeProviderUnavailable, CONNECTION_STATUS_LABELS } from "./lib/labels.js";
import { RETENTION_DAYS_KEY, parseStoredRetentionDays } from "./panel/retention.js";

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
  retention: document.getElementById("retention"),
  siteToggles: document.getElementById("siteToggles"),
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
  "claude-api": "Votre propre clé Anthropic, facturée sur votre compte.",
  ollama: "Un modèle qui tourne sur votre machine : rien n'en sort.",
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
  // docs/PROTOCOL.md "Collage (options, Firefox)": write-only field, never
  // pre-filled with the token/secret in memory — nothing read from
  // chrome.storage.session here.

  // Bug report gap 7: this help text used to say "Chrome" unconditionally,
  // wrong under Firefox — same IS_GECKO detection panel.js already uses for
  // its own browser-specific text (see applyConnectionBanner()).
  els.siteTogglesHelp.textContent = IS_GECKO
    ? "Sans cette autorisation, Firefox cache à l'extension quel site est ouvert dans l'onglet, donc le bouton principal reste générique tant que vous n'avez pas cliqué dessus."
    : "Sans cette autorisation, Chrome cache à l'extension quel site est ouvert dans l'onglet, donc le bouton principal reste générique tant que vous n'avez pas cliqué dessus.";

  const data = await api.storage.local.get(RETENTION_DAYS_KEY);
  const retentionDays = parseStoredRetentionDays(data[RETENTION_DAYS_KEY]);
  els.retention.value = retentionDays === null ? "never" : String(retentionDays);

  els.save.addEventListener("click", () => applyToken(els.token.value.trim()));
  // The spec's primary flow is a paste (Firefox: the /pair secret; Chromium
  // never needs this field at all). Read the value on the next tick — the
  // "paste" event fires before the input's own value is updated — and apply
  // it right away, without waiting for a click on "Enregistrer".
  els.token.addEventListener("paste", () => {
    setTimeout(() => applyToken(els.token.value.trim()), 0);
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

// docs/PROTOCOL.md "Collage (options, Firefox)": a non-empty value is stored
// and reconnects immediately (cancelling any backoff in progress); an empty
// value clears the stored token instead of storing "". Delegated to the
// service worker (message "coati:set-token") rather than writing
// chrome.storage.session directly here, so the same force-reconnect path
// always runs right after — see service-worker.js.
async function applyToken(value) {
  await api.runtime.sendMessage({ type: "coati:set-token", token: value }).catch(() => null);
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
  els.status.className = `status status--${state}`;
  els.statusLabel.textContent = CONNECTION_STATUS_LABELS[state] ?? state;

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

function testProvider(providerId) {
  if (testingProviders.has(providerId)) return;
  testingProviders.add(providerId);
  const button = testButtonsByProvider.get(providerId);
  if (button) {
    button.disabled = true;
    button.textContent = "Test en cours…";
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
    button.textContent = "Tester la connexion";
  }
  const result = testResultsByProvider.get(message.provider);
  if (result) {
    result.textContent = message.message || (message.ok ? "OK" : "Échec");
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
  clearChildren(els.providerList);
  testButtonsByProvider.clear();
  testResultsByProvider.clear();

  if (!settings) {
    els.modelField.hidden = true;
    return;
  }

  for (const provider of settings.available) {
    const item = document.createElement("li");
    item.className = "provider-item";

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
    item.appendChild(label);

    const description = document.createElement("p");
    description.className = "provider-description";
    description.textContent = PROVIDER_DESCRIPTIONS[provider.id] ?? "";
    item.appendChild(description);

    if (provider.configured) {
      const configured = document.createElement("span");
      configured.className = "provider-configured";
      configured.textContent = provider.id === "claude-api" ? "clé enregistrée" : "configuré";
      item.appendChild(configured);
    }

    if (!provider.available && provider.reason) {
      // `provider.reason` is free-text English straight from the broker
      // (broker/src/providers/*.ts) — never shown alone. describeProviderUnavailable()
      // gives it a French label and demotes the broker's own words to a
      // secondary "Détail : …" line (bug report gap 3).
      const reason = document.createElement("span");
      reason.className = "provider-reason";
      // white-space: pre-line lets the \n from describeProviderUnavailable()
      // render as a real line break — see options.css.
      reason.textContent = `— ${describeProviderUnavailable(provider.reason)}`;
      item.appendChild(reason);
    }

    if (provider.id === "claude-api") {
      item.appendChild(buildApiKeyField());
    }

    item.appendChild(buildTestRow(provider.id));

    els.providerList.appendChild(item);
  }

  renderModelField(settings);
}

/** Password field + Enregistrer/Effacer for the `claude-api` provider
 * (deliverable D2). The field starts empty on every load and after every
 * save — the broker never echoes the key back (write-only by contract), so
 * there is nothing to prefill it with. */
function buildApiKeyField() {
  const wrap = document.createElement("div");
  wrap.className = "apikey-field";

  const input = document.createElement("input");
  input.type = "password";
  input.autocomplete = "off";
  input.placeholder = "Clé API Anthropic (sk-ant-…)";

  const saveBtn = document.createElement("button");
  saveBtn.type = "button";
  saveBtn.textContent = "Enregistrer";
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
  clearBtn.textContent = "Effacer la clé";
  clearBtn.addEventListener("click", () => {
    if (!clearConfirmPending) {
      clearConfirmPending = true;
      clearBtn.textContent = "Confirmer l'effacement";
      clearBtn.classList.add("apikey-clear--confirm");
      clearConfirmTimer = setTimeout(() => {
        clearConfirmPending = false;
        clearBtn.textContent = "Effacer la clé";
        clearBtn.classList.remove("apikey-clear--confirm");
      }, CLEAR_CONFIRM_MS);
      return;
    }
    clearConfirmPending = false;
    clearTimeout(clearConfirmTimer);
    clearBtn.textContent = "Effacer la clé";
    clearBtn.classList.remove("apikey-clear--confirm");
    setApiKey("");
    input.value = "";
  });

  wrap.appendChild(input);
  wrap.appendChild(saveBtn);
  wrap.appendChild(clearBtn);
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
  button.textContent = "Tester la connexion";
  button.addEventListener("click", () => testProvider(providerId));
  testButtonsByProvider.set(providerId, button);

  const result = document.createElement("span");
  result.className = "test-result";
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
    placeholder.textContent = "Choisir un modèle…";
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
  }
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
