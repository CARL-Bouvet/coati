#!/usr/bin/env bash
# Builds standalone coati-broker executables with `bun build --compile` —
# goal G4 ("binaries + Windows CI"). One self-contained binary per OS/arch,
# no bun/node install required to run it. Everything the broker reads at
# runtime (see broker/src for readFileSync/import.meta.* call sites) is
# either a real filesystem path under the user's home directory (config,
# data, pairing secret — never bundled) or plain source code pulled in by
# the bundler itself (docs/pair.ts's HTML is a template literal, not a
# separate file) — so nothing needs `--asset` here today. If a future
# change adds a file read relative to the source tree (`import.meta.dir`,
# a JSON fixture, etc.), embed it explicitly and note it here.
#
#   ./scripts/build-binaries.sh                 # all 5 targets
#   ./scripts/build-binaries.sh linux-x64       # just one
#
# Produces:
#   dist/bin/coati-broker-linux-x64
#   dist/bin/coati-broker-linux-arm64
#   dist/bin/coati-broker-darwin-arm64
#   dist/bin/coati-broker-darwin-x64
#   dist/bin/coati-broker-windows-x64.exe
#
# Cross-compiling to a target other than the host downloads that target's
# bun runtime once (cached under ~/.bun) — needs network the first time.

set -euo pipefail
cd "$(dirname "$0")/.."

ENTRY="broker/src/server.ts"
OUT="dist/bin"
mkdir -p "$OUT"

# Known targets; the bun --target value is "bun-<name>". No associative
# array: macOS runners ship bash 3.2, which has none.
KNOWN="linux-x64 linux-arm64 darwin-arm64 darwin-x64 windows-x64"

names=("$@")
if [ "${#names[@]}" -eq 0 ]; then
  # shellcheck disable=SC2206
  names=($KNOWN)
fi

for name in "${names[@]}"; do
  case " $KNOWN " in
    *" $name "*) target="bun-$name" ;;
    *)
      echo "build-binaries.sh: unknown target '$name' (known: $KNOWN)" >&2
      exit 1
      ;;
  esac
  outfile="$OUT/coati-broker-$name"
  if [[ "$name" == windows-* ]]; then
    outfile="$outfile.exe"
  fi
  echo "building $name -> $outfile"
  bun build --compile --target="$target" --outfile "$outfile" "$ENTRY"
done
