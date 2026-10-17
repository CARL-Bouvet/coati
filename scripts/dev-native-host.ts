// Native Messaging host for a source checkout: a launcher that runs the broker
// from source in host mode, registered for Brave (default) or, with --all,
// every browser whose config dir exists. --uninstall removes both.
//
//   bun scripts/dev-native-host.ts [--all | --uninstall]

import { chmodSync, existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { applyActions, currentEnv } from "../broker/src/install/apply.ts";
import { detectBrowsers, planUserManifests } from "../broker/src/install/plan.ts";

if (process.getuid?.() === 0) throw new Error("do not run as root");
const arg = process.argv[2];
if (arg && !["--all", "--uninstall"].includes(arg)) throw new Error(`unknown option: ${arg}`);

const env = currentEnv();
const launcher = join(homedir(), ".local", "share", "coati", "dev-native-host", "coati-native-host.sh");

if (arg === "--uninstall") {
  const paths = planUserManifests(env, launcher, new Set(), true).flatMap((a) => (a.kind === "write" ? [a.path] : []));
  for (const p of [launcher, ...paths]) rmSync(p, { force: true });
  console.log("Development native host uninstalled.");
  process.exit(0);
}

const shq = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;
mkdirSync(dirname(launcher), { recursive: true, mode: 0o700 });
const server = join(import.meta.dir, "..", "broker", "src", "server.ts");
writeFileSync(launcher, `#!/bin/sh\nexec ${shq(process.execPath)} ${shq(server)} --native-host "$@"\n`);
chmodSync(launcher, 0o700);

const wanted = arg === "--all" ? detectBrowsers(env, existsSync) : new Set(["brave"]);
applyActions(planUserManifests(env, launcher, wanted, false));
console.log(`Development native host installed (${[...wanted].join(", ") || "no browser found"}).`);
