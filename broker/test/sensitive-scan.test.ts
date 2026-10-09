// Coverage for extension/lib/sensitive-scan.js — the pure detector behind
// panel/page-request.js's dev-level sensitive-data dialog (CLAUDE.md
// product rule #8: warn, never mask). Each kind is checked both ways: a
// real-shaped example matches, an ordinary run of digits/letters does not.

import { describe, expect, test } from "bun:test";
import { scanForSensitiveData } from "../../extension/lib/sensitive-scan.js";

describe("lib/sensitive-scan.js — scanForSensitiveData", () => {
  test("empty or non-string input matches nothing", () => {
    expect(scanForSensitiveData("")).toEqual([]);
    // @ts-expect-error — deliberately passing a non-string
    expect(scanForSensitiveData(null)).toEqual([]);
  });

  test("ordinary page HTML matches nothing", () => {
    const html = "<p>Order #1234567890123 shipped on 2026-10-10, call +1 415 555 0100.</p>";
    expect(scanForSensitiveData(html)).toEqual([]);
  });

  test("detects an OpenAI-style secret key", () => {
    const html = `<code>sk-${"a".repeat(32)}</code>`;
    expect(scanForSensitiveData(html)).toContain("api-key");
  });

  test("detects a GitHub personal access token", () => {
    const html = `<code>ghp_${"B".repeat(36)}</code>`;
    expect(scanForSensitiveData(html)).toContain("api-key");
  });

  test("detects a long Bearer token", () => {
    const html = `Authorization: Bearer ${"xYz1".repeat(10)}`;
    expect(scanForSensitiveData(html)).toContain("api-key");
  });

  test("detects a Luhn-valid card number but not a lookalike digit run", () => {
    // 4111111111111111 is the well-known Visa test number (passes Luhn).
    expect(scanForSensitiveData("<td>4111 1111 1111 1111</td>")).toContain("card");
    // Same length, fails Luhn.
    expect(scanForSensitiveData("<td>4111 1111 1111 1112</td>")).not.toContain("card");
  });

  test("detects a mod-97-valid IBAN but not a lookalike code", () => {
    // Well-known IBAN test value (Belgium).
    expect(scanForSensitiveData("<p>BE68539007547034</p>")).toContain("iban");
    expect(scanForSensitiveData("<p>BE68539007547035</p>")).not.toContain("iban");
  });

  test("reports multiple kinds together, each at most once", () => {
    const html = `sk-${"a".repeat(32)} and card 4111 1111 1111 1111 and IBAN BE68539007547034 twice BE68539007547034`;
    const kinds = scanForSensitiveData(html);
    expect(kinds).toEqual(["api-key", "card", "iban"]);
  });
});
