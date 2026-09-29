// Unit test for the debounce helper used by panel.js to coalesce
// chrome.tabs.onUpdated events before re-detecting the page.
import { describe, expect, test } from "bun:test";
import { debounce } from "../../extension/panel/debounce.js";

describe("debounce", () => {
  test("only the last call within the window runs", async () => {
    const calls: number[] = [];
    const debounced = debounce((n: number) => calls.push(n), 30);

    debounced(1);
    debounced(2);
    debounced(3);

    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(calls).toEqual([3]);
  });

  test("calls spaced further apart than the window both run", async () => {
    const calls: number[] = [];
    const debounced = debounce((n: number) => calls.push(n), 20);

    debounced("a");
    await new Promise((resolve) => setTimeout(resolve, 40));
    debounced("b");
    await new Promise((resolve) => setTimeout(resolve, 40));

    expect(calls).toEqual(["a", "b"]);
  });
});
