# Installing Coati

Coati has two pieces: the extension, in your browser, and the local program (`coati-broker`),
which runs on your computer and talks to the model. Supported browsers: Chrome, Chromium, Brave,
Edge, Firefox.

## Quick install

The files are not signed with a paid developer certificate, so your system warns you once.

| System | Install |
|---|---|
| Windows | [Coati-Setup-windows-x64.exe](https://github.com/CARL-Bouvet/coati/releases/latest/download/Coati-Setup-windows-x64.exe). SmartScreen shows "Windows protected your PC": click **More info**, then **Run anyway**. |
| macOS | The [script](#other-systems), or the zip: [Apple chip](https://github.com/CARL-Bouvet/coati/releases/latest/download/Coati-Setup-macos-arm64.zip), [Intel](https://github.com/CARL-Bouvet/coati/releases/latest/download/Coati-Setup-macos-x64.zip). Open the zip, double-click **Installer Coati**. |
| Ubuntu, Debian, Mint | `.deb` package, command below (`coati_arm64.deb` on ARM). |
| Fedora | `.rpm` package, command below (`coati-aarch64.rpm` on ARM). |
| openSUSE | `.rpm` package, command below. |
| Arch, Gentoo, other Linux | [Script](#other-systems). |

macOS refuses to open the installer the first time. On macOS 15, open System Settings → Privacy &
Security, scroll down, click **Open Anyway** and confirm. On macOS 14, right-click the file and
choose **Open**.

```sh
# Ubuntu, Debian, Mint
curl -LO https://github.com/CARL-Bouvet/coati/releases/latest/download/coati_amd64.deb && sudo apt install ./coati_amd64.deb

# Fedora
curl -LO https://github.com/CARL-Bouvet/coati/releases/latest/download/coati-x86_64.rpm && sudo dnf install ./coati-x86_64.rpm

# openSUSE
curl -LO https://github.com/CARL-Bouvet/coati/releases/latest/download/coati-x86_64.rpm && sudo zypper install ./coati-x86_64.rpm
```

The Linux packages install `/usr/bin/coati-broker` and a user service. If the program does not
answer right away, log out and in once, or run `systemctl --user enable --now coati-broker`.

<a id="other-systems"></a>

## Other Linux distributions and macOS (script)

Download the script, read it if you like, then run it. It checks the program's checksum and
installs for your user only, without sudo:

```sh
curl -fsSLO https://getcoati.com/install.sh
sh install.sh
```

One-liner alternative: `curl -fsSL https://getcoati.com/install.sh | sh`. Set `COATI_VERSION`
(for example `COATI_VERSION=v0.1.6 sh install.sh`) for a specific release. Extra arguments go to
the program: `sh install.sh --dry-run` prints what would change.

## Add the extension

**Chrome, Chromium, Brave, Edge**: add Coati from the
[Chrome Web Store](https://chromewebstore.google.com/detail/coati/hehlgipomfminodhahcjbencblepjhah).
Edge asks once to allow extensions from other stores.

Without the store, take `coati-chrome.zip` from the
[release assets](https://github.com/CARL-Bouvet/coati/releases/latest) and unzip it into a folder
you keep. Open the extensions page (`chrome://extensions`, `brave://extensions`,
`edge://extensions`), enable **Developer mode**, click **Load unpacked**, pick the folder. The id
matches the store's, so pairing works either way. Keep only one of the two installed.

**Firefox** needs a real `manifest.json` on disk, not a zip. Unzip `coati-firefox.zip`, open
`about:debugging#/runtime/this-firefox`, click **Load Temporary Add-on…** and pick the unzipped
`manifest.json`. It disappears on restart. Pairing is automatic for extension id
`coati@getcoati.com`. A Snap or Flatpak Firefox (Ubuntu's default) can't launch the native host:
see [Flatpak or Snap](#flatpak-or-snap).

## Pick a model

Default provider: **Ollama**, fully local (`http://127.0.0.1:11434`). Coati never picks a model
on its own; with none configured, the program refuses requests.

**Local model**: install [Ollama](https://ollama.com/download) or
[LM Studio](https://lmstudio.ai/download), then download a model by following the tool's own
guide ([Ollama](https://docs.ollama.com/quickstart),
[LM Studio](https://lmstudio.ai/docs/app/basics/download-model)). In the extension's settings
(Coati icon → **Open settings**, "On this computer" tab), the step-by-step guide connects Coati
to the tool; pick your model from the list. Coati sets the context window itself (8192 to 32768
tokens, depending on the model and your memory).

**Other providers**: Claude (your own Anthropic key) and OpenAI-compatible services (LM Studio,
OpenAI, Mistral, OpenRouter, DeepSeek, or any compatible address). Keys are stored by the local
program, never in the extension. For Ollama itself, prefer the **Ollama (local)** provider over
its `/v1` endpoint: through that endpoint Coati can't grow the reading window.

Which model fits your machine: see "Choosing a model" in the [README](../README.md#choosing-a-model).

Then click the Coati toolbar icon (or press `Alt+Shift+C`). A "Getting started" card shows three
checks (local program detected, model connected, page access granted). With the first two green,
ask a question about the page and grant site access when asked.

## Verify the download

Download `SHA256SUMS` from the same release, put it next to the file, and check. If the checksum
doesn't match, don't run the file. (`install.sh` does this for you.)

```sh
sha256sum -c SHA256SUMS --ignore-missing           # Linux
shasum -a 256 -c SHA256SUMS --ignore-missing       # macOS
```
```powershell
(Get-FileHash .\Coati-Setup-windows-x64.exe -Algorithm SHA256).Hash   # compare with its line in SHA256SUMS
```

## Update

Windows and macOS: run the new installer; it replaces the old version. Linux: install the new
package, or run the script again. Extension from the store: automatic. From a folder: replace
its contents and click **Reload** on the extensions page.

## Uninstall

- Windows: Settings → Apps → Coati → Uninstall.
- macOS: `"$HOME/Library/Application Support/Coati/coati-broker" --uninstall`
- Linux: remove the `coati` package, or for a script install run `~/.local/bin/coati-broker --uninstall`.

This stops the program and removes it, its service and the browser manifests. Your configuration
(`~/.config/coati`) and data, including keys (`~/.local/share/coati`), stay unless you add
`--purge`. On Windows, `~` is `%USERPROFILE%`.

## Advanced

`coati-broker` is one file that installs itself. Download `coati-broker-<os>-<arch>` (for example
`coati-broker-linux-x64`) and verify it as above, then `chmod +x` it and run it with a flag. With
no argument, a downloaded copy runs an interactive install.

| Flag | Effect |
|---|---|
| `--install` | Copy the program to your user folder, start it at login, declare it to your browsers. Safe to rerun. |
| `--system` | With `--install`: system-wide install (what the packages use). |
| `--prefix DIR` | With `--install`: install under `DIR`. |
| `--no-service` | With `--install`: don't start it at login. |
| `--all` | With `--install`: declare every supported browser, not only installed ones (Linux, macOS). |
| `--dry-run` | With `--install`: print what would change, change nothing. |
| `--uninstall` | Remove the program, its service and the manifests. |
| `--purge` | With `--uninstall`: also remove configuration and keys. |
| `--serve` | Run the program in the foreground. |

User install locations: `~/.local/bin/coati-broker` (Linux),
`~/Library/Application Support/Coati/` (macOS), `%LOCALAPPDATA%\Coati\` (Windows). At each start
the program rewrites its browser manifests, so a browser installed later is picked up after a
restart. It creates `~/.config/coati/config.json` and `~/.local/share/coati/` on first start.
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
| "Coati can't find its local program." | Not installed, browser installed after the program, blocked by the system warning, or a Flatpak/Snap browser. | Run the installer again and restart the browser. See [Flatpak or Snap](#flatpak-or-snap). |
| "The local program refused the connection." | Handshake rejected. The panel retries; **Retry** is available. | Restart the program. Hand-edited `config.json`: check `allowedExtensionIds`. Manual pairing: check `legacyPairing`, paste the secret again. |
| "Another program is answering instead of Coati's." | Something unauthenticated is listening on port 8787. | Find it: `ss -ltnp 'sport = :8787'` (Linux), `lsof -iTCP:8787 -sTCP:LISTEN` (macOS), `netstat -ano \| findstr 8787` (Windows). Stop it, restart the program. |
| "Coati's local program isn't responding." | The program is not running. | Linux: `systemctl --user status coati-broker`. macOS: read `~/Library/Logs/Coati/coati-broker.log`. Windows: run the installer again. |

## From source

Linux, with [Bun](https://bun.sh) >= 1.4.2: `cd broker && bun install`, then `bun run start`
to run without the systemd service. Service: `bash scripts/install-service.sh` (installs,
enables and starts; rerun-safe). Useful: `systemctl --user status coati-broker`,
`journalctl --user -u coati-broker -n 100`.

Native host from source: `bash scripts/dev-native-host.sh` (Brave only) or `--all`;
`--uninstall` removes it. It writes a launcher at `~/.local/share/coati/dev-native-host/` that
runs the broker from source; pairing is then automatic.

Extension from source: build with `./scripts/build.sh`, or point the browser at the repo's
`extension/` folder as in "Add the extension".
