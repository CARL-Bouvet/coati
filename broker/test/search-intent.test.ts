// search/intent.ts — explicit search-intent detection, the only thing left
// that decides whether a chat.docSearch pipeline runs (no more button).

import { describe, expect, test } from "bun:test";
import { detectSearchIntent, stripSearchTriggerPhrase } from "../src/search/intent.ts";

describe("detectSearchIntent — fr", () => {
  const positives = [
    "cherche dans la doc comment exporter une vidéo",
    "cherche dans la documentation comment exporter",
    "recherche dans la doc le prix de l'abonnement",
    "regarde sur internet si ce site est fiable",
    "consulte l'aide officielle pour la facturation",
    "peux-tu chercher sur le web les tarifs ?",
    "fais une recherche sur ce sujet",
    "fais-moi une recherche rapide",
    "cherche en ligne les horaires",
  ];
  for (const text of positives) {
    test(`detects: "${text}"`, () => expect(detectSearchIntent(text, "fr")).toBe(true));
  }

  const negatives = [
    "cherche un hôtel pas cher à Paris",
    "comment exporter ma vidéo ?",
    "je recherche un emploi",
    "regarde cette image",
    "consulte ton médecin",
    "la documentation est bien faite",
  ];
  for (const text of negatives) {
    test(`does not detect: "${text}"`, () => expect(detectSearchIntent(text, "fr")).toBe(false));
  }
});

describe("detectSearchIntent — en", () => {
  const positives = [
    "search the docs for export options",
    "search the documentation about pricing",
    "look up the documentation for this",
    "can you search online for reviews?",
    "please look up docs about billing",
    "google it",
    "just google this please",
  ];
  for (const text of positives) {
    test(`detects: "${text}"`, () => expect(detectSearchIntent(text, "en")).toBe(true));
  }

  const negatives = [
    "search for a cheap hotel in Paris",
    "how do I export my video?",
    "I'm looking for a new job",
    "google is a big company",
    "the documentation is well written",
  ];
  for (const text of negatives) {
    test(`does not detect: "${text}"`, () => expect(detectSearchIntent(text, "en")).toBe(false));
  }
});

describe("detectSearchIntent — zh_CN", () => {
  const positives = ["搜索一下文档中关于导出的内容", "查一下官方文档", "帮我查查网上的评价", "搜索网上的信息"];
  for (const text of positives) {
    test(`detects: "${text}"`, () => expect(detectSearchIntent(text, "zh_CN")).toBe(true));
  }

  const negatives = ["这个文档写得很好", "帮我找一个便宜的酒店", "搜索一下附近的餐厅"];
  for (const text of negatives) {
    test(`does not detect: "${text}"`, () => expect(detectSearchIntent(text, "zh_CN")).toBe(false));
  }
});

describe("stripSearchTriggerPhrase", () => {
  test("fr: removes verb and target, keeps the real question", () => {
    const out = stripSearchTriggerPhrase("cherche dans la doc comment exporter une vidéo", "fr");
    expect(out).not.toMatch(/\bcherche\b/i);
    expect(out).not.toMatch(/\bdoc\b/i);
    expect(out).toContain("exporter une vidéo");
  });
  test("en: removes verb and target", () => {
    const out = stripSearchTriggerPhrase("search the docs for export options", "en");
    expect(out.toLowerCase()).not.toContain("search");
    expect(out.toLowerCase()).toContain("export options");
  });
  test("never throws on text with no trigger at all", () => {
    expect(() => stripSearchTriggerPhrase("hello there", "en")).not.toThrow();
  });
});
