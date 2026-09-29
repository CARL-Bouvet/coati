// Tests for extension/lib/suggestions.js and suggestions-data.js.
// Run with: cd broker && bun test test/ui-suggestions.test.ts
//
// Amendement 2026-09-28 ("Mes prompts par site"): rewritten for the five-site,
// no-generic-fallback data (docs/DECISIONS.md T30 amendement, T31).
import { describe, expect, test } from "bun:test";
import { suggestionsFor, siteKeyFor } from "../../extension/lib/suggestions.js";
import { SITES, permissionPatternsFor } from "../../extension/lib/suggestions-data.js";

function noResumer(items: { label: string }[]) {
  for (const item of items) {
    if (/résumer/i.test(item.label) && item.label !== "Résumer cette vidéo") return false;
  }
  return true;
}

// ---------------------------------------------------------------------------
// Unknown / unparsable url — no generic fallback anymore
// ---------------------------------------------------------------------------
describe("unknown site → empty items, no generic fallback", () => {
  test("null url", () => {
    const r = suggestionsFor({ url: null });
    expect(r.site).toBeNull();
    expect(r.siteKey).toBeNull();
    expect(r.items).toEqual([]);
  });

  test("undefined url", () => {
    const r = suggestionsFor({ url: undefined });
    expect(r.site).toBeNull();
    expect(r.items).toEqual([]);
  });

  test("garbage string", () => {
    const r = suggestionsFor({ url: "not-a-url" });
    expect(r.site).toBeNull();
    expect(r.items).toEqual([]);
  });

  test("non-http(s) protocol", () => {
    const r = suggestionsFor({ url: "file:///etc/passwd" });
    expect(r.site).toBeNull();
    expect(r.siteKey).toBeNull();
  });

  test("unrecognized host: site null, siteKey is the hostname, items empty", () => {
    const r = suggestionsFor({ url: "https://example.com/page" });
    expect(r.site).toBeNull();
    expect(r.siteKey).toBe("example.com");
    expect(r.items).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// YouTube
// ---------------------------------------------------------------------------
describe("YouTube", () => {
  test("exact host youtube.com", () => {
    const r = suggestionsFor({ url: "https://youtube.com/watch?v=abc" });
    expect(r.site?.id).toBe("youtube");
    expect(r.siteKey).toBe("@youtube");
    expect(r.items.length).toBe(3);
  });

  test("subdomain www.youtube.com", () => {
    const r = suggestionsFor({ url: "https://www.youtube.com/watch?v=abc" });
    expect(r.site?.id).toBe("youtube");
  });

  test("subdomain m.youtube.com", () => {
    const r = suggestionsFor({ url: "https://m.youtube.com/watch?v=abc" });
    expect(r.site?.id).toBe("youtube");
  });

  test("youtu.be short link", () => {
    const r = suggestionsFor({ url: "https://youtu.be/abc" });
    expect(r.site?.id).toBe("youtube");
    expect(r.siteKey).toBe("@youtube");
  });

  test("any path matches — no path restriction", () => {
    const r = suggestionsFor({ url: "https://www.youtube.com/feed/subscriptions" });
    expect(r.site?.id).toBe("youtube");
    expect(r.items.length).toBe(3);
  });

  test("first item is the summarize action, not a chat prompt", () => {
    const r = suggestionsFor({ url: "https://www.youtube.com/watch?v=abc" });
    expect(r.items[0]).toEqual({ id: "coati:youtube:summarize", label: "Résumer cette vidéo", action: "summarize" });
  });

  test("no other Résumer label", () => {
    const r = suggestionsFor({ url: "https://www.youtube.com/watch?v=abc" });
    expect(noResumer(r.items)).toBe(true);
  });

  test("'Pour aller plus loin' is gone", () => {
    const r = suggestionsFor({ url: "https://www.youtube.com/watch?v=abc" });
    expect(r.items.some((i) => i.label === "Pour aller plus loin")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Google — results page only, several country TLDs
// ---------------------------------------------------------------------------
describe("Google", () => {
  test("google.com /search matches", () => {
    const r = suggestionsFor({ url: "https://www.google.com/search?q=x" });
    expect(r.site?.id).toBe("google");
    expect(r.siteKey).toBe("@google");
    expect(r.items.length).toBe(3);
  });

  test("google.co.uk /search matches", () => {
    const r = suggestionsFor({ url: "https://www.google.co.uk/search?q=x" });
    expect(r.site?.id).toBe("google");
  });

  for (const tld of ["fr", "de", "es", "it", "ca", "be", "nl"]) {
    test(`google.${tld} /search matches`, () => {
      const r = suggestionsFor({ url: `https://www.google.${tld}/search?q=x` });
      expect(r.site?.id).toBe("google");
    });
  }

  test("non-/search path on google.com: site recognized, no items", () => {
    const r = suggestionsFor({ url: "https://www.google.com/maps" });
    expect(r.site?.id).toBe("google");
    expect(r.siteKey).toBe("@google");
    expect(r.items).toEqual([]);
  });

  test("evil-google.com does not match", () => {
    const r = suggestionsFor({ url: "https://evil-google.com/search?q=x" });
    expect(r.site).toBeNull();
  });

  test("google.com.evil.net does not match", () => {
    const r = suggestionsFor({ url: "https://google.com.evil.net/search?q=x" });
    expect(r.site).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Wikipedia
// ---------------------------------------------------------------------------
describe("Wikipédia", () => {
  test("fr.wikipedia.org /wiki/... matches", () => {
    const r = suggestionsFor({ url: "https://fr.wikipedia.org/wiki/Coati" });
    expect(r.site?.id).toBe("wikipedia");
    expect(r.siteKey).toBe("@wikipedia");
    expect(r.items.length).toBe(3);
  });

  test("en.wikipedia.org matches too (any subdomain)", () => {
    const r = suggestionsFor({ url: "https://en.wikipedia.org/wiki/Coati" });
    expect(r.site?.id).toBe("wikipedia");
  });

  test("non-/wiki/ path: site recognized, no items", () => {
    const r = suggestionsFor({ url: "https://fr.wikipedia.org/w/index.php?search=x" });
    expect(r.site?.id).toBe("wikipedia");
    expect(r.items).toEqual([]);
  });

  test("evil-wikipedia.org does not match", () => {
    const r = suggestionsFor({ url: "https://evil-wikipedia.org/wiki/x" });
    expect(r.site).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Reddit — a thread only
// ---------------------------------------------------------------------------
describe("Reddit", () => {
  test("reddit.com /r/<sub>/comments/... matches", () => {
    const r = suggestionsFor({ url: "https://www.reddit.com/r/aww/comments/abc123/cute_thing/" });
    expect(r.site?.id).toBe("reddit");
    expect(r.siteKey).toBe("@reddit");
    expect(r.items.length).toBe(2);
  });

  test("old.reddit.com matches", () => {
    const r = suggestionsFor({ url: "https://old.reddit.com/r/aww/comments/abc123/cute_thing/" });
    expect(r.site?.id).toBe("reddit");
  });

  test("new.reddit.com matches", () => {
    const r = suggestionsFor({ url: "https://new.reddit.com/r/aww/comments/abc123/cute_thing/" });
    expect(r.site?.id).toBe("reddit");
  });

  test("subreddit listing (no /comments/): site recognized, no items", () => {
    const r = suggestionsFor({ url: "https://www.reddit.com/r/aww/" });
    expect(r.site?.id).toBe("reddit");
    expect(r.items).toEqual([]);
  });

  test("notreddit.com does not match", () => {
    const r = suggestionsFor({ url: "https://notreddit.com/r/aww/comments/1/x/" });
    expect(r.site).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Amazon — product pages only, several country TLDs
// ---------------------------------------------------------------------------
describe("Amazon", () => {
  test("amazon.fr /dp/... matches", () => {
    const r = suggestionsFor({ url: "https://www.amazon.fr/dp/B000123456" });
    expect(r.site?.id).toBe("amazon");
    expect(r.siteKey).toBe("@amazon");
    expect(r.items.length).toBe(2);
  });

  test("amazon.com /gp/product/... matches", () => {
    const r = suggestionsFor({ url: "https://www.amazon.com/gp/product/B000123456" });
    expect(r.site?.id).toBe("amazon");
  });

  for (const tld of ["de", "co.uk", "es", "it", "ca", "be", "nl"]) {
    test(`amazon.${tld} /dp/... matches`, () => {
      const r = suggestionsFor({ url: `https://www.amazon.${tld}/dp/B000123456` });
      expect(r.site?.id).toBe("amazon");
    });
  }

  test("non-product path on amazon.fr: site recognized, no items", () => {
    const r = suggestionsFor({ url: "https://www.amazon.fr/s?k=chaussures" });
    expect(r.site?.id).toBe("amazon");
    expect(r.items).toEqual([]);
  });

  test("amazon.fr.malicious.com does not match", () => {
    const r = suggestionsFor({ url: "https://amazon.fr.malicious.com/dp/B000" });
    expect(r.site).toBeNull();
  });

  test("evil-amazon.com does not match", () => {
    const r = suggestionsFor({ url: "https://evil-amazon.com/dp/B000" });
    expect(r.site).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// siteKeyFor
// ---------------------------------------------------------------------------
describe("siteKeyFor", () => {
  test("popular site → its @key, regardless of path", () => {
    expect(siteKeyFor("https://www.youtube.com/feed/subscriptions")).toBe("@youtube");
    expect(siteKeyFor("https://www.google.com/maps")).toBe("@google");
    expect(siteKeyFor("https://fr.wikipedia.org/w/index.php")).toBe("@wikipedia");
    expect(siteKeyFor("https://www.reddit.com/r/aww/")).toBe("@reddit");
    expect(siteKeyFor("https://www.amazon.fr/")).toBe("@amazon");
  });

  test("youtu.be → @youtube", () => {
    expect(siteKeyFor("https://youtu.be/abc")).toBe("@youtube");
  });

  test("user site: hostname, www. stripped", () => {
    expect(siteKeyFor("https://www.crisco4.unicaen.fr/page")).toBe("crisco4.unicaen.fr");
  });

  test("user site without www is unchanged", () => {
    expect(siteKeyFor("https://crisco4.unicaen.fr/page")).toBe("crisco4.unicaen.fr");
  });

  test("crisco4.unicaen.fr and unicaen.fr are two distinct keys", () => {
    expect(siteKeyFor("https://crisco4.unicaen.fr/")).not.toBe(siteKeyFor("https://unicaen.fr/"));
  });

  test("lower-cases the host", () => {
    expect(siteKeyFor("https://WWW.Example.COM/")).toBe("example.com");
  });

  test("null/undefined/unparsable/non-http(s) → null", () => {
    expect(siteKeyFor(null)).toBeNull();
    expect(siteKeyFor(undefined)).toBeNull();
    expect(siteKeyFor("not-a-url")).toBeNull();
    expect(siteKeyFor("ftp://example.com/")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// No "Résumer" chat-prompt label anywhere except the YouTube action item
// ---------------------------------------------------------------------------
describe("no stray Résumer label in data", () => {
  test("only YouTube's action item is named Résumer", () => {
    for (const site of SITES) {
      for (const item of site.items) {
        if (/résumer/i.test(item.label)) {
          expect(item.action).toBe("summarize");
        }
      }
    }
  });
});

// ---------------------------------------------------------------------------
// Exactly five sites, removed sites gone
// ---------------------------------------------------------------------------
describe("exactly five sites", () => {
  test("SITES has exactly youtube, google, wikipedia, reddit, amazon, in that order", () => {
    expect(SITES.map((s) => s.id)).toEqual(["youtube", "google", "wikipedia", "reddit", "amazon"]);
  });

  test("real-estate/leboncoin/shopping hosts are unrecognized", () => {
    for (const url of [
      "https://www.bienici.com/annonce/1",
      "https://seloger.com/annonce/1",
      "https://leboncoin.fr/annonce/1",
      "https://fr.aliexpress.com/item/1.html",
    ]) {
      const r = suggestionsFor({ url });
      expect(r.site).toBeNull();
      expect(r.items).toEqual([]);
    }
  });
});

// ---------------------------------------------------------------------------
// Return-shape contract
// ---------------------------------------------------------------------------
describe("return shape", () => {
  test("every item has a stable coati: id and a label; prompt xor action", () => {
    for (const site of SITES) {
      for (const item of site.items) {
        expect(item.id).toMatch(new RegExp(`^coati:${site.id}:[a-z0-9-]+$`));
        expect(typeof item.label).toBe("string");
        expect(item.label.length).toBeGreaterThan(0);
        expect(typeof item.prompt === "string" || item.action === "summarize").toBe(true);
      }
    }
  });

  test("item ids are unique across the whole dataset", () => {
    const ids = SITES.flatMap((s) => s.items.map((i) => i.id));
    expect(new Set(ids).size).toBe(ids.length);
  });
});

// ---------------------------------------------------------------------------
// permissionPatternsFor (docs/DECISIONS.md T42/T43)
// ---------------------------------------------------------------------------
describe("permissionPatternsFor", () => {
  test("popular site: every host over https, subdomains wildcarded except the short-link exception", () => {
    expect(permissionPatternsFor("@youtube")).toEqual(["https://*.youtube.com/*", "https://youtu.be/*"]);
    expect(permissionPatternsFor("@wikipedia")).toEqual(["https://*.wikipedia.org/*"]);
    expect(permissionPatternsFor("@reddit")).toEqual(["https://*.reddit.com/*"]);
  });

  test("Google and Amazon: one https pattern per TLD already in SITES", () => {
    const googleSite = SITES.find((s) => s.id === "google")!;
    expect(permissionPatternsFor("@google")).toEqual(googleSite.hosts.map((h) => `https://*.${h}/*`));
    const amazonSite = SITES.find((s) => s.id === "amazon")!;
    expect(permissionPatternsFor("@amazon")).toEqual(amazonSite.hosts.map((h) => `https://*.${h}/*`));
  });

  test("user hostname key: https and http patterns covering the host and its subdomains", () => {
    expect(permissionPatternsFor("crisco4.unicaen.fr")).toEqual([
      "https://*.crisco4.unicaen.fr/*",
      "http://*.crisco4.unicaen.fr/*",
    ]);
  });

  // Regression, 28/09: `*://` patterns were rejected by Chrome (« Only permissions specified in
  // the manifest may be requested ») because the manifests declare `http://*/*` and
  // `https://*/*` separately — nothing but YouTube could ever be activated. Every requested
  // pattern must use a scheme one of the declared optional patterns covers, in BOTH manifests.
  test("every pattern is requestable under both manifests' optional_host_permissions", () => {
    const { readFileSync } = require("node:fs");
    const { join } = require("node:path");
    const extDir = join(import.meta.dir, "..", "..", "extension");
    const keys = ["@youtube", "@google", "@wikipedia", "@reddit", "@amazon", "crisco4.unicaen.fr"];
    for (const manifestName of ["manifest.json", "manifest.firefox.json"]) {
      const manifest = JSON.parse(readFileSync(join(extDir, manifestName), "utf8"));
      const declaredSchemes = (manifest.optional_host_permissions as string[]).map((p) => p.split("://")[0]);
      for (const key of keys) {
        for (const pattern of permissionPatternsFor(key)) {
          const scheme = pattern.split("://")[0];
          expect(scheme).not.toBe("*");
          expect(declaredSchemes).toContain(scheme);
        }
      }
    }
  });

  test("'*', '@unsorted', null, unknown popular id: no pattern to request", () => {
    expect(permissionPatternsFor("*")).toEqual([]);
    expect(permissionPatternsFor("@unsorted")).toEqual([]);
    expect(permissionPatternsFor(null)).toEqual([]);
    expect(permissionPatternsFor(undefined)).toEqual([]);
    expect(permissionPatternsFor("@not-a-real-site")).toEqual([]);
  });
});
