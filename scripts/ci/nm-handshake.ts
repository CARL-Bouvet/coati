// scripts/ci/nm-handshake.ts — goal G4, CI e2e (see scripts/ci/e2e.sh). Small
// bun helper that performs exactly ONE Native Messaging round trip against a
// given host binary, the way a browser launches it: spawns
// `<binary> <arg>...` (the caller arguments Chrome/Firefox append — the
// pinned origin, --parent-window, a manifest path + extension id, a foreign
// id...), writes one framed `key.get` request to its stdin, reads one framed
// reply off its stdout, and prints that reply as a single line of JSON on
// THIS process's own stdout (nothing else goes to stdout — diagnostics go to
// stderr, same discipline as broker/src/native-host.ts itself).
//
// Exit code mirrors docs/PROTOCOL.md's "Hôte natif" contract: 0 whenever a
// reply was sent (including every `{"type":"error",...}` reply — a
// forbidden caller IS a normal, successful round trip), 1 when the child
// itself reports a framing failure without ever writing a reply. A 5s
// wall-clock cap (matching native-host.ts's HOST_FRAME_TIMEOUT_MS) guards
// against a hung child; exit code 3 then, message on stderr.
//
// Usage: bun scripts/ci/nm-handshake.ts <binary> <arg>...
//   e.g. bun scripts/ci/nm-handshake.ts ./coati-broker \
//          chrome-extension://hehlgipomfminodhahcjbencblepjhah/
//
// COATI_DATA_DIR (and everything else in this process's env) is inherited by
// the child unchanged — Bun.spawn's default when `env` isn't passed.

import { encodeJsonFrame, tryParseFrame } from "../../broker/src/nm-framing.ts";

const [binary, ...args] = process.argv.slice(2);
if (!binary) {
  console.error("usage: bun scripts/ci/nm-handshake.ts <binary> <arg>...");
  process.exit(2);
}

const TIMEOUT_MS = 5000;

const proc = Bun.spawn([binary, ...args], {
  stdin: "pipe",
  stdout: "pipe",
  stderr: "inherit",
});

proc.stdin.write(encodeJsonFrame({ type: "key.get", v: 1 }));
await proc.stdin.end();

const outPromise = new Response(proc.stdout).arrayBuffer();
const timedOut = Symbol("timeout");
const raced = await Promise.race([
  outPromise,
  new Promise<typeof timedOut>((resolve) => setTimeout(() => resolve(timedOut), TIMEOUT_MS)),
]);

if (raced === timedOut) {
  console.error(`nm-handshake: no reply within ${TIMEOUT_MS}ms`);
  try {
    proc.kill();
  } catch {
    // best-effort
  }
  process.exit(3);
}

const exitCode = await proc.exited;
const parsed = tryParseFrame(Buffer.from(raced as ArrayBuffer));
if (parsed.status !== "complete") {
  console.error(`nm-handshake: no complete frame (${parsed.status}), child exit ${exitCode}`);
  process.exit(exitCode === 0 ? 1 : exitCode);
}

console.log(JSON.stringify(JSON.parse(parsed.body.toString("utf8"))));
process.exit(exitCode);
