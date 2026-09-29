// Unit tests for the two-step "arm, then confirm" reducer behind the prompt
// library's delete button.
import { describe, expect, test } from "bun:test";
import { armOrConfirm } from "../../extension/panel/confirm-arm.js";

describe("armOrConfirm", () => {
  test("first click on an item arms it, does not confirm", () => {
    expect(armOrConfirm(null, "a")).toEqual({ armed: "a", confirmed: false });
  });

  test("second click on the SAME armed item confirms and disarms", () => {
    expect(armOrConfirm("a", "a")).toEqual({ armed: null, confirmed: true });
  });

  test("clicking a DIFFERENT item re-arms it instead of confirming", () => {
    expect(armOrConfirm("a", "b")).toEqual({ armed: "b", confirmed: false });
  });
});
