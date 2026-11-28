// Welcome step 2: the way to an AI model. One radio per way; under the chosen one, the
// ONE action (download and check Ollama, sign in, or a key), then, once it works, the
// models to choose from. The pieces are the settings guide's own: lib/oauth-sign-in.js,
// lib/key-input.js, lib/model-list.js. More options live in Settings.

import { t } from "../lib/i18n-page.js";
import { providerLabel } from "../lib/labels.js";
import { createKeyInput } from "../lib/key-input.js";
import { chatgptSignInNodes, createOauthSignIn } from "../lib/oauth-sign-in.js";
import { groupModels, moduleLabelsFrom, readHost, renderModelList } from "../lib/model-list.js";
import { OLLAMA, OLLAMA_LIBRARY_URL, ONLINE_PROVIDERS, keyStoredFor } from "../lib/setup-data.js";

const service = (id) => ONLINE_PROVIDERS.find((entry) => entry.id === id);
// `name`/`desc` are locale keys. `services`: the services to choose from, first is the default.
const ACCESS = [
  { id: "local", name: "model_list_local", desc: "model_split_local_summary" },
  { id: "openrouter", name: "welcome_access_openrouter", desc: "welcome_access_openrouter_desc", services: ["openrouter"] },
  { id: "chatgpt", name: "welcome_access_chatgpt", desc: "welcome_access_chatgpt_desc", services: ["chatgpt"] },
  { id: "paid", name: "welcome_access_paid", desc: "welcome_access_paid_desc", services: ["claude", "openai", "mistral"] },
  { id: "free", name: "welcome_access_free", desc: "welcome_access_free_desc", services: ["google", "mistral"] },
];

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

function link(href, text, className = "c-text-link") {
  const a = el("a", className, text);
  a.href = href;
  a.target = "_blank";
  a.rel = "noopener noreferrer";
  return a;
}

/** Newest first, undated last; OpenRouter without credit: its free models only. */
function catalogOf(settings) {
  const entries = settings?.catalog?.length ? settings.catalog : (settings?.models ?? []).map((id) => ({ id }));
  const freeOnly = settings?.account?.boughtCredit === false && entries.some((entry) => entry.price === "free");
  return entries
    .filter((entry) => !freeOnly || entry.price === "free")
    .sort((a, b) => (a.created === undefined) - (b.created === undefined) || (b.created ?? 0) - (a.created ?? 0));
}

/**
 * @param {object} opts
 * @param {(payload: object) => void} opts.send   one client message to the local program
 * @param {() => string} opts.newId
 * @returns {{ element: HTMLElement, onStatus(connected: boolean): void, onBrokerMessage(reply: object): void }}
 */
export function mountAccessStep({ send, newId }) {
  let connected = false;
  let settings = null;
  let modelsReply = null;
  let way = null;
  let chosen = null; // the service picked under "paid" / "free" (or the only one)
  let keyState = null; // null: not checked, false: refused
  let ollamaOk = false;
  let keyInput = null;
  let signIns = [];
  let planSignature = null;
  const pending = new Map();

  const element = el("div", "welcome-body");
  const group = el("fieldset", "welcome-access");
  group.append(el("legend", "welcome-sr", t("welcome_step_access_title")));
  const detail = el("div", "welcome-body");
  const hostLine = el("span", "welcome-access-desc");
  for (const entry of ACCESS) {
    const row = el("label", "c-row welcome-access-option");
    const input = el("input");
    input.type = "radio";
    input.name = "welcomeAccess";
    input.value = entry.id;
    input.addEventListener("change", () => showWay(entry));
    row.append(input, el("span", "welcome-access-name", t(entry.name)), el("span", "welcome-access-desc", t(entry.desc)));
    if (entry.id === "local") row.append(hostLine);
    group.append(row);
  }
  const more = link("../options.html#setup", t("welcome_access_more"));
  element.append(group, detail, more);

  function request(payload, callback) {
    const id = newId();
    if (callback) pending.set(id, callback);
    send({ ...payload, id });
  }

  // --- The chosen way ----------------------------------------------------------

  const modelBox = el("div", "welcome-models");
  const status = el("p", "c-note");
  status.setAttribute("role", "status");
  const action = el("div", "welcome-body");

  function showWay(entry) {
    way = entry;
    chosen = entry.services ? service(entry.services[0]) : null;
    ollamaOk = false;
    keyState = null;
    status.textContent = "";
    detail.replaceChildren();
    if (entry.id === "local") return showLocal();
    if (entry.id === "paid") detail.append(el("p", "welcome-note", t("setup_online_which_claude_plan")));
    if (entry.services.length > 1) detail.append(servicePicker(entry));
    detail.append(action, status, modelBox);
    useService();
  }

  function showLocal() {
    const download = link(OLLAMA.downloadUrl, t("setup_local_download_ollama"), "c-button c-button--primary");
    const check = el("button", "c-button", t("setup_local_running_check"));
    check.type = "button";
    check.disabled = !connected;
    check.addEventListener("click", checkOllama);
    check.dataset.role = "check";
    const row = el("p", "welcome-links");
    row.append(download, check);
    detail.append(row, status, modelBox);
    refresh();
  }

  // The check never writes a model: choosing is done in the list below, once Ollama answers.
  function checkOllama() {
    status.textContent = t("setup_checking");
    const probe = () => request({ type: "provider.status" }, applyOllamaStatus);
    if (settings?.provider !== "ollama") request({ type: "settings.set", provider: "ollama" }, probe);
    else probe();
  }

  function applyOllamaStatus(result) {
    if (result?.type !== "provider.status-result" || result.provider !== "ollama" || result.state === "unknown") {
      status.textContent = t("setup_check_unknown");
    } else if (result.reason === "ollama-unreachable") {
      status.textContent = t("welcome_access_local_unreachable");
    } else {
      ollamaOk = true;
      status.textContent = t("setup_local_running_ok");
      request({ type: "models.list" });
    }
    refresh();
  }

  function servicePicker(entry) {
    const radios = el("fieldset", "welcome-access");
    radios.append(el("legend", "welcome-sr", t("setup_online_service_title")));
    for (const id of entry.services) {
      const item = service(id);
      const row = el("label", "c-row welcome-access-option");
      const input = el("input");
      input.type = "radio";
      input.name = "welcomeService";
      input.value = id;
      input.checked = item === chosen;
      input.addEventListener("change", () => {
        chosen = item;
        keyState = null;
        useService();
      });
      row.append(input, el("span", "welcome-access-name", item.name));
      radios.append(row);
    }
    return radios;
  }

  /** The service is picked: the local program makes it the active one, then shows its sign-in or key. */
  function useService() {
    keyInput = null;
    signIns = [];
    planSignature = null;
    status.textContent = "";
    action.replaceChildren();
    if (connected) {
      const patch = { type: "settings.set", provider: chosen.provider };
      if (chosen.baseUrl) patch.baseUrl = chosen.baseUrl;
      request(patch);
    }
    if (chosen.group === "plan") renderPlan();
    else if (chosen.oauth) renderOpenRouter();
    else renderKey();
    refresh();
  }

  function signInFor(opts = {}, onFailed) {
    const signIn = createOauthSignIn({ service: chosen, send, newId, t, isConnected: () => connected, onFailed, ...opts });
    signIns.push(signIn);
    return signIn;
  }

  function renderOpenRouter() {
    const keyPart = el("div", "welcome-body");
    keyPart.hidden = true;
    action.append(signInFor({}, () => (keyPart.hidden = false)).element, keyPart);
    appendKey(keyPart);
    action.append(el("p", "c-note", t("setup_online_free_warning")));
  }

  function renderKey() {
    appendKey(action);
    if (chosen.id === "google") action.append(el("p", "c-note", t("welcome_access_free_google")));
  }

  function appendKey(box) {
    if (chosen.keyPrefix) box.append(el("p", "c-note", t("setup_online_key_text", [chosen.keyPrefix])));
    keyInput = createKeyInput({
      provider: chosen.provider,
      send,
      newId,
      getBaseUrl: () => chosen.baseUrl,
      limitsUrl: way.id === "paid" && !chosen.prepaid ? chosen.limitsUrl : undefined,
      onVerified(ok, code) {
        // model-missing: the key works, the saved model is gone from the service.
        keyState = ok || code === "model-missing";
        refresh();
      },
    });
    keyInput.setConnected(connected);
    keyInput.update(entryFor(chosen.provider));
    box.append(keyInput.element, link(chosen.keysUrl, t("setup_online_keys_page")));
  }

  function renderPlan() {
    const account = settings?.provider === chosen.provider ? settings.account : null;
    const signature = `${Boolean(account?.signedIn)}|${Boolean(account?.planUsage)}|${Boolean(account?.revokeUnconfirmed)}`;
    if (signature === planSignature) return;
    planSignature = signature;
    signIns = [];
    const nodes = chatgptSignInNodes(account, (opts) => signInFor(opts), t);
    if (nodes.length === 0) nodes.push(el("p", "c-note", t("setup_chatgpt_welcome")));
    action.replaceChildren(...nodes);
  }

  function entryFor(providerId) {
    return (settings?.available ?? []).find((p) => p.id === providerId) ?? null;
  }

  // --- Once it works: the models -------------------------------------------------

  function serviceReady() {
    if (chosen.group === "plan") return Boolean(settings?.provider === "chatgpt" && settings.account?.signedIn && settings.account.planUsage);
    return keyStoredFor(chosen, settings) && keyState !== false;
  }

  function refresh() {
    if (!way) return;
    if (way.id === "local") return renderLocalModels();
    if (chosen.group === "plan") renderPlan();
    if (chosen.oauth && chosen.group !== "plan") {
      for (const signIn of signIns) signIn.element.hidden = serviceReady();
      if (serviceReady()) status.textContent = t("keyInput_saved");
    }
    if (!serviceReady()) return modelBox.replaceChildren();
    const select = el("select", "c-field c-input");
    select.setAttribute("aria-label", t("options_model_title"));
    const none = el("option", null, t("options_model_title"));
    none.value = "";
    none.disabled = true;
    select.append(none);
    for (const entry of catalogOf(settings)) {
      const option = el("option", null, entry.name ?? entry.id);
      option.value = entry.id;
      select.append(option);
    }
    select.value = settings.model ?? "";
    select.addEventListener("change", () => request({ type: "settings.set", provider: chosen.provider, model: select.value }));
    modelBox.replaceChildren(select);
    if (settings?.account?.boughtCredit === false) modelBox.append(el("p", "c-note", t("options_model_no_credit")));
  }

  function renderLocalModels() {
    if (!ollamaOk || !modelsReply) return modelBox.replaceChildren();
    const reply = { ...modelsReply, current: { provider: settings?.provider ?? null, model: settings?.model ?? null } };
    if (groupModels(reply).local.length === 0) {
      const none = el("p", "c-note", t("welcome_access_local_none"));
      none.append(" ", link(OLLAMA_LIBRARY_URL, t("setup_local_find_ollama")));
      return modelBox.replaceChildren(none);
    }
    renderModelList(modelBox, reply, {
      t,
      providerLabel,
      moduleLabels: moduleLabelsFrom(settings),
      baseUrl: settings?.baseUrl,
      mode: "list",
      localOnly: true,
      idPrefix: "welcomeModels",
      onPick: (entry) => !entry.current && request({ type: "settings.set", provider: entry.provider, model: entry.model }),
    });
  }

  function applyModels(reply) {
    modelsReply = reply;
    const host = readHost(reply.host);
    if (host) hostLine.textContent = t("setup_local_host_ram", [host.ramGb.toLocaleString(document.documentElement.lang || undefined)]);
    refresh();
  }

  return {
    element,
    onStatus(next) {
      connected = next;
      for (const button of detail.querySelectorAll('[data-role="check"]')) button.disabled = !connected;
      for (const signIn of signIns) signIn.button.disabled = !connected;
      keyInput?.setConnected(connected);
      if (connected) request({ type: "models.list" });
    },
    onBrokerMessage(reply) {
      keyInput?.handleBrokerMessage(reply);
      for (const signIn of signIns) signIn.handleBrokerMessage(reply);
      const callback = reply.id && pending.get(reply.id);
      if (callback) {
        pending.delete(reply.id);
        callback(reply);
      }
      if (reply.type === "settings") {
        settings = reply;
        keyInput?.update(chosen ? entryFor(chosen.provider) : null);
        refresh();
        request({ type: "models.list" });
      }
      if (reply.type === "models") applyModels(reply);
    },
  };
}
