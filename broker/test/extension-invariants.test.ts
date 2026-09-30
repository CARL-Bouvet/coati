// Static check for docs/PROTOCOL.md "Règles invariantes, ajouts" (amendement
// 2026-09-30, G4): none of these APIs may appear anywhere under extension/ —
// worker on extension/ owns that tree, this is a cross-cutting guard that
// belongs to the broker's test suite per the amended spec.

import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const FORBIDDEN_PATTERNS: RegExp[] = [
  /setAccessLevel/,
  /externally_connectable/,
  /onMessageExternal/,
  /onConnectExternal/,
];

const EXTENSION_ROOT = join(import.meta.dir, "..", "..", "extension");

const SKIP_DIR_NAMES = new Set(["node_modules", ".git"]);

// This codebase's own comments legitimately NAME these APIs, at length, to
// document the invariant they must never appear as real code (see e.g.
// extension/background/service-worker.js's header) — a blind text grep would
// flag its own warning comments. Line and block comments are stripped from
// JS/TS sources before matching, so this only ever fires on actual code —
// "appears" (docs/PROTOCOL.md) means appears as code, not as a comment
// explaining why it must not. JSON files (manifests) have no comments to
// strip; a real `"externally_connectable"` manifest key is still caught.
function stripJsComments(content: string): string {
  return content.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
}

const CODE_EXTENSIONS = new Set([".js", ".mjs", ".ts"]);

function listFilesRecursive(dir: string): string[] {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return [];
  }
  const files: string[] = [];
  for (const name of entries) {
    if (SKIP_DIR_NAMES.has(name)) continue;
    const full = join(dir, name);
    let st;
    try {
      st = statSync(full);
    } catch {
      continue;
    }
    if (st.isDirectory()) {
      files.push(...listFilesRecursive(full));
    } else if (st.isFile()) {
      files.push(full);
    }
  }
  return files;
}

describe("extension/ static invariants (docs/PROTOCOL.md, amendement 2026-09-30 G4)", () => {
  test("extension/ exists (sanity check — this test must not silently pass on an empty scan)", () => {
    expect(() => statSync(EXTENSION_ROOT)).not.toThrow();
  });

  test("no forbidden API name appears anywhere under extension/", () => {
    const files = listFilesRecursive(EXTENSION_ROOT);
    expect(files.length).toBeGreaterThan(0);
    const offenders: string[] = [];
    for (const file of files) {
      let content: string;
      try {
        content = readFileSync(file, "utf8");
      } catch {
        continue; // binary/unreadable file — not a source file to check
      }
      const ext = file.slice(file.lastIndexOf("."));
      if (CODE_EXTENSIONS.has(ext)) content = stripJsComments(content);
      for (const pattern of FORBIDDEN_PATTERNS) {
        if (pattern.test(content)) {
          offenders.push(`${file}: ${pattern}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });
});
