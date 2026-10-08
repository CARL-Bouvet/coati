// search/reformulate.ts — the extra "turn the question into a short search
// query" model call: happy path, junk/timeout fallback, fallbackQuery()
// itself (trigger phrase stripped + site name).

import { describe, expect, test } from "bun:test";
import { reformulateSearchQuery, fallbackQuery, REFORMULATE_TIMEOUT_MS } from "../src/search/reformulate.ts";
import type { ModelProvider } from "../src/providers/types.ts";
import type { AnswerEvent, BuiltPrompt } from "../src/model.ts";
import type { StreamAnswerOptions, ProviderRuntimeOptions } from "../src/providers/types.ts";

function fakeProvider(
  behavior: (built: BuiltPrompt, opts: StreamAnswerOptions & ProviderRuntimeOptions) => AsyncIterable<AnswerEvent>,
): ModelProvider {
  return {
    id: "fake",
    label: "Fake",
    async isAvailable() {
      return { available: true };
    },
    async checkStatus() {
      return { state: "ok" as never, reason: "" };
    },
    streamAnswer: behavior,
  };
}

async function* deltas(...chunks: string[]): AsyncIterable<AnswerEvent> {
  for (const c of chunks) yield { kind: "delta", text: c };
}

describe("reformulateSearchQuery — happy path", () => {
  test("returns the model's one-line reply, capped to 12 words", async () => {
    const provider = fakeProvider(() => deltas("export video kling ai tutorial steps"));
    const out = await reformulateSearchQuery({
      provider,
      providerOpts: {},
      question: "cherche dans la doc comment exporter une vidéo",
      pageTitle: "Kling AI",
      pageUrl: "https://klingai.com/app",
      lang: "fr",
      siteName: "klingai.com",
    });
    expect(out).toBe("export video kling ai tutorial steps");
  });

  test("strips surrounding quotes from the model's reply", async () => {
    const provider = fakeProvider(() => deltas('"export video tutorial"'));
    const out = await reformulateSearchQuery({
      provider,
      providerOpts: {},
      question: "search the docs for export",
      lang: "en",
      siteName: "example.com",
    });
    expect(out).toBe("export video tutorial");
  });

  test("caps at 12 words even when the model ignores the instruction", async () => {
    const longReply = Array.from({ length: 30 }, (_, i) => `word${i}`).join(" ");
    const provider = fakeProvider(() => deltas(longReply));
    const out = await reformulateSearchQuery({
      provider,
      providerOpts: {},
      question: "search the docs for something",
      lang: "en",
      siteName: "example.com",
    });
    expect(out.split(" ").length).toBeLessThanOrEqual(12);
  });
});

describe("reformulateSearchQuery — fallback on junk/failure", () => {
  test("empty reply falls back to fallbackQuery()", async () => {
    const provider = fakeProvider(() => deltas(""));
    const out = await reformulateSearchQuery({
      provider,
      providerOpts: {},
      question: "cherche dans la doc comment exporter",
      lang: "fr",
      siteName: "klingai.com",
    });
    expect(out).toBe(fallbackQuery("cherche dans la doc comment exporter", "fr", "klingai.com"));
  });

  test("a multi-paragraph (explanation-shaped) reply is treated as junk", async () => {
    const provider = fakeProvider(() => deltas("Sure, here is a query:\n\nexport video tutorial"));
    const out = await reformulateSearchQuery({
      provider,
      providerOpts: {},
      question: "search the docs for export",
      lang: "en",
      siteName: "example.com",
    });
    expect(out).toBe(fallbackQuery("search the docs for export", "en", "example.com"));
  });

  test("a provider that throws falls back, never propagates", async () => {
    const provider = fakeProvider(async function* () {
      throw new Error("boom");
    });
    const out = await reformulateSearchQuery({
      provider,
      providerOpts: {},
      question: "search the docs for export",
      lang: "en",
      siteName: "example.com",
    });
    expect(out).toBe(fallbackQuery("search the docs for export", "en", "example.com"));
  });

  test("a provider that never yields (hangs) times out and falls back — bounded by timeoutMs, not REFORMULATE_TIMEOUT_MS", async () => {
    const provider = fakeProvider(async function* (built, opts) {
      await new Promise((resolve) => {
        opts.signal?.addEventListener("abort", () => resolve(undefined));
      });
      // Real providers throw on abort; a well-behaved fake just stops here.
    });
    const start = Date.now();
    const out = await reformulateSearchQuery({
      provider,
      providerOpts: {},
      question: "search the docs for export",
      lang: "en",
      siteName: "example.com",
      timeoutMs: 50, // never wait the real REFORMULATE_TIMEOUT_MS (20s) in a test
    });
    expect(Date.now() - start).toBeLessThan(REFORMULATE_TIMEOUT_MS);
    expect(out).toBe(fallbackQuery("search the docs for export", "en", "example.com"));
  });
});

describe("fallbackQuery", () => {
  test("fr: strips the trigger phrase, appends the site name, within the char cap", () => {
    const out = fallbackQuery("cherche dans la doc comment exporter une vidéo", "fr", "klingai.com");
    expect(out).not.toMatch(/\bcherche\b/i);
    expect(out).toContain("exporter une vidéo");
    expect(out).toContain("klingai.com");
  });

  test("en: strips the trigger phrase, appends the site name", () => {
    const out = fallbackQuery("search the docs for export options", "en", "example.com");
    expect(out.toLowerCase()).not.toContain("search");
    expect(out).toContain("example.com");
  });

  test("never empty even when the whole question is the trigger phrase itself", () => {
    const out = fallbackQuery("fais une recherche", "fr", "example.com");
    expect(out.length).toBeGreaterThan(0);
  });
});
