#!/bin/sh
# Before the package files go: stop the service in open sessions and remove
# what postinstall wrote. Only on a real removal (deb: "remove"; rpm: 0);
# an upgrade keeps everything and postinstall restarts the service.
# Never fails the package transaction.
case "$1" in remove | 0) ;; *) exit 0 ;; esac

can_systemd() { [ -d /run/systemd/system ] && command -v systemctl >/dev/null 2>&1; }

user_sessions() {
  can_systemd || return 0
  for dir in /run/user/*; do
    uid="${dir##*/}"
    case "$uid" in '' | 0 | *[!0-9]*) continue ;; esac
    user="$(id -nu "$uid" 2>/dev/null)" || continue
    systemctl --user --machine="$user@.host" "$@" >/dev/null 2>&1 || true
  done
}

user_sessions stop coati-broker
/usr/bin/coati-broker --uninstall --system ||
  echo "coati: could not remove everything; run '/usr/bin/coati-broker --uninstall --system' as root" >&2
user_sessions daemon-reload
exit 0
