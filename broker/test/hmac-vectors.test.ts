// Shared HMAC v: 2 test vectors — broker/test/fixtures/hmac-v2-vectors.json.
// Generated once, deterministically (sha256 of fixed fixture strings), and
// consumed by BOTH the broker (this file, node:crypto) and the extension
// worker's own test suite (WebCrypto) — docs/PROTOCOL.md "Poignée de main
// `v: 2`", test plan. Never regenerate ad hoc: any change here must be
// reflected on both sides.

import { describe, expect, test } from "bun:test";
import { brokerProof, extensionProof } from "../src/broker-key.ts";
import vectors from "./fixtures/hmac-v2-vectors.json";

describe("HMAC v: 2 vectors (broker side, node:crypto)", () => {
  const key = Buffer.from(vectors.K, "hex");

  test("bP matches brokerProof(K, cN, bN)", () => {
    expect(brokerProof(key, vectors.cN, vectors.bN)).toBe(vectors.bP);
  });

  test("eP matches extensionProof(K, cN, bN)", () => {
    expect(extensionProof(key, vectors.cN, vectors.bN)).toBe(vectors.eP);
  });

  test("bP and eP are distinct (different labels)", () => {
    expect(vectors.bP).not.toBe(vectors.eP);
  });
});
