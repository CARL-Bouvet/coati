// Unit tests for extension/panel/screenshot.js's PURE helpers (Lot B3,
// plan-montrer-voir-chercher-08-10.md §3B). captureScreen() itself touches
// chrome.tabs/createImageBitmap/OffscreenCanvas — none of those exist under
// `bun test` (no browser) — so only the size/quality/url maths is covered
// here; captureScreen() needs the Chromium e2e the admin runs separately.

import { describe, expect, test } from "bun:test";
import {
  captureNeedsGesture,
  computeResizeDimensions,
  dataUrlToBlob,
  FALLBACK_QUALITY,
  isInternalBrowserUrl,
  isWithinBudget,
  MAX_ENCODED_BYTES,
  MAX_LONG_SIDE_PX,
  nextQuality,
  PRIMARY_QUALITY,
} from "../../extension/panel/screenshot.js";

describe("computeResizeDimensions — long side capped at 1280px, aspect ratio kept", () => {
  test("already within bounds: unchanged (rounded)", () => {
    expect(computeResizeDimensions(1024, 768)).toEqual({ width: 1024, height: 768 });
  });

  test("exactly at the cap: unchanged", () => {
    expect(computeResizeDimensions(MAX_LONG_SIDE_PX, 720)).toEqual({ width: 1280, height: 720 });
  });

  test("wide screenshot (landscape, long side = width) scaled down, aspect kept", () => {
    const result = computeResizeDimensions(2560, 1440);
    expect(result.width).toBe(1280);
    expect(result.height).toBe(720); // 1440 * (1280/2560) = 720 exactly
  });

  test("tall screenshot (long side = height) scaled down, aspect kept", () => {
    const result = computeResizeDimensions(900, 3000);
    expect(result.height).toBe(1280);
    expect(result.width).toBe(384); // 900 * (1280/3000) = 384 exactly
  });

  test("degenerate input (0, negative, NaN) never throws, returns {0,0}", () => {
    expect(computeResizeDimensions(0, 100)).toEqual({ width: 0, height: 0 });
    expect(computeResizeDimensions(100, -5)).toEqual({ width: 0, height: 0 });
    expect(computeResizeDimensions(NaN, 100)).toEqual({ width: 0, height: 0 });
  });

  test("a custom maxSide is honored", () => {
    expect(computeResizeDimensions(2000, 1000, 500)).toEqual({ width: 500, height: 250 });
  });
});

describe("isWithinBudget / nextQuality — the q0.75 -> q0.55 -> fail ladder", () => {
  test("within budget at the first try: no next quality needed", () => {
    expect(isWithinBudget(MAX_ENCODED_BYTES)).toBe(true);
    expect(isWithinBudget(MAX_ENCODED_BYTES - 1)).toBe(true);
    expect(nextQuality(PRIMARY_QUALITY, MAX_ENCODED_BYTES - 1)).toBeNull();
  });

  test("over budget at PRIMARY_QUALITY: try FALLBACK_QUALITY next", () => {
    expect(isWithinBudget(MAX_ENCODED_BYTES + 1)).toBe(false);
    expect(nextQuality(PRIMARY_QUALITY, MAX_ENCODED_BYTES + 1)).toBe(FALLBACK_QUALITY);
  });

  test("still over budget at FALLBACK_QUALITY: nothing left to try (caller reports failure)", () => {
    expect(nextQuality(FALLBACK_QUALITY, MAX_ENCODED_BYTES + 1)).toBeNull();
  });
});

describe("captureNeedsGesture — B0 finding (08/10): the broad host permission does NOT grant captureVisibleTab", () => {
  test("Chrome's real rejection message (verified by the admin against a real Chromium) is recognized", () => {
    expect(captureNeedsGesture(new Error("Either the '<all_urls>' or 'activeTab' permission is required."))).toBe(
      true,
    );
  });

  test("an unrelated error is not misclassified as a gesture problem", () => {
    expect(captureNeedsGesture(new Error("Network error"))).toBe(false);
    expect(captureNeedsGesture(new Error(""))).toBe(false);
  });

  test("a non-Error value never throws", () => {
    expect(captureNeedsGesture(undefined)).toBe(false);
    expect(captureNeedsGesture("plain string, totally unrelated")).toBe(false);
    expect(captureNeedsGesture("activeTab permission missing")).toBe(true);
  });
});

describe("isInternalBrowserUrl — pages captureVisibleTab can never be asked to touch", () => {
  test("internal scheme URLs are flagged", () => {
    for (const url of [
      "chrome://extensions",
      "chrome-extension://abcd/panel/panel.html",
      "edge://settings",
      "brave://settings",
      "about:blank",
      "moz-extension://abcd/panel.html",
      "view-source:https://example.com",
    ]) {
      expect(isInternalBrowserUrl(url)).toBe(true);
    }
  });

  test("ordinary http(s) pages are not flagged", () => {
    expect(isInternalBrowserUrl("https://example.com/")).toBe(false);
    expect(isInternalBrowserUrl("http://127.0.0.1:8080/")).toBe(false);
  });

  test("missing/non-string url never throws", () => {
    expect(isInternalBrowserUrl(undefined)).toBe(false);
    expect(isInternalBrowserUrl(null as any)).toBe(false);
  });
});

describe("dataUrlToBlob — admin's real-Chromium fix (08/10): fetch(dataUrl) is blocked by the panel CSP (no data: in connect-src), decoded by hand instead", () => {
  test("round-trips exact bytes", async () => {
    const original = new Uint8Array([0, 1, 2, 253, 254, 255, 10, 13, 65, 66, 67]);
    let binary = "";
    for (const b of original) binary += String.fromCharCode(b);
    const base64 = btoa(binary);
    const dataUrl = `data:image/jpeg;base64,${base64}`;

    const blob = dataUrlToBlob(dataUrl);
    expect(blob.type).toBe("image/jpeg");
    const roundTripped = new Uint8Array(await blob.arrayBuffer());
    expect(Array.from(roundTripped)).toEqual(Array.from(original));
  });

  test("media type is read from the header, before the ';base64' marker", () => {
    const dataUrl = `data:image/png;base64,${btoa("x")}`;
    expect(dataUrlToBlob(dataUrl).type).toBe("image/png");
  });

  test("an empty payload decodes to a zero-byte blob of the right type", async () => {
    const blob = dataUrlToBlob("data:image/jpeg;base64,");
    expect(blob.type).toBe("image/jpeg");
    expect((await blob.arrayBuffer()).byteLength).toBe(0);
  });
});
