// Unit tests for the shared French label table (provider names, broker
// error codes) used by both panel.js and options.js — bug report gaps 3
// and 4. Lives under extension/lib/ (DOM-free pure JS), same pattern as
// retention.test.ts.
import { describe, expect, test } from "bun:test";
import {
  PROVIDER_LABELS,
  providerLabel,
  describeError,
  describeProviderUnavailable,
  buildPageMention,
  limitSentences,
  limitsSummary,
  hardwareRows,
  nextReadPart,
} from "../../extension/lib/labels.js";

describe("providerLabel", () => {
  test("gives ollama the same name everywhere: 'Ollama (local)'", () => {
    expect(providerLabel("ollama")).toBe("Ollama (local)");
  });

  // Only the two built-in providers have fixed text
  // here — anything else (an externally loaded module) has no entry at all,
  // and providerLabel() falls back to the broker-supplied `label` instead.
  test("only ollama and claude-api have built-in labels", () => {
    expect(Object.keys(PROVIDER_LABELS).sort()).toEqual(["claude-api", "ollama", "openai-compat"]);
  });

  test("falls back to the given fallback for an unknown id", () => {
    expect(providerLabel("mystery-provider", "Mystère")).toBe("Mystère");
  });

  test("falls back to the id itself with no fallback given", () => {
    expect(providerLabel("mystery-provider")).toBe("mystery-provider");
  });
});

describe("describeError", () => {
  test("known code: French label only, no message", () => {
    expect(describeError("bad-request")).toBe("Requête invalide.");
  });

  test("known code with message: label then a secondary 'Détail :' line", () => {
    const text = describeError("bad-request", "chat: missing text");
    expect(text).toBe("Requête invalide.\nDétail : chat: missing text");
  });

  test("the English message never appears without its French label", () => {
    const text = describeError("bad-request", "chat: missing text");
    const lines = text.split("\n");
    expect(lines[0]).toBe("Requête invalide.");
    expect(lines[1]).toContain("chat: missing text");
  });

  test("unknown code falls back to a generic French label, not the raw code", () => {
    expect(describeError("some-future-code")).toBe("Une erreur est survenue.");
  });

  // The broker's two new codes (docs/PROTOCOL.md) each have their own fallback label, same table as
  // every other code — used by describeError() only as a defense-in-depth fallback: the
  // panel's normal path for these two shows the broker's own ready-to-display
  // `message` instead (see panel.js's describeBrokerError()).
  test("quota-exceeded has its own fallback label", () => {
    expect(describeError("quota-exceeded")).toBe("Votre compte chez le fournisseur n'a plus de crédit.");
  });

  test("model-empty has its own label", () => {
    expect(describeError("model-empty")).not.toBe("Une erreur est survenue.");
  });

  test("rate-limited has its own fallback label", () => {
    expect(describeError("rate-limited")).toBe("Le fournisseur reçoit trop de requêtes en ce moment.");
  });
});

describe("describeProviderUnavailable", () => {
  test("with a reason: generic French label, then the broker's text as detail", () => {
    const text = describeProviderUnavailable("Ollama unreachable at http://localhost:11434");
    expect(text).toBe("Indisponible.\nDétail : Ollama unreachable at http://localhost:11434");
  });

  test("without a reason: just the French label", () => {
    expect(describeProviderUnavailable()).toBe("Indisponible.");
  });
});

describe("buildPageMention / nextReadPart", () => {
  const page = (over: object) => ({ level: "text", chars: 100_000, from: 0, sentChars: 100_000, truncated: false, ...over });

  test("whole page read: only the token line", () => {
    const line = buildPageMention(false, { page: page({}), usage: { inputTokens: 3000, outputTokens: 200 } });
    expect(line).toMatch(/^A lu la page · 3[.,]2 k tokens$/);
    expect(nextReadPart(page({}))).toBeUndefined();
  });

  test("uncounted usage: says so instead of showing a figure", () => {
    const usage = { inputTokens: 0, outputTokens: 0, uncounted: true };
    expect(buildPageMention(false, { page: page({}), usage })).toBe("A lu la page · tokens non comptés");
    expect(buildPageMention(true, { usage })).toBe("N'a pas lu la page · tokens non comptés");
  });

  test("first part: percent, what the page needs and what the model reads", () => {
    const p = page({ sentChars: 40_000, truncated: true });
    const line = buildPageMention(false, { page: p, usage: {} });
    expect(line).toContain("Lu : le début (40 %)");
    expect(line).toContain("votre modèle en lit");
    expect(nextReadPart(p)).toEqual({ from: 40_000, level: "text" });
  });

  test("middle and last parts", () => {
    const mid = page({ from: 40_000, sentChars: 40_000, truncated: true });
    expect(buildPageMention(false, { page: mid })).toContain("Lu : de 40 à 80 % de la page.");
    expect(nextReadPart(mid)).toEqual({ from: 80_000, level: "text" });
    const end = page({ from: 80_000, sentChars: 20_000 });
    expect(buildPageMention(false, { page: end })).toContain("Lu : la fin de la page (à partir de 80 %).");
    expect(nextReadPart(end)).toBeUndefined();
  });

  test("no done.page: the page-on-demand line, else the token count alone", () => {
    expect(buildPageMention(false, { usage: { inputTokens: 9000, outputTokens: 1000 } })).toBe("10 k tokens");
    expect(buildPageMention(false, { usage: { inputTokens: 900, outputTokens: 100, uncounted: true } })).toMatch(/^Au moins 1[.,]0 k tokens$/);
    expect(buildPageMention(true, {})).toContain("N'a pas lu la page");
  });
});

describe("model limits", () => {
  const all = {
    memoryFull: { tokens: 7600, contextTokens: 8000 },
    refused: [
      { kind: "search", reason: "searches", count: 1, limit: 4 },
      { kind: "open", reason: "budget", count: 1, limit: 24000 },
      { kind: "open", reason: "unknown-ref", count: 1 },
    ],
    cut: true,
    answerNow: true,
  };

  test("one sentence per fact, caps shown as sent, budget in k", () => {
    const sentences = limitSentences(all, { uncounted: true });
    expect(sentences).toHaveLength(7);
    expect(sentences[0]).toMatch(/7[.,]6 k/);
    expect(sentences[1]).toContain("4");
    expect(sentences[2]).toContain("24 k");
  });

  test("memory full without contextTokens uses the plain sentence; nothing hit gives nothing", () => {
    expect(limitSentences({ memoryFull: { tokens: 900 } }, {})).toHaveLength(1);
    expect(limitSentences({ memoryFull: { tokens: 900 } }, {})[0]).not.toMatch(/\d/);
    expect(limitSentences({ memoryFull: { tokens: 11259, contextTokens: 8192 } })[0]).not.toBe(limitSentences({ memoryFull: { tokens: 7600, contextTokens: 8192 } })[0]);
    expect(limitSentences({ local: { contextTokens: 8000 } }, {})).toEqual([]);
  });

  test("summary: at most two items after the label", () => {
    const parts = limitsSummary({ ...all, local: { contextTokens: 8000, tokensPerSec: 14.2 } }).split(" · ");
    expect(parts).toEqual(["Modèle", "6 limites", "14 tokens/s"]);
    expect(limitsSummary({ local: { contextTokens: 8000 } })).toBe("Modèle");
    expect(limitsSummary({ cut: true })).toBe("Modèle · 1 limite");
  });

  test("hardware rows follow what is known; shared memory when unified", () => {
    expect(hardwareRows(undefined)).toEqual([]);
    expect(hardwareRows({ contextTokens: 8000 })).toHaveLength(1);
    const rows = hardwareRows({ gpuPercent: 62, contextTokens: 8000, tokensPerSec: 14, vramGb: 8, unifiedMemory: true });
    expect(rows).toHaveLength(4);
    expect(rows[3][1]).toContain("7.5");
    expect(hardwareRows({ vramGb: 6.442 })[0][1]).toMatch(/^6 /);
    expect(hardwareRows({ vramGb: 12.9 })[0][1]).toMatch(/^12 /);
  });

  test("GB value uses the page language's decimal separator, one decimal at most", () => {
    const g = globalThis as { document?: unknown };
    const saved = g.document;
    g.document = { documentElement: { lang: "fr" } };
    try {
      expect(hardwareRows({ vramGb: 8 })[0][1]).toContain("7,5");
      expect(hardwareRows({ vramGb: 8.59 })[0][1]).toMatch(/^8 /);
    } finally {
      g.document = saved;
    }
  });

  test("uncounted with a counted total: at least", () => {
    const line = buildPageMention(false, { page: { level: "text", chars: 10, from: 0, sentChars: 10, truncated: false }, usage: { inputTokens: 3000, outputTokens: 200, uncounted: true } });
    expect(line).toMatch(/^A lu la page · au moins 3[.,]2 k tokens$/);
  });

  test("no sentence names a model", () => {
    for (const s of limitSentences(all, { uncounted: true })) expect(s).not.toMatch(/qwen|llama|gpt|claude|gemma/i);
  });
});
