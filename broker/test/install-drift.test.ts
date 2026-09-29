// Unit tests for task A1's systemd-unit drift detection (server.ts). Covers
// the exact incident measured 2026-09-21: the installed unit
// (~/.config/systemd/user/coati-broker.service) losing an `Environment=`
// line relative to packaging/coati-broker.service in the repo. The check
// must warn loudly but never throw or block startup.

import { describe, expect, test, afterEach, mock } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { unitFileDrifted, checkUnitDriftAtStartup } from "../src/server.ts";

describe("unitFileDrifted", () => {
  test("identical content is not drift", () => {
    expect(unitFileDrifted("same\n", "same\n")).toBe(false);
  });

  test("a missing Environment= line is drift", () => {
    const repo = "[Service]\nExecStart=bun run src/server.ts\nEnvironment=COATI_SOME_PATH=/x\n";
    const installed = "[Service]\nExecStart=bun run src/server.ts\n";
    expect(unitFileDrifted(installed, repo)).toBe(true);
  });
});

describe("checkUnitDriftAtStartup", () => {
  let dir: string;
  let warnSpy: ReturnType<typeof mock>;
  let originalWarn: typeof console.warn;

  function setup() {
    dir = mkdtempSync(join(tmpdir(), "coati-drift-"));
    originalWarn = console.warn;
    warnSpy = mock(() => {});
    console.warn = warnSpy as unknown as typeof console.warn;
  }

  afterEach(() => {
    console.warn = originalWarn;
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  test("skips silently (no warning) when INVOCATION_ID is absent — not started by systemd", () => {
    setup();
    const installedUnitPath = join(dir, "installed.service");
    const repoUnitPath = join(dir, "repo.service");
    writeFileSync(installedUnitPath, "A");
    writeFileSync(repoUnitPath, "B");
    checkUnitDriftAtStartup({ installedUnitPath, repoUnitPath }, {});
    expect(warnSpy).not.toHaveBeenCalled();
  });

  test("warns in French naming the installed unit path when content differs under systemd", () => {
    setup();
    const installedUnitPath = join(dir, "installed.service");
    const repoUnitPath = join(dir, "repo.service");
    writeFileSync(installedUnitPath, "[Service]\nExecStart=bun run src/server.ts\n");
    writeFileSync(repoUnitPath, "[Service]\nExecStart=bun run src/server.ts\nEnvironment=COATI_SOME_PATH=/x\n");
    checkUnitDriftAtStartup({ installedUnitPath, repoUnitPath }, { INVOCATION_ID: "abc" });
    expect(warnSpy).toHaveBeenCalledTimes(1);
    const message = warnSpy.mock.calls[0]?.[0] as string;
    expect(message).toContain(installedUnitPath);
    expect(message).toContain(repoUnitPath);
  });

  test("stays silent when content is identical under systemd", () => {
    setup();
    const installedUnitPath = join(dir, "installed.service");
    const repoUnitPath = join(dir, "repo.service");
    writeFileSync(installedUnitPath, "same content\n");
    writeFileSync(repoUnitPath, "same content\n");
    checkUnitDriftAtStartup({ installedUnitPath, repoUnitPath }, { INVOCATION_ID: "abc" });
    expect(warnSpy).not.toHaveBeenCalled();
  });

  test("never throws when a file is missing, even under systemd", () => {
    setup();
    const installedUnitPath = join(dir, "does-not-exist.service");
    const repoUnitPath = join(dir, "also-missing.service");
    expect(() => checkUnitDriftAtStartup({ installedUnitPath, repoUnitPath }, { INVOCATION_ID: "abc" })).not.toThrow();
    expect(warnSpy).not.toHaveBeenCalled();
  });
});
