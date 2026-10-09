#!/usr/bin/env bash
# Coati — end-to-end sanity loop.
#
# Loads the extension in a dedicated Chrome profile, seeds the pairing token in
# the service worker, and lets the reconnect alarm trigger the connection to the
# broker. Answers one question: does the extension reach the local server,
# and with what `Origin`?
#
#   ./scripts/smoke.sh            # against the real broker (must be on 8787)
#   ./scripts/smoke.sh --stub     # against a stub that logs everything
#
# Variables:
#   COATI_CHROME    browser binary (default: Chrome for Testing 154)
#   COATI_HEADLESS  0 for a real window. Required to observe a permission prompt:
#                     in headless mode it cannot appear, so its absence proves
#                     nothing.
#   COATI_PROFILE   profile directory (default: a dedicated profile per browser)
#   COATI_DEV       1 to load the development copy (host permissions granted
#                     upfront, cf. scripts/dev-extension.sh). Required to test
#                     extraction without a human click. The extension ID differs:
#                     declare it once in ~/.config/coati/config.json →
#                     allowedExtensionIds.
#
# Leaves the browser alive at the end: inspect with `bun scripts/cdp-eval.js '<expr>'`.
# Stop with ./scripts/smoke.sh --stop

set -uo pipefail
cd "$(dirname "$0")/.."

CHROME="${COATI_CHROME:-$HOME/.cache/ms-playwright/chromium-1244/chrome-linux64/chrome}"
HEADLESS="${COATI_HEADLESS:-1}"
PROFILE="${COATI_PROFILE:-$HOME/.local/share/coati/profile-$(basename "$CHROME")}"
if [ "${COATI_DEV:-0}" = "1" ]; then
  ./scripts/dev-extension.sh > /dev/null
  EXT="${COATI_DEV_EXT:-/tmp/coati-ext-dev}"
else
  EXT="$PWD/extension"
fi
PORT="${COATI_PORT:-9222}"
STUB_LOG=/tmp/coati-stub.log

stop() {
  pkill -f "user-data-dir=$PROFILE" && echo "Chrome stopped."
  pkill -f "coati-stub.js" && echo "Stub stopped."
  exit 0
}
[ "${1:-}" = "--stop" ] && stop

if [ "${1:-}" = "--stub" ]; then
  cat > /tmp/coati-stub.js <<'STUB'
const log = (m) => console.log(new Date().toISOString(), m);
Bun.serve({
  hostname: "127.0.0.1", port: 8787,
  fetch(req, server) {
    const origin = req.headers.get("origin") ?? "(none)";
    if (server.upgrade(req, { data: { origin } })) return;
    log("HTTP " + req.method + " origin=" + origin);
    return new Response("coati stub");
  },
  websocket: {
    open(ws) { log("WS OPEN origin=" + ws.data.origin); },
    message(ws, msg) {
      log("WS MSG " + String(msg).slice(0, 300));
      ws.send(JSON.stringify({ type: "hello-ok", v: 1, models: ["claude"], capabilities: ["chat", "summarize"] }));
    },
    close(ws, code, reason) { log("WS CLOSE " + code + " " + reason); },
  },
});
log("stub listening on 127.0.0.1:8787");
STUB
  setsid --fork bun /tmp/coati-stub.js > "$STUB_LOG" 2>&1 < /dev/null
  sleep 1
  echo "Stub started → $STUB_LOG"
fi

mkdir -p "$PROFILE"
if [ "$HEADLESS" = "1" ]; then MODE=(--headless=new); else MODE=(); fi
if ! pgrep -f "user-data-dir=$PROFILE" > /dev/null; then
  setsid --fork "$CHROME" "${MODE[@]}" --no-first-run --no-default-browser-check \
    --user-data-dir="$PROFILE" \
    --disable-extensions-except="$EXT" --load-extension="$EXT" \
    --remote-debugging-port=$PORT about:blank > /tmp/coati-chrome.log 2>&1 < /dev/null
  sleep 6
  echo "$(basename "$CHROME") launched (headless=$HEADLESS, profile $PROFILE, extension loaded)."
fi

# The token lives in chrome.storage.session: it disappears on every browser
# restart, by design. Re-seed it on every run.
bun scripts/cdp-eval.js "chrome.storage.session.set({pairingToken:'${COATI_TOKEN:-smoke-token}'}).then(()=>'token seeded')" "$PORT"
echo "Loaded extension ID:"
bun scripts/cdp-eval.js "chrome.runtime.id" "$PORT"

echo "Waiting for the reconnect alarm (up to 35 s)..."
sleep 35

if [ "${1:-}" = "--stub" ]; then
  echo "--- journal du stub ---"
  cat "$STUB_LOG"
fi
