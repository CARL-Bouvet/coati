// Options page pure helpers: shortcut display (extension/lib/shortcut.js)
// and the code-fingerprint file list (extension/lib/build-fingerprint.js),
// which must stay identical to panel.js's and scripts/stamp.sh's copies.
import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "fs";
import { join } from "path";
import { shortcutKeys, actionShortcut } from "../../extension/lib/shortcut.js";
import { FINGERPRINT_FILES } from "../../extension/lib/build-fingerprint.js";

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

  test("same list and order as scripts/stamp.sh", () => {
    const src = readFileSync(join(ROOT, "scripts", "stamp.sh"), "utf8");
    const block = src.match(/FILES=\(([\s\S]*?)\)/);
    expect(block).not.toBeNull();
    const stampFiles = [...block![1].matchAll(/"([^"]+)"/g)].map((m) => m[1]);
    expect(stampFiles).toEqual(FINGERPRINT_FILES);
  });
});
