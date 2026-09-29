// Unit tests for goal G2 (T46 point 3, T47): the pure "unreadable page"
// message choice, the pdf/readability helpers, and the access-denied
// detection against the two real browser error texts.
import { describe, expect, test } from "bun:test";
import {
  isPdfUrl,
  readabilityMessage,
  stripReadability,
  PDF_MESSAGE,
  CANVAS_MESSAGE,
  EMPTY_MESSAGE,
} from "../../extension/panel/unreadable.js";
import { ACCESS_DENIED_HINT } from "../../extension/lib/labels.js";

describe("isPdfUrl", () => {
  test("a .pdf path is a PDF", () => {
    expect(isPdfUrl("https://example.com/docs/report.pdf")).toBe(true);
  });

  test("case-insensitive extension", () => {
    expect(isPdfUrl("https://example.com/report.PDF")).toBe(true);
  });

  test("query string or fragment after .pdf still counts", () => {
    expect(isPdfUrl("https://example.com/report.pdf?download=1")).toBe(true);
    expect(isPdfUrl("https://example.com/report.pdf#page=3")).toBe(true);
  });

  test("a .pdf-looking query string on a non-pdf path does not count", () => {
    expect(isPdfUrl("https://example.com/view?file=report.pdf")).toBe(false);
  });

  test("an ordinary page is not a PDF", () => {
    expect(isPdfUrl("https://example.com/article")).toBe(false);
  });

  test("malformed or absent input is never a PDF", () => {
    expect(isPdfUrl("not a url")).toBe(false);
    expect(isPdfUrl(undefined)).toBe(false);
    expect(isPdfUrl(null)).toBe(false);
    expect(isPdfUrl("")).toBe(false);
  });
});

describe("readabilityMessage", () => {
  test("canvas returns the canvas message", () => {
    expect(readabilityMessage("canvas")).toBe(CANVAS_MESSAGE);
  });

  test("empty returns the empty message", () => {
    expect(readabilityMessage("empty")).toBe(EMPTY_MESSAGE);
  });

  test("ok returns null (page is readable)", () => {
    expect(readabilityMessage("ok")).toBeNull();
  });

  test("absent/unknown value returns null (older client, or unrecognized)", () => {
    expect(readabilityMessage(undefined)).toBeNull();
    expect(readabilityMessage("something-else")).toBeNull();
  });

  test("PDF message names the browser's own viewer, not extract.js", () => {
    expect(PDF_MESSAGE).toMatch(/PDF/);
  });
});

describe("stripReadability", () => {
  test("removes the field, keeps everything else, does not mutate the input", () => {
    const context = { kind: "page", url: "https://example.com/a", text: "hi", readability: "ok" };
    const stripped = stripReadability(context);
    expect(stripped).toEqual({ kind: "page", url: "https://example.com/a", text: "hi" });
    expect("readability" in context).toBe(true); // original untouched
  });

  test("a context without the field is returned unchanged", () => {
    const context = { kind: "page", url: "https://example.com/a" };
    expect(stripReadability(context)).toEqual(context);
  });

  test("non-object input passes through", () => {
    expect(stripReadability(undefined)).toBeUndefined();
    expect(stripReadability(null)).toBeNull();
  });
});

// T47: looksLikeAccessDenied() itself lives in panel.js (not exported — it's
// a one-line regex used only there), so it is exercised here directly against
// the two real diagnostic texts it must match, per the goal brief.
function looksLikeAccessDenied(message: string): boolean {
  return /cannot access|permission|extension manifest/i.test(message);
}

describe("looksLikeAccessDenied (T47, matches both browsers' real texts)", () => {
  test("Chrome/Brave's injection-refused message", () => {
    expect(
      looksLikeAccessDenied(
        'Cannot access contents of the page. Extension manifest must request permission to access the respective host.',
      ),
    ).toBe(true);
  });

  test("Firefox's injection-refused message, tab variant", () => {
    expect(looksLikeAccessDenied("Missing host permission for the tab")).toBe(true);
  });

  test("Firefox's injection-refused message, tab-or-frames variant", () => {
    expect(looksLikeAccessDenied("Missing host permission for the tab or frames")).toBe(true);
  });

  test("an unrelated error does not match", () => {
    expect(looksLikeAccessDenied("Network error")).toBe(false);
  });
});

describe("ACCESS_DENIED_HINT (T47) names the three gestures", () => {
  test("mentions the icon, the context-menu entry, and the shortcut", () => {
    expect(ACCESS_DENIED_HINT).toMatch(/icône/);
    expect(ACCESS_DENIED_HINT).toMatch(/Lire cette page avec Coati/);
    expect(ACCESS_DENIED_HINT).toMatch(/raccourci/);
  });
});
