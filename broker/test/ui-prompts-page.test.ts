// Pure "Mes prompts" board logic (extension/prompts/prompts-cases.js) —
// plan-mes-prompts-28-09.md, lot 4. No DOM, no chrome.*, same pattern as
// ui-encart-items.test.ts.

import { describe, expect, test } from "bun:test";
import { coatiItemsForSite, computeCaseItems, buildCaseDescriptors, replaceInOrder } from "../../extension/prompts/prompts-cases.js";

const SITES = [
  { id: "youtube", name: "YouTube", items: [
    { id: "coati:youtube:summarize", label: "Résumer cette vidéo", action: "summarize" },
    { id: "coati:youtube:key-points", label: "Points clés minutés", prompt: "Liste les points clés." },
  ] },
  { id: "google", name: "Google", items: [{ id: "coati:google:refine", label: "Affiner ma recherche", prompt: "Affine." }] },
];

describe("coatiItemsForSite", () => {
  test("no built-in items for the star case", () => {
    expect(coatiItemsForSite(SITES, "*")).toEqual([]);
  });

  test("no built-in items for a user site", () => {
    expect(coatiItemsForSite(SITES, "crisco4.unicaen.fr")).toEqual([]);
  });

  test("a popular site's own items", () => {
    expect(coatiItemsForSite(SITES, "@youtube")).toBe(SITES[0].items);
  });

  test("unknown popular-looking key -> []", () => {
    expect(coatiItemsForSite(SITES, "@unknown")).toEqual([]);
  });
});

describe("computeCaseItems", () => {
  test("popular site: Coati items first (data order), then user prompts, no prefs", () => {
    const prompts = [{ id: "p_1", site: "@youtube", title: "", body: "Mon prompt" }];
    const items = computeCaseItems({ siteKey: "@youtube", prompts, prefsSites: {}, sites: SITES });
    expect(items.map((i) => i.key)).toEqual(["coati:youtube:summarize", "coati:youtube:key-points", "p_1"]);
    expect(items[2].kind).toBe("user");
    expect(items[2].label).toBe("Mon prompt"); // untitled -> body used as label
  });

  test("removed Coati items are dropped from the case entirely", () => {
    const prefsSites = { "@youtube": { removed: ["coati:youtube:summarize"] } };
    const items = computeCaseItems({ siteKey: "@youtube", prompts: [], prefsSites, sites: SITES });
    expect(items.map((i) => i.key)).toEqual(["coati:youtube:key-points"]);
  });

  test("explicit order wins, tolerant of a stale id and a missing one", () => {
    const prompts = [{ id: "p_1", site: "@youtube", title: "Mien", body: "…" }];
    const prefsSites = {
      "@youtube": { order: ["p_1", "coati:youtube:does-not-exist", "coati:youtube:summarize"] },
    };
    const items = computeCaseItems({ siteKey: "@youtube", prompts, prefsSites, sites: SITES });
    // p_1 first (per order), the unknown id silently skipped, "summarize" per
    // order, "key-points" appended at the end (never mentioned in order).
    expect(items.map((i) => i.key)).toEqual(["p_1", "coati:youtube:summarize", "coati:youtube:key-points"]);
  });

  test("the star case only ever holds user prompts", () => {
    const prompts = [
      { id: "p_star", site: "*", body: "Partout" },
      { id: "p_yt", site: "@youtube", body: "Pas ici" },
    ];
    const items = computeCaseItems({ siteKey: "*", prompts, prefsSites: {}, sites: SITES });
    expect(items.map((i) => i.key)).toEqual(["p_star"]);
  });

  test("a user site only ever holds that site's own prompts, no Coati items", () => {
    const prompts = [
      { id: "p_a", site: "crisco4.unicaen.fr", body: "A" },
      { id: "p_b", site: "unicaen.fr", body: "B" },
    ];
    const items = computeCaseItems({ siteKey: "crisco4.unicaen.fr", prompts, prefsSites: {}, sites: SITES });
    expect(items.map((i) => i.key)).toEqual(["p_a"]);
  });

  test("@unsorted (head case, second part) only ever holds prompts saved with that site key, ordered by prefs['@unsorted']", () => {
    const prompts = [
      { id: "p_star", site: "*", body: "Partout" },
      { id: "p_u1", site: "@unsorted", body: "Sans adresse 1" },
      { id: "p_u2", site: "@unsorted", body: "Sans adresse 2" },
    ];
    const prefsSites = { "@unsorted": { order: ["p_u2", "p_u1"] } };
    const items = computeCaseItems({ siteKey: "@unsorted", prompts, prefsSites, sites: SITES });
    expect(items.map((i) => i.key)).toEqual(["p_u2", "p_u1"]);
  });
});

describe("buildCaseDescriptors", () => {
  test("star + every popular site always present, no user site without a prompt", () => {
    const descriptors = buildCaseDescriptors({ prompts: [], sites: SITES });
    expect(descriptors.map((d) => d.key)).toEqual(["*", "@youtube", "@google"]);
    expect(descriptors.every((d) => d.alwaysShow)).toBe(true);
  });

  test("the star descriptor is the head case (kind: \"head\"), never a plain site case", () => {
    const descriptors = buildCaseDescriptors({ prompts: [], sites: SITES });
    expect(descriptors[0]).toEqual({ key: "*", kind: "head", alwaysShow: true });
  });

  test("no separate descriptor for @unsorted — it only ever lives inside the head case", () => {
    const prompts = [{ id: "p_1", site: "@unsorted", body: "…" }];
    const descriptors = buildCaseDescriptors({ prompts, sites: SITES });
    expect(descriptors.map((d) => d.key)).toEqual(["*", "@youtube", "@google"]);
  });

  test("user sites appended alphabetically, not creation order, and marked alwaysShow:false", () => {
    const prompts = [
      { id: "p_1", site: "zulu.example", body: "…" },
      { id: "p_2", site: "alpha.example", body: "…" },
    ];
    const descriptors = buildCaseDescriptors({ prompts, sites: SITES });
    expect(descriptors.map((d) => d.key)).toEqual(["*", "@youtube", "@google", "alpha.example", "zulu.example"]);
    expect(descriptors.find((d) => d.key === "alpha.example")?.alwaysShow).toBe(false);
  });

  test("crisco4.unicaen.fr and unicaen.fr are two distinct sites", () => {
    const prompts = [
      { id: "p_1", site: "crisco4.unicaen.fr", body: "…" },
      { id: "p_2", site: "unicaen.fr", body: "…" },
    ];
    const descriptors = buildCaseDescriptors({ prompts, sites: SITES });
    expect(descriptors.map((d) => d.key)).toEqual(["*", "@youtube", "@google", "crisco4.unicaen.fr", "unicaen.fr"]);
  });
});

describe("replaceInOrder", () => {
  test("swaps the old id for the new one at the same position", () => {
    expect(replaceInOrder(["a", "b", "c"], "b", "z")).toEqual(["a", "z", "c"]);
  });

  test("drops a separate trailing occurrence of the new id (tolerant-append artefact)", () => {
    // The freshly created prompt was appended at the end by the tolerant
    // "not in order" rule before this call fixes its real position.
    expect(replaceInOrder(["a", "b", "c", "z"], "b", "z")).toEqual(["a", "z", "c"]);
  });

  test("old id absent -> new id just gets dropped from the end, order otherwise unchanged", () => {
    expect(replaceInOrder(["a", "c", "z"], "b", "z")).toEqual(["a", "c"]);
  });
});
