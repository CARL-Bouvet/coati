// Unit tests for the site card's pure state logic (T27-T29). Lives under
// extension/panel/ (DOM-free pure JS), same pattern as ui-scroll.test.ts.
import { describe, expect, test } from "bun:test";
import { cardState, faviconSrc, hostFromUrl, spinnerVisible, SPINNER_DELAY_MS } from "../../extension/panel/card-state.js";

describe("cardState", () => {
  test("unreadable when no url is known", () => {
    expect(cardState({ url: null, site: null })).toBe("unreadable");
  });

  test("known when the url is readable and a site matched", () => {
    expect(cardState({ url: "https://example.com/a", site: { id: "example", name: "Example" } })).toBe("known");
  });

  test("unknown when the url is readable but no site matched", () => {
    expect(cardState({ url: "https://example.com/a", site: null })).toBe("unknown");
  });
});

describe("hostFromUrl", () => {
  test("extracts the hostname", () => {
    expect(hostFromUrl("https://example.com/a/b?c=1")).toBe("example.com");
  });

  test("null for a missing url", () => {
    expect(hostFromUrl(null)).toBeNull();
    expect(hostFromUrl(undefined)).toBeNull();
    expect(hostFromUrl("")).toBeNull();
  });

  test("null for an unparsable url", () => {
    expect(hostFromUrl("not a url")).toBeNull();
  });
});

describe("spinnerVisible", () => {
  test("false before the delay elapses", () => {
    expect(spinnerVisible(SPINNER_DELAY_MS - 1)).toBe(false);
  });

  test("true once the delay elapses", () => {
    expect(spinnerVisible(SPINNER_DELAY_MS)).toBe(true);
  });

  test("true well past the delay", () => {
    expect(spinnerVisible(SPINNER_DELAY_MS + 500)).toBe(true);
  });
});

describe("faviconSrc (T28: never a request to an address the page chose)", () => {
  const getURL = (path: string) => `chrome-extension://id${path}`;

  test("Chromium: the extension's _favicon endpoint, page url encoded", () => {
    expect(faviconSrc({ pageUrl: "https://www.youtube.com/watch?v=a&t=1", favIconUrl: "https://tracker.example/x.ico", isGecko: false, getURL }))
      .toBe("chrome-extension://id/_favicon/?pageUrl=https%3A%2F%2Fwww.youtube.com%2Fwatch%3Fv%3Da%26t%3D1&size=32");
  });

  test("Firefox: an inline data: favicon is kept", () => {
    expect(faviconSrc({ pageUrl: "https://example.com/", favIconUrl: "data:image/png;base64,AAAA", isGecko: true, getURL }))
      .toBe("data:image/png;base64,AAAA");
  });

  test("Firefox: a remote favicon is skipped", () => {
    expect(faviconSrc({ pageUrl: "https://example.com/", favIconUrl: "https://tracker.example/x.ico", isGecko: true, getURL })).toBeNull();
  });

  test("no readable page url: no icon", () => {
    expect(faviconSrc({ pageUrl: null, favIconUrl: "data:image/png;base64,AAAA", isGecko: true, getURL })).toBeNull();
    expect(faviconSrc({ pageUrl: undefined, favIconUrl: undefined, isGecko: false, getURL })).toBeNull();
  });
});
