#!/usr/bin/env bash
# Prints the same code fingerprint the panel computes at runtime
# (extension/panel/panel.js, computeCodeFingerprint), but from the files on
# disk instead of what the browser actually loaded. A human compares the two
# in one glance to catch testing against stale unpacked code (deliverable C1
# — twice in one day was lost to exactly that before this existed).
#
#   ./scripts/stamp.sh
#
# The file list and order below MUST stay identical to panel.js's
# FINGERPRINT_FILES — same paths, same order, same "concatenate raw bytes,
# SHA-256, first 7 hex chars" — or the two hashes are not comparable.

set -euo pipefail
cd "$(dirname "$0")/.."

EXT="$PWD/extension"

FILES=(
  "background/service-worker.js"
  "content/detect.js"
  "content/extract.js"
  "lib/browser-compat.js"
  "manifest.json"
  "options.css"
  "options.html"
  "options.js"
  "panel/panel.css"
  "panel/panel.html"
  "panel/panel.js"
  "panel/retention.js"
  "panel/timestamps.js"
)

VERSION="$(bun -e 'console.log(JSON.parse(await Bun.file(process.argv[1]).text()).version)' "$EXT/manifest.json" 2>/dev/null \
  || node -e 'console.log(JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")).version)' "$EXT/manifest.json")"

HASH="$(cat "${FILES[@]/#/$EXT/}" | sha256sum | cut -c1-7)"

echo "v$VERSION · $HASH"
