// Unit tests for extract.js's Lot A2 step (plan-montrer-voir-chercher-08-10.md
// §3A, flow (1)-(2)): collectInteractiveElements / buildElementsContext.
//
// Reuses the fake-DOM harness pattern from extract.test.ts / extract-t45.test.ts
// (FakeElement / FakeHTMLCollection / runExtract), extended here with the one
// selector shape the older harnesses never needed: a `:not(...)` clause
// (extract.js's INTERACTIVE_SELECTOR uses `input:not([type=hidden])`).

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { EXTRACT_FILES } from "../../extension/content/extract-files.js";

// Lot F4: the content script is split across several files, injected
// together and in order, all sharing one global scope — see
// extract-files.js. Concatenate every file's declarations verbatim as
// EXTRACT_JS_DECLARATIONS; only the LAST file (content/extract.js) ends in
// a bare expression statement, handled as EXTRACT_JS_SOURCE below, same
// trick the single-file version used before the split.
const EXTRACT_JS_FILE_SOURCES = EXTRACT_FILES.map((f) =>
  readFileSync(join(import.meta.dir, "../../extension", f), "utf8"),
);
const EXTRACT_JS_DECLARATIONS = EXTRACT_JS_FILE_SOURCES.slice(0, -1).join("\n");
const EXTRACT_JS_SOURCE = EXTRACT_JS_FILE_SOURCES[EXTRACT_JS_FILE_SOURCES.length - 1];

type FakeRect = { top?: number; bottom?: number; left?: number; right?: number; width?: number; height?: number };
type FakeStyle = { position?: string; display?: string; visibility?: string };

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
  #checkVisibilityResult: boolean | undefined;

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
    } = {},
  ) {
    this.tagName = tag.toUpperCase();
    this.attrs = opts.attrs ?? {};
    this.#childArray = opts.children ?? [];
    for (const c of this.#childArray) c.#parent = this;
    this.children = new FakeHTMLCollection(this.#childArray);
    this._renderedText = opts.text ?? "";
    this.textContent = opts.textContent ?? opts.text ?? "";
    this.rect = opts.rect ?? { top: 0, left: 0, width: 100, height: 20, right: 100, bottom: 20 };
    this.style = opts.style ?? {};
    this.#checkVisibilityResult = opts.checkVisibilityResult;
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

  hasAttribute(name: string): boolean {
    return this.attrs[name] != null;
  }

  getBoundingClientRect(): FakeRect {
    return this.rect;
  }

  getClientRects(): FakeRect[] {
    return this.isHiddenByDisplayNone() ? [] : [this.rect];
  }

  checkVisibility(_opts?: unknown): boolean | undefined {
    return this.#checkVisibilityResult;
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

/** One simple clause, plus an optional trailing `:not(<clause>)` — the one
 * shape beyond the older harnesses' matcher that extract.js's
 * INTERACTIVE_SELECTOR needs (`input:not([type=hidden])`). */
function matchesSimple(el: FakeElement, simple: string): boolean {
  const trimmed = simple.trim();
  const notMatch = trimmed.match(/^(.*?):not\(([^)]*)\)$/);
  const base = notMatch ? notMatch[1] : trimmed;
  const negated = notMatch ? notMatch[2] : null;
  if (negated !== null && matchesSimple(el, negated)) return false;
  if (base === "*" || base === "") return true;
  // Quoted ([attr="value"]) AND unquoted ([attr=value], e.g. extract.js's
  // own `input:not([type=hidden])`) attribute-value clauses.
  const attrMatch = base.match(/^([a-zA-Z0-9-]*)\[([a-zA-Z-]+)(?:=(?:"([^"]*)"|'([^']*)'|([^\]"']*)))?\]$/);
  if (attrMatch) {
    const [, tag, attr, dq, sq, raw] = attrMatch;
    if (tag && el.tagName !== tag.toUpperCase()) return false;
    const value = el.getAttribute(attr!);
    if (value === null) return false;
    const expected = dq ?? sq ?? raw;
    if (expected !== undefined && value !== expected) return false;
    return true;
  }
  if (/^[a-zA-Z0-9-]+$/.test(base)) {
    return el.tagName === base.toUpperCase();
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
  maxElements?: number;
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
  const fakeWindow: Record<string, unknown> = { innerWidth: viewport.innerWidth, innerHeight: viewport.innerHeight };
  if (typeof opts.maxElements === "number") fakeWindow.__coatiMaxElements = opts.maxElements;
  const fakeGetComputedStyle = (el: FakeElement) => ({
    position: el.style?.position || "static",
    visibility: el.style?.visibility || "visible",
  });
  const asExpression = EXTRACT_JS_SOURCE.trim().replace(/;\s*$/, "");
  // eslint-disable-next-line no-new-func
  const factory = new Function(
    "document",
    "location",
    "window",
    "getComputedStyle",
    `"use strict";\n${EXTRACT_JS_DECLARATIONS}\nreturn (\n${asExpression}\n);`,
  );
  return factory(fakeDocument, fakeLocation, fakeWindow, fakeGetComputedStyle);
}

function button(label: string, opts: { rect?: FakeRect; attrs?: Record<string, string> } = {}): FakeElement {
  return new FakeElement("button", { text: label, rect: opts.rect, attrs: opts.attrs });
}

describe("extract.js — collectInteractiveElements (Lot A2, plan 08/10 §3A)", () => {
  test("numbers visible buttons/links e1, e2, … in document order", () => {
    const body = new FakeElement("body", {
      children: [button("Générer"), new FakeElement("a", { text: "En savoir plus", attrs: { href: "/x" } })],
    });
    const result = runExtract({ body });
    expect(result.elements).toEqual([
      { ref: "e1", role: "button", label: "Générer" },
      { ref: "e2", role: "link", label: "En savoir plus" },
    ]);
    expect(typeof result.extractionId).toBe("string");
    expect(result.extractionId.length).toBeGreaterThan(0);
  });

  test("a hidden element (display:none -> empty getClientRects) is excluded", () => {
    const body = new FakeElement("body", {
      children: [button("Visible"), button("Caché", { rect: { top: 0, left: 0, width: 0, height: 0 } })],
    });
    const result = runExtract({ body });
    expect(result.elements).toEqual([{ ref: "e1", role: "button", label: "Visible" }]);
  });

  test("an aria-hidden ancestor excludes its interactive descendants", () => {
    const hiddenWrap = new FakeElement("div", {
      attrs: { "aria-hidden": "true" },
      children: [button("Dans aria-hidden")],
    });
    const body = new FakeElement("body", { children: [hiddenWrap, button("Normal")] });
    const result = runExtract({ body });
    expect(result.elements).toEqual([{ ref: "e1", role: "button", label: "Normal" }]);
  });

  test("a password field is excluded even though it matches input:not([type=hidden])", () => {
    const pwd = new FakeElement("input", { attrs: { type: "password" }, text: "" });
    const email = new FakeElement("input", {
      attrs: { type: "text", "aria-label": "Adresse e-mail" },
      text: "",
    });
    const body = new FakeElement("body", { children: [pwd, email] });
    const result = runExtract({ body });
    expect(result.elements).toEqual([{ ref: "e1", role: "textbox", label: "Adresse e-mail" }]);
  });

  test("a field's typed value never becomes its label (placeholder wins instead)", () => {
    const input = new FakeElement("input", {
      attrs: { type: "text", placeholder: "Rechercher", value: "secret typed text" },
      text: "",
    });
    const body = new FakeElement("body", { children: [input] });
    const result = runExtract({ body });
    expect(result.elements).toEqual([{ ref: "e1", role: "textbox", label: "Rechercher" }]);
  });

  test("label precedence: visible text, then aria-label, then placeholder/title", () => {
    const withText = button("Texte visible", { attrs: { "aria-label": "ignoré" } });
    const ariaOnly = new FakeElement("button", { attrs: { "aria-label": "Via aria-label" }, text: "" });
    const placeholderOnly = new FakeElement("input", { attrs: { type: "text", placeholder: "Via placeholder" }, text: "" });
    const body = new FakeElement("body", { children: [withText, ariaOnly, placeholderOnly] });
    const result = runExtract({ body });
    expect(result.elements.map((e: any) => e.label)).toEqual(["Texte visible", "Via aria-label", "Via placeholder"]);
  });

  test("viewport-first ordering: an above-the-fold element is numbered before a below-the-fold one that comes first in the DOM", () => {
    const belowFold = button("Plus bas dans le code, mais hors écran", { rect: { top: 2000, left: 0, width: 80, height: 20, right: 80, bottom: 2020 } });
    const onScreen = button("Dans la fenêtre", { rect: { top: 100, left: 0, width: 80, height: 20, right: 80, bottom: 120 } });
    const body = new FakeElement("body", { children: [belowFold, onScreen] });
    const result = runExtract({ body, viewport: { innerWidth: 1024, innerHeight: 768 } });
    expect(result.elements.map((e: any) => e.label)).toEqual(["Dans la fenêtre", "Plus bas dans le code, mais hors écran"]);
    expect(result.elements[0].ref).toBe("e1");
  });

  test("caps at 120 by default", () => {
    const children = Array.from({ length: 150 }, (_, i) => button(`Bouton ${i}`));
    const body = new FakeElement("body", { children });
    const result = runExtract({ body });
    expect(result.elements.length).toBe(120);
    expect(result.elements[0].label).toBe("Bouton 0");
    expect(result.elements[119].label).toBe("Bouton 119");
  });

  test("the panel can tighten the cap to 40 via window.__coatiMaxElements (small Ollama context)", () => {
    const children = Array.from({ length: 150 }, (_, i) => button(`Bouton ${i}`));
    const body = new FakeElement("body", { children });
    const result = runExtract({ body, maxElements: 40 });
    expect(result.elements.length).toBe(40);
  });

  test("an out-of-range cap (negative, zero, > 120) falls back to the 120 default rather than widening it", () => {
    const children = Array.from({ length: 150 }, (_, i) => button(`Bouton ${i}`));
    const body = new FakeElement("body", { children });
    expect(runExtract({ body, maxElements: 0 }).elements.length).toBe(120);
    expect(runExtract({ body, maxElements: -5 }).elements.length).toBe(120);
    expect(runExtract({ body, maxElements: 999 }).elements.length).toBe(120);
  });

  test("role mapping covers the closed enum: select -> combobox, textarea -> textbox, checkbox input -> checkbox", () => {
    const select = new FakeElement("select", { text: "" });
    const textarea = new FakeElement("textarea", { text: "" });
    const checkbox = new FakeElement("input", { attrs: { type: "checkbox", "aria-label": "Accepter" }, text: "" });
    const body = new FakeElement("body", { children: [select, textarea, checkbox] });
    const roleLessBody = body; // selects/textareas have no visible text; give them a label via aria
    select.attrs["aria-label"] = "Choisir";
    textarea.attrs["aria-label"] = "Message";
    const result = runExtract({ body: roleLessBody });
    expect(result.elements.map((e: any) => e.role)).toEqual(["combobox", "textbox", "checkbox"]);
  });

  test("an explicit ARIA role in the closed enum wins over the tag's own default", () => {
    const el = new FakeElement("div", { attrs: { role: "switch", "aria-label": "Mode sombre" }, text: "" });
    const body = new FakeElement("body", { children: [el] });
    const result = runExtract({ body });
    // The fake harness's INTERACTIVE_SELECTOR match requires div[role="switch"]
    // to be reached: it is, via the explicit `[role="switch"]` clause.
    expect(result.elements).toEqual([{ ref: "e1", role: "switch", label: "Mode sombre" }]);
  });

  test("elementsFrameLimited is true only when the page has an <iframe>", () => {
    const withoutIframe = runExtract({ body: new FakeElement("body", { children: [button("x")] }) });
    expect(withoutIframe.elementsFrameLimited).toBe(false);
    const withIframe = runExtract({
      body: new FakeElement("body", { children: [button("x"), new FakeElement("iframe")] }),
    });
    expect(withIframe.elementsFrameLimited).toBe(true);
  });

  test("never throws: a broken querySelectorAll degrades to an empty elements array, extraction itself still succeeds", () => {
    const body = new FakeElement("body", { children: [button("x")] });
    const originalQSA = body.querySelectorAll.bind(body);
    (body as any).querySelectorAll = (selector: string) => {
      if (selector.includes("button")) throw new Error("boom");
      return originalQSA(selector);
    };
    const result = runExtract({ body });
    expect(result.kind).toBe("page");
    expect(result.elements).toEqual([]);
  });
});
