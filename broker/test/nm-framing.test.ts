// broker/src/nm-framing.ts — docs/PROTOCOL.md "Cadrage et échange avec
// l'hôte" (amendement 2026-09-30, G4).

import { describe, expect, test } from "bun:test";
import { encodeFrame, encodeJsonFrame, tryParseFrame, MAX_FRAME_BYTES, MIN_FRAME_BYTES } from "../src/nm-framing.ts";

describe("encode/decode round-trip", () => {
  test("a simple JSON frame round-trips", () => {
    const buf = encodeJsonFrame({ type: "key.get", v: 1 });
    const parsed = tryParseFrame(buf);
    expect(parsed.status).toBe("complete");
    if (parsed.status === "complete") {
      expect(JSON.parse(parsed.body.toString("utf8"))).toEqual({ type: "key.get", v: 1 });
      expect(parsed.rest.length).toBe(0);
    }
  });

  test("multi-byte UTF-8 characters: length is counted in bytes, not characters", () => {
    const value = { text: "café ☕ 日本語" };
    const buf = encodeJsonFrame(value);
    const bodyBytes = Buffer.byteLength(JSON.stringify(value), "utf8");
    expect(buf.readUInt32LE(0)).toBe(bodyBytes);
    const parsed = tryParseFrame(buf);
    expect(parsed.status).toBe("complete");
    if (parsed.status === "complete") {
      expect(JSON.parse(parsed.body.toString("utf8"))).toEqual(value);
    }
  });

  test("a header split across two chunks is incomplete, then completes once joined", () => {
    const full = encodeJsonFrame({ a: 1 });
    const firstChunk = full.subarray(0, 2);
    const parsed1 = tryParseFrame(firstChunk);
    expect(parsed1.status).toBe("incomplete");
    const parsed2 = tryParseFrame(full);
    expect(parsed2.status).toBe("complete");
  });

  test("a body split across two chunks is incomplete, then completes once joined", () => {
    const full = encodeJsonFrame({ hello: "world", padding: "x".repeat(100) });
    const partial = full.subarray(0, full.length - 5);
    expect(tryParseFrame(partial).status).toBe("incomplete");
    expect(tryParseFrame(full).status).toBe("complete");
  });

  test("length 1 (MIN_FRAME_BYTES) is accepted", () => {
    const buf = encodeFrame(Buffer.from("x"));
    expect(buf.readUInt32LE(0)).toBe(MIN_FRAME_BYTES);
    const parsed = tryParseFrame(buf);
    expect(parsed.status).toBe("complete");
  });

  test("length 4096 (MAX_FRAME_BYTES) is accepted", () => {
    const buf = encodeFrame(Buffer.alloc(MAX_FRAME_BYTES, 0x41));
    const parsed = tryParseFrame(buf);
    expect(parsed.status).toBe("complete");
    if (parsed.status === "complete") expect(parsed.body.length).toBe(MAX_FRAME_BYTES);
  });

  test("length 0 is refused (invalid-length)", () => {
    const buf = encodeFrame(Buffer.alloc(0));
    const parsed = tryParseFrame(buf);
    expect(parsed.status).toBe("invalid-length");
  });

  test("length 4097 (MAX_FRAME_BYTES + 1) is refused (invalid-length)", () => {
    const header = Buffer.alloc(4);
    header.writeUInt32LE(MAX_FRAME_BYTES + 1, 0);
    const parsed = tryParseFrame(header); // header alone is enough to detect the invalid length
    expect(parsed.status).toBe("invalid-length");
  });

  test("two frames back to back: only the first is parsed, the rest is returned untouched", () => {
    const frame1 = encodeJsonFrame({ n: 1 });
    const frame2 = encodeJsonFrame({ n: 2 });
    const both = Buffer.concat([frame1, frame2]);
    const parsed = tryParseFrame(both);
    expect(parsed.status).toBe("complete");
    if (parsed.status === "complete") {
      expect(JSON.parse(parsed.body.toString("utf8"))).toEqual({ n: 1 });
      expect(parsed.rest.equals(frame2)).toBe(true);
    }
  });
});
