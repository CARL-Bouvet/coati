// Pure install/uninstall planning: inputs (OS, home, executable, detected
// browsers, mode) -> an ordered list of actions. Nothing here touches the
// disk or spawns a process; apply.ts executes the list.

import { posix, win32 } from "node:path";
import { FIXED_PORT } from "../config.ts";
import chromiumManifest from "../../../packaging/native-host/com.getcoati.broker.chromium.json";
import firefoxManifest from "../../../packaging/native-host/com.getcoati.broker.firefox.json";
import unitTemplate from "../../../packaging/coati-broker-binary.service" with { type: "text" };
import plistTemplate from "../../../packaging/com.getcoati.broker.plist" with { type: "text" };

export const HOST_NAME = "com.getcoati.broker";
const TASK_NAME = "CoatiBroker";
const WIN_CURRENT = "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\";
const RUN_KEY = WIN_CURRENT + "Run";
const UNINSTALL_KEY = WIN_CURRENT + "Uninstall\\Coati";

export type Os = "linux" | "darwin" | "win32";
export type Family = "chromium" | "firefox";

export type Action =
  | { kind: "mkdir"; path: string; mode: number }
  | { kind: "write"; path: string; content: string; mode: number }
  | { kind: "copy"; from: string; to: string }
  | { kind: "remove"; path: string; recursive?: boolean }
  // Skipped when `from` is missing; an existing `to` is replaced.
  | { kind: "rename"; from: string; to: string }
  // Stops the broker named in broker-key.json (only if that process is a
  // coati-broker), then waits, bounded, for `port` to be free.
  | { kind: "stop-broker"; dataDir: string; port: number }
  // A plain-English progress line for the user.
  | { kind: "say"; text: string }
  // `optional`: a failure (or a missing tool) is ignored, logged when `warn`.
  // `detached`: started and left running.
  | { kind: "run"; cmd: string[]; optional?: boolean; warn?: boolean; detached?: boolean };

export interface Env {
  os: Os;
  home: string;
  /** Windows only; defaults to <home>\AppData\Local. */
  localAppData?: string;
  /** Replaces the home (POSIX) or LocalAppData (Windows) root. */
  prefix?: string;
  uid?: number;
  /** Windows only: DOMAIN\name, granted access by icacls. */
  user?: string;
}

export interface InstallOpts extends Env {
  /** The executable being installed. */
  exe: string;
  system: boolean;
  service: boolean;
  all: boolean;
  /** Browsers whose config dir exists (see detectBrowsers). */
  detected: ReadonlySet<string>;
  /** Windows Uninstall entry: package version and executable size in KB. */
  version?: string;
  sizeKb?: number;
}

export interface UninstallOpts extends Env {
  /** The running executable: on Windows an installed one cannot delete itself. */
  selfExe?: string;
  system: boolean;
  service: boolean;
  purge: boolean;
  configDir: string;
  dataDir: string;
}

// [name, family, config dir, native-messaging dir (default: <config>/NativeMessagingHosts)],
// all relative to the root.
type BrowserRow = readonly [string, Family, string, string?];
const MAC_SUPPORT = "Library/Application Support/";
const BROWSERS: Record<"linux" | "darwin", readonly BrowserRow[]> = {
  linux: [
    ["chrome", "chromium", ".config/google-chrome"],
    ["chromium", "chromium", ".config/chromium"],
    ["brave", "chromium", ".config/BraveSoftware/Brave-Browser"],
    ["edge", "chromium", ".config/microsoft-edge"],
    ["firefox", "firefox", ".mozilla", ".mozilla/native-messaging-hosts"],
  ],
  darwin: [
    ["chrome", "chromium", MAC_SUPPORT + "Google/Chrome"],
    ["chromium", "chromium", MAC_SUPPORT + "Chromium"],
    ["brave", "chromium", MAC_SUPPORT + "BraveSoftware/Brave-Browser"],
    ["edge", "chromium", MAC_SUPPORT + "Microsoft Edge"],
    ["firefox", "firefox", MAC_SUPPORT + "Mozilla"],
  ],
};

// HKCU\Software\<sub>\NativeMessagingHosts\<host>
const WIN_BROWSERS: readonly (readonly [Family, string])[] = [
  ["chromium", "Google\\Chrome"],
  ["chromium", "Chromium"],
  ["chromium", "BraveSoftware\\Brave-Browser"],
  ["chromium", "Microsoft\\Edge"],
  ["firefox", "Mozilla"],
];

// System-wide manifest dirs (Linux packages). Brave builds without Google
// branding and reads the Chromium directory.
const SYSTEM_NMH: readonly (readonly [Family, string])[] = [
  ["chromium", "/etc/opt/chrome/native-messaging-hosts"],
  ["chromium", "/etc/chromium/native-messaging-hosts"],
  ["chromium", "/etc/opt/edge/native-messaging-hosts"],
  ["firefox", "/usr/lib/mozilla/native-messaging-hosts"],
  ["firefox", "/usr/lib64/mozilla/native-messaging-hosts"],
];
const SYSTEM_EXE = "/usr/bin/coati-broker";
const SYSTEM_UNIT = "/usr/lib/systemd/user/coati-broker.service";

const pathOf = (os: Os) => (os === "win32" ? win32 : posix);

// --- escaping -----------------------------------------------------------

export const xmlEscape = (s: string): string =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** For a double-quoted ExecStart= argument: `\` and `"` C-escaped, `%` and `$` doubled. */
export const systemdEscape = (s: string): string =>
  s.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/%/g, "%%").replace(/\$/g, "$$$$");

// Function replacers: the replacement is never interpreted (`$&`, `$1`).
const fill = (template: string, values: Record<string, string>): string =>
  template.replace(/@@([A-Z_]+)@@/g, (m, k: string) => values[k] ?? m);

export function renderManifest(family: Family, exe: string): string {
  const base = family === "firefox" ? firefoxManifest : chromiumManifest;
  return JSON.stringify({ ...base, path: exe }, null, 2) + "\n";
}

export const renderUnit = (exe: string): string =>
  fill(unitTemplate, { BINARY_PATH: systemdEscape(exe) });

export const renderPlist = (exe: string, logDir: string): string =>
  fill(plistTemplate, { BINARY_PATH: xmlEscape(exe), LOG_DIR: xmlEscape(logDir) });

// --- layout -------------------------------------------------------------

function root(e: Env): string {
  if (e.prefix) return e.prefix;
  return e.os === "win32" ? (e.localAppData ?? win32.join(e.home, "AppData", "Local")) : e.home;
}

/** Where `--install` puts the executable. */
export function installedExe(e: Env, system = false): string {
  if (system) return SYSTEM_EXE;
  const p = pathOf(e.os);
  if (e.os === "win32") return p.join(root(e), "Coati", "coati-broker.exe");
  if (e.os === "darwin") return p.join(root(e), MAC_SUPPORT + "Coati", "coati-broker");
  return p.join(root(e), ".local", "bin", "coati-broker");
}

export function isInstalledExe(e: Env, exe: string): boolean {
  const norm = (s: string) => (e.os === "win32" ? win32.normalize(s).toLowerCase() : posix.normalize(s));
  const places = [installedExe(e)];
  if (e.os === "linux") places.push(SYSTEM_EXE);
  return places.some((p) => norm(p) === norm(exe));
}

/** True for the path of a coati-broker executable (any OS separator). */
export const isBrokerImage = (path: string): boolean => /(^|[\\/])coati-broker[^\\/]*$/i.test(path);

/** A compiled binary is not the bun runtime itself. */
export const isCompiledExe = (execPath: string): boolean => !/(^|[\\/])bun(\.exe)?$/i.test(execPath);

/** Browsers (Linux/macOS) whose config dir exists under the root. */
export function detectBrowsers(e: Env, exists: (p: string) => boolean): Set<string> {
  if (e.os === "win32") return new Set();
  const p = pathOf(e.os);
  return new Set(BROWSERS[e.os].filter((b) => exists(p.join(root(e), b[2]))).map((b) => b[0]));
}

// --- mode and flags -----------------------------------------------------

export type Mode = "serve" | "install" | "uninstall";

export interface Cli {
  system: boolean;
  prefix?: string;
  service: boolean;
  all: boolean;
  dryRun: boolean;
  purge: boolean;
}

export function parseCli(args: readonly string[]): Cli {
  const i = args.findIndex((a) => a === "--prefix" || a.startsWith("--prefix="));
  let prefix: string | undefined;
  if (i >= 0) {
    prefix = args[i]!.startsWith("--prefix=") ? args[i]!.slice("--prefix=".length) : args[i + 1];
    if (!prefix || prefix.startsWith("--")) throw new Error("--prefix needs a directory");
  }
  return {
    system: args.includes("--system"),
    prefix,
    service: !args.includes("--no-service"),
    all: args.includes("--all"),
    dryRun: args.includes("--dry-run"),
    purge: args.includes("--purge"),
  };
}

/** Explicit flags win. Without any, a compiled binary installs itself unless it already runs from its installed place. */
export function selectMode(args: readonly string[], ctx: { compiled: boolean; installed: boolean }): Mode {
  if (args.includes("--uninstall")) return "uninstall";
  if (args.includes("--install")) return "install";
  if (args.includes("--serve")) return "serve";
  return ctx.compiled && !ctx.installed ? "install" : "serve";
}

/** Only a bare double-click gets the "press Enter" console flow; scripts and CI pass flags or have no terminal. */
export const wantsPrompt = (args: readonly string[], mode: Mode, tty: boolean): boolean =>
  mode === "install" && args.length === 0 && tty;

// --- install ------------------------------------------------------------

/** Per-user manifests (Linux/macOS) for every wanted browser. */
export function planUserManifests(e: Env, exe: string, detected: ReadonlySet<string>, all: boolean): Action[] {
  if (e.os === "win32") return [];
  const p = pathOf(e.os);
  return BROWSERS[e.os]
    .filter((b) => all || detected.has(b[0]))
    .flatMap(([, family, config, nmh]): Action[] => {
      const dir = p.join(root(e), nmh ?? config + "/NativeMessagingHosts");
      return [
        { kind: "mkdir", path: dir, mode: 0o700 },
        { kind: "write", path: p.join(dir, HOST_NAME + ".json"), content: renderManifest(family, exe), mode: 0o644 },
      ];
    });
}

export function planInstall(o: InstallOpts): Action[] {
  const p = pathOf(o.os);
  const r = root(o);
  const dest = o.system ? o.exe : installedExe(o);
  const appDir = p.dirname(dest);
  const acts: Action[] = [];
  const run = (cmd: string[], opts: { optional?: boolean; warn?: boolean } = {}) => void acts.push({ kind: "run", cmd, ...opts });
  const say = (text: string) => void acts.push({ kind: "say", text });
  const plist = p.join(r, "Library", "LaunchAgents", HOST_NAME + ".plist");
  const domain = `gui/${o.uid ?? 501}`;

  // An older broker may be running: its service first, then any stray process.
  // (A running Windows exe cannot be overwritten, only renamed: see below.)
  if (!o.system && !o.prefix) {
    say("Stopping the previous version, if there is one");
    if (o.service && o.os === "linux") run(["systemctl", "--user", "stop", "coati-broker"], { optional: true });
    if (o.service && o.os === "darwin") run(["launchctl", "bootout", domain, plist], { optional: true });
    acts.push({ kind: "stop-broker", dataDir: dataDirOf(o), port: FIXED_PORT });
  }

  if (!o.system) {
    acts.push({ kind: "mkdir", path: appDir, mode: 0o755 });
    if (p.normalize(dest) !== p.normalize(o.exe)) {
      say(`Copying Coati to ${appDir}`);
      if (o.os === "win32") acts.push({ kind: "rename", from: dest, to: dest + ".old" });
      acts.push({ kind: "copy", from: o.exe, to: dest });
    }
  }

  if (o.os === "linux") {
    if (o.service) {
      const unit = o.system ? SYSTEM_UNIT : p.join(r, ".config", "systemd", "user", "coati-broker.service");
      acts.push({ kind: "mkdir", path: p.dirname(unit), mode: 0o755 });
      if (!o.system) {
        for (const d of [".config/coati", ".local/share/coati"]) acts.push({ kind: "mkdir", path: p.join(r, d), mode: 0o700 });
      }
      acts.push({ kind: "write", path: unit, content: renderUnit(dest), mode: 0o644 });
      if (o.system) {
        // No systemd (container, chroot): the unit file is still in place.
        run(["systemctl", "--global", "enable", "coati-broker"], { optional: true, warn: true });
      } else {
        say("Setting Coati to start when you sign in");
        run(["systemctl", "--user", "daemon-reload"]);
        run(["systemctl", "--user", "enable", "coati-broker"]);
        run(["systemctl", "--user", "restart", "coati-broker"]);
      }
    }
    if (o.system) {
      for (const [family, dir] of SYSTEM_NMH) {
        acts.push({ kind: "mkdir", path: dir, mode: 0o755 });
        acts.push({ kind: "write", path: p.join(dir, HOST_NAME + ".json"), content: renderManifest(family, dest), mode: 0o644 });
      }
    } else {
      say("Connecting Coati to your browsers");
      acts.push(...planUserManifests(o, dest, o.detected, o.all));
    }
  } else if (o.os === "darwin") {
    say("Allowing Coati to run");
    run(["xattr", "-d", "com.apple.quarantine", dest], { optional: true });
    run(["codesign", "-s", "-", "--force", dest], { optional: true, warn: true });
    if (o.service) {
      const logDir = p.join(r, "Library", "Logs", "Coati");
      say("Setting Coati to start when you sign in");
      acts.push({ kind: "mkdir", path: p.dirname(plist), mode: 0o755 });
      acts.push({ kind: "mkdir", path: logDir, mode: 0o755 });
      acts.push({ kind: "write", path: plist, content: renderPlist(dest, logDir), mode: 0o644 });
      run(["launchctl", "bootstrap", domain, plist]);
    }
    say("Connecting Coati to your browsers");
    acts.push(...planUserManifests(o, dest, o.detected, o.all));
  } else {
    const nmhDir = p.join(appDir, "native-host");
    say("Connecting Coati to your browsers");
    acts.push({ kind: "remove", path: dest + ":Zone.Identifier" });
    acts.push({ kind: "mkdir", path: nmhDir, mode: 0o700 });
    const files: Record<Family, string> = {
      chromium: p.join(nmhDir, HOST_NAME + ".chromium.json"),
      firefox: p.join(nmhDir, HOST_NAME + ".firefox.json"),
    };
    for (const family of ["chromium", "firefox"] as const) {
      acts.push({ kind: "write", path: files[family], content: renderManifest(family, dest), mode: 0o644 });
    }
    for (const [family, sub] of WIN_BROWSERS) {
      run(["reg.exe", "add", winKey(sub), "/ve", "/t", "REG_SZ", "/d", files[family], "/f"]);
    }
    for (const d of [dataDirOf(o), p.join(o.home, ".config", "coati")]) {
      acts.push({ kind: "mkdir", path: d, mode: 0o700 });
      // Without the user's own name the user would lock themselves out.
      if (o.user) {
        const grants = [o.user, "*S-1-5-18", "*S-1-5-32-544"];
        run(["icacls.exe", d, "/inheritance:r", ...grants.flatMap((g) => ["/grant:r", `${g}:(OI)(CI)F`])]);
      }
    }
    // Settings > Apps > Coati; its uninstall command runs the installed exe.
    const entry: [string, string, string | undefined][] = [
      ["DisplayName", "REG_SZ", "Coati"],
      ["DisplayVersion", "REG_SZ", o.version],
      ["Publisher", "REG_SZ", "Coati"],
      ["InstallLocation", "REG_SZ", appDir],
      ["DisplayIcon", "REG_SZ", dest],
      ["UninstallString", "REG_SZ", `"${dest}" --uninstall`],
      ["NoModify", "REG_DWORD", "1"],
      ["NoRepair", "REG_DWORD", "1"],
      ["EstimatedSize", "REG_DWORD", o.sizeKb === undefined ? undefined : String(o.sizeKb)],
    ];
    for (const [name, type, data] of entry) {
      if (data !== undefined) run(["reg.exe", "add", UNINSTALL_KEY, "/v", name, "/t", type, "/d", data, "/f"]);
    }
    if (o.service) {
      say("Starting Coati");
      run(["schtasks.exe", "/Delete", "/TN", TASK_NAME, "/F"], { optional: true });
      run(["reg.exe", "add", RUN_KEY, "/v", "Coati", "/t", "REG_SZ", "/d", `"${dest}" --serve`, "/f"]);
      acts.push({ kind: "run", cmd: [dest, "--serve"], detached: true });
    }
  }
  return acts;
}

/** The data dir the broker uses (config.ts defaultDirs). */
const dataDirOf = (e: Env): string => pathOf(e.os).join(e.os === "win32" ? e.home : root(e), ".local", "share", "coati");

/**
 * Batch file run detached after the uninstaller exits: retries (bounded) until
 * the exe is unlocked, then removes the install dir and itself. Paths are
 * quoted for cmd, `%` doubled for batch.
 */
export function renderDeferredDelete(exe: string, dir: string): string {
  const q = (s: string) => `"${s.replace(/%/g, "%%")}"`;
  return [
    "@echo off",
    "set n=0",
    ":retry",
    "ping -n 2 127.0.0.1 >nul",
    `del /f /q ${q(exe)} >nul 2>&1`,
    "set /a n+=1",
    `if exist ${q(exe)} if %n% lss 30 goto retry`,
    `rmdir /s /q ${q(dir)} >nul 2>&1`,
    'del "%~f0"',
    "",
  ].join("\r\n");
}

const winKey = (sub: string): string => `HKCU\\Software\\${sub}\\NativeMessagingHosts\\${HOST_NAME}`;

// --- uninstall ----------------------------------------------------------

const selfDeletes = (o: UninstallOpts, exe: string): boolean =>
  o.os === "win32" && !!o.selfExe && win32.normalize(o.selfExe).toLowerCase() === win32.normalize(exe).toLowerCase();

export function planUninstall(o: UninstallOpts): Action[] {
  const p = pathOf(o.os);
  const r = root(o);
  const acts: Action[] = [{ kind: "say", text: "Removing Coati" }];
  const run = (cmd: string[]) => void acts.push({ kind: "run", cmd, optional: true });
  const rm = (path: string) => void acts.push({ kind: "remove", path });
  const exe = o.system ? undefined : installedExe(o);

  if (o.os === "linux") {
    const unit = o.system ? SYSTEM_UNIT : p.join(r, ".config", "systemd", "user", "coati-broker.service");
    if (o.service) run(o.system ? ["systemctl", "--global", "disable", "coati-broker"] : ["systemctl", "--user", "disable", "--now", "coati-broker"]);
    rm(unit);
    if (o.service && !o.system) run(["systemctl", "--user", "daemon-reload"]);
    if (o.system) SYSTEM_NMH.forEach(([, dir]) => rm(p.join(dir, HOST_NAME + ".json")));
    else BROWSERS.linux.forEach(([, , config, nmh]) => rm(p.join(r, nmh ?? config + "/NativeMessagingHosts", HOST_NAME + ".json")));
  } else if (o.os === "darwin") {
    const plist = p.join(r, "Library", "LaunchAgents", HOST_NAME + ".plist");
    if (o.service) run(["launchctl", "bootout", `gui/${o.uid ?? 501}`, plist]);
    rm(plist);
    BROWSERS.darwin.forEach(([, , config, nmh]) => rm(p.join(r, nmh ?? config + "/NativeMessagingHosts", HOST_NAME + ".json")));
    if (o.purge) acts.push({ kind: "remove", path: p.join(r, "Library", "Logs", "Coati"), recursive: true });
  } else {
    if (o.service) {
      run(["schtasks.exe", "/Delete", "/TN", TASK_NAME, "/F"]);
      run(["reg.exe", "delete", RUN_KEY, "/v", "Coati", "/f"]);
    }
    run(["reg.exe", "delete", UNINSTALL_KEY, "/f"]);
    WIN_BROWSERS.forEach(([, sub]) => run(["reg.exe", "delete", winKey(sub), "/f"]));
    for (const family of ["chromium", "firefox"]) rm(p.join(p.dirname(exe!), "native-host", `${HOST_NAME}.${family}.json`));
  }
  if (!o.system && !o.prefix) acts.push({ kind: "stop-broker", dataDir: o.dataDir, port: FIXED_PORT });
  if (exe && selfDeletes(o, exe)) {
    // A running exe cannot delete itself: a detached script does it once this process has exited.
    const dir = p.dirname(exe);
    const script = p.join(p.dirname(dir), "coati-uninstall.cmd");
    acts.push({ kind: "write", path: script, content: renderDeferredDelete(exe, dir), mode: 0o644 });
    acts.push({ kind: "run", cmd: ["cmd.exe", "/d", "/c", script], detached: true });
  } else if (exe) {
    rm(exe);
  }
  if (o.purge) {
    acts.push({ kind: "remove", path: o.configDir, recursive: true });
    acts.push({ kind: "remove", path: o.dataDir, recursive: true });
  }
  return acts;
}
