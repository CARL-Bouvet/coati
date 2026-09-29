// Unit tests for extension/content/extract.js. The file is an IIFE that runs
// against the real DOM (document/location) the moment it's evaluated — there
// is no jsdom/happy-dom dependency in this repo, and adding one just for this
// would be disproportionate to a MINEUR finding. Instead this builds a
// minimal fake DOM implementing exactly the calls extract.js makes
// (querySelectorAll/querySelector/closest/getElementsByTagName, a handful of
// simple-selector shapes), then `eval`s the script's source against fake
// `document`/`location` globals and reads its completion value — the same
// value chrome.scripting.executeScript would read in production.
//
// Kept intentionally narrow: it is NOT a general selector engine, only
// enough to drive the specific selector strings extract.js uses today. If
// extract.js starts using a selector shape this doesn't understand, matches()
// throws loudly rather than silently returning wrong results.

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const EXTRACT_JS_SOURCE = readFileSync(
  join(import.meta.dir, "../../extension/content/extract.js"),
  "utf8",
);

/** Minimal viewport-relative rect — same shape as a real DOMRect for the
 * subset extract.js reads (top/bottom/left/right/width/height). */
type FakeRect = { top?: number; bottom?: number; left?: number; right?: number; width?: number; height?: number };

// Real HTMLCollection: iterable, `.length`, `.item(i)`, index access — and
// crucially NO array methods (no map/filter/some/includes). extract.js's
// previous implementation called `.map`/`.filter` straight on `el.children`
// and passed all 64 tests here because `children` used to just be a plain
// array. It then died on every real page, because a real HTMLCollection
// throws on those calls. This class makes that class of bug fail loudly in
// tests again, the same way a browser would (2026-09-25 bis hardening).
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
  // Real DOM name. extract.js must use parentElement, never a harness-only
  // shortcut — `parent` is now a private field, unreachable from extraction
  // code, so this can't silently regress (fixed 2026-09-25 after a
  // real-browser probe found list/listing detection dead on every page while
  // this harness stayed green).
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
      /** Raw source text, when it must differ from the rendered `text`
       * (the display:none innerText trap below needs both). Defaults to
       * `text`. */
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

  /** Rendered text, as a real page's layout would produce it — private-ish
   * (not part of the DOM API surface being modeled); the public reads are
   * `.innerText` and the `.text` alias below. */
  _renderedText: string;

  /** Alias of `.innerText`, for fixture readability (`el.text`) — fixtures
   * across this file read/write it interchangeably. Delegates to the same
   * getter/setter so the display:none trap applies uniformly. */
  get text(): string {
    return this.innerText;
  }
  set text(value: string) {
    this._renderedText = value;
  }

  // THE TRAP (docs/PROTOCOL.md, correction n°4): "innerText d'un élément non
  // affiché (display: none) renvoie son textContent." A real display:none
  // subtree's innerText does NOT come back empty — it falls back to raw
  // textContent, hidden form widgets included. Modeling this faithfully is
  // what makes a test able to prove hidden content is excluded by an
  // explicit rendered-check, not by innerText happening to be empty.
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

  // "les éléments sans rectangle affiché (getClientRects().length === 0)"
  // — empty for a display:none subtree (no layout box at all), non-empty
  // (but still excluded elsewhere via the computed `visibility` check) for
  // visibility:hidden, which keeps its box.
  getClientRects(): FakeRect[] {
    return this.isHiddenByDisplayNone() ? [] : [this.rect];
  }

  /** Same semantics as the real DOM's Node.contains: true for the node
   * itself too, not just strict descendants. */
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

/** Parses one simple selector: optional tag name, optional single [attr] or
 * [attr="value"] clause. Exactly what extract.js's selector strings need. */
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

/** Runs extract.js's IIFE against a fake document/location/window and
 * returns its completion value, exactly like chrome.scripting.executeScript
 * would. `viewport` and `getComputedStyle` back the Amendement 2026-09-25
 * overlay-exclusion signals (position, coverage ratio, edge docking) — real
 * browsers provide both as ambient globals inside a content script, which is
 * why extract.js references them as bare identifiers rather than through
 * `document`. */
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
  // `visibility` is inherited in real CSS: the nearest ancestor with an
  // explicit declaration wins, defaulting to "visible" — modeled here since
  // FakeElement instances are separate objects with no CSSOM behind them.
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
  // extract.js's source is a single `(() => { ... })();` statement — strip
  // the trailing semicolon so it can be re-embedded as a `return (<expr>)`.
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

// ============================================================================
// Harness self-tests (2026-09-25 bis hardening). These test the FAKE DOM
// itself, not extract.js — they exist so a future change to this harness
// can't quietly reopen the class of bug that got past 64 green tests and
// then failed on every real page: harness-only APIs (`el.parent`, array
// methods on `.children`) and the innerText/display:none trap.
// ============================================================================

describe("harness — FakeElement models the real DOM traps, not a convenience shim", () => {
  test("`.children` has no array methods (a real HTMLCollection doesn't either)", () => {
    const child = new FakeElement("li", { text: "one" });
    const parent = new FakeElement("ul", { children: [child] });
    expect((parent.children as any).map).toBeUndefined();
    expect((parent.children as any).filter).toBeUndefined();
    expect((parent.children as any).some).toBeUndefined();
    expect((parent.children as any).includes).toBeUndefined();
  });

  test("`.children` is iterable, has `.length`, `.item()`, and index access", () => {
    const a = new FakeElement("li", { text: "a" });
    const b = new FakeElement("li", { text: "b" });
    const parent = new FakeElement("ul", { children: [a, b] });
    expect(parent.children.length).toBe(2);
    expect(parent.children.item(0)).toBe(a);
    expect(parent.children.item(2)).toBe(null);
    expect(parent.children[0]).toBe(a);
    expect(parent.children[1]).toBe(b);
    expect(Array.from(parent.children)).toEqual([a, b]);
  });

  test("`.parent` is not a public property; only `.parentElement` exists", () => {
    const child = new FakeElement("div", {});
    const parent = new FakeElement("div", { children: [child] });
    expect((child as any).parent).toBeUndefined();
    expect(child.parentElement).toBe(parent);
  });

  test("innerText of a display:none element returns its textContent (the real trap)", () => {
    const hidden = new FakeElement("div", {
      style: { display: "none" },
      text: "", // what a naive fixture might assume innerText renders as
      textContent: "Afghanistan : +93",
    });
    expect(hidden.innerText).toBe("Afghanistan : +93");
    expect(hidden.text).toBe("Afghanistan : +93");
    // ...which is exactly why extraction must check getClientRects()/
    // visibility explicitly, rather than trust innerText to be empty.
    expect(hidden.getClientRects().length).toBe(0);
  });

  test("a visibility:hidden element keeps its layout box (getClientRects) but is flagged via computed style", () => {
    const hidden = new FakeElement("div", {
      style: { visibility: "hidden" },
      text: "should never surface as a fact",
    });
    expect(hidden.getClientRects().length).toBe(1);
    // extract.js reads this through getComputedStyle(el).visibility, not
    // through a property on the element — asserted indirectly by the
    // fact-extraction tests below (piège n°4).
  });
});

describe("extract.js — density heuristic (unchanged behavior)", () => {
  test("a dense <article> wins outright", () => {
    const article = new FakeElement("article", { text: "x".repeat(250) });
    const body = new FakeElement("body", { children: [article] });
    const result = runExtract({ body });
    expect(result.kind).toBe("page");
    expect(result.text.length).toBe(250);
  });

  test("nav/footer/header/aside candidates are skipped even if dense", () => {
    const navDiv = new FakeElement("div", {
      children: [new FakeElement("nav", { children: [new FakeElement("div", { text: "y".repeat(500) })] })],
    });
    const goodDiv = new FakeElement("div", { text: "z".repeat(300) });
    const body = new FakeElement("body", { children: [navDiv, goodDiv] });
    const result = runExtract({ body });
    expect(result.text).toContain("zzz");
    expect(result.text).not.toContain("yyy");
  });
});

describe("extract.js — contenteditable exclusion (item 5)", () => {
  test("a draft in a nested [contenteditable] is stripped from an <article>'s text", () => {
    const draft = new FakeElement("div", {
      attrs: { contenteditable: "true" },
      text: "unsent draft comment",
    });
    const article = new FakeElement("article", {
      children: [draft],
      // innerText of a real browser DOM would include the nested draft's
      // rendered text — we set it explicitly here since our fake elements
      // don't compute layout. Padded past the 200-char density threshold so
      // the <article> wins outright via the semantic-container path.
      text: `Real article body. ${"r".repeat(220)} unsent draft comment More real body.`,
    });
    const body = new FakeElement("body", { children: [article] });
    const result = runExtract({ body });

    expect(result.text).toContain("Real article body.");
    expect(result.text).toContain("More real body.");
    expect(result.text).not.toContain("unsent draft comment");
  });

  test("a contenteditable candidate itself is skipped entirely in the density scan", () => {
    const editableDiv = new FakeElement("div", {
      attrs: { contenteditable: "true" },
      text: "w".repeat(500),
    });
    const goodDiv = new FakeElement("div", { text: "v".repeat(300) });
    const body = new FakeElement("body", { children: [editableDiv, goodDiv] });
    const result = runExtract({ body });
    expect(result.text).toContain("vvv");
    expect(result.text).not.toContain("www");
  });
});

// ============================================================================
// Amendement 2026-09-25 (types de page) — docs/PROTOCOL.md "Types de page,
// faits et entrées". Fixtures below model the traps measured on real pages
// (notes/corpus/observations.md) rather than idealized DOMs.
// ============================================================================

describe("extract.js — couches superposées (piège n°1 : bienici résultats)", () => {
  test("a Didomi-style consent dialog is excluded, the article underneath survives", () => {
    const acceptButton = new FakeElement("button", { text: "Tout accepter" });
    const didomi = new FakeElement("div", {
      attrs: { role: "dialog", "aria-modal": "true", id: "didomi-host" },
      children: [acceptButton],
      style: { position: "fixed" },
      rect: { top: 0, left: 0, width: 1024, height: 400, bottom: 400, right: 1024 },
      text:
        "Nous utilisons des cookies et des traceurs pour mesurer l'audience et partager des données avec nos partenaires. " +
        "Consultez notre politique de confidentialité (RGPD). ".repeat(6),
    });
    const article = new FakeElement("article", { text: "A".repeat(300) });
    // Convention of this fake DOM (see comments above): an element's `.text`
    // must be pre-aggregated by the fixture author, same as any other
    // element read directly — including document.body, which the new
    // 200-char fallback guard reads to size "the whole page after exclusion".
    const body = new FakeElement("body", { children: [didomi, article], text: `${didomi.text} ${article.text}` });

    const result = runExtract({ body });

    expect(result.text).toContain("AAAA");
    expect(result.text).not.toContain("cookies");
    expect(result.text).not.toContain("Tout accepter");
  });

  test("bienici's fixed #searchSideView IS the results list — not dropped by the fixed-position rule", () => {
    const entries = Array.from({ length: 7 }, (_, i) => {
      const heading = new FakeElement("h3", { text: `Maison ${i + 1}` });
      const link = new FakeElement("a", { attrs: { href: `/annonce/${i}` } });
      return new FakeElement("div", {
        children: [heading, link],
        // Padded past 500 cumulative chars (measured on bienici: 4 535)
        // so the whole container legitimately qualifies as a content layer
        // rather than tripping the 200-char fallback guard.
        text: `Maison ${i + 1}\n44000 Nantes\n${300000 + i * 1000} €\nProche du centre-ville, jardin, garage.`,
      });
    });
    const header = "Résultats de recherche : maison à vendre à Nantes.";
    const searchSideView = new FakeElement("div", {
      attrs: { id: "searchSideView" },
      children: entries,
      style: { position: "fixed" },
      rect: { top: 0, left: 0, width: 400, height: 900, bottom: 900, right: 400 },
      text: `${header}\n${entries.map((e) => e.text).join("\n")}`,
    });
    const body = new FakeElement("body", { children: [searchSideView], text: searchSideView.text });

    const result = runExtract({ body });

    expect(result.pageKind).toBe("list");
    expect(result.items).toBeDefined();
    expect(result.items!.length).toBe(7);
    expect(result.items![0].title).toBe("Maison 1");
    expect(result.items![0].price).toBe("300000 €");
    expect(result.items![0].location).toBe("44000 Nantes");
    // The links are read for their presence only — never their href, never sent.
    expect(JSON.stringify(result.items)).not.toContain("/annonce/");
    expect(result.text).toContain("Résultats de recherche");
    // Item text is not duplicated into the leftover `text`.
    expect(result.text).not.toContain("Maison 1");
  });
});

describe("extract.js — garde-fou des 200 caractères", () => {
  test("a page that's ENTIRELY the consent dialog cancels the exclusion and forces pageKind other", () => {
    const acceptButton = new FakeElement("button", { text: "Tout accepter" });
    const onlyDialog = new FakeElement("div", {
      attrs: { role: "dialog", "aria-modal": "true" },
      children: [acceptButton],
      style: { position: "fixed" },
      rect: { top: 0, left: 0, width: 1024, height: 768, bottom: 768, right: 1024 },
      text: "Nous utilisons des cookies et des traceurs. ".repeat(5),
    });
    const body = new FakeElement("body", { children: [onlyDialog], text: onlyDialog.text });

    const result = runExtract({ body });

    expect(result.pageKind).toBe("other");
    expect(result.facts).toBeUndefined();
    expect(result.items).toBeUndefined();
    // Comportement d'aujourd'hui : mieux vaut la bannière que rien du tout
    // quand elle est tout ce que la page contient.
    expect(result.text.length).toBeGreaterThan(0);
  });
});

describe("extract.js — une fiche avec une vraie carte de contact fixe (piège n°2)", () => {
  test("4 facts + a numeric value → pageKind listing; the small fixed contact card is read, not treated as a banner", () => {
    const factsList = new FakeElement("dl", {
      children: [
        new FakeElement("dt", { text: "Prix" }),
        new FakeElement("dd", { text: "250 000 €" }),
        new FakeElement("dt", { text: "Surface" }),
        new FakeElement("dd", { text: "90 m²" }),
        new FakeElement("dt", { text: "DPE" }),
        new FakeElement("dd", { text: "D" }),
        new FakeElement("dt", { text: "Pièces" }),
        new FakeElement("dd", { text: "5" }),
      ],
    });
    const description = new FakeElement("div", {
      text:
        "Belle maison familiale au calme, proche des commerces et des écoles. " +
        "Grand jardin arboré, garage, cuisine ouverte sur salon lumineux. ".repeat(4),
    });
    // Bienici trap #2: the fixed element on a fiche is the agency contact
    // card — small, no consent wording, must NOT be excluded.
    const contactCard = new FakeElement("div", {
      style: { position: "fixed" },
      rect: { top: 300, left: 800, width: 200, height: 150, bottom: 450, right: 1000 },
      text: "Agence Dupont — 02 40 00 00 00",
    });
    const h1 = new FakeElement("h1", { text: "Maison à Basse-Goulaine" });
    const body = new FakeElement("body", {
      children: [h1, factsList, description, contactCard],
      text: `${h1.text} ${description.text} ${contactCard.text}`,
    });

    const result = runExtract({ body });

    expect(result.pageKind).toBe("listing");
    expect(result.facts).toEqual([
      { label: "Prix", value: "250 000 €" },
      { label: "Surface", value: "90 m²" },
      { label: "DPE", value: "D" },
      { label: "Pièces", value: "5" },
    ]);
    // The main-region density heuristic (unchanged) picks the description,
    // not the small contact card — that's fine. What trap n°2 guards against
    // is the card being wrongly EXCLUDED as a banner and dragging something
    // else down with it; pageKind staying "listing" with all 4 facts intact
    // (asserted above) is the proof it wasn't.
    expect(result.text).toContain("Grand jardin");
  });
});

describe("extract.js — dl de menu de navigation (piège n°3 : MDN)", () => {
  test("a dt/dd pair whose dd is a list of links is not read as a fact", () => {
    const navDd = new FakeElement("dd", {
      children: [
        new FakeElement("a", { attrs: { href: "/en/docs/Web/HTML/Element/address" }, text: "<address>" }),
        new FakeElement("a", { attrs: { href: "/en/docs/Web/HTML/Element/article" }, text: "<article>" }),
        new FakeElement("a", { attrs: { href: "/en/docs/Web/HTML/Element/aside" }, text: "<aside>" }),
      ],
      // innerText of a real <dd> whose content is a <ul><li> of links renders
      // as one line per link (block boundaries) — modeled directly here.
      text: "<address>\n<article>\n<aside>",
    });
    const navDt = new FakeElement("dt", { text: "Sectioning root" });
    const navDl = new FakeElement("dl", { children: [navDt, navDd] });

    const mainContent = new FakeElement("main", { text: "M".repeat(1500) });
    const body = new FakeElement("body", { children: [navDl, mainContent], text: `Sectioning root ${mainContent.text}` });

    const result = runExtract({ body });

    expect(result.facts ?? []).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ label: "Sectioning root" })]),
    );
    expect(result.text).toContain("MMMM");
  });
});

describe("extract.js — un article SUR les cookies n'est pas effacé par la règle lexicale", () => {
  test("long article discussing cookies/RGPD, with an illustrative 'Tout accepter' button, survives (guard: >=1500 chars)", () => {
    const illustrativeButton = new FakeElement("button", { text: "Tout accepter" });
    const cookieArticle = new FakeElement("div", {
      children: [illustrativeButton],
      text:
        "Comment fonctionnent les cookies et le consentement RGPD : un guide complet pour les développeurs. ".repeat(20),
    });
    const body = new FakeElement("body", { children: [cookieArticle], text: cookieArticle.text });

    const result = runExtract({ body });

    expect(result.text).toContain("Comment fonctionnent les cookies");
    expect(result.text.length).toBeGreaterThan(1500);
  });

  test("a short cookie-policy blurb that contains the page's <h1> is not excluded either (guard: contains h1)", () => {
    const heading = new FakeElement("h1", { text: "Notre politique de cookies" });
    const acceptButton = new FakeElement("button", { text: "Accepter" });
    const policyBlock = new FakeElement("div", {
      children: [heading, acceptButton],
      text: "Notre politique de cookies et de vie privée, en bref, avec un bouton Accepter en exemple ci-dessous.",
    });
    const body = new FakeElement("body", { children: [policyBlock], text: policyBlock.text });

    const result = runExtract({ body });

    expect(result.text).toContain("politique de cookies");
  });
});

// ============================================================================
// Amendement 2026-09-25 bis — fixtures modelled on the MEASURED shapes from
// notes/corpus/apres/ (real Chromium probe), not idealized DOMs. The first
// implementation passed the fixtures above and still failed every one of
// these on real pages (notes/corpus/observations.md).
// ============================================================================

describe("extract.js — bienici résultats : liste à deux niveaux de profondeur (correction n°1, n°2, n°3)", () => {
  test("results container two levels above a promoted-ad main region, with an oversized entry and in-container facts", () => {
    // Correction n°1: `findMainRegion` picks the promoted ad first (it's the
    // first `article` past 200 chars) — not the results container itself.
    // Its immediate parent is a "box of 3" (too small to be a group of >=5);
    // the real container is two levels up.
    const factLine1 = new FakeElement("p", { text: "Taxe foncière : 1 301 euros" });
    const factLine2 = new FakeElement("p", { text: "Charges courantes par trimestre : 682 euros" });
    const factLine3 = new FakeElement("p", { text: "Année de référence des prix : 2021" });
    const factLine4 = new FakeElement("p", { text: "Prix de vente : 735 000 € TTC" });
    // A different tag than the 4 fact lines below (a "div", not a "p"): with
    // 5 same-shape leaf children, `promotedAd` would itself look like a
    // same-shape group of >=5 and hijack `findCandidateEntryGroup`'s
    // "own group" check before it ever walks up to the real container.
    const prose = new FakeElement("div", {
      text: "Très bel appartement au cœur du quartier, proche de toutes commodités. ".repeat(8),
    });
    const promotedLink = new FakeElement("a", { attrs: { href: "/annonce/promoted" } });
    // Correction n°2: this entry's OWN text (prose + 4 fact lines) exceeds
    // 1 000 chars — if it were ever treated as a list entry, it would have to
    // be skipped individually, not invalidate the whole group. Here it plays
    // the main-region role instead (see above), so this only matters for its
    // sheer size relative to the container's other children.
    const promotedAd = new FakeElement("article", {
      children: [prose, factLine1, factLine2, factLine3, factLine4, promotedLink],
      text: `${prose.text}\n${factLine1.text}\n${factLine2.text}\n${factLine3.text}\n${factLine4.text}`,
    });
    const otherBoxedAd = (n: number) =>
      new FakeElement("article", {
        children: [new FakeElement("a", { attrs: { href: `/annonce/boxed-${n}` } })],
        text: `Annonce mise en avant ${n}\n${300000 + n * 1000} €`,
      });
    // "encart de 3 annonces" — the promoted ad's actual parent, too small
    // (3 < 5) to be mistaken for the results list itself.
    const boxOf3 = new FakeElement("div", {
      attrs: { class: "highlighted-box" },
      children: [promotedAd, otherBoxedAd(1), otherBoxedAd(2)],
    });

    const regularAd = (i: number) => {
      const heading = new FakeElement("h3", { text: `Maison ${i}` });
      const link = new FakeElement("a", { attrs: { href: `/annonce/${i}` } });
      return new FakeElement("article", {
        children: [heading, link],
        text: `Maison ${i}\nNantes (44)\n${250000 + i * 1000} €\nProche du centre-ville, jardin.`,
      });
    };
    const regularAds = Array.from({ length: 24 }, (_, i) => regularAd(i + 1));

    // "search-results-list" — two levels above `promotedAd`, 25 children
    // (the box + 24 same-shape ARTICLEs), exactly the measured shape.
    const resultsContainer = new FakeElement("div", {
      attrs: { id: "search-results-list" },
      children: [boxOf3, ...regularAds],
    });
    const body = new FakeElement("body", { children: [resultsContainer] });

    const result = runExtract({ body });

    expect(result.pageKind).toBe("list");
    expect(result.items).toBeDefined();
    // Correction n°3: the 4 "libellé : valeur" lines inside the promoted ad
    // (INSIDE the results container, outside any single regular entry) must
    // not be read as a facts block that disqualifies the list — they are
    // judged against the container, not the entries.
    expect(result.items!.length).toBe(24);
    expect(result.items![0].title).toBe("Maison 1");
    expect(result.items![0].price).toBe("251000 €");
    expect(result.items![0].location).toBe("Nantes (44)");
    expect(JSON.stringify(result.items)).not.toContain("/annonce/");
  });
});

describe("extract.js — formulaire caché (correction n°4 : piège du DOM sur la fiche bienici)", () => {
  test("a hidden country-code dropdown and validation messages inside a <form> yield ZERO facts", () => {
    const realFacts = new FakeElement("dl", {
      children: [
        new FakeElement("dt", { text: "Prix" }),
        new FakeElement("dd", { text: "265 000 €" }),
        new FakeElement("dt", { text: "Surface" }),
        new FakeElement("dd", { text: "30 m²" }),
        new FakeElement("dt", { text: "DPE" }),
        new FakeElement("dd", { text: "D" }),
        new FakeElement("dt", { text: "Pièces" }),
        new FakeElement("dd", { text: "2" }),
      ],
    });
    const description = new FakeElement("div", {
      text: "Bel appartement lumineux avec vue dégagée, proche des transports et commerces. ".repeat(4),
    });

    // The country-code dropdown: hidden (display:none), but real innerText
    // would still surface its textContent (the trap) — each entry rendered
    // as its own "libellé : valeur"-shaped leaf, exactly the measured shape.
    const countryEntry = (country: string, code: string) => new FakeElement("li", { text: `${country} : ${code}` });
    const countryList = new FakeElement("ul", {
      style: { display: "none" },
      children: [
        countryEntry("France", "+33"),
        countryEntry("Afghanistan", "+93"),
        countryEntry("Albania", "+355"),
        countryEntry("Algeria", "+213"),
        countryEntry("Andorra", "+376"),
      ],
    });
    // Validation messages: visible in the DOM sense but semantically part of
    // the form, never a fact about the listing.
    const validationMsg = new FakeElement("span", { text: "Ce champ est obligatoire : email invalide" });
    const contactForm = new FakeElement("form", {
      attrs: { id: "contact-form" },
      children: [countryList, validationMsg],
    });

    const h1 = new FakeElement("h1", { text: "Appartement 2 pièces, Paris 15e" });
    const body = new FakeElement("body", { children: [h1, realFacts, description, contactForm] });

    const result = runExtract({ body });

    expect(result.pageKind).toBe("listing");
    expect(result.facts).toEqual([
      { label: "Prix", value: "265 000 €" },
      { label: "Surface", value: "30 m²" },
      { label: "DPE", value: "D" },
      { label: "Pièces", value: "2" },
    ]);
    const dump = JSON.stringify(result.facts);
    expect(dump).not.toContain("Afghanistan");
    expect(dump).not.toContain("+33");
    expect(dump).not.toContain("obligatoire");
  });

  test("a visibility:hidden fact-shaped line (box kept, not painted) is also excluded", () => {
    const realFacts = new FakeElement("dl", {
      children: [
        new FakeElement("dt", { text: "Prix" }),
        new FakeElement("dd", { text: "265 000 €" }),
        new FakeElement("dt", { text: "Surface" }),
        new FakeElement("dd", { text: "30 m²" }),
        new FakeElement("dt", { text: "DPE" }),
        new FakeElement("dd", { text: "D" }),
        new FakeElement("dt", { text: "Pièces" }),
        new FakeElement("dd", { text: "2" }),
      ],
    });
    const description = new FakeElement("div", {
      text: "Bel appartement lumineux avec vue dégagée, proche des transports et commerces. ".repeat(4),
    });
    // NOT inside a form, NOT display:none (so getClientRects() > 0) — only
    // caught by the separate computed-style visibility check.
    const ghostFact = new FakeElement("p", {
      style: { visibility: "hidden" },
      text: "Ancien prix : 300 000 €",
    });
    const body = new FakeElement("body", { children: [realFacts, description, ghostFact] });

    const result = runExtract({ body });

    expect(result.pageKind).toBe("listing");
    expect(JSON.stringify(result.facts)).not.toContain("Ancien prix");
  });
});

describe("extract.js — infobox Wikipédia (rappel « valeur chiffrée » : jamais un nombre seul)", () => {
  test("a taxonomy infobox (4+ facts, no currency/unit) with '21 langues' near the <h1> stays 'article'", () => {
    const h1 = new FakeElement("h1", { text: "Coati" });
    // "21 langues" sits right above the h1 in the real page — modeled here
    // as a sibling line one level up, exactly the shape hasChiefNumericFact
    // now walks (and must NOT treat as a valeur chiffrée: no unit, no currency).
    const languageCount = new FakeElement("div", { text: "21 langues" });
    const heading = new FakeElement("div", {
      children: [languageCount, h1],
      text: `${languageCount.text}\n${h1.text}`,
    });

    const infobox = new FakeElement("dl", {
      children: [
        new FakeElement("dt", { text: "Règne" }),
        new FakeElement("dd", { text: "Animalia" }),
        new FakeElement("dt", { text: "Embranchement" }),
        new FakeElement("dd", { text: "Chordata" }),
        new FakeElement("dt", { text: "Classe" }),
        new FakeElement("dd", { text: "Mammalia" }),
        new FakeElement("dt", { text: "Ordre" }),
        new FakeElement("dd", { text: "Carnivora" }),
      ],
    });
    // A bibliography section, same shape as the one that tripped the old
    // regex ("2007, p. 1076") — must not resurrect a numeric match either.
    const references = new FakeElement("p", {
      text: "Klaus-Peter Koepfli et al., Phylogeny of the Procyonidae, Molecular Phylogenetics and Evolution, vol. 43, juin 2007, p. 1076–1095.",
    });
    const article = new FakeElement("article", {
      children: [heading, infobox, references],
      text: `${languageCount.text}\n${h1.text}\n${"Les coatis sont des mammifères d'Amérique du Sud et centrale. ".repeat(30)}\n${references.text}`,
    });
    const body = new FakeElement("body", { children: [article] });

    const result = runExtract({ body });

    expect(result.pageKind).toBe("article");
    expect(result.facts).toBeUndefined();
    expect(result.items).toBeUndefined();
  });
});

// Ported from the now-deleted broker/test/detect.test.ts (item 1, KISS audit
// 2026-09-26): detect.js's copy of hasNumericValue was unused in production
// (extract.js's own copy is what actually runs), but these edge cases guard
// the regex behind hasChiefNumericFact and were not otherwise covered here.
describe("extract.js — hasNumericValue edge cases via facts (ported from detect.test.ts)", () => {
  test("a real-estate abbreviation ('T3 - 65m² - 3 p.') is a chief numeric fact → listing", () => {
    const factsList = new FakeElement("dl", {
      children: [
        new FakeElement("dt", { text: "Type" }),
        new FakeElement("dd", { text: "T3 - 65m² - 3 p." }),
        new FakeElement("dt", { text: "Ville" }),
        new FakeElement("dd", { text: "Nantes" }),
        new FakeElement("dt", { text: "DPE" }),
        new FakeElement("dd", { text: "D" }),
        new FakeElement("dt", { text: "Étage" }),
        new FakeElement("dd", { text: "2e" }),
      ],
    });
    const description = new FakeElement("div", {
      text: "Bel appartement lumineux proche du centre-ville et des commerces. ".repeat(6),
    });
    const body = new FakeElement("body", { children: [factsList, description] });

    const result = runExtract({ body });

    expect(result.pageKind).toBe("listing");
  });

  test("bare-number-adjacent facts ('12 collections', '4.7 –0 Ma', a bibliography page range) never trigger listing", () => {
    const factsList = new FakeElement("dl", {
      children: [
        new FakeElement("dt", { text: "Collections" }),
        new FakeElement("dd", { text: "12 collections" }),
        new FakeElement("dt", { text: "Âge" }),
        new FakeElement("dd", { text: "4.7 –0 Ma" }),
        new FakeElement("dt", { text: "Référence" }),
        new FakeElement("dd", { text: "2013, p. 1–83" }),
        new FakeElement("dt", { text: "Type" }),
        new FakeElement("dd", { text: "Article" }),
      ],
    });
    const body = new FakeElement("body", { children: [factsList] });

    const result = runExtract({ body });

    expect(result.pageKind).not.toBe("listing");
  });
});
