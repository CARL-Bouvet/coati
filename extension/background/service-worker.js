// Coati background service worker.
//
// Owns the single WebSocket connection to the broker (ws://127.0.0.1:8787/ws,
// see docs/PROTOCOL.md). This file must never hold conversation state as its
// only copy: the service worker can be killed by the browser at any moment
// (idle timeout, MV3 lifecycle), so it only relays messages. The panel is
// responsible for persisting the conversation (chrome.storage.local).
//
// Runs as a background page in both Chrome (manifest.json,
// "background.service_worker") and Firefox (manifest.firefox.json,
// "background.scripts" + "type":"module") — same file either way, see
// scripts/build.sh. All chrome.* calls below go through `api` (see
// lib/browser-compat.js) so this file works unmodified on both.

import { api } from "../lib/browser-compat.js";
import { requestBrokerKeyFromHost } from "../lib/native-host.js";
import {
  isHex64,
  randomHex32,
  hmacHex,
  verifyHmacHex,
  brokerProofMessage,
  extensionProofMessage,
} from "../lib/handshake-crypto.js";

// Amendement 2026-09-25 (docs/PROTOCOL.md "Transport") — port fixed at 8787
// for the extension: neither WS_URL below nor the manifests' connect-src CSP
// can take a variable, so this port is hardcoded here and in both manifests,
// kept equal by convention. A broker on another port is unreachable, manual
// paste included; the broker no longer reads a "port" config key either.
const BROKER_PORT = 8787;
const WS_URL = `ws://127.0.0.1:${BROKER_PORT}/ws`;
const PROTOCOL_VERSION = 2;
const RECONNECT_ALARM = "coati-reconnect";
const MAX_BACKOFF_MS = 30000;
// Must stay below the broker's own handshake timeout (3s, docs/PROTOCOL.md
// "Poignée de main v: 2") so the client — not the server closing the socket
// first — is the one to report "handshake timeout" as a distinct state.
const HELLO_TIMEOUT_MS = 2500;

// docs/PROTOCOL.md amendement 2026-09-30, "Côté extension": chrome.storage.session
// keys for the handshake v2 key material. Never chrome.storage.local — see
// CLAUDE.md rule #1 and the invariants comment below.
const BROKER_KEY_STORAGE_KEY = "brokerKey";
const PASTED_KEY_STORAGE_KEY = "pastedKey";

// --- Invariants (docs/PROTOCOL.md "Règles invariantes, ajouts") ------------
// - Never `api.storage.session.setAccessLevel(...)` anywhere in this file:
//   the default access level (extension pages/scripts only) is what keeps
//   brokerKey/pastedKey out of reach of content scripts and web pages.
// - No `externally_connectable` in the manifests, no
//   `runtime.onMessageExternal` / `onConnectExternal` listener here or
//   anywhere else: only this extension's own pages can reach this worker at
//   all (checked again per-message by isTrustedInternalSender below).
// - onMessage handlers below never send back brokerKey/pastedKey in any
//   sendResponse — only opaque status/ids.
// ---------------------------------------------------------------------------
// How long a single request is held in memory while the socket is down
// before it is dropped with an explicit error (deliverable B2). Bounded on
// purpose: silently queueing forever would just move the hang from "no
// connection" to "connection came back an hour later with a stale request".
const PENDING_REQUEST_TIMEOUT_MS = 15000;

// Identifies THIS instantiation of the service worker script. MV3 can kill
// and re-run this whole file at any time, which resets every module-level
// `let` below — including this one, to a fresh random value. The panel
// captures the id in place at request-send time and compares it against
// later reads (see panel.js's request-watch) to tell "the broker is just
// slow" apart from "the service worker died mid-request, nothing is coming"
// (deliverable B4).
const WORKER_INSTANCE_ID = crypto.randomUUID();

// Key for the "act on selection" stash — see the context menu block below.
// chrome.storage.SESSION only: the stashed text is the user's private
// selection, so it must never touch chrome.storage.local (unencrypted disk,
// CLAUDE.md rule #1).
const PENDING_ACTION_KEY = "coati:pendingAction";

// Coati's four selection actions (docs/PROTOCOL.md, message "act"). Menu
// item id -> the broker action it maps to, the French label shown both in
// the context menu and later as the panel's own user-bubble label, and any
// fixed params the action needs (translate defaults to French, matching the
// rest of the UI).
const CONTEXT_MENU_ACTIONS = {
  "coati-rewrite": { action: "rewrite", label: "Reformuler" },
  "coati-shorten": { action: "shorten", label: "Raccourcir" },
  "coati-explain": { action: "explain", label: "Expliquer" },
  "coati-translate": { action: "translate", label: "Traduire", params: { targetLang: "fr" } },
};

let ws = null;
// disconnected | connecting | handshaking | connected | no-host |
// broker-untrusted | no-token | handshake-timeout — see docs/PROTOCOL.md
// amendement 2026-09-30, "États et bandeaux".
let wsState = "disconnected";
let backoffMs = 1000;
let handshakeTimeoutId = null;
// At most one request held while reconnecting (deliverable B2) —
// { payload, timeoutId }, or null when nothing is queued.
let pendingRequest = null;
// docs/PROTOCOL.md "Poignée de main v: 2": at most one automatic retry per
// connection cycle after the broker's proof fails to verify (close 4000) or
// after a 4401. A cycle runs from a disconnection to the next `hello-ok`,
// which resets this flag — never a silent infinite loop against a broker
// that keeps failing. Only meaningful when the key just used came from the
// native host (there is nothing to re-call for a pasted legacy key).
let retriedThisCycle = false;

// Welcome page (docs/DECISIONS.md T51): a fresh install only — an update or
// a browser update must never reopen it.
const WELCOME_PAGE_PATH = "welcome/welcome.html";

api.runtime.onInstalled.addListener((details) => {
  if (details?.reason === "install") {
    Promise.resolve(api.tabs.create({ url: api.runtime.getURL(WELCOME_PAGE_PATH) })).catch(() => {});
  }
  // Chrome/Brave only — openPanelOnActionClick left false on purpose. When
  // true, chrome does NOT dispatch action.onClicked while the panel is
  // already open, so a click meant to re-read the current tab (this
  // deliverable) goes unnoticed. false makes chrome.sidePanel behave like
  // Firefox's sidebarAction: every click reaches the onClicked listener
  // below, which opens the panel itself. Firefox has no sidePanel API at
  // all; its equivalent (sidebar_action) opens declaratively from the
  // manifest too, but the explicit click case is still handled by the
  // action.onClicked listener below, which is why it stays shared.
  if (api.sidePanel) api.sidePanel.setPanelBehavior({ openPanelOnActionClick: false }).catch(() => {});
  api.alarms.create(RECONNECT_ALARM, { periodInMinutes: 0.5 });
  connectIfNeeded();
  setupContextMenus();
});

// T46 (docs/DECISIONS.md) — one more gesture that gives access to the page,
// same class as the toolbar icon: a right-click on the page itself (not on a
// selection). "READ_PAGE_MENU_ID"'s onClicked handler below follows the exact
// same path as action.onClicked (openPanel(tab) first, then
// "coati:action-clicked"), not the selection-stash path used by the entries
// under the "coati" parent, which is unrelated and stays as-is.
const READ_PAGE_MENU_ID = "coati-read-page";

function setupContextMenus() {
  api.contextMenus.removeAll(() => {
    api.contextMenus.create({
      id: READ_PAGE_MENU_ID,
      title: "Lire cette page avec Coati",
      contexts: ["page"],
    });
    api.contextMenus.create({ id: "coati", title: "Coati", contexts: ["selection"] });
    for (const [id, entry] of Object.entries(CONTEXT_MENU_ACTIONS)) {
      api.contextMenus.create({ id, parentId: "coati", title: entry.label, contexts: ["selection"] });
    }
  });
}

// Opens Coati's panel in response to a genuine user gesture (a toolbar
// action click, or — below — a context-menu selection). Feature-detected,
// never user-agent sniffed: Firefox exposes sidebarAction (no sidePanel at
// all), Chrome/Brave expose sidePanel (no sidebarAction). On Firefox,
// sidebarAction.open() must run synchronously within the gesture's own event
// handler — called as the very first statement below, before any `await`, so
// it does even inside an async listener — or Firefox silently refuses it.
function openPanel(tab) {
  if (api.sidebarAction && typeof api.sidebarAction.open === "function") {
    return api.sidebarAction.open();
  }
  if (api.sidePanel && typeof api.sidePanel.open === "function" && tab?.windowId != null) {
    return api.sidePanel.open({ windowId: tab.windowId }).catch(() => {});
  }
  return undefined;
}

// Every icon click reaches this listener now — on Chrome/Brave because
// setPanelBehavior's openPanelOnActionClick is false (see onInstalled
// above), on Firefox because sidebar_action never opens itself. openPanel(tab)
// runs as the very first statement, synchronously within the click's own
// event handler: Firefox's sidebarAction.open() is refused otherwise (see the
// comment on openPanel), and chrome.sidePanel.open() has the same
// user-gesture requirement. The follow-up message tells a panel that was
// ALREADY open (this deliverable: re-read the current tab on a second click)
// to redetect; a panel that just opened from this same click ignores it or
// dedupes it — see panel.js's onRuntimeMessage / redetectTab. No listener may
// be there yet (the panel takes a moment to open) — that rejection is
// expected and swallowed.
if (api.action && api.action.onClicked) {
  api.action.onClicked.addListener((tab) => {
    openPanel(tab);
    api.runtime.sendMessage({ type: "coati:action-clicked", tabId: tab.id }).catch(() => {});
  });
}

// A right-click on a text selection, followed by picking one of our menu
// items, IS a real user gesture — the same kind a toolbar-icon click is —
// which is why openPanel() is allowed to run here (chrome.sidePanel.open()
// throws, and Firefox's sidebarAction.open() is refused, outside of a
// genuine gesture). The panel, however, may not exist yet (this is often the
// very first interaction). So the selection text is stashed in
// chrome.storage.session — a request "in flight" until a panel picks it up —
// and a broadcast is sent in case a panel is already open and listening.
// panel.js drains the stash both on its own load and on that broadcast,
// whichever comes first, and deletes it the moment it's read: two panels
// racing to read it is impossible in single-threaded JS, but a panel that
// died mid-read (drainPendingAction did not run yet) leaves a "read but
// still present" stash undamaged for the next attempt, so nothing is lost
// and a delivered action never fires twice.
// T46 — same path as the toolbar icon's action.onClicked listener above:
// openPanel(tab) as the very first statement (synchronous, within this
// gesture's own event handler — see openPanel()'s comment), then
// "coati:action-clicked" with tab.id. Checked before the selection-action
// entry below, which is a different menu item entirely (contexts:
// ["selection"], under the "coati" parent).
api.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId === READ_PAGE_MENU_ID) {
    if (!tab) return;
    openPanel(tab);
    api.runtime.sendMessage({ type: "coati:action-clicked", tabId: tab.id }).catch(() => {});
  }
});

api.contextMenus.onClicked.addListener(async (info, tab) => {
  const entry = CONTEXT_MENU_ACTIONS[info.menuItemId];
  if (!entry || !info.selectionText || !tab?.windowId) return;

  // Called synchronously, before any await — see openPanel()'s comment.
  openPanel(tab);

  await api.storage.session.set({
    [PENDING_ACTION_KEY]: {
      action: entry.action,
      label: entry.label,
      params: entry.params,
      selectionText: info.selectionText,
      url: tab.url,
      title: tab.title,
    },
  });
  broadcast({ type: "coati:pending-action" });
});

// Stamped so the panel can tell "the user just clicked my icon" apart from
// "the browser restored a panel that was left open". Chrome restores an open
// side panel at startup, and the panel reads the active tab when it loads —
// which would be a page read with no gesture behind it, the one thing rule 5
// forbids. The panel checks this stamp and falls back to metadata-only
// classification inside the window (see panel.js, openedFromGesture).
// storage.session, never local: it must not survive the browser.
api.runtime.onStartup.addListener(() => {
  api.storage.session.set({ browserStartedAt: Date.now() }).catch(() => {});
  connectIfNeeded();
});

api.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === RECONNECT_ALARM) connectIfNeeded();
});

// Any message from a panel/options page wakes this worker up; take that
// opportunity to make sure the socket is alive.
// I2 (lot7 security review): any extension page can post a message this
// worker's onMessage listener will receive — without checking who sent it,
// another (malicious) extension able to reach this one (e.g. via
// externally_connectable, or a content script sharing an isolated world)
// could forge "coati:client-message" (talk to the broker as this user) or
// "coati:set-pasted-key" (overwrite the legacy pasted key). Deliberately NOT
// `!sender.tab` — the options page can be opened in a regular tab (it's a
// full page, not just a popup), so that would wrongly reject it. What must
// hold is that the sender IS this extension: `sender.id` matches our own
// runtime id, AND `sender.url` is one of our own pages (a page origin under
// `chrome-extension://<our-id>/` / `moz-extension://<our-id>/`), ruling out
// a forged sender.id (not forgeable by the platform, but checked together as
// belt and braces since sender.url is what actually gates externally_connectable
// forgery attempts specifically).
function isTrustedInternalSender(sender) {
  return Boolean(sender && sender.id === api.runtime.id && typeof sender.url === "string" && sender.url.startsWith(api.runtime.getURL("")));
}

api.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || typeof message !== "object") return undefined;

  if (message.type === "coati:panel-ready") {
    connectIfNeeded();
    sendResponse({ state: wsState, workerInstanceId: WORKER_INSTANCE_ID });
    return undefined;
  }

  if (message.type === "coati:get-status") {
    sendResponse({ state: wsState, workerInstanceId: WORKER_INSTANCE_ID });
    return undefined;
  }

  if (message.type === "coati:client-message") {
    if (!isTrustedInternalSender(sender)) return undefined;
    sendToBroker(message.payload);
    // Lets the panel stamp the request with the worker instance that
    // actually accepted it — see WORKER_INSTANCE_ID above and panel.js's
    // request-watch (deliverable B4).
    sendResponse({ workerInstanceId: WORKER_INSTANCE_ID });
    return undefined;
  }

  // Sent by options.js on paste/save (docs/PROTOCOL.md "Mode hérité:
  // legacyPairing", section "Navigateur sans programme natif (Flatpak,
  // Snap)"). Centralised here (rather than options.js writing
  // storage.session directly) so the same force-reconnect path — which also
  // resets backoffMs and the retry-once flag below — always runs right after
  // the key changes. An empty value clears it instead of storing "". A
  // non-empty value that isn't exactly 64 lowercase hex chars is rejected
  // without being stored (options.js already validates before sending this,
  // this is the defense-in-depth copy).
  if (message.type === "coati:set-pasted-key") {
    if (!isTrustedInternalSender(sender)) return undefined;
    (async () => {
      const raw = typeof message.key === "string" ? message.key.trim().toLowerCase() : "";
      if (raw && !isHex64(raw)) {
        sendResponse({ ok: false });
        return;
      }
      if (raw) {
        await api.storage.session.set({ [PASTED_KEY_STORAGE_KEY]: raw });
      } else {
        await api.storage.session.remove(PASTED_KEY_STORAGE_KEY);
      }
      forceReconnect();
      sendResponse({ ok: true });
    })();
    return true; // keep the message channel open for the async sendResponse above
  }

  return undefined;
});

function broadcast(message) {
  api.runtime.sendMessage(message).catch(() => {
    // No listener (panel/options closed) — fine, nothing to relay to.
  });
}

function setState(next) {
  wsState = next;
  broadcast({ type: "coati:status", state: wsState });
}

/** Resolves the key (K) used for the v2 handshake, per docs/PROTOCOL.md
 * "Ordre des essais": a stored native key first (no host call — the whole
 * point of storage.session surviving a service-worker restart), else a
 * fresh host call (stored on success), else the legacy pasted key (used
 * "only when the host call fails" — Flatpak/Snap browsers with no native
 * messaging at all), else null (⇒ state "no-host").
 * @returns {Promise<{key: string, source: "native"|"pasted"} | null>} */
async function resolveBrokerKey() {
  const stored = await api.storage.session.get([BROKER_KEY_STORAGE_KEY, PASTED_KEY_STORAGE_KEY]);
  if (isHex64(stored[BROKER_KEY_STORAGE_KEY])) {
    return { key: stored[BROKER_KEY_STORAGE_KEY], source: "native" };
  }

  try {
    const key = await requestBrokerKeyFromHost(api);
    await api.storage.session.set({ [BROKER_KEY_STORAGE_KEY]: key });
    return { key, source: "native" };
  } catch {
    // Host unreachable/not installed/wrong id/timed out — the browser's own
    // rejection reason is never inspected (docs/PROTOCOL.md: it varies by
    // browser/version). Fall back to a pasted legacy key if one is stored.
    if (isHex64(stored[PASTED_KEY_STORAGE_KEY])) {
      return { key: stored[PASTED_KEY_STORAGE_KEY], source: "pasted" };
    }
    return null;
  }
}

async function connectIfNeeded() {
  if (wsState === "connected" || wsState === "connecting" || wsState === "handshaking") return;
  if (ws) return;

  setState("connecting");

  const keyInfo = await resolveBrokerKey();
  if (!keyInfo) {
    setState("no-host");
    return; // next attempt: the 30s reconnect alarm, or any panel-ready/get-status call
  }

  // docs/PROTOCOL.md "Poignée de main v: 2", step 2 — cN: 32 fresh random
  // bytes, 64 lowercase hex, new for every connection attempt (never reused
  // across retries, so a captured `auth` can't be replayed against a new one).
  const cN = randomHex32();
  let handshakeSettled = false; // true once past the challenge step (success or fail)
  // I3 (final security review): true only once the broker's HMAC proof has
  // actually verified for THIS connection. Every message before that point —
  // hello-ok included — is refused: accepting hello-ok (or relaying
  // chunk/error/prompts) on the strength of an unverified challenge would let
  // a broker that never proved its identity talk to the panel anyway.
  let brokerVerified = false;

  try {
    ws = new WebSocket(WS_URL);
  } catch {
    ws = null;
    scheduleReconnect();
    return;
  }

  ws.addEventListener("open", () => {
    setState("handshaking");
    ws.send(JSON.stringify({ type: "hello", v: PROTOCOL_VERSION, nonce: cN, key: keyInfo.source }));
    handshakeTimeoutId = setTimeout(() => {
      if (wsState !== "connected") {
        setState("handshake-timeout");
        ws?.close();
      }
    }, HELLO_TIMEOUT_MS);
  });

  ws.addEventListener("message", (event) => {
    let message;
    try {
      message = JSON.parse(event.data);
    } catch {
      return;
    }

    // I3 (final security review): before the broker's proof has verified,
    // the ONLY acceptable message is a first `challenge` — anything else
    // (hello-ok, chunk, error, prompts, or a second challenge racing the
    // first) means the peer on the other end never proved it holds the
    // shared key, so the socket is dropped outright rather than partially
    // trusted. docs/PROTOCOL.md "Poignée de main v: 2", steps 3-5: the
    // challenge is expected exactly once, before hello-ok, never again after.
    if (!brokerVerified) {
      if (message.type === "challenge" && !handshakeSettled && wsState === "handshaking") {
        handleChallenge(message);
        return;
      }
      ws?.close(4000);
      return;
    }

    handleBrokerMessage(message);
  });

  async function handleChallenge(message) {
    // Set synchronously, before the `await` below: a second `challenge`
    // arriving while this one is still mid-verification must find
    // handshakeSettled already true (it flips before any suspension point in
    // this function) — otherwise two overlapping verifications could race,
    // and a slow/malicious broker could reorder their effects.
    handshakeSettled = true;
    // Pinned so the continuations below can tell "this exact socket, still
    // the live one" apart from "closed (e.g. by the second-challenge guard
    // above) or replaced by a reconnect while verifyHmacHex/hmacHex were
    // pending" — sending auth (or trusting a stale `ok`) on the wrong/dead
    // socket would misattribute the proof to a connection it was never
    // computed for.
    const socket = ws;
    const bN = message.nonce;
    const bP = message.proof;
    // Malformed shape (nonce/proof not 64 lowercase hex) fails the same way
    // as a wrong proof below — verifyHmacHex would fail anyway, but the hex
    // check also guards against passing garbage into crypto.subtle.
    const ok = isHex64(bN) && (await verifyHmacHex(keyInfo.key, brokerProofMessage(cN, bN), bP));
    if (socket !== ws || wsState !== "handshaking") return; // stale — see comment above
    if (!ok) {
      // docs/PROTOCOL.md step 4: close 4000, send nothing else. The close
      // handler below does the actual key-clearing/retry/terminal-state work.
      ws?.close(4000);
      return;
    }
    // Proof verified — this connection now trusts the peer. Set BEFORE
    // sending `auth`: the ordering itself isn't racy in JS's single-threaded
    // model, but it keeps "verified" and "about to prove ourselves" in the
    // same statement block, matching how the rest of this file reasons about
    // handshake state.
    brokerVerified = true;
    const eP = await hmacHex(keyInfo.key, extensionProofMessage(cN, bN));
    if (socket !== ws || wsState !== "handshaking") return; // stale again after the 2nd await
    ws.send(JSON.stringify({ type: "auth", v: PROTOCOL_VERSION, proof: eP }));
  }

  ws.addEventListener("close", (event) => {
    clearTimeout(handshakeTimeoutId);
    ws = null;
    handshakeSettled = true;

    // docs/PROTOCOL.md "Poignée de main v: 2": 4000 = the broker's own proof
    // didn't verify (our own close code, chosen above); 4401 = the broker
    // rejected `auth` (or the Origin, before any challenge). Both clear the
    // key that was just proven wrong/refused and retry once — but only when
    // that key came from the native host: a pasted legacy key has no host
    // to re-call, so it goes straight to the terminal state.
    if (event.code === 4000 || event.code === 4401) {
      const terminalState = event.code === 4000 ? "broker-untrusted" : "no-token";
      const storageKey = keyInfo.source === "pasted" ? PASTED_KEY_STORAGE_KEY : BROKER_KEY_STORAGE_KEY;
      const canRetry = keyInfo.source === "native" && !retriedThisCycle;
      api.storage.session
        .remove(storageKey)
        .catch(() => {})
        .finally(() => {
          if (canRetry) {
            retriedThisCycle = true;
            setState("disconnected");
            connectIfNeeded(); // immediate: re-resolves the key (fresh host call)
            return;
          }
          setState(terminalState);
        });
      return;
    }

    setState("disconnected");
    scheduleReconnect();
  });

  ws.addEventListener("error", (event) => {
    // The close event follows; nothing actionable here besides letting it fire,
    // but log it so a case where that assumption breaks isn't silently invisible.
    console.warn("coati: WebSocket error", { state: wsState, type: event?.type, event });
  });
}

// Called right after the options page changes the stored pasted key (paste
// or clear — see "coati:set-pasted-key" above): any stale socket/backoff
// state from repeated failed attempts must not delay the very next attempt.
// A deliberate key change also starts a fresh handshake cycle, so the
// retry-once flag resets here too.
function forceReconnect() {
  if (ws) {
    try {
      ws.close();
    } catch {
      // already closed/closing — fine.
    }
    ws = null;
  }
  backoffMs = 1000;
  retriedThisCycle = false;
  setState("disconnected");
  connectIfNeeded();
}

function scheduleReconnect() {
  setTimeout(() => {
    backoffMs = Math.min(backoffMs * 2, MAX_BACKOFF_MS);
    connectIfNeeded();
  }, backoffMs);
}

function handleBrokerMessage(message) {
  if (message.type === "hello-ok") {
    // I3: only reachable here once brokerVerified is true (see the message
    // listener above), but re-asserted per the spec — hello-ok is only ever
    // meaningful while still mid-handshake, never once already connected.
    if (wsState !== "handshaking") return;
    clearTimeout(handshakeTimeoutId);
    backoffMs = 1000;
    // hello-ok is the end of a handshake cycle (docs/PROTOCOL.md "Poignée de
    // main v: 2") — the next 4000/4401 gets its own single retry again.
    retriedThisCycle = false;
    // No token to store (docs/PROTOCOL.md amendement 2026-09-30: hello-ok
    // v2 carries no token at all — the key already proved everything).
    setState("connected");
    flushPendingRequest();
    return;
  }

  // chunk / done / error / prompts — relayed as-is to the panel.
  broadcast({ type: "coati:broker-message", message });
}

function sendToBroker(payload) {
  if (!payload) return;
  if (wsState === "connected" && ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(payload));
    return;
  }
  // Socket not up right now (deliverable B2): hold the request instead of
  // failing it on the spot — a broker restart is usually back within
  // seconds, and rejecting immediately turns every restart into a visible
  // error for no reason. connectIfNeeded() is the "immediate attempt on any
  // user action" half of deliverable B3 (the other half is the alarm).
  holdPendingRequest(payload);
  connectIfNeeded();
}

/** Holds at most one request while reconnecting, and drops it — with an
 * explicit French reason sent back as a normal terminal `error` for its id —
 * after PENDING_REQUEST_TIMEOUT_MS, or immediately if a second request
 * arrives before the first was flushed. Never queues silently/unboundedly. */
function holdPendingRequest(payload) {
  if (pendingRequest) {
    rejectPendingRequest(pendingRequest, "Une nouvelle requête a pris la priorité ; celle-ci a été abandonnée.");
  }
  const timeoutId = setTimeout(() => {
    if (pendingRequest && pendingRequest.payload === payload) {
      rejectPendingRequest(
        pendingRequest,
        "Le broker ne répond pas depuis 15 s. Vérifiez qu'il tourne sur cette machine, puis réessayez.",
      );
    }
  }, PENDING_REQUEST_TIMEOUT_MS);
  pendingRequest = { payload, timeoutId };
}

function rejectPendingRequest(entry, reasonMessage) {
  clearTimeout(entry.timeoutId);
  if (pendingRequest === entry) pendingRequest = null;
  broadcast({
    type: "coati:broker-message",
    message: { type: "error", id: entry.payload?.id ?? "unknown", code: "internal", message: reasonMessage },
  });
}

/** Replays the one held request, if any, once the socket reaches
 * "connected" — called from handleBrokerMessage's hello-ok branch. */
function flushPendingRequest() {
  if (!pendingRequest || wsState !== "connected" || !ws || ws.readyState !== WebSocket.OPEN) return;
  const { payload, timeoutId } = pendingRequest;
  clearTimeout(timeoutId);
  pendingRequest = null;
  ws.send(JSON.stringify(payload));
}
