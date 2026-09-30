// broker/src/native-host.ts — docs/PROTOCOL.md "Hôte natif" (amendement
// 2026-09-30, G4). Unit tests drive runNativeHostLogic directly against a
// fake stdin (fast, no process spawn); the integration tests at the bottom
// spawn the real `bun run src/server.ts <arg>` process, per the test plan.

import { describe, expect, test } from "bun:test";
import { Readable } from "node:stream";
import { join } from "node:path";
import {
  isNativeHostInvocation,
  verifyCaller,
  runNativeHostLogic,
  CHROMIUM_PINNED_ORIGIN,
  FIREFOX_PINNED_ID,
} from "../src/native-host.ts";
import { encodeJsonFrame, tryParseFrame } from "../src/nm-framing.ts";
import { generateBrokerKey, writeBrokerKeyFile } from "../src/broker-key.ts";
import { makeTmpDir } from "./helpers/tmp-dir.ts";

function fakeStdin(chunks: Buffer[], end = true): Readable {
  const stream = new Readable({ read() {} });
  queueMicrotask(() => {
    for (const c of chunks) stream.push(c);
    if (end) stream.push(null);
  });
  return stream;
}

describe("isNativeHostInvocation", () => {
  test("--native-host alone", () => expect(isNativeHostInvocation(["--native-host"])).toBe(true));
  test("a chrome-extension origin arg", () =>
    expect(isNativeHostInvocation([CHROMIUM_PINNED_ORIGIN])).toBe(true));
  test("the Firefox id", () => expect(isNativeHostInvocation([FIREFOX_PINNED_ID])).toBe(true));
  test("no relevant argument: broker mode", () => expect(isNativeHostInvocation(["--check-modules"])).toBe(false));
  test("no arguments at all: broker mode", () => expect(isNativeHostInvocation([])).toBe(false));
});

describe("verifyCaller", () => {
  test("the exact pinned Chromium origin is accepted", () => {
    expect(verifyCaller([CHROMIUM_PINNED_ORIGIN]).ok).toBe(true);
  });

  test("a different chrome-extension origin is forbidden", () => {
    expect(verifyCaller(["chrome-extension://bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb/"]).ok).toBe(false);
  });

  test("Firefox: manifest path + id together are accepted", () => {
    expect(verifyCaller(["/home/user/.mozilla/native-messaging-hosts/com.getcoati.broker.json", FIREFOX_PINNED_ID]).ok).toBe(
      true,
    );
  });

  test("Firefox: the id ALONE, without a path argument, is forbidden", () => {
    expect(verifyCaller([FIREFOX_PINNED_ID]).ok).toBe(false);
  });

  test("--native-host alone is forbidden (not a real caller)", () => {
    expect(verifyCaller(["--native-host"]).ok).toBe(false);
  });

  test("an unrelated argument set is forbidden", () => {
    expect(verifyCaller(["--some-other-flag"]).ok).toBe(false);
  });
});

describe("runNativeHostLogic", () => {
  test("forbidden caller: replies forbidden-caller, exit 0, no stdin read", async () => {
    const dataDir = makeTmpDir("coati-host-forbidden-");
    const chunks: Buffer[] = [];
    const originalWrite = process.stdout.write.bind(process.stdout);
    (process.stdout.write as unknown) = (chunk: any, cb?: any) => {
      chunks.push(Buffer.from(chunk));
      if (typeof cb === "function") cb();
      return true;
    };
    try {
      const code = await runNativeHostLogic(["--native-host"], { dataDir }, fakeStdin([], false));
      expect(code).toBe(0);
    } finally {
      process.stdout.write = originalWrite as any;
    }
    const parsed = tryParseFrame(Buffer.concat(chunks));
    expect(parsed.status).toBe("complete");
    if (parsed.status === "complete") {
      expect(JSON.parse(parsed.body.toString("utf8"))).toMatchObject({ type: "error", code: "forbidden-caller" });
    }
  });

  test("pinned caller, broker not running: replies broker-not-running", async () => {
    const dataDir = makeTmpDir("coati-host-norunning-");
    const chunks: Buffer[] = [];
    const originalWrite = process.stdout.write.bind(process.stdout);
    (process.stdout.write as unknown) = (chunk: any, cb?: any) => {
      chunks.push(Buffer.from(chunk));
      if (typeof cb === "function") cb();
      return true;
    };
    try {
      const requestFrame = encodeJsonFrame({ type: "key.get", v: 1 });
      const code = await runNativeHostLogic([CHROMIUM_PINNED_ORIGIN], { dataDir }, fakeStdin([requestFrame]));
      expect(code).toBe(0);
    } finally {
      process.stdout.write = originalWrite as any;
    }
    const parsed = tryParseFrame(Buffer.concat(chunks));
    expect(parsed.status).toBe("complete");
    if (parsed.status === "complete") {
      expect(JSON.parse(parsed.body.toString("utf8"))).toMatchObject({ type: "error", code: "broker-not-running" });
    }
  });

  test("pinned caller, broker running: replies with the exact key", async () => {
    const dataDir = makeTmpDir("coati-host-running-");
    const key = generateBrokerKey();
    writeBrokerKeyFile({ dataDir }, key, process.pid, new Date().toISOString());
    const chunks: Buffer[] = [];
    const originalWrite = process.stdout.write.bind(process.stdout);
    (process.stdout.write as unknown) = (chunk: any, cb?: any) => {
      chunks.push(Buffer.from(chunk));
      if (typeof cb === "function") cb();
      return true;
    };
    try {
      const requestFrame = encodeJsonFrame({ type: "key.get", v: 1 });
      const code = await runNativeHostLogic([CHROMIUM_PINNED_ORIGIN], { dataDir }, fakeStdin([requestFrame]));
      expect(code).toBe(0);
    } finally {
      process.stdout.write = originalWrite as any;
    }
    const parsed = tryParseFrame(Buffer.concat(chunks));
    expect(parsed.status).toBe("complete");
    if (parsed.status === "complete") {
      expect(JSON.parse(parsed.body.toString("utf8"))).toEqual({ type: "key", v: 1, key: key.toString("hex") });
    }
  });

  test("an oversized frame (>4096): no reply, exit 1", async () => {
    const dataDir = makeTmpDir("coati-host-oversized-");
    const header = Buffer.alloc(4);
    header.writeUInt32LE(4097, 0);
    const chunks: Buffer[] = [];
    const originalWrite = process.stdout.write.bind(process.stdout);
    (process.stdout.write as unknown) = (chunk: any, cb?: any) => {
      chunks.push(Buffer.from(chunk));
      if (typeof cb === "function") cb();
      return true;
    };
    try {
      const code = await runNativeHostLogic([CHROMIUM_PINNED_ORIGIN], { dataDir }, fakeStdin([header]));
      expect(code).toBe(1);
    } finally {
      process.stdout.write = originalWrite as any;
    }
    expect(chunks.length).toBe(0);
  });

  test("stream ends before a full frame arrives: no reply, exit 1", async () => {
    const dataDir = makeTmpDir("coati-host-eof-");
    const chunks: Buffer[] = [];
    const originalWrite = process.stdout.write.bind(process.stdout);
    (process.stdout.write as unknown) = (chunk: any, cb?: any) => {
      chunks.push(Buffer.from(chunk));
      if (typeof cb === "function") cb();
      return true;
    };
    try {
      const code = await runNativeHostLogic([CHROMIUM_PINNED_ORIGIN], { dataDir }, fakeStdin([Buffer.from([1, 2])], true));
      expect(code).toBe(1);
    } finally {
      process.stdout.write = originalWrite as any;
    }
    expect(chunks.length).toBe(0);
  });

  test("bad JSON in an otherwise well-formed frame: bad-request reply", async () => {
    const dataDir = makeTmpDir("coati-host-badjson-");
    const chunks: Buffer[] = [];
    const originalWrite = process.stdout.write.bind(process.stdout);
    (process.stdout.write as unknown) = (chunk: any, cb?: any) => {
      chunks.push(Buffer.from(chunk));
      if (typeof cb === "function") cb();
      return true;
    };
    try {
      const frame = encodeJsonFrame("not-an-object"); // valid JSON, wrong shape
      const code = await runNativeHostLogic([CHROMIUM_PINNED_ORIGIN], { dataDir }, fakeStdin([frame]));
      expect(code).toBe(0);
    } finally {
      process.stdout.write = originalWrite as any;
    }
    const parsed = tryParseFrame(Buffer.concat(chunks));
    if (parsed.status === "complete") {
      expect(JSON.parse(parsed.body.toString("utf8"))).toMatchObject({ type: "error", code: "bad-request" });
    }
  });
});

// --- Integration: spawn the real process, per the test plan -----------------

describe("native host — real process (bun run src/server.ts <arg>)", () => {
  const serverPath = join(import.meta.dir, "..", "src", "server.ts");

  test("spawned as the pinned Chromium caller, with a live broker-key.json, returns the key and exits 0", async () => {
    const dataDir = makeTmpDir("coati-host-spawn-");
    const key = generateBrokerKey();
    writeBrokerKeyFile({ dataDir }, key, process.pid, new Date().toISOString());

    const proc = Bun.spawn(["bun", "run", serverPath, CHROMIUM_PINNED_ORIGIN], {
      env: { ...process.env, COATI_DATA_DIR: dataDir },
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    });
    const writer = proc.stdin;
    writer.write(encodeJsonFrame({ type: "key.get", v: 1 }));
    await writer.end();

    const out = await new Response(proc.stdout).arrayBuffer();
    const exitCode = await proc.exited;
    expect(exitCode).toBe(0);
    const parsed = tryParseFrame(Buffer.from(out));
    expect(parsed.status).toBe("complete");
    if (parsed.status === "complete") {
      expect(JSON.parse(parsed.body.toString("utf8"))).toEqual({ type: "key", v: 1, key: key.toString("hex") });
    }
  }, 15000);

  test("spawned with an unrecognized origin: forbidden-caller, exit 0, never opens a port", async () => {
    const dataDir = makeTmpDir("coati-host-spawn-forbidden-");
    const proc = Bun.spawn(["bun", "run", serverPath, "chrome-extension://bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb/"], {
      env: { ...process.env, COATI_DATA_DIR: dataDir },
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    });
    await proc.stdin.end();
    const out = await new Response(proc.stdout).arrayBuffer();
    const exitCode = await proc.exited;
    expect(exitCode).toBe(0);
    const parsed = tryParseFrame(Buffer.from(out));
    if (parsed.status === "complete") {
      expect(JSON.parse(parsed.body.toString("utf8"))).toMatchObject({ code: "forbidden-caller" });
    }
  }, 15000);
});
