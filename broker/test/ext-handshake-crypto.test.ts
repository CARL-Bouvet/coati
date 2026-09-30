// Handshake v2 crypto helpers (extension/lib/handshake-crypto.js) —
// docs/PROTOCOL.md amendement 2026-09-30, "Poignée de main v: 2" and "Plan
// de test" ("Vecteurs HMAC" — a fixed-values file checked by both the
// broker's own code (node:crypto) and the extension's (WebCrypto, here
// under Bun, which implements the same subtle-crypto API a real browser
// does).
//
// The shared fixture broker/test/fixtures/hmac-v2-vectors.json is written by
// the broker-side worker (K, cN, bN, bP, eP). If it isn't there yet when
// this runs, the vectors are computed in-process with node:crypto instead —
// same algorithm, same message framing, just not cross-checked against the
// broker's own file. See the "Not verified" note in this worker's report.
import { describe, expect, test } from "bun:test";
import { createHmac } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  HEX64_RE,
  isHex64,
  randomHex32,
  hmacHex,
  verifyHmacHex,
  brokerProofMessage,
  extensionProofMessage,
} from "../../extension/lib/handshake-crypto.js";

const FIXTURE_PATH = join(import.meta.dir, "fixtures", "hmac-v2-vectors.json");

function loadOrComputeVectors() {
  if (existsSync(FIXTURE_PATH)) {
    return { vectors: JSON.parse(readFileSync(FIXTURE_PATH, "utf8")), fromFixture: true };
  }
  // Fallback: same shape as the fixture the broker worker is expected to
  // write, computed here with node:crypto (independent implementation from
  // the extension's WebCrypto path — still catches a framing/prefix bug).
  const K = "a".repeat(64);
  const cN = "1".repeat(64);
  const bN = "2".repeat(64);
  const bP = createHmac("sha256", Buffer.from(K, "hex")).update(`coati-v2-broker:${cN}:${bN}`).digest("hex");
  const eP = createHmac("sha256", Buffer.from(K, "hex")).update(`coati-v2-extension:${cN}:${bN}`).digest("hex");
  return { vectors: { K, cN, bN, bP, eP }, fromFixture: false };
}

const { vectors, fromFixture } = loadOrComputeVectors();

describe("handshake-crypto: HMAC vectors", () => {
  test(`vectors source: ${fromFixture ? "broker/test/fixtures/hmac-v2-vectors.json" : "computed in-test (fixture absent)"}`, () => {
    expect(vectors.K).toBeTruthy();
  });

  test("bP = HMAC-SHA256(K, coati-v2-broker:cN:bN)", async () => {
    const computed = await hmacHex(vectors.K, brokerProofMessage(vectors.cN, vectors.bN));
    expect(computed).toBe(vectors.bP);
  });

  test("eP = HMAC-SHA256(K, coati-v2-extension:cN:bN)", async () => {
    const computed = await hmacHex(vectors.K, extensionProofMessage(vectors.cN, vectors.bN));
    expect(computed).toBe(vectors.eP);
  });

  test("verifyHmacHex accepts the true proof, via crypto.subtle.verify", async () => {
    expect(await verifyHmacHex(vectors.K, brokerProofMessage(vectors.cN, vectors.bN), vectors.bP)).toBe(true);
  });

  test("verifyHmacHex rejects a wrong proof (broker's own proof replayed as extension's)", async () => {
    expect(await verifyHmacHex(vectors.K, extensionProofMessage(vectors.cN, vectors.bN), vectors.bP)).toBe(false);
  });

  test("verifyHmacHex rejects a wrong key", async () => {
    const wrongKey = vectors.K.slice(0, -1) + (vectors.K.endsWith("0") ? "1" : "0");
    expect(await verifyHmacHex(wrongKey, brokerProofMessage(vectors.cN, vectors.bN), vectors.bP)).toBe(false);
  });

  test("verifyHmacHex never throws on a malformed signature", async () => {
    expect(await verifyHmacHex(vectors.K, brokerProofMessage(vectors.cN, vectors.bN), "not-hex")).toBe(false);
    expect(await verifyHmacHex(vectors.K, brokerProofMessage(vectors.cN, vectors.bN), "")).toBe(false);
  });
});

describe("handshake-crypto: hex helpers", () => {
  test("HEX64_RE / isHex64 accept exactly 64 lowercase hex chars", () => {
    expect(isHex64("a".repeat(64))).toBe(true);
    expect(HEX64_RE.test("a".repeat(64))).toBe(true);
  });

  test("isHex64 rejects wrong length, uppercase, non-hex, non-string", () => {
    expect(isHex64("a".repeat(63))).toBe(false);
    expect(isHex64("A".repeat(64))).toBe(false);
    expect(isHex64("g".repeat(64))).toBe(false);
    expect(isHex64(undefined)).toBe(false);
    expect(isHex64(null)).toBe(false);
    expect(isHex64(64)).toBe(false);
  });

  test("randomHex32 returns 64 fresh lowercase hex chars every call", () => {
    const a = randomHex32();
    const b = randomHex32();
    expect(isHex64(a)).toBe(true);
    expect(isHex64(b)).toBe(true);
    expect(a).not.toBe(b);
  });
});

describe("handshake-crypto: proof message framing", () => {
  test("the two labels differ, over the same cN/bN", () => {
    const cN = "c".repeat(64);
    const bN = "b".repeat(64);
    expect(brokerProofMessage(cN, bN)).toBe(`coati-v2-broker:${cN}:${bN}`);
    expect(extensionProofMessage(cN, bN)).toBe(`coati-v2-extension:${cN}:${bN}`);
    expect(brokerProofMessage(cN, bN)).not.toBe(extensionProofMessage(cN, bN));
  });
});
