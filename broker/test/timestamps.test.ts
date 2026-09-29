// Unit tests for the [mm:ss]/[h:mm:ss] timestamp parser used by the panel to
// make YouTube-summary bullets clickable. Plain, DOM-free JS module, so it
// imports and runs directly from the broker's test runner — same pattern as
// broker/test/detect.test.ts for extension/content/detect.js.
import { describe, expect, test } from "bun:test";
import { getYouTubeVideoIdFromUrl, parseTimestamps } from "../../extension/panel/timestamps.js";

describe("parseTimestamps — valid forms", () => {
  test("[m:ss]", () => {
    expect(parseTimestamps("[2:52] Un neurone…")).toEqual([
      { type: "timestamp", raw: "[2:52]", label: "2:52", seconds: 172 },
      { type: "text", value: " Un neurone…" },
    ]);
  });

  test("[mm:ss]", () => {
    expect(parseTimestamps("[12:18] Ce réseau…")).toEqual([
      { type: "timestamp", raw: "[12:18]", label: "12:18", seconds: 738 },
      { type: "text", value: " Ce réseau…" },
    ]);
  });

  test("[h:mm:ss]", () => {
    expect(parseTimestamps("[1:02:03] plus loin")).toEqual([
      { type: "timestamp", raw: "[1:02:03]", label: "1:02:03", seconds: 3723 },
      { type: "text", value: " plus loin" },
    ]);
  });
});

describe("parseTimestamps — invalid forms are left as plain text", () => {
  test("minutes/seconds >= 60 (99:99)", () => {
    expect(parseTimestamps("[99:99] texte")).toEqual([{ type: "text", value: "[99:99] texte" }]);
  });

  test("four components ([1:2:3:4])", () => {
    expect(parseTimestamps("[1:2:3:4] texte")).toEqual([{ type: "text", value: "[1:2:3:4] texte" }]);
  });

  test("non-numeric ([abc])", () => {
    expect(parseTimestamps("[abc] texte")).toEqual([{ type: "text", value: "[abc] texte" }]);
  });
});

describe("parseTimestamps — multiple timestamps and plain text", () => {
  test("a line with several timestamps", () => {
    expect(parseTimestamps("[0:01] premier, puis [0:02] second.")).toEqual([
      { type: "timestamp", raw: "[0:01]", label: "0:01", seconds: 1 },
      { type: "text", value: " premier, puis " },
      { type: "timestamp", raw: "[0:02]", label: "0:02", seconds: 2 },
      { type: "text", value: " second." },
    ]);
  });

  test("text with none returns a single text token, unchanged", () => {
    const text = "Un résumé sans horodatage du tout.";
    expect(parseTimestamps(text)).toEqual([{ type: "text", value: text }]);
  });

  test("ordinary text passes through unchanged (no mutation, no re-encoding)", () => {
    const text = "Prix : 12,50 € — 50% de réduction & compagnie <ok>";
    expect(parseTimestamps(text)).toEqual([{ type: "text", value: text }]);
  });
});

describe("getYouTubeVideoIdFromUrl", () => {
  test("a watch URL", () => {
    expect(getYouTubeVideoIdFromUrl("https://www.youtube.com/watch?v=abc123")).toBe("abc123");
  });

  test("a youtu.be short link", () => {
    expect(getYouTubeVideoIdFromUrl("https://youtu.be/abc123")).toBe("abc123");
  });

  test("a non-YouTube URL", () => {
    expect(getYouTubeVideoIdFromUrl("https://example.com/watch?v=abc123")).toBeUndefined();
  });
});
