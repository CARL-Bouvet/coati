// Tests for extension/panel/encart-items.js — the site card's button
// ordering (plan-mes-prompts-28-09.md, lot 3). Same pattern/location as
// ui-suggestions.test.ts.
import { describe, expect, test } from "bun:test";
import { encartItems, truncateLabel } from "../../extension/panel/encart-items.js";

const YT_SUMMARIZE = { id: "coati:youtube:summarize", label: "Résumer cette vidéo", action: "summarize" };
const YT_KEY_POINTS = { id: "coati:youtube:key-points", label: "Points clés minutés", prompt: "Liste les points clés…" };
const YT_FACT_CHECK = { id: "coati:youtube:fact-check", label: "À vérifier", prompt: "Relève les affirmations…" };
const YT_ITEMS = [YT_SUMMARIZE, YT_KEY_POINTS, YT_FACT_CHECK];

function userPrompt(id: string, site: string, body: string, title?: string) {
  return { id, site, title, body };
}

describe("truncateLabel", () => {
  test("short text unchanged", () => {
    expect(truncateLabel("Résumé neutre")).toBe("Résumé neutre");
  });

  test("cuts at a word boundary near 40 chars, appends …", () => {
    const text = "Résume cette page de façon neutre, sans jugement de valeur.";
    const out = truncateLabel(text);
    expect(out.endsWith("…")).toBe(true);
    expect(out.length).toBeLessThanOrEqual(41);
    expect(text.startsWith(out.slice(0, -1))).toBe(true);
    expect(out.includes(" ")).toBe(true); // did not cut mid-word into garbage
  });

  test("trims edge whitespace before measuring", () => {
    expect(truncateLabel("   Résumé neutre   ")).toBe("Résumé neutre");
  });

  test("single very long word: hard cut, still appends …", () => {
    const text = "a".repeat(60);
    const out = truncateLabel(text);
    expect(out).toBe("a".repeat(40) + "…");
  });
});

describe("encartItems — no site (unreadable address)", () => {
  test("null siteKey → only '*' prompts, no coati items even if given", () => {
    const result = encartItems({
      siteKey: null,
      coatiItems: YT_ITEMS,
      prompts: [userPrompt("p_1", "*", "Traduis ce texte.")],
      prefsSites: {},
    });
    expect(result).toEqual([{ key: "p_1", kind: "user", label: "Traduis ce texte.", prompt: "Traduis ce texte." }]);
  });

  test("null siteKey, no '*' prompts → empty", () => {
    expect(encartItems({ siteKey: null, coatiItems: YT_ITEMS, prompts: [], prefsSites: {} })).toEqual([]);
  });
});

describe("encartItems — @unsorted, the head case's unnamed part (T44)", () => {
  test("null siteKey → @unsorted prompts (in their order) first, then '*' prompts", () => {
    const result = encartItems({
      siteKey: null,
      coatiItems: YT_ITEMS,
      prompts: [
        userPrompt("p_star", "*", "Prompt de tous les sites."),
        userPrompt("p_u1", "@unsorted", "Premier prompt sans site."),
        userPrompt("p_u2", "@unsorted", "Second prompt sans site."),
      ],
      prefsSites: { "@unsorted": { order: ["p_u2", "p_u1"] } },
    });
    expect(result.map((b) => b.key)).toEqual(["p_u2", "p_u1", "p_star"]);
  });

  test("a known siteKey never shows @unsorted prompts", () => {
    const result = encartItems({
      siteKey: "@youtube",
      coatiItems: [],
      prompts: [userPrompt("p_u1", "@unsorted", "Ne doit pas apparaître ici.")],
      prefsSites: {},
    });
    expect(result).toEqual([]);
  });

  test("a known siteKey's own prompts don't leak into an unknown-address encart", () => {
    const result = encartItems({
      siteKey: null,
      coatiItems: [],
      prompts: [userPrompt("p_yt", "@youtube", "Prompt YouTube.")],
      prefsSites: {},
    });
    expect(result).toEqual([]);
  });
});

describe("encartItems — known site, default order (no prefs)", () => {
  test("coati items in data order, then site's own user prompts, then '*' prompts", () => {
    const result = encartItems({
      siteKey: "@youtube",
      coatiItems: YT_ITEMS,
      prompts: [
        userPrompt("p_yt", "@youtube", "Corps du prompt utilisateur", "Mon prompt YouTube"),
        userPrompt("p_star", "*", "Un prompt pour tous les sites", "Partout"),
      ],
      prefsSites: {},
    });
    expect(result.map((b) => b.key)).toEqual([
      "coati:youtube:summarize",
      "coati:youtube:key-points",
      "coati:youtube:fact-check",
      "p_yt",
      "p_star",
    ]);
    expect(result[0]).toEqual({ key: "coati:youtube:summarize", kind: "coati", label: "Résumer cette vidéo", action: "summarize" });
    expect(result[3]).toEqual({ key: "p_yt", kind: "user", label: "Mon prompt YouTube", prompt: "Corps du prompt utilisateur" });
  });

  test("unknown host (site null, siteKey is the hostname) still gets its own prompts + '*'", () => {
    const result = encartItems({
      siteKey: "crisco4.unicaen.fr",
      coatiItems: [], // suggestionsFor() returns no items for an unrecognized host
      prompts: [
        userPrompt("p_a", "crisco4.unicaen.fr", "Corps A", "Titre A"),
        userPrompt("p_b", "*", "Corps B", "Titre B"),
      ],
      prefsSites: {},
    });
    expect(result.map((b) => b.key)).toEqual(["p_a", "p_b"]);
  });

  test("unknown host, nothing saved anywhere → empty", () => {
    expect(encartItems({ siteKey: "example.com", coatiItems: [], prompts: [], prefsSites: {} })).toEqual([]);
  });
});

describe("encartItems — removed coati suggestions", () => {
  test("a removed coati id disappears from the site's case", () => {
    const result = encartItems({
      siteKey: "@youtube",
      coatiItems: YT_ITEMS,
      prompts: [],
      prefsSites: { "@youtube": { removed: ["coati:youtube:fact-check"] } },
    });
    expect(result.map((b) => b.key)).toEqual(["coati:youtube:summarize", "coati:youtube:key-points"]);
  });

  test("removed only affects the named site, not '*'", () => {
    const result = encartItems({
      siteKey: "@youtube",
      coatiItems: YT_ITEMS,
      prompts: [userPrompt("p_star", "*", "Corps")],
      prefsSites: { "*": { removed: ["coati:youtube:summarize"] } }, // no-op: not a '*' item
    });
    expect(result.map((b) => b.key)).toEqual([
      "coati:youtube:summarize",
      "coati:youtube:key-points",
      "coati:youtube:fact-check",
      "p_star",
    ]);
  });
});

describe("encartItems — explicit order, tolerant rule", () => {
  test("reorders coati suggestions and a user prompt together", () => {
    const result = encartItems({
      siteKey: "@youtube",
      coatiItems: YT_ITEMS,
      prompts: [userPrompt("p_yt", "@youtube", "Corps", "Mon prompt")],
      prefsSites: {
        "@youtube": { order: ["p_yt", "coati:youtube:fact-check", "coati:youtube:summarize", "coati:youtube:key-points"] },
      },
    });
    expect(result.map((b) => b.key)).toEqual([
      "p_yt",
      "coati:youtube:fact-check",
      "coati:youtube:summarize",
      "coati:youtube:key-points",
    ]);
  });

  test("an id in order that matches nothing is skipped, not surfaced as a gap", () => {
    const result = encartItems({
      siteKey: "@youtube",
      coatiItems: YT_ITEMS,
      prompts: [],
      prefsSites: { "@youtube": { order: ["coati:youtube:ghost", "coati:youtube:key-points"] } },
    });
    expect(result.map((b) => b.key)).toEqual(["coati:youtube:key-points", "coati:youtube:summarize", "coati:youtube:fact-check"]);
  });

  test("an item missing from order is appended at the end, default-ordered among itself", () => {
    const result = encartItems({
      siteKey: "@youtube",
      coatiItems: YT_ITEMS,
      prompts: [userPrompt("p_yt", "@youtube", "Corps", "Mon prompt")],
      prefsSites: { "@youtube": { order: ["coati:youtube:key-points"] } },
    });
    expect(result.map((b) => b.key)).toEqual([
      "coati:youtube:key-points",
      "coati:youtube:summarize",
      "coati:youtube:fact-check",
      "p_yt",
    ]);
  });

  test("'*' order is independent from the site's order", () => {
    const result = encartItems({
      siteKey: "@youtube",
      coatiItems: [],
      prompts: [
        userPrompt("p_1", "*", "Corps 1", "Un"),
        userPrompt("p_2", "*", "Corps 2", "Deux"),
      ],
      prefsSites: { "*": { order: ["p_2", "p_1"] } },
    });
    expect(result.map((b) => b.key)).toEqual(["p_2", "p_1"]);
  });
});

describe("encartItems — labels", () => {
  test("prompt with a title uses the title verbatim", () => {
    const result = encartItems({
      siteKey: "*",
      coatiItems: [],
      prompts: [userPrompt("p_1", "*", "Un corps quelconque, sans rapport avec le titre.", "Mon titre")],
      prefsSites: {},
    });
    expect(result[0].label).toBe("Mon titre");
  });

  test("prompt without a title falls back to a truncated body", () => {
    const body = "Résume cette page de façon neutre, sans jugement de valeur, en français.";
    const result = encartItems({ siteKey: "*", coatiItems: [], prompts: [userPrompt("p_1", "*", body)], prefsSites: {} });
    expect(result[0].label).toBe(truncateLabel(body));
    expect(result[0].label.endsWith("…")).toBe(true);
  });

  test("coati items keep their own label untouched", () => {
    const result = encartItems({ siteKey: "@youtube", coatiItems: YT_ITEMS, prompts: [], prefsSites: {} });
    expect(result.map((b) => b.label)).toEqual(["Résumer cette vidéo", "Points clés minutés", "À vérifier"]);
  });
});

describe("encartItems — item shape", () => {
  test("a coati action item carries 'action', never 'prompt'", () => {
    const result = encartItems({ siteKey: "@youtube", coatiItems: YT_ITEMS, prompts: [], prefsSites: {} });
    const summarizeBtn = result.find((b) => b.key === "coati:youtube:summarize");
    expect(summarizeBtn.action).toBe("summarize");
    expect(summarizeBtn.prompt).toBeUndefined();
  });

  test("a coati chat item carries 'prompt', never 'action'", () => {
    const result = encartItems({ siteKey: "@youtube", coatiItems: YT_ITEMS, prompts: [], prefsSites: {} });
    const keyPointsBtn = result.find((b) => b.key === "coati:youtube:key-points");
    expect(keyPointsBtn.prompt).toBe("Liste les points clés…");
    expect(keyPointsBtn.action).toBeUndefined();
  });

  test("a user prompt item carries 'prompt', kind 'user'", () => {
    const result = encartItems({
      siteKey: "*",
      coatiItems: [],
      prompts: [userPrompt("p_1", "*", "Corps", "Titre")],
      prefsSites: {},
    });
    expect(result[0]).toEqual({ key: "p_1", kind: "user", label: "Titre", prompt: "Corps" });
  });
});
