// Unit tests for the pure maths inside content/pointer.js ("Montrer du
// doigt" highlight, 3 intensity levels).
// pointer.js is a classic content script (no import/export, loaded via
// `executeScript({ files: [...] })`), so it can't be driven like a normal
// module — but importing it for its side effect is safe: nothing at its
// top level touches the DOM, it only *defines* functions and assigns
// `globalThis.__coatiPoint` / `globalThis.__coatiPointerInternals`, neither
// of which runs anything yet. `__coatiPointerInternals` is a test-only hook
// exposing the pure helpers (normalizeEffect, perimeterPoint, layoutComet) with no
// access to page state — same spirit as retention.test.ts importing
// DOM-free logic straight from extension/panel/.
import { describe, expect, test } from "bun:test";
import "../../extension/content/pointer.js";

const { normalizeEffect, perimeterPoint, layoutComet } = (globalThis as any).__coatiPointerInternals;

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

describe("perimeterPoint", () => {
  test("walks the edge clockwise from the top-left corner and wraps around", () => {
    expect(perimeterPoint(50, 100, 40)).toEqual({ x: 50, y: 0 });
    expect(perimeterPoint(120, 100, 40)).toEqual({ x: 100, y: 20 });
    expect(perimeterPoint(190, 100, 40)).toEqual({ x: 50, y: 40 });
    expect(perimeterPoint(260, 100, 40)).toEqual({ x: 0, y: 20 });
    expect(perimeterPoint(280 + 50, 100, 40)).toEqual({ x: 50, y: 0 });
  });
});

describe("layoutComet", () => {
  const VW = 1200;
  const VH = 800;
  const PILL_W = 220;
  const PILL_H = 28;
  const overlaps = (a: any, b: any) => a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;
  const at = (left: number, top: number, width = 180, height = 40) => ({
    left,
    top,
    width,
    height,
    right: left + width,
    bottom: top + height,
  });

  test("the label pill never covers the element, wherever it sits", () => {
    for (const rect of [at(500, 4), at(500, 380), at(500, 756), at(1015, 380), at(4, 4), at(1015, 756, 180, 40)]) {
      const { pill } = layoutComet(rect, VW, VH, PILL_W, PILL_H);
      const box = { left: pill.left, top: pill.top, right: pill.left + PILL_W, bottom: pill.top + PILL_H };
      expect(overlaps(box, rect)).toBe(false);
    }
  });

  test("an element at the very top gets its pill below", () => {
    const rect = at(500, 10);
    expect(layoutComet(rect, VW, VH, PILL_W, PILL_H).pill.top).toBeGreaterThanOrEqual(rect.bottom);
  });

  test("the comet enters from the right edge and stops outside the element", () => {
    for (const rect of [at(500, 380), at(1015, 380), at(1015, 10)]) {
      const { start, end } = layoutComet(rect, VW, VH, PILL_W, PILL_H);
      expect(start.x).toBeGreaterThanOrEqual(VW);
      const inside = end.x > rect.left && end.x < rect.right && end.y > rect.top && end.y < rect.bottom;
      expect(inside).toBe(false);
    }
  });
});
