#!/usr/bin/env bash
# "Client journey" end to end, CI only: what a customer does with a download,
# minus the OS warning clicks, on the real HOME / registry of a disposable
# machine. Per OS:
#
#   windows  Coati-Setup-windows-x64.exe with no argument and no terminal; the
#            installer starts the broker itself (Run key + detached --serve)
#   macos    unzip Coati-Setup-macos-arm64.zip, run "Installer Coati" with no
#            argument and no terminal; the LaunchAgent starts the broker
#   linux    inside an ubuntu:24.04 container as root: apt install the .deb,
#            broker started by hand as a normal user (no systemd in a container)
#
# then Playwright's Chromium with the unpacked extension (extension-e2e.mjs in
# attach mode): the panel reaches "connected" through the manifest the package
# wrote, and the fake provider answers; then uninstall and check nothing is left.
#
# Needs dist/pkg (scripts/package.sh) and dist/stage/chrome (scripts/build.sh).
# Refuses to run unless CI=true; the Linux part also refuses outside a container.
#   Windows / macOS: bash scripts/ci/journey.sh
#   Linux: docker run --rm -e CI=true -e GITHUB_ACTIONS -v "$PWD:/repo:ro" \
#            ubuntu:24.04 bash /repo/scripts/ci/journey.sh

set -euo pipefail
export MSYS_NO_PATHCONV=1

[ "${CI:-}" = "true" ] || { echo "journey.sh: refusing to run outside CI (it installs and removes Coati on this machine)" >&2; exit 2; }

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"
PORT=8787
PINNED_ID=hehlgipomfminodhahcjbencblepjhah
LOGDIR="$(mktemp -d)"
STEP="start"
BROKER_PID=""
step() { STEP="$1"; echo "== $1"; }
pass() { echo "PASS $1"; }
fail() { echo "FAIL $1" >&2; exit 1; }
annotate() { echo "::$1 title=client journey ($(uname -s))::$2"; }

on_exit() {
  local code=$?
  [ -n "$BROKER_PID" ] && kill "$BROKER_PID" >/dev/null 2>&1 || true
  [ "$code" -eq 0 ] || [ -z "${GITHUB_ACTIONS:-}" ] && return 0
  # Job logs need a signed-in account; annotations are public.
  local body="failed at step '$STEP' (exit $code)"
  for f in "$LOGDIR"/*.log; do
    [ -f "$f" ] && body="$body"$'\n'"--- $(basename "$f") (tail) ---"$'\n'"$(tail -n 20 "$f")"
  done
  body="${body//%/%25}"; body="${body//$'\r'/}"; body="${body//$'\n'/%0A}"
  echo "::error title=scripts/ci/journey.sh ($(uname -s))::${body:0:6000}"
}
trap on_exit EXIT

port_free() {
  node -e 'require("net").createServer().once("error",()=>process.exit(1)).listen(+process.argv[1],"127.0.0.1",function(){this.close()})' "$PORT"
}

wait_for() { # <seconds> <label> <command...>
  local n=$1 label=$2; shift 2
  while ! "$@" >/dev/null 2>&1; do
    n=$((n - 1)); [ "$n" -gt 0 ] || fail "timeout waiting for $label"
    sleep 1
  done
}

# config.json is read once, when the broker starts: it goes in before the installer runs.
write_config() { # <config dir> <fixture module path as the broker sees it>
  mkdir -p "$1"
  cat > "$1/config.json" <<EOF
{
  "port": $PORT,
  "allowedExtensionIds": ["$PINNED_ID"],
  "provider": "e2e-fixture",
  "modules": [{ "path": "$2", "options": { "id": "e2e-fixture", "label": "E2E Fixture" } }]
}
EOF
}

need() { [ -e "$1" ] || fail "$1 is missing (scripts/package.sh and scripts/build.sh output)"; }

# --- Windows ---------------------------------------------------------------

reg_has() { reg.exe query "$@" >/dev/null 2>&1; }

journey_windows() {
  local win_curr='HKCU\Software\Microsoft\Windows\CurrentVersion'
  local nmh_subs=('Google\Chrome' 'Chromium' 'BraveSoftware\Brave-Browser' 'Microsoft\Edge' 'Mozilla')
  local home; home="$(cygpath -u "$USERPROFILE")"
  local installed_dir; installed_dir="$(cygpath -u "$LOCALAPPDATA")/Coati"
  local installed="$installed_dir/coati-broker.exe"
  need dist/pkg/Coati-Setup-windows-x64.exe; need dist/stage/chrome
  port_free || fail "port $PORT is already in use"

  step "config.json for the fake provider"
  write_config "$home/.config/coati" "$(cygpath -m "$ROOT")/broker/test/fixtures/modules/valid-provider.ts"

  step "run the downloaded installer: no argument, no terminal"
  local dl="$home/Downloads/coati-journey"
  rm -rf "$dl"; mkdir -p "$dl"
  cp dist/pkg/Coati-Setup-windows-x64.exe "$dl/"
  "$dl/Coati-Setup-windows-x64.exe" < /dev/null > "$LOGDIR/install.log" 2>&1 || { cat "$LOGDIR/install.log" >&2; fail "installer exited non-zero"; }
  [ -f "$installed" ] || fail "installer did not write $installed"
  reg.exe query "$win_curr\\Run" /v Coati | grep -qF -- '--serve' || fail "Run key Coati is missing"
  reg_has "$win_curr\\Uninstall\\Coati" || fail "Uninstall entry is missing"
  reg_has 'HKCU\Software\Chromium\NativeMessagingHosts\com.getcoati.broker' || fail "Chromium native messaging key is missing"
  pass "installed: exe, Run key, Uninstall entry, native messaging key"

  # Playwright's Chromium is Chrome for Testing, which reads its own key: give it
  # the manifest path the installer registered for Google Chrome.
  local chrome_key='HKCU\Software\Google\Chrome\NativeMessagingHosts\com.getcoati.broker'
  local cft_key='HKCU\Software\Google\Chrome for Testing\NativeMessagingHosts\com.getcoati.broker'
  local chrome_manifest; chrome_manifest="$(reg.exe query "$chrome_key" /ve | sed -n 's/.*REG_SZ[[:space:]]*//p' | tr -d '\r')"
  [ -n "$chrome_manifest" ] || fail "Google Chrome native messaging key is missing"
  reg.exe add "$cft_key" /ve /t REG_SZ /d "$chrome_manifest" /f >/dev/null

  step "browser: extension pairs with the broker the installer started"
  COATI_E2E_ATTACH=1 node scripts/ci/extension-e2e.mjs
  reg.exe delete "$cft_key" /f >/dev/null

  step "uninstall with the installed exe"
  "$installed" --uninstall < /dev/null > "$LOGDIR/uninstall.log" 2>&1 || { cat "$LOGDIR/uninstall.log" >&2; fail "--uninstall exited non-zero"; }
  # The running exe cannot delete itself: a detached script finishes the job.
  wait_for 60 "the deferred delete of $installed_dir" bash -c '[ ! -e "$1" ] && [ ! -d "$2" ] && [ ! -e "$3" ]' _ "$installed" "$installed_dir" "$installed_dir/../coati-uninstall.cmd"
  reg.exe query "$win_curr\\Run" /v Coati >/dev/null 2>&1 && fail "uninstall left the Run key"
  reg_has "$win_curr\\Uninstall\\Coati" && fail "uninstall left the Uninstall entry"
  for sub in "${nmh_subs[@]}"; do
    reg_has "HKCU\\Software\\$sub\\NativeMessagingHosts\\com.getcoati.broker" && fail "uninstall left HKCU\\Software\\$sub native messaging key"
  done
  port_free || fail "broker still listens on $PORT after uninstall"
  pass "uninstalled: files, registry keys and broker gone"
}

# --- macOS -----------------------------------------------------------------

journey_macos() {
  local zip=dist/pkg/Coati-Setup-macos-arm64.zip
  local support="$HOME/Library/Application Support"
  local installed="$support/Coati/coati-broker"
  local plist="$HOME/Library/LaunchAgents/com.getcoati.broker.plist"
  local label="gui/$(id -u)/com.getcoati.broker"
  need "$zip"; need dist/stage/chrome
  [ "$(uname -m)" = arm64 ] || fail "this runner is $(uname -m), the zip holds an arm64 binary"
  port_free || fail "port $PORT is already in use"

  step "config.json for the fake provider; Chromium's profile dir exists, as on a machine that has it"
  write_config "$HOME/.config/coati" "$ROOT/broker/test/fixtures/modules/valid-provider.ts"
  mkdir -p "$support/Chromium"

  step "unzip the download, run \"Installer Coati\": no argument, no terminal"
  local dl; dl="$(mktemp -d)"
  unzip -q "$zip" -d "$dl"
  [ -x "$dl/Installer Coati" ] || fail "the zip does not hold an executable 'Installer Coati'"
  local autostart=1
  if ! "$dl/Installer Coati" < /dev/null > "$LOGDIR/install.log" 2>&1; then
    # The installer stops at the failed bootstrap, before it writes the browser manifests.
    grep -q 'launchctl bootstrap' "$LOGDIR/install.log" || { cat "$LOGDIR/install.log" >&2; fail "installer exited non-zero"; }
    autostart=0
    annotate warning "launchctl bootstrap in gui/$(id -u) is impossible on this runner: the LaunchAgent autostart path was NOT exercised; the installed broker is started by hand with --serve"
    "$dl/Installer Coati" --install --no-service < /dev/null >> "$LOGDIR/install.log" 2>&1 || { cat "$LOGDIR/install.log" >&2; fail "installer --no-service exited non-zero"; }
    "$installed" --serve > "$LOGDIR/broker.log" 2>&1 &
    BROKER_PID=$!
  fi
  [ -x "$installed" ] || fail "installer did not write $installed"
  [ -f "$support/Chromium/NativeMessagingHosts/com.getcoati.broker.json" ] || fail "installer wrote no Chromium manifest"
  if [ "$autostart" = 1 ]; then
    launchctl print "$label" >/dev/null 2>&1 || fail "LaunchAgent $label is not loaded after the installer"
    export COATI_E2E_BROKER_LOG="$HOME/Library/Logs/Coati/coati-broker.log"
  else
    export COATI_E2E_BROKER_LOG="$LOGDIR/broker.log"
  fi
  pass "installed: exe, manifest, $([ "$autostart" = 1 ] && echo 'LaunchAgent loaded' || echo 'LaunchAgent NOT loaded (fallback)')"

  step "browser: extension pairs with the broker (default Chromium profile, so its per-user manifest is the installer's)"
  COATI_E2E_ATTACH=1 COATI_E2E_PROFILE_DIR="$support/Chromium" node scripts/ci/extension-e2e.mjs

  step "uninstall with the installed binary"
  "$installed" --uninstall < /dev/null > "$LOGDIR/uninstall.log" 2>&1 || { cat "$LOGDIR/uninstall.log" >&2; fail "--uninstall exited non-zero"; }
  [ -e "$installed" ] && fail "uninstall left $installed"
  [ -e "$plist" ] && fail "uninstall left $plist"
  for b in Google/Chrome Chromium BraveSoftware/Brave-Browser "Microsoft Edge" Mozilla; do
    [ -e "$support/$b/NativeMessagingHosts/com.getcoati.broker.json" ] && fail "uninstall left the $b manifest"
  done
  launchctl print "$label" >/dev/null 2>&1 && fail "LaunchAgent still loaded after uninstall"
  wait_for 15 "the broker to release port $PORT" port_free
  pass "uninstalled: exe, LaunchAgent, manifests and broker gone"
}

# --- Linux (inside the container) --------------------------------------------

NODE_VERSION=22.14.0

journey_linux() {
  [ "$(id -u)" = 0 ] && { [ -f /.dockerenv ] || [ -f /run/.containerenv ]; } || fail "the Linux journey installs a package: run it as root inside the CI container"
  local deb; deb="coati_$(dpkg --print-architecture).deb"
  local user=coati-ci home=/home/coati-ci stage=/opt/coati-journey
  need "/repo/dist/pkg/$deb"; need /repo/dist/stage/chrome
  export DEBIAN_FRONTEND=noninteractive
  as_user() { setpriv --reuid "$user" --regid "$user" --init-groups env HOME="$home" USER="$user" "$@"; }

  step "tools: Node $NODE_VERSION (Playwright needs >= 20, Ubuntu ships 18) and Playwright's Chromium"
  apt-get update -qq && apt-get install -y -qq --no-install-recommends ca-certificates curl >/dev/null
  local arch; case "$(uname -m)" in x86_64) arch=x64 ;; aarch64) arch=arm64 ;; *) fail "unsupported arch $(uname -m)" ;; esac
  local tarball="node-v$NODE_VERSION-linux-$arch.tar.gz" base="https://nodejs.org/dist/v$NODE_VERSION"
  (cd "$LOGDIR" && curl -fsSL -O "$base/$tarball" && curl -fsSL "$base/SHASUMS256.txt" | grep -F " $tarball" | sha256sum -c -)
  mkdir -p /opt/node && tar -xzf "$LOGDIR/$tarball" -C /opt/node --strip-components=1
  export PATH="/opt/node/bin:$PATH" PLAYWRIGHT_BROWSERS_PATH=/opt/ms-playwright
  # A private copy of what the browser run needs, readable by the unprivileged user
  # whatever the permissions of the mounted checkout.
  mkdir -p "$stage/scripts/ci" "$stage/broker/test/fixtures/modules" "$stage/dist/stage" "$stage/node_modules"
  cp /repo/scripts/ci/extension-e2e.mjs "$stage/scripts/ci/"
  cp /repo/broker/test/fixtures/modules/valid-provider.ts "$stage/broker/test/fixtures/modules/"
  cp -r /repo/dist/stage/chrome "$stage/dist/stage/"
  cp -r /repo/node_modules/playwright /repo/node_modules/playwright-core "$stage/node_modules/"
  node "$stage/node_modules/playwright/cli.js" install --with-deps chromium >/dev/null
  chmod -R a+rX /opt/node /opt/ms-playwright "$stage"

  step "a normal user, config.json for the fake provider"
  useradd -m -s /bin/bash "$user"
  write_config "$home/.config/coati" "$stage/broker/test/fixtures/modules/valid-provider.ts"
  chown -R "$user:$user" "$home"
  port_free || fail "port $PORT is already in use"

  step "apt install the .deb"
  cp "/repo/dist/pkg/$deb" "$LOGDIR/$deb"
  apt-get install -y -qq "$LOGDIR/$deb" >/dev/null
  local manifest=/etc/opt/chrome/native-messaging-hosts/com.getcoati.broker.json
  [ -x /usr/bin/coati-broker ] || fail "/usr/bin/coati-broker is missing"
  grep -qF '"path": "/usr/bin/coati-broker"' "$manifest" || fail "$manifest is missing or does not point to /usr/bin/coati-broker"
  # Playwright's Chromium is Chrome for Testing, which reads its own system dir:
  # point it at Google Chrome's, so the browser reads the exact file a Chrome user gets.
  mkdir -p /etc/opt/chrome_for_testing
  ln -s /etc/opt/chrome/native-messaging-hosts /etc/opt/chrome_for_testing/native-messaging-hosts
  pass "installed: binary and system manifest"

  step "broker as $user: /usr/bin/coati-broker --serve"
  annotate notice "no systemd in a container: the user service start (systemctl --user, enable on login) was NOT exercised; the broker is started by hand with --serve"
  # Not through as_user: a backgrounded function is a subshell, and $! would not be the broker.
  setpriv --reuid "$user" --regid "$user" --init-groups env HOME="$home" USER="$user" \
    /usr/bin/coati-broker --serve > "$LOGDIR/broker.log" 2>&1 &
  BROKER_PID=$!

  step "browser: extension pairs with the broker through the SYSTEM manifest"
  # Chromium reads a per-user manifest under its --user-data-dir (a fresh temporary
  # profile here, so empty) and the system one linked above.
  # The broker's serve-time sync writes user manifests only under ~/.config/<browser> of
  # browsers whose config dir exists, which this home does not have. The check
  # below that no user manifest exists anywhere in the home turns that into a proof:
  # the connection could only come from the system manifest.
  as_user PLAYWRIGHT_BROWSERS_PATH="$PLAYWRIGHT_BROWSERS_PATH" PATH="$PATH" CI=true \
    GITHUB_ACTIONS="${GITHUB_ACTIONS:-}" COATI_E2E_BROKER_LOG="$LOGDIR/broker.log" COATI_E2E_ATTACH=1 \
    node "$stage/scripts/ci/extension-e2e.mjs"
  local user_manifests; user_manifests="$(find "$home" -name com.getcoati.broker.json)"
  [ -z "$user_manifests" ] || fail "a user manifest exists, the system path is not proven alone: $user_manifests"
  pass "connected with no user manifest anywhere: the system manifest $manifest was the one used"

  step "apt remove"
  kill "$BROKER_PID"; wait "$BROKER_PID" 2>/dev/null || true; BROKER_PID=""
  apt-get remove -y -qq coati >/dev/null
  local left; left="$(find /usr /etc -iname '*coati*' 2>/dev/null || true)"
  [ -z "$left" ] || fail "left behind after removal: $left"
  wait_for 15 "port $PORT to be free after removal" port_free
  pass "removed: nothing left under /usr and /etc"
}

case "$(uname -s)" in
  MINGW*|MSYS*|CYGWIN*) journey_windows ;;
  Darwin*) journey_macos ;;
  Linux*) journey_linux ;;
  *) fail "unsupported OS $(uname -s)" ;;
esac
echo "== scripts/ci/journey.sh: ALL PASS =="
