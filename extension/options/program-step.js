// Coati options page — "Install the local program" (options.html#setup-program).
// Shown when the browser cannot reach the local program (state "no-host"), or
// when opened by link. One direct-download button for this system
// (lib/program-download.js), a folded help for the warnings that system shows,
// and a detection loop: while the step is on screen and the program does not
// answer, the service worker is asked for its status every few seconds (the
// "panel-ready" call, which makes it try to connect); "Retry" does the same at
// once. The new state arrives through the usual coati:status broadcast
// (onStatus). Once connected, the step is ticked and the page moves on to the
// model guide.

import { api } from "../lib/browser-compat.js";
import { t } from "../lib/i18n-page.js";
import { INSTALL_DOC_URL, platformFromInfo, programDownloads } from "../lib/program-download.js";
import { detectOs, el, externalLink, fold, makeStep } from "../options-setup.js";
import { els } from "./dom-refs.js";

const POLL_MS = 3000;
const CHECKING_MS = 2000;
const ADVANCE_MS = 1500;

const DOWNLOAD_LABELS = {
  windows: "setup_program_download_windows",
  mac_arm: "setup_program_download_mac_arm",
  mac_x64: "setup_program_download_mac_x64",
  deb: "setup_program_download_deb",
  rpm: "setup_program_download_rpm",
};
const HELP_KEYS = {
  windows: ["setup_program_win_1", "setup_program_win_2", "setup_program_win_3"],
  mac: ["setup_program_mac_1", "setup_program_mac_2", "setup_program_mac_3", "setup_program_mac_4"],
  linux: ["setup_program_linux_1"],
};

async function detectPlatform() {
  let platform = { os: null, arch: "x64" };
  try {
    platform = platformFromInfo(await api.runtime.getPlatformInfo());
  } catch {
    // No platform API: the page's own guess below.
  }
  return { ...platform, os: platform.os ?? detectOs() };
}

/** @param {{ section: HTMLElement, list: HTMLElement }} root  the section, and the <ol> receiving the step */
export function mountProgramStep({ section, list }) {
  const step = makeStep(1, t("setup_program_step_title"));
  list.append(step.li);

  let state = "unknown";
  let timer = null;
  let checkingTimer = null;
  let sawMissing = false;

  const retry = el("button", "c-button c-button--small", t("setup_program_retry"));
  retry.type = "button";
  retry.addEventListener("click", () => {
    setWaiting(t("setup_program_checking"), CHECKING_MS);
    askStatus();
  });

  const links = el("p", "setup-links");
  step.body.append(el("p", "setup-text", t("setup_program_text")), links);
  detectPlatform().then(({ os, arch }) => renderDownloads(os, arch));

  function renderDownloads(os, arch) {
    const buttons = programDownloads(os, arch).map(({ kind, url }) => {
      const a = el("a", "c-button c-button--primary", t(DOWNLOAD_LABELS[kind === "mac" ? `mac_${arch}` : kind]));
      a.href = url;
      a.download = "";
      return a;
    });
    links.append(...buttons, externalLink(INSTALL_DOC_URL, t("setup_program_other")));
    if (HELP_KEYS[os]) step.body.append(helpFold(os));
    step.body.append(retryRow());
  }

  function helpFold(os) {
    const { details, body } = fold(null, t("setup_program_help_title"), "fold fold--inner");
    const items = el("ol", "setup-os-list");
    for (const key of HELP_KEYS[os]) items.append(el("li", null, t(key)));
    body.append(items);
    if (os === "linux") {
      const pairing = el("a", "c-text-link", t("options_legacy_title"));
      pairing.href = "#legacyPairing";
      pairing.addEventListener("click", () => {
        els.legacyPairing.open = true;
      });
      body.append(el("p", "setup-text", t("setup_program_linux_snap")), pairing);
    }
    return details;
  }

  function retryRow() {
    const row = el("p", "setup-links");
    row.append(retry);
    return row;
  }

  function setWaiting(text, revertMs) {
    clearTimeout(checkingTimer);
    step.setState("busy", text);
    if (revertMs) checkingTimer = setTimeout(() => state !== "connected" && setWaiting(t("setup_program_waiting")), revertMs);
  }

  function askStatus() {
    // coati:panel-ready is the message that makes the worker (re)connect; get-status only reports.
    return api.runtime.sendMessage({ type: "coati:panel-ready" }).catch(() => null);
  }

  /** Polls while the step is on screen, the tab is visible and the program does not answer. */
  function syncPolling() {
    const wanted = !section.hidden && state !== "connected" && !document.hidden;
    if (wanted && !timer) timer = setInterval(askStatus, POLL_MS);
    else if (!wanted && timer) {
      clearInterval(timer);
      timer = null;
    }
  }
  document.addEventListener("visibilitychange", syncPolling);

  function reveal() {
    if (!section.hidden) return;
    section.hidden = false;
    if (state !== "connected") {
      sawMissing = true;
      setWaiting(t("setup_program_waiting"));
    }
  }

  function advance() {
    setTimeout(() => {
      if (state === "connected") location.hash = "#setup";
    }, ADVANCE_MS);
  }

  return {
    /** Every connection state of the page (options.js's applyStatus). */
    onStatus(next) {
      state = next;
      if (next === "no-host") reveal();
      if (next === "connected" && !section.hidden) {
        clearTimeout(checkingTimer);
        step.setState("done", t("setup_program_ok"));
        if (sawMissing) {
          sawMissing = false;
          advance();
        }
      }
      syncPolling();
    },
    /** options.html#setup-program. */
    open() {
      reveal();
      if (state === "connected") step.setState("done", t("setup_program_ok"));
      section.scrollIntoView?.({ block: "start" });
      syncPolling();
    },
  };
}
