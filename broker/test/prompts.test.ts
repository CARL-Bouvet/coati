import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { listPrompts, savePrompt, deletePrompt, setPromptSite, type PromptsDirs } from "../src/prompts.ts";

let dirs: PromptsDirs;

beforeEach(() => {
  const dataDir = mkdtempSync(join(tmpdir(), "coati-prompts-"));
  dirs = { dataDir };
});

afterEach(() => {
  rmSync(dirs.dataDir, { recursive: true, force: true });
});

describe("prompts library round-trip", () => {
  test("starts empty — no DEFAULT_PROMPTS anymore", () => {
    expect(listPrompts(dirs)).toEqual([]);
  });

  test("save without id creates, assigns a p_<12 hex> id", async () => {
    const items = await savePrompt(dirs, { site: "@youtube", title: "Greeting", body: "Say hi" });
    expect(items.length).toBe(1);
    expect(items[0]!.id).toMatch(/^p_[0-9a-f]{12}$/);
    expect(items[0]).toEqual({ id: items[0]!.id, site: "@youtube", title: "Greeting", body: "Say hi" });
  });

  test("save without title omits it (no empty title persisted)", async () => {
    const items = await savePrompt(dirs, { site: "*", body: "body only" });
    expect(items[0]).toEqual({ id: items[0]!.id, site: "*", body: "body only" });
  });

  test("save with an existing id updates title/body, leaves site and id unchanged", async () => {
    const created = await savePrompt(dirs, { site: "@youtube", title: "A", body: "B" });
    const id = created[0]!.id;
    const updated = await savePrompt(dirs, { id, site: "@google", title: "A2", body: "B2" });
    expect(updated).toEqual([{ id, site: "@youtube", title: "A2", body: "B2" }]);
  });

  test("save with an existing id and no title clears a previously-set title", async () => {
    const created = await savePrompt(dirs, { site: "*", title: "A", body: "B" });
    const id = created[0]!.id;
    const updated = await savePrompt(dirs, { id, site: "*", body: "B2" });
    expect(updated).toEqual([{ id, site: "*", body: "B2" }]);
  });

  test("save with an unknown id rejects (does not silently create)", async () => {
    await expect(savePrompt(dirs, { id: "p_ffffffffffff", site: "*", body: "b" })).rejects.toThrow();
    expect(listPrompts(dirs)).toEqual([]);
  });

  test("delete removes the prompt by id", async () => {
    const [a] = await savePrompt(dirs, { site: "*", body: "A" });
    await savePrompt(dirs, { site: "*", body: "B" });
    const left = await deletePrompt(dirs, a!.id);
    expect(left.length).toBe(1);
    expect(left[0]!.body).toBe("B");
  });

  test("delete of an absent id is idempotent — no-op, no error, full list returned", async () => {
    const [a] = await savePrompt(dirs, { site: "*", body: "A" });
    const result = await deletePrompt(dirs, "p_000000000000");
    expect(result).toEqual([a]);
    const again = await deletePrompt(dirs, "p_000000000000");
    expect(again).toEqual([a]);
  });

  test("persists across fresh reads of the same dir", async () => {
    await savePrompt(dirs, { site: "@youtube", body: "Say hi" });
    const reread = listPrompts({ dataDir: dirs.dataDir });
    expect(reread.length).toBe(1);
    expect(reread[0]!.body).toBe("Say hi");
  });

  test("concurrent saves of distinct prompts all land, none lost to a race", async () => {
    const N = 20;
    await Promise.all(Array.from({ length: N }, (_, i) => savePrompt(dirs, { site: "*", body: `body ${i}` })));
    const items = listPrompts(dirs);
    expect(items.length).toBe(N);
    const ids = new Set(items.map((p) => p.id));
    expect(ids.size).toBe(N); // every id distinct — no reuse
  });

  test("setPromptSite moves a prompt to another site, keeps its id and body", async () => {
    const [a] = await savePrompt(dirs, { site: "@youtube", body: "A" });
    const items = setPromptSite(dirs, a!.id, "crisco4.unicaen.fr");
    expect(items).toEqual([{ id: a!.id, site: "crisco4.unicaen.fr", body: "A" }]);
  });

  test("setPromptSite throws on an unknown id", () => {
    expect(() => setPromptSite(dirs, "p_000000000000", "*")).toThrow();
  });

  test("@unsorted (reserved site key, unknown page address): save and move both work", async () => {
    const items = await savePrompt(dirs, { site: "@unsorted", body: "Saved from an unknown page" });
    expect(items[0]).toEqual({ id: items[0]!.id, site: "@unsorted", body: "Saved from an unknown page" });
    const moved = setPromptSite(dirs, items[0]!.id, "@youtube");
    expect(moved).toEqual([{ id: items[0]!.id, site: "@youtube", body: "Saved from an unknown page" }]);
  });
});

describe("atomic write", () => {
  test("leaves no temp files behind after a save", async () => {
    await savePrompt(dirs, { site: "*", body: "x" });
    const leftover = readdirSync(dirs.dataDir).filter((f) => f.includes(".tmp"));
    expect(leftover).toEqual([]);
  });

  test("writes prompts-v2.json with a version envelope", async () => {
    await savePrompt(dirs, { site: "*", body: "x" });
    const raw = JSON.parse(readFileSync(join(dirs.dataDir, "prompts-v2.json"), "utf8"));
    expect(raw.version).toBe(2);
    expect(Array.isArray(raw.prompts)).toBe(true);
  });
});

describe("old flat prompts.json is ignored, never touched", () => {
  test("presence of an old-format prompts.json does not surface in listPrompts, and the file is untouched byte-for-byte", async () => {
    const oldPath = join(dirs.dataDir, "prompts.json");
    const oldContent = JSON.stringify([{ name: "Traduire en français", body: "..." }], null, 2) + "\n";
    writeFileSync(oldPath, oldContent);

    expect(listPrompts(dirs)).toEqual([]);

    await savePrompt(dirs, { site: "*", body: "new one" });
    await deletePrompt(dirs, "p_000000000000");

    expect(readFileSync(oldPath, "utf8")).toBe(oldContent);
  });
});
