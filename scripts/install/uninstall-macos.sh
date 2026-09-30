#!/usr/bin/env bash
# Reverses scripts/install/install-macos.sh. Not verified on real hardware
# (no macOS available in this environment) — logic follows the spec.
#
#   scripts/install/uninstall-macos.sh [--prefix DIR] [--no-service] [--dry-run]
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=./lib.sh
. "$SCRIPT_DIR/lib.sh"

PREFIX="$HOME"
NO_SERVICE=0
DRY_RUN=0

while [ $# -gt 0 ]; do
  case "$1" in
    --prefix)
      PREFIX="$2"
      shift 2
      ;;
    --prefix=*)
      PREFIX="${1#*=}"
      shift
      ;;
    --no-service)
      NO_SERVICE=1
      shift
      ;;
    --dry-run)
      DRY_RUN=1
      shift
      ;;
    *)
      echo "Option inconnue : $1" >&2
      exit 1
      ;;
  esac
done

PLIST_DEST="$PREFIX/Library/LaunchAgents/com.getcoati.broker.plist"

if [ "$NO_SERVICE" = "1" ]; then
  say "$DRY_RUN" "agent launchd ignoré (--no-service)"
  remove_file "$DRY_RUN" "$PLIST_DEST"
else
  if [ "$DRY_RUN" = "1" ]; then
    echo "[dry-run] launchctl bootout gui/\$UID $PLIST_DEST"
  elif command -v launchctl >/dev/null 2>&1; then
    launchctl bootout "gui/$(id -u)" "$PLIST_DEST" >/dev/null 2>&1 || true
  fi
  remove_file "$DRY_RUN" "$PLIST_DEST"
fi

remove_file "$DRY_RUN" "$PREFIX/Library/Application Support/Coati/coati-broker"

uninstall_manifests macos "$PREFIX" "$DRY_RUN"

echo
echo "Désinstallation terminée."
