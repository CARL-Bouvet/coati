#!/usr/bin/env bash
# Installs the Native Messaging host for a source checkout of Coati — no
# compiled binary needed, unlike scripts/install/install-*.sh. Writes a tiny
# launcher script that runs the broker from source in host mode ("Lanceur"
# in docs/PROTOCOL.md, "Amendement 2026-09-30 : Native Messaging"), then
# registers it for Brave (default) — the browser used during development —
# or every existing Chromium-family / Firefox dir with --all.
#
#   scripts/dev-native-host.sh              # Brave only
#   scripts/dev-native-host.sh --all         # every existing browser dir
#   scripts/dev-native-host.sh --uninstall   # removes launcher + manifests
#
# Never touches the systemd unit (scripts/install-service.sh's job).
set -euo pipefail

if [ "$(id -u)" -eq 0 ]; then
  echo "Erreur : ce script ne doit pas être lancé en root (et n'appelle jamais sudo)." >&2
  exit 1
fi

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
# shellcheck source=./install/lib.sh
. "$PROJECT_ROOT/scripts/install/lib.sh"

ALL=0
UNINSTALL=0
DRY_RUN=0

for arg in "$@"; do
  case "$arg" in
    --all) ALL=1 ;;
    --uninstall) UNINSTALL=1 ;;
    --dry-run) DRY_RUN=1 ;;
    *)
      echo "Option inconnue : $arg" >&2
      exit 1
      ;;
  esac
done

DEV_DIR="$HOME/.local/share/coati/dev-native-host"
LAUNCHER="$DEV_DIR/coati-native-host.sh"

if [ "$UNINSTALL" = "1" ]; then
  remove_file "$DRY_RUN" "$LAUNCHER"
  uninstall_manifests linux "$HOME" "$DRY_RUN"
  echo "Désinstallation de l'hôte natif de développement terminée."
  exit 0
fi

BUN_BIN="$(command -v bun || true)"
if [ -z "$BUN_BIN" ]; then
  echo "Erreur : bun introuvable dans le PATH." >&2
  exit 1
fi

ensure_dir "$DRY_RUN" "$DEV_DIR" 0700

# %q-quotes both paths (final security review): unquoted, a PROJECT_ROOT or
# bun path containing a space/glob/shell-special char would either break the
# launcher or let it be reinterpreted by the shell that execs it. %q's
# backslash-escaping output is plain POSIX sh, matching the launcher's own
# #!/bin/sh shebang.
LAUNCHER_CONTENT="#!/bin/sh
$(printf 'exec %q %q --native-host "$@"\n' "$BUN_BIN" "$PROJECT_ROOT/broker/src/server.ts")
"
write_file "$DRY_RUN" "$LAUNCHER" "$LAUNCHER_CONTENT" 0700
say "$DRY_RUN" "lanceur écrit : $LAUNCHER"

if [ "$ALL" = "1" ]; then
  # Every existing Chromium-family / Firefox dir, same as the distributed
  # installer's --all.
  install_manifests linux "$HOME" 1 "$DRY_RUN" "$LAUNCHER"
else
  # Brave only, forced regardless of whether its config dir already exists —
  # this is the browser used during development, always registered.
  BRAVE_NMH_DIR="$HOME/.config/BraveSoftware/Brave-Browser/NativeMessagingHosts"
  ensure_dir "$DRY_RUN" "$BRAVE_NMH_DIR" 0700
  write_file "$DRY_RUN" "$BRAVE_NMH_DIR/$HOST_NAME.json" "$(render_manifest chromium "$LAUNCHER")" 0644
  say "$DRY_RUN" "manifeste écrit pour Brave : $BRAVE_NMH_DIR/$HOST_NAME.json"
fi

echo
echo "Installation de l'hôte natif de développement terminée."
if [ "$ALL" != "1" ]; then
  echo "Seul Brave a été enregistré. --all pour tous les navigateurs présents."
fi
