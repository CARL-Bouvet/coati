// Unit tests for docs/DECISIONS.md T45 (goal G2), points 1 to 6, implemented in
// extension/content/extract.js.
//
// Reuses the fake-DOM harness pattern from extract.test.ts / extract-ter.test.ts
// (FakeElement / FakeHTMLCollection / runExtract) rather than importing it
// (neither file exports it) — extended here with the bits T45 needs that the
// older harnesses don't model: `checkVisibility()`, `shadowRoot` /
// `openOrClosedShadowRoot()`, and a `getComputedStyle` mock that also reads
// `fontSize` / `color` / `backgroundColor` / `clip` / `clipPath`.
//
// Rule -> lecture_des_pages.md section 5 point -> extract.js:
//   1. never pick a non-rendered candidate -> isRenderedCandidate,
//      findMainRegion, articleText
//   2. group repeated sibling blocks -> findThreadGroupContainer, findMainRegion
//   3. read shadow roots (open and closed) -> getOpenOrClosedShadowRoot,
//      collectShadowText
//   4. strip text invisible to the eye -> stripZeroWidth, findInvisibleTextElements
//   5. keep headings/list items as `#`/`##`/`###`/`- ` lines -> applyStructurePrefixes
//   6. `readability` field ("ok"/"canvas"/"empty") -> computeReadability

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const EXTRACT_JS_SOURCE = readFileSync(
  join(import.meta.dir, "../../extension/content/extract.js"),
  "utf8",
);

type FakeRect = { top?: number; bottom?: number; left?: number; right?: number; width?: number; height?: number };
type FakeStyle = {
  position?: string;
  display?: string;
  visibility?: string;
  fontSize?: string;
  color?: string;
  backgroundColor?: string;
  clip?: string;
  clipPath?: string;
};

class FakeHTMLCollection {
  #items: FakeElement[];
  constructor(items: FakeElement[]) {
    this.#items = items;
    items.forEach((item, i) => {
      Object.defineProperty(this, i, { value: item, enumerable: true });
    });
  }
  get length(): number {
    return this.#items.length;
  }
  item(i: number): FakeElement | null {
    return this.#items[i] ?? null;
  }
  [Symbol.iterator](): Iterator<FakeElement> {
    return this.#items[Symbol.iterator]();
  }
}

/** A minimal open shadow root: only what shadowRootOwnText/shadowRootText
 * read (`.children`, optionally `.querySelectorAll` for nested hosts). */
class FakeShadowRoot {
  children: FakeElement[];
  constructor(children: FakeElement[]) {
    this.children = children;
  }
  querySelectorAll(selector: string): FakeElement[] {
    // Nested shadow hosts aren't exercised by these tests; empty is a safe,
    // honest answer for a flat shadow tree.
    return [];
  }
}

class FakeElement {
  tagName: string;
  attrs: Record<string, string>;
  children: FakeHTMLCollection;
  #childArray: FakeElement[];
  #parent: FakeElement | null = null;
  get parentElement(): FakeElement | null {
    return this.#parent;
  }
  textContent: string;
  rect: FakeRect;
  style: FakeStyle;
  _renderedText: string;
  /** undefined = "not implemented" (feature-detection falls through), same
   * as a real browser lacking the API — only set when a test needs it. */
  #checkVisibilityResult: boolean | undefined;
  shadowRoot: FakeShadowRoot | null;
  #closedShadowRoot: FakeShadowRoot | null;

  constructor(
    tag: string,
    opts: {
      attrs?: Record<string, string>;
      children?: FakeElement[];
      text?: string;
      textContent?: string;
      rect?: FakeRect;
      style?: FakeStyle;
      checkVisibilityResult?: boolean;
      shadowRoot?: FakeElement[];
      closedShadowRoot?: FakeElement[];
    } = {},
  ) {
    this.tagName = tag.toUpperCase();
    this.attrs = opts.attrs ?? {};
    this.#childArray = opts.children ?? [];
    for (const c of this.#childArray) c.#parent = this;
    this.children = new FakeHTMLCollection(this.#childArray);
    this._renderedText = opts.text ?? "";
    this.textContent = opts.textContent ?? opts.text ?? "";
    this.rect = opts.rect ?? {};
    this.style = opts.style ?? {};
    this.#checkVisibilityResult = opts.checkVisibilityResult;
    this.shadowRoot = opts.shadowRoot ? new FakeShadowRoot(opts.shadowRoot) : null;
    this.#closedShadowRoot = opts.closedShadowRoot ? new FakeShadowRoot(opts.closedShadowRoot) : null;
  }

  get text(): string {
    return this.innerText;
  }
  set text(value: string) {
    this._renderedText = value;
  }

  get innerText(): string {
    if (this.isHiddenByDisplayNone()) return this.textContent;
    return this._renderedText;
  }
  set innerText(value: string) {
    this._renderedText = value;
  }

  private isHiddenByDisplayNone(): boolean {
    let el: FakeElement | null = this;
    while (el) {
      if (el.style?.display === "none") return true;
      el = el.#parent;
    }
    return false;
  }

  getAttribute(name: string): string | null {
    return this.attrs[name] ?? null;
  }

  getBoundingClientRect(): FakeRect {
    return this.rect;
  }

  getClientRects(): FakeRect[] {
    return this.isHiddenByDisplayNone() ? [] : [this.rect];
  }

  // Only present when the fixture opts in (`checkVisibilityResult` set) —
  // matches real feature-detection: most fixtures behave like a browser
  // that hasn't shipped `checkVisibility` yet, same as the older harnesses.
  checkVisibility(this: FakeElement, _opts?: unknown): boolean | undefined {
    return this.#checkVisibilityResult;
  }

  // Firefox-shaped shadow API — only defined when a fixture asks for a
  // closed root, so `typeof el.openOrClosedShadowRoot === "function"`
  // stays false everywhere else (feature-detection must not assume it).
  openOrClosedShadowRoot(): FakeShadowRoot | null {
    return this.#closedShadowRoot;
  }

  contains(other: FakeElement | null | undefined): boolean {
    let el: FakeElement | null | undefined = other;
    while (el) {
      if (el === this) return true;
      el = el.#parent;
    }
    return false;
  }

  private walkDescendants(cb: (el: FakeElement) => void): void {
    for (const c of this.#childArray) {
      cb(c);
      c["walkDescendants"](cb);
    }
  }

  querySelectorAll(selector: string): FakeElement[] {
    const out: FakeElement[] = [];
    this.walkDescendants((el) => {
      if (matches(el, selector)) out.push(el);
    });
    return out;
  }

  querySelector(selector: string): FakeElement | null {
    return this.querySelectorAll(selector)[0] ?? null;
  }

  getElementsByTagName(tag: string): FakeElement[] {
    if (tag === "*") {
      const out: FakeElement[] = [];
      this.walkDescendants((el) => out.push(el));
      return out;
    }
    return this.querySelectorAll(tag);
  }

  closest(selector: string): FakeElement | null {
    let el: FakeElement | null = this;
    while (el) {
      if (matches(el, selector)) return el;
      el = el.#parent;
    }
    return null;
  }
}

// Deletes the never-implemented Firefox method from instances that didn't
// opt into a closed shadow root, so feature-detection sees it as genuinely
// absent rather than "a function that returns null" (a real absent API
// doesn't exist at all).
function stripUnusedShadowApi(el: FakeElement, hadClosedShadowRoot: boolean): void {
  if (!hadClosedShadowRoot) {
    // @ts-expect-error - intentionally removing the method for realism
    delete el.openOrClosedShadowRoot;
  }
}

function matchesSimple(el: FakeElement, simple: string): boolean {
  const trimmed = simple.trim();
  if (trimmed === "*") return true;
  const attrMatch = trimmed.match(/^([a-zA-Z0-9-]*)\[([a-zA-Z-]+)(?:=(?:"([^"]*)"|'([^']*)'))?\]$/);
  if (attrMatch) {
    const [, tag, attr, dq, sq] = attrMatch;
    if (tag && el.tagName !== tag.toUpperCase()) return false;
    const value = el.getAttribute(attr!);
    if (value === null) return false;
    const expected = dq ?? sq;
    if (expected !== undefined && value !== expected) return false;
    return true;
  }
  if (/^[a-zA-Z0-9-]+$/.test(trimmed)) {
    return el.tagName === trimmed.toUpperCase();
  }
  throw new Error(`fake DOM matcher doesn't understand selector clause: "${simple}"`);
}

function matches(el: FakeElement, selector: string): boolean {
  return selector.split(",").some((part) => matchesSimple(el, part));
}

function runExtract(opts: {
  url?: string;
  title?: string;
  body: FakeElement;
  viewport?: { innerWidth: number; innerHeight: number };
}): any {
  const url = opts.url ?? "https://example.com/article";
  const fakeDocument = {
    title: opts.title ?? "",
    body: opts.body,
    querySelectorAll: (selector: string) => opts.body.querySelectorAll(selector),
    querySelector: (selector: string) => opts.body.querySelector(selector),
  };
  const parsed = new URL(url);
  const fakeLocation = {
    href: url,
    origin: parsed.origin,
    pathname: parsed.pathname,
    hostname: parsed.hostname,
  };
  const viewport = opts.viewport ?? { innerWidth: 1024, innerHeight: 768 };
  const fakeWindow = { innerWidth: viewport.innerWidth, innerHeight: viewport.innerHeight };
  function computedStyleOf(el: FakeElement): FakeStyle & { position: string; visibility: string } {
    let visibility = "visible";
    let cur: FakeElement | null = el;
    while (cur) {
      if (cur.style?.visibility) {
        visibility = cur.style.visibility;
        break;
      }
      cur = cur.parentElement;
    }
    return {
      position: el.style?.position || "static",
      visibility,
      fontSize: el.style?.fontSize,
      color: el.style?.color,
      backgroundColor: el.style?.backgroundColor,
      clip: el.style?.clip,
      clipPath: el.style?.clipPath,
    };
  }
  const asExpression = EXTRACT_JS_SOURCE.trim().replace(/;\s*$/, "");
  // eslint-disable-next-line no-new-func
  const factory = new Function(
    "document",
    "location",
    "window",
    "getComputedStyle",
    `"use strict";\nreturn (\n${asExpression}\n);`,
  );
  return factory(fakeDocument, fakeLocation, fakeWindow, computedStyleOf);
}

// ============================================================================
// Rule 1 — never pick a non-rendered candidate.
// ============================================================================

describe("extract.js — T45 rule 1: skip non-rendered candidates", () => {
  test("checkVisibility() === false loses to a genuinely rendered candidate", () => {
    const hiddenPopin = new FakeElement("div", {
      text: "x".repeat(600), // would win on density alone
      checkVisibilityResult: false,
    });
    const article = new FakeElement("article", { text: "Real article body. ".repeat(20) });
    const body = new FakeElement("body", { children: [hiddenPopin, article] });
    const result = runExtract({ body });
    expect(result.text).toContain("Real article body.");
    expect(result.text).not.toContain("xxxx");
  });

  test("an aria-hidden subtree loses even when checkVisibility is unimplemented", () => {
    const hiddenMenu = new FakeElement("div", {
      attrs: { "aria-hidden": "true" },
      text: "y".repeat(600),
    });
    const article = new FakeElement("article", { text: "Real article body. ".repeat(20) });
    const body = new FakeElement("body", { children: [hiddenMenu, article] });
    const result = runExtract({ body });
    expect(result.text).toContain("Real article body.");
    expect(result.text).not.toContain("yyyy");
  });

  test("a semantic <main> that fails checkVisibility is skipped in favor of a visible <article>", () => {
    const hiddenMain = new FakeElement("main", {
      text: "Hidden settings dialog. ".repeat(20),
      checkVisibilityResult: false,
    });
    const article = new FakeElement("article", { text: "Real article body. ".repeat(20) });
    const body = new FakeElement("body", { children: [hiddenMain, article] });
    const result = runExtract({ body });
    expect(result.text).toContain("Real article body.");
    expect(result.text).not.toContain("Hidden settings dialog.");
  });
});

// ============================================================================
// Rule 2 — group repeated sibling blocks instead of keeping the densest one.
// ============================================================================

describe("extract.js — T45 rule 2: repeated sibling blocks (comment threads)", () => {
  test("a table-like comment thread is read whole, not just its densest row", () => {
    const commentTexts = [
      "First comment with enough characters to pass the entry floor easily.",
      "Second comment, also long enough, replying to the first one above here.",
      "Third comment adds more context and is at least forty characters long.",
      "Fourth comment: shorter but still over the forty character floor set.",
      "Fifth comment closes the thread with a final remark of its own here.",
      // The densest single row on a real page (no nested tags of its own) —
      // longer than the others so the OLD density-only heuristic would pick
      // this row alone instead of the whole thread.
      "z".repeat(400),
    ];
    const rows = commentTexts.map((t) => new FakeElement("div", { attrs: { class: "comment" }, text: t }));
    const table = new FakeElement("div", {
      attrs: { class: "comment-tree" },
      children: rows,
      text: commentTexts.join("\n"),
    });
    const body = new FakeElement("body", { children: [table] });
    const result = runExtract({ body });
    // Every comment survives, not just the densest row.
    expect(result.text).toContain("First comment");
    expect(result.text).toContain("Fifth comment");
    expect(result.text).toContain("zzzz");
  });

  test("fewer than five same-shape siblings does not trigger grouping (falls back to density)", () => {
    const rows = ["one", "two", "three"].map(
      (t) => new FakeElement("div", { text: `${t} ${"pad".repeat(70)}` }),
    );
    const wrapper = new FakeElement("div", { children: rows, text: rows.map((r) => r.text).join("\n") });
    const dense = new FakeElement("div", { text: "d".repeat(500) });
    const body = new FakeElement("body", { children: [wrapper, dense] });
    const result = runExtract({ body });
    // Unchanged behavior: the single densest candidate still wins when there
    // is no repeated-shape group of at least five.
    expect(result.text).toContain("dddd");
  });
});

// ============================================================================
// Rule 3 — read shadow roots, open and closed.
// ============================================================================

describe("extract.js — T45 rule 3: shadow DOM", () => {
  test("an open shadow root's text is read (el.shadowRoot)", () => {
    const shadowChild = new FakeElement("p", { text: "Text living inside an open shadow root." });
    const host = new FakeElement("my-widget", { shadowRoot: [shadowChild] });
    const article = new FakeElement("article", {
      children: [host],
      text: "Real article body. ".repeat(20),
    });
    const body = new FakeElement("body", { children: [article] });
    const result = runExtract({ body });
    expect(result.text).toContain("Real article body.");
    expect(result.text).toContain("Text living inside an open shadow root.");
  });

  test("a closed shadow root's text is read via openOrClosedShadowRoot()", () => {
    const shadowChild = new FakeElement("p", { text: "Text living inside a closed shadow root." });
    const host = new FakeElement("my-widget", { closedShadowRoot: [shadowChild] });
    stripUnusedShadowApi(host, true);
    const article = new FakeElement("article", {
      children: [host],
      text: "Real article body. ".repeat(20),
    });
    const body = new FakeElement("body", { children: [article] });
    const result = runExtract({ body });
    expect(result.text).toContain("Real article body.");
    expect(result.text).toContain("Text living inside a closed shadow root.");
  });

  test("no shadow API present at all never throws", () => {
    const host = new FakeElement("div", { text: "plain host, no shadow root" });
    stripUnusedShadowApi(host, false);
    const article = new FakeElement("article", {
      children: [host],
      text: "Real article body. ".repeat(20),
    });
    const body = new FakeElement("body", { children: [article] });
    expect(() => runExtract({ body })).not.toThrow();
  });
});

// ============================================================================
// Rule 4 — text invisible to the eye.
// ============================================================================

describe("extract.js — T45 rule 4: text invisible to the eye", () => {
  test("zero-width characters are stripped from the final text", () => {
    const article = new FakeElement("article", {
      text: `Real​body‌text‍with⁠zero﻿width chars. ${"pad ".repeat(60)}`,
    });
    const body = new FakeElement("body", { children: [article] });
    const result = runExtract({ body });
    expect(result.text).not.toMatch(/[​-‍⁠﻿]/);
    expect(result.text).toContain("Realbodytextwithzerowidth chars.");
  });

  test("near-zero font-size text is excluded", () => {
    const hiddenSpan = new FakeElement("span", {
      text: "SECRET_INSTRUCTION_TINY_FONT",
      style: { fontSize: "1px" },
    });
    const article = new FakeElement("article", {
      children: [hiddenSpan],
      text: `Real article body. ${"pad ".repeat(60)} SECRET_INSTRUCTION_TINY_FONT`,
    });
    const body = new FakeElement("body", { children: [article], text: article.text });
    const result = runExtract({ body });
    expect(result.text).toContain("Real article body.");
    expect(result.text).not.toContain("SECRET_INSTRUCTION_TINY_FONT");
  });

  test("clip-based screen-reader-only text is excluded", () => {
    const srOnly = new FakeElement("span", {
      text: "SECRET_INSTRUCTION_CLIPPED",
      style: { clip: "rect(0px, 0px, 0px, 0px)", position: "absolute" },
    });
    const article = new FakeElement("article", {
      children: [srOnly],
      text: `Real article body. ${"pad ".repeat(60)} SECRET_INSTRUCTION_CLIPPED`,
    });
    const body = new FakeElement("body", { children: [article], text: article.text });
    const result = runExtract({ body });
    expect(result.text).toContain("Real article body.");
    expect(result.text).not.toContain("SECRET_INSTRUCTION_CLIPPED");
  });

  test("off-screen text (left: -9999px) is excluded", () => {
    const offscreen = new FakeElement("span", {
      text: "SECRET_INSTRUCTION_OFFSCREEN",
      style: { position: "absolute" },
      rect: { left: -9999, right: -9800, top: 0, bottom: 10, width: 199, height: 10 },
    });
    const article = new FakeElement("article", {
      children: [offscreen],
      text: `Real article body. ${"pad ".repeat(60)} SECRET_INSTRUCTION_OFFSCREEN`,
    });
    const body = new FakeElement("body", { children: [article], text: article.text });
    const result = runExtract({ body });
    expect(result.text).toContain("Real article body.");
    expect(result.text).not.toContain("SECRET_INSTRUCTION_OFFSCREEN");
  });

  test("scrolled-past static content (negative rect, no fixed/absolute position) is NOT treated as off-screen", () => {
    // getBoundingClientRect is viewport-relative: an article's opening lines,
    // scrolled past at the moment extract.js runs, have a negative top/bottom
    // too — but they are `position: static`, unlike the CSS hiding trick.
    const scrolledPastPara = new FakeElement("p", {
      text: "The article's opening paragraph, now scrolled above the fold.",
      rect: { left: 10, right: 500, top: -900, bottom: -820, width: 490, height: 80 },
    });
    const article = new FakeElement("article", {
      children: [scrolledPastPara],
      text: `${scrolledPastPara.text} ${"pad ".repeat(60)}`,
    });
    const body = new FakeElement("body", { children: [article] });
    const result = runExtract({ body });
    expect(result.text).toContain("The article's opening paragraph");
  });

  test("text painted the same color as its background is excluded", () => {
    const invisibleInk = new FakeElement("span", {
      text: "SECRET_INSTRUCTION_SAME_COLOR",
      style: { color: "rgb(255, 255, 255)", backgroundColor: "rgb(255, 255, 255)" },
    });
    const article = new FakeElement("article", {
      children: [invisibleInk],
      text: `Real article body. ${"pad ".repeat(60)} SECRET_INSTRUCTION_SAME_COLOR`,
    });
    const body = new FakeElement("body", { children: [article], text: article.text });
    const result = runExtract({ body });
    expect(result.text).toContain("Real article body.");
    expect(result.text).not.toContain("SECRET_INSTRUCTION_SAME_COLOR");
  });

  test("ordinary visible text with a real color/background contrast is kept", () => {
    const visible = new FakeElement("span", {
      text: "perfectly visible caption",
      style: { color: "rgb(0, 0, 0)", backgroundColor: "rgb(255, 255, 255)" },
    });
    const article = new FakeElement("article", {
      children: [visible],
      text: `Real article body. ${"pad ".repeat(60)} perfectly visible caption`,
    });
    const body = new FakeElement("body", { children: [article] });
    const result = runExtract({ body });
    expect(result.text).toContain("perfectly visible caption");
  });
});

// ============================================================================
// Rule 5 — headings and list items kept as `#`/`##`/`###`/`- ` lines.
// ============================================================================

describe("extract.js — T45 rule 5: structure kept as plain-text markup", () => {
  test("h1/h2/li get prefixed lines; ordinary paragraphs are untouched", () => {
    const h1 = new FakeElement("h1", { text: "Main Title" });
    const h2 = new FakeElement("h2", { text: "A Section" });
    const li1 = new FakeElement("li", { text: "Item one" });
    const li2 = new FakeElement("li", { text: "Item two" });
    const list = new FakeElement("ul", { children: [li1, li2], text: "Item one\nItem two" });
    const para = new FakeElement("p", {
      text: `An ordinary paragraph of body prose, padded past the two hundred character density floor. ${"pad ".repeat(20)}`,
    });
    const article = new FakeElement("article", {
      children: [h1, h2, list, para],
      text: [h1.text, h2.text, list.text, para.text].join("\n"),
    });
    const body = new FakeElement("body", { children: [article] });
    const result = runExtract({ body });
    expect(result.text).toContain("# Main Title");
    expect(result.text).toContain("## A Section");
    expect(result.text).toContain("- Item one");
    expect(result.text).toContain("- Item two");
    expect(result.text).toContain("An ordinary paragraph of body prose");
    // "No other markup": the paragraph line is not itself prefixed.
    expect(result.text).not.toContain("# An ordinary paragraph");
  });

  test("h3-h6 all collapse to the same `### ` prefix", () => {
    const h3 = new FakeElement("h3", { text: "Sub Section" });
    const article = new FakeElement("article", {
      children: [h3],
      text: `${h3.text}\n${"pad ".repeat(60)}`,
    });
    const body = new FakeElement("body", { children: [article] });
    const result = runExtract({ body });
    expect(result.text).toContain("### Sub Section");
  });
});

// ============================================================================
// Rule 6 — `readability` field.
// ============================================================================

describe("extract.js — T45 rule 6: readability field", () => {
  test("a normal article is 'ok'", () => {
    const article = new FakeElement("article", { text: "Real article body. ".repeat(30) });
    const body = new FakeElement("body", { children: [article] });
    const result = runExtract({ body });
    expect(result.readability).toBe("ok");
  });

  test("a near-empty page is 'empty'", () => {
    const article = new FakeElement("article", { text: "too short" });
    const div = new FakeElement("div", { text: "also too short but over two hundred? no." });
    const body = new FakeElement("body", { children: [article, div] });
    const result = runExtract({ body });
    expect(result.text.length).toBeLessThan(200);
    expect(result.readability).toBe("empty");
  });

  test("a full-viewport canvas with little text is 'canvas'", () => {
    const canvas = new FakeElement("canvas", {
      rect: { top: 0, left: 0, right: 1024, bottom: 768, width: 1024, height: 768 },
    });
    const caption = new FakeElement("div", { text: "Map view" });
    const body = new FakeElement("body", { children: [canvas, caption] });
    const result = runExtract({ body });
    expect(result.readability).toBe("canvas");
  });

  test("a small decorative canvas next to a real article stays 'ok'", () => {
    const canvas = new FakeElement("canvas", {
      rect: { top: 0, left: 0, right: 50, bottom: 50, width: 50, height: 50 },
    });
    const article = new FakeElement("article", { text: "Real article body. ".repeat(30) });
    const body = new FakeElement("body", { children: [canvas, article] });
    const result = runExtract({ body });
    expect(result.readability).toBe("ok");
  });
});
