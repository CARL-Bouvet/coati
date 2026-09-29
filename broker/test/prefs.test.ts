import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getPrefs, setSitePrefs, moveInPrefs, type PrefsDirs } from "../src/prefs.ts";
import { savePrompt, setPromptSite, type PromptsDirs } from "../src/prompts.ts";

let dirs: PrefsDirs & PromptsDirs;

beforeEach(() => {
  const dataDir = mkdtempSync(join(tmpdir(), "coati-prefs-"));
  dirs = { dataDir };
});

afterEach(() => {
  rmSync(dirs.dataDir, { recursive: true, force: true });
});

describe("prefs.get / prefs.set round-trip", () => {
  test("empty at install", () => {
    expect(getPrefs(dirs)).toEqual({});
  });

  test("set then get returns the site entry", async () => {
    const sites = await setSitePrefs(dirs, "@youtube", {
      order: ["coati:youtube:key-points", "p_000000000000"],
      removed: ["coati:youtube:further"],
    });
    expect(sites["@youtube"]).toEqual({
      order: ["coati:youtube:key-points", "p_000000000000"],
      removed: ["coati:youtube:further"],
    });
    expect(getPrefs(dirs)).toEqual(sites);
  });

  test("set replaces the whole entry — a field present replaces, does not merge", async () => {
    await setSitePrefs(dirs, "@youtube", { order: ["p_000000000000"], removed: ["coati:youtube:further"] });
    const sites = await setSitePrefs(dirs, "@youtube", { order: ["coati:youtube:key-points"] });
    // removed untouched (field omitted)
    expect(sites["@youtube"]).toEqual({
      order: ["coati:youtube:key-points"],
      removed: ["coati:youtube:further"],
    });
  });

  test("set with removed: [] clears removed while leaving order", async () => {
    await setSitePrefs(dirs, "@youtube", { order: ["p_000000000000"], removed: ["coati:youtube:further"] });
    const sites = await setSitePrefs(dirs, "@youtube", { removed: [] });
    expect(sites["@youtube"]).toEqual({ order: ["p_000000000000"] });
  });

  test("an entry left empty (both fields empty) is deleted, not persisted empty", async () => {
    await setSitePrefs(dirs, "@youtube", { order: ["p_000000000000"] });
    const sites = await setSitePrefs(dirs, "@youtube", { order: [] });
    expect(sites["@youtube"]).toBeUndefined();
    expect(getPrefs(dirs)).toEqual({});
  });

  test("dedupes items within order/removed", async () => {
    const sites = await setSitePrefs(dirs, "*", { order: ["p_000000000000", "p_000000000000"] });
    expect(sites["*"]!.order).toEqual(["p_000000000000"]);
  });
});

describe("atomic write", () => {
  test("leaves no temp files behind", async () => {
    await setSitePrefs(dirs, "*", { order: ["p_000000000000"] });
    const leftover = readdirSync(dirs.dataDir).filter((f) => f.includes(".tmp"));
    expect(leftover).toEqual([]);
  });

  test("writes prefs.json with a version envelope", async () => {
    await setSitePrefs(dirs, "*", { order: ["p_000000000000"] });
    const raw = JSON.parse(readFileSync(join(dirs.dataDir, "prefs.json"), "utf8"));
    expect(raw.version).toBe(1);
    expect(typeof raw.sites).toBe("object");
  });
});

describe("tolerant read", () => {
  test("corrupt prefs.json falls back to empty, never throws", () => {
    writeFileSync(join(dirs.dataDir, "prefs.json"), "{not json");
    expect(getPrefs(dirs)).toEqual({});
  });

  test("unknown shape falls back to empty", () => {
    writeFileSync(join(dirs.dataDir, "prefs.json"), JSON.stringify({ version: 1, sites: "nope" }));
    expect(getPrefs(dirs)).toEqual({});
  });

  test("a malformed site key in the file is dropped, valid ones kept", () => {
    writeFileSync(
      join(dirs.dataDir, "prefs.json"),
      JSON.stringify({
        version: 1,
        sites: { "www.bad.com": { order: ["p_000000000000"] }, "*": { order: ["p_000000000000"] } },
      }),
    );
    const sites = getPrefs(dirs);
    expect(sites["www.bad.com"]).toBeUndefined();
    expect(sites["*"]).toEqual({ order: ["p_000000000000"] });
  });
});

describe("prompts.move — updates both prompts-v2.json and prefs.json", () => {
  test("moves the prompt's site, removes it from the source order, sets the destination order", async () => {
    const [a] = await savePrompt(dirs, { site: "@youtube", body: "A" });
    await setSitePrefs(dirs, "@youtube", { order: [a!.id, "coati:youtube:key-points"] });

    const items = setPromptSite(dirs, a!.id, "crisco4.unicaen.fr");
    expect(items[0]!.site).toBe("crisco4.unicaen.fr");

    const sites = moveInPrefs(dirs, a!.id, "crisco4.unicaen.fr", [a!.id]);
    expect(sites["@youtube"]).toEqual({ order: ["coati:youtube:key-points"] });
    expect(sites["crisco4.unicaen.fr"]).toEqual({ order: [a!.id] });
  });

  test("source site entry is dropped entirely if it becomes empty", async () => {
    const [a] = await savePrompt(dirs, { site: "@youtube", body: "A" });
    await setSitePrefs(dirs, "@youtube", { order: [a!.id] });

    setPromptSite(dirs, a!.id, "*");
    const sites = moveInPrefs(dirs, a!.id, "*", [a!.id]);
    expect(sites["@youtube"]).toBeUndefined();
    expect(sites["*"]).toEqual({ order: [a!.id] });
  });
});
