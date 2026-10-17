// Tests for broker/src/install/: pure plans (paths per OS, escaping, mode
// selection) and the real apply/uninstall against a throwaway prefix.

import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyActions, currentEnv, syncUserManifests } from "../src/install/apply.ts";
import { runUninstall } from "../src/install/uninstall.ts";
import {
  type Action,
  type InstallOpts,
  detectBrowsers,
  installedExe,
  isCompiledExe,
  isInstalledExe,
  parseCli,
  planInstall,
  isBrokerImage,
  planUninstall,
  renderDeferredDelete,
  renderPlist,
  renderUnit,
  selectMode,
  wantsPrompt,
} from "../src/install/plan.ts";

const CHROME_ORIGIN = "chrome-extension://hehlgipomfminodhahcjbencblepjhah/";
const NASTY = 'home dir & "q" \\ %1 $x #1';

const base = (o: Partial<InstallOpts>): InstallOpts => ({
  os: "linux",
  home: "/home/u",
  exe: "/tmp/dl/coati-broker",
  system: false,
  service: true,
  all: false,
  detected: new Set(),
  ...o,
});
const writes = (a: Action[]) => a.filter((x): x is Extract<Action, { kind: "write" }> => x.kind === "write");
const cmds = (a: Action[]) => a.filter((x) => x.kind === "run").map((x) => (x as { cmd: string[] }).cmd.join(" "));

describe("plan: Linux", () => {
  test("user install: binary, unit with --serve, systemctl, only detected browsers", () => {
    const a = planInstall(base({ detected: new Set(["brave"]) }));
    expect(a).toContainEqual({ kind: "copy", from: "/tmp/dl/coati-broker", to: "/home/u/.local/bin/coati-broker" });
    const unit = writes(a).find((w) => w.path === "/home/u/.config/systemd/user/coati-broker.service")!;
    expect(unit.content).toContain('ExecStart="/home/u/.local/bin/coati-broker" --serve');
    expect(cmds(a)).toEqual([
      "systemctl --user stop coati-broker",
      "systemctl --user daemon-reload",
      "systemctl --user enable coati-broker",
      "systemctl --user restart coati-broker",
    ]);
    const manifests = writes(a).filter((w) => w.path.endsWith("com.getcoati.broker.json"));
    expect(manifests.map((m) => m.path)).toEqual([
      "/home/u/.config/BraveSoftware/Brave-Browser/NativeMessagingHosts/com.getcoati.broker.json",
    ]);
  });

  test("--all covers every browser; --no-service has no unit and no command", () => {
    const a = planInstall(base({ all: true, service: false }));
    expect(writes(a)).toHaveLength(5);
    expect(cmds(a)).toEqual([]);
  });

  test("running from the installed place does not copy onto itself", () => {
    const a = planInstall(base({ exe: "/home/u/.local/bin/coati-broker" }));
    expect(a.some((x) => x.kind === "copy")).toBe(false);
  });

  test("system install: package paths, global enable, Brave shares the Chromium dir", () => {
    const a = planInstall(base({ system: true, exe: "/usr/bin/coati-broker" }));
    expect(writes(a).map((w) => w.path)).toEqual([
      "/usr/lib/systemd/user/coati-broker.service",
      "/etc/opt/chrome/native-messaging-hosts/com.getcoati.broker.json",
      "/etc/chromium/native-messaging-hosts/com.getcoati.broker.json",
      "/etc/opt/edge/native-messaging-hosts/com.getcoati.broker.json",
      "/usr/lib/mozilla/native-messaging-hosts/com.getcoati.broker.json",
      "/usr/lib64/mozilla/native-messaging-hosts/com.getcoati.broker.json",
    ]);
    expect(cmds(a)).toEqual(["systemctl --global enable coati-broker"]);
    // A package install must survive a machine without systemd (container, chroot).
    expect(a.find((x) => x.kind === "run")).toMatchObject({ optional: true });
    expect(a.some((x) => x.kind === "copy")).toBe(false);
  });

  test("system uninstall: removes the package's files but never the binary", () => {
    const a = planUninstall({ os: "linux", home: "/root", system: true, service: true, purge: false, configDir: "c", dataDir: "d" });
    const removed = a.filter((x) => x.kind === "remove").map((x) => (x as { path: string }).path);
    expect(removed).toContain("/usr/lib/systemd/user/coati-broker.service");
    expect(removed).toContain("/etc/chromium/native-messaging-hosts/com.getcoati.broker.json");
    expect(removed).not.toContain("/usr/bin/coati-broker");
    expect(cmds(a)).toEqual(["systemctl --global disable coati-broker"]);
    expect(a.some((x) => x.kind === "stop-broker")).toBe(false);
  });

  test("manifests: Chromium pins the origin, Firefox the extension id", () => {
    const a = writes(planInstall(base({ all: true, service: false })));
    const chrome = JSON.parse(a.find((w) => w.path.includes("google-chrome"))!.content);
    const firefox = JSON.parse(a.find((w) => w.path.includes(".mozilla"))!.content);
    expect(chrome.allowed_origins).toEqual([CHROME_ORIGIN]);
    expect(chrome.allowed_extensions).toBeUndefined();
    expect(firefox.allowed_extensions).toEqual(["coati@getcoati.com"]);
    expect(firefox.allowed_origins).toBeUndefined();
    expect(chrome.path).toBe("/home/u/.local/bin/coati-broker");
  });
});

describe("plan: macOS and Windows", () => {
  test("macOS: Application Support, quarantine, ad-hoc signature, LaunchAgent with --serve", () => {
    const a = planInstall(base({ os: "darwin", home: "/Users/u", uid: 502 }));
    const exe = "/Users/u/Library/Application Support/Coati/coati-broker";
    expect(a).toContainEqual({ kind: "copy", from: "/tmp/dl/coati-broker", to: exe });
    const plist = "/Users/u/Library/LaunchAgents/com.getcoati.broker.plist";
    expect(cmds(a)).toEqual([
      `launchctl bootout gui/502 ${plist}`,
      `xattr -d com.apple.quarantine ${exe}`,
      `codesign -s - --force ${exe}`,
      `launchctl bootstrap gui/502 ${plist}`,
    ]);
    const body = writes(a).find((w) => w.path === plist)!.content;
    expect(body).toContain("<string>--serve</string>");
    expect(body).toContain("/Users/u/Library/Logs/Coati/coati-broker.log");
  });

  test("Windows: HKCU keys, Run autostart with --serve, old task removed, backslashes escaped in JSON", () => {
    const a = planInstall(
      base({ os: "win32", home: "C:\\Users\\u", localAppData: "C:\\Users\\u\\AppData\\Local", exe: "C:\\dl\\Coati-Setup.exe", user: "PC\\u" }),
    );
    const exe = "C:\\Users\\u\\AppData\\Local\\Coati\\coati-broker.exe";
    expect(a).toContainEqual({ kind: "copy", from: "C:\\dl\\Coati-Setup.exe", to: exe });
    const c = cmds(a);
    expect(c).toContain(
      `reg.exe add HKCU\\Software\\Google\\Chrome\\NativeMessagingHosts\\com.getcoati.broker /ve /t REG_SZ /d C:\\Users\\u\\AppData\\Local\\Coati\\native-host\\com.getcoati.broker.chromium.json /f`,
    );
    expect(c).toContain(
      "reg.exe add HKCU\\Software\\Mozilla\\NativeMessagingHosts\\com.getcoati.broker /ve /t REG_SZ /d C:\\Users\\u\\AppData\\Local\\Coati\\native-host\\com.getcoati.broker.firefox.json /f",
    );
    expect(c).toContain(`reg.exe add HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run /v Coati /t REG_SZ /d "${exe}" --serve /f`);
    expect(c).toContain("schtasks.exe /Delete /TN CoatiBroker /F");
    expect(c.filter((x) => x.startsWith("icacls.exe"))).toHaveLength(2);
    expect(a).toContainEqual({ kind: "run", cmd: [exe, "--serve"], detached: true });
    const manifest = writes(a).find((w) => w.path.endsWith("chromium.json"))!;
    expect(JSON.parse(manifest.content).path).toBe(exe);
    expect(manifest.content).toContain("C:\\\\Users\\\\u");
  });

  test("Windows without a user name never runs icacls (it would lock the user out)", () => {
    const a = planInstall(base({ os: "win32", home: "C:\\Users\\u", service: false }));
    expect(cmds(a).some((x) => x.startsWith("icacls.exe"))).toBe(false);
    expect(cmds(a).some((x) => x.includes("CurrentVersion\\Run"))).toBe(false);
  });
});

const WIN = { os: "win32", home: "C:\\Users\\u", localAppData: "C:\\Users\\u\\AppData\\Local" } as const;
const WIN_EXE = "C:\\Users\\u\\AppData\\Local\\Coati\\coati-broker.exe";
const kinds = (a: Action[]) => a.filter((x) => x.kind !== "say").map((x) => x.kind + (x.kind === "run" ? ":" + x.cmd[0] : ""));

describe("upgrade over a running broker", () => {
  test("Windows: stop, rename the running exe to .old, copy, start last", () => {
    const a = planInstall(base({ ...WIN, exe: "C:\\dl\\Setup.exe" }));
    const at = (k: string) => a.findIndex((x) => x.kind === k);
    expect(a[at("stop-broker")]).toEqual({ kind: "stop-broker", dataDir: "C:\\Users\\u\\.local\\share\\coati", port: 8787 });
    expect(a).toContainEqual({ kind: "rename", from: WIN_EXE, to: WIN_EXE + ".old" });
    expect(at("stop-broker")).toBeLessThan(at("rename"));
    expect(at("rename") + 1).toBe(at("copy"));
    expect(a.at(-1)).toEqual({ kind: "run", cmd: [WIN_EXE, "--serve"], detached: true });
  });

  test("Linux and macOS: the service is stopped before the binary is replaced", () => {
    expect(kinds(planInstall(base({}))).slice(0, 4)).toEqual(["run:systemctl", "stop-broker", "mkdir", "copy"]);
    const mac = kinds(planInstall(base({ os: "darwin", home: "/Users/u" })));
    expect(mac.slice(0, 4)).toEqual(["run:launchctl", "stop-broker", "mkdir", "copy"]);
    expect(mac.filter((k) => k === "run:launchctl")).toHaveLength(2);
  });

  test("a test prefix and a system install never stop anything", () => {
    for (const o of [{ prefix: "/p" }, { system: true, exe: "/usr/bin/coati-broker" }]) {
      expect(planInstall(base(o)).some((x) => x.kind === "stop-broker")).toBe(false);
    }
  });

  test("only a coati-broker process is ever stopped", () => {
    for (const ok of ["/usr/bin/coati-broker", "C:\\x\\coati-broker.exe", "/h/Library/Application Support/Coati/coati-broker"]) {
      expect(isBrokerImage(ok)).toBe(true);
    }
    for (const no of ["/usr/bin/bun", "C:\\x\\not-coati-broker.exe", "/bin/cat", ""]) expect(isBrokerImage(no)).toBe(false);
  });
});

describe("Windows uninstall entry and self-delete", () => {
  const key = "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\Coati";
  const uninstall = (selfExe?: string) =>
    planUninstall({ ...WIN, system: false, service: true, purge: false, configDir: "c", dataDir: "d", selfExe });

  test("entry values", () => {
    const c = cmds(planInstall(base({ ...WIN, version: "0.1.0", sizeKb: 2048 }))).filter((x) => x.includes(key));
    const v = (name: string) => c.find((x) => x.includes(` /v ${name} `))!.split(" /d ")[1]!.replace(/ \/f$/, "");
    expect(v("DisplayName")).toBe("Coati");
    expect(v("DisplayVersion")).toBe("0.1.0");
    expect(v("Publisher")).toBe("Coati");
    expect(v("InstallLocation")).toBe("C:\\Users\\u\\AppData\\Local\\Coati");
    expect(v("UninstallString")).toBe(`"${WIN_EXE}" --uninstall`);
    expect(v("NoModify")).toBe("1");
    expect(v("NoRepair")).toBe("1");
    expect(v("EstimatedSize")).toBe("2048");
    expect(c.find((x) => x.includes(" /v NoModify "))).toContain("REG_DWORD");
  });

  test("uninstall deletes the entry; from the installed exe the delete is deferred to a script", () => {
    expect(cmds(uninstall())).toContain(`reg.exe delete ${key} /f`);
    expect(uninstall("C:\\dl\\Setup.exe")).toContainEqual({ kind: "remove", path: WIN_EXE });

    const self = uninstall(WIN_EXE.toUpperCase());
    expect(self.some((x) => x.kind === "remove" && x.path === WIN_EXE)).toBe(false);
    const script = "C:\\Users\\u\\AppData\\Local\\coati-uninstall.cmd";
    expect(writes(self).find((w) => w.path === script)?.content).toContain(`del /f /q "${WIN_EXE}"`);
    expect(self.at(-1)).toEqual({ kind: "run", cmd: ["cmd.exe", "/d", "/c", script], detached: true });
  });

  test("deferred delete quotes paths with spaces and doubles %", () => {
    const dir = "C:\\Users\\Jo Doe\\100%\\Coati";
    const lines = renderDeferredDelete(dir + "\\coati-broker.exe", dir).split("\r\n");
    expect(lines).toContain('del /f /q "C:\\Users\\Jo Doe\\100%%\\Coati\\coati-broker.exe" >nul 2>&1');
    expect(lines).toContain('rmdir /s /q "C:\\Users\\Jo Doe\\100%%\\Coati" >nul 2>&1');
    expect(lines).toContain('if exist "C:\\Users\\Jo Doe\\100%%\\Coati\\coati-broker.exe" if %n% lss 30 goto retry');
  });
});

describe("escaping", () => {
  test("systemd: backslash, quote, percent and dollar in the binary path", () => {
    const line = renderUnit('/h/a"b\\c%d$e f').split("\n").find((l) => l.startsWith("ExecStart="));
    expect(line).toBe('ExecStart="/h/a\\"b\\\\c%%d$$e f" --serve');
  });

  test("plist: & < > \" are XML-escaped, placeholders fully replaced", () => {
    const plist = renderPlist('/a&b<c>"d', "/l&g");
    expect(plist).toContain("<string>/a&amp;b&lt;c&gt;&quot;d</string>");
    expect(plist).toContain("<string>/l&amp;g/coati-broker.log</string>");
    expect(plist).not.toContain("@@");
  });

  test("a path with & \" \\ % and spaces survives in the JSON manifest", () => {
    const prefix = join(tmpdir(), NASTY);
    const a = planInstall(base({ prefix, all: true, service: false }));
    for (const w of writes(a)) expect(JSON.parse(w.content).path).toBe(installedExe({ os: "linux", home: "/h", prefix }));
  });
});

describe("mode selection", () => {
  const ctx = (compiled: boolean, installed: boolean) => ({ compiled, installed });
  test("explicit flags win", () => {
    expect(selectMode(["--serve"], ctx(true, false))).toBe("serve");
    expect(selectMode(["--install"], ctx(true, true))).toBe("install");
    expect(selectMode(["--uninstall", "--purge"], ctx(true, true))).toBe("uninstall");
  });
  test("no flag: a compiled binary installs unless it runs from its installed place; bun run serves", () => {
    expect(selectMode([], ctx(true, false))).toBe("install");
    expect(selectMode([], ctx(true, true))).toBe("serve");
    expect(selectMode([], ctx(false, false))).toBe("serve");
  });
  test("installed location per OS, case-insensitive on Windows", () => {
    const lin = { os: "linux", home: "/home/u" } as const;
    expect(isInstalledExe(lin, "/home/u/.local/bin/coati-broker")).toBe(true);
    expect(isInstalledExe(lin, "/usr/bin/coati-broker")).toBe(true);
    expect(isInstalledExe(lin, "/home/u/Downloads/coati-broker")).toBe(false);
    const win = { os: "win32", home: "C:\\Users\\u", localAppData: "C:\\Users\\u\\AppData\\Local" } as const;
    expect(isInstalledExe(win, "c:\\users\\U\\appdata\\local\\coati\\COATI-BROKER.exe")).toBe(true);
    expect(isInstalledExe({ ...lin, prefix: "/p" }, "/p/.local/bin/coati-broker")).toBe(true);
  });
  test("only a bare double-click on a terminal gets the Enter prompt", () => {
    expect(wantsPrompt([], "install", true)).toBe(true);
    expect(wantsPrompt([], "install", false)).toBe(false);
    expect(wantsPrompt(["--install"], "install", true)).toBe(false);
    expect(wantsPrompt(["--no-service"], "install", true)).toBe(false);
    expect(wantsPrompt([], "serve", true)).toBe(false);
    expect(wantsPrompt([], "uninstall", true)).toBe(false);
  });
  test("compiled detection and flag parsing", () => {
    expect(isCompiledExe("/home/u/.bun/bin/bun")).toBe(false);
    expect(isCompiledExe("C:\\x\\bun.exe")).toBe(false);
    expect(isCompiledExe("/home/u/Downloads/coati-broker-linux-x64")).toBe(true);
    expect(parseCli(["--install", "--prefix=/p x", "--no-service", "--all"])).toMatchObject({ prefix: "/p x", service: false, all: true, system: false });
    expect(parseCli(["--prefix", "/q", "--system"])).toMatchObject({ prefix: "/q", system: true, service: true });
    expect(() => parseCli(["--prefix"])).toThrow();
  });
});

describe("apply against a throwaway prefix", () => {
  let dir = "";
  // Tests skipped on this OS return before setup(): nothing to clean then.
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = "";
  });
  const setup = () => {
    dir = mkdtempSync(join(tmpdir(), "coati-install-"));
    const exe = join(dir, "dl-coati-broker");
    writeFileSync(exe, "#!/bin/sh\necho fake\n");
    return { exe, prefix: join(dir, NASTY) };
  };
  const planFor = (prefix: string, exe: string, o: Partial<InstallOpts> = {}) =>
    planInstall({ ...currentEnv(prefix), os: "linux", exe, system: false, service: false, all: true, detected: new Set(), ...o });

  test("install writes binary + manifests, is idempotent, uninstall keeps config unless --purge", () => {
    // runUninstall plans for the host OS; the install above is a Linux plan.
    if (process.platform !== "linux") return;
    const { exe, prefix } = setup();
    const logs: string[] = [];
    applyActions(planFor(prefix, exe), { log: (l) => logs.push(l) });
    const bin = join(prefix, ".local/bin/coati-broker");
    expect(statSync(bin).mode & 0o111).not.toBe(0);
    const manifest = join(prefix, ".config/BraveSoftware/Brave-Browser/NativeMessagingHosts/com.getcoati.broker.json");
    expect(JSON.parse(readFileSync(manifest, "utf8")).path).toBe(bin);

    logs.length = 0;
    applyActions(planFor(prefix, exe).filter((a) => a.kind !== "copy"), { log: (l) => logs.push(l) });
    expect(logs.filter((l) => l.startsWith("write"))).toEqual([]);

    mkdirSync(join(prefix, ".config/coati"), { recursive: true });
    writeFileSync(join(prefix, ".config/coati/config.json"), "{}");
    const cli = { ...parseCli(["--no-service"]), prefix };
    runUninstall(cli, () => {});
    expect(existsSync(bin) || existsSync(manifest)).toBe(false);
    expect(existsSync(join(prefix, ".config/coati/config.json"))).toBe(true);
    runUninstall({ ...cli, purge: true }, () => {});
    expect(existsSync(join(prefix, ".config/coati"))).toBe(false);
  });

  test("rename skips a missing source and replaces an existing target", () => {
    const { exe } = setup();
    const old = exe + ".old";
    applyActions([{ kind: "rename", from: join(dir, "absent"), to: old }], { log: () => {} });
    expect(existsSync(old)).toBe(false);
    writeFileSync(old, "stale");
    applyActions([{ kind: "rename", from: exe, to: old }], { log: () => {} });
    expect(readFileSync(old, "utf8")).toContain("fake");
    expect(existsSync(exe)).toBe(false);
  });

  test("dry run writes nothing", () => {
    const { exe, prefix } = setup();
    const logs: string[] = [];
    applyActions(planFor(prefix, exe), { dryRun: true, log: (l) => logs.push(l) });
    expect(existsSync(prefix)).toBe(false);
    expect(logs.every((l) => l.startsWith("[dry-run]"))).toBe(true);
  });

  test("planUninstall removes exactly the files an install writes", () => {
    const { exe, prefix } = setup();
    const written = planFor(prefix, exe).flatMap((a) => (a.kind === "write" ? [a.path] : []));
    const env = currentEnv(prefix);
    const removed = planUninstall({ ...env, os: "linux", system: false, service: false, purge: false, configDir: "c", dataDir: "d" })
      .flatMap((a) => (a.kind === "remove" ? [a.path] : []));
    for (const w of written) expect(removed).toContain(w);
  });

  test("serve-time sync: detected browser gets a manifest, identical is untouched, a live foreign path is kept", () => {
    // Linux paths below; syncUserManifests uses the host OS.
    if (process.platform !== "linux" || process.getuid?.() === 0) return;
    const { prefix } = setup();
    const before = process.env.COATI_INSTALL_PREFIX;
    process.env.COATI_INSTALL_PREFIX = prefix;
    try {
      mkdirSync(join(prefix, ".config/BraveSoftware/Brave-Browser"), { recursive: true });
      const me = join(dir, "me");
      const other = join(dir, "other");
      writeFileSync(me, "x");
      writeFileSync(other, "x");
      const manifest = join(prefix, ".config/BraveSoftware/Brave-Browser/NativeMessagingHosts/com.getcoati.broker.json");
      const logs: string[] = [];
      syncUserManifests(me, (l) => logs.push(l));
      expect(JSON.parse(readFileSync(manifest, "utf8")).path).toBe(me);
      expect(existsSync(join(prefix, ".config/google-chrome"))).toBe(false);

      logs.length = 0;
      syncUserManifests(me, (l) => logs.push(l));
      expect(logs).toEqual([]);

      syncUserManifests(other, (l) => logs.push(l));
      expect(JSON.parse(readFileSync(manifest, "utf8")).path).toBe(me);
      expect(logs.join("\n")).toContain("left unchanged");

      rmSync(me);
      syncUserManifests(other, () => {});
      expect(JSON.parse(readFileSync(manifest, "utf8")).path).toBe(other);
    } finally {
      if (before === undefined) delete process.env.COATI_INSTALL_PREFIX;
      else process.env.COATI_INSTALL_PREFIX = before;
    }
  });

  test("detectBrowsers reads the config dirs under the root", () => {
    if (process.platform === "win32") return; // POSIX root joined with a Windows temp path
    const { prefix } = setup();
    mkdirSync(join(prefix, ".mozilla"), { recursive: true });
    const found = detectBrowsers({ os: "linux", home: "/h", prefix }, existsSync);
    expect([...found]).toEqual(["firefox"]);
  });
});
