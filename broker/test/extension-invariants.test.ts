// Static check for docs/PROTOCOL.md: none of these APIs may appear anywhere under extension/ —
// this is a cross-cutting guard that belongs to the broker's test suite.

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

describe("extension/ static invariants (docs/PROTOCOL.md)", () => {
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

describe("key input format check", () => {
  test("a pasted command is refused; each service's prefix is required", async () => {
    const { isValidKeyFormat } = await import("../../extension/lib/key-input.js");
    expect(isValidKeyFormat("claude-api", undefined, "claude /login")).toBe(false);
    expect(isValidKeyFormat("claude-api", undefined, "sk-ant-abc")).toBe(true);
    expect(isValidKeyFormat("claude-api", undefined, "sk-abc")).toBe(false);
    expect(isValidKeyFormat("openai-compat", "https://openrouter.ai/api/v1", "sk-abc")).toBe(false);
    expect(isValidKeyFormat("openai-compat", "https://openrouter.ai/api/v1", "sk-or-abc")).toBe(true);
    expect(isValidKeyFormat("openai-compat", "https://api.openai.com/v1", "sk-abc")).toBe(true);
    expect(isValidKeyFormat("openai-compat", "http://localhost:1234/v1", "anything")).toBe(true);
    expect(isValidKeyFormat("openai-compat", "http://localhost:1234/v1", "a b")).toBe(false);
  });
});
