// "Connecter un modèle d'IA" — the step-by-step guide inside the settings
// page (goal U2). Opened by `options.html#setup` (contract with the panel:
// its "never connected" message and "?" button open that URL).
//
// Two paths, chosen on the first screen:
//   local  — Ollama (LM Studio under a collapsed « Avancé »): install, check
//            it answers, pull a model sized to the machine's memory;
//   online — OpenRouter free models first, then Claude and OpenAI (paid),
//            Mistral and DeepSeek under « Autres »; create a key, paste it in
//            the shared key component (lib/key-input.js).
// Both end on « Essayer sur une page ». Each step is ticked as soon as the
// existing probes say it succeeded (provider.status for Ollama,
// settings.test through the key component) — never on a click alone.
//
// Every provider fact (URLs, models, prices, quotas) comes from
// lib/setup-data.js; every sentence from _locales (`setup_*` keys). No
// innerHTML: nodes built one by one.

import { t } from "./lib/i18n-page.js";
import { createKeyInput } from "./lib/key-input.js";
import {
  OLLAMA_DOWNLOADS,
  OLLAMA_LINUX_INSTALL_COMMAND,
  OLLAMA_START_COMMAND,
  OLLAMA_MODELS_BY_MEMORY,
  LM_STUDIO,
  ONLINE_PROVIDERS,
  COST_BASIS_WORDS,
} from "./lib/setup-data.js";

const OS_NAMES = { windows: "Windows", mac: "macOS", linux: "Linux" };

/** "windows" | "mac" | "linux" | null — from User-Agent Client Hints when
 * available (Chromium), else the legacy navigator.platform (Firefox). */
export function detectOs(nav = globalThis.navigator) {
  const raw = String(nav?.userAgentData?.platform || nav?.platform || "").toLowerCase();
  if (raw.startsWith("win")) return "windows";
  if (raw.startsWith("mac")) return "mac";
  if (raw.includes("linux") && !raw.includes("android")) return "linux";
  return null;
}

/** Index of the OLLAMA_MODELS_BY_MEMORY row that likely fits this machine,
 * or -1 when the browser does not tell. navigator.deviceMemory is coarse and
 * capped at 8 (Chromium), so ">= 8" can mean any bigger machine too. */
export function suggestedModelRow(deviceMemory, rows = OLLAMA_MODELS_BY_MEMORY) {
  if (typeof deviceMemory !== "number" || !(deviceMemory > 0)) return -1;
  let index = 0;
  rows.forEach((row, i) => {
    if (deviceMemory >= row.minGb) index = i;
  });
  return index;
}

/** Same model, tolerating Ollama's implicit ":latest" tag. */
function sameModel(a, b) {
  if (!a || !b) return false;
  const norm = (name) => (name.includes(":") ? name : `${name}:latest`);
  return norm(a) === norm(b);
}

function uiLocale() {
  return (document.documentElement.lang || "fr").replace("_", "-");
}

function formatUsd(amount) {
  try {
    return new Intl.NumberFormat(uiLocale(), {
      style: "currency",
      currency: "USD",
      maximumSignificantDigits: 1,
    }).format(amount);
  } catch {
    return `$${amount}`;
  }
}

function formatNumber(value) {
  try {
    return new Intl.NumberFormat(uiLocale()).format(value);
  } catch {
    return String(value);
  }
}

// --- Tiny DOM helper (this file only) -----------------------------------------

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

function externalLink(href, text, className = "link") {
  const a = el("a", className, text);
  a.href = href;
  a.target = "_blank";
  a.rel = "noopener noreferrer";
  return a;
}

/** A command line + « Copier » button. Writing to the clipboard on a click is
 * fine; Coati never READS the clipboard. */
function commandLine(command) {
  const wrap = el("div", "setup-command");
  const code = el("code", "setup-command-text", command);
  const copy = el("button", "button-secondary setup-copy", t("setup_copy"));
  copy.type = "button";
  copy.addEventListener("click", async () => {
    let ok = false;
    try {
      await navigator.clipboard.writeText(command);
      ok = true;
    } catch {
      // Fallback: select the text so Ctrl+C works.
      const range = document.createRange();
      range.selectNodeContents(code);
      const selection = window.getSelection();
      selection?.removeAllRanges();
      selection?.addRange(range);
    }
    copy.textContent = ok ? t("setup_copied") : t("setup_copy_manual");
    setTimeout(() => {
      copy.textContent = t("setup_copy");
    }, 2000);
  });
  wrap.append(code, copy);
  return wrap;
}

/** One numbered step. `setState("todo"|"busy"|"done"|"failed", text?)`. */
function makeStep(number, title) {
  const li = el("li", "setup-step");
  li.dataset.state = "todo";
  const mark = el("span", "setup-step-mark", String(number));
  mark.setAttribute("aria-hidden", "true");
  const main = el("div", "setup-step-main");
  const heading = el("h3", "setup-step-title", title);
  const body = el("div", "setup-step-body");
  const result = el("p", "setup-step-result");
  result.setAttribute("role", "status");
  result.hidden = true;
  main.append(heading, body, result);
  li.append(mark, main);

  function setState(state, text) {
    li.dataset.state = state;
    mark.textContent = state === "done" ? "✓" : state === "failed" ? "!" : String(number); // i18n-allow: symbols
    heading.dataset.done = String(state === "done");
    result.textContent = text ?? "";
    result.hidden = !text;
  }
  return { li, body, setState, get state() {
    return li.dataset.state;
  } };
}

function actionButton(text, className) {
  const button = el("button", className, text);
  button.type = "button";
  return button;
}

/**
 * @param {object} opts
 * @param {HTMLDetailsElement} opts.root      the #setup <details>
 * @param {(payload: object) => void} opts.send
 * @param {() => string} opts.newId
 */
export function mountSetupGuide({ root, send, newId }) {
  const summary = root.querySelector("summary");
  const pathButtons = [...root.querySelectorAll(".setup-path")];
  const localWrap = root.querySelector("#setupLocal");
  const onlineWrap = root.querySelector("#setupOnline");
  const notice = root.querySelector("#setupNotConnected");

  let settings = null;
  let connected = false;
  // request id -> callback(message), for settings.set / provider.status
  // replies this guide is waiting on.
  const pending = new Map();
  const checkButtons = [];

  const os = detectOs();
  const suggestedRow = suggestedModelRow(navigator.deviceMemory);
  let chosenModel = OLLAMA_MODELS_BY_MEMORY[Math.max(0, suggestedRow)].model;

  // --- Path choice -------------------------------------------------------------

  for (const button of pathButtons) {
    button.addEventListener("click", () => choosePath(button.dataset.path));
  }

  function choosePath(path) {
    for (const button of pathButtons) {
      button.setAttribute("aria-pressed", String(button.dataset.path === path));
    }
    localWrap.hidden = path !== "local";
    onlineWrap.hidden = path !== "online";
    const target = path === "local" ? localWrap : onlineWrap;
    target.querySelector(".setup-step-title")?.scrollIntoView?.({ block: "nearest" });
  }

  // --- Local path: Ollama ------------------------------------------------------

  const localList = el("ol", "setup-steps");
  const install = makeStep(1, t("setup_local_install_title"));
  const running = makeStep(2, t("setup_local_running_title"));
  const model = makeStep(3, t("setup_local_model_title"));
  const tryLocal = makeStep(4, t("setup_try_title"));
  localList.append(install.li, running.li, model.li, tryLocal.li);

  // Step 1 — download + start.
  install.body.append(el("p", "setup-text", t("setup_local_install_text")));
  const downloads = el("p", "setup-links");
  if (os) {
    downloads.append(externalLink(OLLAMA_DOWNLOADS[os], t("setup_local_download_for", [OS_NAMES[os]]), "setup-primary-link"));
  }
  const otherOs = el("span", "setup-other-os");
  otherOs.append(os ? t("setup_local_other_os") : t("setup_local_download"), " ");
  Object.keys(OLLAMA_DOWNLOADS)
    .filter((key) => key !== os)
    .forEach((key, i) => {
      if (i > 0) otherOs.append(" · ");
      otherOs.append(externalLink(OLLAMA_DOWNLOADS[key], OS_NAMES[key]));
    });
  downloads.append(otherOs);
  install.body.append(downloads);
  if (os === "linux") {
    install.body.append(el("p", "setup-text", t("setup_local_linux_install")), commandLine(OLLAMA_LINUX_INSTALL_COMMAND));
  }
  install.body.append(el("p", "setup-text", t("setup_local_start_intro")));
  const startList = el("ul", "setup-os-list");
  for (const key of os ? [os] : Object.keys(OS_NAMES)) {
    const li = el("li", null);
    if (!os) li.append(el("strong", null, OS_NAMES[key]), " — ");
    li.append(t(`setup_local_start_${key}`));
    startList.append(li);
  }
  install.body.append(startList);
  if (os === "linux" || !os) install.body.append(commandLine(OLLAMA_START_COMMAND));

  // Step 2 — is Ollama answering?
  running.body.append(el("p", "setup-text", t("setup_local_running_text")));
  const runningCheck = actionButton(t("setup_local_running_check"), "setup-check setup-check-ollama");
  runningCheck.addEventListener("click", () => checkOllama(false));
  checkButtons.push(runningCheck);
  running.body.append(runningCheck);

  // Step 3 — pick and pull a model.
  model.body.append(el("p", "setup-text", t("setup_local_model_text")));
  model.body.append(
    el(
      "p",
      "help help--tight setup-memory-hint",
      suggestedRow === -1 ? t("setup_local_memory_unknown") : t("setup_local_memory_known", [String(navigator.deviceMemory)]),
    ),
  );
  const table = el("table", "setup-models");
  const thead = el("thead");
  const headRow = el("tr");
  headRow.append(
    el("th", null, t("setup_local_col_memory")),
    el("th", null, t("setup_local_col_model")),
    el("th", null, t("setup_local_col_size")),
  );
  thead.append(headRow);
  const tbody = el("tbody");
  OLLAMA_MODELS_BY_MEMORY.forEach((row, i) => {
    const tr = el("tr", i === suggestedRow ? "setup-model-row setup-model-row--suggested" : "setup-model-row");
    const memoryCell = el("td");
    const label = el("label", "setup-model-choice");
    const radio = el("input");
    radio.type = "radio";
    radio.name = "setupModel";
    radio.value = row.model;
    radio.checked = row.model === chosenModel;
    radio.addEventListener("change", () => {
      if (!radio.checked) return;
      chosenModel = row.model;
      refreshPullCommand();
    });
    label.append(radio, t("setup_local_memory_row", [formatNumber(row.minGb)]));
    memoryCell.append(label);
    if (i === suggestedRow) memoryCell.append(" ", el("span", "setup-tag", t("setup_local_suggested")));
    tr.append(memoryCell, el("td", "setup-model-name", row.model), el("td", null, t("setup_size_gb", [formatNumber(row.downloadGb)])));
    tbody.append(tr);
  });
  table.append(thead, tbody);
  const tableWrap = el("div", "setup-table-wrap");
  tableWrap.append(table);
  model.body.append(tableWrap);
  model.body.append(el("p", "setup-text", t("setup_local_pull_text")));
  // Rebuild the copy button so it copies the CURRENT model's command.
  const pullSlot = el("div", "setup-pull-slot");
  model.body.append(pullSlot);
  function refreshPullCommand() {
    pullSlot.replaceChildren(commandLine(`ollama pull ${chosenModel}`));
  }
  refreshPullCommand();
  const modelCheck = actionButton(t("setup_local_model_check"), "setup-check setup-check-model");
  modelCheck.addEventListener("click", () => checkOllama(true));
  checkButtons.push(modelCheck);
  model.body.append(modelCheck);

  // Step 4 — try it.
  tryLocal.body.append(el("p", "setup-text", t("setup_try_text")));

  // Advanced: LM Studio.
  const lmStudio = el("details", "setup-advanced");
  const lmSummary = el("summary", null, t("setup_lmstudio_title"));
  const lmBody = el("div", "setup-advanced-body");
  lmBody.append(el("p", "setup-text", t("setup_lmstudio_text")));
  const lmLinks = el("p", "setup-links");
  lmLinks.append(externalLink(LM_STUDIO.downloadUrl, t("setup_lmstudio_download")));
  lmBody.append(lmLinks);
  const lmButton = actionButton(t("setup_lmstudio_use"), "button-secondary setup-check setup-check-lmstudio");
  const lmResult = el("p", "setup-step-result");
  lmResult.setAttribute("role", "status");
  lmResult.hidden = true;
  let lmTestId = null;
  lmButton.addEventListener("click", () => {
    if (!connected) return;
    lmResult.hidden = false;
    lmResult.dataset.tone = "neutral";
    lmResult.textContent = t("setup_checking");
    request({ type: "settings.set", provider: "openai-compat", baseUrl: LM_STUDIO.baseUrl }, () => {
      lmTestId = newId();
      send({ type: "settings.test", id: lmTestId, provider: "openai-compat" });
    });
  });
  checkButtons.push(lmButton);
  lmBody.append(lmButton, lmResult);
  lmStudio.append(lmSummary, lmBody);

  localWrap.append(localList, lmStudio);

  function checkOllama(withModel) {
    if (!connected) return;
    const target = withModel ? model : running;
    target.setState("busy", t("setup_checking"));
    const patch = {};
    if (settings?.provider !== "ollama") patch.provider = "ollama";
    // The user picked this row: make it the configured model, so the check
    // below answers about THAT model (model-missing until it is pulled).
    if (withModel && !sameModel(settings?.model, chosenModel)) patch.model = chosenModel;
    const probe = () => request({ type: "provider.status" }, (result) => applyOllamaStatus(result, withModel));
    if (Object.keys(patch).length > 0) {
      if (!patch.provider) patch.provider = "ollama";
      request({ type: "settings.set", ...patch }, probe);
    } else {
      probe();
    }
  }

  function applyOllamaStatus(result, withModel) {
    const reason = result?.reason;
    if (result?.type !== "provider.status-result" || result.provider !== "ollama") {
      (withModel ? model : running).setState("failed", t("setup_check_unknown"));
      return;
    }
    if (reason === "ollama-unreachable") {
      install.setState("todo");
      running.setState("failed", t("setup_local_unreachable"));
      if (withModel) model.setState("todo");
      return;
    }
    if (result.state === "unknown") {
      (withModel ? model : running).setState("failed", t("setup_check_unknown"));
      return;
    }
    install.setState("done");
    running.setState("done", t("setup_local_running_ok"));
    if (reason === "ready") {
      model.setState("done", t("setup_local_model_ok"));
    } else if (reason === "model-missing") {
      model.setState(withModel ? "failed" : "todo", t("setup_local_model_missing", [settings?.model || chosenModel]));
    } else if (reason === "no-model-installed") {
      model.setState(withModel ? "failed" : "todo", t("setup_local_no_model"));
    } else {
      model.setState("failed", t("setup_check_unknown"));
    }
  }

  // --- Online path -------------------------------------------------------------

  const onlineList = el("ol", "setup-steps");
  const service = makeStep(1, t("setup_online_service_title"));
  const account = makeStep(2, t("setup_online_account_title"));
  const key = makeStep(3, t("setup_online_key_title"));
  const tryOnline = makeStep(4, t("setup_try_title"));
  onlineList.append(service.li, account.li, key.li, tryOnline.li);
  onlineWrap.append(onlineList);

  // Step 1 — said BEFORE the choice: free models may keep the texts.
  const warning = el("p", "setup-warning", t("setup_online_free_warning"));
  service.body.append(warning);
  const serviceList = el("div", "setup-services");
  serviceList.setAttribute("role", "radiogroup");
  serviceList.setAttribute("aria-label", t("setup_online_service_title"));
  const serviceRadios = new Map();
  const others = el("details", "setup-advanced setup-others");
  others.append(el("summary", null, t("setup_online_others")));
  const othersBody = el("div", "setup-services");
  others.append(othersBody);
  for (const entry of ONLINE_PROVIDERS) {
    const option = el("label", "setup-service");
    option.dataset.service = entry.id;
    const radio = el("input");
    radio.type = "radio";
    radio.name = "setupService";
    radio.value = entry.id;
    radio.addEventListener("change", () => {
      if (radio.checked) chooseService(entry);
    });
    serviceRadios.set(entry.id, radio);
    const text = el("span", "setup-service-text");
    text.append(el("span", "setup-service-name", entry.name), el("span", "setup-service-detail", serviceDetail(entry)));
    option.append(radio, text);
    (entry.group === "other" ? othersBody : serviceList).append(option);
  }
  service.body.append(serviceList, others);

  function serviceDetail(entry) {
    if (entry.costUsdPerRequest === 0) {
      return t("setup_online_free_detail", [
        formatNumber(entry.freeRequestsPerDay),
        formatNumber(entry.freeRequestsPerDayWithCredit),
        formatUsd(entry.freeQuotaCreditUsd),
      ]);
    }
    return t("setup_online_paid_detail", [formatUsd(entry.costUsdPerRequest), formatNumber(COST_BASIS_WORDS)]);
  }

  let chosenService = null;
  let guideKeyInput = null;

  account.body.append(el("p", "setup-text", t("setup_online_pick_first")));
  key.body.append(el("p", "setup-text", t("setup_online_pick_first")));
  tryOnline.body.append(el("p", "setup-text", t("setup_try_text")));

  function chooseService(entry, { fromSettings = false } = {}) {
    chosenService = entry;
    const radio = serviceRadios.get(entry.id);
    if (radio) radio.checked = true;
    if (entry.group === "other") others.open = true;
    renderAccountStep(entry);
    renderKeyStep(entry);
    if (fromSettings) {
      service.setState("done", t("setup_online_service_ok", [entry.name]));
      return;
    }
    if (!connected) return;
    service.setState("busy", t("setup_checking"));
    const patch = { type: "settings.set", provider: entry.provider };
    if (entry.baseUrl) patch.baseUrl = entry.baseUrl;
    if (entry.model) patch.model = entry.model;
    request(patch, (reply) => {
      if (reply?.type === "settings" && reply.provider === entry.provider) {
        service.setState("done", t("setup_online_service_ok", [entry.name]));
      } else {
        service.setState("failed", t("setup_check_unknown"));
      }
    });
  }

  function renderAccountStep(entry) {
    const body = account.body;
    body.replaceChildren();
    const links = el("p", "setup-links");
    links.append(
      externalLink(entry.signupUrl, t("setup_online_signup", [entry.name]), "setup-primary-link"),
      " ",
      externalLink(entry.keysUrl, t("setup_online_keys_page")),
    );
    body.append(el("p", "setup-text", t("setup_online_account_text")), links);
    if (entry.group === "free") {
      const privacy = el("p", "setup-text");
      privacy.append(t("setup_online_openrouter_privacy"), " ", externalLink(entry.privacyUrl, t("setup_online_privacy_link")));
      body.append(privacy);
      body.append(el("p", "help help--tight", t("setup_online_openrouter_quota", [formatNumber(entry.freeRequestsPerMinute)])));
    } else if (entry.prepaid) {
      body.append(el("p", "setup-text", t("setup_online_prepaid")));
    } else {
      body.append(el("p", "setup-text", t("setup_online_paid_billing")));
    }
    account.setState("todo");
  }

  function renderKeyStep(entry) {
    key.body.replaceChildren();
    if (entry.keyPrefix) key.body.append(el("p", "setup-text", t("setup_online_key_text", [entry.keyPrefix])));
    guideKeyInput = createKeyInput({
      provider: entry.provider,
      send,
      newId,
      limitsUrl: entry.group === "free" || entry.prepaid ? undefined : entry.limitsUrl,
      onVerified(ok) {
        if (ok) {
          account.setState("done");
          key.setState("done");
        } else {
          key.setState("failed");
        }
      },
    });
    guideKeyInput.setConnected(connected);
    guideKeyInput.update(entryFor(entry.provider));
    key.body.append(guideKeyInput.element);
    key.setState("todo");
  }

  function entryFor(providerId) {
    return (settings?.available ?? []).find((p) => p.id === providerId) ?? null;
  }

  /** Which online service the CURRENT settings point at, if any. */
  function serviceFromSettings(current) {
    if (!current) return null;
    if (current.provider === "claude-api") return ONLINE_PROVIDERS.find((p) => p.provider === "claude-api") ?? null;
    if (current.provider === "openai-compat" && current.baseUrl) {
      return ONLINE_PROVIDERS.find((p) => p.baseUrl === current.baseUrl) ?? null;
    }
    return null;
  }

  // --- Broker plumbing -----------------------------------------------------------

  function request(payload, callback) {
    const id = newId();
    pending.set(id, callback);
    send({ ...payload, id });
  }

  function refreshEnabled() {
    notice.hidden = connected;
    for (const button of checkButtons) button.disabled = !connected;
    guideKeyInput?.setConnected(connected);
  }

  refreshEnabled();

  return {
    onStatus(state) {
      connected = state === "connected";
      refreshEnabled();
    },
    onSettings(next) {
      settings = next;
      guideKeyInput?.update(chosenService ? entryFor(chosenService.provider) : null);
      if (!chosenService) {
        const current = serviceFromSettings(next);
        if (current) chooseService(current, { fromSettings: true });
      }
    },
    onBrokerMessage(message) {
      if (!message) return;
      guideKeyInput?.handleBrokerMessage(message);
      if (message.id && pending.has(message.id)) {
        const callback = pending.get(message.id);
        pending.delete(message.id);
        callback(message);
        return;
      }
      if (message.type === "settings.test-result" && lmTestId && message.id === lmTestId) {
        lmTestId = null;
        lmResult.dataset.tone = message.ok ? "ok" : "error";
        lmResult.textContent = message.ok ? t("setup_lmstudio_ok") : message.message || t("setup_check_unknown");
      }
    },
    /** Opens the guide, scrolls to it and focuses its heading. */
    open() {
      root.open = true;
      root.scrollIntoView?.({ block: "start" });
      summary?.focus({ preventScroll: true });
    },
  };
}
