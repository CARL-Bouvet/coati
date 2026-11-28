#!/bin/sh
# Coati local program installer (Linux, macOS). Downloads coati-broker from the
# GitHub release, verifies its SHA-256 checksum, then runs its own installer
# for the current user. Never uses sudo. Extra arguments go to the program
# (for example --dry-run). COATI_VERSION=v0.1.6 picks a specific release.
set -eu

DOCS=https://github.com/CARL-Bouvet/coati/blob/main/docs/INSTALL.md
REPO=https://github.com/CARL-Bouvet/coati/releases

fail() { echo "coati: $*" >&2; exit 1; }

# Platform
os_raw=$(uname -s)
arch_raw=$(uname -m)
case "$os_raw" in
  Linux) os=linux ;;
  Darwin) os=darwin ;;
  *) fail "unsupported system '$os_raw'. See $DOCS" ;;
esac
case "$arch_raw" in
  x86_64 | amd64) arch=x64 ;;
  aarch64 | arm64) arch=arm64 ;;
  *) fail "unsupported architecture '$arch_raw'. See $DOCS" ;;
esac
asset="coati-broker-$os-$arch"

# Release URL
if [ -n "${COATI_VERSION:-}" ]; then
  base="$REPO/download/$COATI_VERSION"
else
  base="$REPO/latest/download"
fi

# Download tool
if command -v curl >/dev/null 2>&1; then
  fetch() { curl -fsSL -o "$2" "$1"; }
elif command -v wget >/dev/null 2>&1; then
  fetch() { wget -q -O "$2" "$1"; }
else
  fail "curl or wget is required"
fi

# Checksum tool
if command -v sha256sum >/dev/null 2>&1; then
  sha256() { sha256sum "$1" | cut -d ' ' -f 1; }
elif command -v shasum >/dev/null 2>&1; then
  sha256() { shasum -a 256 "$1" | cut -d ' ' -f 1; }
else
  fail "sha256sum or shasum is required"
fi

tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT

echo "Downloading $asset..."
fetch "$base/$asset" "$tmp/$asset" || fail "download failed: $base/$asset"
fetch "$base/SHA256SUMS" "$tmp/SHA256SUMS" || fail "download failed: $base/SHA256SUMS"

# Verify: the expected hash is the line of SHA256SUMS naming this asset
expected=$(awk -v f="$asset" '$2 == f || $2 == "*" f { print $1; exit }' "$tmp/SHA256SUMS")
[ -n "$expected" ] || fail "no checksum for $asset in SHA256SUMS; nothing installed"
actual=$(sha256 "$tmp/$asset")
[ "$expected" = "$actual" ] || fail "checksum mismatch for $asset; nothing installed"

chmod +x "$tmp/$asset"
"$tmp/$asset" --install "$@"

echo "Done. Go back to your browser: the Coati tab will detect the program."
