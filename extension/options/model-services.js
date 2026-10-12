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
  providerEntry,
  serviceName,
  serviceState,
  onlineServices,
  keyInputs,
  openServiceDetails,
} from "./model-core.js";

// --- Tab "Online": configured services (zone Z2d) ------------------------

export function renderServices(settings) {
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

/** One row: name, "In use" tag, state; Utiliser / Tester / Retirer;
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

// "Remove" asks for a second click within this delay (same two-step
// pattern as the key component's "Delete the key", no native dialog).
const REMOVE_CONFIRM_MS = 5000;
// Service rows: armed "Remove" buttons, kept across re-renders.
const removeArmed = new Map(); // provider -> timer

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

/** "Remove": the local program forgets the service's key without
 * touching the active provider or model (`clearKey`, docs/PROTOCOL.md
 * amendement 2026-10-08 §9bis). openai-compat also drops its address: an
 * empty `baseUrl` is what makes the row go away (its `configured` means "an
 * address is set"), and it clears the key bound to that origin too. */
function removeService(providerId) {
  if (!lastSettings || status !== "connected") return;
  const patch = { type: "settings.set", id: newId(), clearKey: providerId };
  if (providerId === "openai-compat") patch.baseUrl = "";
  sendClientMessage(patch);
}

/** The shared key component (lib/key-input.js) for `providerId`. The
 * monthly spending cap is the tab's own block ("Spending cap"), not
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

/** "Add a service": one OpenAI-compatible service at a time — say so
 * when adding another would replace the configured one. */
export function renderAddService(settings) {
  const compat = providerEntry(settings, "openai-compat");
  const replaces = Boolean(settings && compat?.configured && !isLocalProvider("openai-compat", settings));
  els.addServiceReplaces.hidden = !replaces;
  els.addServiceReplaces.textContent = replaces
    ? t("options_add_service_replaces", [serviceName("openai-compat", settings)])
    : "";
  baseUrlField.setValue(settings?.provider === "openai-compat" ? settings.baseUrl : undefined);
}

/** "Spending cap": the paid services' own cap pages
 * (lib/setup-data.js); free and prepaid services need none. */
export function renderCapLinks() {
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

export function setProvider(provider, model) {
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
 * provider (goal G5), under "Add a service › Other address".
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
     * else "Other address". Never overwrites what the user is typing. */
    setValue(baseUrl) {
      if (document.activeElement !== input) input.value = baseUrl ?? "";
      presetSelect.value = MODEL_PROVIDER_PRESETS.some((p) => p.baseUrl === baseUrl) ? baseUrl : "";
    },
  };
}

// "Add a service › Other OpenAI-compatible address" (built once).
export const baseUrlField = buildBaseUrlField();
