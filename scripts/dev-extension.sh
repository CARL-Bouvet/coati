#!/usr/bin/env bash
# Construit une copie de `extension/` avec les permissions d'hôte déjà accordées,
# pour pouvoir éprouver l'extraction sans clic humain.
#
# Pourquoi : le manifest publié n'a que `activeTab` + permissions d'hôte
# optionnelles (DECISIONS.md T5). C'est la bonne posture — aucun code ne lit une
# page sans geste de l'utilisateur — mais elle rend tout test automatisé
# impossible. Cette copie existe uniquement pour le développement et n'est
# jamais empaquetée.
#
#   ./scripts/dev-extension.sh          # construit /tmp/coati-ext-dev
#   ./scripts/dev-extension.sh --id     # affiche l'identifiant que Chrome lui donnera
#
# L'identifiant d'une extension non empaquetée dérive du chemin absolu : la copie
# a donc un identifiant différent de `extension/`, à déclarer une fois dans
# ~/.config/coati/config.json → allowedExtensionIds.

set -euo pipefail
cd "$(dirname "$0")/.."

SRC="$PWD/extension"
DEST="${COATI_DEV_EXT:-/tmp/coati-ext-dev}"

rm -rf "$DEST"
mkdir -p "$DEST"
cp -r "$SRC"/. "$DEST"/

# Les permissions d'hôte deviennent obligatoires au lieu d'optionnelles, et le
# nom change pour qu'on ne confonde jamais les deux dans chrome://extensions.
bun -e '
  const path = process.argv[1];
  const m = JSON.parse(await Bun.file(path).text());
  m.name = "Coati (dev)";
  m.host_permissions = ["http://*/*", "https://*/*"];
  delete m.optional_host_permissions;
  await Bun.write(path, JSON.stringify(m, null, 2) + "\n");
' "$DEST/manifest.json"

echo "Copie de développement : $DEST"
echo "Permissions d'hôte accordées d'office. Ne jamais empaqueter cette copie."
