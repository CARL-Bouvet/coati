// Options page pure helpers: shortcut display (extension/lib/shortcut.js)
// and the code-fingerprint file list (extension/lib/build-fingerprint.js),
// which must stay identical to panel.js's and scripts/stamp.sh's copies.
import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "fs";
import { join } from "path";
import { shortcutKeys, actionShortcut } from "../../extension/lib/shortcut.js";
import { FINGERPRINT_FILES } from "../../extension/lib/build-fingerprint.js";
import { platformFromInfo, programDownloads } from "../../extension/lib/program-download.js";

const ROOT = join(import.meta.dir, "..", "..");

describe("shortcutKeys", () => {
  test("splits on '+' and names Shift 'Maj'", () => {
    expect(shortcutKeys("Alt+Shift+C")).toEqual(["Alt", "Maj", "C"]);
  });

  test("keeps Ctrl, maps macOS names", () => {
    expect(shortcutKeys("Ctrl+Shift+Y")).toEqual(["Ctrl", "Maj", "Y"]);
    expect(shortcutKeys("Command+MacCtrl+K")).toEqual(["Cmd", "Ctrl", "K"]);
  });

  test("a macOS symbol string stays one label", () => {
    expect(shortcutKeys("⌥⇧C")).toEqual(["⌥⇧C"]);
  });

  test("empty, blank or missing = no keys", () => {
    expect(shortcutKeys("")).toEqual([]);
    expect(shortcutKeys("   ")).toEqual([]);
    expect(shortcutKeys(undefined)).toEqual([]);
    expect(shortcutKeys(null)).toEqual([]);
  });
});

describe("actionShortcut", () => {
  test("picks _execute_action among other commands", () => {
    const commands = [
      { name: "other", shortcut: "Ctrl+Y" },
      { name: "_execute_action", shortcut: "Alt+Shift+C" },
    ];
    expect(actionShortcut(commands)).toBe("Alt+Shift+C");
  });

  test("absent entry, unset shortcut or bad input = ''", () => {
    expect(actionShortcut([{ name: "other", shortcut: "Ctrl+Y" }])).toBe("");
    expect(actionShortcut([{ name: "_execute_action" }])).toBe("");
    expect(actionShortcut(undefined)).toBe("");
  });
});

describe("program download mapping", () => {
  const BASE = "https://github.com/CARL-Bouvet/coati/releases/latest/download/";
  const files = (os: string | null, arch: string) => programDownloads(os, arch).map((d) => d.url.replace(BASE, ""));

  test("getPlatformInfo -> os and CPU family (Chrome 'arm64', Firefox 'arm')", () => {
    expect(platformFromInfo({ os: "win", arch: "x86-64" })).toEqual({ os: "windows", arch: "x64" });
    expect(platformFromInfo({ os: "mac", arch: "arm64" })).toEqual({ os: "mac", arch: "arm" });
    expect(platformFromInfo({ os: "mac", arch: "arm" })).toEqual({ os: "mac", arch: "arm" });
    expect(platformFromInfo({ os: "linux", arch: "aarch64" })).toEqual({ os: "linux", arch: "arm" });
    expect(platformFromInfo({ os: "android", arch: "arm64" }).os).toBeNull();
    expect(platformFromInfo(undefined)).toEqual({ os: null, arch: "x64" });
  });

  test("one button for Windows and macOS, two for Linux, none when unknown", () => {
    expect(files("windows", "x64")).toEqual(["Coati-Setup-windows-x64.exe"]);
    expect(files("windows", "arm")).toEqual(["Coati-Setup-windows-x64.exe"]);
    expect(files("mac", "arm")).toEqual(["Coati-Setup-macos-arm64.zip"]);
    expect(files("mac", "x64")).toEqual(["Coati-Setup-macos-x64.zip"]);
    expect(files("linux", "x64")).toEqual(["coati_amd64.deb", "coati-x86_64.rpm"]);
    expect(files("linux", "arm")).toEqual(["coati_arm64.deb", "coati-aarch64.rpm"]);
    expect(files(null, "x64")).toEqual([]);
  });
});

describe("FINGERPRINT_FILES parity", () => {
  test("panel.js imports the shared module instead of keeping its own copy", () => {
    const src = readFileSync(join(ROOT, "extension", "panel", "panel.js"), "utf8");
    expect(src).not.toMatch(/const FINGERPRINT_FILES = \[/);
    expect(src).toMatch(/from "\.\.\/lib\/build-fingerprint\.js"/);
  });

  test("every listed file exists", () => {
    for (const path of FINGERPRINT_FILES) {
      expect(existsSync(join(ROOT, "extension", path))).toBe(true);
    }
  });

  test("covers every code file of the extension (a new module cannot be forgotten)", () => {
    const onDisk = [...new Bun.Glob("**/*.{js,css,html,json}").scanSync(join(ROOT, "extension"))]
      .map((p) => p.replaceAll("\\", "/"))
      .filter((p) => !p.includes(".claude/") && p !== "manifest.firefox.json")
      .sort();
    expect([...FINGERPRINT_FILES].sort()).toEqual(onDisk);
  });

  test("same list and order as scripts/stamp.sh", () => {
    const src = readFileSync(join(ROOT, "scripts", "stamp.sh"), "utf8");
    const block = src.match(/FILES=\(([\s\S]*?)\)/);
    expect(block).not.toBeNull();
    const stampFiles = [...block![1].matchAll(/"([^"]+)"/g)].map((m) => m[1]);
    expect(stampFiles).toEqual(FINGERPRINT_FILES);
  });
});
