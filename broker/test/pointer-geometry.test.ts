// Unit tests for the pure maths inside content/pointer.js ("Montrer du
// doigt" highlight, 3 intensity levels).
// pointer.js is a classic content script (no import/export, loaded via
// `executeScript({ files: [...] })`), so it can't be driven like a normal
// module — but importing it for its side effect is safe: nothing at its
// top level touches the DOM, it only *defines* functions and assigns
// `globalThis.__coatiPoint` / `globalThis.__coatiPointerInternals`, neither
// of which runs anything yet. `__coatiPointerInternals` is a test-only hook
// exposing the two pure helpers (normalizeEffect, pickArrowSide) with no
// access to page state — same spirit as retention.test.ts importing
// DOM-free logic straight from extension/panel/.
import { describe, expect, test } from "bun:test";
import "../../extension/content/pointer.js";

const { normalizeEffect, pickArrowSide } = (globalThis as any).__coatiPointerInternals;

describe("normalizeEffect", () => {
  test("accepts the three known levels", () => {
    expect(normalizeEffect("subtle")).toBe("subtle");
    expect(normalizeEffect("strong")).toBe("strong");
    expect(normalizeEffect("spectacular")).toBe("spectacular");
  });

  test("falls back to 'strong' for anything else, including undefined/garbage", () => {
    expect(normalizeEffect(undefined)).toBe("strong");
    expect(normalizeEffect(null)).toBe("strong");
    expect(normalizeEffect("")).toBe("strong");
    expect(normalizeEffect("nonsense")).toBe("strong");
  });
});

describe("pickArrowSide", () => {
  const VIEWPORT_W = 1200;
  const VIEWPORT_H = 800;

  test("picks the side with the most room — plenty below, element near the top", () => {
    const rect = { top: 20, bottom: 60, left: 500, right: 600, width: 100, height: 40 };
    expect(pickArrowSide(rect, VIEWPORT_W, VIEWPORT_H)).toBe("bottom");
  });

  test("picks 'top' when the element sits near the bottom of the viewport", () => {
    const rect = { top: 740, bottom: 780, left: 500, right: 600, width: 100, height: 40 };
    expect(pickArrowSide(rect, VIEWPORT_W, VIEWPORT_H)).toBe("top");
  });

  test("picks 'left' when the element is pinned to the right edge", () => {
    const rect = { top: 350, bottom: 390, left: 1150, right: 1195, width: 45, height: 40 };
    expect(pickArrowSide(rect, VIEWPORT_W, VIEWPORT_H)).toBe("left");
  });

  test("picks 'right' when the element is pinned to the left edge", () => {
    const rect = { top: 350, bottom: 390, left: 5, right: 50, width: 45, height: 40 };
    expect(pickArrowSide(rect, VIEWPORT_W, VIEWPORT_H)).toBe("right");
  });

  test("a perfectly centered element still returns one of the four sides", () => {
    const rect = { top: 380, bottom: 420, left: 575, right: 625, width: 50, height: 40 };
    expect(["top", "bottom", "left", "right"]).toContain(pickArrowSide(rect, VIEWPORT_W, VIEWPORT_H));
  });
});
