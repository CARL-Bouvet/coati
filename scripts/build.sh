#!/usr/bin/env bash
# Construit les deux paquets Coati (Chrome/Brave et Firefox) depuis la même
# arborescence source `extension/`. Pas de bundler, pas de dépendance : une
# copie de travail par cible, le bon manifest posé dessus, `zip`.
#
# Chrome/Brave garde `extension/manifest.json` tel quel (le "Charger l'extension
# non empaquetée" du navigateur continue de pointer directement sur `extension/`
# sans passer par ce script). Firefox n'a pas le même manifest — voir
# `extension/manifest.firefox.json` et docs/FIREFOX.md pour le détail des
# différences (background non-persistant, sidebar_action au lieu de side_panel,
# pas d'externally_connectable, pas de `key`). Ce script copie la source, pose
# manifest.firefox.json à la place de manifest.json, puis zippe — le fichier
# manifest.firefox.json lui-même ne doit jamais finir dans un paquet.
#
#   ./scripts/build.sh
#
# Produit :
#   dist/coati-chrome.zip
#   dist/coati-firefox.zip
#   dist/stage/firefox/        copie non empaquetée, pour "Charger un module
#                               complémentaire temporaire" dans Firefox — ce
#                               chargeur exige un manifest.json réel sur disque,
#                               un .zip ne suffit pas. Voir docs/FIREFOX.md.

set -euo pipefail
cd "$(dirname "$0")/.."

SRC="$PWD/extension"
DIST="$PWD/dist"
STAGE="$DIST/stage"

# The two manifests are hand-maintained separately (no templating) — the one
# thing they must never drift on is "version": AMO refuses to sign the same
# version number twice for a given gecko id, and a silent mismatch would make
# the Firefox package invisibly stale. See docs/FIREFOX.md "Pour republier".
CHROME_VERSION="$(bun -e 'console.log(JSON.parse(await Bun.file(process.argv[1]).text()).version)' "$SRC/manifest.json")"
FIREFOX_VERSION="$(bun -e 'console.log(JSON.parse(await Bun.file(process.argv[1]).text()).version)' "$SRC/manifest.firefox.json")"
if [ "$CHROME_VERSION" != "$FIREFOX_VERSION" ]; then
  echo "build.sh: version mismatch — manifest.json=$CHROME_VERSION manifest.firefox.json=$FIREFOX_VERSION" >&2
  exit 1
fi

rm -rf "$DIST"
mkdir -p "$DIST"

build_target() {
  local browser="$1"       # chrome | firefox
  local manifest_src="$2"  # manifest à poser comme manifest.json dans le paquet
  local stage="$STAGE/$browser"

  rm -rf "$stage"
  mkdir -p "$stage"
  cp -r "$SRC"/. "$stage"/
  rm -f "$stage/manifest.json" "$stage/manifest.firefox.json"
  cp "$manifest_src" "$stage/manifest.json"

  local zip_path="$DIST/coati-$browser.zip"
  (cd "$stage" && zip -qr -X "$zip_path" .)
  echo "dist/coati-$browser.zip"
}

build_target chrome "$SRC/manifest.json"
build_target firefox "$SRC/manifest.firefox.json"

echo "dist/stage/firefox/  (chargement temporaire Firefox — voir docs/FIREFOX.md)"
