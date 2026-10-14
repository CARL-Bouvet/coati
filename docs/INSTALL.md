# Installing Coati

Coati has two pieces: the extension, in the browser, and the **local program** (`coati-broker`),
which runs on your machine and talks to the model. This document installs the local program.

It ships as a single executable, `coati-broker`, which also acts as a **native host**: a
program the browser launches itself, at the extension's request, to hand it the key that opens
the connection to the broker — this pairs the extension with no gesture from you. Detail:
`docs/PROTOCOL.md`, "Native host". Supported browsers: Chrome, Chromium, Brave, Edge, Firefox.
No step needs administrator rights.

## 1. Download and verify

From the [releases page](https://github.com/CARL-Bouvet/coati/releases), take from the same
release: the executable for your system (`coati-broker-linux-x64`/`-arm64`,
`coati-broker-darwin-arm64`/`-x64`, `coati-broker-windows-x64.exe`), `SHA256SUMS`, the
extension for your browser (`coati-chrome.zip` or `coati-firefox.zip`), and the "Source code"
archive (install scripts + templates). Decompress the source archive, then verify:

```sh
sha256sum --check --ignore-missing SHA256SUMS                    # Linux
shasum -a 256 coati-broker-darwin-arm64                           # macOS, compare by hand
```
```powershell
Get-FileHash .\coati-broker-windows-x64.exe -Algorithm SHA256     # Windows
```

Don't install the file if the checksum doesn't match.

## 2. Install the local program

Run from the decompressed source archive, passing the downloaded executable's path. Safe to
rerun.

```sh
bash scripts/install/install-linux.sh ~/Downloads/coati-broker-linux-x64
bash scripts/install/install-macos.sh ~/Downloads/coati-broker-darwin-arm64
```
```powershell
powershell -ExecutionPolicy Bypass -File scripts\install\install-windows.ps1 -Binary "$env:USERPROFILE\Downloads\coati-broker-windows-x64.exe"
```

Each installs: the executable (`~/.local/bin/coati-broker` Linux,
`~/Library/Application Support/Coati/` macOS, `%LOCALAPPDATA%\Coati\` Windows); an
auto-starting service (systemd user unit, launchd agent, or a Windows scheduled task,
`CoatiBroker`); the native-host manifest (`com.getcoati.broker.json`) registered with each
already-installed browser. Options: `--no-service`/`-NoService`, `--dry-run`/`-DryRun`, and on
Linux/macOS `--all` to declare every browser (otherwise only the ones already installed). On
Windows, all five browsers are always declared. Windows also restricts the data folder's ACL to
your account, `SYSTEM`, and Administrators.

**Unsigned executables**: published binaries carry no Apple/Microsoft developer signature. The
installer removes the "downloaded from the internet" mark itself. If still blocked: macOS
(Gatekeeper) — Finder, right-click → **Open**, confirm, or
`xattr -d com.apple.quarantine <path>`; Windows (SmartScreen) — **More info** → **Run anyway**.

## 3. Configuration and data

Created by the broker on first start (on Windows, `~` means `%USERPROFILE%`):
`~/.config/coati/config.json` (configuration), `~/.local/share/coati/` (data, including
`broker-key.json`, drawn fresh on every start). Provider modules
(`docs/ARCHITECTURE.md`, "Modules"): `coati-broker --check-modules` checks they load without
opening a port.

## 4. Load the extension

Take the extension from the release assets: unzip `coati-chrome.zip` (Chrome, Chromium, Brave,
Edge) or `coati-firefox.zip` (Firefox) into a folder you keep — don't move or delete it. Their
checksums are in `SHA256SUMS`. Alternative: the `extension/` folder of the decompressed source
archive works the same way for Chrome-family browsers.

**Chrome, Chromium, Brave, Edge**: open the extensions page (`chrome://extensions`,
`brave://extensions`, `edge://extensions`), enable **Developer mode**, **Load unpacked**, pick
the unzipped folder (or `extension/`). The id is fixed by the manifest's `key`, so pairing works
immediately, even after a reload. After an update: replace the folder's contents, click
**Reload**.

**Firefox**: needs a real `manifest.json` on disk, not a zip.

- *Temporary*: unzip `coati-firefox.zip` (or build it: `./scripts/build.sh` →
  `dist/stage/firefox/`); declare the native host once with
  `bash scripts/dev-native-host.sh --all` (from the source archive); in Firefox,
  `about:debugging#/runtime/this-firefox` → **Load Temporary Add-on…** → pick the unzipped
  `manifest.json`. Disappears on restart; after a code change, rebuild and
  click **Reload**.
- *Permanent*: Firefox requires AMO signing even for personal use. Create a free account at
  [addons.mozilla.org/developers](https://addons.mozilla.org/developers/), build
  `dist/coati-firefox.zip`, submit at
  [.../addon/submit/distribution](https://addons.mozilla.org/developers/addon/submit/distribution)
  choosing **On your own** (not the public store). Mozilla's automated review (no human review on
  this path) takes minutes; install the signed `.xpi` by dragging it into Firefox, or
  `about:addons` → gear → **Install Add-on From File…**. To republish: bump `"version"` in both
  `extension/manifest.json` and `extension/manifest.firefox.json` (kept in sync) — AMO won't
  re-sign the same version twice for the same id (`coati@getcoati.com`, never changes).
- Pairing is automatic, same as Chrome, for extension id `coati@getcoati.com` only. A Snap/Flatpak
  Firefox (Ubuntu's default) can't launch the native host — see "Flatpak or Snap" below.

## 5. Pick a model

Default provider: **Ollama**, fully local (`http://127.0.0.1:11434`). Coati never picks a model
on its own — with none configured, the broker refuses requests.

**Ollama (recommended to start)**: install [Ollama](https://ollama.com), then
`ollama pull llama3.2` (~2 GB; any chat model works, bigger ones answer better but load slower).
In the extension's settings (Coati icon → **Open settings**): provider **Ollama (local)**, pick
`llama3.2` from the installed-models list. Ollama's default 4096-token window silently truncates;
Coati requests a window sized to the page (up to 16384 tokens) — a long page uses more memory and
triggers a reload when the size changes.

**Other providers**: **Claude (API key)** — your own Anthropic key; **OpenAI-compatible** — LM
Studio, OpenAI, Mistral, OpenRouter, DeepSeek, or any compatible address (key stored by the local
program, never in the extension). For Ollama itself, prefer the **Ollama (local)** provider over
its `/v1` endpoint — through that endpoint Coati can't grow the reading window.

Which model fits your machine: see "Which model" in the README.

**What you should see**: click the Coati toolbar icon (or press `Alt+Shift+C`). A "Getting
started" card shows three checks (local program detected, model connected, page access granted).
With the first two green, ask a question about the page and grant site access when asked.
Provider status shows at the panel's bottom.

## 6. Uninstall

```sh
bash scripts/install/uninstall-linux.sh     # or uninstall-macos.sh
```
```powershell
powershell -ExecutionPolicy Bypass -File scripts\install\uninstall-windows.ps1
```

Stops the service, removes the executable, the service/task, and the native-host manifests.
Leaves `~/.config/coati` and `~/.local/share/coati` — delete by hand to erase everything.

## Browser installed via Flatpak or Snap

A sandboxed browser can't launch the native host. Manual pairing, off by default:

1. `~/.config/coati/config.json`: set `"legacyPairing": true`, then
   `systemctl --user restart coati-broker`.
2. `~/.local/bin/coati-broker --show-pairing-secret` to print the secret.
3. Extension settings → "Browser without a native host (Flatpak, Snap)" → paste → **Save**.

The extension keeps the secret in memory only — paste it again after every browser restart. The
secret is permanent and readable by any program under your account
(`~/.local/share/coati/pairing-secret`); to rotate it, delete that file, restart the broker,
re-run `--show-pairing-secret`, paste the new value. Back to default: `"legacyPairing": false`.

## Troubleshooting

| Banner | Likely cause | Fix |
|---|---|---|
| "Coati can't find its local program." | Native host not installed, browser installed after the broker, blocked by Gatekeeper/SmartScreen, or a Flatpak/Snap browser. | Rerun the installer (`--all`), restart the browser. See "Unsigned executables" / "Flatpak or Snap". |
| "The local program refused the connection." | Handshake rejected. Panel retries automatically; **Retry** button available. | Restart the broker. Hand-edited `config.json`: check `allowedExtensionIds`. Manual pairing: check `legacyPairing`, re-paste the secret. |
| "Another program is answering instead of Coati's." | Something unauthenticated is listening on port 8787. | Find it: `ss -ltnp 'sport = :8787'` (Linux), `lsof -iTCP:8787 -sTCP:LISTEN` (macOS), `netstat -ano \| findstr 8787` (Windows). Stop it, restart the broker. |
| "Coati's local program isn't responding." | Broker not running. | `systemctl --user status coati-broker` (Linux); check `~/Library/Logs/Coati/coati-broker.log` (macOS); `Start-ScheduledTask -TaskName CoatiBroker` (Windows). |

## Development: installing from source

Linux, with [Bun](https://bun.sh) **>= 1.4.2**: `cd broker && bun install`, then
`bun run start` to run without the systemd service. Service: `bash scripts/install-service.sh`
(installs/enables/starts; rerun-safe). Useful: `systemctl --user status coati-broker`,
`journalctl --user -u coati-broker -n 100`, `systemctl --user stop coati-broker`.

Native host from source: `bash scripts/dev-native-host.sh` (Brave only) or `--all`, `--uninstall`
to remove — writes a launcher at `~/.local/share/coati/dev-native-host/` that runs the broker
from source in host mode; pairing is then automatic.

Extension from source: same steps as "Load the extension" above, pointing at the repo's
`extension/` folder.
