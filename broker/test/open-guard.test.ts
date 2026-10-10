import { describe, expect, test } from "bun:test";
// @ts-ignore plain browser JS
import { checkOpen, isLocalHostname } from "../../extension/lib/open-guard.js";

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
