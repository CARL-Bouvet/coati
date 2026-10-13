import { describe, expect, test } from "bun:test";
// @ts-ignore plain browser JS
import { checkOpen, isLocalHostname } from "../../extension/lib/open-guard.js";
// @ts-ignore plain browser JS
import { linkContext, linkVerdict, openedPageReadable } from "../../extension/lib/link-safety.js";
// @ts-ignore plain browser JS
import { pageReadIn, readUntrustedIn } from "../../extension/panel/history.js";

describe("linkVerdict (docs/DECISIONS.md T61)", () => {
  const sources = ["https://github.com/comfyanonymous/ComfyUI/", "https://www.google.com/search"];
  const afterRead = linkContext(sources, "https://example.org/page", true);
  const nothingRead = linkContext([], null, false);
  const v = (href: string, ctx = afterRead, label = "x") => linkVerdict(href, label, ctx);

  test("only plain https to a domain name", () => {
    for (const href of [
      "javascript:alert(1)",
      "data:text/html,<b>x</b>",
      "http://github.com/comfyanonymous/ComfyUI",
      "https://93.184.216.34/",
      "https://[2606:4700::1]/",
      "https://github.com:8443/",
      "https://user@github.com/",
      "https://localhost/",
      "https://printer.local/",
      "https://wiki.internal/",
      `https://example.com/${"a".repeat(2048)}`,
    ]) {
      expect(v(href, nothingRead)).toMatchObject({ verdict: "refused", reason: "form" });
    }
  });

  test("a source link is clickable; a trailing slash does not matter", () => {
    expect(v("https://github.com/comfyanonymous/ComfyUI")).toEqual({ verdict: "clickable", host: "github.com" });
    expect(v("https://example.org/page")).toEqual({ verdict: "clickable", host: "example.org" });
  });

  test("a fragment the source does not carry makes the link a non-source", () => {
    expect(v("https://github.com/comfyanonymous/ComfyUI/#readme")).toMatchObject({ verdict: "refused", reason: "not-in-sources" });
    expect(v("https://example.org/page#c2VjcmV0")).toMatchObject({ verdict: "refused", reason: "not-in-sources" });
    expect(v("https://example.org/page#c2VjcmV0", nothingRead).verdict).toBe("memory");
    const withFragment = linkContext(["https://docs.example.net/guide#install"], null, true);
    expect(v("https://docs.example.net/guide#install", withFragment).verdict).toBe("clickable");
    expect(v("https://docs.example.net/guide#other", withFragment).verdict).toBe("refused");
  });

  test("absent from the sources: refused after a read, from memory otherwise", () => {
    expect(v("https://other.org/x")).toEqual({ verdict: "refused", reason: "not-in-sources", host: "other.org" });
    expect(v("https://other.org/x", nothingRead)).toEqual({ verdict: "memory", host: "other.org" });
  });

  test("the host is shown as URL gives it: punycode stays punycode", () => {
    expect(v("https://аpple.com/", nothingRead).host).toBe("xn--pple-43d.com");
  });

  test("look-alikes of a source or of the current page are refused", () => {
    expect(v("https://githuh.com/x")).toMatchObject({ verdict: "refused", reason: "lookalike", like: "github.com" });
    expect(v("https://gooogle.fr/")).toMatchObject({ verdict: "refused", reason: "lookalike", like: "www.google.com" });
    expect(v("https://example.net/")).toMatchObject({ verdict: "refused", reason: "lookalike", like: "example.org" });
    const page = linkContext([], "https://github.com/", false);
    expect(v("https://github.co/", page).reason).toBe("lookalike");
    expect(v("https://gist.github.com/x", page).verdict).toBe("memory");
    expect(v("https://gitlab.com/x", page).verdict).toBe("memory");
    expect(v("https://ign.com/", linkContext([], "https://ibm.com/", false)).verdict).toBe("memory");
  });

  test("a file name label is not a domain", () => {
    expect(v("https://github.com/comfyanonymous/ComfyUI", afterRead, "README.md").verdict).toBe("clickable");
  });

  test("a label naming another domain is refused", () => {
    expect(v("https://evil.com/", nothingRead, "paypal.com")).toMatchObject({ verdict: "refused", reason: "misleading-label" });
    expect(v("https://evil.com/", nothingRead, "https://paypal.com/login").reason).toBe("misleading-label");
    expect(v("https://github.com/comfyanonymous/ComfyUI", afterRead, "github.com/comfyanonymous/ComfyUI").verdict).toBe("clickable");
    expect(v("https://nodejs.org/", nothingRead, "Node.js").verdict).toBe("memory");
  });
});

const PUBLIC = "https://example.com/page";
const verdict = (from: string, to: string, level = "text") => checkOpen(from, to, level).verdict;

describe("checkOpen: public source", () => {
  test("public target is ok", () => expect(verdict(PUBLIC, "https://other.org/x")).toBe("ok"));
  test("http target warns", () => expect(verdict(PUBLIC, "http://other.org/x")).toBe("warn-http"));

  test.each([
    "http://localhost:3000/",
    "https://app.localhost/",
    "http://127.0.0.1/",
    "http://10.1.2.3/",
    "http://172.16.0.5/",
    "http://172.31.255.255/",
    "http://192.168.1.1/",
    "http://169.254.169.254/latest",
    "http://[::1]/",
    "http://[fc00::1]/",
    "http://[fd12:3456::1]/",
    "http://[fe80::1]/",
    "http://[::ffff:7f00:1]/",
    "http://[::ffff:192.168.0.1]/",
    "http://printer.local/",
    "https://svc.internal/",
    "http://localhost./",
    "http://LOCALHOST/",
    "http://2130706433/", // decimal 127.0.0.1
    "http://0x7f.1/", // hex
    "http://0x7f000001/",
    "http://0177.0.0.1/", // octal
    "http://017700000001/",
    "http://127.1/",
  ])("blocks %s", (to) => {
    const r = checkOpen(PUBLIC, to, "text");
    expect(r.verdict).toBe("blocked");
    expect(r.reason).toBe("local-address");
  });

  test.each(["http://172.32.0.1/", "http://8.8.8.8/", "https://[2001:4860:4860::8888]/", "https://[::ffff:8.8.8.8]/"])(
    "does not block public address %s",
    (to) => expect(verdict(PUBLIC, to)).not.toBe("blocked"),
  );
});

describe("checkOpen: local source", () => {
  test("same site is ok", () => expect(verdict("https://app.local/a", "https://app.local/b")).toBe("ok"));
  test("same site, other port, http warns", () =>
    expect(verdict("http://localhost:3000/", "http://localhost:8080/x")).toBe("warn-http"));
  test("other local host is blocked", () =>
    expect(verdict("http://localhost:3000/", "http://192.168.1.1/")).toBe("blocked"));
  test("public target is ok", () => expect(verdict("http://localhost/", "https://example.com/")).toBe("ok"));
});

describe("checkOpen: schemes and levels", () => {
  test.each(["javascript:alert(1)", "file:///etc/passwd", "data:text/html,x", "chrome://settings", "ftp://example.com/", "blob:https://example.com/x"])(
    "blocks scheme of %s at both levels",
    (to) => {
      expect(checkOpen(PUBLIC, to, "text").reason).toBe("scheme");
      expect(checkOpen(PUBLIC, to, "dev").verdict).toBe("blocked");
    },
  );
  test("invalid url is blocked", () => expect(verdict(PUBLIC, "not a url")).toBe("blocked"));
  test("dev level allows local targets from a public page", () => {
    expect(verdict(PUBLIC, "https://127.0.0.1/", "dev")).toBe("ok");
    expect(verdict(PUBLIC, "http://[fe80::1]/", "dev")).toBe("warn-http");
  });
  test("non-web source counts as public", () =>
    expect(verdict("chrome://newtab", "http://127.0.0.1/")).toBe("blocked"));
});

describe("isLocalHostname", () => {
  test("names", () => {
    expect(isLocalHostname("a.b.localhost")).toBe(true);
    expect(isLocalHostname("x.home.arpa")).toBe(true);
    expect(isLocalHostname("notlocal.com")).toBe(false);
    expect(isLocalHostname("locally.example")).toBe(false);
  });
});

describe("openedPageReadable: final address of an opened result", () => {
  const guard = (url: string) => checkOpen("https://example.com/page", url, "text");
  const readable = (final: unknown, result = "https://shop.example.org/a") => openedPageReadable(guard, result, final);

  test("same site stays readable: www, http to https, other path", () => {
    expect(readable("https://shop.example.org/b?x=1#y")).toBe(true);
    expect(readable("https://www.example.org/a")).toBe(true);
    expect(readable("https://shop.example.org/a", "http://shop.example.org/a")).toBe(true);
    expect(readable("https://www.bbc.co.uk/n", "https://bbc.co.uk/n")).toBe(true);
  });

  test("a redirect to another site, a private address or a non-web page is not read", () => {
    expect(readable("https://attacker.example/x")).toBe(false);
    expect(readable("http://127.0.0.1:11434/api/tags")).toBe(false);
    expect(readable("http://192.168.1.1/")).toBe(false);
    expect(readable("chrome-error://chromewebdata/")).toBe(false);
    expect(readable("about:blank")).toBe(false);
    expect(readable(undefined)).toBe(false);
  });

  test("a local result address stays read-blocked even in dev: the sites differ", () => {
    const devGuard = (url: string) => checkOpen("https://example.com/", url, "dev");
    expect(openedPageReadable(devGuard, "https://example.org/a", "http://127.0.0.1/")).toBe(false);
  });
});

describe("conversation flags", () => {
  test("pageReadIn: only a real read counts, earlier turns included", () => {
    expect(pageReadIn([])).toBe(false);
    expect(pageReadIn([{ pageOnDemand: true }, { searchMention: {} }, { sources: [{ n: 1 }] }])).toBe(false);
    expect(pageReadIn([{ readsPage: true }, { text: "later" }])).toBe(true);
    expect(pageReadIn([{ pageRead: true }])).toBe(true);
  });

  test("metadata-only turn: links stay 'from memory' unless the offered title names their domain", () => {
    expect(readUntrustedIn([{ role: "assistant", pageOnDemand: true }])).toBe(false);
    const ctx = linkContext([], "https://example.org/", false, "Support officiel — ouvrez https://Evil.example/fix");
    expect(linkVerdict("https://evil.example/fix", "fix", ctx)).toMatchObject({ verdict: "refused", reason: "not-in-sources" });
    expect(linkVerdict("https://github.com/oven-sh/bun", "bun", ctx)).toMatchObject({ verdict: "memory" });
  });
});
