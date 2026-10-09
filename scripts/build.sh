#!/usr/bin/env bash
# Builds the two Coati packages (Chrome/Brave and Firefox) from the same
# `extension/` source tree. No bundler, no extra dependency: one working copy
# per target, the right manifest dropped in, then `zip`.
#
# Chrome/Brave keeps `extension/manifest.json` as-is (the browser's "Load
# unpacked extension" flow continues to point directly at `extension/` without
# going through this script). Firefox uses a different manifest — see
# `extension/manifest.firefox.json` and docs/INSTALL.md for the differences
# (non-persistent background, sidebar_action instead of side_panel, no
# externally_connectable, no `key`). This script copies the source, drops
# manifest.firefox.json in place of manifest.json, then zips — the
# manifest.firefox.json file itself must never end up inside a package.
#
#   ./scripts/build.sh
#
# Produces:
#   dist/coati-chrome.zip
#   dist/coati-firefox.zip
#   dist/stage/firefox/        unpacked copy, for "Load Temporary Add-on"
#                               in Firefox — that loader requires a real
#                               manifest.json on disk, a .zip is not enough.
#                               See docs/INSTALL.md.

set -euo pipefail
cd "$(dirname "$0")/.."

SRC="$PWD/extension"
DIST="$PWD/dist"
STAGE="$DIST/stage"

# The two manifests are hand-maintained separately (no templating) — the one
# thing they must never drift on is "version": AMO refuses to sign the same
# version number twice for a given gecko id, and a silent mismatch would make
# the Firefox package invisibly stale. See docs/INSTALL.md "Re-publish".
CHROME_VERSION="$(bun -e 'console.log(JSON.parse(await Bun.file(process.argv[1]).text()).version)' "$SRC/manifest.json")"
FIREFOX_VERSION="$(bun -e 'console.log(JSON.parse(await Bun.file(process.argv[1]).text()).version)' "$SRC/manifest.firefox.json")"
if [ "$CHROME_VERSION" != "$FIREFOX_VERSION" ]; then
  echo "build.sh: version mismatch — manifest.json=$CHROME_VERSION manifest.firefox.json=$FIREFOX_VERSION" >&2
  exit 1
fi

# Only wipe this script's own outputs — dist/ is shared with
# scripts/build-binaries.sh's dist/bin/, which must survive a build.sh run
# regardless of run order.
rm -rf "$DIST/stage" "$DIST/coati-chrome.zip" "$DIST/coati-firefox.zip"
mkdir -p "$DIST"

build_target() {
  local browser="$1"       # chrome | firefox
  local manifest_src="$2"  # manifest to use as manifest.json in the package
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

echo "dist/stage/firefox/  (Firefox temporary load — see docs/INSTALL.md)"
