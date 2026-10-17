#!/usr/bin/env bash
# Turns the binaries of scripts/build-binaries.sh (dist/bin) into the files
# users download (dist/pkg). Names carry no version, so that
# releases/latest/download/<file> is a stable link.
#
#   ./scripts/package.sh                  # every target below
#   ./scripts/package.sh linux-x64 darwin-arm64
#   ./scripts/package.sh --no-linux       # windows + macOS only (no nfpm needed)
#
# Per target (the names build-binaries.sh uses):
#   windows-x64   Coati-Setup-windows-x64.exe
#   darwin-arm64  Coati-Setup-macos-arm64.zip   (one executable: "Installer Coati")
#   darwin-x64    Coati-Setup-macos-x64.zip
#   linux-x64     coati_amd64.deb, coati-x86_64.rpm
#   linux-arm64   coati_arm64.deb, coati-aarch64.rpm
#
# The Linux packages need nfpm (https://nfpm.goreleaser.com) on the PATH.
# VERSION (default: broker/package.json) is the package version.

set -euo pipefail
cd "$(dirname "$0")/.."

IN="dist/bin"
OUT="dist/pkg"
KNOWN="windows-x64 darwin-arm64 darwin-x64 linux-x64 linux-arm64"

targets=()
for arg in "$@"; do
  case "$arg" in
    --no-linux) targets+=(windows-x64 darwin-arm64 darwin-x64) ;;
    *)
      case " $KNOWN " in
        *" $arg "*) targets+=("$arg") ;;
        *) echo "package.sh: unknown target '$arg' (known: $KNOWN, --no-linux)" >&2; exit 1 ;;
      esac
      ;;
  esac
done
# shellcheck disable=SC2206
[ "${#targets[@]}" -gt 0 ] || targets=($KNOWN)

for t in "${targets[@]}"; do
  src="$IN/coati-broker-$t"
  [ "$t" = windows-x64 ] && src="$src.exe"
  [ -f "$src" ] || { echo "package.sh: $src is missing (run scripts/build-binaries.sh $t)" >&2; exit 1; }
  case "$t" in
    linux-*)
      command -v nfpm >/dev/null || { echo "package.sh: nfpm is not installed (https://nfpm.goreleaser.com/install/); use --no-linux to skip the Linux packages" >&2; exit 1; }
      ;;
    darwin-*)
      command -v zip >/dev/null || { echo "package.sh: zip is not installed (it keeps the executable bit; other archivers may not)" >&2; exit 1; }
      ;;
  esac
done

VERSION="${VERSION:-$(sed -n 's/^  "version": "\(.*\)",$/\1/p' broker/package.json)}"
[ -n "$VERSION" ] || { echo "package.sh: cannot work out the version (set VERSION)" >&2; exit 1; }

mkdir -p "$OUT"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

for t in "${targets[@]}"; do
  src="$IN/coati-broker-$t"
  case "$t" in
    windows-x64)
      cp "$src.exe" "$OUT/Coati-Setup-windows-x64.exe"
      ;;
    darwin-*)
      arch="${t#darwin-}"
      zipfile="$PWD/$OUT/Coati-Setup-macos-$arch.zip"
      mkdir "$work/$t"
      cp "$src" "$work/$t/Installer Coati"
      chmod 755 "$work/$t/Installer Coati"
      rm -f "$zipfile"
      (cd "$work/$t" && zip -q -X "$zipfile" "Installer Coati")
      ;;
    linux-*)
      case "$t" in
        linux-x64) arch=amd64; rpmname=coati-x86_64.rpm ;;
        linux-arm64) arch=arm64; rpmname=coati-aarch64.rpm ;;
      esac
      export VERSION NFPM_ARCH="$arch" COATI_BIN="$src"
      nfpm package -f packaging/nfpm.yaml -p deb -t "$OUT/coati_$arch.deb"
      nfpm package -f packaging/nfpm.yaml -p rpm -t "$OUT/$rpmname"
      ;;
  esac
done

ls -l "$OUT"
