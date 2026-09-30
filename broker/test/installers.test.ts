// Tests for scripts/install/install-linux.sh + uninstall-linux.sh (and, when
// running on darwin, install-macos.sh + uninstall-macos.sh) — goal G4,
// docs/PROTOCOL.md "Amendement 2026-09-30 : Native Messaging".
//
// Runs the real installer against a fake --prefix (never the real HOME),
// with --no-service so no systemd/launchd call is made, then checks every
// file it wrote (binary, Native Messaging manifests — valid JSON, correct
// path, exact allowed_origins/allowed_extensions), then runs the uninstaller
// and checks everything is gone.

import { describe, expect, test, afterEach } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, chmodSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const REPO_ROOT = join(import.meta.dir, "..", "..");

function run(cmd: string[]): { code: number; stdout: string; stderr: string } {
  const proc = Bun.spawnSync(cmd, { cwd: REPO_ROOT, stdout: "pipe", stderr: "pipe" });
  return {
    code: proc.exitCode,
    stdout: proc.stdout.toString(),
    stderr: proc.stderr.toString(),
  };
}

function makeFakeBinary(dir: string): string {
  const path = join(dir, "coati-broker-fake");
  writeFileSync(path, "#!/bin/sh\necho fake\n");
  chmodSync(path, 0o755);
  return path;
}

// The POSIX installers are not meant for Windows (git-bash on a CI runner is
// not a target); Windows is covered by install-windows.ps1 in scripts/ci/e2e.sh.
const describePosix = process.platform === "win32" ? describe.skip : describe;

describePosix("install-linux.sh / uninstall-linux.sh", () => {
  let dir: string;

  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  test("--all writes the binary and every Native Messaging manifest, valid JSON", () => {
    dir = mkdtempSync(join(tmpdir(), "coati-install-linux-"));
    const prefix = join(dir, "home");
    const binary = makeFakeBinary(dir);

    const install = run([
      "bash",
      join(REPO_ROOT, "scripts/install/install-linux.sh"),
      binary,
      "--prefix",
      prefix,
      "--no-service",
      "--all",
    ]);
    expect(install.code).toBe(0);

    const binDest = join(prefix, ".local/bin/coati-broker");
    expect(existsSync(binDest)).toBe(true);

    const manifestDirs: Record<string, string> = {
      chrome: ".config/google-chrome/NativeMessagingHosts",
      chromium: ".config/chromium/NativeMessagingHosts",
      brave: ".config/BraveSoftware/Brave-Browser/NativeMessagingHosts",
      edge: ".config/microsoft-edge/NativeMessagingHosts",
      firefox: ".mozilla/native-messaging-hosts",
    };

    for (const [browser, subdir] of Object.entries(manifestDirs)) {
      const manifestPath = join(prefix, subdir, "com.getcoati.broker.json");
      expect(existsSync(manifestPath)).toBe(true);
      const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
      expect(manifest.name).toBe("com.getcoati.broker");
      expect(manifest.path).toBe(binDest);
      expect(manifest.type).toBe("stdio");
      if (browser === "firefox") {
        expect(manifest.allowed_extensions).toEqual(["coati@getcoati.com"]);
        expect(manifest.allowed_origins).toBeUndefined();
      } else {
        expect(manifest.allowed_origins).toEqual(["chrome-extension://hehlgipomfminodhahcjbencblepjhah/"]);
        expect(manifest.allowed_extensions).toBeUndefined();
      }
    }

    const uninstall = run([
      "bash",
      join(REPO_ROOT, "scripts/install/uninstall-linux.sh"),
      "--prefix",
      prefix,
      "--no-service",
    ]);
    expect(uninstall.code).toBe(0);

    expect(existsSync(binDest)).toBe(false);
    for (const subdir of Object.values(manifestDirs)) {
      expect(existsSync(join(prefix, subdir, "com.getcoati.broker.json"))).toBe(false);
    }
  });

  test("without --all, only a browser whose config dir already exists gets a manifest", () => {
    dir = mkdtempSync(join(tmpdir(), "coati-install-linux-"));
    const prefix = join(dir, "home");
    const binary = makeFakeBinary(dir);

    // Pre-create only Brave's config dir.
    const braveConfigDir = join(prefix, ".config/BraveSoftware/Brave-Browser");
    const { mkdirSync } = require("node:fs");
    mkdirSync(braveConfigDir, { recursive: true });

    const install = run([
      "bash",
      join(REPO_ROOT, "scripts/install/install-linux.sh"),
      binary,
      "--prefix",
      prefix,
      "--no-service",
    ]);
    expect(install.code).toBe(0);

    expect(existsSync(join(prefix, ".config/BraveSoftware/Brave-Browser/NativeMessagingHosts/com.getcoati.broker.json"))).toBe(true);
    expect(existsSync(join(prefix, ".config/google-chrome/NativeMessagingHosts/com.getcoati.broker.json"))).toBe(false);
    expect(existsSync(join(prefix, ".mozilla/native-messaging-hosts/com.getcoati.broker.json"))).toBe(false);
  });

  test("--dry-run writes nothing", () => {
    dir = mkdtempSync(join(tmpdir(), "coati-install-linux-"));
    const prefix = join(dir, "home");
    const binary = makeFakeBinary(dir);

    const install = run([
      "bash",
      join(REPO_ROOT, "scripts/install/install-linux.sh"),
      binary,
      "--prefix",
      prefix,
      "--no-service",
      "--all",
      "--dry-run",
    ]);
    expect(install.code).toBe(0);
    expect(install.stdout).toContain("[dry-run]");
    expect(existsSync(join(prefix, ".local/bin/coati-broker"))).toBe(false);
    expect(existsSync(join(prefix, ".config"))).toBe(false);
  });

  test("--prefix with a space, & and # still produces a valid manifest holding the exact path (final security review)", () => {
    dir = mkdtempSync(join(tmpdir(), "coati-install-linux-"));
    // Exercises lib.sh's render_manifest against bash 5.2+'s
    // patsub_replacement `&` behaviour and a literal `#` in the substituted
    // path — see lib.sh's sed_escape_replacement/render_manifest comments.
    const prefix = join(dir, "home dir & co #1");
    const binary = makeFakeBinary(dir);

    const install = run([
      "bash",
      join(REPO_ROOT, "scripts/install/install-linux.sh"),
      binary,
      "--prefix",
      prefix,
      "--no-service",
      "--all",
    ]);
    expect(install.code).toBe(0);

    const binDest = join(prefix, ".local/bin/coati-broker");
    const manifestPath = join(prefix, ".config/google-chrome/NativeMessagingHosts/com.getcoati.broker.json");
    const raw = readFileSync(manifestPath, "utf8");
    const manifest = JSON.parse(raw); // throws if render_manifest produced broken JSON
    expect(manifest.path).toBe(binDest);
  });

  test("install is idempotent: running it twice produces the same manifest", () => {
    dir = mkdtempSync(join(tmpdir(), "coati-install-linux-"));
    const prefix = join(dir, "home");
    const binary = makeFakeBinary(dir);

    for (let i = 0; i < 2; i++) {
      const install = run([
        "bash",
        join(REPO_ROOT, "scripts/install/install-linux.sh"),
        binary,
        "--prefix",
        prefix,
        "--no-service",
        "--all",
      ]);
      expect(install.code).toBe(0);
    }

    const manifestPath = join(prefix, ".config/google-chrome/NativeMessagingHosts/com.getcoati.broker.json");
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    expect(manifest.path).toBe(join(prefix, ".local/bin/coati-broker"));
  });
});

describe("install-macos.sh / uninstall-macos.sh", () => {
  let dir: string;

  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  const maybeTest = process.platform === "darwin" ? test : test.skip;

  maybeTest("--all writes the binary and every Native Messaging manifest, valid JSON", () => {
    dir = mkdtempSync(join(tmpdir(), "coati-install-macos-"));
    const prefix = join(dir, "home");
    const binary = makeFakeBinary(dir);

    const install = run([
      "bash",
      join(REPO_ROOT, "scripts/install/install-macos.sh"),
      binary,
      "--prefix",
      prefix,
      "--no-service",
      "--all",
    ]);
    expect(install.code).toBe(0);

    const binDest = join(prefix, "Library/Application Support/Coati/coati-broker");
    expect(existsSync(binDest)).toBe(true);

    const manifestPath = join(
      prefix,
      "Library/Application Support/Google/Chrome/NativeMessagingHosts/com.getcoati.broker.json",
    );
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    expect(manifest.path).toBe(binDest);
    expect(manifest.allowed_origins).toEqual(["chrome-extension://hehlgipomfminodhahcjbencblepjhah/"]);

    const uninstall = run([
      "bash",
      join(REPO_ROOT, "scripts/install/uninstall-macos.sh"),
      "--prefix",
      prefix,
      "--no-service",
    ]);
    expect(uninstall.code).toBe(0);
    expect(existsSync(binDest)).toBe(false);
    expect(existsSync(manifestPath)).toBe(false);
  });

  maybeTest(
    "--prefix with a space, & and # still produces a valid manifest and plist (final security review)",
    () => {
      dir = mkdtempSync(join(tmpdir(), "coati-install-macos-"));
      const prefix = join(dir, "home dir & co #1");
      const binary = makeFakeBinary(dir);

      const install = run([
        "bash",
        join(REPO_ROOT, "scripts/install/install-macos.sh"),
        binary,
        "--prefix",
        prefix,
        "--no-service",
        "--all",
      ]);
      expect(install.code).toBe(0);

      const binDest = join(prefix, "Library/Application Support/Coati/coati-broker");
      const manifestPath = join(
        prefix,
        "Library/Application Support/Google/Chrome/NativeMessagingHosts/com.getcoati.broker.json",
      );
      const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
      expect(manifest.path).toBe(binDest);

      // --no-service skips the plist entirely (install-macos.sh), so render
      // it directly here to exercise the same xml_escape/sed_escape_replacement
      // path the real (non---no-service) install would use, and validate the
      // XML with plutil — macOS-only tool, hence maybeTest gating this whole
      // block on darwin already.
      const plistProc = Bun.spawnSync(
        ["bash", "-c", `. "${join(REPO_ROOT, "scripts/install/lib.sh")}" ; xml_escape "$1"`, "_", binDest],
        { cwd: REPO_ROOT },
      );
      const escaped = plistProc.stdout.toString().trim();
      const plistSrc = readFileSync(join(REPO_ROOT, "packaging/com.getcoati.broker.plist"), "utf8");
      const rendered = plistSrc.replace(/@@BINARY_PATH@@/g, escaped).replace(/@@LOG_DIR@@/g, escaped);
      const plistPath = join(dir, "rendered.plist");
      writeFileSync(plistPath, rendered);
      const plutil = run(["plutil", "-lint", plistPath]);
      expect(plutil.code).toBe(0);
    },
  );
});

describe("install-windows.ps1 / uninstall-windows.ps1 — syntax only", () => {
  const pwsh = Bun.which("pwsh");
  const maybeTest = pwsh ? test : test.skip;

  maybeTest("install-windows.ps1 parses without error", () => {
    const result = run([
      "pwsh",
      "-NoProfile",
      "-Command",
      `$errors = $null; $null = [System.Management.Automation.Language.Parser]::ParseFile('${join(REPO_ROOT, "scripts/install/install-windows.ps1")}', [ref]$null, [ref]$errors); if ($errors.Count -gt 0) { $errors | ForEach-Object { Write-Error $_ }; exit 1 }`,
    ]);
    expect(result.code).toBe(0);
  });

  maybeTest("uninstall-windows.ps1 parses without error", () => {
    const result = run([
      "pwsh",
      "-NoProfile",
      "-Command",
      `$errors = $null; $null = [System.Management.Automation.Language.Parser]::ParseFile('${join(REPO_ROOT, "scripts/install/uninstall-windows.ps1")}', [ref]$null, [ref]$errors); if ($errors.Count -gt 0) { $errors | ForEach-Object { Write-Error $_ }; exit 1 }`,
    ]);
    expect(result.code).toBe(0);
  });
});
