// Prompt library persisted at ~/.local/share/coati/prompts-v2.json.
// Base directory is always passed in as a parameter so tests can point at a temp dir.
//
// Amendement 2026-09-28 ("Mes prompts par site" — docs/DECISIONS.md T41): replaces the flat
// `prompts.json` (identified by `name`) with a per-site format identified by a broker-assigned
// `id`. The old `prompts.json` is NEVER read, renamed or deleted — see docs/PROTOCOL.md
// "Bibliothèque de prompts et préférences par site" → "Stockage". No migration: a library that
// existed under the old format simply does not appear anymore.

import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import type { PromptEntry } from "./protocol.ts";
import { PROMPT_ID_PREFIX, PROMPT_ID_RE, PROMPT_TITLE_MAX, PROMPT_BODY_MAX, isValidSiteKey } from "./protocol.ts";

export interface PromptsDirs {
  /** Directory holding prompts-v2.json, e.g. ~/.local/share/coati */
  dataDir: string;
}

const STORE_VERSION = 2;

interface PromptsStore {
  version: 2;
  prompts: PromptEntry[];
}

function promptsPath(dirs: PromptsDirs): string {
  return join(dirs.dataDir, "prompts-v2.json");
}

function isPromptEntry(v: unknown): v is PromptEntry {
  if (typeof v !== "object" || v === null) return false;
  const r = v as Record<string, unknown>;
  if (typeof r.id !== "string" || !PROMPT_ID_RE.test(r.id)) return false;
  if (!isValidSiteKey(r.site)) return false;
  if (typeof r.body !== "string" || r.body.length === 0 || r.body.length > PROMPT_BODY_MAX) return false;
  if (r.title !== undefined && (typeof r.title !== "string" || r.title.length > PROMPT_TITLE_MAX)) return false;
  return true;
}

/** Reads prompts-v2.json. Absent, unreadable, corrupt or unknown-shaped → empty
 * library, never throws — the client never sees a broker-side read failure. */
function readAll(dirs: PromptsDirs): PromptEntry[] {
  const path = promptsPath(dirs);
  if (!existsSync(path)) return [];
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    return [];
  }
  try {
    const parsed = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null || !Array.isArray((parsed as PromptsStore).prompts)) {
      return [];
    }
    return (parsed as PromptsStore).prompts.filter(isPromptEntry);
  } catch {
    return [];
  }
}

/**
 * Writes atomically: write to a sibling temp file, then rename over the
 * target. Rename is atomic on POSIX, so a reader (or a crash mid-write) never
 * observes a partially-written prompts-v2.json. `writeFileSync`'s mode is kept
 * through the rename, so the 0600 permission survives.
 */
function writeAllAtomic(dirs: PromptsDirs, items: PromptEntry[]): void {
  if (!existsSync(dirs.dataDir)) {
    mkdirSync(dirs.dataDir, { recursive: true });
  }
  const target = promptsPath(dirs);
  const tmp = join(dirs.dataDir, `.prompts-v2.json.${process.pid}.${randomBytes(6).toString("hex")}.tmp`);
  const store: PromptsStore = { version: STORE_VERSION, prompts: items };
  try {
    writeFileSync(tmp, JSON.stringify(store, null, 2) + "\n", { mode: 0o600 });
    renameSync(tmp, target);
  } catch (err) {
    try {
      unlinkSync(tmp);
    } catch {
      // tmp was never created, or already gone — fine either way.
    }
    throw err;
  }
}

export function listPrompts(dirs: PromptsDirs): PromptEntry[] {
  return readAll(dirs);
}

/**
 * Per-dataDir serialization so two concurrent callers (e.g. two open panels
 * saving/deleting at the same time) queue instead of racing a read-modify-write
 * against each other — the atomic rename above only protects a single write
 * from being observed half-done, not two writes from clobbering one another.
 *
 * Exported so prefs.ts's prompts.move handler (server.ts) can share the same
 * lock across both files — see docs/PROTOCOL.md "prompts.move".
 */
const dirLocks = new Map<string, Promise<unknown>>();

export function withDirLock<T>(dataDir: string, fn: () => T | Promise<T>): Promise<T> {
  const prev = dirLocks.get(dataDir) ?? Promise.resolve();
  const next = prev.then(fn, fn);
  // Track a settled-either-way promise so a prior rejection never wedges the queue.
  dirLocks.set(
    dataDir,
    next.then(
      () => undefined,
      () => undefined,
    ),
  );
  return next;
}

function newPromptId(): string {
  return PROMPT_ID_PREFIX + randomBytes(6).toString("hex");
}

/**
 * Creates or updates a prompt and returns the full updated list.
 *
 * `prompt.id` absent → create (a fresh id is assigned here). `prompt.id`
 * present → update title/body of that prompt; `site` is ignored (moving
 * site is prompts.move's job, so prompts-v2.json and prefs.json never need
 * to be kept in sync by this function). An unknown id throws — server.ts
 * turns that into a bad-request error, never a silent create.
 */
export function savePrompt(
  dirs: PromptsDirs,
  prompt: { id?: string; site: string; title?: string; body: string },
): Promise<PromptEntry[]> {
  return withDirLock(dirs.dataDir, () => {
    const items = readAll(dirs);
    if (prompt.id === undefined) {
      const entry: PromptEntry = { id: newPromptId(), site: prompt.site, body: prompt.body };
      if (prompt.title !== undefined) entry.title = prompt.title;
      items.push(entry);
    } else {
      const idx = items.findIndex((p) => p.id === prompt.id);
      if (idx < 0) {
        throw new Error(`prompts.save: unknown id ${prompt.id}`);
      }
      const updated: PromptEntry = { ...items[idx], body: prompt.body };
      if (prompt.title !== undefined) {
        updated.title = prompt.title;
      } else {
        delete updated.title;
      }
      items[idx] = updated;
    }
    writeAllAtomic(dirs, items);
    return items;
  });
}

/**
 * Deletes a prompt by id and returns the full updated list. Idempotent: an
 * unknown id is a no-op, never an error — see docs/PROTOCOL.md
 * "prompts.delete".
 */
export function deletePrompt(dirs: PromptsDirs, promptId: string): Promise<PromptEntry[]> {
  return withDirLock(dirs.dataDir, () => {
    const items = readAll(dirs).filter((p) => p.id !== promptId);
    writeAllAtomic(dirs, items);
    return items;
  });
}

/** Moves a prompt's `site` in place, inside an already-held lock — used by
 * server.ts's prompts.move handler alongside prefs.ts's moveSitePrefs, under
 * the SAME withDirLock call so both files are written consistently. Throws
 * on an unknown id (server.ts turns that into bad-request). */
export function setPromptSite(dirs: PromptsDirs, promptId: string, site: string): PromptEntry[] {
  const items = readAll(dirs);
  const idx = items.findIndex((p) => p.id === promptId);
  if (idx < 0) {
    throw new Error(`prompts.move: unknown id ${promptId}`);
  }
  items[idx] = { ...items[idx], site };
  writeAllAtomic(dirs, items);
  return items;
}
