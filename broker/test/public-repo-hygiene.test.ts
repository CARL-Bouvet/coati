// This repository is public. A file must never point to the maintainers' private notes
// (the pre-push hook refuses such a push, which is too late: this test catches it as soon
// as `bun test` runs, for humans and coding agents alike). Patterns are assembled in
// pieces so this file does not match itself.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "fs";
import { join } from "path";

const ROOT = join(import.meta.dir, "..", "..");
const PRIVATE = new RegExp(
  ["coati-" + "interne/", "\\binterne" + "/(design|etudes|archives|modules|bench|notes)/", "(^|[^.\\w])" + "(JOURNAL|REGLES)" + "\\.md\\b"].join("|"),
);
const SKIP_DIRS = ["node_modules/", ".git/", ".tmp/", "dist/", "coverage/"];
const TEXT = /\.(js|mjs|ts|css|html|json|md|sh|ps1|py|yml|yaml|service|plist|txt)$/;

// Files git would publish: tracked or new, never the ignored local ones (notes/, .tmp/…).
function trackedTextFiles(): string[] {
  const out = Bun.spawnSync(["git", "ls-files", "--cached", "--others", "--exclude-standard"], { cwd: ROOT });
  return out.stdout
    .toString()
    .split("\n")
    .filter((p) => p && TEXT.test(p) && !SKIP_DIRS.some((d) => p.startsWith(d) || p.includes("/" + d)));
}

describe("public repository hygiene", () => {
  test("no file refers to the private notes", () => {
    const offenders: string[] = [];
    for (const rel of trackedTextFiles()) {
      if (rel === "scripts/hooks/pre-push") continue;
      const lines = readFileSync(join(ROOT, rel), "utf8").split("\n");
      lines.forEach((line, i) => {
        if (PRIVATE.test(line)) offenders.push(`${rel}:${i + 1}: ${line.trim().slice(0, 100)}`);
      });
    }
    expect(offenders).toEqual([]);
  });
});
