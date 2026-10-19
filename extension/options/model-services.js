// Coati options page — online services list, key management, "Add a
// service", model name field.

import { t } from "../lib/i18n-page.js";
import { createKeyInput } from "../lib/key-input.js";
import { ONLINE_PROVIDERS } from "../lib/setup-data.js";
import { MODEL_PROVIDER_PRESETS, isAllowedBaseUrl } from "../lib/model-provider-presets.js";
import { sameModel } from "../lib/model-list.js";
import { els } from "./dom-refs.js";
import { el, buttonEl, newId, clearChildren, sendClientMessage } from "./dom-helpers.js";
import { testTargets, registerTestTarget, testProvider } from "./provider-tests.js";
import {
  status,
  lastSettings,
  modelsReply,
  modelsUnsupported,
  isLocalProvider,
  serviceName,
  serviceState,
  onlineServices,
  keyInputs,
  openServiceDetails,
} from "./model-core.js";

// --- "Online" side: configured services (zone Z2d) ----------------------

export function renderServices(settings) {
  // The model field and the key components are re-parented below: park the
  // field first, remember the focus to give it back after the rebuild.
  const focused = els.serviceList.contains(document.activeElement) ? document.activeElement : null;
  els.modelSection.appendChild(els.modelField);
  els.serviceList.replaceChildren();
  for (const key of [...testTargets.keys()]) if (key.startsWith("row:")) testTargets.delete(key);

  const services = settings ? onlineServices(settings) : [];
  els.servicesBlock.hidden = services.length === 0;
  for (const entry of services) els.serviceList.appendChild(buildServiceRow(entry, settings));
  if (focused?.isConnected && document.activeElement !== focused) focused.focus({ preventScroll: true });
}

/** One row: name, "In use" tag, state; the active row then shows its model and its folded key;
 * Use / Test / Remove last. */
function buildServiceRow(entry, settings) {
  const active = entry.active;
  const row = el("li", active ? "c-card service service--active" : "c-card service");
  // Stable anchor for the panel's deep link (#provider-<id>); with several openai-compat
  // services, the active one carries it.
  if (entry.id !== "openai-compat" || active) row.id = `provider-${entry.id}`;

  const head = el("div", "service-head");
  // The service in use is marked as the panel marks the current model: ✓ and
  // a caramel name, plus the "In use" chip.
  if (active) head.append(el("span", "model-item-check", "✓")); // i18n-allow: symbol
  head.append(el("span", "service-name", serviceName(entry.id, settings, entry.baseUrl)));
  if (active) head.append(el("span", "c-chip c-chip--active", t("options_service_active")));
  const state = serviceState(entry);
  const stateNode = el("span", "service-state", state.text);
  stateNode.dataset.tone = state.tone;
  head.append(stateNode);

  const actions = el("div", "service-actions");
  const connected = status === "connected";
  if (!active) {
    const use = buttonEl(t("options_service_use"), "c-button c-button--small");
    use.disabled = !connected;
    use.addEventListener("click", () => setProvider(entry.id, undefined, entry.baseUrl));
    actions.append(use);
  }
  // settings.test probes the active address: an inactive openai-compat service is tested once in use.
  const testable = entry.id !== "openai-compat" || active;
  const test = buttonEl(t("options_test_short"), "c-button c-button--small test-button");
  test.addEventListener("click", () => testProvider(entry.id, "row"));
  if (testable) actions.append(test);
  if (entry.id === "claude-api" || entry.id === "openai-compat") actions.append(buildRemoveButton(entry));

  const result = el("span", "test-result service-result");
  result.setAttribute("role", "status");
  row.append(head);
  // The active row reads in order: the model to use, its key (folded), then Test / Remove.
  if (active) {
    row.append(els.modelField);
    if (entry.id === "claude-api" || entry.id === "openai-compat") {
      const details = el("details", "fold fold--inner service-details");
      details.open = openServiceDetails.has(entry.key) || !entry.configured;
      details.addEventListener("toggle", () => {
        if (details.open) openServiceDetails.add(entry.key);
        else openServiceDetails.delete(entry.key);
      });
      const keyInput = keyInputFor(entry.id);
      keyInput.update(entry.id === "openai-compat" ? { ...entry, configured: entry.hasKey } : entry);
      const body = el("div", "fold-body");
      body.append(keyInput.element);
      details.append(el("summary", null, t("options_service_key")), body);
      row.append(details);
    }
  }
  row.append(actions, result);
  if (testable) registerTestTarget("row", entry.id, test, result);
  return row;
}

// "Remove" asks for a second click within this delay (same two-step
// pattern as the key component's "Delete the key", no native dialog).
const REMOVE_CONFIRM_MS = 5000;
// Service rows: armed "Remove" buttons, kept across re-renders.
const removeArmed = new Map(); // service key -> timer

function buildRemoveButton(entry) {
  const button = buttonEl(t("options_service_remove"), "c-button c-button--small c-button--danger service-remove");
  button.disabled = status !== "connected";
  const paintArmed = (armed) => {
    button.textContent = armed ? t("options_service_remove_confirm") : t("options_service_remove");
    button.classList.toggle("is-armed", armed);
  };
  paintArmed(removeArmed.has(entry.key));
  button.addEventListener("click", () => {
    if (!removeArmed.has(entry.key)) {
      const timer = setTimeout(() => {
        removeArmed.delete(entry.key);
        if (button.isConnected) paintArmed(false);
      }, REMOVE_CONFIRM_MS);
      removeArmed.set(entry.key, timer);
      paintArmed(true);
      return;
    }
    clearTimeout(removeArmed.get(entry.key));
    removeArmed.delete(entry.key);
    removeService(entry);
  });
  return button;
}

/** "Remove": the local program forgets the service and its key (`clearKey` for Claude,
 * `removeBaseUrl` for an openai-compat service, docs/PROTOCOL.md); the active provider and model
 * stay as they are. */
function removeService(entry) {
  if (!lastSettings || status !== "connected") return;
  const patch = { type: "settings.set", id: newId() };
  if (entry.id === "openai-compat") patch.removeBaseUrl = entry.baseUrl;
  else patch.clearKey = entry.id;
  sendClientMessage(patch);
}

/** The shared key component (lib/key-input.js) for `providerId`. The
 * monthly spending cap is the side's own block ("Spending cap"), not
 * repeated under the field. */
function keyInputFor(providerId) {
  let keyInput = keyInputs.get(providerId);
  if (!keyInput) {
    keyInput = createKeyInput({
      provider: providerId,
      send: sendClientMessage,
      newId,
      getBaseUrl: () => lastSettings?.baseUrl,
      placeholder:
        providerId === "openai-compat" ? t("options_apikey_placeholder_optional") : t("options_apikey_placeholder_anthropic"),
    });
    keyInput.setConnected(status === "connected");
    keyInputs.set(providerId, keyInput);
  }
  return keyInput;
}

/** "Add a service": the address field mirrors the active openai-compat address. */
export function renderAddService(settings) {
  baseUrlField.setValue(settings?.provider === "openai-compat" ? settings.baseUrl : undefined);
}

/** "Spending cap": the paid services' own cap pages
 * (lib/setup-data.js); free and prepaid services need none. */
export function renderCapLinks() {
  const paid = ONLINE_PROVIDERS.filter((service) => service.limitsUrl && service.group !== "free" && !service.prepaid);
  paid.forEach((service, index) => {
    if (index > 0) els.capLinks.append(" · ");
    const link = el("a", "c-text-link", service.name);
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
export function placeModelField(settings) {
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

export function setProvider(provider, model, baseUrl) {
  const payload = { type: "settings.set", id: newId() };
  if (provider !== undefined) payload.provider = provider;
  if (model !== undefined) payload.model = model;
  if (baseUrl !== undefined) payload.baseUrl = baseUrl;
  sendClientMessage(payload);
}

// baseUrl is NOT a secret (docs/PROTOCOL.md) —
// unlike apiKey (lib/key-input.js), the broker echoes it back in the next `settings`
// message, so it is safe (and expected) to keep it visible in the address
// input rather than clearing it after every save. Sent without `provider`:
// saving an address never switches the active model.
function setBaseUrl(baseUrl) {
  sendClientMessage({ type: "settings.set", id: newId(), baseUrl });
}

/** Preset select + address field + Enregistrer, for the `openai-compat`
 * provider, under "Add a service › Other address".
 * `baseUrl` is NOT a secret (docs/PROTOCOL.md) — prefilled from the broker's
 * last answer when openai-compat is active, kept after a save. */
function buildBaseUrlField() {
  const wrap = el("div", "baseurl-field");

  const presetSelect = el("select", "c-field c-input");
  presetSelect.setAttribute("aria-label", t("options_other_address_title"));
  const customOption = el("option", null, t("options_other_address"));
  customOption.value = "";
  presetSelect.appendChild(customOption);
  for (const preset of MODEL_PROVIDER_PRESETS) {
    const option = el("option", null, preset.label);
    option.value = preset.baseUrl;
    presetSelect.appendChild(option);
  }

  const input = el("input", "c-field c-input");
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

  const saveBtn = buttonEl(t("options_save_address"), "c-button");
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
     * else "Other address". Never overwrites what the user is typing. */
    setValue(baseUrl) {
      if (document.activeElement !== input) input.value = baseUrl ?? "";
      presetSelect.value = MODEL_PROVIDER_PRESETS.some((p) => p.baseUrl === baseUrl) ? baseUrl : "";
    },
  };
}

// "Add a service › Other OpenAI-compatible address" (built once).
export const baseUrlField = buildBaseUrlField();
