// Unit tests for docs/PROTOCOL.md "Amendement 2026-09-25 (ter), après une
// deuxième sonde sur les vraies pages" — rules 5-9 (line ~655-676), which
// replace/override the (bis) rules from the same section where they differ.
// Only scripts/corpus-probe.ts covered these before this file existed.
//
// Reuses the fake-DOM harness pattern from extract.test.ts (FakeElement /
// FakeHTMLCollection / runExtract) rather than importing it (that file
// doesn't export it) — kept deliberately narrow, same selector subset.
//
// Rule -> PROTOCOL line -> implementing code (extension/content/extract.js):
//   5. only a dialog is a strong structural signal; fixed/sticky is always
//      weak, excluded only with lexical confirmation AND <1500 chars.
//        PROTOCOL.md:655-661 -> extract.js:317-326 (hasStrongStructuralSignal,
//        hasWeakStructuralSignal), extract.js:348-355 (shouldExcludeLayer)
//   6. main region never inside a form, nor inside a fixed/sticky element
//      carrying less than half the page's text.
//        PROTOCOL.md:662-666 -> extract.js:478-533 (FIXED_SIDEBAR_MAX_SHARE,
//        isInsideFixedOrSticky, findMainRegion)
//   7. climbing to the list container goes up to twelve levels, not six.
//        PROTOCOL.md:667-669 -> extract.js:260 (MAX_ANCESTOR_LEVELS),
//        extract.js:569-591 (findCandidateEntryGroup)
//   8. narrowed consent lexicon: "partenaires" and "Paramétrer" removed.
//        PROTOCOL.md:670-672 -> extract.js:219-241 (CONSENT_LEXICON,
//        CONSENT_CONTROL_WORDS) -- NOTE: extract.js already reflects this;
//        the STALE copy is extension/content/detect.js (dead code for
//        pageKind at runtime, see bug report below), not extract.js.
//   9. a label with '?'/'!', or a value ending in '!', is not a fact.
//        PROTOCOL.md:673-676 -> extract.js:824-827 (capFacts)
//
// Mutation proof: see notes/BUG or the mission report for the one-shot bash
// commands used (backup -> edit -> test -> restore via trap), not stored
// here — this file only holds the passing fixtures.

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
  _renderedText: string;

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

// ============================================================================
// Rule 5 (PROTOCOL.md:655-661) — "Seul un dialogue est un signal structurel
// fort." A fixed/sticky element, even past 30% viewport coverage, is only a
// WEAK signal: excluded only with lexical confirmation AND <1500 chars.
// ============================================================================

describe("extract.js — rule 5 (ter): fixed/sticky at high coverage is a weak signal, not strong", () => {
  test("a long fixed panel (>=1500 chars, >=30% viewport) with an incidental consent word+button survives", () => {
    // Real shape measured on bienici (PROTOCOL.md:661): 4 535 chars of
    // legitimate results content, in a fixed panel, mentioning "partenaires"
    // and "Paramétrer" — narrowed out of the lexicon by rule 8, but even
    // with a genuine lexicon word ("cookies") + control word ("Accepter")
    // present, rule 5 says a panel this long is never excluded on fixed-ness
    // alone: only a `role="dialog"` is a strong-enough signal for that.
    const acceptButton = new FakeElement("button", { text: "Accepter" });
    const longProse =
      "Cette section liste nos résultats de recherche avec le détail de chaque annonce. ".repeat(20) +
      "Nous utilisons des cookies techniques pour la recherche. ";
    const fixedPanel = new FakeElement("div", {
      attrs: { id: "searchSideView" },
      children: [acceptButton],
      style: { position: "fixed" },
      // 1024x300 / 1024x768 viewport = 0.39 >= OVERLAY_COVERAGE_THRESHOLD (0.3)
      rect: { top: 0, left: 0, width: 1024, height: 300, bottom: 300, right: 1024 },
      text: longProse,
    });
    expect(fixedPanel.text.length).toBeGreaterThanOrEqual(1500);
    // A second, much lower-density candidate: if `fixedPanel` were wrongly
    // excluded, this would become the elected main region instead, and its
    // own text (not the panel's) would be all that `result.text` contains —
    // that's what makes this fixture prove the point rather than merely
    // triggering the "exclusion too aggressive" 200-char guard (which would
    // fall back to the whole page and mask the bug either way).
    const otherDiv = new FakeElement("div", {
      text: "Filtre de recherche actif : maison, trois pièces, avec jardin, secteur centre-ville. ".repeat(3),
    });
    expect(otherDiv.text.length).toBeGreaterThanOrEqual(200);
    const body = new FakeElement("body", {
      children: [fixedPanel, otherDiv],
      text: `${fixedPanel.text} ${otherDiv.text}`,
    });

    const result = runExtract({ body });

    // Kept: the panel's content is not thrown away as a banner, and wins the
    // main-region density race over `otherDiv`.
    expect(result.text).toContain("résultats de recherche");
  });

  test("a short fixed banner (<1500 chars, >=30% viewport) WITH lexical confirmation is excluded", () => {
    // Contrast case: same coverage/position, but short and squarely a
    // banner — still excluded, because rule 5's exemption is for length,
    // not for fixed-ness.
    const acceptButton = new FakeElement("button", { text: "Accepter" });
    const bannerText = "Nous utilisons des cookies et des traceurs pour mesurer l'audience. ".repeat(3);
    expect(bannerText.length).toBeLessThan(1500);
    const fixedBanner = new FakeElement("div", {
      children: [acceptButton],
      style: { position: "fixed" },
      rect: { top: 0, left: 0, width: 1024, height: 300, bottom: 300, right: 1024 },
      text: bannerText,
    });
    const article = new FakeElement("article", { text: "A".repeat(300) });
    const body = new FakeElement("body", {
      children: [fixedBanner, article],
      text: `${fixedBanner.text} ${article.text}`,
    });

    const result = runExtract({ body });

    expect(result.text).toContain("AAAA");
    expect(result.text).not.toContain("cookies");
  });
});

// ============================================================================
// Rule 6 (PROTOCOL.md:662-666) — the main region is never inside a form, nor
// inside a fixed/sticky element that carries less than half the page's text
// (a sidebar); a fixed element that carries half or more IS the page's main
// surface.
// ============================================================================

describe("extract.js — rule 6 (ter): fixed/sticky sidebar share threshold", () => {
  test("a fixed element carrying LESS than half the page's text is excluded as a main-region candidate", () => {
    const fixedSidebar = new FakeElement("div", {
      style: { position: "fixed" },
      text: "Carte de contact agence. Numéro de téléphone : 02 40 00 00 00. Horaires d'ouverture affichés ici.",
    });
    const mainDiv = new FakeElement("div", {
      text: "Grand article descriptif sur le bien immobilier avec de nombreux détails supplémentaires utiles. ".repeat(4),
    });
    // Sidebar much shorter than the rest: well under 50% of body text.
    expect(fixedSidebar.text.length).toBeLessThan(mainDiv.text.length);
    const body = new FakeElement("body", {
      children: [fixedSidebar, mainDiv],
      text: `${fixedSidebar.text} ${mainDiv.text}`,
    });

    const result = runExtract({ body });

    expect(result.text).toContain("Grand article descriptif");
    expect(result.text).not.toContain("Carte de contact agence");
  });

  test("a fixed element carrying HALF OR MORE of the page's text IS the main region", () => {
    const fixedMain = new FakeElement("div", {
      attrs: { id: "searchSideView" },
      style: { position: "fixed" },
      text: "Résultats de recherche : liste complète des annonces disponibles dans le secteur choisi par l'utilisateur. ".repeat(3),
    });
    // A second, real (>=200 chars) candidate: if `fixedMain` were wrongly
    // excluded as a candidate (old bis rule: "never in a fixed element,
    // full stop"), this div — not `document.body`'s whole-page fallback —
    // would be elected instead, and its own distinct phrase would be all
    // `result.text` contains.
    const decoyDiv = new FakeElement("div", {
      text: "Filtre de recherche actif sur le secteur, avec trois pièces minimum et un jardin exigé par lutilisateur. ".repeat(2),
    });
    expect(decoyDiv.text.length).toBeGreaterThanOrEqual(200);
    // fixedMain still carries clearly more than half of the body's total text.
    expect(fixedMain.text.length).toBeGreaterThan(decoyDiv.text.length);
    const body = new FakeElement("body", {
      children: [fixedMain, decoyDiv],
      text: `${fixedMain.text} ${decoyDiv.text}`,
    });

    const result = runExtract({ body });

    expect(result.text).toContain("Résultats de recherche");
    expect(result.text).not.toContain("Filtre de recherche actif");
  });
});

// ============================================================================
// Rule 7 (PROTOCOL.md:667-669) — climbing to the list container's ancestor
// goes up to TWELVE levels, not six.
// ============================================================================

describe("extract.js — rule 7 (ter): ancestor climb for the list container goes up to 12 levels", () => {
  test("a results container 8 levels above the elected main region is still found", () => {
    // mainRegionEl: a dense leaf (no children -> highest density, only
    // candidate >= 200 chars since every wrapper below is left textless).
    const mainRegionEl = new FakeElement("div", {
      text: "Description détaillée de l'annonce mise en avant avec un texte assez long pour dépasser le seuil. ".repeat(3),
    });
    expect(mainRegionEl.text.length).toBeGreaterThanOrEqual(200);

    // 7 single-child wrapper divs between mainRegionEl and the results
    // container: mainRegionEl's parent is level 0, ..., the 7th wrapper's
    // parent (the container) is level 7 -- past the (bis) 6-level cap,
    // within the (ter) 12-level cap.
    let node: FakeElement = mainRegionEl;
    for (let i = 0; i < 7; i += 1) {
      node = new FakeElement("div", { children: [node] });
    }

    const entry = (i: number) =>
      new FakeElement("article", {
        children: [new FakeElement("h3", { text: `Maison ${i}` }), new FakeElement("a", { attrs: { href: `/annonce/${i}` } })],
        text: `Maison ${i}\nNantes (44)\n${250000 + i * 1000} €\nProche du centre-ville.`,
      });
    const entries = Array.from({ length: 6 }, (_, i) => entry(i + 1));

    const container = new FakeElement("div", {
      attrs: { id: "deep-results" },
      children: [node, ...entries],
    });
    const body = new FakeElement("body", { children: [container] });

    const result = runExtract({ body });

    expect(result.pageKind).toBe("list");
    expect(result.items).toBeDefined();
    expect(result.items!.length).toBe(6);
    expect(result.items![0].title).toBe("Maison 1");
  });
});

// ============================================================================
// Rule 8 (PROTOCOL.md:670-672) — narrowed consent lexicon: "partenaires" and
// "Paramétrer" removed (too common on an ordinary page). extract.js already
// reflects this (CONSENT_LEXICON / CONSENT_CONTROL_WORDS, extract.js:219-241);
// the stale duplicate is in extension/content/detect.js (reported separately,
// see mission report -- it is dead code for pageKind at runtime, only
// classifyPageType()/classifyPageTypeFromMetadata() from that file are used
// in production, per extension/panel/panel.js).
// ============================================================================

describe("extract.js — rule 8 (ter): 'partenaires' and 'Paramétrer' no longer trigger consent exclusion", () => {
  test("a fact-bearing block that merely says 'partenaires' / 'Paramétrer' is NOT treated as a consent layer", () => {
    const piecesFact = new FakeElement("div", { text: "Pièces : 5" });
    const partnersProse = new FakeElement("p", {
      text: "Nos partenaires locaux proposent des réductions ce mois-ci sur les visites.",
    });
    const partnersButton = new FakeElement("button", { text: "Paramétrer" });
    const sidePanel = new FakeElement("div", {
      children: [piecesFact, partnersProse, partnersButton],
      text: `${piecesFact.text} ${partnersProse.text} ${partnersButton.text}`,
    });

    const h1 = new FakeElement("h1", { text: "Maison à Basse-Goulaine" });
    const factsList = new FakeElement("dl", {
      children: [
        new FakeElement("dt", { text: "Prix" }),
        new FakeElement("dd", { text: "250 000 €" }),
        new FakeElement("dt", { text: "Surface" }),
        new FakeElement("dd", { text: "90 m²" }),
        new FakeElement("dt", { text: "DPE" }),
        new FakeElement("dd", { text: "D" }),
      ],
    });
    const body = new FakeElement("body", { children: [h1, factsList, sidePanel] });

    const result = runExtract({ body });

    // 3 facts from the <dl> + "Pièces: 5" from sidePanel = 4 -> listing.
    // If sidePanel were wrongly excluded as a consent layer (bis lexicon),
    // only 3 facts would remain and pageKind would not be "listing".
    expect(result.pageKind).toBe("listing");
    expect(result.facts).toEqual(
      expect.arrayContaining([{ label: "Pièces", value: "5" }]),
    );
  });
});

// ============================================================================
// Rule 9 (PROTOCOL.md:673-676) — a question or an exclamation is not a fact:
// a label containing '?' or '!', or a value ending in '!', is an ad insert.
// ============================================================================

describe("extract.js — rule 9 (ter): a question/exclamation is not a fact", () => {
  test("a two-cell row shaped like an ad ('Besoin de déménager ?' / 'Comparez ! ') is dropped", () => {
    // Uses the two-cell-row fact source (not the label-value-line source,
    // whose own regex already forbids '?'/'!' in the label) to prove the
    // rule 9 filter in capFacts() applies across every fact shape, not just
    // one extractor.
    const adRow = new FakeElement("tr", {
      children: [
        new FakeElement("th", { text: "Besoin de déménager ?" }),
        new FakeElement("td", { text: "Comparez les déménageurs !" }),
      ],
    });
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
    const table = new FakeElement("table", { children: [adRow] });
    const h1 = new FakeElement("h1", { text: "Maison à Basse-Goulaine" });
    const body = new FakeElement("body", { children: [h1, factsList, table] });

    const result = runExtract({ body });

    expect(result.pageKind).toBe("listing");
    expect(result.facts).toEqual([
      { label: "Prix", value: "250 000 €" },
      { label: "Surface", value: "90 m²" },
      { label: "DPE", value: "D" },
      { label: "Pièces", value: "5" },
    ]);
    expect(JSON.stringify(result.facts)).not.toContain("déménager");
  });

  test("a value ending in '!' is dropped even with a clean label", () => {
    const adRow = new FakeElement("tr", {
      children: [
        new FakeElement("th", { text: "Astuce déco" }),
        new FakeElement("td", { text: "Découvrez nos conseils dès maintenant !" }),
      ],
    });
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
    const table = new FakeElement("table", { children: [adRow] });
    const h1 = new FakeElement("h1", { text: "Maison à Basse-Goulaine" });
    const body = new FakeElement("body", { children: [h1, factsList, table] });

    const result = runExtract({ body });

    expect(result.pageKind).toBe("listing");
    expect(result.facts!.length).toBe(4);
    expect(JSON.stringify(result.facts)).not.toContain("Astuce déco");
  });
});
