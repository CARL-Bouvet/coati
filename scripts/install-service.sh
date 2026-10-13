#!/usr/bin/env bash
# Installs the coati-broker systemd user service.
# Idempotent — safe to rerun any number of times: the unit is ALWAYS rewritten
# from the repo (no "skip if already present"), the systemd daemon is ALWAYS
# reloaded, then the script reports what changed. This prevents the
# incident (installed unit silently drifting from the repo) from recurring via
# a forgotten `git pull`.
#
# Never calls sudo, never calls `loginctl enable-linger` — both remain human
# decisions, shown at the end of the script.
set -euo pipefail

# Root check
if [ "$(id -u)" -eq 0 ]; then
  echo "Error: this script must not be run as root (and never calls sudo)." >&2
  exit 1
fi

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
UNIT_SRC="$PROJECT_ROOT/packaging/coati-broker.service"
SYSTEMD_DIR="$HOME/.config/systemd/user"
UNIT_DEST="$SYSTEMD_DIR/coati-broker.service"
PORT=8787

# Pre-flight checks
if [ ! -f "$UNIT_SRC" ]; then
  echo "Error: unit file not found: $UNIT_SRC" >&2
  exit 1
fi

# Create the systemd user directory if needed
if [ ! -d "$SYSTEMD_DIR" ]; then
  mkdir -p "$SYSTEMD_DIR"
  echo "Directory created: $SYSTEMD_DIR"
fi

# The versioned unit is a template (@@PROJECT_ROOT@@, @@BUN_BIN@@): no personal
# paths are committed; each machine substitutes its own here.
BUN_BIN="$(command -v bun || true)"
if [ -z "$BUN_BIN" ]; then
  echo "Error: bun not found in PATH." >&2
  exit 1
fi

RENDERED="$(mktemp)"
trap 'rm -f "$RENDERED"' EXIT
sed -e "s#@@PROJECT_ROOT@@#$PROJECT_ROOT#g" \
    -e "s#@@BUN_BIN@@#$BUN_BIN#g" \
    "$UNIT_SRC" > "$RENDERED"

# Always rewrite the unit, even if identical — this is what makes the script
# strongly idempotent: no divergence between the installed unit and
# packaging/coati-broker.service (once the template is substituted) can
# survive a second run. We compare before copying only for the report below.
UNIT_WAS_PRESENT=0
UNIT_CHANGED=1
if [ -f "$UNIT_DEST" ]; then
  UNIT_WAS_PRESENT=1
  if cmp -s "$RENDERED" "$UNIT_DEST"; then
    UNIT_CHANGED=0
  fi
fi
cp "$RENDERED" "$UNIT_DEST"

# Always reload the user daemon, even if the content hasn't changed: a
# daemon-reload is side-effect-free and cheaper than a missed reload leaving
# systemd working from a stale definition.
systemctl --user daemon-reload

echo
echo "=== Report ==="
if [ "$UNIT_WAS_PRESENT" -eq 0 ]; then
  echo "Unit installed for the first time: $UNIT_DEST"
elif [ "$UNIT_CHANGED" -eq 1 ]; then
  echo "Unit updated: $UNIT_DEST changed (recopied from $UNIT_SRC)."
else
  echo "Unit already up to date: $UNIT_DEST was identical to $UNIT_SRC."
fi
echo "daemon-reload done."

# Enable on session start — natively idempotent (systemctl does not complain
# if already enabled), but we distinguish the two cases in the report.
if systemctl --user is-enabled coati-broker >/dev/null 2>&1; then
  echo "Service already enabled (auto-start on session open)."
else
  systemctl --user enable coati-broker
  echo "Service enabled (auto-start on session open)."
fi

# Start (or restart if already active) — always uses the definition we just
# recopied and reloaded, never an in-memory version.
systemctl --user restart coati-broker
echo "Service (re)started."

# Check: is the broker responding on 127.0.0.1:$PORT?
echo "Checking broker on 127.0.0.1:$PORT..."
MAX=10
i=0
while [ $i -lt $MAX ]; do
  # /pair only answers a top-level navigation
  # (docs/PROTOCOL.md): without these two headers it returns 403 and this check
  # would report a healthy broker as dead.
  if curl -sf --max-time 2 -H 'Sec-Fetch-Mode: navigate' -H 'Sec-Fetch-Dest: document' \
       "http://127.0.0.1:$PORT/pair" -o /dev/null 2>/dev/null; then
    echo "Broker running on http://127.0.0.1:$PORT/pair ✓"
    break
  fi
  sleep 1
  i=$((i + 1))
done

if [ $i -eq $MAX ]; then
  echo "Warning: broker not responding after ${MAX}s. Check logs:"
  echo "  journalctl --user -u coati-broker -n 30"
  exit 1
fi

echo
echo "For the service to start even without an open graphical session (e.g. after a"
echo "reboot without login), enable systemd linger for your account —"
echo "this script does not do it (shared system setting, human decision):"
echo "  loginctl enable-linger $USER"
echo
echo "Installation complete. Useful commands:"
echo "  systemctl --user status coati-broker"
echo "  journalctl --user -u coati-broker -f"
echo "  systemctl --user stop coati-broker"
echo "  systemctl --user disable coati-broker && rm $UNIT_DEST"
