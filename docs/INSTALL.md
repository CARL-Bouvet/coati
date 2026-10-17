# Installing Coati

Coati has two pieces: the extension, in your browser, and the local program (`coati-broker`),
which runs on your computer and talks to the model. The extension's tutorial detects your
system and links to the right download below. Supported browsers: Chrome, Chromium, Brave, Edge,
Firefox.

## 1. Install

Download the file for your system from
`https://github.com/CARL-Bouvet/coati/releases/latest/download/<file>`. The files are not signed
with a paid developer certificate, so your system warns you once.

**Windows**: download `Coati-Setup-windows-x64.exe` and double-click it. SmartScreen shows
"Windows protected your PC": click **More info**, then **Run anyway**. A window shows the
install, then closes. Coati starts at each login.

**macOS**: download `Coati-Setup-macos-arm64.zip` (Apple chip) or `Coati-Setup-macos-x64.zip`
(Intel). Open the zip and double-click **Installer Coati**. macOS refuses to open it. On macOS
15, open System Settings → Privacy & Security, scroll down, click **Open Anyway** and confirm.
On macOS 14, right-click the file and choose **Open**.

**Linux**: download the package for your distribution (`coati_amd64.deb` for Debian, Ubuntu,
Mint; `coati-x86_64.rpm` for Fedora, openSUSE; `arm64`/`aarch64` on ARM) and open it: the
software center offers to install it and asks for your password. From a terminal instead:

```sh
sudo apt install ./coati_amd64.deb
sudo dnf install ./coati-x86_64.rpm
```

The package installs `/usr/bin/coati-broker` and a user service. If the program does not answer
right away, log out and in once, or run `systemctl --user enable --now coati-broker`. Other
distributions: see "Advanced".

The extension's tutorial polls the program and turns green when it answers.

## 2. Load the extension

Take the extension from the [release assets](https://github.com/CARL-Bouvet/coati/releases/latest):
unzip `coati-chrome.zip` (Chrome, Chromium, Brave, Edge) or `coati-firefox.zip` (Firefox) into a
folder you keep. Don't move or delete it.

**Chrome, Chromium, Brave, Edge**: open the extensions page (`chrome://extensions`,
`brave://extensions`, `edge://extensions`), enable **Developer mode**, click **Load unpacked**,
pick the unzipped folder. The id is fixed by the manifest's `key`, so pairing works immediately,
even after a reload.

**Firefox** needs a real `manifest.json` on disk, not a zip.

- Temporary: unzip `coati-firefox.zip`, open `about:debugging#/runtime/this-firefox`, click
  **Load Temporary Add-on…** and pick the unzipped `manifest.json`. It disappears on restart.
- Permanent: Firefox requires AMO signing even for personal use. Create a free account at
  [addons.mozilla.org/developers](https://addons.mozilla.org/developers/), build
  `dist/coati-firefox.zip`, submit at
  [.../addon/submit/distribution](https://addons.mozilla.org/developers/addon/submit/distribution)
  choosing **On your own** (not the public store). Install the signed `.xpi` by dragging it
  into Firefox, or from `about:addons` → gear → **Install Add-on From File…**. To republish,
  bump `"version"` in both `extension/manifest.json` and `extension/manifest.firefox.json`
  (kept in sync): AMO won't re-sign the same version twice for the same id
  (`coati@getcoati.com`, never changes).
- Pairing is automatic, for extension id `coati@getcoati.com` only. A Snap or Flatpak Firefox
  (Ubuntu's default) can't launch the native host: see "Flatpak or Snap" below.

## 3. Pick a model

Default provider: **Ollama**, fully local (`http://127.0.0.1:11434`). Coati never picks a model
on its own; with none configured, the program refuses requests.

**Local model**: install [Ollama](https://ollama.com/download) or
[LM Studio](https://lmstudio.ai/download), then download a model with it by following the
tool's own guide ([Ollama](https://docs.ollama.com/quickstart),
[LM Studio](https://lmstudio.ai/docs/app/basics/download-model)). In the extension's settings
(Coati icon → **Open settings**, "On this computer" tab), the step-by-step guide connects Coati
to the tool; pick your model from the installed-models list. Coati sets the context window
itself (8192 to 32768 tokens, depending on the model and your memory); a larger window uses
more memory.

**Other providers**: Claude (your own Anthropic key) and OpenAI-compatible services (LM Studio,
OpenAI, Mistral, OpenRouter, DeepSeek, or any compatible address). Keys are stored by the local
program, never in the extension. For Ollama itself, prefer the **Ollama (local)** provider over
its `/v1` endpoint: through that endpoint Coati can't grow the reading window.

Which model fits your machine: see "Choosing a model" in the [README](../README.md#choosing-a-model).

Then click the Coati toolbar icon (or press `Alt+Shift+C`). A "Getting started" card shows three
checks (local program detected, model connected, page access granted). With the first two green,
ask a question about the page and grant site access when asked.

## 4. Update

Windows and macOS: download the installer again and run it; it replaces the old version. Linux:
install the new package the same way. Extension: replace the folder's contents and click
**Reload** on the extensions page.

## 5. Uninstall

- Windows: Settings → Apps → Coati → Uninstall.
- macOS: in Terminal, run `"~/Library/Application Support/Coati/coati-broker" --uninstall`.
- Linux: remove the package with your package manager (`coati`).

This stops the program and removes it, its service and the browser manifests. Your configuration
(`~/.config/coati`) and data, including keys (`~/.local/share/coati`), stay unless you add
`--purge`. On Windows, `~` is `%USERPROFILE%`.

## Advanced

The raw program is one file that installs itself.

1. Download `coati-broker-<os>-<arch>` (for example `coati-broker-linux-x64`) and `SHA256SUMS`
   from the same release.
2. Verify it. If the checksum doesn't match, don't run the file.

```sh
sha256sum --check --ignore-missing SHA256SUMS      # Linux
shasum -a 256 coati-broker-macos-arm64             # macOS, compare by hand
```
```powershell
Get-FileHash .\coati-broker-windows-x64.exe -Algorithm SHA256   # Windows
```

3. Make it executable and install. No administrator rights needed, and it is safe to rerun.

```sh
chmod +x coati-broker-linux-x64
./coati-broker-linux-x64 --install
```

Started with no argument from a downloaded copy, the program runs an interactive install.

| Flag | Effect |
|---|---|
| `--install` | Copy the program to your user folder, start it at login, declare it to your browsers. |
| `--system` | With `--install`: system-wide install (what the packages use). |
| `--prefix <dir>` | With `--install`: install under `<dir>`. |
| `--no-service` | With `--install`: don't start it at login. |
| `--all` | With `--install`: declare every supported browser, not only installed ones (Linux, macOS). |
| `--dry-run` | With `--install`: print what would change, change nothing. |
| `--uninstall` | Remove the program, its service and the manifests. |
| `--purge` | With `--uninstall`: also remove configuration and keys. |
| `--serve` | Run the program in the foreground. |

User install locations: `~/.local/bin/coati-broker` (Linux),
`~/Library/Application Support/Coati/` (macOS), `%LOCALAPPDATA%\Coati\` (Windows). At each start
the program rewrites its browser manifests, so a browser installed later is picked up after a
restart. Arch and other distributions without a package: use the raw binary as above.

The program creates `~/.config/coati/config.json` and `~/.local/share/coati/` on first start.
`coati-broker --check-modules` checks that provider modules load, without opening a port.

### Flatpak or Snap

A sandboxed browser can't launch the native host. Manual pairing, off by default:

1. In `~/.config/coati/config.json`, set `"legacyPairing": true`, then
   `systemctl --user restart coati-broker`.
2. Run `coati-broker --show-pairing-secret` to print the secret.
3. Extension settings → "Browser with no native program (Flatpak, Snap)" → paste → **Save**.

The extension keeps the secret in memory only: paste it again after every browser restart. The
secret is permanent and readable by any program under your account
(`~/.local/share/coati/pairing-secret`). To rotate it, delete that file, restart the program,
run `--show-pairing-secret` again and paste the new value. To go back to the default, set
`"legacyPairing": false`.

## Troubleshooting

| Banner | Likely cause | Fix |
|---|---|---|
| "Coati can't find its local program." | Not installed, browser installed after the program, blocked by the system warning, or a Flatpak/Snap browser. | Run the installer again and restart the browser. See "Install" and "Flatpak or Snap". |
| "The local program refused the connection." | Handshake rejected. The panel retries; **Retry** is available. | Restart the program. Hand-edited `config.json`: check `allowedExtensionIds`. Manual pairing: check `legacyPairing`, paste the secret again. |
| "Another program is answering instead of Coati's." | Something unauthenticated is listening on port 8787. | Find it: `ss -ltnp 'sport = :8787'` (Linux), `lsof -iTCP:8787 -sTCP:LISTEN` (macOS), `netstat -ano \| findstr 8787` (Windows). Stop it, restart the program. |
| "Coati's local program isn't responding." | The program is not running. | Linux: `systemctl --user status coati-broker`. macOS: read `~/Library/Logs/Coati/coati-broker.log`. Windows: run the installer again. |

## Development: installing from source

Linux, with [Bun](https://bun.sh) >= 1.4.2: `cd broker && bun install`, then `bun run start`
to run without the systemd service. Service: `bash scripts/install-service.sh`
(installs, enables and starts; rerun-safe). Useful: `systemctl --user status coati-broker`,
`journalctl --user -u coati-broker -n 100`, `systemctl --user stop coati-broker`.

Native host from source: `bash scripts/dev-native-host.sh` (Brave only) or `--all`;
`--uninstall` removes it. It writes a launcher at `~/.local/share/coati/dev-native-host/` that
runs the broker from source in host mode; pairing is then automatic.

Extension from source: build with `./scripts/build.sh`, or point the browser at the repo's
`extension/` folder as in "Load the extension".
