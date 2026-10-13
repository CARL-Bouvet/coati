// Coati options page — model (current model + two tabs "On this computer" /
// "Online"), page reading default, shortcut, sites, history,
// about, and the legacy pairing-secret paste field (Flatpak/Snap browsers
// with no native messaging — docs/PROTOCOL.md,
// "Legacy mode: legacyPairing").
//
// The pasted key is a secret: it MUST live in chrome.storage.session (wiped
// when the browser closes), never chrome.storage.local (unencrypted on disk).
//
// Split into extension/options/*.js: this file keeps only
// bootstrap/wiring — imports, init(), the broker message dispatch, and the
// legacy-pairing paste field. Each submodule owns its own state; see their
// header comments.

import { api, IS_GECKO } from "./lib/browser-compat.js";
import { RETENTION_DAYS_KEY, parseStoredRetentionDays } from "./panel/retention.js";
import { POINT_EFFECT_KEY, parseStoredPointEffect } from "./panel/point-effect.js";
import {
  DEV_MODE_KEY,
  DEV_MODE_ACKNOWLEDGED_KEY,
  parseStoredDevMode,
  parseStoredDevModeAcknowledged,
  confirmDevModeActivation,
} from "./lib/dev-mode-pref.js";
import { t, applyI18n, reloadOnLanguageChange } from "./lib/i18n-page.js";
import { mountLanguageSelector } from "./lib/language-selector.js";
import { els } from "./options/dom-refs.js";
import { setupShortcut, showAbout } from "./options/shortcut-about.js";
import { renderSiteToggles } from "./options/site-toggles.js";
import { applyStatus, requestSettings, handleBrokerMessage, wireModelSettings } from "./options/model-core.js";

applyI18n(document);
// Same compact selector (FR/EN/中) as the panel's header, in the page's
// anthracite band — the "Language" section is gone.
mountLanguageSelector(document.getElementById("languageSelectorMount"), { compact: true });

// U1 — live language switch: this page also has module-level t() tables
// (labels.js, model-provider-presets.js, shortcut.js) in its import graph;
// a reload re-runs them all with the new catalog already loaded (see
// lib/i18n.js's top-level await), simpler than repainting each in place.
reloadOnLanguageChange();

// Theme variant hook, screenshots only — inert unless the page is opened with
// e.g. "?variant=b".
const variant = new URLSearchParams(location.search).get("variant");
if (variant) document.documentElement.dataset.variant = variant;

init();

async function init() {
  // docs/PROTOCOL.md: write-only field, never
  // pre-filled with the key/secret in memory — nothing read from
  // chrome.storage.session here.

  // Bug report gap 7: this help text used to say "Chrome" unconditionally,
  // wrong under Firefox — same IS_GECKO detection panel.js already uses for
  // its own browser-specific text (see applyConnectionBanner()).
  els.siteTogglesHelp.textContent = IS_GECKO
    ? t("options_sites_help_gecko")
    : t("options_sites_help_chrome");

  const data = await api.storage.local.get([RETENTION_DAYS_KEY, DEV_MODE_KEY, POINT_EFFECT_KEY]);
  const retentionDays = parseStoredRetentionDays(data[RETENTION_DAYS_KEY]);
  els.retention.value = retentionDays === null ? "never" : String(retentionDays);
  // Same storage key as the panel's "Dev mode" switch (lib/dev-mode-pref.js) —
  // ONE preference. Default off (unlike the former attachPage default of
  // "on"): dev mode sends more data and may expose personal data, so it
  // never turns itself on silently.
  els.devMode.checked = parseStoredDevMode(data[DEV_MODE_KEY]);
  // First-ever activation goes through the same risk/cost confirmation
  // dialog as the panel's switch (reused from lib/dev-mode-pref.js, not duplicated).
  // Declined: the checkbox reverts, nothing is written.
  els.devMode.addEventListener("change", async () => {
    if (!els.devMode.checked) {
      api.storage.local.set({ [DEV_MODE_KEY]: false });
      return;
    }
    const acknowledged = await api.storage.local
      .get(DEV_MODE_ACKNOWLEDGED_KEY)
      .then((d) => parseStoredDevModeAcknowledged(d[DEV_MODE_ACKNOWLEDGED_KEY]))
      .catch(() => false);
    if (!acknowledged) {
      const confirmed = await confirmDevModeActivation(document);
      if (!confirmed) {
        els.devMode.checked = false;
        return;
      }
      await api.storage.local.set({ [DEV_MODE_ACKNOWLEDGED_KEY]: true }).catch(() => {});
    }
    api.storage.local.set({ [DEV_MODE_KEY]: true });
  });
  // The panel writes the same key too: adopt its value if changed while
  // this page is open.
  api.storage.onChanged.addListener((changes, area) => {
    if (area === "local" && DEV_MODE_KEY in changes) {
      els.devMode.checked = parseStoredDevMode(changes[DEV_MODE_KEY].newValue);
    }
  });

  const pointEffect = parseStoredPointEffect(data[POINT_EFFECT_KEY]);
  for (const input of els.pointEffectInputs) {
    input.checked = input.value === pointEffect;
    input.addEventListener("change", () => {
      if (input.checked) api.storage.local.set({ [POINT_EFFECT_KEY]: input.value });
    });
  }

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

  // "Model"
  wireModelSettings();

  api.runtime.onMessage.addListener((message) => {
    if (message?.type === "coati:status") {
      applyStatus(message.state);
      if (message.state === "connected") requestSettings();
    }
    if (message?.type === "coati:broker-message") handleBrokerMessage(message.message);
  });

  const initial = await api.runtime.sendMessage({ type: "coati:get-status" }).catch(() => null);
  applyStatus(initial?.state ?? "unknown");
  if (initial?.state === "connected") requestSettings();

  await renderSiteToggles();
  api.permissions.onAdded.addListener(renderSiteToggles);
  api.permissions.onRemoved.addListener(renderSiteToggles);
}

// 64 lowercase hex chars — same shape as the broker's own key (docs/PROTOCOL.md
// "Handshake v: 2"). Checked here too (defense in depth; the service
// worker validates again) so a mistyped paste gets an immediate, specific
// message instead of silently doing nothing.
const PASTED_KEY_RE = /^[0-9a-f]{64}$/i;

// docs/PROTOCOL.md: a valid 64-hex value is
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
  // I4: clear the field once applied — nothing left
  // sitting visible/selectable in the DOM after the secret has done its job.
  els.token.value = "";
}

async function saveRetention() {
  const raw = els.retention.value;
  const retentionDays = raw === "never" ? null : Number(raw);
  await api.storage.local.set({ [RETENTION_DAYS_KEY]: retentionDays });
}
