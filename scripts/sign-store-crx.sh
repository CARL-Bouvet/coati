#!/usr/bin/env bash
# Signs the Chrome Web Store package as a CRX3. The store item has verified
# uploads on: every update must be a .crx signed with the upload key.
#
#   ./scripts/build.sh
#   <print the upload key PEM> | ./scripts/sign-store-crx.sh
#
# The key is read from stdin, written only to a private temp dir, and removed
# on exit. Produces dist/coati-chrome-store.crx. CHROME picks the browser
# binary (default: brave).

set -euo pipefail
cd "$(dirname "$0")/.."

STORE="$PWD/dist/stage/chrome-store"
[ -f "$STORE/manifest.json" ] || { echo "sign-store-crx.sh: run scripts/build.sh first" >&2; exit 1; }

umask 077
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
cat > "$TMP/key.pem"
grep -q 'PRIVATE KEY' "$TMP/key.pem" || { echo "sign-store-crx.sh: no PEM private key on stdin" >&2; exit 1; }

cp -r "$STORE" "$TMP/pkg"
"${CHROME:-brave}" --user-data-dir="$TMP/profile" --no-message-box \
  --pack-extension="$TMP/pkg" --pack-extension-key="$TMP/key.pem" >/dev/null 2>&1 || true
[ -s "$TMP/pkg.crx" ] || { echo "sign-store-crx.sh: browser produced no .crx" >&2; exit 1; }
mv "$TMP/pkg.crx" dist/coati-chrome-store.crx
echo "dist/coati-chrome-store.crx  (Chrome Web Store upload, signed)"
