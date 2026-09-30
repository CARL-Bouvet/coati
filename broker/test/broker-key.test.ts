// broker/src/broker-key.ts + broker/src/fs-atomic.ts — docs/PROTOCOL.md
// "Clé de broker" / "Écoute exclusive du port, durcissement du dossier et
// fichiers temporaires" (amendement 2026-09-30, G4).

import { describe, expect, test } from "bun:test";
import { existsSync, statSync, lstatSync, symlinkSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { mkdtempSync } from "node:fs";
import { makeTmpDir } from "./helpers/tmp-dir.ts";
import {
  generateBrokerKey,
  writeBrokerKeyFile,
  readBrokerKeyFile,
  deleteBrokerKeyFileIfOwned,
  loadOrCreatePairingSecret,
  deletePairingSecretIfDisabled,
  isSameAccountProcessAlive,
  brokerProof,
  extensionProof,
  safeEqualHex,
  isHex64,
  HEX64_RE,
} from "../src/broker-key.ts";
import { hardenDir, UnsafeDirError, atomicWriteFileSync } from "../src/fs-atomic.ts";

describe("generateBrokerKey", () => {
  test("returns 32 bytes, different every call", () => {
    const a = generateBrokerKey();
    const b = generateBrokerKey();
    expect(a.length).toBe(32);
    expect(a.equals(b)).toBe(false);
  });
});

describe("broker-key.json file", () => {
  test("written 0600 in a 0700 dataDir, readable back with the same key", () => {
    const dataDir = makeTmpDir("coati-key-");
    const key = generateBrokerKey();
    writeBrokerKeyFile({ dataDir }, key, process.pid, new Date().toISOString());
    const path = join(dataDir, "broker-key.json");
    expect(existsSync(path)).toBe(true);
    if (process.platform !== "win32") {
      expect(statSync(path).mode & 0o777).toBe(0o600);
      expect(statSync(dataDir).mode & 0o777).toBe(0o700);
    }
    const result = readBrokerKeyFile({ dataDir });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.file.key).toBe(key.toString("hex"));
  });

  test("no leftover .tmp file after a write", () => {
    const dataDir = makeTmpDir("coati-key-tmp-");
    writeBrokerKeyFile({ dataDir }, generateBrokerKey(), process.pid, new Date().toISOString());
    const names = readdirSync(dataDir);
    expect(names.some((n) => n.endsWith(".tmp"))).toBe(false);
  });

  test("absent file: broker-not-running", () => {
    const dataDir = makeTmpDir("coati-key-absent-");
    const result = readBrokerKeyFile({ dataDir });
    expect(result).toEqual({ ok: false, reason: "broker-not-running" });
  });

  test("malformed JSON: broker-not-running", () => {
    const dataDir = makeTmpDir("coati-key-malformed-");
    writeFileSync(join(dataDir, "broker-key.json"), "{not json", { mode: 0o600 });
    const result = readBrokerKeyFile({ dataDir });
    expect(result).toEqual({ ok: false, reason: "broker-not-running" });
  });

  test("a symlink at broker-key.json is refused (never followed), same as broker-not-running (final security review)", () => {
    if (process.platform === "win32") return; // symlinkSync needs elevation on Windows
    const dataDir = makeTmpDir("coati-key-symlink-");
    // Points at a file that DOES hold a well-formed, alive-pid key — proves
    // the rejection is about the symlink itself, not about the target's
    // content being unreadable/malformed.
    const targetDir = makeTmpDir("coati-key-symlink-target-");
    writeBrokerKeyFile({ dataDir: targetDir }, generateBrokerKey(), process.pid, new Date().toISOString());
    symlinkSync(join(targetDir, "broker-key.json"), join(dataDir, "broker-key.json"));

    const result = readBrokerKeyFile({ dataDir });
    expect(result).toEqual({ ok: false, reason: "broker-not-running" });
  });

  test("a dead pid: broker-not-running", () => {
    const dataDir = makeTmpDir("coati-key-dead-");
    // A pid essentially guaranteed not to exist.
    const deadPid = 2_000_000_000;
    writeBrokerKeyFile({ dataDir }, generateBrokerKey(), deadPid, new Date().toISOString());
    const result = readBrokerKeyFile({ dataDir });
    expect(result).toEqual({ ok: false, reason: "broker-not-running" });
  });

  test("deleteBrokerKeyFileIfOwned removes the file only if the pid matches", () => {
    const dataDir = makeTmpDir("coati-key-del-");
    writeBrokerKeyFile({ dataDir }, generateBrokerKey(), process.pid + 12345, new Date().toISOString());
    deleteBrokerKeyFileIfOwned({ dataDir }, process.pid); // wrong pid: no-op
    expect(existsSync(join(dataDir, "broker-key.json"))).toBe(true);

    writeBrokerKeyFile({ dataDir }, generateBrokerKey(), process.pid, new Date().toISOString());
    deleteBrokerKeyFileIfOwned({ dataDir }, process.pid); // matching pid: removed
    expect(existsSync(join(dataDir, "broker-key.json"))).toBe(false);
  });
});

describe("isSameAccountProcessAlive", () => {
  test("the current process is alive", () => {
    expect(isSameAccountProcessAlive(process.pid)).toBe(true);
  });

  test("an unreasonable pid is not alive, never throws", () => {
    expect(isSameAccountProcessAlive(2_000_000_000)).toBe(false);
    expect(isSameAccountProcessAlive(-1)).toBe(false);
    expect(isSameAccountProcessAlive(0)).toBe(false);
  });
});

describe("loadOrCreatePairingSecret (legacy S)", () => {
  test("creates a 32-byte secret on first call, returns the SAME one on the next call", () => {
    const dataDir = makeTmpDir("coati-pairing-secret-");
    const first = loadOrCreatePairingSecret({ dataDir });
    expect(first.length).toBe(32);
    const second = loadOrCreatePairingSecret({ dataDir });
    expect(second.equals(first)).toBe(true);
  });

  test("file is 0600", () => {
    if (process.platform === "win32") return;
    const dataDir = makeTmpDir("coati-pairing-secret-mode-");
    loadOrCreatePairingSecret({ dataDir });
    const mode = statSync(join(dataDir, "pairing-secret")).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  test("a symlink at pairing-secret is refused (never followed), removed and regenerated as a real file (final security review)", () => {
    if (process.platform === "win32") return; // symlinkSync needs elevation on Windows
    const dataDir = makeTmpDir("coati-pairing-secret-symlink-");
    // Points at a file holding an otherwise perfectly valid secret — proves
    // the rejection is about the symlink itself, not the target's content.
    const targetDir = makeTmpDir("coati-pairing-secret-symlink-target-");
    const targetSecret = loadOrCreatePairingSecret({ dataDir: targetDir });
    symlinkSync(join(targetDir, "pairing-secret"), join(dataDir, "pairing-secret"));

    const result = loadOrCreatePairingSecret({ dataDir });
    expect(result.equals(targetSecret)).toBe(false); // regenerated, not the symlink target's secret
    expect(lstatSync(join(dataDir, "pairing-secret")).isSymbolicLink()).toBe(false); // symlink gone
    expect(statSync(join(dataDir, "pairing-secret")).isFile()).toBe(true);
    if (process.platform !== "win32") {
      expect(statSync(join(dataDir, "pairing-secret")).mode & 0o777).toBe(0o600);
    }
  });
});

describe("deletePairingSecretIfDisabled", () => {
  test("removes an existing pairing-secret file and logs one line", () => {
    const dataDir = makeTmpDir("coati-pairing-secret-disable-");
    loadOrCreatePairingSecret({ dataDir }); // creates pairing-secret
    expect(existsSync(join(dataDir, "pairing-secret"))).toBe(true);

    const errors: unknown[] = [];
    const originalError = console.error;
    console.error = (...args: unknown[]) => errors.push(args.join(" "));
    try {
      deletePairingSecretIfDisabled({ dataDir });
    } finally {
      console.error = originalError;
    }

    expect(existsSync(join(dataDir, "pairing-secret"))).toBe(false);
    expect(errors).toHaveLength(1);
    expect(String(errors[0])).toContain("pairing-secret");
  });

  test("no-op, no log, when there is nothing to delete", () => {
    const dataDir = makeTmpDir("coati-pairing-secret-disable-absent-");
    const errors: unknown[] = [];
    const originalError = console.error;
    console.error = (...args: unknown[]) => errors.push(args.join(" "));
    try {
      expect(() => deletePairingSecretIfDisabled({ dataDir })).not.toThrow();
    } finally {
      console.error = originalError;
    }
    expect(errors).toHaveLength(0);
  });
});

describe("HMAC v: 2 handshake helpers", () => {
  test("brokerProof and extensionProof use distinct labels — never equal for the same inputs", () => {
    const key = Buffer.alloc(32, 7);
    const cN = "a".repeat(64);
    const bN = "b".repeat(64);
    expect(brokerProof(key, cN, bN)).not.toBe(extensionProof(key, cN, bN));
  });

  test("safeEqualHex: equal 64-hex strings match", () => {
    const v = "c".repeat(64);
    expect(safeEqualHex(v, v)).toBe(true);
  });

  test("safeEqualHex: never throws on garbage input, always returns boolean", () => {
    expect(safeEqualHex("", "")).toBe(false);
    expect(safeEqualHex("not-hex-at-all", "c".repeat(64))).toBe(false);
    expect(safeEqualHex("c".repeat(63), "c".repeat(64))).toBe(false);
    expect(safeEqualHex("C".repeat(64), "c".repeat(64))).toBe(false); // case-sensitive
    expect(safeEqualHex(undefined as unknown as string, "c".repeat(64))).toBe(false);
  });

  test("isHex64 / HEX64_RE reject anything not exactly 64 lowercase hex chars", () => {
    expect(isHex64("a".repeat(64))).toBe(true);
    expect(isHex64("a".repeat(63))).toBe(false);
    expect(isHex64("a".repeat(65))).toBe(false);
    expect(isHex64("A".repeat(64))).toBe(false);
    expect(HEX64_RE.test("g".repeat(64))).toBe(false); // 'g' not hex
  });
});

describe("hardenDir", () => {
  test("creates an absent directory at 0700", () => {
    if (process.platform === "win32") return;
    const base = mkdtempSync(join(tmpdir(), "coati-harden-"));
    const target = join(base, "sub");
    hardenDir(target);
    expect(statSync(target).mode & 0o777).toBe(0o700);
  });

  test("tightens an existing directory wider than 0700", () => {
    if (process.platform === "win32") return;
    const dir = makeTmpDir("coati-harden-wide-");
    require("node:fs").chmodSync(dir, 0o755);
    hardenDir(dir);
    expect(statSync(dir).mode & 0o777).toBe(0o700);
  });

  test("refuses a symlinked directory", () => {
    if (process.platform === "win32") return;
    const base = mkdtempSync(join(tmpdir(), "coati-harden-link-"));
    const real = join(base, "real");
    mkdirSync(real, { mode: 0o700 });
    const link = join(base, "link");
    symlinkSync(real, link);
    expect(() => hardenDir(link)).toThrow(UnsafeDirError);
  });
});

describe("atomicWriteFileSync", () => {
  test("writes the file, no .tmp left over, correct mode", () => {
    if (process.platform === "win32") return;
    const dir = makeTmpDir("coati-atomic-");
    const path = join(dir, "secret");
    atomicWriteFileSync(path, "hello", 0o600);
    expect(readdirSync(dir)).toEqual(["secret"]);
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(require("node:fs").readFileSync(path, "utf8")).toBe("hello");
  });

  test("a leftover .tmp from a previous crash is removed before writing", () => {
    const dir = makeTmpDir("coati-atomic-leftover-");
    const path = join(dir, "secret");
    writeFileSync(`${path}.tmp`, "stale garbage", { mode: 0o600 });
    atomicWriteFileSync(path, "fresh", 0o600);
    expect(require("node:fs").readFileSync(path, "utf8")).toBe("fresh");
  });
});
