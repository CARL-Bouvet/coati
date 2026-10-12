// Coati side panel — chat UI, streaming rendering, contextual summarize
// button, selection actions, prompt library. Plain JS, no framework, no
// bundler.
//
// Conversation state lives HERE (persisted to chrome.storage.local), never
// only in the background service worker's memory: the service worker can be
// killed and restarted at any time (see background/service-worker.js).
//
// --- Permission flow for the contextual main button (read before editing) --
//
// Rule (CLAUDE.md #5, "the gesture rule"): Coati never reads a page on its
// own. Concretely, for `chrome.scripting.executeScript` against page content:
//
//   - On a tab switch (`chrome.tabs.onActivated`) there is NO user gesture —
//     switching tabs is not "using Coati". So we NEVER inject there.
//     `redetectTabFromMetadata()` classifies from `tab.url`/`tab.title` alone
//     (via `classifyPageTypeFromMetadata()` in detect.js), which
//     `chrome.tabs.get` already returns for any origin we hold a host
//     permission for — no page read needed to get that far. Most page types
//     cannot be told apart from the URL alone (an article and a plain page
//     look the same), so this stays honestly "unknown" and the main button
//     keeps its generic "Summarize" label; only a recognisable shape like a
//     YouTube watch URL resolves to a real type here. The site card (T27-T29,
//     below) follows the exact same rule: `chrome.tabs.onUpdated`, filtered on
//     the current tab and debounced, re-runs this same metadata-only
//     classification on in-tab navigation — never a page read either.
//   - Opening the panel IS a gesture (the user clicked the toolbar icon), and
//     it grants `activeTab` for whatever tab is active right now. `init()`
//     spends that grant immediately via `redetectTab()`: query the tab,
//     inject content/extract.js, classify with the fuller
//     `classifyPageType()`, and show the precise main-button label. This is
//     the one page read allowed without a click inside the panel itself.
//   - Past that, a page is only ever read again on an explicit gesture inside
//     the panel: a click on the main button (`summarize()`), a site-card
//     suggestion (`runSuggestion()` — same page-attached path as a library
//     prompt sent with "Read the page" checked), the "Read the page"
//     toggle being ON at send time (`sendChat()`), or a
//     context-menu action on selected text. Each of those calls
//     `extractFromTab()` and, once real content came back, refines the type
//     and relabels the button via `applyDetectedContext()`.
//   - Page access, "path B" (docs/DECISIONS.md T50, amended T42/T43): while
//      the page isn't accessible, the encart's head shows the "Read this
//      page" button (read-button.js). Its first click asks ONCE for the
//      optional "all sites" host permission — no origin needed, so it works
//      even when a tab switch left the address unknown. `permissions.request`
//      is called first thing in the click handler, no `await` before it
//      (Firefox drops the gesture otherwise). Granted → the same click reads
//      the page (`redetectTab()`), never a summary. Refused → remembered in
//      storage.local, and from then on the button asks for this site only
//      when its address is known (`redetectTab()` learns it through
//      `api.tabs.get(tabId)` inside a gesture's activeTab grant). T47: the
//      injection-refused error itself is NOT mined for the origin — neither
//      Chrome/Brave nor Firefox embed the page address in it.
//   - Granted permissions are remembered by the browser — nothing is cached
//      here (no secrets in chrome.storage, CLAUDE.md rule #1), and
//      `chrome.scripting.executeScript` simply works on matching tabs from
//      then on. Having "all sites" changes WHERE Coati may read, never WHEN:
//      still only on the gestures listed above.

import { api } from "../lib/browser-compat.js";
import { debounce } from "./debounce.js";
import { bindAutogrow } from "./composer-autogrow.js";
import { isRedetectDuplicate, parseActionClickedTabId } from "./redetect-dedupe.js";
import { computeCodeFingerprint } from "../lib/build-fingerprint.js";
import { t, applyI18n, reloadOnLanguageChange } from "../lib/i18n-page.js";
import { mountLanguageSelector } from "../lib/language-selector.js";
import { els } from "./dom-refs.js";
import { panelState } from "./panel-state.js";
import { loadConversation, persistConversation } from "./conversation-store.js";
import { renderAll } from "./message-render.js";
import {
  retryConnection,
  applyStatus,
  applyBrokerFeatures,
  maybeRecheckProviderForFirstRun,
  maybeRefreshModels,
  wireModelPicker,
  wireStatusLabel,
  onModelWarmupResult,
  onSettingsMessage,
  onModelsMessage,
  onProviderStatusResult,
} from "./model-status.js";
import {
  openModelTutorial,
  wireHelpButton,
  onReadPageClick,
  COATI_ICON_PATH,
  refreshAllSitesGranted,
  loadAccessPrefs,
  refreshReadButton,
  PERMISSION_REDETECT_SKIP_MS,
} from "./first-run-wiring.js";
import { sendChat } from "./composer-send.js";
import { cancelActive, onEraseClick } from "./request-watch.js";
import { requestPrompts, requestPrefs, openMyPromptsPage, saveCurrentAsPrompt, updateSavePromptEnabled } from "./prompts-wiring.js";
import {
  DEV_MODE_KEY,
  DEV_MODE_ACKNOWLEDGED_KEY,
  parseStoredDevMode,
  parseStoredDevModeAcknowledged,
  confirmDevModeActivation,
  isDevModeChecked,
  setDevModeChecked,
  updateDevModeUi,
} from "./dev-mode.js";
import { redetectTab, redetectTabFromMetadata, openedFromGesture, lastRedetectTabId, lastRedetectAt } from "./page-detect.js";
import { updateSiteCard, onPromptsMessage, onPrefsMessage } from "./site-card.js";
import { activeTabId } from "./page-extract.js";
import { drainPendingAction } from "./pending-action.js";
import { onChunk, onProgress, onDone, onError } from "./chat-stream.js";
import { onPageRequest } from "./page-request.js";
import { onSearchRequest, onOpenRequest } from "./web-search.js";

// Public repo doc, opened from the "no-host" banner (docs/PROTOCOL.md
// amendment 2026-09-30, "États et bandeaux"). No local doc viewer in the
// extension itself, so this points at the same repo the "À propos" section
// already links to.
const INSTALL_DOC_URL = "https://github.com/CARL-Bouvet/coati/blob/main/docs/INSTALL.md";

// Composer height recompute (lot 4) — set in init(), called after every
// programmatic change of els.input.value (those fire no "input" event).
// Only ever reassigned here (bootstrap) — every other module imports it
// read-only.
export let resizeComposer = () => {};
// Page detection state (deliverable 1) — see the comment block above. Only
// ever reassigned here (bootstrap); every other module imports it read-only.
export let currentTabId = null;

applyI18n(document);
// U1 — live language switch: FIRST_RUN_TEXT, READ_BUTTON_TEXT, suggestions
// SITES and every other module-level t() table in this page's import graph
// were all computed once, at import time (see lib/i18n.js's top-level
// await). Repainting them in place would mean re-deriving every one of
// those tables here too; a reload re-runs the whole module graph instead,
// which is simpler and complete. The conversation is kept (see
// development notes U1 entry) only when the history setting
// persists it to storage — otherwise this clears it, same as closing and
// reopening the panel.
reloadOnLanguageChange();
export const langSelector = mountLanguageSelector(document.getElementById("langSelectorMount"));

// Design-variant hook for captures only (notes/PLAN_goal_panneau_v2.md,
// "Contrat commun") — inert unless the panel's own address carries
// `?variant=a|b|c`; theme.css keys its variants off this attribute.
const requestedVariant = new URLSearchParams(location.search).get("variant");
if (requestedVariant) document.documentElement.dataset.variant = requestedVariant;

// Public repo doc, opened from the "no-host" banner (docs/PROTOCOL.md
// amendment 2026-09-30, "États et bandeaux"). No local doc viewer in the
// extension itself, so this points at the same repo the "À propos" section
// already links to.

init();

async function init() {
  panelState.conversation = await loadConversation();
  renderAll();

  els.openOptions.addEventListener("click", () => api.runtime.openOptionsPage());
  // Opens the options page — options.js auto-expands the "Browser without
  // programme natif (Flatpak, Snap)" section for both states this button is
  // shown in (no-host, no-token). Same page as the gear icon, no separate
  // "connect" flow left (docs/PROTOCOL.md: /pair removed from the extension).
  els.connectCoati.addEventListener("click", () => api.runtime.openOptionsPage());
  els.installDocLink.addEventListener("click", () => api.tabs.create({ url: INSTALL_DOC_URL }));
  els.connectionBannerRetry.addEventListener("click", retryConnection);
  els.neverConnectedAction.addEventListener("click", openModelTutorial);
  wireHelpButton();
  els.readPage.addEventListener("click", onReadPageClick);
  // Same Brave favicon bug as the site card's own icon below: fall back to
  // Coati's icon rather than an empty ring.
  els.readPageIcon.addEventListener("error", () => {
    if (els.readPageIcon.getAttribute("src") !== COATI_ICON_PATH) els.readPageIcon.src = COATI_ICON_PATH;
  });
  // Back from the settings tab with the model still not answering: ask the
  // broker again (a status check, never a page read) — at most every 10 s,
  // and only while the first-launch card still shows that check missing.
  window.addEventListener("focus", maybeRecheckProviderForFirstRun);
  // Back from the tutorial with a freshly pulled model: same 10 s floor.
  window.addEventListener("focus", maybeRefreshModels);
  wireModelPicker();
  wireStatusLabel();
  els.send.addEventListener("click", sendChat);
  els.cancel.addEventListener("click", cancelActive);
  els.openMyPrompts.addEventListener("click", openMyPromptsPage);
  els.savePrompt.addEventListener("click", saveCurrentAsPrompt);
  els.eraseConversation.addEventListener("click", onEraseClick);
  // "Dev mode" (docs/PROTOCOL.md "Page on demand") — replaces the former
  // "Read the page"/"See the screen" switches. Turning it OFF is immediate;
  // turning it ON for the very first time ever shows the risk/cost
  // confirmation dialog first (dev-mode.js) — declined, the switch reverts.
  els.devMode.addEventListener("click", async () => {
    const turningOn = !isDevModeChecked();
    if (!turningOn) {
      panelState.devModePreference = false;
      updateDevModeUi();
      persistConversation();
      return;
    }
    const acknowledged = await api.storage.local
      .get(DEV_MODE_ACKNOWLEDGED_KEY)
      .then((data) => parseStoredDevModeAcknowledged(data[DEV_MODE_ACKNOWLEDGED_KEY]))
      .catch(() => false);
    if (!acknowledged) {
      const confirmed = await confirmDevModeActivation(document);
      if (!confirmed) return; // switch never moved — nothing to revert
      await api.storage.local.set({ [DEV_MODE_ACKNOWLEDGED_KEY]: true }).catch(() => {});
    }
    panelState.devModePreference = true;
    updateDevModeUi();
    persistConversation();
  });
  els.input.addEventListener("keydown", (event) => {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      sendChat();
    }
  });
  els.input.addEventListener("input", updateSavePromptEnabled);
  resizeComposer = bindAutogrow(els.input, { overflowClass: "composer-input--overflow" });
  // Favicon that fails to load (known Brave bug: the _favicon/ endpoint
  // answers nothing usable), or simply absent: the icon slot collapses —
  // no placeholder square (plan-mes-prompts-28-09.md, "no site icon: nothing").
  els.siteCardFavicon.addEventListener("error", () => {
    if (els.siteCardFavicon.hidden || !els.siteCardFavicon.getAttribute("src")) return;
    els.siteCardFavicon.hidden = true;
  });

  api.runtime.onMessage.addListener(onRuntimeMessage);
  api.tabs.onActivated.addListener(({ tabId }) => {
    currentTabId = tabId;
    redetectTabFromMetadata(tabId);
  });
  // Re-detect on navigation inside the current tab too, not just on tab
  // switch — a single-page app changing its URL, or a plain link click,
  // never fires onActivated. Filtered on currentTabId, debounced ~200ms
  // (a navigation fires several onUpdated events in a row), and
  // metadata-only exactly like redetectTabFromMetadata() below: never a page
  // read on its own (rule 5).
  const debouncedRedetectFromMetadata = debounce((tabId) => redetectTabFromMetadata(tabId), 200);
  api.tabs.onUpdated.addListener((tabId, changeInfo) => {
    if (tabId !== currentTabId) return;
    if (changeInfo.url == null && changeInfo.status == null) return;
    debouncedRedetectFromMetadata(tabId);
  });
  // The "Mes prompts" page (T42) toggles permissions too — keep the panel's
  // own "Activer" link (T43) in sync whether the change came from here or
  // from there. Re-detect from metadata, not just the link: a grant made while
  // the panel sits on that very site is what makes its address legible — without
  // this the card stayed on "This page" until the next tab switch or
  // navigation (bug of 29/09, Reddit activated from the page). Metadata-only,
  // never a page read (rule 5); redetectTabFromMetadata() refreshes the link.
  // Skipped right after a full read of this same tab (the read button's own
  // grant fires onAdded while its read is running): the metadata-only pass
  // would reset the fresher DOM-derived state (pageKind) that read produced.
  const onPermissionsChanged = async () => {
    await refreshAllSitesGranted();
    const justRead = lastRedetectTabId === currentTabId && Date.now() - lastRedetectAt < PERMISSION_REDETECT_SKIP_MS;
    if (currentTabId != null && !justRead) redetectTabFromMetadata(currentTabId);
    else refreshReadButton();
  };
  api.permissions.onAdded.addListener(onPermissionsChanged);
  api.permissions.onRemoved.addListener(onPermissionsChanged);
  // The options page writes the same key (same shared preference, dev-
  // mode.js): adopt its value, or the next persistConversation() would
  // overwrite it with the stale in-memory one.
  api.storage.onChanged.addListener((changes, area) => {
    if (area !== "local") return;
    if (DEV_MODE_KEY in changes) {
      panelState.devModePreference = parseStoredDevMode(changes[DEV_MODE_KEY].newValue);
      updateDevModeUi();
    }
  });

  await loadAccessPrefs();
  await refreshAllSitesGranted();

  await retryConnection();
  requestPrompts();
  requestPrefs();
  updateSavePromptEnabled();

  try {
    currentTabId = await activeTabId();
    // Reading the page on panel load is legitimate when the panel is loading
    // BECAUSE the user just clicked the icon. It is not when the browser
    // restored a panel left open from the previous session: that would be a
    // page read with nobody asking, which rule 5 forbids. Chrome gives us no
    // signal on the panel side, so the service worker stamps the browser's
    // startup and we stay on metadata-only classification for a few seconds
    // after it.
    if (await openedFromGesture()) {
      await redetectTab(currentTabId);
    } else {
      await redetectTabFromMetadata(currentTabId);
    }
  } catch {
    currentTabId = null;
    updateSiteCard();
    refreshReadButton();
  }

  await drainPendingAction();
  await showBuildInfo();
}

// --- Build fingerprint (deliverable C1) ------------------------------------
//
// Twice in one day, testing continued against a stale unpacked build with
// nothing on screen to reveal it. This computes a hash of the code the
// browser ACTUALLY loaded (fetched at runtime via chrome.runtime.getURL, not
// read from disk) so a mismatch with `scripts/stamp.sh`'s output — run
// against the files on disk — is visible in one glance, no devtools needed.

async function showBuildInfo() {
  els.buildInfo.textContent = "";
  const version = api.runtime.getManifest().version;
  const fingerprint = await computeCodeFingerprint(api).catch(() => null);
  els.buildInfo.textContent = fingerprint
    ? t("panel_build_fingerprint", [version, fingerprint])
    : t("panel_build_fingerprint_unavailable", [version]);
}

function onRuntimeMessage(message) {
  if (!message || typeof message !== "object") return;

  if (message.type === "coati:status") {
    applyStatus(message.state);
    applyBrokerFeatures(message.state, message.features);
    if (message.state === "connected") {
      requestPrompts();
      requestPrefs();
    }
    return;
  }

  if (message.type === "coati:pending-action") {
    drainPendingAction();
    return;
  }

  // The toolbar icon was clicked while this panel was already open — the
  // service worker no longer relies on chrome.sidePanel's automatic
  // open-on-click for that case (see service-worker.js). A real page read is
  // legitimate here: this IS the user's gesture (CLAUDE.md rule 5; T5 in
  // docs/DECISIONS.md). Skipped when init already read this tab via
  // openedFromGesture() because this same click opened the panel.
  if (message.type === "coati:action-clicked") {
    const tabId = parseActionClickedTabId(message);
    if (tabId != null && !isRedetectDuplicate(lastRedetectTabId, lastRedetectAt, tabId, Date.now())) {
      currentTabId = tabId;
      redetectTab(currentTabId);
    }
    return;
  }

  if (message.type === "coati:broker-message") {
    handleBrokerMessage(message.message);
  }
}

// Thin dispatcher: every case's actual body lives with the state it reads/
// writes (chat-stream.js, model-status.js, site-card.js).
function handleBrokerMessage(message) {
  if (!message || typeof message !== "object") return;
  switch (message.type) {
    case "chunk":
      onChunk(message);
      break;
    case "progress":
      onProgress(message);
      break;
    case "model.warmup-result":
      onModelWarmupResult(message);
      break;
    case "done":
      onDone(message);
      break;
    case "page.request":
      onPageRequest(message);
      break;
    case "search.request":
      onSearchRequest(message);
      break;
    case "open.request":
      onOpenRequest(message);
      break;
    case "error":
      onError(message);
      break;
    case "prompts":
      onPromptsMessage(message);
      break;
    case "prefs":
      onPrefsMessage(message);
      break;
    case "settings":
      onSettingsMessage(message);
      break;
    case "models":
      onModelsMessage(message);
      break;
    case "provider.status-result":
      onProviderStatusResult(message);
      break;
    default:
      break;
  }
}
