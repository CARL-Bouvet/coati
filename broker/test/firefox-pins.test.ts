// broker/src/config.ts's Firefox pin-list API — docs/PROTOCOL.md "Cas
// Firefox" (amendement 2026-09-25): parse/serialize, and recordFirefoxSeen's
// re-read-before-write + 16-entry LRU eviction. See
// test/firefox-pairing.test.ts for the end-to-end (WebSocket) coverage of the
// same feature.

import { describe, expect, test } from "bun:test";
import { writeFileSync, readFileSync, existsSync, chmodSync } from "node:fs";
import { join } from "node:path";
import { makeTmpDir } from "./helpers/tmp-dir.ts";
import {
  parseFirefoxPinsFile,
  serializeFirefoxPinsFile,
  loadFirefoxPins,
  recordFirefoxSeen,
  FIREFOX_UUID_CAP,
  FIREFOX_UUIDS_FILENAME,
  type FirefoxPin,
} from "../src/config.ts";

function tmpDataDir(): string {
  return makeTmpDir("coati-fx-pins-");
}

describe("parseFirefoxPinsFile", () => {
  test("parses one uuid/pinnedAt/lastSeen line per pin, lower-casing the uuid", () => {
    const content = "12345678-1234-1234-1234-123456789ABC 2026-09-25T14:03:00Z 2026-09-25T14:05:00Z\n";
    const { pins, malformedCount } = parseFirefoxPinsFile(content);
    expect(malformedCount).toBe(0);
    expect(pins).toEqual([
      { uuid: "12345678-1234-1234-1234-123456789abc", pinnedAt: "2026-09-25T14:03:00Z", lastSeen: "2026-09-25T14:05:00Z" },
    ]);
  });

  test("skips blank lines and #-comments", () => {
    const content = "\n# a comment\n12345678-1234-1234-1234-123456789abc 2026-09-25T14:03:00Z 2026-09-25T14:03:00Z\n\n";
    const { pins, malformedCount } = parseFirefoxPinsFile(content);
    expect(pins.length).toBe(1);
    expect(malformedCount).toBe(0);
  });

  test("counts a malformed line without throwing or dropping the rest of the file", () => {
    const content = [
      "not-a-uuid 2026-09-25T14:03:00Z 2026-09-25T14:03:00Z",
      "12345678-1234-1234-1234-123456789abc 2026-09-25T14:03:00Z 2026-09-25T14:03:00Z",
      "12345678-1234-1234-1234-123456789abc onlyonefield",
    ].join("\n");
    const { pins, malformedCount } = parseFirefoxPinsFile(content);
    expect(pins).toEqual([
      { uuid: "12345678-1234-1234-1234-123456789abc", pinnedAt: "2026-09-25T14:03:00Z", lastSeen: "2026-09-25T14:03:00Z" },
    ]);
    expect(malformedCount).toBe(2);
  });

  test("empty content parses to no pins, no malformed lines", () => {
    expect(parseFirefoxPinsFile("")).toEqual({ pins: [], malformedCount: 0 });
  });
});

describe("serializeFirefoxPinsFile", () => {
  test("round-trips through parseFirefoxPinsFile", () => {
    const pins: FirefoxPin[] = [
      { uuid: "12345678-1234-1234-1234-123456789abc", pinnedAt: "2026-09-25T14:03:00Z", lastSeen: "2026-09-25T14:05:00Z" },
      { uuid: "87654321-4321-4321-4321-cba987654321", pinnedAt: "2026-09-25T15:00:00Z", lastSeen: "2026-09-25T15:00:00Z" },
    ];
    expect(parseFirefoxPinsFile(serializeFirefoxPinsFile(pins)).pins).toEqual(pins);
  });

  test("an empty pin list serializes to an empty string", () => {
    expect(serializeFirefoxPinsFile([])).toBe("");
  });
});

describe("loadFirefoxPins", () => {
  test("returns [] when no pins file exists", () => {
    const dataDir = tmpDataDir();
    expect(loadFirefoxPins({ dataDir })).toEqual([]);
  });

  test("reads back what recordFirefoxSeen wrote", () => {
    const dataDir = tmpDataDir();
    recordFirefoxSeen({ dataDir }, "12345678-1234-1234-1234-123456789abc", "2026-09-25T14:03:00Z");
    expect(loadFirefoxPins({ dataDir })).toEqual([
      { uuid: "12345678-1234-1234-1234-123456789abc", pinnedAt: "2026-09-25T14:03:00Z", lastSeen: "2026-09-25T14:03:00Z" },
    ]);
  });

  test("the pins file is created 0600", () => {
    const dataDir = tmpDataDir();
    recordFirefoxSeen({ dataDir }, "12345678-1234-1234-1234-123456789abc", "2026-09-25T14:03:00Z");
    const stat = require("node:fs").statSync(join(dataDir, FIREFOX_UUIDS_FILENAME));
    expect(stat.mode & 0o777).toBe(0o600);
  });

  test("a malformed line is dropped, not thrown on", () => {
    const dataDir = tmpDataDir();
    writeFileSync(join(dataDir, FIREFOX_UUIDS_FILENAME), "garbage line here\n", { mode: 0o600 });
    expect(loadFirefoxPins({ dataDir })).toEqual([]);
  });
});

describe("recordFirefoxSeen", () => {
  test("pins a new uuid, marking `pinned: true`", () => {
    const dataDir = tmpDataDir();
    const result = recordFirefoxSeen({ dataDir }, "12345678-1234-1234-1234-123456789abc", "2026-09-25T14:03:00Z");
    expect(result.pinned).toBe(true);
    expect(result.evicted).toBeUndefined();
  });

  test("touching an already-pinned uuid only refreshes lastSeen — `pinned: false`", () => {
    const dataDir = tmpDataDir();
    recordFirefoxSeen({ dataDir }, "12345678-1234-1234-1234-123456789abc", "2026-09-25T14:03:00Z");
    const result = recordFirefoxSeen({ dataDir }, "12345678-1234-1234-1234-123456789abc", "2026-09-25T15:00:00Z");
    expect(result.pinned).toBe(false);
    expect(result.pins).toEqual([
      { uuid: "12345678-1234-1234-1234-123456789abc", pinnedAt: "2026-09-25T14:03:00Z", lastSeen: "2026-09-25T15:00:00Z" },
    ]);
  });

  test("a line deleted by hand between the WS-open read and this call is never recreated — re-reads first", () => {
    const dataDir = tmpDataDir();
    recordFirefoxSeen({ dataDir }, "12345678-1234-1234-1234-123456789abc", "2026-09-25T14:03:00Z");
    // Simulate a hand-edit: delete the pin file entirely.
    writeFileSync(join(dataDir, FIREFOX_UUIDS_FILENAME), "", { mode: 0o600 });

    // A stale in-memory caller touching the now-deleted uuid must not
    // resurrect it as a "refresh" — it re-reads first, sees it gone, and
    // pins it fresh (pinned: true, not false).
    const result = recordFirefoxSeen({ dataDir }, "12345678-1234-1234-1234-123456789abc", "2026-09-25T16:00:00Z");
    expect(result.pinned).toBe(true);
  });

  test(`caps at ${16} pins, evicting the least-recently-seen entry`, () => {
    const dataDir = tmpDataDir();
    expect(FIREFOX_UUID_CAP).toBe(16);
    const uuidFor = (i: number) => `00000000-0000-0000-0000-${String(i).padStart(12, "0")}`;

    for (let i = 0; i < FIREFOX_UUID_CAP; i++) {
      recordFirefoxSeen({ dataDir }, uuidFor(i), `2026-09-25T00:${String(i).padStart(2, "0")}:00Z`);
    }
    expect(loadFirefoxPins({ dataDir }).length).toBe(FIREFOX_UUID_CAP);

    // uuidFor(0) has the oldest lastSeen — pinning a 17th evicts it.
    const result = recordFirefoxSeen({ dataDir }, uuidFor(16), "2026-09-25T00:16:00Z");
    expect(result.pinned).toBe(true);
    expect(result.evicted?.uuid).toBe(uuidFor(0));

    const pins = loadFirefoxPins({ dataDir });
    expect(pins.length).toBe(FIREFOX_UUID_CAP);
    expect(pins.some((p) => p.uuid === uuidFor(0))).toBe(false);
    expect(pins.some((p) => p.uuid === uuidFor(16))).toBe(true);
  });

  // L1 (lot7 security review): mayCreate=false must never resurrect/create a
  // pin — used by server.ts for the "silent grant" / "session token" paths,
  // which must never pin, only touch an EXISTING entry's lastSeen.
  describe("mayCreate flag", () => {
    test("mayCreate: false on a not-yet-pinned uuid is a no-op — no write, pinned: false", () => {
      const dataDir = tmpDataDir();
      const result = recordFirefoxSeen({ dataDir }, "12345678-1234-1234-1234-123456789abc", "2026-09-25T14:03:00Z", false);
      expect(result.pinned).toBe(false);
      expect(result.pins).toEqual([]);
      expect(loadFirefoxPins({ dataDir })).toEqual([]);
    });

    test("mayCreate: false on an already-pinned uuid still refreshes lastSeen", () => {
      const dataDir = tmpDataDir();
      recordFirefoxSeen({ dataDir }, "12345678-1234-1234-1234-123456789abc", "2026-09-25T14:03:00Z");
      const result = recordFirefoxSeen({ dataDir }, "12345678-1234-1234-1234-123456789abc", "2026-09-25T15:00:00Z", false);
      expect(result.pinned).toBe(false);
      expect(result.pins[0].lastSeen).toBe("2026-09-25T15:00:00Z");
    });

    test("mayCreate defaults to true when omitted — back-compat with existing direct callers", () => {
      const dataDir = tmpDataDir();
      const result = recordFirefoxSeen({ dataDir }, "12345678-1234-1234-1234-123456789abc", "2026-09-25T14:03:00Z");
      expect(result.pinned).toBe(true);
    });
  });

  test("writes are atomic — no .tmp file left behind after a write", () => {
    const dataDir = tmpDataDir();
    recordFirefoxSeen({ dataDir }, "12345678-1234-1234-1234-123456789abc", "2026-09-25T14:03:00Z");
    const leftoverTmp = require("node:fs")
      .readdirSync(dataDir)
      .filter((f: string) => f.includes(".tmp-"));
    expect(leftoverTmp).toEqual([]);
  });
});
