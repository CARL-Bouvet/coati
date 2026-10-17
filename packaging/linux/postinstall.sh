#!/bin/sh
# After the package files are in place: write the system manifests and the
# user unit, then (re)start the service in the sessions that are open.
# Never fails the package transaction: a machine without systemd or without a
# signed-in user is normal (containers, servers).
/usr/bin/coati-broker --install --system ||
  echo "coati: could not finish the setup; run '/usr/bin/coati-broker --install --system' as root" >&2

if [ -d /run/systemd/system ] && command -v systemctl >/dev/null 2>&1; then
  for dir in /run/user/*; do
    uid="${dir##*/}"
    case "$uid" in '' | 0 | *[!0-9]*) continue ;; esac
    user="$(id -nu "$uid" 2>/dev/null)" || continue
    systemctl --user --machine="$user@.host" daemon-reload >/dev/null 2>&1 || true
    systemctl --user --machine="$user@.host" restart coati-broker >/dev/null 2>&1 || true
  done
fi
exit 0
