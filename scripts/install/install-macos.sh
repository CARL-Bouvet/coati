#!/usr/bin/env bash
# Installs a downloaded coati-broker binary as both the launchd user agent
# and the Native Messaging host on macOS (goal G4, docs/PROTOCOL.md
# "Amendement 2026-09-30 : Native Messaging" — sections "macOS" et
# "Emplacements des manifestes"). Idempotent. Never requires sudo/admin.
#
#   scripts/install/install-macos.sh <path-to-coati-broker-binary> [options]
#
# Options:
#   --prefix DIR    Use DIR instead of $HOME as the install root (tests, CI).
#   --no-service    Skip the launchd user agent entirely (just the binary +
#                   Native Messaging manifests).
#   --all           Write Native Messaging manifests for every browser in
#                   the table, even if its config dir doesn't exist yet.
#   --dry-run       Print what would be written/run, write/run nothing.
#
# Not verified on real hardware (no macOS available in this environment) —
# logic follows the spec; `codesign`/`xattr`/`launchctl` calls are best-effort
# (skipped with a warning if the tool is missing, e.g. under --prefix tests
# run from Linux).
set -euo pipefail

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

APP_DIR="$PREFIX/Library/Application Support/Coati"
BIN_DEST="$APP_DIR/coati-broker"

ensure_dir "$DRY_RUN" "$APP_DIR" 0755
if [ "$DRY_RUN" = "1" ]; then
  echo "[dry-run] install -m 0755 $BINARY $BIN_DEST"
else
  cp "$BINARY" "$BIN_DEST"
  chmod 0755 "$BIN_DEST"
  echo "Binaire installé : $BIN_DEST"
fi

# Gatekeeper: retirer la marque "téléchargé depuis Internet" et poser une
# signature ad hoc si l'outil est disponible. Best-effort : ni l'un ni
# l'autre n'est disponible en dehors de macOS (tests --prefix sous Linux).
if [ "$DRY_RUN" = "1" ]; then
  echo "[dry-run] xattr -d com.apple.quarantine $BIN_DEST"
  echo "[dry-run] codesign -s - $BIN_DEST"
else
  if command -v xattr >/dev/null 2>&1; then
    xattr -d com.apple.quarantine "$BIN_DEST" 2>/dev/null || true
  fi
  if command -v codesign >/dev/null 2>&1; then
    codesign -s - "$BIN_DEST" 2>/dev/null || true
  fi
fi

if [ "$NO_SERVICE" = "1" ]; then
  say "$DRY_RUN" "agent launchd ignoré (--no-service)"
else
  PLIST_SRC="$REPO_ROOT/packaging/com.getcoati.broker.plist"
  LAUNCH_AGENTS_DIR="$PREFIX/Library/LaunchAgents"
  PLIST_DEST="$LAUNCH_AGENTS_DIR/com.getcoati.broker.plist"
  LOG_DIR="$PREFIX/Library/Logs/Coati"
  ensure_dir "$DRY_RUN" "$LAUNCH_AGENTS_DIR" 0755
  ensure_dir "$DRY_RUN" "$LOG_DIR" 0755
  # XML-escape the paths (they land inside plist <string> elements); the
  # substitution itself is literal (lib.sh replace_literal).
  RENDERED="$(replace_literal @@BINARY_PATH@@ "$(xml_escape "$BIN_DEST")" < "$PLIST_SRC" \
    | replace_literal @@LOG_DIR@@ "$(xml_escape "$LOG_DIR")")"
  write_file "$DRY_RUN" "$PLIST_DEST" "$RENDERED" 0644
  say "$DRY_RUN" "agent launchd écrit : $PLIST_DEST"

  if [ "$DRY_RUN" = "1" ]; then
    echo "[dry-run] launchctl bootstrap gui/\$UID $PLIST_DEST"
  elif command -v launchctl >/dev/null 2>&1; then
    launchctl bootout "gui/$(id -u)" "$PLIST_DEST" >/dev/null 2>&1 || true
    launchctl bootstrap "gui/$(id -u)" "$PLIST_DEST"
    echo "Agent launchd chargé."
  else
    echo "launchctl introuvable (hors macOS) : agent écrit mais pas chargé."
  fi
fi

install_manifests macos "$PREFIX" "$ALL" "$DRY_RUN" "$BIN_DEST"

echo
echo "Installation terminée."
