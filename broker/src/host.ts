// Reads the machine's hardware capacity once per process lifetime.
// Used by server.ts to fill the `host` field of a `models` reply and to
// classify each local Ollama model as "gpu" / "shared" / "too-big".
//
// Design constraints:
//   - Never throws (all errors return safe defaults).
//   - Total wall-clock time ≤ 1.5 s (spawn timeout = 1 s; sysfs reads are instant).
//   - Result is cached for the process lifetime — weights never change without
//     a restart, and the machine's RAM/VRAM never changes while running.

import { totalmem } from "node:os";
import { readdirSync, readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import type { SpawnSyncReturns } from "node:child_process";

import type { HostCapacity, ModelFit } from "./protocol.ts";
export type { HostCapacity, ModelFit };

// ---------------------------------------------------------------------------
// Classification constants — one place to change them.
// ---------------------------------------------------------------------------

/** Constants for fit classification. All sizes in bytes unless noted. */
export const FIT_CONSTANTS = {
  /** Extra memory beyond model weights (KV cache, runtime, etc.). */
  OVERHEAD_BYTES: 1.5 * 1e9,
  /** Max RAM fraction usable when GPU shares host RAM (macOS unified memory). */
  UNIFIED_RAM_FRACTION: 0.75,
  /** RAM fraction that supplements dedicated VRAM (shared inference path). */
  RAM_SUPPLEMENT_FRACTION: 0.5,
  /** RAM fraction available for CPU-only inference (no GPU at all). */
  CPU_RAM_FRACTION: 0.5,
} as const;

// ---------------------------------------------------------------------------
// Test seams — only broker/test/*.test.ts should call these.
// ---------------------------------------------------------------------------

type ReaddirFn = (path: string) => string[];
type ReadFileFn = (path: string, enc: "utf8") => string;
type SpawnSyncFn = (
  cmd: string,
  args: readonly string[],
  opts: { timeout: number; encoding: "utf8"; shell: boolean },
) => SpawnSyncReturns<string>;

let _readdir: ReaddirFn = (p) => readdirSync(p) as unknown as string[];
let _readFile: ReadFileFn = (p, e) => readFileSync(p, e) as string;
let _spawnSync: SpawnSyncFn = (cmd, args, opts) =>
  spawnSync(cmd, args as string[], opts) as SpawnSyncReturns<string>;
let _platform: NodeJS.Platform | undefined;
let _cachedOverride: HostCapacity | undefined; // set directly by __overrideCapacityForTests

export function __setFsForTests(rd: ReaddirFn, rf: ReadFileFn): void {
  _readdir = rd;
  _readFile = rf;
}
export function __setSpawnForTests(fn: SpawnSyncFn): void {
  _spawnSync = fn;
}
export function __setPlatformForTests(p: NodeJS.Platform): void {
  _platform = p;
}
/** Injects a known capacity directly — skips all real reads. Use in integration
 *  tests that don't want to exercise the read logic itself. */
export function __overrideCapacityForTests(cap: HostCapacity): void {
  _cachedOverride = cap;
  cachedCapacity = cap;
}
export function __resetHostForTests(): void {
  _readdir = (p) => readdirSync(p) as unknown as string[];
  _readFile = (p, e) => readFileSync(p, e) as string;
  _spawnSync = (cmd, args, opts) =>
    spawnSync(cmd, args as string[], opts) as SpawnSyncReturns<string>;
  _platform = undefined;
  _cachedOverride = undefined;
  cachedCapacity = undefined;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

let cachedCapacity: HostCapacity | undefined;

/** Returns the largest VRAM byte count found in AMD sysfs DRM entries, or null. */
function readAmdVramBytes(): number | null {
  const base = "/sys/class/drm";
  let cards: string[];
  try {
    cards = _readdir(base);
  } catch {
    return null;
  }
  let max = 0;
  for (const card of cards) {
    if (!/^card\d+$/.test(card)) continue;
    try {
      const raw = _readFile(`${base}/${card}/device/mem_info_vram_total`, "utf8").trim();
      const val = parseInt(raw, 10);
      if (!isNaN(val) && val > max) max = val;
    } catch {
      // This card has no VRAM file — skip.
    }
  }
  return max > 0 ? max : null;
}

/** Returns the largest VRAM MiB count from nvidia-smi, or null.
 *  Spawns synchronously with a 1 s timeout; shell:false prevents PATH injection. */
function readNvidiaVramMib(): number | null {
  try {
    const result = _spawnSync(
      "nvidia-smi",
      ["--query-gpu=memory.total", "--format=csv,noheader,nounits"],
      { timeout: 1000, encoding: "utf8", shell: false },
    );
    if (result.status !== 0 || result.error) return null;
    const lines = ((result.stdout as string) ?? "").trim().split("\n");
    let max = 0;
    for (const line of lines) {
      const mib = parseInt(line.trim(), 10);
      if (!isNaN(mib) && mib > max) max = mib;
    }
    return max > 0 ? max : null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Reads the machine's RAM and (when detectable) VRAM, caches for the process
 * lifetime. Never throws; total wall time ≤ 1.5 s.
 *
 * - ramGb  = os.totalmem() rounded to 1 decimal (÷ 1e9).
 * - Linux  : tries AMD sysfs first, then nvidia-smi if AMD yields nothing.
 * - macOS  : vramGb = null, unifiedMemory = true (GPU shares RAM).
 * - Windows / other : vramGb = null.
 */
export async function readHostCapacity(): Promise<HostCapacity> {
  if (cachedCapacity) return cachedCapacity;

  const ramGb = Math.round((totalmem() / 1e9) * 10) / 10;
  const platform = _platform ?? (process.platform as NodeJS.Platform);

  let vramGb: number | null = null;
  let unifiedMemory: true | undefined;

  if (platform === "darwin") {
    unifiedMemory = true;
  } else if (platform === "linux") {
    const amdBytes = readAmdVramBytes();
    if (amdBytes !== null) {
      vramGb = Math.round((amdBytes / 1e9) * 10) / 10;
    } else {
      const nvMib = readNvidiaVramMib();
      if (nvMib !== null) {
        vramGb = Math.round((nvMib * 1024 * 1024 / 1e9) * 10) / 10;
      }
    }
  }
  // Windows / other: vramGb stays null.

  cachedCapacity = {
    ramGb,
    vramGb,
    ...(unifiedMemory ? { unifiedMemory } : {}),
  };
  return cachedCapacity;
}

/**
 * Classifies a local model's memory fit against the host's capacity.
 *
 * Rules (OVERHEAD_BYTES = 1.5 GB margin for KV cache + runtime):
 *   unifiedMemory: "gpu" if needed ≤ 0.75×RAM, else "too-big".
 *   vramGb known : "gpu" if needed ≤ VRAM;
 *                  "shared" if needed ≤ VRAM + 0.5×RAM;
 *                  else "too-big".
 *   no GPU       : "shared" if needed ≤ 0.5×RAM, else "too-big".
 */
export function computeFit(sizeBytes: number, host: HostCapacity): ModelFit {
  const needed = sizeBytes + FIT_CONSTANTS.OVERHEAD_BYTES;

  if (host.unifiedMemory) {
    return needed <= FIT_CONSTANTS.UNIFIED_RAM_FRACTION * host.ramGb * 1e9 ? "gpu" : "too-big";
  }

  if (host.vramGb !== null) {
    const vramBytes = host.vramGb * 1e9;
    if (needed <= vramBytes) return "gpu";
    if (needed <= vramBytes + FIT_CONSTANTS.RAM_SUPPLEMENT_FRACTION * host.ramGb * 1e9) return "shared";
    return "too-big";
  }

  // No GPU at all — CPU-only inference.
  return needed <= FIT_CONSTANTS.CPU_RAM_FRACTION * host.ramGb * 1e9 ? "shared" : "too-big";
}
