// Regression test for security review 2026-09-26, finding #1: extract.js's
// own comment (~35-41) promises a [contenteditable] draft is never sent —
// but before this fix, that promise only held for the density-heuristic
// article/main text path. The four fact-shape readers (dl, two-cell <tr>,
// adjacent pairs, "label : value" lines) and titleForEntry() read a
// label/value cell's rendered text directly, without checking whether that
// cell itself contains an editable draft nested inside an otherwise ordinary
// container — a listing page with e.g. <tr><th>Message</th><td><div
// contenteditable>draft</div></td></tr> could leak the draft as a "fact".
//
// Harness: identical approach to extract.test.ts (readFileSync + IIFE
// against a fake DOM) — duplicated rather than imported so this file stays
// readable standalone and the fake DOM is never made more permissive than
// extract.test.ts's own copy.

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const EXTRACT_JS_SOURCE = readFileSync(
  join(import.meta.dir, "../../extension/content/extract.js"),
  "utf8",
);

type FakeRect = { top?: number; bottom?: number; left?: number; right?: number; width?: number; height?: number };

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
  style: { position?: string; display?: string; visibility?: string };

  constructor(
    tag: string,
    opts: {
      attrs?: Record<string, string>;
      children?: FakeElement[];
      text?: string;
      textContent?: string;
      rect?: FakeRect;
      style?: { position?: string; display?: string; visibility?: string };
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
  }

  _renderedText: string;
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
  function computedVisibility(el: FakeElement): string {
    let cur: FakeElement | null = el;
    while (cur) {
      if (cur.style?.visibility) return cur.style.visibility;
      cur = cur.parentElement;
    }
    return "visible";
  }
  const fakeGetComputedStyle = (el: FakeElement) => ({
    position: el.style?.position || "static",
    visibility: computedVisibility(el),
  });
  const asExpression = EXTRACT_JS_SOURCE.trim().replace(/;\s*$/, "");
  // eslint-disable-next-line no-new-func
  const factory = new Function(
    "document",
    "location",
    "window",
    "getComputedStyle",
    `"use strict";\nreturn (\n${asExpression}\n);`,
  );
  return factory(fakeDocument, fakeLocation, fakeWindow, fakeGetComputedStyle);
}

describe("extract.js — an editable draft never surfaces as a fact/title (security review, finding #1)", () => {
  test("a two-cell <tr> whose value cell contains a [contenteditable] draft is dropped, siblings kept", () => {
    const draftRow = new FakeElement("tr", {
      children: [
        new FakeElement("th", { text: "Message" }),
        new FakeElement("td", {
          children: [new FakeElement("div", { attrs: { contenteditable: "true" }, text: "draft" })],
          text: "draft",
        }),
      ],
    });
    const priceRow = new FakeElement("tr", {
      children: [new FakeElement("th", { text: "Prix" }), new FakeElement("td", { text: "265 000 €" })],
    });
    const surfaceRow = new FakeElement("tr", {
      children: [new FakeElement("th", { text: "Surface" }), new FakeElement("td", { text: "30 m²" })],
    });
    const dpeRow = new FakeElement("tr", {
      children: [new FakeElement("th", { text: "DPE" }), new FakeElement("td", { text: "D" })],
    });
    const roomsRow = new FakeElement("tr", {
      children: [new FakeElement("th", { text: "Pièces" }), new FakeElement("td", { text: "2" })],
    });
    const table = new FakeElement("table", {
      children: [draftRow, priceRow, surfaceRow, dpeRow, roomsRow],
    });
    const description = new FakeElement("div", {
      text: "Bel appartement lumineux avec vue dégagée, proche des transports et commerces. ".repeat(4),
    });
    const body = new FakeElement("body", { children: [table, description] });

    const result = runExtract({ body });

    expect(result.pageKind).toBe("listing");
    const dump = JSON.stringify(result.facts);
    expect(dump).not.toContain("draft");
    expect(dump).toContain("265 000 €");
    expect(dump).toContain("30 m²");
  });

  test("a <dl> whose <dd> contains a [contenteditable] draft yields no fact for that pair, others kept", () => {
    const editableDd = new FakeElement("dd", {
      children: [new FakeElement("div", { attrs: { contenteditable: "true" }, text: "draft reply" })],
      text: "draft reply",
    });
    const dl = new FakeElement("dl", {
      children: [
        new FakeElement("dt", { text: "Prix" }),
        new FakeElement("dd", { text: "265 000 €" }),
        new FakeElement("dt", { text: "Surface" }),
        new FakeElement("dd", { text: "30 m²" }),
        new FakeElement("dt", { text: "DPE" }),
        new FakeElement("dd", { text: "D" }),
        new FakeElement("dt", { text: "Pièces" }),
        new FakeElement("dd", { text: "2" }),
        new FakeElement("dt", { text: "Brouillon" }),
        editableDd,
      ],
    });
    const description = new FakeElement("div", {
      text: "Bel appartement lumineux avec vue dégagée, proche des transports et commerces. ".repeat(4),
    });
    const body = new FakeElement("body", { children: [dl, description] });

    const result = runExtract({ body });

    expect(result.pageKind).toBe("listing");
    const dump = JSON.stringify(result.facts);
    expect(dump).not.toContain("draft reply");
    expect(dump).not.toContain("Brouillon");
    expect(dump).toContain("265 000 €");
    expect(dump).toContain("30 m²");
  });

  test("an adjacent label/value pair whose value is editable is dropped, sibling pairs kept", () => {
    const pair = (label: string, value: string) =>
      new FakeElement("div", {
        children: [new FakeElement("span", { text: label }), new FakeElement("span", { text: value })],
      });
    const editablePair = new FakeElement("div", {
      children: [
        new FakeElement("span", { text: "Note" }),
        new FakeElement("span", {
          children: [new FakeElement("div", { attrs: { contenteditable: "true" }, text: "draft note" })],
          text: "draft note",
        }),
      ],
    });
    const grid = new FakeElement("div", {
      children: [
        pair("Prix", "265 000 €"),
        pair("Surface", "30 m²"),
        pair("DPE", "D"),
        pair("Pièces", "2"),
        editablePair,
      ],
    });
    const description = new FakeElement("div", {
      text: "Bel appartement lumineux avec vue dégagée, proche des transports et commerces. ".repeat(4),
    });
    const body = new FakeElement("body", { children: [grid, description] });

    const result = runExtract({ body });

    expect(result.pageKind).toBe("listing");
    const dump = JSON.stringify(result.facts);
    expect(dump).not.toContain("draft note");
    expect(dump).toContain("265 000 €");
    expect(dump).toContain("30 m²");
  });

  test("a list entry whose heading contains an editable node never surfaces the draft as its title", () => {
    const regularAd = (i: number) => {
      const heading = new FakeElement("h3", { text: `Maison ${i}` });
      const link = new FakeElement("a", { attrs: { href: `/annonce/${i}` } });
      return new FakeElement("article", {
        children: [heading, link],
        text: `Maison ${i}\nNantes (44)\n${250000 + i * 1000} €\nProche du centre-ville, jardin.`,
      });
    };
    const draftHeading = new FakeElement("h3", {
      children: [new FakeElement("div", { attrs: { contenteditable: "true" }, text: "draft" })],
      text: "draft",
    });
    const draftLink = new FakeElement("a", { attrs: { href: "/annonce/draft" } });
    const draftEntry = new FakeElement("article", {
      children: [draftHeading, draftLink],
      text: "draft\nNantes (44)\n260000 €\nProche du centre-ville, jardin.",
    });

    const regularAds = Array.from({ length: 23 }, (_, i) => regularAd(i + 1));
    const resultsContainer = new FakeElement("div", {
      attrs: { id: "search-results-list" },
      children: [...regularAds, draftEntry],
    });
    const body = new FakeElement("body", { children: [resultsContainer] });

    const result = runExtract({ body });

    expect(result.pageKind).toBe("list");
    expect(result.items).toBeDefined();
    expect(result.items!.length).toBe(24);
    const dump = JSON.stringify(result.items);
    expect(dump).not.toContain('"title":"draft"');
    expect(dump).not.toContain('"title": "draft"');
    for (const item of result.items!) {
      expect(item.title).not.toBe("draft");
    }
    expect(result.items!.some((it: any) => it.title === "Maison 1")).toBe(true);
  });
});
