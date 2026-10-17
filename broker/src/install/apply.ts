// Executes the actions of plan.ts, and the install / manifest-sync entry
// points that build a plan from the real machine.

import { spawn, spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, readlinkSync, renameSync, rmSync, statSync } from "node:fs";
import { homedir } from "node:os";
import pkg from "../../package.json";
import { readBrokerKeyFile } from "../broker-key.ts";
import { atomicWriteFileSync } from "../fs-atomic.ts";
import {
  type Action,
  type Cli,
  type Env,
  HOST_NAME,
  detectBrowsers,
  isBrokerImage,
  planInstall,
  planUserManifests,
} from "./plan.ts";

export interface ApplyOpts {
  dryRun?: boolean;
  log?: (line: string) => void;
  /** Receives the plain-English progress lines; defaults to `log`. */
  say?: (line: string) => void;
}

export function describe(a: Action): string {
  switch (a.kind) {
    case "mkdir":
      return `mkdir ${a.path}`;
    case "write":
      return `write ${a.path}`;
    case "copy":
      return `copy ${a.from} -> ${a.to}`;
    case "rename":
      return `rename ${a.from} -> ${a.to}`;
    case "remove":
      return `remove ${a.path}`;
    case "stop-broker":
      return `stop the running broker, wait for port ${a.port}`;
    case "say":
      return a.text;
    case "run":
      return `run ${a.cmd.join(" ")}`;
  }
}

function imageOf(pid: number): string | undefined {
  try {
    if (process.platform === "linux") return readlinkSync(`/proc/${pid}/exe`).replace(/ \(deleted\)$/, "");
    if (process.platform === "win32") {
      const out = spawnSync("tasklist.exe", ["/FI", `PID eq ${pid}`, "/FO", "CSV", "/NH"], { encoding: "utf8" }).stdout;
      return out.match(/^"([^"]*)"/)?.[1];
    }
    return spawnSync("ps", ["-p", String(pid), "-o", "comm="], { encoding: "utf8" }).stdout.trim() || undefined;
  } catch {
    return undefined;
  }
}

const portFree = (port: number): boolean => {
  try {
    Bun.listen({ hostname: "127.0.0.1", port, socket: { data() {} } }).stop(true);
    return true;
  } catch {
    return false;
  }
};

/** Stops the broker recorded in broker-key.json (only a live coati-broker process), then waits up to 10 s for its port. */
function stopBroker({ dataDir, port }: { dataDir: string; port: number }, log: (line: string) => void, warn: (line: string) => void): void {
  const key = readBrokerKeyFile({ dataDir });
  if (key.ok && key.file.pid !== process.pid && isBrokerImage(imageOf(key.file.pid) ?? "")) {
    try {
      process.kill(key.file.pid);
      log(`stopped broker pid ${key.file.pid}`);
    } catch {
      // already gone
    }
  }
  const end = Date.now() + 10_000;
  while (!portFree(port) && Date.now() < end) Bun.sleepSync(200);
  if (!portFree(port)) warn(`Warning: port ${port} is still in use, continuing`);
}

/** A previous upgrade left the running exe renamed; it can go once that process has exited. */
export function removeLeftoverOldExe(exe: string): void {
  try {
    rmSync(exe + ".old", { force: true });
  } catch {
    // still locked: next start
  }
}

function readIfExists(path: string): string | undefined {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return undefined;
  }
}

function runCommand(a: Extract<Action, { kind: "run" }>, warn: (line: string) => void): void {
  const [cmd, ...args] = a.cmd as [string, ...string[]];
  if (a.detached) {
    spawn(cmd, args, { detached: true, stdio: "ignore", windowsHide: true }).unref();
    return;
  }
  const r = spawnSync(cmd, args, { encoding: "utf8" });
  if (!r.error && r.status === 0) return;
  const why = r.error?.message ?? (r.stderr.trim() || `exit ${r.status}`);
  if (!a.optional) throw new Error(`${a.cmd.join(" ")} failed: ${why}`);
  if (a.warn) warn(`Warning: ${cmd} failed, continuing: ${why}`);
}

/** Runs the actions in order. A file already holding the wanted content is left untouched. */
export function applyActions(actions: readonly Action[], { dryRun = false, log = console.log, say = log }: ApplyOpts = {}): void {
  for (const a of actions) {
    if (dryRun) {
      log(`[dry-run] ${describe(a)}`);
      continue;
    }
    switch (a.kind) {
      case "say":
        say(a.text);
        break;
      case "stop-broker":
        stopBroker(a, log, say);
        break;
      case "rename":
        if (!existsSync(a.from)) break;
        rmSync(a.to, { force: true });
        renameSync(a.from, a.to);
        log(describe(a));
        break;
      case "mkdir":
        mkdirSync(a.path, { recursive: true, mode: a.mode });
        break;
      case "write":
        if (readIfExists(a.path) === a.content) break;
        atomicWriteFileSync(a.path, a.content, a.mode);
        log(describe(a));
        break;
      case "copy": {
        const tmp = `${a.to}.tmp`;
        copyFileSync(a.from, tmp);
        chmodSync(tmp, 0o755);
        renameSync(tmp, a.to);
        log(describe(a));
        break;
      }
      case "remove":
        if (!existsSync(a.path)) break;
        try {
          rmSync(a.path, { recursive: a.recursive ?? false, force: true });
          log(describe(a));
        } catch (e) {
          say(`Warning: could not remove ${a.path}: ${(e as Error).message}`);
        }
        break;
      case "run":
        runCommand(a, say);
        break;
    }
  }
}

/** The real machine as an Env. COATI_INSTALL_PREFIX is for tests: it replaces the home/LocalAppData root and implies no service. */
export function currentEnv(prefix?: string): Env & { prefixFromEnv: boolean } {
  const fromEnv = !prefix && !!process.env.COATI_INSTALL_PREFIX;
  const domain = process.env.USERDOMAIN;
  const name = process.env.USERNAME;
  return {
    os: process.platform === "win32" ? "win32" : process.platform === "darwin" ? "darwin" : "linux",
    home: homedir(),
    localAppData: process.env.LOCALAPPDATA,
    prefix: prefix ?? process.env.COATI_INSTALL_PREFIX ?? undefined,
    uid: process.getuid?.(),
    user: name ? (domain ? `${domain}\\${name}` : name) : undefined,
    prefixFromEnv: fromEnv,
  };
}

export function runInstall(cli: Cli, exe: string, log: (line: string) => void = console.log, say: (line: string) => void = log): void {
  const env = currentEnv(cli.prefix);
  if (env.uid === 0 && !cli.system) throw new Error("run as your own user, not root (use --system for a system-wide install)");
  const detected = detectBrowsers(env, existsSync);
  const actions = planInstall({
    ...env,
    exe,
    system: cli.system,
    service: cli.service && !env.prefixFromEnv,
    all: cli.all,
    detected,
    version: pkg.version,
    sizeKb: Math.ceil(statSync(exe).size / 1024),
  });
  applyActions(actions, { dryRun: cli.dryRun, log, say });
  log(cli.dryRun ? "Nothing written (dry run)." : "Installation complete.");
}

/**
 * Called by a serving, compiled broker: writes a per-user manifest for every
 * installed browser that lacks one (covers browsers installed after the
 * installer ran). A manifest pointing to another live executable is left alone.
 */
export function syncUserManifests(exe: string, log: (line: string) => void = console.log): void {
  const env = currentEnv();
  if (env.os === "win32" || env.uid === 0) return;
  const actions = planUserManifests(env, exe, detectBrowsers(env, existsSync), false);
  const keep = actions.filter((a) => {
    if (a.kind !== "write") return true;
    try {
      const other = (JSON.parse(readIfExists(a.path) ?? "null") as { path?: string } | null)?.path;
      if (other && other !== exe && existsSync(other)) {
        log(`coati-broker: ${HOST_NAME} manifest ${a.path} points to ${other}, left unchanged`);
        return false;
      }
    } catch {
      // unreadable manifest: rewrite it
    }
    return true;
  });
  applyActions(keep, { log: (l) => log(`coati-broker: ${l}`) });
}
