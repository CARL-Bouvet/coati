// U1 bug (development notes): the user picks French in the language
// selector (uiLang stored "fr") while the browser's own UI language is
// English — extension/lib/i18n.js's runtime catalog (loadRuntimeMessages())
// used to load ASYNCHRONOUSLY, so every module that calls t() at its own
// MODULE LOAD time (extension/lib/suggestions-data.js's SITES, among many
// others listed in the fix's commit) raced it and froze on chrome.i18n — the
// browser's fixed language, never the stored preference.
//
// The fix is lib/i18n.js's top-level `await loadRuntimeMessages()` in
// document contexts, which this repo's `bun test` environment has none of
// (no DOM here — see broker/test/extract.test.ts's own comment on that).
// So this test drives the same underlying mechanism directly: prime the
// shared i18n.js singleton via its exported `i18nReady()` with a
// chrome-extension mock (storage.local.uiLang = "fr", i18n.getUILanguage =
// "en"), THEN import suggestions-data.js — cache-busted so its module body
// (and its own module-load-time t() calls) actually re-runs against the
// now-loaded catalog, exactly like a fresh page load would after the real
// fix's top-level await. Run with: cd broker && bun test test/ui-i18n-runtime.test.ts
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const EXT = join(import.meta.dir, "..", "..", "extension");

function messagesFor(lang: string): Record<string, { message: string }> {
  return JSON.parse(readFileSync(join(EXT, "_locales", lang, "messages.json"), "utf8"));
}

describe("U1 — stored uiLang beats the browser's own UI language", () => {
  test("uiLang 'fr' + browser UI language 'en': suggestions-data.js's SITES comes out French", async () => {
    const frMessages = messagesFor("fr");

    const previousChrome = (globalThis as any).chrome;
    const previousFetch = globalThis.fetch;
    (globalThis as any).chrome = {
      runtime: { getURL: (path: string) => `chrome-extension://test/${path}` },
      i18n: {
        getUILanguage: () => "en",
        // Reached only if the fix regresses and t() falls back to
        // chrome.i18n instead of the loaded "fr" catalog — distinctive on
        // purpose so a regression fails loudly instead of accidentally
        // matching real English text.
        getMessage: (key: string) => `EN-FALLBACK:${key}`,
      },
      storage: {
        local: { get: async (key: string) => ({ [key]: "fr" }) },
        onChanged: { addListener: () => {} },
      },
    };
    globalThis.fetch = (async (url: string) => {
      const lang = url.includes("/zh_CN/") ? "zh_CN" : url.includes("/fr/") ? "fr" : "en";
      return { ok: true, json: async () => messagesFor(lang) } as Response;
    }) as typeof fetch;

    try {
      // Canonical (non-cache-busted) import: this is the one singleton every
      // real module in the extension shares, i18n.js included.
      const i18n = await import("../../extension/lib/i18n.js");
      await i18n.i18nReady();

      // Cache-busted: forces suggestions-data.js's module body — and its
      // module-load-time t() calls building SITES — to run again, now that
      // the canonical i18n.js singleton it imports has the "fr" catalog
      // loaded. Mirrors what the real top-level-await fix guarantees for
      // every document page.
      const { SITES } = await import(`../../extension/lib/suggestions-data.js?u1-i18n-runtime-test`);

      const wikipedia = SITES.find((s: { id: string }) => s.id === "wikipedia");
      expect(wikipedia).toBeDefined();
      expect(wikipedia.name).toBe(frMessages.sugg_wikipedia_name.message);
      expect(wikipedia.name).not.toBe("EN-FALLBACK:sugg_wikipedia_name");

      const youtube = SITES.find((s: { id: string }) => s.id === "youtube");
      const summarizeItem = youtube.items.find((i: { action?: string }) => i.action === "summarize");
      expect(summarizeItem.label).toBe(frMessages.panel_summarize_video.message);
    } finally {
      (globalThis as any).chrome = previousChrome;
      globalThis.fetch = previousFetch;
    }
  });
});
