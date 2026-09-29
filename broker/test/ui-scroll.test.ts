// Unit tests for the panel's "should auto-follow the conversation to the
// bottom" check. Lives under extension/panel/ (DOM-free pure JS), same
// pattern as retention.test.ts.
import { describe, expect, test } from "bun:test";
import { isNearBottom, AUTO_SCROLL_THRESHOLD_PX } from "../../extension/panel/scroll.js";

describe("isNearBottom", () => {
  test("true when scrolled exactly to the bottom", () => {
    expect(isNearBottom(1000, 800, 200)).toBe(true);
  });

  test("true within the threshold slack", () => {
    expect(isNearBottom(1000, 800 - AUTO_SCROLL_THRESHOLD_PX, 200)).toBe(true);
  });

  test("false once scrolled up past the threshold", () => {
    expect(isNearBottom(1000, 800 - AUTO_SCROLL_THRESHOLD_PX - 1, 200)).toBe(false);
  });

  test("false when scrolled far up to read earlier messages", () => {
    expect(isNearBottom(2000, 0, 200)).toBe(false);
  });
});
