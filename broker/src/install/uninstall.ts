// `--uninstall [--purge]`: removes what `--install` wrote. Config and keys
// stay unless --purge.

import { join } from "node:path";
import { defaultDirs } from "../config.ts";
import { applyActions, currentEnv } from "./apply.ts";
import { type Cli, planUninstall } from "./plan.ts";

export function runUninstall(cli: Cli, log: (line: string) => void = console.log, say: (line: string) => void = log): void {
  const env = currentEnv(cli.prefix);
  // A test prefix must never reach the real config and keys.
  const dirs = env.prefix
    ? { configDir: join(env.prefix, ".config", "coati"), dataDir: join(env.prefix, ".local", "share", "coati") }
    : defaultDirs();
  const actions = planUninstall({
    ...env,
    selfExe: process.execPath,
    system: cli.system,
    service: cli.service && !env.prefixFromEnv,
    purge: cli.purge,
    ...dirs,
  });
  applyActions(actions, { dryRun: cli.dryRun, log, say });
  log(cli.dryRun ? "Nothing removed (dry run)." : "Uninstallation complete.");
}
