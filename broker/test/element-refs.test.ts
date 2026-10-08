// Unit tests for extension/panel/element-refs.js (Lot A2,
// plan-montrer-voir-chercher-08-10.md §3A, flow (4)). Pure/DOM-free module,
// same testing style as broker/test/ui-timestamps-like modules.

import { describe, expect, test } from "bun:test";
import { parseElementRefs, prepareContextForWire, resolveElementClick } from "../../extension/panel/element-refs.js";

const ELEMENTS = [
  { ref: "e1", role: "button", label: "Générer" },
  { ref: "e2", role: "link", label: "En savoir plus" },
];

describe("parseElementRefs", () => {
  test("plain text with no ref is returned as a single text token", () => {
    expect(parseElementRefs("Rien à montrer ici.", ELEMENTS)).toEqual([
      { type: "text", value: "Rien à montrer ici." },
    ]);
  });

  test("a known ref becomes a 'ref' token carrying the label from the extraction, never the model's own words", () => {
    const tokens = parseElementRefs("Clique sur [[e1]] pour continuer.", ELEMENTS);
    expect(tokens).toEqual([
      { type: "text", value: "Clique sur " },
      { type: "ref", ref: "e1", role: "button", label: "Générer" },
      { type: "text", value: " pour continuer." },
    ]);
  });

  test("the model writing its own label next to the ref changes nothing: the button's label still comes from `elements`", () => {
    const tokens = parseElementRefs("Appuie sur [[e1]] (« Soumettre »).", ELEMENTS);
    const ref = tokens.find((t) => t.type === "ref");
    expect(ref).toEqual({ type: "ref", ref: "e1", role: "button", label: "Générer" });
  });

  test("an unknown ref is dropped entirely — never left as literal '[[eN]]' text", () => {
    const tokens = parseElementRefs("Vois [[e99]] là-bas.", ELEMENTS);
    expect(tokens).toEqual([
      { type: "text", value: "Vois " },
      { type: "text", value: " là-bas." },
    ]);
    expect(tokens.some((t) => t.type === "text" && t.value.includes("[["))).toBe(false);
  });

  test("several refs in the same text, known and unknown mixed", () => {
    const tokens = parseElementRefs("D'abord [[e1]], puis [[e42]], enfin [[e2]].", ELEMENTS);
    expect(tokens).toEqual([
      { type: "text", value: "D'abord " },
      { type: "ref", ref: "e1", role: "button", label: "Générer" },
      { type: "text", value: ", puis " },
      { type: "text", value: ", enfin " },
      { type: "ref", ref: "e2", role: "link", label: "En savoir plus" },
      { type: "text", value: "." },
    ]);
  });

  test("no elements known at all: every [[eN]] is dropped, text reduces to plain prose", () => {
    const tokens = parseElementRefs("[[e1]] puis [[e2]]", []);
    expect(tokens).toEqual([{ type: "text", value: " puis " }]);
  });

  test("a token split across streaming chunks: incomplete bracket stays literal text until closed", () => {
    // panel.js re-parses the FULL accumulated text on every chunk (same
    // tolerance as markdown.js) — mid-stream, an unclosed "[[e1" is not yet
    // a match, so it must render as plain text, not throw and not vanish.
    const midStream = parseElementRefs("Clique sur [[e1", ELEMENTS);
    expect(midStream).toEqual([{ type: "text", value: "Clique sur [[e1" }]);

    const completed = parseElementRefs("Clique sur [[e1]] maintenant.", ELEMENTS);
    expect(completed).toEqual([
      { type: "text", value: "Clique sur " },
      { type: "ref", ref: "e1", role: "button", label: "Générer" },
      { type: "text", value: " maintenant." },
    ]);
  });

  test("malformed refs (e0, e1234, no digits) are left as plain text — the regex never matches them", () => {
    const tokens = parseElementRefs("[[e0]] [[e1234]] [[eX]]", ELEMENTS);
    expect(tokens).toEqual([{ type: "text", value: "[[e0]] [[e1234]] [[eX]]" }]);
  });

  test("the global regex's lastIndex does not leak state across independent calls", () => {
    parseElementRefs("[[e1]]", ELEMENTS);
    const tokens = parseElementRefs("no refs here", ELEMENTS);
    expect(tokens).toEqual([{ type: "text", value: "no refs here" }]);
  });
});

describe("resolveElementClick — regression: an OLDER message must resolve against its OWN extraction, never a newer one (admin review 08/10)", () => {
  const firstAnswer = { extractionId: "x-first", elements: [{ ref: "e1", role: "button", label: "Générer" }] };
  const secondAnswer = { extractionId: "x-second", elements: [{ ref: "e1", role: "link", label: "Mentions légales" }] };

  test("a known ref resolves to the full click payload, extractionId included", () => {
    expect(resolveElementClick(firstAnswer, "e1")).toEqual({
      extractionId: "x-first",
      ref: "e1",
      role: "button",
      label: "Générer",
    });
  });

  test("the SAME ref number ('e1') resolved against two different snapshots yields two DIFFERENT payloads", () => {
    const fromFirst = resolveElementClick(firstAnswer, "e1");
    const fromSecond = resolveElementClick(secondAnswer, "e1");
    expect(fromFirst).not.toEqual(fromSecond);
    // The regression this guards against: an older message's button, built
    // from `firstAnswer`, must keep pointing at "Générer" / x-first — never
    // silently drift to "Mentions légales" / x-second just because a newer
    // question was sent in between.
    expect(fromFirst).toEqual({ extractionId: "x-first", ref: "e1", role: "button", label: "Générer" });
    expect(fromSecond).toEqual({ extractionId: "x-second", ref: "e1", role: "link", label: "Mentions légales" });
  });

  test("an unknown ref resolves to null", () => {
    expect(resolveElementClick(firstAnswer, "e99")).toBeNull();
  });

  test("a missing/empty snapshot resolves to null, never throws", () => {
    expect(resolveElementClick(null, "e1")).toBeNull();
    expect(resolveElementClick(undefined, "e1")).toBeNull();
    expect(resolveElementClick({ extractionId: "x", elements: [] }, "e1")).toBeNull();
    expect(resolveElementClick({ extractionId: "x" } as any, "e1")).toBeNull();
  });
});

describe("prepareContextForWire", () => {
  const context = {
    kind: "page",
    url: "https://example.com/",
    title: "Exemple",
    text: "...",
    extractionId: "x123abc",
    elementsFrameLimited: true,
    elements: [{ ref: "e1", role: "button", label: "Générer" }],
  };

  test("feature disabled: extractionId, elementsFrameLimited and elements are all stripped", () => {
    const wire = prepareContextForWire(context, false);
    expect(wire).not.toHaveProperty("extractionId");
    expect(wire).not.toHaveProperty("elementsFrameLimited");
    expect(wire).not.toHaveProperty("elements");
    expect(wire.url).toBe(context.url);
    expect(wire.text).toBe(context.text);
  });

  test("feature enabled: elements passes through, extractionId/elementsFrameLimited still stripped", () => {
    const wire = prepareContextForWire(context, true);
    expect(wire.elements).toEqual(context.elements);
    expect(wire).not.toHaveProperty("extractionId");
    expect(wire).not.toHaveProperty("elementsFrameLimited");
  });

  test("never mutates the input context", () => {
    const before = JSON.stringify(context);
    prepareContextForWire(context, true);
    expect(JSON.stringify(context)).toBe(before);
  });

  test("a context with no elements field (e.g. a selection-based act context) passes through unchanged minus nothing", () => {
    const noElements = { kind: "selection", text: "hello" };
    expect(prepareContextForWire(noElements, true)).toEqual({ kind: "selection", text: "hello" });
  });

  test("undefined/non-object context is returned as-is", () => {
    expect(prepareContextForWire(undefined, true)).toBeUndefined();
    expect(prepareContextForWire(null as any, true)).toBeNull();
  });
});
