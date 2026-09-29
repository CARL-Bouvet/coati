// Unit tests for the composer's autogrow height (lot 4 of an internal design
// plan, 28/09): one line at rest, grows to 4 lines,
// then a scrollbar. Pure function from extension/panel/, same pattern as
// ui-scroll.test.ts.
import { describe, expect, test } from "bun:test";
import { autogrowHeight, MAX_LINES } from "../../extension/panel/composer-autogrow.js";

// 20px lines, 8px padding top and bottom, 1px border top and bottom.
const BOX = { lineHeight: 20, paddingY: 16, borderY: 2 };

describe("autogrowHeight", () => {
  test("caps at four lines", () => {
    expect(MAX_LINES).toBe(4);
  });

  test("one line when empty (scrollHeight is one line + padding)", () => {
    expect(autogrowHeight({ ...BOX, scrollHeight: 36 })).toEqual({ height: 38, overflow: false });
  });

  test("never shorter than one line", () => {
    expect(autogrowHeight({ ...BOX, scrollHeight: 0 })).toEqual({ height: 38, overflow: false });
  });

  test("grows with the text", () => {
    expect(autogrowHeight({ ...BOX, scrollHeight: 76 })).toEqual({ height: 78, overflow: false });
  });

  test("exactly four lines: full height, no scrollbar", () => {
    expect(autogrowHeight({ ...BOX, scrollHeight: 96 })).toEqual({ height: 98, overflow: false });
  });

  test("sub-pixel rounding at four lines does not trigger the scrollbar", () => {
    expect(autogrowHeight({ ...BOX, scrollHeight: 96.8 }).overflow).toBe(false);
  });

  test("beyond four lines: height capped, scrollbar on", () => {
    expect(autogrowHeight({ ...BOX, scrollHeight: 400 })).toEqual({ height: 98, overflow: true });
  });

  test("maxLines is configurable", () => {
    expect(autogrowHeight({ ...BOX, scrollHeight: 400, maxLines: 2 })).toEqual({ height: 58, overflow: true });
  });
});
