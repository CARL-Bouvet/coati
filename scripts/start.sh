#!/usr/bin/env bash
# Démarre le broker Coati et rappelle comment brancher l'extension.
#
#   ./scripts/start.sh          # démarre en tâche de fond
#   ./scripts/start.sh --stop   # arrête
#   ./scripts/start.sh --log    # suit le journal

set -uo pipefail
cd "$(dirname "$0")/.."

LOG=/tmp/coati-broker.log
CONFIG="$HOME/.config/coati/config.json"
KEY_FILE="$HOME/.local/share/coati/broker-key.json"

case "${1:-}" in
  --stop)
    pgrep -f "broker/src/server.ts" | head -1 | xargs -r kill -TERM
    # Amendement 2026-10-02 (goal-j2FJ-kI7): wait for the process to actually
    # exit before returning, up to ~10s — a caller that restarts right after
    # --stop (tests, dev workflow) must never race the old process still
    # holding the port/socket.
    for _ in $(seq 1 20); do
      pgrep -f "broker/src/server.ts" > /dev/null || break
      sleep 0.5
    done
    if pgrep -f "broker/src/server.ts" > /dev/null; then
      echo "Broker toujours en cours après 10 s d'attente." >&2
      exit 1
    fi
    echo "Broker arrêté."
    exit 0
    ;;
  --log)
    tail -f "$LOG"
    exit 0
    ;;
esac

if pgrep -f "broker/src/server.ts" > /dev/null; then
  echo "Le broker tourne déjà. (--stop pour l'arrêter)"
else
  setsid --fork bun broker/src/server.ts > "$LOG" 2>&1 < /dev/null
  sleep 2
  cat "$LOG"
fi

echo
echo "Pour brancher l'extension :"
echo "  1. chrome://extensions → mode développeur → « Charger l'extension non empaquetée »"
echo "     → $PWD/extension"
echo "  2. Relever l'identifiant affiché, et l'ajouter à $CONFIG"
echo "     dans \"allowedExtensionIds\" (le broker refuse toute autre origine)."
echo "  3. Une fois : bash scripts/dev-native-host.sh (déclare le programme natif"
echo "     au navigateur ; l'extension obtient alors la clé du broker d'elle-même)."
if [ -f "$KEY_FILE" ]; then
  echo "     Clé du broker présente : $KEY_FILE"
else
  echo "     (la clé est écrite dans $KEY_FILE quand le broker écoute)"
fi
