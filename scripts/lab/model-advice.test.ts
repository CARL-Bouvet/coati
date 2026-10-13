// Pure helpers of extension/panel/model-advice.js (4 and 6). The DOM builders are exercised by the
// lab states progress-*, shared-model-advice and answer-stalled-tip.
import { describe, expect, test } from "bun:test";
import { groupModels } from "../../extension/lib/model-list.js";
import {
  coatiVisible,
  COATI_VISIBLE_MS,
  isSlowFirstWord,
  progressKey,
  readProgressStage,
  sharedModelNoticeText,
  slowTipFor,
  SLOW_FIRST_WORD_MS,
} from "../../extension/panel/model-advice.js";

const ROMAIN = groupModels({
  current: { provider: "ollama", model: "qwen3:8b" },
  entries: [
    { provider: "ollama", model: "qwen3:8b", local: true, sizeBytes: 5_225_387_923, fit: "shared", gpuPercent: 68 },
    { provider: "ollama", model: "qwen3:4b", local: true, sizeBytes: 2_600_000_000, fit: "gpu" },
    { provider: "ollama", model: "llama3.2:latest", local: true, sizeBytes: 2_019_393_189, fit: "gpu" },
    { provider: "claude-cli", model: "claude-sonnet-4-5", local: false },
  ],
});
const NOTHING_FITS = groupModels({
  current: { provider: "ollama", model: "qwen3:8b" },
  entries: [{ provider: "ollama", model: "qwen3:8b", local: true, sizeBytes: 5_225_387_923, fit: "shared" }],
});
const slow = ROMAIN.currentEntry;
const fits = ROMAIN.local[1];
const online = ROMAIN.online[0];

// Stand-in for chrome.i18n: key + substitutions, enough to check the wiring.
const t = (key: string, subs: string[] = []) => [key, ...subs].join("|");

describe("progress stage", () => {
  test("only loading / reading are drawn", () => {
    expect(readProgressStage("loading")).toBe("loading");
    expect(readProgressStage("reading")).toBe("reading");
    expect(readProgressStage("thinking")).toBe("thinking");
    expect(readProgressStage("writing")).toBeNull();
    expect(readProgressStage(undefined)).toBeNull();
  });

  test("thinking has its own line", () => {
    expect(progressKey("thinking", true)).toBe("panel_progress_thinking");
  });

  test("reading names the page only when the page was sent", () => {
    expect(progressKey("loading", true)).toBe("panel_progress_loading");
    expect(progressKey("reading", true)).toBe("panel_progress_reading_page");
    expect(progressKey("reading", false)).toBe("panel_progress_reading_request");
  });
});

describe("« partagé » model notice", () => {
  test("names the model, then the largest one that fits", () => {
    expect(sharedModelNoticeText(slow, ROMAIN, t)).toBe("panel_shared_model_note|qwen3:8b panel_shared_model_alt|qwen3:4b");
  });

  test("one sentence when nothing fits", () => {
    expect(sharedModelNoticeText(NOTHING_FITS.currentEntry, NOTHING_FITS, t)).toBe("panel_shared_model_note|qwen3:8b");
  });
});

describe("tip after a slow or cut answer", () => {
  test("slow Ollama model: suggests the largest one that fits", () => {
    expect(slowTipFor(slow, ROMAIN)).toEqual({ suggest: "qwen3:4b" });
  });

  test("Ollama model that fits: speed-up only", () => {
    expect(slowTipFor(fits, ROMAIN)).toEqual({ suggest: null });
  });

  test("nothing fits: speed-up only", () => {
    expect(slowTipFor(NOTHING_FITS.currentEntry, NOTHING_FITS)).toEqual({ suggest: null });
  });

  test("online model or unknown: no tip", () => {
    expect(slowTipFor(online, ROMAIN)).toBeNull();
    expect(slowTipFor(null, ROMAIN)).toBeNull();
  });

  test("late first word only counts on a model that doesn't fit", () => {
    expect(isSlowFirstWord(SLOW_FIRST_WORD_MS + 1, slow)).toBe(true);
    expect(isSlowFirstWord(SLOW_FIRST_WORD_MS - 1, slow)).toBe(false);
    expect(isSlowFirstWord(SLOW_FIRST_WORD_MS + 1, fits)).toBe(false);
    expect(isSlowFirstWord(SLOW_FIRST_WORD_MS + 1, online)).toBe(false);
  });
});

describe("sniffing coati's 2s window (injected clock, no real timers)", () => {
  const start = 1_000_000;

  test("visible right when the first progress stage fires", () => {
    expect(coatiVisible(start, start)).toBe(true);
  });

  test("still visible just under the window", () => {
    expect(coatiVisible(start, start + COATI_VISIBLE_MS - 1)).toBe(true);
  });

  test("gone exactly at the window and after", () => {
    expect(coatiVisible(start, start + COATI_VISIBLE_MS)).toBe(false);
    expect(coatiVisible(start, start + COATI_VISIBLE_MS + 5000)).toBe(false);
  });

  test("a later stage change (loading -> reading) does not restart the window", () => {
    // startedAt is set once, on the first stage; a later stage at +1900ms
    // still uses the same startedAt, so "now" close to it must stay hidden
    // once the original window elapsed.
    const laterStageAt = start + 1900;
    expect(coatiVisible(start, laterStageAt)).toBe(true); // still within 2s of the real start
    expect(coatiVisible(start, laterStageAt + 200)).toBe(false); // 2100ms after the real start
  });

  test("no stage fired yet: never visible", () => {
    expect(coatiVisible(undefined, start)).toBe(false);
    expect(coatiVisible(null, start)).toBe(false);
  });
});
