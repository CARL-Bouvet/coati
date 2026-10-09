#!/usr/bin/env bash
# Builds a copy of `extension/` with host permissions already granted, so
# extraction can be tested without a human click.
#
# Why: the published manifest only has `activeTab` + optional host permissions
# (DECISIONS.md T5). That is the right posture — no code reads a page without
# a user gesture — but it makes automated testing impossible. This copy exists
# for development only and is never packaged.
#
#   ./scripts/dev-extension.sh          # builds /tmp/coati-ext-dev
#   ./scripts/dev-extension.sh --id     # print the ID Chrome will assign it
#
# The ID of an unpacked extension is derived from its absolute path: the copy
# gets a different ID than `extension/`, which must be declared once in
# ~/.config/coati/config.json → allowedExtensionIds.

set -euo pipefail
cd "$(dirname "$0")/.."

SRC="$PWD/extension"
DEST="${COATI_DEV_EXT:-/tmp/coati-ext-dev}"

rm -rf "$DEST"
mkdir -p "$DEST"
cp -r "$SRC"/. "$DEST"/

# Host permissions become required instead of optional, and the name changes
# so the two are never confused in chrome://extensions.
bun -e '
  const path = process.argv[1];
  const m = JSON.parse(await Bun.file(path).text());
  m.name = "Coati (dev)";
  m.host_permissions = ["http://*/*", "https://*/*"];
  delete m.optional_host_permissions;
  await Bun.write(path, JSON.stringify(m, null, 2) + "\n");
' "$DEST/manifest.json"

echo "Development copy: $DEST"
echo "Host permissions granted upfront. Never package this copy."
