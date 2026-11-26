// The step-by-step model guide, merged into the settings page's
// two model sides. `options.html#setup` still opens it
// (contract with the panel: its "never connected" message and "?" button
// open that URL) — options.js picks the side, this file builds the steps:
//   local  — appended to the "On this computer" side: one fold with the
//            steps (install Ollama or LM Studio, download a model with it,
//            connect Coati), then "Speed up Ollama";
//   online — appended inside "Add a service" ("Online" side):
//            OpenRouter free models first, then Claude and OpenAI (paid),
//            Mistral and DeepSeek under "Others"; once one is chosen, its
//            own short to-do (account, credit, key) and the shared key
//            component (lib/key-input.js).
// Both end on "Try it on a page". Each step is ticked as soon as the
// existing probes say it succeeded (provider.status for Ollama,
// settings.test for LM Studio and through the key component) — never on a
// click alone.
//
// Every provider fact (URLs, models, prices, quotas) comes from
// lib/setup-data.js; every sentence from _locales (`setup_*` keys). No
// innerHTML: nodes built one by one.

import { t } from "./lib/i18n-page.js";
import { api } from "./lib/browser-compat.js";
import { createKeyInput } from "./lib/key-input.js";
import { fitLimitsGb, groupModels, readHost, sameModel, shortModelName } from "./lib/model-list.js";
import {
  OLLAMA,
  OLLAMA_LIBRARY_URL,
  HUGGING_FACE_GGUF_URL,
  OLLAMA_SPEEDUP,
  LM_STUDIO,
  ONLINE_PROVIDERS,
  COST_BASIS_WORDS,
} from "./lib/setup-data.js";

const OAUTH_URL_PREFIX = "https://openrouter.ai/auth?";
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

function uiLocale() {
  return (document.documentElement.lang || "fr").replace("_", "-");
}

export function formatUsd(amount) {
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

export function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

export function externalLink(href, text, className = "c-text-link") {
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
  const code = el("code", block ? "c-field setup-command-text setup-command-text--block" : "c-field setup-command-text", command);
  const copy = el("button", "c-button c-button--small setup-copy", t("setup_copy"));
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
export function makeStep(number, title) {
  const li = el("li", "c-card setup-step");
  li.dataset.state = "todo";
  const mark = el("span", "setup-step-mark", String(number));
  mark.setAttribute("aria-hidden", "true");
  const main = el("div", "setup-step-main");
  const heading = el("h3", "c-title", title);
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
export function fold(id, title, className = "fold") {
  const details = el("details", className);
  if (id) details.id = id;
  const summary = el("summary", null, title);
  const body = el("div", "fold-body");
  details.append(summary, body);
  return { details, summary, body };
}

/**
 * @param {object} opts
 * @param {HTMLElement} opts.localRoot   "On this computer" side: the folds are appended here
 * @param {HTMLElement} opts.onlineRoot  inside "Add a service": the online steps
 * @param {(payload: object) => void} opts.send
 * @param {() => string} opts.newId
 * @param {(reply: object) => void} [opts.onModels]  every `models` reply this guide receives
 * @param {() => void} [opts.onNeedModel]  a key was accepted but no model is chosen yet
 * @param {() => void} [opts.onModelSlot]  modelSlot() may have changed: the page re-places its model field
 */
export function mountSetupGuide({ localRoot, onlineRoot, send, newId, onModels, onNeedModel, onModelSlot }) {
  let settings = null;
  let connected = false;
  // The local side is on screen: only then is `host` worth fetching.
  let localVisible = false;
  // request id -> callback(message), for settings.set / provider.status
  // replies this guide is waiting on.
  const pending = new Map();
  const checkButtons = [];
  const oauthButtons = new Set();

  const os = detectOs();

  // --- Local path: Ollama ------------------------------------------------------

  const guide = fold("setupLocalGuide", t("options_local_guide_title"));
  const localList = el("ol", "setup-steps");
  const install = makeStep(1, t("setup_local_install_title"));
  const model = makeStep(2, t("setup_local_model_title"));
  const connect = makeStep(3, t("setup_local_connect_title"));
  const tryLocal = makeStep(4, t("setup_try_title"));
  localList.append(install.li, model.li, connect.li, tryLocal.li);

  // Step 1 — two tools, each with its official download page.
  const downloads = el("p", "setup-links");
  downloads.append(
    externalLink(OLLAMA.downloadUrl, t("setup_local_download_ollama"), "c-button c-button--primary"),
    externalLink(LM_STUDIO.downloadUrl, t("setup_local_download_lmstudio"), "c-button"),
  );
  install.body.append(el("p", "setup-text", t("setup_local_install_text")), downloads, el("p", "help help--tight", t("setup_local_why_ollama")));

  // Step 2 — each tool's own beginner docs, what this machine can run, where
  // to find a model. Coati names no model. The machine lines need `host` from
  // the local program (older versions don't send it: nothing shown).
  const hostLine = el("p", "help help--tight setup-memory-hint");
  const capacityLine = el("p", "help help--tight setup-memory-hint");
  const docsLinks = el("p", "setup-links");
  docsLinks.append(
    externalLink(OLLAMA.docsUrl, t("setup_local_docs_ollama")),
    " · ",
    externalLink(LM_STUDIO.docsUrl, t("setup_local_docs_lmstudio")),
  );
  const findLinks = el("p", "setup-links");
  findLinks.append(
    externalLink(OLLAMA_LIBRARY_URL, t("setup_local_find_ollama")),
    " · ",
    externalLink(HUGGING_FACE_GGUF_URL, t("setup_local_find_hf")),
  );
  model.body.append(
    el("p", "setup-text", t("setup_local_model_text")),
    docsLinks,
    hostLine,
    capacityLine,
    el("p", "setup-text", t("setup_local_find_text")),
    findLinks,
  );

  /** Machine lines. The graphics-card sentence only when the graphics memory
   * was measured (`vramGb`); with it unknown, nothing about speed. */
  function renderHost() {
    const host = lastModels ? readHost(lastModels.host) : null;
    if (!host) {
      hostLine.textContent = "";
      capacityLine.textContent = "";
      return;
    }
    const ram = formatNumber(host.ramGb);
    hostLine.textContent = host.unifiedMemory
      ? t("setup_local_host_unified", [ram])
      : host.vramGb === null
        ? t("setup_local_host_ram", [ram])
        : t("setup_local_host_vram", [ram, formatNumber(host.vramGb)]);
    const limits = fitLimitsGb(host);
    capacityLine.textContent =
      limits.shared === 0
        ? t("setup_local_none_fit")
        : host.unifiedMemory
          ? t("setup_local_cap_unified", [formatNumber(limits.gpu)])
          : host.vramGb !== null && limits.gpu > 0
            ? t("setup_local_cap_gpu", [formatNumber(limits.gpu), formatNumber(limits.shared)])
            : "";
  }

  // Step 3 — pick the tool; the check never writes a model into the config:
  // choosing is done in the installed list at the top of the side (options.js),
  // refreshed through `onModels` once the check succeeded.
  const ollamaCheck = actionButton(t("setup_local_running_check"), "c-button c-button--primary setup-check-ollama");
  ollamaCheck.addEventListener("click", () => checkOllama());
  const lmButton = actionButton(t("setup_lmstudio_use"), "c-button setup-check-lmstudio");
  let lmTestId = null;
  lmButton.addEventListener("click", () => {
    if (!connected) return;
    connect.setState("busy", t("setup_checking"));
    request({ type: "settings.set", provider: "openai-compat", baseUrl: LM_STUDIO.baseUrl }, () => {
      lmTestId = newId();
      send({ type: "settings.test", id: lmTestId, provider: "openai-compat" });
    });
  });
  checkButtons.push(ollamaCheck, lmButton);
  connect.body.append(
    el("p", "setup-text", t("setup_local_running_text")),
    ollamaCheck,
    el("p", "setup-text", t("setup_lmstudio_text")),
    lmButton,
  );

  // Step 4 — try it.
  tryLocal.body.append(el("p", "setup-text", t("setup_try_text")), searchTip());
  guide.body.append(localList);

  // "Speed up Ollama": when it helps, then this machine's OS first (same detectOs() as the
  // download button), then how to check it worked.
  const speedupFold = fold("setupOllamaSpeedup", t("setup_speedup_title"), "fold setup-speedup");
  const speedup = speedupFold.details;
  const speedupSummary = speedupFold.summary;
  const speedupBody = speedupFold.body;
  speedupBody.append(el("p", "setup-text", t("setup_speedup_when")), el("p", "setup-text", t("setup_speedup_intro")));
  const otherOs = Object.keys(OS_NAMES).filter((key) => key !== os);
  if (os) {
    speedupBody.append(speedupOsBlock(os));
    const otherSystems = el("details", "fold fold--inner setup-speedup-others");
    const otherSystemsBody = el("div", "fold-body");
    otherSystems.append(el("summary", null, t("setup_speedup_other_os")), otherSystemsBody);
    for (const key of otherOs) otherSystemsBody.append(speedupOsBlock(key));
    speedupBody.append(otherSystems);
  } else {
    for (const key of Object.keys(OS_NAMES)) speedupBody.append(speedupOsBlock(key));
  }
  speedupBody.append(el("p", "setup-text", t("setup_speedup_check")));
  const speedupLinks = el("p", "setup-links");
  speedupLinks.append(
    externalLink(OLLAMA_SPEEDUP.faqUrl, t("setup_speedup_faq")),
    externalLink(OLLAMA_SPEEDUP.issueUrl, t("setup_speedup_report")),
  );
  speedupBody.append(speedupLinks);

  localRoot.append(guide.details, speedup);
  guide.details.addEventListener("toggle", () => {
    if (guide.details.open) prefetchModels();
  });

  function speedupOsBlock(key) {
    const section = el("section", "setup-speedup-os");
    section.dataset.os = key;
    section.append(el("h4", "setup-speedup-os-title", OS_NAMES[key]));
    let list;
    const newList = (title) => {
      if (title) section.append(el("h5", "setup-speedup-case-title", title));
      list = el("ol", "setup-os-list setup-speedup-steps");
      section.append(list);
    };
    const step = (text, ...extra) => {
      const li = el("li", null);
      li.append(el("p", "setup-text", text), ...extra);
      list.append(li);
    };
    const env = OLLAMA_SPEEDUP.env;
    if (key === "linux") {
      newList(t("setup_speedup_linux_service"));
      step(t("setup_speedup_linux_edit"), commandLine(OLLAMA_SPEEDUP.linuxEditCommand));
      const lines = ["[Service]", ...env.map(([name, value]) => `Environment="${name}=${value}"`)].join("\n");
      step(t("setup_speedup_linux_add"), commandLine(lines, { block: true }));
      step(t("setup_speedup_linux_restart"), commandLine(OLLAMA_SPEEDUP.linuxRestartCommand));
      newList(t("setup_speedup_linux_manual"));
      const serve = [...env.map(([name, value]) => `${name}=${value}`), "ollama serve"].join(" ");
      step(t("setup_speedup_linux_manual_step"), commandLine(serve));
    } else if (key === "mac") {
      newList();
      step(t("setup_speedup_mac_set"), ...env.map(([name, value]) => commandLine(`launchctl setenv ${name} ${value}`)));
      step(t("setup_speedup_mac_restart"));
    } else {
      newList();
      step(t("setup_speedup_win_open"));
      const rows = env.map(([name, value]) => {
        const row = el("div", "setup-env-row");
        row.append(commandLine(name), el("span", "setup-env-value", t("setup_speedup_win_value", [value])));
        return row;
      });
      step(t("setup_speedup_win_add"), ...rows);
      step(t("setup_speedup_win_restart"));
    }
    return section;
  }

  function checkOllama() {
    if (!connected) return;
    connect.setState("busy", t("setup_checking"));
    const probe = () => request({ type: "provider.status" }, applyOllamaStatus);
    if (settings?.provider !== "ollama") {
      request({ type: "settings.set", provider: "ollama" }, probe);
    } else {
      probe();
    }
  }

  // --- Installed models (models.list) ------------------------------------------

  let lastModels = null;
  let modelsInFlight = false;

  function fetchModels(callback) {
    modelsInFlight = true;
    request({ type: "models.list" }, (reply) => {
      modelsInFlight = false;
      if (reply?.type === "models") {
        lastModels = reply;
        renderHost();
        markChosenLocalModel();
        onModels?.(reply);
      }
      callback?.(reply?.type === "models" ? reply : null);
    });
  }

  /** Quietly reads `host` (machine capacity) + installed models, once the
   * local side is on screen — no step state touched. */
  function prefetchModels() {
    if (!connected || lastModels || modelsInFlight || !localVisible) return;
    fetchModels(null);
  }

  function applyOllamaStatus(result) {
    const reason = result?.reason;
    if (result?.type !== "provider.status-result" || result.provider !== "ollama" || result.state === "unknown") {
      connect.setState("failed", t("setup_check_unknown"));
      return;
    }
    if (reason === "ollama-unreachable") {
      install.setState("todo");
      connect.setState("failed", t("setup_local_unreachable"));
      return;
    }
    install.setState("done");
    connect.setState("done", t("setup_local_running_ok"));
    fetchModels(null);
    if (reason === "ready") {
      model.setState("done", t("setup_local_model_ok"));
    } else if (reason === "model-missing") {
      model.setState("failed", settings?.model ? t("setup_local_model_missing", [settings.model]) : t("setup_local_no_model"));
    } else if (reason === "no-model-chosen") {
      model.setState("failed", t("setup_local_choose_model"));
    } else if (reason === "no-model-installed") {
      model.setState("failed", t("setup_local_no_model"));
    }
  }

  // --- Online path -------------------------------------------------------------
  // One block that moves forward: the service; how to connect it (OpenRouter: one sign-in
  // button, the key by hand folded; the others: the key, how to get one folded); then,
  // once the key is accepted, the model list right under it (options/model-picker.js,
  // placed here by the page through modelSlot()).

  const onlineBlock = el("div", "c-card setup-online-block");
  onlineRoot.append(onlineBlock);

  // Which way in suits someone who wants a paid model or a free one, folded above the
  // services; it goes with the list once a service is picked.
  const which = fold(null, t("setup_online_which_title"), "fold fold--inner setup-online-which");
  const ways = el("ul", "setup-os-list setup-todo");
  ways.append(
    el("li", null, t("setup_online_which_openrouter")),
    el("li", null, t("setup_online_which_api_key")),
    el("li", null, t("setup_online_which_free")),
  );
  which.body.append(ways, el("p", "help", t("setup_online_which_claude_plan")));

  // OpenRouter's retention warning sits under the chosen service, shown as soon as it is
  // chosen, before any key is pasted.
  const warning = el("p", "setup-warning", t("setup_online_free_warning"));
  warning.hidden = true;
  const serviceList = el("div", "c-card setup-services");
  serviceList.setAttribute("role", "radiogroup");
  serviceList.setAttribute("aria-label", t("setup_online_service_title"));
  const serviceRadios = new Map();
  const others = el("details", "fold fold--inner setup-others");
  others.append(el("summary", null, t("setup_online_others")));
  const othersBody = el("div", "fold-body setup-services");
  others.append(othersBody);
  for (const entry of ONLINE_PROVIDERS) {
    const option = el("label", "c-row setup-service");
    option.dataset.service = entry.id;
    const radio = el("input");
    radio.type = "radio";
    radio.name = "setupService";
    radio.value = entry.id;
    radio.addEventListener("change", () => {
      if (radio.checked) chooseService(entry);
    });
    // The same service picked again after "Change": the list folds back.
    radio.addEventListener("click", () => {
      if (chosenService === entry) foldServices(true);
    });
    serviceRadios.set(entry.id, radio);
    const text = el("span", "setup-service-text");
    text.append(
      el("span", "setup-service-name", entry.name),
      // setup_online_purpose_openrouter, _claude, _openai, _mistral, _google, _deepseek
      el("span", "setup-service-purpose", t(`setup_online_purpose_${entry.id}`)),
      el("span", "setup-service-detail", serviceDetail(entry)),
    );
    option.append(radio, text);
    (entry.group === "other" ? othersBody : serviceList).append(option);
  }
  // Once a service is picked here, the list folds to its name and "Change".
  const chosenLine = el("p", "setup-service-chosen");
  chosenLine.hidden = true;
  const chosenName = el("span", "setup-service-name");
  const change = el("button", "c-link", t("setup_online_change"));
  change.type = "button";
  change.addEventListener("click", () => foldServices(false));
  chosenLine.append(chosenName, " · ", change); // i18n-allow: symbol
  const serviceStatus = statusLine();
  const access = el("div", "setup-online-access");
  access.hidden = true;
  const modelSlot = el("div", "setup-online-model");
  const readyLine = statusLine();
  onlineBlock.append(which.details, serviceList, others, chosenLine, warning, serviceStatus, access, modelSlot, readyLine);

  /** Folds the list to the chosen service (true), or shows every service again. */
  function foldServices(folded) {
    const focus = document.activeElement;
    which.details.hidden = serviceList.hidden = others.hidden = folded;
    chosenLine.hidden = !folded;
    chosenName.textContent = chosenService.name;
    if (!folded && chosenService.group === "other") others.open = true;
    if (folded && (serviceList.contains(focus) || others.contains(focus))) change.focus();
    if (!folded && focus === change) serviceRadios.get(chosenService.id)?.focus();
  }

  function statusLine() {
    const line = el("p", "setup-step-result");
    line.setAttribute("role", "status");
    line.hidden = true;
    return line;
  }

  function setLine(line, text, tone) {
    line.textContent = text ?? "";
    line.hidden = !text;
    if (tone) line.dataset.tone = tone;
    else delete line.dataset.tone;
  }

  function serviceDetail(entry) {
    if (entry.costUsdPerRequest === 0) {
      return t("setup_online_free_detail", [
        formatNumber(entry.freeRequestsPerDay),
        formatNumber(entry.freeRequestsPerDayWithCredit),
        formatUsd(entry.freeQuotaCreditUsd),
      ]);
    }
    const detail = entry.freeTier ? "setup_online_freetier_detail" : "setup_online_paid_detail";
    return t(detail, [formatUsd(entry.costUsdPerRequest), formatNumber(COST_BASIS_WORDS)]);
  }

  let chosenService = null;
  let guideKeyInput = null;
  let oauthPending = false;
  // The chosen service's key works (checked here, or already stored when the page opened).
  let keyOk = false;
  // OpenRouter's "I already have a key" fold: opened when the key it holds is refused.
  let manualFold = null;
  // OpenRouter's sign-in button, and the line that replaces it once the key works.
  let oauthBox = null;
  const signedInLine = statusLine();

  function chooseService(entry, { fromSettings = false } = {}) {
    chosenService = entry;
    keyOk = fromSettings && keyStoredFor(entry, settings);
    const radio = serviceRadios.get(entry.id);
    if (radio) radio.checked = true;
    // The service already in use: the whole list, to add another one.
    foldServices(!fromSettings);
    warning.hidden = entry.group !== "free";
    access.hidden = false;
    renderAccess(entry);
    setLine(serviceStatus, null);
    renderProgress();
    onModelSlot?.();
    if (fromSettings || !connected) return;
    setLine(serviceStatus, t("setup_checking"));
    const patch = { type: "settings.set", provider: entry.provider };
    if (entry.baseUrl) patch.baseUrl = entry.baseUrl;
    request(patch, (reply) => {
      const ok = reply?.type === "settings" && reply.provider === entry.provider;
      setLine(serviceStatus, ok ? null : t("setup_check_unknown"), "error");
    });
  }

  /** OpenRouter: the sign-in button, its notes, then the key by hand in a fold. The
   * others: the key field, then how to get one in a fold. */
  function renderAccess(entry) {
    const keyPart = el("div", "setup-online-key");
    if (entry.keyPrefix) keyPart.append(el("p", "setup-text", t("setup_online_key_text", [entry.keyPrefix])));
    keyPart.append(buildKeyInput(entry).element);
    const howTo = fold(null, t(entry.oauth ? "setup_online_have_key" : "setup_online_no_key"), "fold fold--inner setup-online-fold");
    howTo.body.append(...howToGetKey(entry));
    manualFold = entry.oauth ? howTo.details : null;
    oauthBox = entry.oauth ? oauthBlock(entry) : null;
    if (entry.oauth) {
      howTo.body.append(keyPart);
      access.replaceChildren(oauthBox, signedInLine, ...freeNotes(entry), howTo.details);
    } else {
      access.replaceChildren(keyPart, howTo.details);
    }
  }

  /** OpenRouter, Claude, OpenAI: their own to-do, one direct link per line; the
   * others: the generic sentence and their two pages. */
  function howToGetKey(entry) {
    const nodes = [];
    if (entry.group === "other") {
      const links = el("p", "setup-links");
      links.append(
        externalLink(entry.signupUrl, t("setup_online_signup", [entry.name]), "c-button c-button--primary"),
        " ",
        externalLink(entry.keysUrl, t("setup_online_keys_page")),
      );
      nodes.push(el("p", "setup-text", t("setup_online_account_text")), links);
      if (!entry.freeTier) nodes.push(el("p", "setup-text", t(entry.prepaid ? "setup_online_prepaid" : "setup_online_paid_billing")));
    } else {
      const list = () => el("ol", "setup-os-list setup-todo");
      let todo = list();
      const item = (href, linkText, rest) => {
        const li = el("li", "setup-text");
        if (href) li.append(externalLink(href, linkText), " ");
        li.append(rest);
        todo.append(li);
      };
      if (entry.subscriberTodo) {
        nodes.push(el("p", "setup-text setup-todo-title", t("setup_online_claude_subscriber")), todo);
        item(entry.planUrl, t(entry.planLink), t("setup_online_claude_subscriber_credit"));
        item(entry.keysUrl, t("setup_online_do_key_link"), t(entry.keyRest ?? "setup_online_do_key_rest"));
        item(null, "", t("setup_online_do_copy"));
        todo = list();
        nodes.push(el("p", "setup-text setup-todo-title", t("setup_online_claude_others")));
      }
      item(entry.signupUrl, t("setup_online_do_account_link", [entry.name]), t("setup_online_do_account_rest"));
      if (entry.needsCredit) item(entry.billingUrl, t("setup_online_do_credit_link"), t("setup_online_do_credit_rest"));
      item(entry.keysUrl, t("setup_online_do_key_link"), t(entry.keyRest ?? "setup_online_do_key_rest"));
      item(null, "", t("setup_online_do_copy"));
      nodes.push(todo);
    }
    if (entry.planNote) {
      const plan = el("p", "help help--tight", t(entry.planNote));
      if (entry.planUrl) plan.append(" ", externalLink(entry.planUrl, t(entry.planLink)));
      nodes.push(plan);
    }
    return nodes;
  }

  /** OpenRouter's free models: where to allow them, and their pace. */
  function freeNotes(entry) {
    if (entry.group !== "free") return [];
    const privacy = el("p", "help help--tight");
    privacy.append(t("setup_online_openrouter_privacy"), " ", externalLink(entry.privacyUrl, t("setup_online_privacy_link")));
    return [privacy, el("p", "help help--tight", t("setup_online_openrouter_quota", [formatNumber(entry.freeRequestsPerMinute)]))];
  }

  /** One-click sign-in: the local program returns the address to open in a new tab; the key
   * arrives in the program, never here. The settings it pushes afterwards get it checked. */
  function oauthBlock(entry) {
    const box = el("div", "setup-oauth");
    const button = el("button", "c-button c-button--primary", t("setup_oauth_signin", [entry.name]));
    button.type = "button";
    button.disabled = !connected;
    oauthButtons.clear();
    oauthButtons.add(button);
    const status = el("p", "help help--tight");
    status.setAttribute("aria-live", "polite");
    button.addEventListener("click", () => {
      button.disabled = true;
      request({ type: "oauth.start", service: entry.oauth }, (reply) => {
        button.disabled = !connected;
        if (reply?.type === "oauth.started" && typeof reply.url === "string" && reply.url.startsWith(OAUTH_URL_PREFIX)) {
          oauthPending = true;
          status.textContent = t("setup_oauth_waiting");
          api.tabs.create({ url: reply.url });
        } else {
          status.textContent = t("setup_oauth_failed");
        }
      });
    });
    box.append(button, status);
    return box;
  }

  /** The program holds a key for this service and it is the active service. */
  function keyStoredFor(entry, current) {
    if (current?.provider !== entry.provider) return false;
    if (!entry.baseUrl) return Boolean(current.available?.find((p) => p.id === entry.provider)?.configured);
    return current.baseUrl === entry.baseUrl && Boolean(current.services?.some((svc) => svc.baseUrl === entry.baseUrl && svc.hasKey));
  }

  function buildKeyInput(entry) {
    guideKeyInput = createKeyInput({
      provider: entry.provider,
      send,
      newId,
      getBaseUrl: () => entry.baseUrl,
      limitsUrl: entry.group === "free" || entry.prepaid ? undefined : entry.limitsUrl,
      onVerified(ok, code) {
        // model-missing: the key works, the saved model is gone from the service.
        const needModel = ok ? !settings?.model : code === "model-missing";
        keyOk = ok || needModel;
        if (!keyOk && manualFold) manualFold.open = true;
        renderProgress();
        onModelSlot?.();
        if (needModel) onNeedModel?.();
      },
    });
    guideKeyInput.setConnected(connected);
    guideKeyInput.update(entryFor(entry.provider));
    return guideKeyInput;
  }

  /** Where the block stands: once the key works, the sign-in button gives way to a line
   * saying so; once a model is chosen too, the last line says Coati is set up. */
  function renderProgress() {
    const working = Boolean(chosenService && keyOk && keyStoredFor(chosenService, settings));
    if (oauthBox) oauthBox.hidden = working;
    const accepted = `✓ ${t("keyInput_saved")} · ${t("keyInput_accepted")}`; // i18n-allow: symbols
    setLine(signedInLine, working && oauthBox ? accepted : null, "ok");
    setLine(readyLine, working && settings.model ? t("setup_online_ready") : null, "ok");
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
    for (const button of oauthButtons) button.disabled = !connected;
    guideKeyInput?.setConnected(connected);
  }

  refreshEnabled();

  /** Step 2 ticked once the model in use is an installed local one (picked in
   * the side's installed list, the panel's menu, or already in use). */
  function markChosenLocalModel() {
    if (!settings?.model || !lastModels) return;
    const current = groupModels(lastModels).local.find(
      (entry) => entry.provider === settings.provider && sameModel(entry.model, settings.model),
    );
    if (current) model.setState("done", t("setup_local_model_chosen", [shortModelName(current.model)]));
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
      renderHost();
      markChosenLocalModel();
    },
    /** The "On this computer" side is shown (true) or hidden (false). */
    setLocalVisible(visible) {
      localVisible = Boolean(visible);
      prefetchModels();
    },
    onSettings(next) {
      settings = next;
      markChosenLocalModel();
      guideKeyInput?.update(chosenService ? entryFor(chosenService.provider) : null);
      if (oauthPending && chosenService?.oauth && keyStoredFor(chosenService, next)) {
        oauthPending = false;
        guideKeyInput?.verify();
      }
      if (!chosenService) {
        const current = serviceFromSettings(next);
        if (current) chooseService(current, { fromSettings: true });
      }
      renderProgress();
      onModelSlot?.();
    },
    /** Where the model list goes once the chosen service's key works, else null. */
    modelSlot() {
      return chosenService && keyOk && keyStoredFor(chosenService, settings) ? modelSlot : null;
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
        if (message.ok) {
          install.setState("done");
          connect.setState("done", t("setup_lmstudio_ok"));
          fetchModels(null);
        } else {
          connect.setState("failed", message.message || t("setup_check_unknown"));
        }
      }
    },
    /** Opens the Ollama guide fold (the caller shows the local side first). */
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
      // Keyboard users land here; the ring would frame the title as if it had been clicked.
      speedupSummary.focus({ preventScroll: true, focusVisible: false });
    },
  };
}
