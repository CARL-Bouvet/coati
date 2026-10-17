// Console behaviour of the compiled binary: the Windows serve process drops
// its own console window; the installer waits for Enter when double-clicked.

import { dlopen, ptr } from "bun:ffi";

/**
 * Windows `--serve`: a console created for this process alone (autostart)
 * is released, so no window stays open. A console shared with a shell is kept.
 * The detached console invalidates stdout/stderr, so console output is dropped.
 */
export function releaseOwnConsole(): void {
  if (process.platform !== "win32") return;
  const k = dlopen("kernel32.dll", {
    GetConsoleProcessList: { args: ["ptr", "u32"], returns: "u32" },
    FreeConsole: { args: [], returns: "i32" },
  });
  const attached = k.symbols.GetConsoleProcessList(ptr(new Uint32Array(2)), 2);
  if (attached !== 1) return;
  k.symbols.FreeConsole();
  for (const m of ["log", "info", "warn", "error", "debug"] as const) console[m] = () => {};
}

export function waitForEnter(prompt = "Press Enter to close this window."): Promise<void> {
  process.stdout.write(`\n${prompt}\n`);
  return new Promise((resolve) => {
    process.stdin.once("data", () => resolve());
    process.stdin.resume();
  });
}
