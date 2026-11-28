// Direct-download links of the local program's installers, picked for the
// user's system. The file names carry no version, so "releases/latest/download"
// stays a stable address (scripts/package.sh builds them).

export const RELEASE_DOWNLOAD_BASE = "https://github.com/CARL-Bouvet/coati/releases/latest/download/";
export const INSTALL_DOC_URL = "https://github.com/CARL-Bouvet/coati/blob/main/docs/INSTALL.md#other-systems";

// kind -> file per CPU family. Windows ships x64 only (Windows on ARM runs it).
const FILES = {
  windows: { x64: "Coati-Setup-windows-x64.exe", arm: "Coati-Setup-windows-x64.exe" },
  mac: { x64: "Coati-Setup-macos-x64.zip", arm: "Coati-Setup-macos-arm64.zip" },
  deb: { x64: "coati_amd64.deb", arm: "coati_arm64.deb" },
  rpm: { x64: "coati-x86_64.rpm", arm: "coati-aarch64.rpm" },
};
const KINDS_BY_OS = { windows: ["windows"], mac: ["mac"], linux: ["deb", "rpm"] };

/** runtime.getPlatformInfo() -> { os: "windows"|"mac"|"linux"|null, arch: "arm"|"x64" }.
 * Chrome says "arm64", Firefox "arm" for any ARM; everything else is x64. */
export function platformFromInfo(info) {
  const os = { win: "windows", mac: "mac", linux: "linux" }[info?.os] ?? null;
  return { os, arch: /^(arm|aarch64)/i.test(String(info?.arch ?? "")) ? "arm" : "x64" };
}

/** The installer buttons for a system: [{ kind, file, url }] — one for
 * Windows and macOS, two for Linux (.deb, .rpm), none when the system is unknown. */
export function programDownloads(os, arch) {
  const family = arch === "arm" ? "arm" : "x64";
  return (KINDS_BY_OS[os] ?? []).map((kind) => {
    const file = FILES[kind][family];
    return { kind, file, url: RELEASE_DOWNLOAD_BASE + file };
  });
}

// Button labels and per-system help texts, shared by Settings (options/program-step.js)
// and the welcome page.
export const DOWNLOAD_LABELS = {
  windows: "setup_program_download_windows",
  mac_arm: "setup_program_download_mac_arm",
  mac_x64: "setup_program_download_mac_x64",
  deb: "setup_program_download_deb",
  rpm: "setup_program_download_rpm",
};
export const HELP_KEYS = {
  windows: ["setup_program_win_1", "setup_program_win_2", "setup_program_win_3"],
  mac: ["setup_program_mac_1", "setup_program_mac_2", "setup_program_mac_3", "setup_program_mac_4"],
  linux: ["setup_program_linux_1"],
};
