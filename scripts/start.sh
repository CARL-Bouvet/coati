#!/usr/bin/env bash
# Starts the Coati broker and reminds how to connect the extension.
#
#   ./scripts/start.sh          # start in the background
#   ./scripts/start.sh --stop   # stop
#   ./scripts/start.sh --log    # follow the log

set -uo pipefail
cd "$(dirname "$0")/.."

LOG=/tmp/coati-broker.log
CONFIG="$HOME/.config/coati/config.json"
KEY_FILE="$HOME/.local/share/coati/broker-key.json"

case "${1:-}" in
  --stop)
    pgrep -f "broker/src/server.ts" | head -1 | xargs -r kill -TERM
    # Wait for the process to actually
    # exit before returning, up to ~10s — a caller that restarts right after
    # --stop (tests, dev workflow) must never race the old process still
    # holding the port/socket.
    for _ in $(seq 1 20); do
      pgrep -f "broker/src/server.ts" > /dev/null || break
      sleep 0.5
    done
    if pgrep -f "broker/src/server.ts" > /dev/null; then
      echo "Broker still running after 10 s." >&2
      exit 1
    fi
    echo "Broker stopped."
    exit 0
    ;;
  --log)
    tail -f "$LOG"
    exit 0
    ;;
esac

if pgrep -f "broker/src/server.ts" > /dev/null; then
  echo "Broker already running. (--stop to stop it)"
else
  setsid --fork bun broker/src/server.ts > "$LOG" 2>&1 < /dev/null
  sleep 2
  cat "$LOG"
fi

echo
echo "To connect the extension:"
echo "  1. chrome://extensions → developer mode → Load unpacked extension"
echo "     → $PWD/extension"
echo "  2. Copy the displayed extension ID and add it to $CONFIG"
echo "     under \"allowedExtensionIds\" (the broker rejects every other origin)."
echo "  3. Once: bash scripts/dev-native-host.sh (registers the native host"
echo "     with the browser; the extension then fetches the broker key itself)."
if [ -f "$KEY_FILE" ]; then
  echo "     Broker key present: $KEY_FILE"
else
  echo "     (the key is written to $KEY_FILE when the broker is listening)"
fi
