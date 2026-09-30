#!/usr/bin/env bash
# Installs a downloaded coati-broker binary as both the systemd user service
# and the Native Messaging host (goal G4, docs/PROTOCOL.md "Amendement
# 2026-09-30 : Native Messaging"). Idempotent: rerunning overwrites the same
# files with the same content, never duplicates anything.
#
#   scripts/install/install-linux.sh <path-to-coati-broker-binary> [options]
#
# Options:
#   --prefix DIR    Use DIR instead of $HOME as the install root (tests, CI).
#   --no-service    Skip the systemd user unit entirely (just the binary +
#                   Native Messaging manifests). Useful in CI / containers
#                   without a systemd user session.
#   --all           Write Native Messaging manifests for every browser in
#                   the table, even if its config dir doesn't exist yet.
#                   Default: only browsers whose config dir already exists.
#   --dry-run       Print what would be written/run, write/run nothing.
#
# Never requires sudo. Never depends on the host mode actually running:
# the binary only needs to exist at the destination path for the browser
# to be able to invoke it later.
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
ALL=0
DRY_RUN=0
BINARY=""

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
    --all)
      ALL=1
      shift
      ;;
    --dry-run)
      DRY_RUN=1
      shift
      ;;
    -*)
      echo "Option inconnue : $1" >&2
      exit 1
      ;;
    *)
      if [ -n "$BINARY" ]; then
        echo "Un seul chemin de binaire attendu (déjà : $BINARY)" >&2
        exit 1
      fi
      BINARY="$1"
      shift
      ;;
  esac
done

if [ -z "$BINARY" ]; then
  echo "Usage: $0 <path-to-coati-broker-binary> [--prefix DIR] [--no-service] [--all] [--dry-run]" >&2
  exit 1
fi
if [ ! -f "$BINARY" ]; then
  echo "Erreur : binaire introuvable : $BINARY" >&2
  exit 1
fi

BIN_DIR="$PREFIX/.local/bin"
BIN_DEST="$BIN_DIR/coati-broker"

ensure_dir "$DRY_RUN" "$BIN_DIR" 0755
if [ "$DRY_RUN" = "1" ]; then
  echo "[dry-run] install -m 0755 $BINARY $BIN_DEST"
else
  cp "$BINARY" "$BIN_DEST"
  chmod 0755 "$BIN_DEST"
  echo "Binaire installé : $BIN_DEST"
fi

if [ "$NO_SERVICE" = "1" ]; then
  say "$DRY_RUN" "service systemd ignoré (--no-service)"
else
  UNIT_SRC="$REPO_ROOT/packaging/coati-broker-binary.service"
  SYSTEMD_DIR="$PREFIX/.config/systemd/user"
  UNIT_DEST="$SYSTEMD_DIR/coati-broker.service"
  ensure_dir "$DRY_RUN" "$SYSTEMD_DIR" 0755
  RENDERED="$(replace_literal @@BINARY_PATH@@ "$(systemd_escape "$BIN_DEST")" < "$UNIT_SRC")"
  write_file "$DRY_RUN" "$UNIT_DEST" "$RENDERED" 0644
  say "$DRY_RUN" "unité systemd écrite : $UNIT_DEST"

  if [ "$DRY_RUN" = "1" ]; then
    echo "[dry-run] systemctl --user daemon-reload"
    echo "[dry-run] systemctl --user enable --now coati-broker"
  else
    # systemctl always targets the real user session (XDG dirs), regardless
    # of --prefix — a fake --prefix only redirects file paths, never a real
    # systemd session. Use --no-service under --prefix (tests, CI).
    systemctl --user daemon-reload
    systemctl --user enable --now coati-broker
    echo "Service systemd activé et démarré."
  fi
fi

install_manifests linux "$PREFIX" "$ALL" "$DRY_RUN" "$BIN_DEST"

echo
echo "Installation terminée."
if [ "$NO_SERVICE" = "1" ]; then
  echo "Service systemd non installé (--no-service) : lancer le broker manuellement,"
  echo "ou relancer sans --no-service."
fi
