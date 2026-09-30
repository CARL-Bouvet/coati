#!/usr/bin/env bash
# Shared helpers for scripts/install/install-linux.sh, uninstall-linux.sh,
# install-macos.sh and uninstall-macos.sh — goal G4, Native Messaging
# installers (docs/PROTOCOL.md, "Amendement 2026-09-30 : Native Messaging").
#
# Not meant to be run directly: `. "$(dirname "$0")/lib.sh"` from a caller
# that has already set REPO_ROOT-independent behaviour (this file resolves
# its own location so it works from any working directory).

LIB_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$LIB_DIR/../.." && pwd)"

HOST_NAME="com.getcoati.broker"
CHROMIUM_TEMPLATE="$REPO_ROOT/packaging/native-host/com.getcoati.broker.chromium.json"
FIREFOX_TEMPLATE="$REPO_ROOT/packaging/native-host/com.getcoati.broker.firefox.json"

# render_manifest <family> <host_path>
# family: "chromium" or "firefox". Prints the manifest JSON on stdout.
render_manifest() {
  local family="$1" host_path="$2" template content escaped
  if [ "$family" = "firefox" ]; then
    template="$FIREFOX_TEMPLATE"
  else
    template="$CHROMIUM_TEMPLATE"
  fi
  content="$(cat "$template")"
  # JSON-escape backslashes and double quotes in host_path (final security
  # review): the template's placeholder sits inside a JSON string
  # (`"path": "@@HOST_PATH@@"`), so an unescaped `\` or `"` in a custom
  # --prefix could break out of that string and inject arbitrary JSON.
  escaped="${host_path//\\/\\\\}"
  escaped="${escaped//\"/\\\"}"
  # The replacement is quoted ("$escaped", not $escaped): bash >=5.2's
  # patsub_replacement shell option treats an unquoted `&` in the replacement
  # of ${var//pat/repl} like sed does (re-inserts the matched text) — a
  # host_path containing `&` would otherwise silently turn back into the
  # literal placeholder instead of the path.
  printf '%s\n' "${content//@@HOST_PATH@@/"$escaped"}"
}

# sed_escape_replacement <text>
# Escapes <text> for safe use as the replacement half of `sed "s#pat#<text>#g"`
# (final security review — install-linux.sh/install-macos.sh, systemd unit
# and launchd plist rendering): a raw `&` means "the whole match" to sed, a
# raw `\` starts an escape sequence, and a raw `#` — our chosen delimiter —
# would prematurely close/reopen the substitution. Order matters: backslash
# first, or the backslashes this function inserts for `&`/`#` would
# themselves get re-escaped.
sed_escape_replacement() {
  local s="$1"
  s="${s//\\/\\\\}"
  s="${s//&/\\&}"
  s="${s//#/\\#}"
  printf '%s' "$s"
}

# xml_escape <text>
# Escapes &, <, >, " for safe use inside XML/plist text or attribute content
# (final security review — install-macos.sh's launchd plist rendering: the
# binary/log paths are spliced into <string> elements). & first, so the
# ampersands this function inserts for </>/" don't get re-escaped.
xml_escape() {
  local s="$1"
  s="${s//&/&amp;}"
  s="${s//</&lt;}"
  s="${s//>/&gt;}"
  s="${s//\"/&quot;}"
  printf '%s' "$s"
}

# say <dry_run> <message>
say() {
  if [ "$1" = "1" ]; then
    echo "[dry-run] $2"
  else
    echo "$2"
  fi
}

# ensure_dir <dry_run> <dir> [mode]
ensure_dir() {
  local dry="$1" dir="$2" mode="${3:-0700}"
  if [ -d "$dir" ]; then
    return 0
  fi
  if [ "$dry" = "1" ]; then
    echo "[dry-run] mkdir -p -m $mode $dir"
    return 0
  fi
  mkdir -p -m "$mode" "$dir"
}

# write_file <dry_run> <path> <content> [mode]
write_file() {
  local dry="$1" path="$2" content="$3" mode="${4:-0644}"
  if [ "$dry" = "1" ]; then
    echo "[dry-run] write $path (mode $mode)"
    return 0
  fi
  local tmp
  tmp="$(mktemp "${path}.XXXXXX")"
  printf '%s' "$content" > "$tmp"
  chmod "$mode" "$tmp"
  mv "$tmp" "$path"
}

# remove_file <dry_run> <path>
remove_file() {
  local dry="$1" path="$2"
  if [ ! -e "$path" ]; then
    return 0
  fi
  if [ "$dry" = "1" ]; then
    echo "[dry-run] rm $path"
    return 0
  fi
  rm -f "$path"
  echo "Removed: $path"
}

# browser_table <os>
# Prints one line per browser: name|family|config_subdir|nmh_subdir
# (subdirs are relative to the prefix/home root).
browser_table() {
  case "$1" in
    linux)
      cat <<'EOF'
chrome|chromium|.config/google-chrome|.config/google-chrome/NativeMessagingHosts
chromium|chromium|.config/chromium|.config/chromium/NativeMessagingHosts
brave|chromium|.config/BraveSoftware/Brave-Browser|.config/BraveSoftware/Brave-Browser/NativeMessagingHosts
edge|chromium|.config/microsoft-edge|.config/microsoft-edge/NativeMessagingHosts
firefox|firefox|.mozilla|.mozilla/native-messaging-hosts
EOF
      ;;
    macos)
      cat <<'EOF'
chrome|chromium|Library/Application Support/Google/Chrome|Library/Application Support/Google/Chrome/NativeMessagingHosts
chromium|chromium|Library/Application Support/Chromium|Library/Application Support/Chromium/NativeMessagingHosts
brave|chromium|Library/Application Support/BraveSoftware/Brave-Browser|Library/Application Support/BraveSoftware/Brave-Browser/NativeMessagingHosts
edge|chromium|Library/Application Support/Microsoft Edge|Library/Application Support/Microsoft Edge/NativeMessagingHosts
firefox|firefox|Library/Application Support/Mozilla|Library/Application Support/Mozilla/NativeMessagingHosts
EOF
      ;;
    *)
      echo "browser_table: unknown os '$1'" >&2
      return 1
      ;;
  esac
}

# install_manifests <os> <prefix> <all> <dry_run> <host_path>
# Writes one manifest per browser whose config dir already exists under
# <prefix> (or all of them when <all>=1). Never touches a browser's own
# config dir, only creates NativeMessagingHosts/ under it.
install_manifests() {
  local os="$1" prefix="$2" all="$3" dry="$4" host_path="$5"
  local line name family config_subdir nmh_subdir config_dir nmh_dir family_label
  while IFS='|' read -r name family config_subdir nmh_subdir; do
    [ -z "$name" ] && continue
    config_dir="$prefix/$config_subdir"
    nmh_dir="$prefix/$nmh_subdir"
    if [ "$all" != "1" ] && [ ! -d "$config_dir" ]; then
      say "$dry" "skipped $name: $config_dir absent (use --all to force)"
      continue
    fi
    ensure_dir "$dry" "$nmh_dir" 0700
    write_file "$dry" "$nmh_dir/$HOST_NAME.json" "$(render_manifest "$family" "$host_path")" 0644
    say "$dry" "manifest written for $name: $nmh_dir/$HOST_NAME.json"
  done < <(browser_table "$os")
}

# uninstall_manifests <os> <prefix> <dry_run>
# Removes exactly the manifest files an installer of this lib would have
# written, wherever they exist. Never removes the NativeMessagingHosts/
# directory itself (other native hosts may live there).
uninstall_manifests() {
  local os="$1" prefix="$2" dry="$3"
  local name family config_subdir nmh_subdir nmh_dir
  while IFS='|' read -r name family config_subdir nmh_subdir; do
    [ -z "$name" ] && continue
    nmh_dir="$prefix/$nmh_subdir"
    remove_file "$dry" "$nmh_dir/$HOST_NAME.json"
  done < <(browser_table "$os")
}
