// Native Messaging host — docs/PROTOCOL.md "Hôte natif : lancement et
// détection" / "Cadrage et échange avec l'hôte" (amendement 2026-09-30, G4).
// Same executable as the broker (server.ts dispatches here before anything
// else when process.argv matches — see isNativeHostInvocation); also runnable
// standalone (`bun run src/native-host.ts <args>`, this file's own
// import.meta.main block) for the launcher script and for tests that spawn
// it directly.
//
// Reads EXACTLY ONE Native Messaging frame, replies with exactly one, and
// exits. Never writes anything to stdout besides that one reply frame — every
// diagnostic goes to stderr, prefixed `coati-native-host:`, and NEVER
// includes the key.

import { defaultDirs, type Dirs } from "./config.ts";
import { readBrokerKeyFile } from "./broker-key.ts";
import { encodeJsonFrame, tryParseFrame } from "./nm-framing.ts";

export const CHROMIUM_PINNED_ORIGIN = "chrome-extension://hehlgipomfminodhahcjbencblepjhah/";
export const FIREFOX_PINNED_ID = "coati@getcoati.com";

// Generic shape Chrome uses for the calling origin argument — used only to
// DETECT host mode (docs/PROTOCOL.md's mode switch, unchanged by this
// amendment); verifyCaller below is what actually checks it's the ONE pinned
// origin, not just this shape.
const CHROME_EXTENSION_ORIGIN_ARG_RE = /^chrome-extension:\/\/[a-p]{32}\/$/;

/** Pure: true iff `argv` (process.argv, including argv[0]/argv[1]) signals
 * "run as the native host" — docs/PROTOCOL.md's mode switch. Checked BEFORE
 * anything else in server.ts's main. */
export function isNativeHostInvocation(argv: readonly string[]): boolean {
  if (argv.includes("--native-host")) return true;
  if (argv.some((a) => CHROME_EXTENSION_ORIGIN_ARG_RE.test(a))) return true;
  if (argv.includes(FIREFOX_PINNED_ID)) return true;
  return false;
}

function looksLikePathArg(arg: string): boolean {
  return arg.includes("/") || arg.includes("\\");
}

export type CallerVerification = { ok: true } | { ok: false };

/**
 * Defense in depth (docs/PROTOCOL.md "Contrôle de l'appelant") — the browser
 * has already checked the caller before launching this process at all
 * (`allowed_origins`/`allowed_extensions`). This only protects against a
 * direct invocation of the executable, outside any browser:
 *  - Chromium form: an argument exactly equal to the pinned origin string.
 *  - Firefox form: BOTH `coati@getcoati.com` AND another, path-shaped
 *    argument (the manifest path Firefox always passes first) must be
 *    present — the ID alone is not enough, Firefox never invokes the host
 *    that way.
 */
export function verifyCaller(argv: readonly string[]): CallerVerification {
  if (argv.includes(CHROMIUM_PINNED_ORIGIN)) return { ok: true };
  const hasFirefoxId = argv.includes(FIREFOX_PINNED_ID);
  const hasPathArg = argv.some((a) => a !== FIREFOX_PINNED_ID && looksLikePathArg(a));
  if (hasFirefoxId && hasPathArg) return { ok: true };
  return { ok: false };
}

function writeStdout(buf: Buffer): Promise<void> {
  return new Promise((resolve, reject) => {
    process.stdout.write(buf, (err) => (err ? reject(err) : resolve()));
  });
}

export const HOST_FRAME_TIMEOUT_MS = 5000;

type ReadFrameOutcome =
  | { status: "ok"; body: Buffer }
  | { status: "invalid-length" }
  | { status: "timeout" }
  | { status: "eof" };

/** Reads bytes off `stdin` until exactly one frame is parsed, the length
 * header is invalid, the stream ends early, or `timeoutMs` elapses —
 * whichever comes first. Never throws. */
function readOneFrame(stdin: NodeJS.ReadableStream, timeoutMs: number): Promise<ReadFrameOutcome> {
  return new Promise((resolve) => {
    let buffered = Buffer.alloc(0);
    let settled = false;

    const finish = (outcome: ReadFrameOutcome) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      stdin.removeListener("data", onData);
      stdin.removeListener("end", onEnd);
      stdin.removeListener("error", onError);
      resolve(outcome);
    };

    const onData = (chunk: Buffer) => {
      buffered = Buffer.concat([buffered, chunk]);
      const parsed = tryParseFrame(buffered);
      if (parsed.status === "complete") finish({ status: "ok", body: parsed.body });
      else if (parsed.status === "invalid-length") finish({ status: "invalid-length" });
      // "incomplete": keep buffering.
    };
    const onEnd = () => finish({ status: "eof" });
    const onError = () => finish({ status: "eof" });
    const timer = setTimeout(() => finish({ status: "timeout" }), timeoutMs);

    stdin.on("data", onData);
    stdin.on("end", onEnd);
    stdin.on("error", onError);
    if (typeof (stdin as { resume?: () => void }).resume === "function") {
      (stdin as { resume: () => void }).resume();
    }
  });
}

function isKeyGetRequest(v: unknown): boolean {
  return !!v && typeof v === "object" && (v as Record<string, unknown>).type === "key.get" && (v as Record<string, unknown>).v === 1;
}

/**
 * The host's whole logic, minus process wiring — takes stdin explicitly so
 * tests can feed it a fake stream without spawning a real process. Returns
 * the process exit code (docs/PROTOCOL.md): 0 whenever a reply was sent
 * (including every `error` reply), 1 when the frame itself was malformed
 * (bad length, timeout, premature EOF) and NOTHING was sent.
 */
export async function runNativeHostLogic(
  argv: readonly string[],
  dirs: Pick<Dirs, "dataDir">,
  stdin: NodeJS.ReadableStream,
): Promise<number> {
  const verification = verifyCaller(argv);
  if (!verification.ok) {
    console.error("coati-native-host: forbidden-caller");
    try {
      await writeStdout(encodeJsonFrame({ type: "error", v: 1, code: "forbidden-caller" }));
    } catch {
      // Best-effort: the exit code already reflects the outcome via logs.
    }
    return 0;
  }

  const frame = await readOneFrame(stdin, HOST_FRAME_TIMEOUT_MS);
  if (frame.status !== "ok") {
    console.error(`coati-native-host: ${frame.status}`);
    return 1;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(frame.body.toString("utf8"));
  } catch {
    console.error("coati-native-host: bad-request");
    await safeReply({ type: "error", v: 1, code: "bad-request" });
    return 0;
  }

  if (!isKeyGetRequest(parsed)) {
    console.error("coati-native-host: bad-request");
    await safeReply({ type: "error", v: 1, code: "bad-request" });
    return 0;
  }

  try {
    const result = readBrokerKeyFile(dirs);
    if (!result.ok) {
      console.error(`coati-native-host: ${result.reason}`);
      await safeReply({ type: "error", v: 1, code: result.reason });
      return 0;
    }
    console.error("coati-native-host: key served");
    await safeReply({ type: "key", v: 1, key: result.file.key });
    return 0;
  } catch {
    console.error("coati-native-host: internal");
    await safeReply({ type: "error", v: 1, code: "internal" });
    return 0;
  }

  async function safeReply(msg: Record<string, unknown>): Promise<void> {
    try {
      await writeStdout(encodeJsonFrame(msg));
    } catch {
      // The process still exits 0 (a reply was attempted) — nothing more to do.
    }
  }
}

/** Real-process entrypoint: process.argv/process.stdin, real dataDir. */
export async function runNativeHost(argv: readonly string[], dirs: Pick<Dirs, "dataDir">): Promise<number> {
  return runNativeHostLogic(argv, dirs, process.stdin);
}

if (import.meta.main) {
  const argv = process.argv.slice(2);
  const dirs = defaultDirs();
  process.exit(await runNativeHost(argv, dirs));
}
