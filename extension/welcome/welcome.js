// Welcome page (docs/DECISIONS.md T51) — opened once by the service worker's
// runtime.onInstalled when reason === "install", never on an update. Four
// steps: install the local program (download for this system, connection
// state), pick a model access, ask a first question (pin the icon), and an
// optional colour theme that recolours this page at once and is kept in
// storage ("uiTheme"). "coati:welcomeStep" (a step id) is only set by
// the lab, to review each step.

import { api, IS_GECKO } from "../lib/browser-compat.js";
import { t, setDocumentLanguage, reloadOnLanguageChange } from "../lib/i18n-page.js";
import { mountLanguageSelector } from "../lib/language-selector.js";
import { initTheme, buildThemeMenu } from "../lib/theme-pref.js";
import { createIcon } from "../lib/icons.js";
import { mountAccessStep } from "./access-step.js";
import { DOWNLOAD_LABELS, HELP_KEYS, INSTALL_DOC_URL, platformFromInfo, programDownloads } from "../lib/program-download.js";

const STEP_IDS = ["program", "access", "first", "theme"];
const POLL_MS = 3000;
const ADVANCE_MS = 1500;

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

// The lab bundles this page as a classic script: no top-level await.
async function start() {
  await initTheme();
  const stored = await api.storage.local.get("coati:welcomeStep").catch(() => ({}));

  setDocumentLanguage();
  document.title = t("welcome_title");
  mountLanguageSelector(document.getElementById("langSelectorMount"));
  document.getElementById("welcomeTitle").textContent = t("welcome_title");
  document.getElementById("welcomeLead").textContent = t("welcome_lead");
  document.getElementById("welcomeLeadPrivacy").textContent = t("welcome_lead_privacy");
  document.getElementById("welcomeLeadServer").textContent = t("welcome_lead_server");
  document.getElementById("welcomeSource").textContent = t("welcome_source_link");
  document.getElementById("welcomeLicence").textContent = t("welcome_licence");

  // --- Connection state: same messages as the options page (options.js) -------
  let status = (await api.runtime.sendMessage({ type: "coati:get-status" }).catch(() => null))?.state ?? "unknown";
  const statusLine = el("p", "welcome-status");
  statusLine.setAttribute("role", "status");

  // --- Step bodies (built once, kept across updates) --------------------------
  function programBody() {
    const body = el("div", "welcome-body");
    const links = el("p", "welcome-links");
    body.append(links, statusLine);
    api.runtime
      .getPlatformInfo()
      .then(platformFromInfo, () => ({ os: null, arch: "x64" }))
      .then(({ os, arch }) => {
        for (const { kind, url } of programDownloads(os, arch)) {
          const a = el("a", "c-button c-button--primary c-button--large", t(DOWNLOAD_LABELS[kind === "mac" ? `mac_${arch}` : kind]));
          a.href = url;
          a.download = "";
          links.append(a);
        }
        const other = el("a", "c-text-link", t("setup_program_other"));
        other.href = INSTALL_DOC_URL;
        other.target = "_blank";
        other.rel = "noopener";
        links.append(other);
        if (!HELP_KEYS[os]) return;
        const fold = el("details", "welcome-fold");
        const list = el("ol", "welcome-list-text");
        for (const key of HELP_KEYS[os]) list.append(el("li", null, t(key)));
        fold.append(el("summary", null, t("setup_program_help_title")), list);
        if (os === "linux") fold.append(el("p", null, t("setup_program_linux_snap")));
        links.after(fold);
      });
    return body;
  }

  // Step 2: the way to a model and its one action (welcome/access-step.js).
  let access = null;
  function accessBody() {
    access = mountAccessStep({
      send: (payload) => api.runtime.sendMessage({ type: "coati:client-message", payload }).catch(() => {}),
      newId: () => `welcome-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    });
    return access.element;
  }

  function pinBody() {
    const body = el("div", "welcome-body");
    const list = el("ol", "welcome-list-text");
    const suffix = IS_GECKO ? "gecko" : "chromium";
    for (const n of [1, 2, 3]) list.append(el("li", null, t(`welcome_pin_step${n}_${suffix}`)));
    body.append(el("h3", "welcome-sub", t("welcome_pin_title")), list);
    return body;
  }

  function themeBody() {
    return buildThemeMenu(t);
  }

  const BODIES = { program: programBody, access: accessBody, first: pinBody, theme: themeBody };

  // --- Steps: one accordion ----------------------------------------------------
  const passed = new Set();
  const startStep = STEP_IDS.indexOf(stored["coati:welcomeStep"]);
  const hashStep = STEP_IDS.indexOf(location.hash.slice(1));
  let open = hashStep >= 0 ? hashStep : startStep >= 0 ? startStep : status === "connected" ? 1 : 0;

  const list = el("ol", "welcome-list");
  document.getElementById("welcomeSteps").append(list);

  const steps = STEP_IDS.map((id, i) => {
    const li = el("li", "welcome-step");
    const mark = el("span", "welcome-mark");
    mark.setAttribute("aria-hidden", "true");
    const label = el("span", "welcome-step-label");
    label.append(el("span", "welcome-step-title", t(`welcome_step_${id}_title`)));
    if (id === "theme") label.append(el("span", "welcome-optional", t("welcome_step_optional")));
    const sr = el("span", "welcome-sr");
    label.append(sr);
    const head = el("h2", "welcome-step-head");
    const panel = el("div", "welcome-panel");
    panel.id = `welcomePanel-${id}`;
    const body = BODIES[id]?.();
    const toggle = el("button", "welcome-toggle");
    toggle.type = "button";
    toggle.append(mark, label);
    // Step 2's choices speak for themselves: no intro line.
    if (id !== "access") panel.append(el("p", "welcome-step-text", t(`welcome_step_${id}_text`)));
    const chevron = el("span", "welcome-chevron");
    chevron.append(createIcon("chevron-down"));
    toggle.append(chevron);
    toggle.setAttribute("aria-controls", panel.id);
    toggle.addEventListener("click", () => go(open === i ? -1 : i));
    head.append(toggle);
    if (body) panel.append(body);
    li.append(head, panel);
    list.append(li);
    return { li, head, toggle, panel, mark, sr };
  });

  function stepState(i) {
    if (i === open) return "current";
    return (i === 0 ? status === "connected" : passed.has(i)) ? "done" : "todo";
  }

  function update() {
    steps.forEach((step, i) => {
      const state = stepState(i);
      step.li.dataset.state = state;
      step.mark.textContent = state === "done" ? "" : String(i + 1);
      step.sr.textContent = t(`welcome_step_state_${state}`);
      const expanded = i === open;
      step.toggle.setAttribute("aria-expanded", String(expanded));
      step.panel.hidden = !expanded;
    });
    statusLine.textContent = t(status === "connected" ? "setup_program_ok" : "setup_program_waiting");
    statusLine.dataset.state = status === "connected" ? "ok" : "waiting";
  }

  function go(index) {
    if (open > 0 && index > open) passed.add(open);
    open = index;
    update();
  }

  function setStatus(next) {
    const was = status;
    status = next ?? "unknown";
    access.onStatus(status === "connected");
    update();
    // Like the options guide: once the program answers, move on to the model.
    if (status === "connected" && was !== "connected" && open === 0) {
      setTimeout(() => open === 0 && go(1), ADVANCE_MS);
    }
  }

  // Step 2 is done once a model is set that was not already: a model that was
  // there on arrival marks it done without moving on (the user came to change it).
  let baselineModel;
  function onSettings(reply) {
    if (baselineModel === undefined) {
      baselineModel = reply.model ?? null;
      if (baselineModel) passed.add(1);
      return update();
    }
    if (!reply.model || reply.model === baselineModel) return;
    baselineModel = reply.model;
    passed.add(1);
    if (open === 1) go(2);
    else update();
  }

  function askBroker() {
    api.runtime.sendMessage({ type: "coati:client-message", payload: { type: "settings.get", id: `welcome-${Date.now()}` } }).catch(() => {});
  }

  api.runtime.onMessage.addListener((message) => {
    if (message?.type === "coati:status") {
      setStatus(message.state);
      if (message.state === "connected") askBroker();
    }
    const reply = message?.type === "coati:broker-message" ? message.message : null;
    if (reply?.type === "settings") onSettings(reply);
    if (reply) access.onBrokerMessage(reply);
  });
  access.onStatus(status === "connected");
  if (status === "connected") askBroker();
  // coati:panel-ready makes the worker try to connect; polled until the program answers.
  setInterval(() => {
    if (status === "connected" || document.hidden) return;
    api.runtime
      .sendMessage({ type: "coati:panel-ready" })
      .then((reply) => reply?.state && reply.state !== status && setStatus(reply.state))
      .catch(() => {});
  }, POLL_MS);

  update();
  // U1 — live language switch: reload, like the other pages.
  reloadOnLanguageChange();
}

start();
