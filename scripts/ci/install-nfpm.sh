#!/usr/bin/env bash
# Installs the pinned nfpm (used by scripts/package.sh) into $1 (default:
# $RUNNER_TEMP/nfpm-bin) and puts it on the PATH of the following CI steps.
# Linux x86_64 runners only. The sha256 is the digest GitHub shows for that
# release asset (releases API, `digest` field); bump both lines together.
set -euo pipefail

VERSION="2.48.0"
SHA256="6d7f9a28b2f397934403950fcbba83f598b08d02edbe79a0815b3b4897341750"

dest="${1:-${RUNNER_TEMP:-/tmp}/nfpm-bin}"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

tarball="nfpm_${VERSION}_Linux_x86_64.tar.gz"
curl -fsSL -o "$work/$tarball" "https://github.com/goreleaser/nfpm/releases/download/v${VERSION}/${tarball}"
echo "$SHA256  $work/$tarball" | sha256sum -c -

mkdir -p "$dest"
tar -xzf "$work/$tarball" -C "$dest" nfpm
[ -z "${GITHUB_PATH:-}" ] || echo "$dest" >> "$GITHUB_PATH"
"$dest/nfpm" --version
