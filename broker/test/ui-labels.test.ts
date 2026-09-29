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
} from "../../extension/lib/labels.js";

describe("providerLabel", () => {
  test("gives ollama the same name everywhere: 'Ollama (local)'", () => {
    expect(providerLabel("ollama")).toBe("Ollama (local)");
  });

  // Amendement 2026-09-29: only the two built-in providers have fixed text
  // here — anything else (an externally loaded module) has no entry at all,
  // and providerLabel() falls back to the broker-supplied `label` instead.
  test("only ollama and claude-api have built-in labels", () => {
    expect(Object.keys(PROVIDER_LABELS).sort()).toEqual(["claude-api", "ollama"]);
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
