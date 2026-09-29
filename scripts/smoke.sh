#!/usr/bin/env bash
# Coati — boucle de vérification de bout en bout.
#
# Charge l'extension dans un profil Chrome dédié, sème le jeton de pairage dans
# le service worker, et laisse l'alarme de reconnexion déclencher la connexion au
# broker. Sert à répondre à une seule question, la seule qui compte ici : est-ce
# que l'extension joint le serveur local, et avec quel `Origin` ?
#
#   ./scripts/smoke.sh            # contre le vrai broker (doit tourner sur 8787)
#   ./scripts/smoke.sh --stub     # contre un stub qui journalise tout
#
# Variables :
#   COATI_CHROME    binaire du navigateur (défaut : Chrome for Testing 154)
#   COATI_HEADLESS  0 pour une vraie fenêtre. Indispensable pour observer une
#                     demande de permission : en headless elle ne peut pas
#                     s'afficher, donc son absence ne prouve rien.
#   COATI_PROFILE   répertoire de profil (défaut : un profil dédié par navigateur)
#   COATI_DEV       1 pour charger la copie de développement (permissions
#                     d'hôte accordées d'office, cf. scripts/dev-extension.sh).
#                     Indispensable pour éprouver l'extraction sans clic humain.
#                     L'identifiant d'extension diffère : à déclarer une fois
#                     dans ~/.config/coati/config.json → allowedExtensionIds.
#
# Laisse le navigateur en vie à la fin : inspecter avec `bun scripts/cdp-eval.js '<expr>'`.
# Arrêter avec ./scripts/smoke.sh --stop

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
  pkill -f "user-data-dir=$PROFILE" && echo "Chrome arrêté."
  pkill -f "coati-stub.js" && echo "Stub arrêté."
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
  echo "Stub démarré → $STUB_LOG"
fi

mkdir -p "$PROFILE"
if [ "$HEADLESS" = "1" ]; then MODE=(--headless=new); else MODE=(); fi
if ! pgrep -f "user-data-dir=$PROFILE" > /dev/null; then
  setsid --fork "$CHROME" "${MODE[@]}" --no-first-run --no-default-browser-check \
    --user-data-dir="$PROFILE" \
    --disable-extensions-except="$EXT" --load-extension="$EXT" \
    --remote-debugging-port=$PORT about:blank > /tmp/coati-chrome.log 2>&1 < /dev/null
  sleep 6
  echo "$(basename "$CHROME") lancé (headless=$HEADLESS, profil $PROFILE, extension chargée)."
fi

# Le jeton vit en chrome.storage.session : il disparaît à chaque redémarrage du
# navigateur, c'est voulu. On le resème à chaque passage.
bun scripts/cdp-eval.js "chrome.storage.session.set({pairingToken:'${COATI_TOKEN:-smoke-token}'}).then(()=>'token semé')" "$PORT"
echo "Identifiant de l'extension chargée :"
bun scripts/cdp-eval.js "chrome.runtime.id" "$PORT"

echo "Attente de l'alarme de reconnexion (jusqu'à 35 s)…"
sleep 35

if [ "${1:-}" = "--stub" ]; then
  echo "--- journal du stub ---"
  cat "$STUB_LOG"
fi
