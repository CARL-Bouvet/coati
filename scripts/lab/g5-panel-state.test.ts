// G5 (docs/DECISIONS.md T50/T51) — pure state of the encart's "Lire cette
// page" button and of the first-launch card, plus the static invariants of
// voie B (manifests, welcome page on install only, fingerprint lists).
// Lives under scripts/lab/ only because broker/** had another owner while
// G5 was built; it can move to broker/test/ unchanged (paths are root-based).
import { describe, expect, test } from "bun:test";
import { readFileSync, existsSync } from "fs";
import { join } from "path";
import {
  readButtonState,
  ALL_SITES_ORIGINS,
  READ_BUTTON_TEXT,
} from "../../extension/panel/read-button.js";
import { firstRunChecks, markFor } from "../../extension/panel/first-run.js";

const ROOT = join(import.meta.dir, "..", "..");
const EXT = join(ROOT, "extension");

const base = {
  allSitesGranted: false,
  siteGranted: false,
  sitePatternsKnown: false,
  declined: false,
  used: false,
  reading: false,
  pageReadable: false,
};

describe("readButtonState (T50)", () => {
  test("invites and breathes on a page it can't read, first time", () => {
    const view = readButtonState(base);
    expect(view.state).toBe("invite");
    expect(view.request).toBe("all-sites");
    expect(view.label).toBe(READ_BUTTON_TEXT.invite);
    expect(view.animate).toBe(true);
  });

  test("stops breathing for good once a read through it succeeded", () => {
    const view = readButtonState({ ...base, used: true });
    expect(view.state).toBe("invite");
    expect(view.animate).toBe(false);
  });

  test("hidden once all sites or this site is granted", () => {
    expect(readButtonState({ ...base, allSitesGranted: true }).state).toBeNull();
    expect(readButtonState({ ...base, siteGranted: true, sitePatternsKnown: true }).state).toBeNull();
  });

  test("hidden on a page another gesture just read, unless all sites was declined", () => {
    expect(readButtonState({ ...base, pageReadable: true }).state).toBeNull();
    const declined = readButtonState({ ...base, pageReadable: true, declined: true, sitePatternsKnown: true });
    expect(declined.state).toBe("refused");
    expect(declined.request).toBe("site");
  });

  test("reading: the spinning state, whatever the permissions say", () => {
    const view = readButtonState({ ...base, reading: true, allSitesGranted: true });
    expect(view.state).toBe("reading");
    expect(view.request).toBeNull();
    expect(view.animate).toBe(false);
  });

  test("refused, address known: falls back to per-site activation, no motion", () => {
    const view = readButtonState({ ...base, declined: true, sitePatternsKnown: true });
    expect(view.state).toBe("refused");
    expect(view.request).toBe("site");
    expect(view.label).toBe(READ_BUTTON_TEXT.activateSite);
    expect(view.note).not.toBe("");
    expect(view.animate).toBe(false);
  });

  test("refused, address unknown: only all sites can be asked again, on a click", () => {
    const view = readButtonState({ ...base, declined: true });
    expect(view.state).toBe("refused");
    expect(view.request).toBe("all-sites");
    expect(view.animate).toBe(false);
  });

  test("the all-sites request uses explicit schemes, never *:// or <all_urls>", () => {
    expect(ALL_SITES_ORIGINS).toEqual(["http://*/*", "https://*/*"]);
  });
});

describe("firstRunChecks (T51)", () => {
  const facts = { connState: "connected", providerState: null, modelAnswered: false, pageAccess: false };

  test("no-host: program missing, model waits for it", () => {
    const c = firstRunChecks({ ...facts, connState: "no-host" });
    expect(c.program).toBe("missing");
    expect(c.model).toBe("waiting");
    expect(markFor(c.model)).toBe("pending");
    expect(c.allMet).toBe(false);
  });

  test("still connecting: program pending", () => {
    for (const s of ["connecting", "disconnected", "unknown", "handshake-timeout"]) {
      expect(firstRunChecks({ ...facts, connState: s }).program).toBe("pending");
    }
  });

  test("a key came back from the native host: program ok", () => {
    for (const s of ["connected", "handshaking", "no-token", "broker-untrusted"]) {
      expect(firstRunChecks({ ...facts, connState: s }).program).toBe("ok");
    }
  });

  test("model: ok from provider.status or from a first complete answer", () => {
    expect(firstRunChecks({ ...facts, providerState: "ok" }).model).toBe("ok");
    expect(firstRunChecks({ ...facts, providerState: "ko", modelAnswered: true }).model).toBe("ok");
    expect(firstRunChecks({ ...facts, providerState: "ko" }).model).toBe("missing");
    expect(firstRunChecks({ ...facts, providerState: "unknown" }).model).toBe("missing");
    expect(firstRunChecks(facts).model).toBe("pending");
  });

  test("all three met only with program, model and page access", () => {
    expect(firstRunChecks({ ...facts, providerState: "ok" }).allMet).toBe(false);
    expect(firstRunChecks({ ...facts, providerState: "ok", pageAccess: true }).allMet).toBe(true);
  });
});

describe("voie B — static invariants", () => {
  for (const name of ["manifest.json", "manifest.firefox.json"]) {
    test(`${name}: all sites optional, no tabs, no <all_urls>, no mandatory host permission`, () => {
      const manifest = JSON.parse(readFileSync(join(EXT, name), "utf8"));
      expect(manifest.optional_host_permissions).toEqual(expect.arrayContaining(ALL_SITES_ORIGINS));
      expect(manifest.permissions).not.toContain("tabs");
      expect(JSON.stringify(manifest)).not.toContain("<all_urls>");
      expect(JSON.stringify(manifest)).not.toContain("*://");
      expect(manifest.host_permissions ?? []).toEqual([]);
    });
  }

  test("the welcome page opens on a fresh install only", () => {
    const sw = readFileSync(join(EXT, "background", "service-worker.js"), "utf8");
    expect(sw).toMatch(/if \(details\?\.reason === "install"\)/);
    expect(existsSync(join(EXT, "welcome", "welcome.html"))).toBe(true);
  });

  test("the read button asks for the permission before any await (Firefox gesture rule)", () => {
    const panel = readFileSync(join(EXT, "panel", "panel.js"), "utf8");
    const start = panel.indexOf("function onReadPageClick()");
    const body = panel.slice(start, panel.indexOf("\n}\n", start));
    expect(start).toBeGreaterThan(-1);
    expect(body).not.toContain("await");
    expect(body.indexOf("api.permissions.request")).toBeGreaterThan(-1);
  });

  test("every new G5 file is fingerprinted", () => {
    const fp = readFileSync(join(EXT, "lib", "build-fingerprint.js"), "utf8");
    for (const f of [
      "panel/read-button.js",
      "panel/first-run.js",
      "welcome/welcome.html",
      "welcome/welcome.css",
      "welcome/welcome.js",
      "lib/model-provider-presets.js",
    ]) {
      expect(fp).toContain(`"${f}"`);
    }
  });
});

describe("Mes prompts under an \"all sites\" grant (T42, amendement 30/09 bis)", () => {
  const src = readFileSync(join(EXT, "prompts", "prompts.js"), "utf8");

  test("the way back removes exactly the two all-sites patterns, nothing per-site", () => {
    const start = src.indexOf("function revokeAllSites()");
    const body = src.slice(start, src.indexOf("\n}\n", start));
    expect(start).toBeGreaterThan(-1);
    expect(body).toContain("remove({ origins: ALL_SITES_ORIGINS })");
    expect(body).not.toContain("permissionPatternsFor");
  });

  test("locked switches: on, aria-disabled, described by the notice, clicks ignored", () => {
    expect(src).toMatch(/if \(allSitesGranted\) \{\s*btn\.setAttribute\("aria-checked", "true"\)/);
    expect(src).toContain('btn.setAttribute("aria-describedby", "allSitesText")');
    expect(src).toMatch(/handleActiveSwitchClick\(btn\) \{\s*if \(btn\.getAttribute\("aria-disabled"\) === "true"\) return;/);
    const html = readFileSync(join(EXT, "prompts", "prompts.html"), "utf8");
    expect(html).toContain('id="allSitesText"');
    expect(html).toContain('id="allSitesRevoke"');
  });
});
