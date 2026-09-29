// Per-site display preferences persisted at ~/.local/share/coati/prefs.json.
// Amendement 2026-09-28 ("Mes prompts par site" — docs/DECISIONS.md T41). Same
// guarantees as prompts.ts: atomic write, per-dataDir lock, tolerant read
// (absent/corrupt/unknown shape → empty, never throws at the client). See
// docs/PROTOCOL.md "prefs.get / prefs.set".

import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import type { SitePrefs } from "./protocol.ts";
import { isValidSiteKey, isValidOrderItem, PREFS_ORDER_MAX, PREFS_SITES_MAX } from "./protocol.ts";
import { withDirLock } from "./prompts.ts";

export interface PrefsDirs {
  /** Directory holding prefs.json, e.g. ~/.local/share/coati */
  dataDir: string;
}

const STORE_VERSION = 1;

interface PrefsStore {
  version: 1;
  sites: Record<string, SitePrefs>;
}

function prefsPath(dirs: PrefsDirs): string {
  return join(dirs.dataDir, "prefs.json");
}

function dedupe(items: string[]): string[] {
  return Array.from(new Set(items));
}

/** Keeps only well-formed items, drops the field if it ends up empty — mirrors
 * the bounds enforced at parse time (protocol.ts) so a hand-edited or
 * partially-corrupt file degrades instead of throwing. */
function sanitizeSitePrefs(v: unknown): SitePrefs | undefined {
  if (typeof v !== "object" || v === null) return undefined;
  const r = v as Record<string, unknown>;
  const out: SitePrefs = {};
  if (Array.isArray(r.order)) {
    const order = dedupe(r.order.filter(isValidOrderItem)).slice(0, PREFS_ORDER_MAX);
    if (order.length > 0) out.order = order;
  }
  if (Array.isArray(r.removed)) {
    const removed = dedupe(r.removed.filter(isValidOrderItem)).slice(0, PREFS_ORDER_MAX);
    if (removed.length > 0) out.removed = removed;
  }
  return out.order || out.removed ? out : undefined;
}

function readAll(dirs: PrefsDirs): Record<string, SitePrefs> {
  const path = prefsPath(dirs);
  if (!existsSync(path)) return {};
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    return {};
  }
  try {
    const parsed = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null || typeof (parsed as PrefsStore).sites !== "object") {
      return {};
    }
    const sites = (parsed as PrefsStore).sites;
    const out: Record<string, SitePrefs> = {};
    let count = 0;
    for (const [site, entry] of Object.entries(sites ?? {})) {
      if (!isValidSiteKey(site)) continue;
      const sanitized = sanitizeSitePrefs(entry);
      if (!sanitized) continue;
      if (count >= PREFS_SITES_MAX) break;
      out[site] = sanitized;
      count++;
    }
    return out;
  } catch {
    return {};
  }
}

function writeAllAtomic(dirs: PrefsDirs, sites: Record<string, SitePrefs>): void {
  if (!existsSync(dirs.dataDir)) {
    mkdirSync(dirs.dataDir, { recursive: true });
  }
  const target = prefsPath(dirs);
  const tmp = join(dirs.dataDir, `.prefs.json.${process.pid}.${randomBytes(6).toString("hex")}.tmp`);
  const store: PrefsStore = { version: STORE_VERSION, sites };
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

export function getPrefs(dirs: PrefsDirs): Record<string, SitePrefs> {
  return readAll(dirs);
}

/** Replaces one site's entry entirely (`order`/`removed` each optional and
 * independent — a field present replaces, it does not merge; a field absent
 * leaves the other unchanged). An entry left empty is dropped rather than
 * persisted empty. Returns the full updated prefs. */
export function setSitePrefs(dirs: PrefsDirs, site: string, prefs: SitePrefs): Promise<Record<string, SitePrefs>> {
  return withDirLock(dirs.dataDir, () => {
    const sites = readAll(dirs);
    const existing = sites[site];
    const merged: SitePrefs = {
      order: prefs.order !== undefined ? dedupe(prefs.order).slice(0, PREFS_ORDER_MAX) : existing?.order,
      removed: prefs.removed !== undefined ? dedupe(prefs.removed).slice(0, PREFS_ORDER_MAX) : existing?.removed,
    };
    const isEmpty = (!merged.order || merged.order.length === 0) && (!merged.removed || merged.removed.length === 0);
    if (isEmpty) {
      delete sites[site];
    } else {
      if (!merged.order || merged.order.length === 0) delete merged.order;
      if (!merged.removed || merged.removed.length === 0) delete merged.removed;
      sites[site] = merged;
    }
    writeAllAtomic(dirs, sites);
    return sites;
  });
}

/** Removes `promptId` from the source site's order and replaces the
 * destination site's order with `destOrder` — the two halves of
 * prompts.move's prefs side. Must be called INSIDE the same withDirLock as
 * the matching prompts-v2.json write (server.ts) so both files move
 * together. Not itself lock-wrapped — the caller already holds the lock. */
export function moveInPrefs(
  dirs: PrefsDirs,
  promptId: string,
  destSite: string,
  destOrder: string[],
): Record<string, SitePrefs> {
  const sites = readAll(dirs);
  for (const [site, prefs] of Object.entries(sites)) {
    if (site === destSite) continue;
    if (prefs.order?.includes(promptId)) {
      const order = prefs.order.filter((it) => it !== promptId);
      if (order.length > 0) {
        sites[site] = { ...prefs, order };
      } else {
        const rest = { ...prefs };
        delete rest.order;
        if (rest.removed && rest.removed.length > 0) {
          sites[site] = rest;
        } else {
          delete sites[site];
        }
      }
    }
  }
  const order = dedupe(destOrder).slice(0, PREFS_ORDER_MAX);
  if (order.length > 0) {
    sites[destSite] = { ...sites[destSite], order };
  } else if (sites[destSite]) {
    delete sites[destSite].order;
    if (!sites[destSite].removed || sites[destSite].removed!.length === 0) delete sites[destSite];
  }
  writeAllAtomic(dirs, sites);
  return sites;
}
