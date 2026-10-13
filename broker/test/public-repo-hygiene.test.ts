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
// Comments describe the code as it is: no plan files, goal ids or dates (history lives in git).
const HISTORY = /plan-[\w-]+\.md|goal-[A-Za-z0-9_-]{6,}|20\d\d-\d\d-\d\d/;
const COMMENT = /^\s*(\/\/|\/\*|\*|#(?!!)|<!--)|\s\/\/\s/;
const COMMENT_DIRS = ["extension/", "broker/src/", "scripts/"];
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

  test("comments carry no plan file, goal id or date", () => {
    const offenders: string[] = [];
    for (const rel of trackedTextFiles().filter((p) => COMMENT_DIRS.some((d) => p.startsWith(d)))) {
      readFileSync(join(ROOT, rel), "utf8")
        .split("\n")
        .forEach((line, i) => {
          if (COMMENT.test(line) && HISTORY.test(line)) offenders.push(`${rel}:${i + 1}: ${line.trim().slice(0, 100)}`);
        });
    }
    expect(offenders).toEqual([]);
  });
});
