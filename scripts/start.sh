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
TOKEN_FILE="$HOME/.local/share/coati/pairing.txt"

case "${1:-}" in
  --stop)
    pgrep -f "broker/src/server.ts" | head -1 | xargs -r kill -TERM
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
echo "  3. Ouvrir les options de l'extension et y coller le jeton :"
if [ -f "$TOKEN_FILE" ]; then
  echo "     $(cat "$TOKEN_FILE")"
else
  echo "     (le jeton sera créé au premier démarrage dans $TOKEN_FILE)"
fi
echo
echo "Le jeton vit en mémoire vive côté navigateur : il est à recoller après"
echo "chaque redémarrage de Chrome. C'est voulu — rien de secret ne touche le disque."
