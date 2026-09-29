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

// Amendement 2026-09-25 (docs/PROTOCOL.md "Transport") — port fixed at 8787
// for the extension: neither WS_URL below nor the manifests' connect-src CSP
// can take a variable, so this port is hardcoded here and in both manifests,
// kept equal by convention. A broker on another port is unreachable, manual
// paste included; the broker no longer reads a "port" config key either.
const BROKER_PORT = 8787;
const WS_URL = `ws://127.0.0.1:${BROKER_PORT}/ws`;
const PROTOCOL_VERSION = 1;
const RECONNECT_ALARM = "coati-reconnect";
const MAX_BACKOFF_MS = 30000;
// Must stay below the broker's own handshake timeout (3000ms, server.ts:193-195)
// so the client — not the server closing the socket first — is the one to
// report "handshake timeout" as a distinct state.
const HELLO_TIMEOUT_MS = 2500;
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
let wsState = "disconnected"; // disconnected | connecting | handshaking | connected
let backoffMs = 1000;
let helloTimeoutId = null;
// At most one request held while reconnecting (deliverable B2) —
// { payload, timeoutId }, or null when nothing is queued.
let pendingRequest = null;
// docs/PROTOCOL.md "Appairage silencieux", "Jeton refusé": at most one
// no-secret retry per connection cycle after a 4401 that followed a `secret`.
// A cycle runs from a disconnection to the next `hello-ok`, which resets this
// flag — never a silent infinite loop against a broker that keeps refusing.
let retriedWithoutSecretThisCycle = false;

api.runtime.onInstalled.addListener(() => {
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
// "coati:set-token" (overwrite the pairing token). Deliberately NOT
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

  // Sent by options.js on paste/save (docs/PROTOCOL.md "Appairage
  // silencieux", "Collage (options, Firefox)"). Centralised here (rather than
  // options.js writing storage.session directly) so the same force-reconnect
  // path — which also resets backoffMs and the retry-once flag below — always
  // runs right after the token changes. An empty token clears it instead of
  // storing "".
  if (message.type === "coati:set-token") {
    if (!isTrustedInternalSender(sender)) return undefined;
    (async () => {
      const token = typeof message.token === "string" ? message.token.trim() : "";
      if (token) {
        await api.storage.session.set({ pairingToken: token });
      } else {
        await api.storage.session.remove("pairingToken");
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

async function connectIfNeeded() {
  if (wsState === "connected" || wsState === "connecting" || wsState === "handshaking") return;
  if (ws) return;

  // With no stored token, still attempt the handshake — this Chrome install
  // may already be trusted (its origin is fixed, unforgeable, and derived
  // from manifest.json's pinned key; see docs/PROTOCOL.md "Appairage
  // silencieux"), in which case the broker silently auto-grants a token on
  // hello-ok. Same thing for a Firefox uuid already pinned. If the broker
  // doesn't know this origin, it refuses and the close handler below falls
  // back to "no-token".
  const { pairingToken } = await api.storage.session.get("pairingToken");

  setState("connecting");
  try {
    ws = new WebSocket(WS_URL);
  } catch {
    ws = null;
    scheduleReconnect();
    return;
  }

  ws.addEventListener("open", () => {
    setState("handshaking");
    const hello = { type: "hello", v: PROTOCOL_VERSION };
    if (pairingToken) hello.secret = pairingToken;
    ws.send(JSON.stringify(hello));
    helloTimeoutId = setTimeout(() => {
      if (wsState !== "connected") {
        setState("handshake-timeout");
        ws?.close();
      }
    }, HELLO_TIMEOUT_MS);
  });

  ws.addEventListener("message", (event) => {
    handleBrokerMessage(event.data);
  });

  ws.addEventListener("close", (event) => {
    clearTimeout(helloTimeoutId);
    ws = null;

    // docs/PROTOCOL.md "Jeton refusé": a 4401 during the handshake, after we
    // sent a `secret` (permanent secret or session token), means that secret
    // is stale — typically a broker restart, which invalidates every session
    // token in memory. Drop it and retry once, immediately, without any
    // secret: an already-known origin (Chromium id, pinned Firefox uuid)
    // gets a silent grant; an unknown one falls through to "no-token" below
    // on this very next attempt. At most once per cycle (flag reset on
    // hello-ok) so a broker that keeps refusing never loops silently.
    if (event.code === 4401 && wsState === "handshaking" && pairingToken && !retriedWithoutSecretThisCycle) {
      retriedWithoutSecretThisCycle = true;
      setState("disconnected");
      // Wait for the removal before reconnecting: connectIfNeeded() re-reads
      // storage.session, and an un-awaited remove() let it read the SAME stale
      // token and loop on refusals (broker journal, 2026-09-25 08:48 — several
      // refusals per second after a broker restart).
      api.storage.session
        .remove("pairingToken")
        .catch(() => {})
        .finally(() => connectIfNeeded());
      return;
    }

    // No secret was sent (or the no-secret retry above just ran), and the
    // handshake still didn't reach "connected": the broker doesn't know this
    // origin (silent auto-grant was refused). Retrying immediately with
    // backoff would just get refused again — fall back to "no-token" and let
    // the existing reconnect alarm (every 30s) retry later.
    if (!pairingToken && wsState === "handshaking") {
      setState("no-token");
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

// Called right after the options page changes the stored token (paste or
// clear — see "coati:set-token" above): any stale socket/backoff state
// from repeated failed attempts on the OLD (or absent) token must not delay
// the very next attempt. A deliberate token change also starts a fresh
// handshake cycle, so the no-secret-retry flag resets here too.
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
  retriedWithoutSecretThisCycle = false;
  setState("disconnected");
  connectIfNeeded();
}

function scheduleReconnect() {
  setTimeout(() => {
    backoffMs = Math.min(backoffMs * 2, MAX_BACKOFF_MS);
    connectIfNeeded();
  }, backoffMs);
}

function handleBrokerMessage(raw) {
  let message;
  try {
    message = JSON.parse(raw);
  } catch {
    return;
  }

  if (message.type === "hello-ok") {
    clearTimeout(helloTimeoutId);
    backoffMs = 1000;
    // hello-ok is the end of a handshake cycle (docs/PROTOCOL.md "Jeton
    // refusé") — the next 4401 gets its own single no-secret retry again.
    retriedWithoutSecretThisCycle = false;
    // token is always present now (docs/PROTOCOL.md "Poignée de main"): a
    // fresh session token (silent grant, or after presenting the permanent
    // secret / a session token), or the same one echoed back. Store it in
    // chrome.storage.session, never local (CLAUDE.md rule #1), replacing
    // whatever was there — in particular a permanent secret pasted by hand
    // is replaced by the session token from this very hello-ok.
    if (message.token) {
      api.storage.session.set({ pairingToken: message.token }).catch(() => {});
    }
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
