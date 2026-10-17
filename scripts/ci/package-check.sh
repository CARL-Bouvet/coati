#!/usr/bin/env bash
# Runs INSIDE a container (debian:stable or fedora:latest) with dist/pkg
# mounted at /pkg: installs the Linux package, checks what `--install --system`
# wrote, removes the package, checks nothing is left. systemd is not running
# in a container, so the postinstall script must cope with that.
#   usage: package-check.sh deb|rpm
set -euo pipefail

kind="${1:?usage: package-check.sh deb|rpm}"
BIN=/usr/bin/coati-broker
MANIFEST_DIRS="/etc/opt/chrome /etc/chromium /etc/opt/edge /usr/lib/mozilla /usr/lib64/mozilla"
UNIT=/usr/lib/systemd/user/coati-broker.service

cd "$(mktemp -d)"
case "$kind" in
  deb) cp /pkg/coati_amd64.deb . && apt-get update -qq && apt-get install -y -qq ./coati_amd64.deb ;;
  rpm) cp /pkg/coati-x86_64.rpm . && dnf install -y -q ./coati-x86_64.rpm ;;
  *) echo "unknown package kind '$kind'" >&2; exit 2 ;;
esac

test -x "$BIN"
test -f "$UNIT"
grep -qF "ExecStart=\"$BIN\" --serve" "$UNIT"
for d in $MANIFEST_DIRS; do
  f="$d/native-messaging-hosts/com.getcoati.broker.json"
  test -f "$f" || { echo "missing $f" >&2; exit 1; }
  grep -qF "\"path\": \"$BIN\"" "$f" || { echo "$f does not point to $BIN" >&2; exit 1; }
done
echo "PASS installed: binary, unit and system manifests"

case "$kind" in
  deb) apt-get remove -y -qq coati ;;
  rpm) dnf remove -y -q coati ;;
esac

left="$(find /usr /etc -iname '*coati*' 2>/dev/null || true)"
if [ -n "$left" ]; then
  echo "left behind after removal:" >&2
  echo "$left" >&2
  exit 1
fi
echo "PASS removed: nothing left"
