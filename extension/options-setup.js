// The step-by-step model guide, merged into the settings page's
// two model tabs. `options.html#setup` still opens it
// (contract with the panel: its "never connected" message and "?" button
// open that URL) — options.js picks the tab, this file builds the steps:
//   local  — appended to the "On this computer" tab: one fold with the
//            Ollama steps (install, check it answers, pull a model sized to
//            the machine), then "Speed up Ollama", then LM Studio;
//   online — appended inside "Add a service" ("Online" tab):
//            OpenRouter free models first, then Claude and OpenAI (paid),
//            Mistral and DeepSeek under "Others"; create a key, paste it in
//            the shared key component (lib/key-input.js).
// Both end on "Try it on a page". Each step is ticked as soon as the
// existing probes say it succeeded (provider.status for Ollama,
// settings.test through the key component) — never on a click alone.
//
// Every provider fact (URLs, models, prices, quotas) comes from
// lib/setup-data.js; every sentence from _locales (`setup_*` keys). No
// innerHTML: nodes built one by one.

import { t } from "./lib/i18n-page.js";
import { createKeyInput } from "./lib/key-input.js";
import { groupModels, readHost, sameModel, shortModelName, suggestForHost } from "./lib/model-list.js";
import {
  OLLAMA_DOWNLOADS,
  OLLAMA_LINUX_INSTALL_COMMAND,
  OLLAMA_START_COMMAND,
  OLLAMA_SPEEDUP,
  OLLAMA_MODELS_BY_MEMORY,
  OLLAMA_SUGGESTIONS,
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

/** "Ask for a search" block shown under the last step of both guides. */
function searchTip() {
  const box = el("div", "setup-search-tip");
  box.append(el("h4", "setup-subtitle", t("setup_search_title")));
  box.append(commandLine(t("setup_search_example_1")), commandLine(t("setup_search_example_2")));
  box.append(el("p", "setup-text", t("setup_search_text")), el("p", "setup-text", t("setup_search_model")));
  return box;
}

/** A command line + "Copy" button. Writing to the clipboard on a click is
 * fine; Coati never READS the clipboard. `block`: several lines, kept as typed. */
function commandLine(command, { block = false } = {}) {
  const wrap = el("div", "setup-command");
  const code = el("code", block ? "setup-command-text setup-command-text--block" : "setup-command-text", command);
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

/** A fold (<details>) with the page's shared chevron style (options.css .fold). */
function fold(id, title, className = "fold") {
  const details = el("details", className);
  if (id) details.id = id;
  const summary = el("summary", null, title);
  const body = el("div", "fold-body");
  details.append(summary, body);
  return { details, summary, body };
}

/**
 * @param {object} opts
 * @param {HTMLElement} opts.localRoot   "On this computer" tab: the folds are appended here
 * @param {HTMLElement} opts.onlineRoot  inside "Add a service": the online steps
 * @param {(payload: object) => void} opts.send
 * @param {() => string} opts.newId
 * @param {(reply: object) => void} [opts.onModels]  every `models` reply this guide receives
 */
export function mountSetupGuide({ localRoot, onlineRoot, send, newId, onModels }) {
  let settings = null;
  let connected = false;
  // The local tab is on screen: only then is `host` worth fetching.
  let localVisible = false;
  // request id -> callback(message), for settings.set / provider.status
  // replies this guide is waiting on.
  const pending = new Map();
  const checkButtons = [];

  const os = detectOs();
  const suggestedRow = suggestedModelRow(navigator.deviceMemory);
  let chosenModel = OLLAMA_MODELS_BY_MEMORY[Math.max(0, suggestedRow)].model;

  // --- Local path: Ollama ------------------------------------------------------

  const guide = fold("setupLocalGuide", t("options_local_guide_title"));
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
  // When the local program reports the
  // machine's capacity (`host`), the suggestions are filtered by it
  // (lib/model-list.js suggestForHost); otherwise (older local program, or
  // no answer yet) the previous table driven by navigator.deviceMemory.
  const modelIntro = el("p", "setup-text");
  const memoryHint = el("p", "help help--tight setup-memory-hint");
  const suggestionsSlot = el("div", "setup-suggestions");
  const pullText = el("p", "setup-text", t("setup_local_pull_text"));
  // Rebuild the copy button so it copies the CURRENT model's command.
  const pullSlot = el("div", "setup-pull-slot");
  model.body.append(
    modelIntro,
    memoryHint,
    el("h4", "setup-subtitle", t("setup_local_suggestions_title")),
    suggestionsSlot,
    pullText,
    pullSlot,
  );
  // The user's own radio choice survives a re-render (host arriving, an
  // installed-models check); until then the suggested row is chosen.
  let userPickedModel = false;

  function installedOllamaModel(name) {
    const local = lastModels ? groupModels(lastModels).local : [];
    return local.find((entry) => entry.provider === "ollama" && sameModel(entry.model, name)) ?? null;
  }

  function radioCell(row, labelText) {
    const label = el("label", "setup-model-choice");
    const radio = el("input");
    radio.type = "radio";
    radio.name = "setupModel";
    radio.value = row.model;
    radio.checked = row.model === chosenModel;
    radio.addEventListener("change", () => {
      if (!radio.checked) return;
      chosenModel = row.model;
      userPickedModel = true;
      refreshPullCommand();
    });
    label.append(radio, labelText);
    return label;
  }

  function headerRow(keys) {
    const thead = el("thead");
    const tr = el("tr");
    for (const key of keys) tr.append(el("th", null, t(key)));
    thead.append(tr);
    return thead;
  }

  function renderSuggestions() {
    const host = lastModels ? readHost(lastModels.host) : null;
    const table = el("table", "setup-models");
    const tbody = el("tbody");

    if (!host) {
      modelIntro.textContent = t("setup_local_model_text");
      memoryHint.textContent =
        suggestedRow === -1 ? t("setup_local_memory_unknown") : t("setup_local_memory_known", [String(navigator.deviceMemory)]);
      if (!userPickedModel) chosenModel = OLLAMA_MODELS_BY_MEMORY[Math.max(0, suggestedRow)].model;
      OLLAMA_MODELS_BY_MEMORY.forEach((row, i) => {
        const tr = el("tr", i === suggestedRow ? "setup-model-row setup-model-row--suggested" : "setup-model-row");
        const memoryCell = el("td");
        memoryCell.append(radioCell(row, t("setup_local_memory_row", [formatNumber(row.minGb)])));
        if (i === suggestedRow) memoryCell.append(" ", el("span", "setup-tag", t("setup_local_suggested")));
        tr.append(memoryCell, el("td", "setup-model-name", row.model), el("td", null, t("setup_size_gb", [formatNumber(row.downloadGb)])));
        tbody.append(tr);
      });
      table.append(headerRow(["setup_local_col_memory", "setup_local_col_model", "setup_local_col_size"]), tbody);
    } else {
      modelIntro.textContent = t("setup_local_model_text_host");
      memoryHint.textContent = hostLine(host);
      const rows = suggestForHost(OLLAMA_SUGGESTIONS, host);
      if (rows.length === 0) {
        suggestionsSlot.replaceChildren(el("p", "setup-text setup-none-fit", t("setup_local_none_fit")));
        pullText.hidden = true;
        pullSlot.replaceChildren();
        return;
      }
      if (!userPickedModel || !rows.some((row) => row.model === chosenModel)) {
        chosenModel = (rows.find((row) => row.recommended) ?? rows[0]).model;
        userPickedModel = false;
      }
      for (const row of rows) {
        const tr = el("tr", row.recommended ? "setup-model-row setup-model-row--suggested" : "setup-model-row");
        tr.dataset.fit = row.fit;
        const modelCell = el("td");
        modelCell.append(radioCell(row, row.model));
        if (row.recommended) modelCell.append(" ", el("span", "setup-tag", t("setup_local_suggested")));
        if (installedOllamaModel(row.model)) {
          modelCell.append(" ", el("span", "setup-tag setup-tag--installed", t("setup_local_installed_tag")));
        }
        tr.append(
          modelCell,
          el("td", "setup-model-size", t("setup_size_gb", [formatNumber(row.downloadGb)])),
          el("td", "setup-model-fit", t(row.fit === "gpu" ? "model_fit_gpu" : "model_fit_shared")),
        );
        tbody.append(tr);
      }
      // Below 480 px each row stacks into a block (options.css); explicit
      // roles keep the table semantics a display change would drop.
      table.classList.add("setup-models--host");
      table.setAttribute("role", "table");
      table.append(headerRow(["setup_local_col_model", "setup_local_col_size", "setup_local_col_fit"]), tbody);
      for (const node of table.querySelectorAll("thead, tbody")) node.setAttribute("role", "rowgroup");
      for (const node of table.querySelectorAll("tr")) node.setAttribute("role", "row");
      for (const node of table.querySelectorAll("th")) node.setAttribute("role", "columnheader");
      for (const node of table.querySelectorAll("td")) node.setAttribute("role", "cell");
    }
    const tableWrap = el("div", "setup-table-wrap");
    tableWrap.append(table);
    suggestionsSlot.replaceChildren(tableWrap);
    refreshPullCommand();
  }

  function hostLine(host) {
    const ram = formatNumber(host.ramGb);
    if (host.unifiedMemory) return t("setup_local_host_unified", [ram]);
    if (host.vramGb === null) return t("setup_local_host_vram_unknown", [ram]);
    return t("setup_local_host_vram", [ram, formatNumber(host.vramGb)]);
  }

  function refreshPullCommand() {
    pullText.hidden = false;
    const installed = installedOllamaModel(chosenModel);
    if (installed) {
      pullText.hidden = true;
      pullSlot.replaceChildren(el("p", "setup-text setup-already-installed", t("setup_local_installed_no_pull", [chosenModel])));
      return;
    }
    pullSlot.replaceChildren(commandLine(`ollama pull ${chosenModel}`));
  }
  // "Check the model" only checks (models.list): it never writes the
  // suggested row's model into the config — choosing is done in the
  // installed list at the top of the tab (options.js), which this check
  // refreshes through `onModels`.
  const modelCheck = actionButton(t("setup_local_model_check"), "setup-check setup-check-model");
  modelCheck.addEventListener("click", () => checkChosenModel());
  checkButtons.push(modelCheck);
  model.body.append(modelCheck);

  // Step 4 — try it.
  tryLocal.body.append(el("p", "setup-text", t("setup_try_text")), searchTip());
  guide.body.append(localList);

  // LM Studio (local server speaking the OpenAI format).
  const lmFold = fold("setupLmStudio", t("setup_lmstudio_title"));
  const lmBody = lmFold.body;
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

  // "Speed up Ollama". This
  // machine's OS first (same detectOs() as the download button).
  const speedupFold = fold("setupOllamaSpeedup", t("setup_speedup_title"), "fold setup-speedup");
  const speedup = speedupFold.details;
  const speedupSummary = speedupFold.summary;
  const speedupBody = speedupFold.body;
  speedupBody.append(el("p", "setup-text", t("setup_speedup_intro")));
  const speedupOrder = os ? [os, ...Object.keys(OS_NAMES).filter((key) => key !== os)] : Object.keys(OS_NAMES);
  for (const key of speedupOrder) speedupBody.append(speedupOsBlock(key));
  const speedupLinks = el("p", "setup-links");
  speedupLinks.append(externalLink(OLLAMA_SPEEDUP.faqUrl, t("setup_speedup_faq")));
  speedupBody.append(speedupLinks);

  // Order: guide (with the suggested models), Speed up, LM Studio.
  localRoot.append(guide.details, speedup, lmFold.details);
  guide.details.addEventListener("toggle", () => {
    if (guide.details.open) prefetchModels();
  });

  function speedupOsBlock(key) {
    const section = el("section", "setup-speedup-os");
    section.dataset.os = key;
    section.append(el("h4", "setup-speedup-os-title", OS_NAMES[key]));
    const list = el("ol", "setup-os-list setup-speedup-steps");
    const step = (text, ...extra) => {
      const li = el("li", null);
      li.append(el("p", "setup-text", text), ...extra);
      list.append(li);
    };
    const env = OLLAMA_SPEEDUP.env;
    if (key === "linux") {
      step(t("setup_speedup_linux_edit"), commandLine(OLLAMA_SPEEDUP.linuxEditCommand));
      const lines = ["[Service]", ...env.map(([name, value]) => `Environment="${name}=${value}"`)].join("\n");
      step(t("setup_speedup_linux_add"), commandLine(lines, { block: true }));
      step(t("setup_speedup_linux_restart"), commandLine(OLLAMA_SPEEDUP.linuxRestartCommand));
    } else if (key === "mac") {
      step(t("setup_speedup_mac_set"), ...env.map(([name, value]) => commandLine(`launchctl setenv ${name} ${value}`)));
      step(t("setup_speedup_mac_restart"));
    } else {
      step(t("setup_speedup_win_open"));
      const rows = env.map(([name, value]) => {
        const row = el("div", "setup-env-row");
        row.append(commandLine(name), el("span", "setup-env-value", t("setup_speedup_win_value", [value])));
        return row;
      });
      step(t("setup_speedup_win_add"), ...rows);
      step(t("setup_speedup_win_restart"));
    }
    section.append(list);
    return section;
  }

  function checkOllama(withModel) {
    if (!connected) return;
    const target = withModel ? model : running;
    target.setState("busy", t("setup_checking"));
    const probe = () => request({ type: "provider.status" }, (result) => applyOllamaStatus(result, withModel));
    if (settings?.provider !== "ollama") {
      request({ type: "settings.set", provider: "ollama" }, probe);
    } else {
      probe();
    }
  }

  // --- Installed models (models.list) ------------------------------------------

  let lastModels = null;
  let modelsInFlight = false;
  renderSuggestions();

  function fetchModels(callback) {
    modelsInFlight = true;
    request({ type: "models.list" }, (reply) => {
      modelsInFlight = false;
      if (reply?.type === "models") {
        lastModels = reply;
        renderSuggestions();
        onModels?.(reply);
      }
      callback?.(reply?.type === "models" ? reply : null);
    });
  }

  /** Quietly reads `host` + installed models for the suggestions, once the
   * local tab is on screen — no step state touched. */
  function prefetchModels() {
    if (!connected || lastModels || modelsInFlight || !localVisible) return;
    fetchModels(null);
  }

  /** Ollama down → step 2 is the one to fix; true when it answered. */
  function applyOllamaSource(grouped) {
    if (grouped.ollamaUnreachable) {
      install.setState("todo");
      running.setState("failed", t("setup_local_unreachable"));
      return false;
    }
    install.setState("done");
    running.setState("done", t("setup_local_running_ok"));
    return true;
  }

  /** Is the suggested row's model installed? Reads only — never settings.set. */
  function checkChosenModel() {
    if (!connected) return;
    model.setState("busy", t("setup_checking"));
    fetchModels((reply) => {
      if (!reply) {
        model.setState("failed", t("setup_check_unknown"));
        return;
      }
      const grouped = groupModels(reply);
      if (!applyOllamaSource(grouped)) {
        model.setState("todo");
        return;
      }
      const found = grouped.local.find((entry) => entry.provider === "ollama" && sameModel(entry.model, chosenModel));
      if (!found) model.setState("failed", t("setup_local_model_missing", [chosenModel]));
      else if (found.current) model.setState("done", t("setup_local_model_ok"));
      else model.setState("done", t("setup_local_model_installed", [shortModelName(found.model)]));
    });
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
  onlineRoot.append(onlineList);

  // Step 1 — said BEFORE the choice: free models may keep the texts.
  const warning = el("p", "setup-warning", t("setup_online_free_warning"));
  service.body.append(warning);
  const serviceList = el("div", "setup-services");
  serviceList.setAttribute("role", "radiogroup");
  serviceList.setAttribute("aria-label", t("setup_online_service_title"));
  const serviceRadios = new Map();
  const others = el("details", "fold fold--inner setup-others");
  others.append(el("summary", null, t("setup_online_others")));
  const othersBody = el("div", "fold-body setup-services");
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
  tryOnline.body.append(el("p", "setup-text", t("setup_try_text")), searchTip());

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
      getBaseUrl: () => entry.baseUrl,
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
    for (const button of checkButtons) button.disabled = !connected;
    guideKeyInput?.setConnected(connected);
  }

  refreshEnabled();

  /** Step 3 ticked once an installed Ollama model answers (picked in the
   * tab's installed list, the panel's menu, or already in use). */
  function markChosenLocalModel() {
    const current = settings?.provider === "ollama" && settings.model ? installedOllamaModel(settings.model) : null;
    if (current && model.state !== "busy") {
      model.setState("done", t("setup_local_model_chosen", [shortModelName(current.model)]));
    }
  }

  return {
    onStatus(state) {
      connected = state === "connected";
      refreshEnabled();
      prefetchModels();
    },
    /** A `models` reply received by the page (options.js's own request). */
    onModels(reply) {
      if (reply?.type !== "models") return;
      lastModels = reply;
      renderSuggestions();
      markChosenLocalModel();
    },
    /** The "On this computer" tab is shown (true) or hidden (false). */
    setLocalVisible(visible) {
      localVisible = Boolean(visible);
      prefetchModels();
    },
    onSettings(next) {
      settings = next;
      markChosenLocalModel();
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
    /** Opens the Ollama guide fold (the caller shows the local tab first). */
    openLocalGuide({ scroll = true } = {}) {
      guide.details.open = true;
      if (!scroll) return;
      guide.details.scrollIntoView?.({ block: "start" });
      guide.summary.focus({ preventScroll: true });
    },
    /** options.html#setup-ollama-speedup (the panel's slow-answer tip). */
    openSpeedup() {
      speedup.open = true;
      speedup.scrollIntoView?.({ block: "start" });
      speedupSummary.focus({ preventScroll: true });
    },
  };
}
