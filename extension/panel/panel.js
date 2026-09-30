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
// Rule (CLAUDE.md #5, "la règle du geste"): Coati never reads a page on its
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
//     keeps its generic "Résumer" label; only a recognisable shape like a
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
//     prompt sent with "Coati lit cette page" checked), the "Coati lit
//     cette page" toggle being ON at send time (`sendChat()`), or a
//     context-menu action on selected text. Each of those calls
//     `extractFromTab()` and, once real content came back, refines the type
//     and relabels the button via `applyDetectedContext()`.
//   - Page access, "voie B" (docs/DECISIONS.md T50, amended T42/T43): while
//      the page isn't accessible, the encart's head shows the "Lire cette
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

import { classifyPageType, classifyPageTypeFromMetadata } from "../content/detect.js";
import { applyRetention, RETENTION_DAYS_KEY, parseStoredRetentionDays } from "./retention.js";
import { api, IS_GECKO } from "../lib/browser-compat.js";
import { parseTimestamps, getYouTubeVideoIdFromUrl } from "./timestamps.js";
import { isNearBottom } from "./scroll.js";
import {
  providerLabel,
  describeError,
  EXTRACTION_TIMEOUT_LABEL,
  CONNECTION_STATUS_LABELS,
  ACCESS_DENIED_HINT,
} from "../lib/labels.js";
import { withDeadline } from "../lib/deadline.js";
import { cardState, faviconSrc, hostFromUrl, SPINNER_DELAY_MS } from "./card-state.js";
import { debounce } from "./debounce.js";
import { bindAutogrow } from "./composer-autogrow.js";
// suggestionsFor({ url, pageKind }) -> { site: {id, name}|null, siteKey: string|null, items: [...] }
// siteKeyFor(url) -> "@popular-site" | "hostname-no-www" | null (docs/PROTOCOL.md "PromptEntry").
import { suggestionsFor, siteKeyFor } from "../lib/suggestions.js";
// permissionPatternsFor(siteKey) -> chrome.permissions match patterns for that site key, [] for
// "*"/"@unsorted"/null (docs/DECISIONS.md T42/T43).
import { permissionPatternsFor } from "../lib/suggestions-data.js";
// Pure encart ordering (plan-mes-prompts-28-09.md, lot 3) — see its own
// header comment for the shape contract.
import { encartItems } from "./encart-items.js";
import { isRedetectDuplicate, parseActionClickedTabId } from "./redetect-dedupe.js";
// Unreadable-page decision (T46 point 3) — pure, see its own header comment.
import { isPdfUrl, readabilityMessage, stripReadability, PDF_MESSAGE } from "./unreadable.js";
import { renderMarkdown } from "./markdown.js";
import { computeCodeFingerprint } from "../lib/build-fingerprint.js";
import {
  readButtonState,
  ALL_SITES_ORIGINS,
  ALL_SITES_DECLINED_KEY,
  READ_BUTTON_USED_KEY,
} from "./read-button.js";
import { firstRunChecks, markFor, FIRST_RUN_TEXT, FIRST_RUN_DONE_KEY, RELEASES_URL } from "./first-run.js";
import { t, applyI18n } from "../lib/i18n.js";

applyI18n(document);

// Design-variant hook for captures only (notes/PLAN_goal_panneau_v2.md,
// "Contrat commun") — inert unless the panel's own address carries
// `?variant=a|b|c`; theme.css keys its variants off this attribute.
const requestedVariant = new URLSearchParams(location.search).get("variant");
if (requestedVariant) document.documentElement.dataset.variant = requestedVariant;

// Public repo doc, opened from the "no-host" banner (docs/PROTOCOL.md
// amendement 2026-09-30, "États et bandeaux"). No local doc viewer in the
// extension itself, so this points at the same repo the "À propos" section
// already links to.
const INSTALL_DOC_URL = "https://github.com/CARL-Bouvet/coati/blob/main/docs/INSTALL.md";

const STORAGE_KEY = "coati:conversation";
const ATTACH_PAGE_KEY = "coati:attachPage";
const PENDING_ACTION_KEY = "coati:pendingAction";
const MAX_PERSISTED_MESSAGES = 200;

// Client-side deadline for an in-flight request (deliverable B1). Set just
// PAST the broker's own 120s model timeout (broker/src/model.ts,
// MODEL_TIMEOUT_MS) so, when the broker's specific "model-unavailable" error
// can still reach us, it wins the race and this generic deadline never fires.
// It only fires for the case the broker's own timeout can't cover: the
// answer that never arrives at all (socket dropped mid-request).
const REQUEST_DEADLINE_MS = 130_000;
// How often the panel checks that the service worker instance which
// accepted the current request is still the same one (deliverable B4).
const WORKER_HEARTBEAT_MS = 5_000;

const MAIN_BUTTON_LABELS = {
  video: t("panel_summarize_video"),
  article: t("panel_summarize_article"),
  page: t("panel_summarize_page"),
};

// Amendement 2026-09-25 (types de page), docs/PROTOCOL.md "Types de page,
// faits et entrées". `context.pageKind` — set by extract.js only for
// kind === "page" — refines the generic "page" label above. Plain text only,
// same button, same styling: no new visual element, no new CSS (task scope).
// `other` keeps today's wording so an unrecognized/absent pageKind (an older
// client, or the amendment's own "doute → other") reads exactly as before.
const PAGE_KIND_BUTTON_LABELS = {
  list: t("panel_summarize_results"),
  listing: t("panel_summarize_listing"),
  article: t("panel_summarize_article"),
  other: t("panel_summarize_page"),
};

const els = {
  status: document.getElementById("status"),
  statusLabel: document.querySelector("#status .status-label"),
  connectionBanner: document.getElementById("connectionBanner"),
  connectionBannerText: document.getElementById("connectionBannerText"),
  connectCoati: document.getElementById("connectCoati"),
  installDocLink: document.getElementById("installDocLink"),
  openOptions: document.getElementById("openOptions"),
  readPage: document.getElementById("readPage"),
  readPageIcon: document.getElementById("readPageIcon"),
  readPageLabel: document.getElementById("readPageLabel"),
  readPageNote: document.getElementById("readPageNote"),
  firstRun: document.getElementById("firstRun"),
  firstRunTitle: document.getElementById("firstRunTitle"),
  firstRunSteps: document.getElementById("firstRunSteps"),
  siteCard: document.getElementById("siteCard"),
  siteCardSpinner: document.getElementById("siteCardSpinner"),
  siteCardFavicon: document.getElementById("siteCardFavicon"),
  siteCardLabel: document.getElementById("siteCardLabel"),
  siteCardSuggestions: document.getElementById("siteCardSuggestions"),
  openMyPrompts: document.getElementById("openMyPrompts"),
  savePrompt: document.getElementById("savePrompt"),
  promptSavedNotice: document.getElementById("promptSavedNotice"),
  messages: document.getElementById("messages"),
  attachPage: document.getElementById("attachPage"),
  input: document.getElementById("input"),
  send: document.getElementById("send"),
  cancel: document.getElementById("cancel"),
  eraseConversation: document.getElementById("eraseConversation"),
  buildInfo: document.getElementById("buildInfo"),
};

/** @type {Array<{id: string, role: 'user'|'assistant'|'system', text: string}>} */
let conversation = [];
let activeRequestId = null;
/** @type {Array<{id:string, site:string, title?:string, body:string}>} */
let prompts = [];
/** @type {Record<string, {order?:string[], removed?:string[]}>} */
let prefsSites = {};

// Replay payloads for the "J'ai relancé, réessayer" recovery button
// (deliverable D1) — keyed by request id, in-memory only (never persisted to
// chrome.storage.local: it can hold page content, same reasoning as why
// context.url is kept out of the conversation elsewhere in this file). Only
// kept for a request that ended in "auth-required": any other terminal
// outcome drops its entry, so this never grows unbounded over a long session.
const pendingRetries = new Map();

// Request-watch state (deliverables B1 + B4) — armed by startRequestWatch()
// right after a request is sent, disarmed by clearRequestWatch() whenever
// setStreamingUi(false) runs (done/error/cancel/disconnect all funnel there).
let requestDeadlineTimer = null;
let requestHeartbeatTimer = null;
let requestWorkerInstanceId = null; // service worker instance that accepted the current request, or null

// Page detection state (deliverable 1) — see the comment block above.
let currentTabId = null;
let pageType = null; // "video" | "article" | "page" | null (unknown)
// "list" | "listing" | "article" | "other" | null (unknown — no DOM read yet,
// or the client-side context predates the amendment). DOM-derived only:
// redetectTabFromMetadata() never sets this (see its own comment).
let pageKind = null;
let knownOrigin = null; // origin string once learned (granted, or from a failed-extraction error), or null
// See redetect-dedupe.js for why this exists (the "coati:action-clicked"
// message can race init's own redetectTab() for the same click).
let lastRedetectTabId = null;
let lastRedetectAt = 0;

// Site card state (T27-T29) — see card-state.js for the pure state logic.
// `currentPageUrl` is the full URL when it's legible (metadata via a granted
// host permission, or from a completed extraction) and null otherwise — same
// visibility rule as knownOrigin, just the full string instead of the
// origin. `currentFavIconUrl` is the icon source from faviconSrc(): Chromium's
// `_favicon/` cache endpoint, or an inline data: favicon on Firefox — never a
// request to an address the page chose (T28: the site's own favicon, never a
// bundled logo).
let currentPageUrl = null;
let currentFavIconUrl = null;
let cardDetectingTimer = null;

// "Coati lit cette page" toggle (deliverable 3). null = no stored
// preference yet, so default to true once a page type is known.
let attachPagePreference = null;

// Erase-button two-step confirm state (no window.confirm — see the comment
// above wireEraseButton()).
let eraseConfirmPending = false;
let eraseConfirmTimer = null;

// Composer height recompute (lot 4) — set in init(), called after every
// programmatic change of els.input.value (those fire no "input" event).
let resizeComposer = () => {};

// "Enregistré pour <site>" notice (plan-mes-prompts-28-09.md, lot 3) — cleared
// after a couple seconds, same pattern as the recovery button's "Copié !".
let promptSavedNoticeTimer = null;

/** Thrown by extractReadableFromTab (never by extractFromTab itself) when the
 * page cannot usefully be read even though the injection succeeded: a PDF
 * shown by the browser's own viewer (extraction never runs there), or
 * extract.js reporting `readability: "canvas" | "empty"` — see "Unreadable
 * pages" below. `message` is the ready-to-display French text. */
class UnreadablePageError extends Error {
  constructor(message) {
    super(message);
    this.name = "UnreadablePageError";
  }
}

// Security review 2026-09-26, finding #2: chrome.scripting.executeScript has
// no deadline of its own, so a hostile or pathologically heavy page could
// leave the panel awaiting page content forever. EXTRACTION_DEADLINE_MS is
// deliberately generous — no measurement in notes/corpus/ approaches even a
// few seconds — so it never fires on a real page; it only bounds the
// pathological case. This must NOT be used to cap the extraction loops
// themselves (extract.js): that would change results on heavy real pages,
// which is out of scope for this fix.
const EXTRACTION_DEADLINE_MS = 20000;

class ExtractionTimeoutError extends Error {
  constructor() {
    super(EXTRACTION_TIMEOUT_LABEL);
    this.name = "ExtractionTimeoutError";
  }
}

init();

async function init() {
  conversation = await loadConversation();
  renderAll();

  els.openOptions.addEventListener("click", () => api.runtime.openOptionsPage());
  // Opens the options page — options.js auto-expands the "Navigateur sans
  // programme natif (Flatpak, Snap)" section for both states this button is
  // shown in (no-host, no-token). Same page as the gear icon, no separate
  // "connect" flow left (docs/PROTOCOL.md: /pair removed from the extension).
  els.connectCoati.addEventListener("click", () => api.runtime.openOptionsPage());
  els.installDocLink.addEventListener("click", () => api.tabs.create({ url: INSTALL_DOC_URL }));
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
  els.send.addEventListener("click", sendChat);
  els.cancel.addEventListener("click", cancelActive);
  els.openMyPrompts.addEventListener("click", openMyPromptsPage);
  els.savePrompt.addEventListener("click", saveCurrentAsPrompt);
  els.eraseConversation.addEventListener("click", onEraseClick);
  els.attachPage.addEventListener("click", () => {
    attachPagePreference = !isAttachPageChecked();
    setAttachPageChecked(attachPagePreference);
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
  // no placeholder square (plan-mes-prompts-28-09.md, "pas d'icône du
  // site : rien").
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
  // this the card stayed on « Cette page » until the next tab switch or
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
  // The settings page writes the same key: adopt its value, or the next
  // persistConversation() would overwrite it with the stale in-memory one.
  api.storage.onChanged.addListener((changes, area) => {
    if (area !== "local" || !(ATTACH_PAGE_KEY in changes)) return;
    const value = changes[ATTACH_PAGE_KEY].newValue;
    attachPagePreference = typeof value === "boolean" ? value : null;
  });

  await loadAccessPrefs();
  await refreshAllSitesGranted();

  const status = await api.runtime.sendMessage({ type: "coati:panel-ready" }).catch(() => null);
  applyStatus(status?.state ?? "unknown");
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
    updateAttachToggle();
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

function handleBrokerMessage(message) {
  if (!message || typeof message !== "object") return;

  switch (message.type) {
    case "chunk": {
      const msg = conversation.find((m) => m.id === message.id);
      if (msg) {
        msg.text += message.delta ?? "";
        renderMessage(msg);
      }
      break;
    }
    case "done": {
      pendingRetries.delete(message.id);
      const msg = conversation.find((m) => m.id === message.id);
      if (msg) {
        msg.streaming = false;
        renderMessage(msg);
        // A complete answer proves the model works, whatever provider.status said.
        if (msg.role === "assistant" && msg.text && !modelAnswered) {
          modelAnswered = true;
          renderFirstRun();
        }
      }
      if (activeRequestId === message.id) setStreamingUi(false);
      persistConversation();
      break;
    }
    case "error": {
      // docs/PROTOCOL.md "Disponibilité du fournisseur": an older broker that
      // doesn't know provider.status answers some generic error for this id
      // instead of provider.status-result — show nothing for it, per spec.
      if (message.id === providerStatusRequestId) {
        providerStatusRequestId = null;
        break;
      }
      const text = describeBrokerError(message);
      const authRequired = message.code === "auth-required";
      // Remedy depends on the provider (session to reopen vs key to fix) —
      // stored on the message so a reloaded conversation keeps the right block.
      const authKind = authRequired ? authKindFor(currentProvider) : undefined;
      if (!authRequired) pendingRetries.delete(message.id);
      // Clear activeRequestId BEFORE rendering: buildAuthRecoveryBlock()
      // reads it to decide whether the retry button starts enabled, and
      // this terminal error is exactly what should free it up again.
      if (activeRequestId === message.id) setStreamingUi(false);
      const msg = conversation.find((m) => m.id === message.id);
      if (msg) {
        msg.streaming = false;
        msg.text = msg.text || text;
        msg.authRequired = authRequired;
        msg.authKind = authKind;
        renderMessage(msg);
      } else {
        addMessage({ id: message.id, role: "system", text, authRequired, authKind });
      }
      persistConversation();
      break;
    }
    // Relayed as broadcast (service-worker.js broadcasts every broker
    // message to all extension pages) — applied here whoever requested it,
    // so this panel stays in sync with any change made from "Mes prompts"
    // in another tab, for free.
    case "prompts": {
      prompts = Array.isArray(message.items) ? message.items : [];
      // prompts.move's reply also carries the full prefs (docs/PROTOCOL.md)
      // — folded in here too, so a move made elsewhere updates order/removed
      // without a separate round trip.
      if (message.prefs && typeof message.prefs === "object" && message.prefs.sites) {
        prefsSites = message.prefs.sites;
      }
      updateSiteCard();
      break;
    }
    case "prefs": {
      prefsSites = message.sites && typeof message.sites === "object" ? message.sites : {};
      updateSiteCard();
      break;
    }
    case "provider.status-result": {
      if (message.id !== providerStatusRequestId) break; // stale/unrelated — ignore
      providerStatusRequestId = null;
      providerStatusSuffix = formatProviderStatus(message);
      providerState = ["ok", "ko", "unknown"].includes(message.state) ? message.state : "unknown";
      currentProvider = typeof message.provider === "string" ? message.provider : null;
      renderStatusLabel();
      renderFirstRun();
      break;
    }
    default:
      break;
  }
}

// `auth-required` (docs/PROTOCOL.md "Session expirée ou identifiants non
// authentifiés") has two remedies: a CLI session to reopen (`claude-cli`,
// personal module) or an API key the provider refused (`claude-api`,
// `openai-compat`, anything else). The error itself carries no provider id,
// so the panel uses the one from the last provider.status-result; unknown
// (no answer yet) gets a text naming both remedies.
const AUTH_REQUIRED_TEXT = {
  session: t("panel_auth_session_expired"),
  key: t("panel_auth_key_refused"),
  unknown: t("panel_auth_unknown"),
  copy: t("panel_copy"),
  copied: t("panel_copied"),
  copyFailed: t("panel_copy_failed"),
  openSettings: t("panel_open_settings"),
  retrySession: t("panel_retry_session"),
  retryKey: t("panel_retry_key"),
};
const SESSION_AUTH_PROVIDERS = new Set(["claude-cli"]);
// Provider id from the last provider.status-result, null until one arrives.
let currentProvider = null;

/** "session" | "key" | "unknown" — which remedy an auth-required needs. */
function authKindFor(provider) {
  if (!provider) return "unknown";
  return SESSION_AUTH_PROVIDERS.has(provider) ? "session" : "key";
}

/** Maps a terminal broker `error` to a French message that names its own
 * remedy (deliverable B5, third banner: "broker reachable but the model
 * failed"). The other two B5 causes — broker unreachable, no pairing token —
 * are connection-level states handled separately by applyConnectionBanner();
 * this one is per-request, so it renders inline in the conversation like any
 * other error, not as a banner. */
function describeBrokerError(message) {
  // docs/PROTOCOL.md "Limites côté broker" — the broker sends this fixed id,
  // then closes the connection with code 1009; the normal reconnect flow
  // (backoff/alarm) takes over from there, same as any other drop.
  if (message.id === "oversized") {
    return t("panel_error_oversized");
  }
  switch (message.code) {
    case "model-unavailable":
      // Covers both the broker's own 120s model-call timeout and a model
      // that can't be reached at all (broker/src/model.ts, MODEL_TIMEOUT_MS)
      // — the broker itself is fine, the model is the problem.
      return t("panel_error_model_unavailable", [message.message || t("panel_unavailable")]);
    case "auth-required":
      // Provider-aware (see AUTH_REQUIRED_TEXT): the actionable part (copy
      // `claude /login`, or open the settings; then retry) is rendered
      // separately by renderMessage() via msg.authRequired/msg.authKind —
      // see buildAuthRecoveryBlock() below.
      return AUTH_REQUIRED_TEXT[authKindFor(currentProvider)];
    case "cancelled":
      return t("panel_request_cancelled");
    case "context-too-large":
      return t("panel_error_context_too_large_warn");
    default:
      // Covers "bad-request" and any other/unknown code: a French label
      // keyed on `code` (extension/lib/labels.js, shared with options.js),
      // the broker's English `message` demoted to a secondary "Détail : …"
      // line — never shown on its own (bug report gap 3).
      return `⚠ ${describeError(message.code, message.message)}`;
  }
}

// Current connection state, kept so a later provider.status-result (which
// arrives asynchronously) can be folded into the status line without
// recomputing/duplicating the connection label above it.
let currentConnState = "unknown";
// Short factual French text from the last provider.status-result, or "" when
// there is nothing to add (state "ok", or no check done yet this panel
// session) — see maybeRequestProviderStatus()/renderStatusLabel() below.
let providerStatusSuffix = "";

function applyStatus(state) {
  // A dropped connection must not leave the panel permanently locked: any
  // in-flight request will never get its "done"/"error" reply now.
  if ((state === "disconnected" || state === "no-token") && activeRequestId) {
    setStreamingUi(false);
  }

  currentConnState = state;
  if (state !== "connected") providerStatusSuffix = ""; // stale once disconnected
  els.status.className = `status status--${state}`;
  renderStatusLabel();
  applyConnectionBanner(state);
  if (state === "connected") maybeRequestProviderStatus();
  renderFirstRun();
}

function renderStatusLabel() {
  const labels = { ...CONNECTION_STATUS_LABELS, "no-token": t("panel_status_no_token") };
  let text = labels[currentConnState] ?? currentConnState;
  if (currentConnState === "connected" && providerStatusSuffix) text += ` · ${providerStatusSuffix}`;
  els.statusLabel.textContent = text;
}

// Four connection-level states share this one banner (deliverable G4,
// docs/PROTOCOL.md amendement 2026-09-30, "États et bandeaux") — never
// confused with each other, each with its own fix:
// - "no-host": Coati can't reach its local pairing program at all (not
//   installed, wrong id, browser sandboxed with no native messaging) — fix:
//   install it, or the Flatpak/Snap manual-pairing section in the options.
// - "broker-untrusted": something answers on the port but didn't prove it's
//   the Coati broker — nothing was sent to it, no further action from here.
// - "no-token": the broker is reachable and proved itself, but refused this
//   extension's id — fix: allowedExtensionIds, broker-side.
// - "disconnected": we hold a key the broker already trusts, it just isn't
//   answering right now — fix: start the broker.
function applyConnectionBanner(state) {
  els.installDocLink.hidden = true;
  els.connectCoati.hidden = true;

  if (state === "no-host") {
    els.connectionBannerText.textContent = t("panel_banner_no_host");
    els.installDocLink.hidden = false;
    els.connectCoati.hidden = false;
    els.connectionBanner.hidden = false;
    return;
  }
  if (state === "broker-untrusted") {
    els.connectionBannerText.textContent = t("panel_banner_broker_untrusted");
    els.connectionBanner.hidden = false;
    return;
  }
  if (state === "no-token") {
    els.connectionBannerText.textContent = t("panel_banner_no_token", [api.runtime.id]);
    els.connectCoati.hidden = false;
    els.connectionBanner.hidden = false;
    return;
  }
  if (state === "disconnected") {
    els.connectionBannerText.textContent = t("panel_banner_disconnected");
    els.connectionBanner.hidden = false;
    return;
  }
  els.connectionBanner.hidden = true;
}

// --- Disponibilité du fournisseur (docs/PROTOCOL.md "provider.status") ----
//
// Sent once per panel open, on a user gesture (opening the panel), the first
// time this panel reaches "connected" — never from the service worker, never
// on a timer. One exception (T51): while the first-launch card still shows
// "model" missing, the panel regaining focus (the user coming back from the
// settings tab) asks again, at most every PROVIDER_RECHECK_MIN_MS.

let providerStatusRequested = false;
let providerStatusRequestId = null;
// Last provider.status-result `state` ("ok" | "ko" | "unknown"), null = none yet.
let providerState = null;
let providerRecheckAt = 0;
const PROVIDER_RECHECK_MIN_MS = 10_000;

function maybeRequestProviderStatus() {
  if (providerStatusRequested) return;
  providerStatusRequested = true;
  sendProviderStatus();
}

function maybeRecheckProviderForFirstRun() {
  if (els.firstRun.hidden || currentConnState !== "connected" || providerState === "ok" || modelAnswered) return;
  if (providerStatusRequestId || Date.now() - providerRecheckAt < PROVIDER_RECHECK_MIN_MS) return;
  providerRecheckAt = Date.now();
  sendProviderStatus();
}

function sendProviderStatus() {
  const id = newId();
  providerStatusRequestId = id;
  api.runtime.sendMessage({
    type: "coati:client-message",
    payload: { type: "provider.status", id },
  });
}

// Reason codes are a closed, stable, English list read by this code only
// (docs/PROTOCOL.md "Disponibilité du fournisseur") — never shown as-is.
// `state: "ok"` is shown too: the point of the check is that the user sees,
// before any click, whether the model will answer (goal 2026-09-25, Q5).
// Provider display names come from lib/labels.js — the single shared table
// with options.js (bug report gap 4: names must match everywhere).

const PROVIDER_STATUS_REASON_TEXT = {
  "ready": t("panel_provider_ready"),
  "logged-in": t("panel_provider_logged_in"),
  "no-key": t("panel_provider_no_key"),
  "key-unverified": t("panel_provider_key_unverified"),
  "cli-missing": t("panel_provider_cli_missing"),
  "not-logged-in": t("panel_provider_not_logged_in"),
  "probe-failed": t("panel_provider_probe_failed"),
  "ollama-unreachable": t("panel_provider_ollama_unreachable"),
  "model-missing": t("panel_provider_model_missing"),
  "no-model-installed": t("panel_provider_no_model_installed"),
};

function formatProviderStatus(message) {
  const label = providerLabel(message.provider, t("panel_provider_default_label"));
  const reasonText =
    PROVIDER_STATUS_REASON_TEXT[message.reason] ?? (message.state === "ok" ? t("panel_provider_ready") : t("panel_provider_unknown_state"));
  return t("panel_provider_status_line", [label, reasonText]);
}

// --- Chat ---------------------------------------------------------------

/** Reads the page when "Coati lit cette page" is on right now, else resolves
 * to `undefined` — the shared "should we attach" check for sendChat() and
 * relaunchMessage() (both read the switch's CURRENT state, never whatever it
 * was at the original send). Throws on an extraction failure; the caller
 * reports it via reportExtractionError(). */
async function extractIfAttaching() {
  const attach = !els.attachPage.disabled && isAttachPageChecked() && currentTabId != null;
  return attach ? extractReadableFromTab(currentTabId) : undefined;
}

async function sendChat() {
  const text = els.input.value.trim();
  if (!text || activeRequestId) return;

  // Extract at send time only — never on every keystroke. Never send the
  // question alone when the user asked for the page to be attached: a blind
  // answer looks like a working feature and wastes a turn.
  let context;
  try {
    context = await extractIfAttaching();
  } catch (err) {
    reportExtractionError(err, {
      accessDenied: t("panel_access_denied_question", [ACCESS_DENIED_HINT]),
      other: (e) => t("panel_read_error_question", [e.message]),
    });
    return;
  }

  const text0 = text;
  els.input.value = "";
  resizeComposer();
  updateSavePromptEnabled();
  await sendChatMessage(text0, context);
}

/** Shared tail of "send a chat message, with or without the page attached" —
 * used by sendChat() (the composer's Send button, attach depending on the
 * "Coati lit cette page" toggle) and runSuggestion() (a site-card
 * suggestion click, always attached — see its own comment). */
async function sendChatMessage(text, context) {
  const id = newId();
  const note = context ? PAGE_CONTENT_MARKER_SUFFIX : "";
  // `relaunch` (plan-mes-prompts-28-09.md, "Relancer"): resending this exact
  // message means resending `text` through this same function, reading the
  // page per the switch's state AT THE TIME OF THE RELAUNCH — never a cached
  // copy of `context`, which can hold page content (kept out of
  // chrome.storage.local, same reasoning as context.url elsewhere).
  addMessage({ id: `${id}-u`, role: "user", text: `${text}${note}`, relaunch: { type: "chat", text } });
  addMessage({ id, role: "assistant", text: "", streaming: true });

  activeRequestId = id;
  setStreamingUi(true);
  persistConversation();

  pendingRetries.set(id, { type: "chat", text, context });
  await sendClientMessage({ type: "chat", id, text, context });
}

// --- Site card suggestions (T27-T30) ---------------------------------------
//
// A suggestion click sends its prompt WITH the page content, through the
// exact same path as a library prompt used with "Coati lit cette page"
// checked (sendChatMessage above) — the click itself is the gesture that
// justifies the read (rule 5), same as the main button's summarize(). On a
// YouTube video, the click may open YouTube's own transcript panel once, like
// summarize() (named exception, widened on 26/09 — openTranscriptIfNeeded()).

// YouTube charge sa transcription en différé. Après un clic de l'utilisateur
// (résumé ou suggestion vidéo), on ouvre le panneau une fois — exception nommée
// à la règle du geste — puis on relit. Sans transcription il n'y aurait que la
// description et les commentaires, ce qui produirait une réponse plausible et
// fausse : les appelants s'arrêtent alors sur reportMissingTranscript().
async function openTranscriptIfNeeded(context) {
  if (!context.needsTranscript) return context;
  const opened = await openYouTubeTranscript(currentTabId).catch(() => false);
  // Re-extraction here reuses extractFromTab, not extractReadableFromTab: the
  // page's readability can't have changed between the two reads (only the
  // transcript panel opened), so this just strips the field again rather than
  // re-running the PDF/canvas/empty checks a second time.
  return opened ? stripReadability(await extractFromTab(currentTabId).catch(() => context)) : context;
}

// Message factuel, sans qualification juridique : soit YouTube a changé sa
// page, soit la vidéo n'a pas de sous-titres. C'est aussi le signal de rupture
// prévu par T19.
function reportMissingTranscript() {
  addMessage({
    id: newId(),
    role: "system",
    text: t("panel_transcript_missing"),
  });
}

async function runSuggestion(promptText) {
  if (activeRequestId || currentTabId == null) return;
  activeRequestId = "pending"; // in-flight guard until sendChatMessage sets the real id
  setStreamingUi(true);

  let context;
  try {
    context = await extractReadableFromTab(currentTabId);
  } catch (err) {
    setStreamingUi(false);
    reportExtractionError(err, {
      accessDenied: t("panel_access_denied_generic", [ACCESS_DENIED_HINT]),
      other: (e) => t("panel_read_error_generic", [e.message]),
    });
    return;
  }

  context = await openTranscriptIfNeeded(context);
  if (context.needsTranscript) {
    reportMissingTranscript();
    setStreamingUi(false);
    return;
  }

  await sendChatMessage(promptText, context);
}

// Cancelling clears the in-flight state right away rather than waiting on the
// broker's "error"/cancelled reply (deliverable B1): that reply is exactly
// what might never arrive if we're cancelling because the connection is
// stuck. The protocol does define a "cancel" message (docs/PROTOCOL.md), so
// it is still sent best-effort in case the broker is in fact listening.
function cancelActive() {
  if (!activeRequestId) return;
  const id = activeRequestId;
  pendingRetries.delete(id);
  api.runtime.sendMessage({
    type: "coati:client-message",
    payload: { type: "cancel", id: newId(), target: id },
  });
  const msg = conversation.find((m) => m.id === id);
  if (msg) {
    msg.streaming = false;
    if (!msg.text) msg.text = t("panel_request_cancelled");
    renderMessage(msg);
  }
  setStreamingUi(false);
  persistConversation();
}

// --- Erase conversation (deliverable "historique — effacement") -----------
//
// `window.confirm()` is unreliable in extension surfaces (it is outright
// blocked in MV3 popups, and Chrome's side panel behavior is not documented
// as supported either) — so confirmation is inline, in the panel itself: a
// first click turns the button into "Confirmer l'effacement ?", a second
// click within 4 s actually erases. A human must click twice in the real
// side panel to verify this reads clearly; that click cannot be simulated
// here.
function onEraseClick() {
  if (!eraseConfirmPending) {
    eraseConfirmPending = true;
    els.eraseConversation.textContent = t("panel_confirm_erase");
    els.eraseConversation.classList.add("link-button--confirm");
    eraseConfirmTimer = setTimeout(resetEraseButton, 4000);
    return;
  }
  resetEraseButton();
  eraseConversation();
}

function resetEraseButton() {
  eraseConfirmPending = false;
  clearTimeout(eraseConfirmTimer);
  eraseConfirmTimer = null;
  els.eraseConversation.textContent = t("panel_erase_conversation");
  els.eraseConversation.classList.remove("link-button--confirm");
}

async function eraseConversation() {
  // Cancel any in-flight request first — its "chunk"/"done" replies must not
  // repopulate the conversation we are about to wipe.
  cancelActive();
  activeRequestId = null;
  setStreamingUi(false);

  conversation = [];
  pendingRetries.clear();
  await api.storage.local.remove(STORAGE_KEY);
  persistConversation();
  renderAll();
}

// --- Auth recovery (deliverable D1) ---------------------------------------
//
// The broker's `auth-required` error (docs/PROTOCOL.md, "Fournisseur de
// modèle") means the local `claude` CLI session expired. We deliberately do
// NOT relay or drive the interactive `claude /login` flow (that decision is
// final, see the task brief) — the panel only makes the manual fix as cheap
// as possible: the exact command to copy, and a button that replays the
// request that just failed once the user says they ran it.

/** Builds the actionable block appended under an assistant/system message
 * whose terminal error was `auth-required`. No innerHTML — real DOM nodes,
 * same discipline as linkifyTimestamps() above. */
function buildAuthRecoveryBlock(msg) {
  const block = document.createElement("div");
  block.className = "recovery-block";
  // Messages persisted before authKind existed were all claude-cli sessions.
  const kind = msg.authKind ?? "session";

  if (kind === "session") {
    const commandRow = document.createElement("div");
    commandRow.className = "recovery-command";
    const code = document.createElement("code");
    code.textContent = "claude /login";
    const copyBtn = document.createElement("button");
    copyBtn.type = "button";
    copyBtn.className = "recovery-copy";
    copyBtn.textContent = AUTH_REQUIRED_TEXT.copy;
    copyBtn.addEventListener("click", () => copyLoginCommand(copyBtn));
    commandRow.appendChild(code);
    commandRow.appendChild(copyBtn);
    block.appendChild(commandRow);
  } else {
    // API key (or unknown provider): the key lives in the broker, set from
    // the settings page — the one place to fix it.
    const settingsBtn = document.createElement("button");
    settingsBtn.type = "button";
    settingsBtn.className = "recovery-copy";
    settingsBtn.textContent = AUTH_REQUIRED_TEXT.openSettings;
    settingsBtn.addEventListener("click", () => api.runtime.openOptionsPage());
    block.appendChild(settingsBtn);
  }

  // Only offered when we still hold the payload to replay — lost across a
  // panel reload (pendingRetries is in-memory only), in which case the copy
  // button above remains the fallback: rerun the question by hand.
  if (pendingRetries.has(msg.id)) {
    const retryBtn = document.createElement("button");
    retryBtn.type = "button";
    retryBtn.className = "recovery-retry";
    retryBtn.textContent = kind === "session" ? AUTH_REQUIRED_TEXT.retrySession : AUTH_REQUIRED_TEXT.retryKey;
    retryBtn.disabled = !!activeRequestId;
    retryBtn.addEventListener("click", () => retryRequest(msg));
    block.appendChild(retryBtn);
  }

  return block;
}

async function copyLoginCommand(button) {
  const original = button.textContent;
  try {
    await navigator.clipboard.writeText("claude /login");
    button.textContent = AUTH_REQUIRED_TEXT.copied;
  } catch {
    button.textContent = AUTH_REQUIRED_TEXT.copyFailed;
  }
  setTimeout(() => {
    button.textContent = original;
  }, 1500);
}

/** Replays the request that ended in `auth-required`, reusing its own id —
 * by the time this can be clicked that id already reached a terminal state,
 * so the broker/service-worker no longer track anything under it. Sending it
 * again goes through the exact same path (sendToBroker's one-slot pending
 * queue, panel.js's 130s request-watch deadline) as any first-time request —
 * no separate replay machinery (task brief, D1). */
async function retryRequest(msg) {
  if (activeRequestId) return;
  const payload = pendingRetries.get(msg.id);
  if (!payload) return;

  msg.authRequired = false;
  msg.authKind = undefined;
  msg.text = "";
  msg.streaming = true;
  renderMessage(msg);

  activeRequestId = msg.id;
  setStreamingUi(true);
  persistConversation();

  await sendClientMessage({ ...payload, id: msg.id });
}

function setStreamingUi(streaming) {
  els.send.disabled = streaming;
  els.cancel.hidden = !streaming;
  // Encart buttons and every "Relancer" already in the conversation: a
  // gesture-driven read must not overlap another in-flight request.
  for (const button of els.siteCardSuggestions.querySelectorAll("button")) button.disabled = streaming;
  for (const button of els.messages.querySelectorAll(".message-relaunch")) button.disabled = streaming;
  if (!streaming) {
    activeRequestId = null;
    clearRequestWatch();
  }
}

// --- Request watch (deliverables B1 + B4) ---------------------------------
//
// Armed right after a request is sent to the background, disarmed the moment
// streaming stops for any reason (done, error, cancel, or a disconnect — see
// setStreamingUi). Two independent guards run in parallel:
//   - a deadline, just past the broker's own 120s model timeout, for the
//     case where no reply — not even the broker's own error — ever arrives;
//   - a heartbeat that notices the service worker instance changed under us,
//     which means it was killed by the MV3 lifecycle mid-request and nothing
//     is coming for this id no matter how long we wait.

/** Sends a `coati:client-message` request to the service worker and arms
 * the request-watch deadline with whatever `workerInstanceId` comes back in
 * the ack (or null if the send itself failed) — the shared tail of every
 * place that kicks off a chat/summarize/act request or replays one. */
async function sendClientMessage(payload) {
  const ack = await api.runtime.sendMessage({ type: "coati:client-message", payload }).catch(() => null);
  startRequestWatch(payload.id, ack?.workerInstanceId ?? null);
}

function startRequestWatch(id, workerInstanceId) {
  clearRequestWatch();
  requestWorkerInstanceId = workerInstanceId;
  requestDeadlineTimer = setTimeout(() => onRequestDeadline(id), REQUEST_DEADLINE_MS);
  requestHeartbeatTimer = setInterval(() => checkWorkerAlive(id), WORKER_HEARTBEAT_MS);
}

function clearRequestWatch() {
  clearTimeout(requestDeadlineTimer);
  clearInterval(requestHeartbeatTimer);
  requestDeadlineTimer = null;
  requestHeartbeatTimer = null;
  requestWorkerInstanceId = null;
}

async function checkWorkerAlive(id) {
  if (activeRequestId !== id) return;
  const status = await api.runtime.sendMessage({ type: "coati:get-status" }).catch(() => null);
  if (!status || activeRequestId !== id) return;
  if (
    requestWorkerInstanceId &&
    status.workerInstanceId &&
    status.workerInstanceId !== requestWorkerInstanceId
  ) {
    failActiveRequest(id, t("panel_worker_restarted"));
  }
}

function onRequestDeadline(id) {
  if (activeRequestId !== id) return;
  failActiveRequest(id, t("panel_no_response_130s"));
}

function failActiveRequest(id, text) {
  const msg = conversation.find((m) => m.id === id);
  if (msg) {
    msg.streaming = false;
    if (!msg.text) msg.text = `⚠ ${text}`;
    renderMessage(msg);
  } else {
    addMessage({ id: newId(), role: "system", text: `⚠ ${text}` });
  }
  if (activeRequestId === id) setStreamingUi(false);
  persistConversation();
}

// --- Page detection (deliverable 1) --------------------------------------

/** `pageKind` (DOM-derived, kind === "page" only) wins over the legacy
 * `pageType` label when known; falls back to it otherwise — an older broker
 * exchange, a video, or a page read before the DOM classifier ran. */
function mainButtonLabel() {
  if (pageKind && PAGE_KIND_BUTTON_LABELS[pageKind]) return PAGE_KIND_BUTTON_LABELS[pageKind];
  return MAIN_BUTTON_LABELS[pageType] ?? t("panel_summarize_default");
}

function updateAttachToggle() {
  // Gated on "do we have a tab to read", not on whether its type is already
  // known — real extraction always happens at send time (a gesture), even
  // when redetectTabFromMetadata() left the type unknown.
  const available = currentTabId != null;
  els.attachPage.disabled = !available;
  setAttachPageChecked(available && (attachPagePreference ?? true));
}

/** `#attachPage` is a `role="switch"` button (Lot 2), not a checkbox: its
 * state lives in `aria-checked`/the `.switch--on` class, not `.checked`. */
function setAttachPageChecked(checked) {
  els.attachPage.setAttribute("aria-checked", String(checked));
  els.attachPage.classList.toggle("switch--on", checked);
}

function isAttachPageChecked() {
  return els.attachPage.getAttribute("aria-checked") === "true";
}

// --- Site card (T27-T29, encart lot 3 — plan-mes-prompts-28-09.md) --------
//
// Fixed-size block: a small spinner while (re)detection is running (only if
// it takes a moment — see card-state.js's SPINNER_DELAY_MS), then the site's
// own favicon + name when suggestions.js recognizes the site, the host name
// on an unrecognized-but-readable site, or neither on a site we have no
// permission for yet (unchanged "Activer Coati sur ce site" flow below it).
// Its buttons (encart-items.js's ordering) replace the old fixed "Résumer"
// button entirely: on YouTube, the first Coati suggestion IS the summarize
// action (coati:youtube:summarize) — there is no other way to trigger
// summarize() anymore. An unknown site with nothing saved shows only the
// head line and "Mes prompts ↗".

/** Arms the spinner-after-a-delay timer. Paired with endCardDetection() in a
 * try/finally around every (re)detection — see redetectTab() and
 * redetectTabFromMetadata() above. */
function beginCardDetection() {
  clearTimeout(cardDetectingTimer);
  cardDetectingTimer = setTimeout(showCardSpinner, SPINNER_DELAY_MS);
}

function endCardDetection() {
  clearTimeout(cardDetectingTimer);
  cardDetectingTimer = null;
}

function showCardSpinner() {
  els.siteCard.dataset.state = "detecting";
  els.siteCardSpinner.hidden = false;
  els.siteCardFavicon.hidden = true;
  els.siteCardLabel.textContent = "";
}

/** Recomputes and re-renders the card from the current detection state.
 * Called after every point that changes `currentPageUrl`/`pageKind`/
 * `currentFavIconUrl`/`prompts`/`prefsSites` — see resetPageState(),
 * applyDetectedContext(), redetectTabFromMetadata(), refreshFavIcon(),
 * handleBrokerMessage()'s "prompts"/"prefs" cases. */
function updateSiteCard() {
  const result = suggestionsFor({ url: currentPageUrl, pageKind });
  const state = cardState({ url: currentPageUrl, site: result.site ?? null });
  renderSiteCard(state, result);
}

function renderSiteCard(state, result) {
  els.siteCard.dataset.state = state;
  els.siteCardSpinner.hidden = true;

  // Favicon absent, or its icon failed to load (Brave bug, handled by the
  // "error" listener): the icon slot simply collapses — no placeholder
  // square (plan-mes-prompts-28-09.md, "Pas d'icône du site : rien").
  const showFavicon = !!currentFavIconUrl;
  els.siteCardFavicon.hidden = !showFavicon;
  if (showFavicon) {
    els.siteCardFavicon.src = currentFavIconUrl;
  } else {
    els.siteCardFavicon.removeAttribute("src");
  }

  if (state === "known") {
    els.siteCardLabel.textContent = result.site?.name ?? "";
  } else if (state === "unknown") {
    els.siteCardLabel.textContent = hostFromUrl(currentPageUrl) ?? "";
  } else {
    // Unreadable URL (site not activated): the head line is reserved anyway
    // (no layout jump, T27) — a neutral label beats an empty band.
    els.siteCardLabel.textContent = t("common_this_page");
  }

  renderEncart(result.siteKey, result.items ?? []);
}

/** Rebuilds the encart's buttons from encart-items.js's ordering: the site's
 * own case (Coati suggestions minus removed, plus the user's prompts for
 * that site), then "Tous les sites" — "Mes prompts ↗" is a separate, static
 * button in the markup, always last (plan-mes-prompts-28-09.md). Real DOM
 * nodes, textContent only (CLAUDE.md rule #3): a prompt's title/body is
 * user data, a suggestion's label ships with the extension — same
 * discipline either way. The first button keeps the primary/caramel style
 * whatever its kind, since the user controls the order (see report). */
function renderEncart(siteKey, coatiItems) {
  const buttons = encartItems({ siteKey, coatiItems, prompts, prefsSites });
  els.siteCardSuggestions.textContent = "";
  buttons.forEach((button, index) => {
    const el = document.createElement("button");
    el.type = "button";
    el.className = `toolbar-button site-card-suggestion${index === 0 ? " toolbar-button--primary" : ""}`;
    el.textContent = button.label;
    el.disabled = !!activeRequestId;
    el.addEventListener("click", () => runEncartButton(button));
    els.siteCardSuggestions.appendChild(el);
  });
}

/** A click on any encart button: the YouTube summarize item reuses the
 * existing summarize() path (extraction + transcript handling unchanged);
 * every other item — Coati suggestion or user prompt — goes through
 * runSuggestion(), which always reads the page (rule of the gesture). */
function runEncartButton(button) {
  if (button.action === "summarize") {
    summarize();
  } else {
    runSuggestion(button.prompt);
  }
}

// --- "Lire cette page" button (T50) and first-launch card (T51) -----------
//
// Pure state in read-button.js / first-run.js; this section only gathers the
// facts (permissions, storage.local preferences, connection and provider
// state) and renders.

// Coati's own icon, shown in the button's ring when the site's favicon is
// unknown or fails to load — an existing asset, never a drawing (P24).
const COATI_ICON_PATH = "../icons/icon32.png";
// permissions.onAdded arriving this soon after a full read of the same tab
// is ignored — see onPermissionsChanged in init().
const PERMISSION_REDETECT_SKIP_MS = 2000;

let allSitesGranted = false;
let siteGranted = false; // this page's own site permission (per-site activation, T42)
let sitePatterns = []; // permissionPatternsFor(knownOrigin), [] when unknown
let allSitesDeclined = false;
let readButtonUsed = false;
let readButtonReading = false;
let readButtonRequest = null; // "all-sites" | "site" | null — what the next click asks for
let firstRunDone = false;
let accessPrefsLoaded = false;
let modelAnswered = false;

async function loadAccessPrefs() {
  const keys = [ALL_SITES_DECLINED_KEY, READ_BUTTON_USED_KEY, FIRST_RUN_DONE_KEY];
  const stored = await api.storage.local.get(keys).catch(() => ({}));
  allSitesDeclined = stored[ALL_SITES_DECLINED_KEY] === true;
  readButtonUsed = stored[READ_BUTTON_USED_KEY] === true;
  firstRunDone = stored[FIRST_RUN_DONE_KEY] === true;
  accessPrefsLoaded = true;
}

async function refreshAllSitesGranted() {
  allSitesGranted = await api.permissions.contains({ origins: ALL_SITES_ORIGINS }).catch(() => false);
}

// Bumped on every call to refreshReadButton(); a slower, stale
// permissions.contains() answer (tab switched again meanwhile) checks its
// own token before touching the DOM, so it never clobbers a fresher result.
let readButtonToken = 0;

/** Recomputes the button from `knownOrigin` and the permissions held. Called
 * whenever `knownOrigin` changes and on permissions.onAdded/onRemoved —
 * never throws. */
async function refreshReadButton() {
  const token = ++readButtonToken;
  const patterns = knownOrigin ? permissionPatternsFor(siteKeyFor(knownOrigin)) : [];
  const granted =
    !allSitesGranted && patterns.length > 0
      ? await api.permissions.contains({ origins: patterns }).catch(() => false)
      : false;
  if (token !== readButtonToken) return; // superseded by a later call
  sitePatterns = patterns;
  siteGranted = granted;
  renderReadButton();
}

function renderReadButton() {
  const view = readButtonState({
    allSitesGranted,
    siteGranted,
    sitePatternsKnown: sitePatterns.length > 0,
    declined: allSitesDeclined,
    used: readButtonUsed,
    reading: readButtonReading,
    pageReadable: currentPageUrl != null && firstRunDone,
  });
  readButtonRequest = view.request;
  els.readPage.hidden = !view.state;
  if (view.state) {
    els.siteCard.dataset.readButton = view.state;
    els.readPage.dataset.state = view.state;
  } else {
    delete els.siteCard.dataset.readButton;
    delete els.readPage.dataset.state;
  }
  els.readPage.classList.toggle("encart-read--breathing", view.animate);
  // aria-disabled, not `disabled`: a disabled button drops keyboard focus
  // mid-read, and the click handler ignores clicks while reading anyway.
  els.readPage.setAttribute("aria-busy", String(view.state === "reading"));
  els.readPage.setAttribute("aria-disabled", String(view.state === "reading"));
  els.readPageLabel.textContent = view.label;
  if (view.request === "site" && knownOrigin) {
    const siteName = suggestionsFor({ url: knownOrigin }).site?.name ?? hostFromUrl(knownOrigin) ?? knownOrigin;
    els.readPage.title = knownOrigin;
    els.readPage.setAttribute("aria-label", `${view.label} (${siteName})`);
  } else {
    els.readPage.removeAttribute("title");
    els.readPage.removeAttribute("aria-label");
  }
  const icon = currentFavIconUrl || COATI_ICON_PATH;
  if (els.readPageIcon.getAttribute("src") !== icon) els.readPageIcon.src = icon;
  els.readPageNote.textContent = view.note;
  els.readPageNote.hidden = !view.note;
  renderFirstRun();
}

/** Click on the button: the permission request goes out FIRST, before any
 * `await` — Firefox only honours permissions.request inside the click's own
 * task, and Chrome needs the gesture too. Granted → this same click reads
 * the page (detection only: never a summary, rule 5). */
function onReadPageClick() {
  if (readButtonReading || !readButtonRequest) return;
  const request = readButtonRequest;
  const asked = api.permissions.request({ origins: request === "site" ? sitePatterns : ALL_SITES_ORIGINS });
  readButtonReading = true;
  renderReadButton();
  finishReadPageClick(request, asked);
}

async function finishReadPageClick(request, asked) {
  try {
    const granted = await Promise.resolve(asked).catch(() => false);
    if (!granted) {
      if (request === "all-sites" && !allSitesDeclined) {
        allSitesDeclined = true;
        await api.storage.local.set({ [ALL_SITES_DECLINED_KEY]: true }).catch(() => {});
      }
      return;
    }
    if (request === "all-sites") {
      allSitesGranted = true;
      if (allSitesDeclined) {
        allSitesDeclined = false;
        await api.storage.local.remove(ALL_SITES_DECLINED_KEY).catch(() => {});
      }
    } else {
      siteGranted = true;
    }
    const read = currentTabId != null ? await redetectTab(currentTabId) : false;
    if (read && !readButtonUsed) {
      readButtonUsed = true;
      await api.storage.local.set({ [READ_BUTTON_USED_KEY]: true }).catch(() => {});
    }
  } finally {
    readButtonReading = false;
    await refreshAllSitesGranted();
    await refreshReadButton();
  }
}

/** First-launch card: shown while a check is missing, hidden for good (a
 * storage.local preference) once all three are met. Rebuilt from scratch on
 * each call — it only changes on connection/provider/permission events. */
function renderFirstRun() {
  if (!accessPrefsLoaded || firstRunDone) {
    els.firstRun.hidden = true;
    return;
  }
  const checks = firstRunChecks({
    connState: currentConnState,
    providerState,
    modelAnswered,
    pageAccess: readButtonUsed || allSitesGranted || siteGranted,
  });
  if (checks.allMet) {
    firstRunDone = true;
    els.firstRun.hidden = true;
    api.storage.local.set({ [FIRST_RUN_DONE_KEY]: true }).catch(() => {});
    return;
  }
  els.firstRunTitle.textContent = FIRST_RUN_TEXT.title;
  els.firstRunSteps.replaceChildren(
    firstRunStep("program", checks.program, () => api.tabs.create({ url: RELEASES_URL })),
    firstRunStep("model", checks.model, () => api.runtime.openOptionsPage()),
    firstRunStep("page", checks.page, pointAtReadButton),
  );
  els.firstRun.hidden = false;
}

function firstRunStep(check, value, onAction) {
  const text = FIRST_RUN_TEXT[check];
  const status = markFor(value);
  const li = document.createElement("li");
  li.className = "first-run-step";
  li.dataset.check = check;
  li.dataset.status = status;

  const mark = document.createElement("span");
  mark.className = "first-run-mark";
  mark.setAttribute("aria-hidden", "true");
  mark.textContent = FIRST_RUN_TEXT.marks[status];

  const body = document.createElement("div");
  body.className = "first-run-body";
  const label = document.createElement("span");
  label.className = "first-run-label";
  const statusName = document.createElement("span");
  statusName.className = "visually-hidden";
  statusName.textContent = `${FIRST_RUN_TEXT.markNames[status]} : `;
  label.append(statusName, text[value] ?? text[status]);
  body.appendChild(label);

  if (status === "missing") {
    if (text.hint) {
      const hint = document.createElement("p");
      hint.className = "first-run-hint";
      hint.textContent = text.hint;
      body.appendChild(hint);
    }
    const action = document.createElement("button");
    action.type = "button";
    action.className = "toolbar-button first-run-action";
    action.textContent = text.action;
    action.addEventListener("click", onAction);
    body.appendChild(action);
  }
  li.append(mark, body);
  return li;
}

/** "Montrer le bouton": moves focus to the encart button — the user still
 * clicks it themselves (the first read is never launched for them). */
function pointAtReadButton() {
  if (els.readPage.hidden) return;
  els.readPage.scrollIntoView({ block: "nearest" });
  els.readPage.focus({ focusVisible: true });
  // Programmatic focus after a mouse click may not draw :focus-visible —
  // a short outline of its own makes sure the eye lands on it.
  els.readPage.classList.add("encart-read--pointed");
  setTimeout(() => els.readPage.classList.remove("encart-read--pointed"), 2000);
}

function resetPageState() {
  pageType = null;
  pageKind = null;
  currentPageUrl = null;
  currentFavIconUrl = null;
  updateAttachToggle();
  updateSiteCard();
}

function classifyForContext(context) {
  return classifyPageType({
    url: context.url,
    title: context.title,
    textLength: (context.text || "").length,
    hasTranscript: context.kind === "youtube" && !context.needsTranscript && !!context.text,
    hasVideoElement: !!context.hasVideoElement,
    hasArticleMarkup: !!context.hasArticleMarkup,
  });
}

function applyDetectedContext(context) {
  try {
    knownOrigin = new URL(context.url).origin;
  } catch {
    knownOrigin = null;
  }
  currentPageUrl = context.url || null;
  pageType = classifyForContext(context);
  // docs/PROTOCOL.md "Compatibilité": an absent field, or a value outside
  // the four expected ones, means "behave exactly as before" — falling back
  // to the legacy pageType label in mainButtonLabel() achieves that without
  // needing to special-case it here.
  pageKind =
    context.kind === "page" && typeof context.pageKind === "string" ? context.pageKind : null;
  updateAttachToggle();
  refreshReadButton();
  updateSiteCard();
  // extract.js reads page content, never tab metadata — the favicon comes
  // from a separate, metadata-only chrome.tabs.get(), same visibility rule
  // as everywhere else in this file (T28: the site's own icon, no logo of
  // ours). Best-effort: a failure here just means no favicon, never a
  // blocked card. Re-render once it resolves.
  refreshFavIcon(currentTabId).then(() => {
    updateSiteCard();
    renderReadButton();
  });
}

/** Re-runs detection for `tabId`. Never throws — degrades to the generic
 * state (and, when possible, the "activer sur ce site" affordance) instead. */
/** How long after the browser starts a loading panel is assumed to be a
 * restored one rather than a freshly clicked one. Chrome restores side panels
 * within a second or two of startup; ten seconds covers a cold machine without
 * swallowing a deliberate click, which realistically comes later than that. */
const RESTORE_WINDOW_MS = 10_000;

/** False when this panel is most likely one the browser restored at startup.
 * Fails closed: any error reading the stamp means we do NOT read the page. */
async function openedFromGesture() {
  try {
    const { browserStartedAt } = await api.storage.session.get("browserStartedAt");
    if (typeof browserStartedAt !== "number") return true;
    return Date.now() - browserStartedAt > RESTORE_WINDOW_MS;
  } catch {
    return false;
  }
}

async function redetectTab(tabId) {
  // Recorded on every read, but only the "coati:action-clicked" handler skips
  // on it: a read requested by the encart's read button right after a grant
  // must never be swallowed by the dedupe window. Resolves true when the page
  // was actually read, false otherwise (never throws).
  lastRedetectTabId = tabId;
  lastRedetectAt = Date.now();
  beginCardDetection();
  try {
    const context = await extractFromTab(tabId);
    applyDetectedContext(context);
    return true;
  } catch {
    resetPageState();
    // T47: the injection-refused error no longer carries the page address
    // (neither browser embeds it — verified 2026-09-29), so the origin is
    // read from tabs.get() instead. Legitimate here specifically: this
    // function only runs inside a genuine gesture (icon click, context menu,
    // shortcut, the encart's read button), whose activeTab grant already gives tab metadata
    // regardless of any scripting/host permission. If we already hold this
    // site's permission, extraction failed for some other reason (a
    // chrome:// page, a PDF viewer…) — refreshReadButton() checks
    // that itself and stays hidden in that case. The favicon rides along so
    // the button's ring shows the site's own icon.
    try {
      const tab = await api.tabs.get(tabId);
      knownOrigin = tab?.url ? new URL(tab.url).origin : null;
      currentFavIconUrl = tab?.url ? iconFor(tab) : null;
    } catch {
      knownOrigin = null;
    }
    await refreshReadButton();
    return false;
  } finally {
    endCardDetection();
  }
}

/** Tab-switch handler — never reads the page (see the comment block at the
 * top of this file). Classifies from `tab.url`/`tab.title` only, which
 * `chrome.tabs.get` returns without injecting anything as long as we hold a
 * host permission for that tab's origin. Leaves the type "unknown" (and the
 * main button generic) whenever the URL shape alone can't tell — that is the
 * honest answer, not a bug. */
async function redetectTabFromMetadata(tabId) {
  beginCardDetection();
  try {
    let tab;
    try {
      tab = await api.tabs.get(tabId);
    } catch {
      tab = null;
    }

    resetPageState();
    knownOrigin = null;
    if (!tab || !tab.url) {
      refreshReadButton();
      return; // no permission for this origin: nothing legible
    }

    try {
      knownOrigin = new URL(tab.url).origin;
    } catch {
      knownOrigin = null;
    }
    currentPageUrl = tab.url;
    currentFavIconUrl = iconFor(tab);
    pageType = classifyPageTypeFromMetadata({ url: tab.url, title: tab.title });
    updateAttachToggle();
    refreshReadButton();
    updateSiteCard();
  } finally {
    endCardDetection();
  }
}

function iconFor(tab) {
  return faviconSrc({
    pageUrl: tab?.url,
    favIconUrl: tab?.favIconUrl,
    isGecko: IS_GECKO,
    getURL: (path) => api.runtime.getURL(path),
  });
}

/** Metadata-only favicon lookup (T28), same visibility rule as tab.url
 * everywhere else in this file — used after a real extraction, which reads
 * page content and knows nothing about tab chrome. */
async function refreshFavIcon(tabId) {
  if (tabId == null) {
    currentFavIconUrl = null;
    return;
  }
  try {
    const tab = await api.tabs.get(tabId);
    currentFavIconUrl = iconFor(tab);
  } catch {
    currentFavIconUrl = null;
  }
}

// --- Summarize ------------------------------------------------------------

async function summarize() {
  if (activeRequestId) return;
  activeRequestId = "pending"; // in-flight guard until the real id is known below; also drives the disabled buttons
  setStreamingUi(true);

  if (currentTabId == null) {
    addMessage({ id: newId(), role: "system", text: t("panel_no_active_tab") });
    setStreamingUi(false);
    return;
  }

  let context;
  try {
    context = await extractReadableFromTab(currentTabId);
  } catch (err) {
    reportExtractionError(err, {
      accessDenied: t("panel_access_denied_generic", [ACCESS_DENIED_HINT]),
      other: (e) => t("panel_read_error_generic", [e.message]),
    });
    setStreamingUi(false);
    return;
  }

  context = await openTranscriptIfNeeded(context);
  if (context.needsTranscript) {
    reportMissingTranscript();
    setStreamingUi(false);
    return;
  }

  if (!context.text || context.text.trim().length < 40) {
    addMessage({
      id: newId(),
      role: "system",
      text: t("panel_nothing_readable"),
    });
    setStreamingUi(false);
    return;
  }

  applyDetectedContext(context);

  const id = newId();
  const label = mainButtonLabel();
  // Never the URL here: it is persisted to chrome.storage.local unencrypted
  // (CLAUDE.md rule #1) and a URL can carry a session token. Title only, with
  // a neutral fallback rather than reaching for context.url.
  const description = (context.title || "").trim() || t("common_this_page_lowercase");
  addMessage({ id: `${id}-u`, role: "user", text: `${label} : ${description}`, relaunch: { type: "summarize" } });
  // videoId only — never context.url (rule #1: chrome.storage.local is
  // unencrypted, and a URL can carry a session token; a bare video id can't).
  // It's what lets a rendered timestamp be tied back to "the video this
  // summary was made from" without ever persisting that video's URL.
  const videoId = context.kind === "youtube" ? context.videoId : undefined;
  addMessage({ id, role: "assistant", text: "", streaming: true, videoId });

  activeRequestId = id;
  setStreamingUi(true);
  persistConversation();

  pendingRetries.set(id, { type: "summarize", context });
  await sendClientMessage({ type: "summarize", id, context });
}

async function activeTabId() {
  const [tab] = await api.tabs.query({ active: true, currentWindow: true });
  if (!tab || !tab.id) throw new Error(t("common_no_active_tab_internal"));
  return tab.id;
}

/** Classifies a page-read failure (an unreadable page / a browser permission
 * refusal / anything else) and reports it as a system message, with the
 * phrasing appropriate to the caller (sendChat vs. summarize word things
 * slightly differently). Callers still do their own cleanup (setStreamingUi,
 * return) after calling this — that part isn't shared because it differs
 * between callers. */
function reportExtractionError(err, { accessDenied, other }) {
  if (err instanceof UnreadablePageError) {
    addMessage({ id: newId(), role: "system", text: err.message });
  } else if (looksLikeAccessDenied(err)) {
    addMessage({ id: newId(), role: "system", text: accessDenied });
  } else {
    addMessage({ id: newId(), role: "system", text: other(err) });
  }
}

// T47 (docs/DECISIONS.md): verified 2026-09-29 against both browsers —
// Chrome/Brave: "Cannot access contents of the page. Extension manifest must
// request permission to access the respective host." Firefox: "Missing host
// permission for the tab" / "…for the tab or frames" (Firefox source).
// Neither embeds the page address, so this only classifies, it never mines
// an origin (that used to be extractOriginFromError/NoAccessError, removed).
/** True when the failure looks like the browser refusing access for lack of
 * a host permission. */
function looksLikeAccessDenied(err) {
  const message = err && typeof err.message === "string" ? err.message : "";
  return /cannot access|permission|extension manifest/i.test(message);
}

async function extractFromTab(tabId) {
  const results = await withDeadline(
    api.scripting.executeScript({
      target: { tabId },
      // Leading slash, and it matters: Chrome resolves an injected file path
      // against the extension root, Firefox against the calling document — the
      // panel lives in panel/, so "content/extract.js" became
      // moz-extension://…/panel/content/extract.js and failed to load.
      // Measured in Firefox on 2026-09-20. Root-relative works on both.
      files: ["/content/extract.js"],
    }),
    EXTRACTION_DEADLINE_MS,
    () => new ExtractionTimeoutError(),
  );

  const result = results?.[0]?.result;
  if (!result || typeof result !== "object") throw new Error(t("common_extraction_empty"));
  return result;
}

// --- Unreadable pages (T46 point 3) ----------------------------------------
//
// Wraps extractFromTab() for every caller that is about to SEND the page to
// the broker (extractIfAttaching, runSuggestion, summarize — never
// openYouTubeTranscript's own internal re-read, which just reuses whatever
// context already passed this check). Two cases short-circuit BEFORE a
// question is sent: a PDF (the browser's own viewer refuses script
// injection, so this must be caught from the tab URL, before attempting
// extraction at all) and extract.js's own `readability: "canvas" | "empty"`
// verdict (caught after a successful extraction). `context.readability`
// itself must never reach the broker (docs/PROTOCOL.md's Context has no such
// field) — stripReadability() below strips it from every context this
// function returns.
async function extractReadableFromTab(tabId) {
  let tab = null;
  try {
    tab = await api.tabs.get(tabId);
  } catch {
    tab = null;
  }
  if (isPdfUrl(tab?.url)) throw new UnreadablePageError(PDF_MESSAGE);

  const context = await extractFromTab(tabId);
  // YouTube has its own path: without a transcript the page is "empty" on
  // purpose (the caller opens the transcript on the user's click and reads
  // again), and a short video has a short transcript that is still the whole
  // content. The unreadable-page check is for ordinary pages only — refusing
  // here blocked « Résumer cette vidéo » (reported by Romain, 29/09).
  const message =
    context.kind === "youtube" || context.needsTranscript ? null : readabilityMessage(context.readability);
  if (message) throw new UnreadablePageError(message);
  return stripReadability(context);
}

// Exception nommée à la règle du geste (DECISIONS.md, élargie le 26/09). Un seul
// clic, sur le bouton que YouTube affiche déjà, uniquement en réponse au clic de
// l'utilisateur sur « Résumer cette vidéo » ou sur une autre suggestion vidéo
// de l'encart, sur l'onglet qu'il regarde. Jamais au chargement, jamais en
// boucle, jamais sur une autre vidéo. Ce n'est pas un parcours automatisé :
// c'est le geste de l'utilisateur, outillé.
async function openYouTubeTranscript(tabId) {
  const results = await api.scripting.executeScript({
    target: { tabId },
    func: async () => {
      const button = [...document.querySelectorAll("button")].find((el) =>
        /afficher la transcription|show transcript/i.test(
          el.getAttribute("aria-label") || el.innerText || "",
        ),
      );
      if (!button) return false;

      button.click();

      // Le panneau se remplit en différé ; mesuré entre 1 et 10 s.
      const deadline = Date.now() + 15000;
      while (Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 500));
        if (
          document.querySelector(
            "transcript-segment-view-model, ytd-transcript-segment-renderer",
          )
        ) {
          return true;
        }
      }
      return false;
    },
  });
  return results?.[0]?.result === true;
}

// --- Selection actions (context menu) -------------------------------------

/** Reads and clears the stash left by the context-menu click, then runs it.
 * See the comment above chrome.contextMenus.onClicked in service-worker.js:
 * called both on panel load and on the "coati:pending-action" broadcast,
 * whichever comes first — reading it here removes it, so the other caller
 * finds nothing and no-ops. */
async function drainPendingAction() {
  const data = await api.storage.session.get(PENDING_ACTION_KEY);
  const pending = data[PENDING_ACTION_KEY];
  if (!pending) return;
  await api.storage.session.remove(PENDING_ACTION_KEY);
  runAct(pending);
}

async function runAct(pending) {
  const { action, label, params, selectionText } = pending;
  if (!selectionText) return;
  if (activeRequestId) {
    addMessage({ id: newId(), role: "system", text: t("panel_request_in_progress") });
    return;
  }

  const id = newId();
  addMessage({ id: `${id}-u`, role: "user", text: `${label} : « ${truncateForDisplay(selectionText)} »` });
  addMessage({ id, role: "assistant", text: "", streaming: true });

  activeRequestId = id;
  setStreamingUi(true);
  persistConversation();

  pendingRetries.set(id, { type: "act", action, text: selectionText, params });
  await sendClientMessage({ type: "act", id, action, text: selectionText, params });
}

function truncateForDisplay(text, max = 220) {
  const trimmed = text.trim();
  return trimmed.length > max ? `${trimmed.slice(0, max)}…` : trimmed;
}

// --- Prompt library (plan-mes-prompts-28-09.md, lot 3) --------------------
//
// The library itself (list/order/removed suggestions/editing) is managed on
// the "Mes prompts" page (a later phase); the panel only ever reads it (to
// build the encart) and writes exactly one thing: the disquette below, which
// saves the current composer text with no title, into the current site's
// case (or "Tous les sites" on an unreadable address).

function requestPrompts() {
  api.runtime.sendMessage({
    type: "coati:client-message",
    payload: { type: "prompts.list", id: newId() },
  });
}

function requestPrefs() {
  api.runtime.sendMessage({
    type: "coati:client-message",
    payload: { type: "prefs.get", id: newId() },
  });
}

function openMyPromptsPage() {
  api.tabs.create({ url: api.runtime.getURL("prompts/prompts.html") });
}

function updateSavePromptEnabled() {
  els.savePrompt.disabled = els.input.value.trim().length === 0;
}

function saveCurrentAsPrompt() {
  const body = els.input.value.trim();
  if (!body) return;
  // T44: an unreadable address no longer files silently into "Tous les
  // sites" (docs/DECISIONS.md, amendement T33) — it goes to the unnamed,
  // unsorted part of the head case instead.
  const siteKey = siteKeyFor(currentPageUrl) ?? "@unsorted";
  api.runtime.sendMessage({
    type: "coati:client-message",
    payload: { type: "prompts.save", id: newId(), prompt: { site: siteKey, body } },
  });
  requestPrompts();
  showPromptSavedNotice(siteKey);
}

/** Calm, temporary confirmation (no title asked, no dialog) — cleared after
 * ~2s, same pattern as the recovery block's "Copié !". */
function showPromptSavedNotice(siteKey) {
  clearTimeout(promptSavedNoticeTimer);
  if (siteKey === "@unsorted") {
    els.promptSavedNotice.textContent = t("panel_prompt_saved_no_site");
  } else {
    const label = siteKey === "*" ? t("common_all_sites") : suggestionsFor({ url: currentPageUrl }).site?.name ?? hostFromUrl(currentPageUrl) ?? siteKey;
    els.promptSavedNotice.textContent = t("panel_prompt_saved_for", [label]);
  }
  promptSavedNoticeTimer = setTimeout(() => {
    els.promptSavedNotice.textContent = "";
  }, 2000);
}

// --- Relancer (plan-mes-prompts-28-09.md, lot 3) --------------------------
//
// Each user message carries enough metadata (`msg.relaunch`) to resend it:
// a chat message replays through the exact same path as a fresh sendChat()
// (reading the page per the switch's CURRENT state, never a stale copy of
// what it read the first time), a summarize-triggered one re-runs
// summarize(). A message stored before this feature shipped (or restored
// from an older session) has no `relaunch` — inferRelaunch() below treats it
// as chat text, stripping the "attached page" marker sendChatMessage() adds.

const PAGE_CONTENT_MARKER_SUFFIX = `\n\n${t("panel_with_page_content_marker")}`;

function inferRelaunch(text) {
  const stripped = text.endsWith(PAGE_CONTENT_MARKER_SUFFIX)
    ? text.slice(0, -PAGE_CONTENT_MARKER_SUFFIX.length)
    : text;
  return { type: "chat", text: stripped };
}

async function relaunchMessage(msg) {
  if (activeRequestId) return;
  const relaunch = msg.relaunch ?? inferRelaunch(msg.text);

  if (relaunch.type === "summarize") {
    await summarize();
    return;
  }

  let context;
  try {
    context = await extractIfAttaching();
  } catch (err) {
    reportExtractionError(err, {
      accessDenied: t("panel_access_denied_relaunch", [ACCESS_DENIED_HINT]),
      other: (e) => t("panel_read_error_relaunch", [e.message]),
    });
    return;
  }
  await sendChatMessage(relaunch.text, context);
}

/** Real DOM node, no innerHTML (CLAUDE.md rule #3). Sits below the bubble
 * (see the `.message-user-bubble` wrapper in renderMessage()), visible on
 * hover/keyboard focus, always in the tab order (card.css). */
function buildRelaunchButton(msg) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "message-relaunch";
  button.textContent = t("panel_relaunch");
  button.title = t("panel_relaunch_title");
  button.disabled = !!activeRequestId;
  button.addEventListener("click", () => relaunchMessage(msg));
  return button;
}

// --- Rendering ----------------------------------------------------------

function addMessage(msg) {
  conversation.push(msg.ts == null ? { ...msg, ts: Date.now() } : msg);
  if (conversation.length > MAX_PERSISTED_MESSAGES) {
    conversation = conversation.slice(-MAX_PERSISTED_MESSAGES);
  }
  renderAll();
}

function renderAll() {
  els.messages.replaceChildren();
  for (const msg of conversation) renderMessage(msg, { append: true });
  els.messages.scrollTop = els.messages.scrollHeight;
}

function wasNearBottom() {
  const el = els.messages;
  return isNearBottom(el.scrollHeight, el.scrollTop, el.clientHeight);
}

function renderMessage(msg, { append = false } = {}) {
  let node = document.getElementById(`msg-${msg.id}`);
  // Capture BEFORE mutating the DOM: appending/growing the node can itself
  // change scrollHeight, which would make the "near bottom" check below
  // always true if read after the fact.
  const shouldFollow = wasNearBottom();
  if (!node) {
    if (!append) return;
    node = document.createElement("div");
    node.id = `msg-${msg.id}`;
    els.messages.appendChild(node);
  }
  node.className = `message message--${msg.role}${msg.streaming ? " message--streaming" : ""}`;

  if (msg.role === "user") {
    // The bubble's own background/padding live on an inner node so
    // "Relancer" (card.css) can sit below it, not inside it (plan-mes-
    // prompts-28-09.md, "sous la bulle") — .message--user only aligns the
    // pair. User messages are never re-streamed, so building this once is
    // safe (no later renderMessage() call ever mutates one).
    node.replaceChildren();
    const bubble = document.createElement("div");
    bubble.className = "message-user-bubble";
    bubble.appendChild(renderMarkdown(document, msg.text));
    node.appendChild(bubble);
    node.appendChild(buildRelaunchButton(msg));
  } else {
    node.replaceChildren(renderMarkdown(document, msg.text));
    // Only a YouTube-context assistant message carries a videoId (set in
    // summarize()) — an ordinary article summary that happens to contain
    // "[1:23]" has none, so its timestamps stay plain text (deliverable 4).
    if (msg.role === "assistant" && msg.videoId) linkifyTimestamps(node, msg.videoId);
    if (msg.authRequired) node.appendChild(buildAuthRecoveryBlock(msg));
  }
  // Only follow the stream to the bottom if the user was already there
  // (or close enough) — a user scrolled up to read must not be yanked back
  // down by every incoming chunk (bug report, symptom 2).
  if (shouldFollow) els.messages.scrollTop = els.messages.scrollHeight;
}

/**
 * Walks a rendered message's text nodes and turns `[mm:ss]`/`[h:mm:ss]`
 * timestamps into clickable <button>s. Built as real DOM nodes
 * (createElement/textContent), never via string-concatenated HTML — the
 * text driving this is model output, and CLAUDE.md rule #3 says page/model
 * content is data, never markup, full stop.
 */
function linkifyTimestamps(container, videoId) {
  const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT);
  const textNodes = [];
  let n;
  while ((n = walker.nextNode())) textNodes.push(n);

  for (const textNode of textNodes) {
    const tokens = parseTimestamps(textNode.data);
    if (tokens.length === 1 && tokens[0].type === "text") continue; // nothing to link

    const fragment = document.createDocumentFragment();
    for (const token of tokens) {
      if (token.type === "text") {
        fragment.appendChild(document.createTextNode(token.value));
        continue;
      }
      const button = document.createElement("button");
      button.type = "button";
      button.className = "timestamp-link";
      button.textContent = token.raw;
      button.title = t("panel_seek_timestamp_title");
      button.addEventListener("click", () => seekActiveVideoTab(videoId, token.seconds));
      fragment.appendChild(button);
    }
    textNode.parentNode.replaceChild(fragment, textNode);
  }
}

// Seeks the <video> element of the CURRENT active tab — but only when a real
// click just happened (this is only ever called from a "click" listener
// above) AND that tab is showing the same video the summary was made from.
// CLAUDE.md rule #5 ("la règle du geste"): this tools a gesture the user just
// made, it never fires on its own, never on a timer, never on another tab.
async function seekActiveVideoTab(videoId, seconds) {
  try {
    const [tab] = await api.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id || getYouTubeVideoIdFromUrl(tab.url) !== videoId) return;
    await api.scripting.executeScript({
      target: { tabId: tab.id },
      func: (t) => {
        const video = document.querySelector("video");
        if (video) video.currentTime = t;
      },
      args: [seconds],
    });
  } catch {
    // Tab closed, no more permission, no <video> on the page yet — a seek is
    // best-effort, never worth surfacing an error for.
  }
}

// --- Persistence ----------------------------------------------------------

async function loadConversation() {
  const data = await api.storage.local.get([STORAGE_KEY, ATTACH_PAGE_KEY, RETENTION_DAYS_KEY]);
  attachPagePreference = typeof data[ATTACH_PAGE_KEY] === "boolean" ? data[ATTACH_PAGE_KEY] : null;
  const retentionDays = parseStoredRetentionDays(data[RETENTION_DAYS_KEY]);
  const raw = Array.isArray(data[STORAGE_KEY]) ? data[STORAGE_KEY] : [];
  const filtered = applyRetention(raw, retentionDays);
  if (filtered.length !== raw.length || filtered.some((msg, i) => msg.ts !== raw[i]?.ts)) {
    // Persist the migration (stamped timestamps) and the expiry (dropped
    // messages) right away, so a crash before the next save doesn't re-show
    // messages that should have expired.
    api.storage.local.set({ [STORAGE_KEY]: filtered });
  }
  return filtered;
}

function persistConversation() {
  api.storage.local.set({ [STORAGE_KEY]: conversation, [ATTACH_PAGE_KEY]: attachPagePreference });
}

function newId() {
  return crypto.randomUUID();
}
