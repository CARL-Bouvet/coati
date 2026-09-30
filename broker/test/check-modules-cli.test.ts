// End-to-end smoke test for the `--check-modules` CLI flag (server.ts's
// import.meta.main block) — proves an external provider module named in
// config.json's `modules` array (docs/MODULES.md) still loads via dynamic
// `import()` when run as a real OS process, no network required. Runs the
// same check against `bun run src/server.ts` always, and additionally
// against the compiled binary at dist/bin/coati-broker-<host> when
// scripts/build-binaries.sh has already produced one (goal G4, "binaries +
// Windows CI") — never builds it itself, that would make every `bun test`
// run download bun's cross-compile targets.

import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { makeTmpDir } from "./helpers/tmp-dir.ts";

const FIXTURES = join(import.meta.dir, "fixtures", "modules");
const REPO_ROOT = join(import.meta.dir, "..");

/** Writes a fresh $HOME (~/.config/coati/config.json) pointing `modules` at
 * the given fixture, and returns that HOME. */
function fakeHomeWithModule(fixtureFile: string): string {
  const home = makeTmpDir("coati-check-modules-home-");
  const configDir = join(home, ".config", "coati");
  mkdirSync(configDir, { recursive: true });
  writeFileSync(
    join(configDir, "config.json"),
    JSON.stringify(
      {
        port: 8787,
        allowedExtensionIds: [],
        provider: "ollama",
        ollamaUrl: "http://127.0.0.1:11434",
        modules: [{ path: join(FIXTURES, fixtureFile), options: { id: "smoke-valid" } }],
      },
      null,
      2,
    ),
  );
  return home;
}

async function run(cmd: string[], home: string): Promise<{ code: number; stdout: string; stderr: string }> {
  const proc = Bun.spawn(cmd, {
    cwd: REPO_ROOT,
    env: { ...process.env, HOME: home },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { code, stdout, stderr };
}

describe("--check-modules", () => {
  test("bun run src/server.ts --check-modules: loads the fixture module, prints provider ids, exits 0", async () => {
    const home = fakeHomeWithModule("valid-provider.ts");
    const { code, stdout } = await run(["bun", "run", "src/server.ts", "--check-modules"], home);
    expect(code).toBe(0);
    expect(stdout).toContain("ollama");
    expect(stdout).toContain("claude-api");
    expect(stdout).toContain("smoke-valid");
  });

  test("bun run src/server.ts --check-modules: a configured module that fails to import exits non-zero", async () => {
    const home = fakeHomeWithModule("throwing-provider.ts");
    const { code, stdout } = await run(["bun", "run", "src/server.ts", "--check-modules"], home);
    expect(code).not.toBe(0);
    // The built-ins still load — a broken module never blocks the others.
    expect(stdout).toContain("ollama");
    expect(stdout).toContain("claude-api");
  });

  const hostBinary = (() => {
    // Mirrors scripts/build-binaries.sh's naming: coati-broker-<os>-<arch>[.exe].
    const os = process.platform === "darwin" ? "darwin" : process.platform === "win32" ? "windows" : "linux";
    const arch = process.arch === "arm64" ? "arm64" : "x64";
    const ext = process.platform === "win32" ? ".exe" : "";
    return join(REPO_ROOT, "..", "dist", "bin", `coati-broker-${os}-${arch}${ext}`);
  })();

  test.if(existsSync(hostBinary))("the compiled host binary: same smoke, same result", async () => {
    const home = fakeHomeWithModule("valid-provider.ts");
    const { code, stdout } = await run([hostBinary, "--check-modules"], home);
    expect(code).toBe(0);
    expect(stdout).toContain("ollama");
    expect(stdout).toContain("claude-api");
    expect(stdout).toContain("smoke-valid");
  });
});
