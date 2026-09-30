#!/usr/bin/env bash
# Reverses scripts/install/install-linux.sh: removes exactly what it wrote
# (binary, systemd user unit, Native Messaging manifests) and nothing else —
# a NativeMessagingHosts/ dir shared with another host is left in place.
#
#   scripts/install/uninstall-linux.sh [--prefix DIR] [--no-service] [--dry-run]
set -euo pipefail

if [ "$(id -u)" -eq 0 ]; then
  echo "Erreur : ce script ne doit pas être lancé en root (et n'appelle jamais sudo)." >&2
  exit 1
fi

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

UNIT_DEST="$PREFIX/.config/systemd/user/coati-broker.service"

if [ "$NO_SERVICE" = "1" ]; then
  say "$DRY_RUN" "service systemd ignoré (--no-service)"
  remove_file "$DRY_RUN" "$UNIT_DEST"
else
  if [ "$DRY_RUN" = "1" ]; then
    echo "[dry-run] systemctl --user disable --now coati-broker"
  elif systemctl --user is-enabled coati-broker >/dev/null 2>&1 || systemctl --user is-active coati-broker >/dev/null 2>&1; then
    systemctl --user disable --now coati-broker || true
  fi
  remove_file "$DRY_RUN" "$UNIT_DEST"
  if [ "$DRY_RUN" != "1" ]; then
    systemctl --user daemon-reload || true
  fi
fi

remove_file "$DRY_RUN" "$PREFIX/.local/bin/coati-broker"

uninstall_manifests linux "$PREFIX" "$DRY_RUN"

echo
echo "Désinstallation terminée."
