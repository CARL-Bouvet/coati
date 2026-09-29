// Shared helper: every test suite that needs a scratch directory calls
// makeTmpDir() instead of mkdtempSync() directly. Fixes the leak reported in
// notes/BUG_tests_du_broker_dossiers_temporaires_jamais_supprim_s_811_mo_20260926-000230.md
// (1,101 leftover dirs / 811 MB under $TMPDIR): every suite created its own
// mkdtempSync() dir and never removed it. One helper, one afterAll per
// created dir — verified working: a dynamically-registered afterAll (called
// from inside a running test, not just at describe-scope) still fires once,
// after every test in that file, per Bun 1.4.2 (measured 2026-09-26).
import { afterAll } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** Creates a fresh temp dir under $TMPDIR with the given prefix (same
 * contract as mkdtempSync(join(tmpdir(), prefix))) and registers its removal
 * (recursive, force) in afterAll — the caller never needs its own cleanup. */
export function makeTmpDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });
  return dir;
}
