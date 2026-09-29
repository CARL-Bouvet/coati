// Regression test for security review 2026-09-26, finding #2 (partial):
// extension/panel/panel.js's extractFromTab() used to await
// chrome.scripting.executeScript with no deadline — a hostile or huge page
// could leave the panel waiting forever. The fix races the extraction
// against EXTRACTION_DEADLINE_MS via extension/lib/deadline.js.

import { describe, expect, test } from "bun:test";
import { withDeadline } from "../../extension/lib/deadline.js";

describe("lib/deadline.js — withDeadline (security review, finding #2)", () => {
  test("resolves with the promise's value when it settles before the deadline", async () => {
    const fast = new Promise((resolve) => setTimeout(() => resolve("page content"), 5));
    const result = await withDeadline(fast, 50, () => new Error("should never fire"));
    expect(result).toBe("page content");
  });

  test("rejects with onTimeout()'s error when the promise never settles before the deadline", async () => {
    const neverSettles = new Promise(() => {});
    await expect(
      withDeadline(neverSettles, 10, () => new Error("La page met trop de temps à être lue.")),
    ).rejects.toThrow("La page met trop de temps à être lue.");
  });

  test("propagates the promise's own rejection unchanged when it rejects before the deadline", async () => {
    const failsFast = Promise.reject(new Error("boom"));
    await expect(withDeadline(failsFast, 50, () => new Error("timeout"))).rejects.toThrow("boom");
  });
});
