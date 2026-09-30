#!/usr/bin/env bash
# End-to-end CI check for goal G4 ("CI end to end + Windows ACL") — runs on
# all three OS (Linux, macOS, Windows via git-bash) against THIS runner's own
# compiled binary. Mirrors docs/PROTOCOL.md's "Poignée de main Native
# Messaging simulée" test plan, but against the REAL installer + REAL
# installed binary rather than `bun run src/server.ts`, per goal G4's
# instructions — that's what actually exercises install-{linux,macos}.sh /
# install-windows.ps1 end to end:
#
#   1. install the compiled binary with this OS's installer, --no-service /
#      -NoService, into a throwaway prefix under a temp $HOME/$USERPROFILE;
#   2. start the installed binary as the broker (COATI_PORT=18787,
#      COATI_DATA_DIR under the same temp home), wait for broker-key.json;
#   3. simulate the browser launching the Native Messaging host: run the
#      installed binary with the pinned chrome-extension origin argument,
#      write a framed key.get, check the reply's key matches the key file;
#      then with a foreign id — expect forbidden-caller;
#   4. run scripts/ws-probe.js against the broker, expect hello-ok (v: 2) and
#      an answer from the fake provider module (broker/test/fixtures/modules
#      /valid-provider.ts, which echoes back "echo:<prompt>");
#   5. stop the broker, run the uninstaller, assert nothing it wrote is left.
#
# Never touches the real HOME/USERPROFILE — everything lives under a mktemp
# directory, removed on exit (success or failure).
#
# Usage: bash scripts/ci/e2e.sh [target]
#   target: linux-x64 | linux-arm64 | darwin-x64 | darwin-arm64 | windows-x64
#           (default: auto-detected from `uname`)
#
# Windows notes (git-bash on the windows-latest/self-hosted runner):
#  - .exe suffix on the binary.
#  - git-bash's own POSIX-style paths (mktemp's /tmp/xxxx) do NOT resolve
#    correctly when handed as an ENV VAR VALUE or CLI ARG to a native Windows
#    process (bun.exe, coati-broker.exe, pwsh.exe/icacls.exe) — every such
#    value is converted with `cygpath -w` first (see *_WIN variables below).
#    Plain bash file tests (`test -f`, `mkdir -p`) keep using the POSIX form.
#  - MSYS_NO_PATHCONV=1 disables git-bash's OWN implicit (and unpredictable)
#    argv path conversion, so only our explicit *_WIN conversions apply.
#  - Both HOME and USERPROFILE are set to the same temp dir: Node/Bun's
#    os.homedir() reads $HOME on POSIX and $USERPROFILE on Windows — setting
#    both is harmless where unused (same idiom as .github/workflows/tests.yml
#    "--check-modules smoke").
#  - Killing the background broker: `kill` on the job's PID, with a
#    `taskkill` backstop — Remove-Item on the installed .exe would otherwise
#    fail with the file still locked by a running process.

set -euo pipefail
export MSYS_NO_PATHCONV=1

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"

STEP=0
pass() { STEP=$((STEP + 1)); echo "PASS [$STEP] $1"; }
fail() { STEP=$((STEP + 1)); echo "FAIL [$STEP] $1" >&2; exit 1; }

# --- OS / target detection ---------------------------------------------

case "$(uname -s)" in
  Linux*) OS=linux ;;
  Darwin*) OS=macos ;;
  MINGW*|MSYS*|CYGWIN*) OS=windows ;;
  *) fail "unsupported uname -s: $(uname -s)" ;;
esac

if [ -n "${1:-}" ]; then
  TARGET="$1"
else
  case "$OS" in
    linux)
      case "$(uname -m)" in
        x86_64) TARGET=linux-x64 ;;
        aarch64|arm64) TARGET=linux-arm64 ;;
        *) fail "unsupported linux arch: $(uname -m)" ;;
      esac
      ;;
    macos)
      case "$(uname -m)" in
        arm64) TARGET=darwin-arm64 ;;
        x86_64) TARGET=darwin-x64 ;;
        *) fail "unsupported macos arch: $(uname -m)" ;;
      esac
      ;;
    windows)
      TARGET=windows-x64
      ;;
  esac
fi
echo "== scripts/ci/e2e.sh: os=$OS target=$TARGET =="

EXT=""
[ "$OS" = "windows" ] && EXT=".exe"
BIN="$ROOT/dist/bin/coati-broker-$TARGET$EXT"
if [ ! -f "$BIN" ]; then
  echo "binary missing, building: $BIN"
  bash scripts/build-binaries.sh "$TARGET"
fi
[ -f "$BIN" ] || fail "binary still missing after build-binaries.sh: $BIN"
pass "compiled binary present ($BIN)"

# --- native-path helper (Windows only; identity everywhere else) --------

to_win() {
  if [ "$OS" = "windows" ] && command -v cygpath >/dev/null 2>&1; then
    cygpath -w "$1"
  else
    printf '%s' "$1"
  fi
}

# --- temp HOME/USERPROFILE + prefix, never the real ones ----------------

HOME_DIR="$(mktemp -d "${TMPDIR:-/tmp}/coati-e2e-home.XXXXXX")"
HOME_DIR_WIN="$(to_win "$HOME_DIR")"
PREFIX_DIR="$HOME_DIR/prefix"
PREFIX_DIR_WIN="$(to_win "$PREFIX_DIR")"
DATA_DIR="$HOME_DIR/.local/share/coati"
DATA_DIR_WIN="$HOME_DIR_WIN/.local/share/coati"
BIN_WIN="$(to_win "$BIN")"
ROOT_WIN="$(to_win "$ROOT")"

BROKER_PID=""
cleanup() {
  if [ -n "$BROKER_PID" ]; then
    kill "$BROKER_PID" >/dev/null 2>&1 || true
    if [ "$OS" = "windows" ]; then
      taskkill //F //IM "coati-broker.exe" //T >/dev/null 2>&1 || true
    fi
    wait "$BROKER_PID" 2>/dev/null || true
  fi
  rm -rf "$HOME_DIR" 2>/dev/null || true
}
trap cleanup EXIT

export HOME="$HOME_DIR_WIN"
export USERPROFILE="$HOME_DIR_WIN"

mkdir -p "$HOME_DIR/.config/coati"
FIXTURE="$ROOT_WIN/broker/test/fixtures/modules/valid-provider.ts"
cat > "$HOME_DIR/.config/coati/config.json" <<EOF
{
  "port": 18787,
  "allowedExtensionIds": ["hehlgipomfminodhahcjbencblepjhah"],
  "provider": "e2e-fixture",
  "modules": [
    { "path": "$FIXTURE", "options": { "id": "e2e-fixture", "label": "E2E Fixture" } }
  ]
}
EOF
pass "temp HOME/config.json prepared ($HOME_DIR)"

# --- (a) install, --no-service / -NoService, throwaway prefix -----------

case "$OS" in
  linux)
    bash scripts/install/install-linux.sh "$BIN" --prefix "$PREFIX_DIR" --no-service --all
    INSTALLED_BIN="$PREFIX_DIR/.local/bin/coati-broker"
    ;;
  macos)
    bash scripts/install/install-macos.sh "$BIN" --prefix "$PREFIX_DIR" --no-service --all
    INSTALLED_BIN="$PREFIX_DIR/Library/Application Support/Coati/coati-broker"
    ;;
  windows)
    command -v pwsh >/dev/null 2>&1 || fail "pwsh not found on PATH (required on the windows-latest runner)"
    pwsh -NoProfile -File "scripts/install/install-windows.ps1" \
      -Binary "$BIN_WIN" -Prefix "$PREFIX_DIR_WIN" -NoService
    INSTALLED_BIN="$PREFIX_DIR/Coati/coati-broker.exe"
    ;;
esac
[ -f "$INSTALLED_BIN" ] || fail "installer did not produce $INSTALLED_BIN"
pass "install ($OS installer, --no-service, prefix=$PREFIX_DIR)"
# Used below as a CLI ARG to bun (nm-handshake.ts) — needs the same cygpath -w
# conversion as every other native-process CLI arg (see this file's header).
# Plain bash file tests above keep using the POSIX form.
INSTALLED_BIN_WIN="$(to_win "$INSTALLED_BIN")"

# --- (b) start the installed binary as the broker, wait for the key -----

COATI_PORT=18787 COATI_DATA_DIR="$DATA_DIR_WIN" "$INSTALLED_BIN" \
  > "$HOME_DIR/broker.log" 2>&1 &
BROKER_PID=$!

KEY_FILE="$DATA_DIR/broker-key.json"
# Same as INSTALLED_BIN_WIN above: this path is read via `bun -e` as a CLI arg
# below, so it needs the native Windows form there; the [ -f ] wait loop right
# below keeps the POSIX form (plain bash file test).
KEY_FILE_WIN="$(to_win "$KEY_FILE")"
tries=0
until [ -f "$KEY_FILE" ]; do
  tries=$((tries + 1))
  if [ "$tries" -ge 100 ]; then
    cat "$HOME_DIR/broker.log" >&2 || true
    fail "broker-key.json never appeared under $DATA_DIR (broker log above)"
  fi
  sleep 0.1
done
pass "broker started (pid $BROKER_PID, port 18787), key file written"

BROKER_KEY="$(bun -e 'console.log(JSON.parse(await Bun.file(process.argv[1]).text()).key)' "$KEY_FILE_WIN")"
[ -n "$BROKER_KEY" ] || fail "could not read key from $KEY_FILE"

# --- (c) simulated Native Messaging handshake ---------------------------

PINNED_ORIGIN="chrome-extension://hehlgipomfminodhahcjbencblepjhah/"
FOREIGN_ORIGIN="chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/"
if [ "$OS" = "windows" ]; then
  HANDSHAKE_ARGS=("--parent-window=0" "$PINNED_ORIGIN")
  FOREIGN_ARGS=("--parent-window=0" "$FOREIGN_ORIGIN")
else
  HANDSHAKE_ARGS=("$PINNED_ORIGIN")
  FOREIGN_ARGS=("$FOREIGN_ORIGIN")
fi

REPLY="$(COATI_DATA_DIR="$DATA_DIR_WIN" bun scripts/ci/nm-handshake.ts "$INSTALLED_BIN_WIN" "${HANDSHAKE_ARGS[@]}")"
REPLY_KEY="$(bun -e 'console.log(JSON.parse(process.argv[1]).key ?? "")' "$REPLY")"
[ "$REPLY_KEY" = "$BROKER_KEY" ] || fail "native host reply key mismatch: got '$REPLY_KEY', expected '$BROKER_KEY' (reply: $REPLY)"
pass "native host, pinned caller: key matches broker-key.json"

FOREIGN_REPLY="$(COATI_DATA_DIR="$DATA_DIR_WIN" bun scripts/ci/nm-handshake.ts "$INSTALLED_BIN_WIN" "${FOREIGN_ARGS[@]}")"
FOREIGN_CODE="$(bun -e 'console.log(JSON.parse(process.argv[1]).code ?? "")' "$FOREIGN_REPLY")"
[ "$FOREIGN_CODE" = "forbidden-caller" ] || fail "native host, foreign caller: expected code forbidden-caller, got '$FOREIGN_CODE' (reply: $FOREIGN_REPLY)"
pass "native host, foreign caller: forbidden-caller"

# --- (d) ws-probe: v:2 handshake + real answer from the fake provider ---

QUESTION="coati e2e probe $$"
WS_OUT="$HOME_DIR/ws-probe.out"
WS_ERR="$HOME_DIR/ws-probe.err"
if ! COATI_DATA_DIR="$DATA_DIR_WIN" bun scripts/ws-probe.js "$QUESTION" > "$WS_OUT" 2> "$WS_ERR"; then
  cat "$WS_ERR" >&2
  fail "ws-probe.js exited non-zero"
fi
grep -q "hello-ok (v: 2)" "$WS_ERR" || fail "ws-probe.js: no 'hello-ok (v: 2)' in stderr ($WS_ERR)"
pass "ws-probe: hello-ok (v: 2)"
# valid-provider.ts's streamAnswer() yields "echo:<prompt>", and the prompt
# built for a chat message wraps the raw text (buildPrompt) — so the two
# checks below land on different lines of the same answer, not one grep.
grep -q "^echo:" "$WS_OUT" || fail "ws-probe.js: answer does not start with the fake provider's echo (stdout: $(cat "$WS_OUT"))"
grep -qF "$QUESTION" "$WS_OUT" || fail "ws-probe.js: answer does not contain the question sent (stdout: $(cat "$WS_OUT"))"
pass "ws-probe: answer from the fake provider module"

# --- (e) stop the broker, uninstall, assert nothing left ----------------

kill "$BROKER_PID" >/dev/null 2>&1 || true
if [ "$OS" = "windows" ]; then
  taskkill //F //IM "coati-broker.exe" //T >/dev/null 2>&1 || true
fi
wait "$BROKER_PID" 2>/dev/null || true
BROKER_PID=""
sleep 1
pass "broker stopped"

case "$OS" in
  linux)
    bash scripts/install/uninstall-linux.sh --prefix "$PREFIX_DIR" --no-service
    ;;
  macos)
    bash scripts/install/uninstall-macos.sh --prefix "$PREFIX_DIR" --no-service
    ;;
  windows)
    pwsh -NoProfile -File "scripts/install/uninstall-windows.ps1" \
      -Prefix "$PREFIX_DIR_WIN" -NoService
    ;;
esac
pass "uninstall ($OS uninstaller)"

[ -f "$INSTALLED_BIN" ] && fail "uninstall left the binary behind: $INSTALLED_BIN"
case "$OS" in
  linux)
    for m in \
      "$PREFIX_DIR/.config/google-chrome/NativeMessagingHosts/com.getcoati.broker.json" \
      "$PREFIX_DIR/.config/chromium/NativeMessagingHosts/com.getcoati.broker.json" \
      "$PREFIX_DIR/.config/BraveSoftware/Brave-Browser/NativeMessagingHosts/com.getcoati.broker.json" \
      "$PREFIX_DIR/.config/microsoft-edge/NativeMessagingHosts/com.getcoati.broker.json" \
      "$PREFIX_DIR/.mozilla/native-messaging-hosts/com.getcoati.broker.json"; do
      [ -f "$m" ] && fail "uninstall left a manifest behind: $m"
    done
    ;;
  macos)
    [ -f "$PREFIX_DIR/Library/Application Support/Google/Chrome/NativeMessagingHosts/com.getcoati.broker.json" ] &&
      fail "uninstall left the Chrome manifest behind"
    ;;
  windows)
    for m in \
      "$PREFIX_DIR/Coati/native-host/com.getcoati.broker.chromium.json" \
      "$PREFIX_DIR/Coati/native-host/com.getcoati.broker.firefox.json"; do
      [ -f "$m" ] && fail "uninstall left a manifest behind: $m"
    done
    pwsh -NoProfile -Command '
      $ErrorActionPreference = "Stop"
      $keys = @(
        "HKCU:\Software\Google\Chrome\NativeMessagingHosts\com.getcoati.broker",
        "HKCU:\Software\Chromium\NativeMessagingHosts\com.getcoati.broker",
        "HKCU:\Software\BraveSoftware\Brave-Browser\NativeMessagingHosts\com.getcoati.broker",
        "HKCU:\Software\Microsoft\Edge\NativeMessagingHosts\com.getcoati.broker",
        "HKCU:\Software\Mozilla\NativeMessagingHosts\com.getcoati.broker"
      )
      $left = $keys | Where-Object { Test-Path -LiteralPath $_ }
      if ($left) { Write-Error "registry keys left behind: $($left -join `", `")"; exit 1 }
    ' || fail "uninstall left a registry key behind"
    ;;
esac
pass "uninstall: nothing left (binary, manifests$( [ "$OS" = windows ] && echo ', registry keys'))"

echo "== scripts/ci/e2e.sh: ALL PASS ($STEP steps) =="
