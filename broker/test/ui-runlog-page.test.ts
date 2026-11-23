// Run-log page rendering (extension/runlog/runlog-render.js) against a minimal
// document stand-in, plus the "never innerHTML" rule on the page sources.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "fs";
import { join } from "path";
import { renderNote, renderRun, renderRuns } from "../../extension/runlog/runlog-render.js";

class FakeNode {
  className = "";
  textContent = "";
  children: FakeNode[] = [];
  constructor(public tag: string) {}
  appendChild(c: FakeNode) { this.children.push(c); return c; }
  replaceChildren(...c: FakeNode[]) { this.children = c; }
  all(): FakeNode[] { return [this, ...this.children.flatMap((c) => c.all())]; }
  text(): string { return this.textContent + this.children.map((c) => c.text()).join(" "); }
}
const doc = { createElement: (tag: string) => new FakeNode(tag) };
const has = (n: FakeNode, cls: string) => n.all().filter((x) => x.className.split(" ").includes(cls));

const run = {
  startedAt: 0, ms: 20000, provider: "ollama", model: "m1", question: "Why <b>so</b>?",
  steps: [
    { t: 0, ms: 5000, kind: "call", n: 1, inputTokens: 2000, outputTokens: 300, stop: "marker", reasoning: "thinking <i>hard</i>", marker: { type: "search", query: "q" }, decision: "accepted" },
    { t: 5000, ms: 900, kind: "search", answer: "results", results: 4 },
    { t: 6000, ms: 800, kind: "open", answer: "pages", pages: [{ n: 1, title: "T", host: "h.example", chars: 5000 }] },
    { t: 7000, ms: 4000, kind: "call", n: 2, inputTokens: 3000, outputTokens: 100, stop: "marker", marker: { type: "open", refs: [9] }, decision: "refused", reason: "pages" },
    { t: 11000, ms: 3000, kind: "call", n: 3, uncounted: true, stop: "answer" },
  ],
  limits: { refused: [{ kind: "open", reason: "pages", count: 1, limit: 6 }] },
};

describe("renderRun", () => {
  const root = new FakeNode("main");
  renderRun(doc, root, run);

  test("one row per step, in order", () => {
    const steps = has(root, "runlog-step");
    expect(steps.length).toBe(5);
    expect(steps.map((s) => s.className.includes("--call"))).toEqual([true, false, false, true, true]);
  });

  test("model text stays text, never markup", () => {
    expect(root.text()).toContain("Why <b>so</b>?");
    expect(has(root, "runlog-reasoning-text")[0].tag).toBe("pre");
    expect(has(root, "runlog-reasoning-text")[0].textContent).toBe("thinking <i>hard</i>");
    expect(root.all().some((n) => n.tag === "a")).toBe(false);
  });

  test("refused step shows the limit sentence; accepted does not", () => {
    expect(has(root, "runlog-decision--refused").length).toBe(1);
    expect(has(root, "runlog-reason")[0].textContent).toContain("6");
  });

  test("reasoning only where present; the others are greyed lines", () => {
    expect(has(root, "runlog-reasoning").length).toBe(1);
    expect(has(root, "runlog-no-reasoning").length).toBe(2);
  });

  test("page rows carry title, host and chars as text", () => {
    const page = has(root, "runlog-page")[0];
    expect(page.text()).toContain("T");
    expect(page.text()).toContain("h.example");
  });

  test("header marks uncounted tokens; limits block is present", () => {
    expect(has(root, "runlog-head")[0].text()).toContain("m1");
    expect(has(root, "runlog-tokens").some((n) => n.textContent !== "" && n.textContent.length > 0)).toBe(true);
    expect(has(root, "runlog-limits").length).toBe(1);
  });
});

describe("declined steps and chains", () => {
  const declined = (answer: any) => ({ ...run, steps: [{ t: 0, ms: 1, kind: "search", answer: "declined", ...answer }], limits: undefined });
  const answerOf = (step: any) => {
    const root = new FakeNode("main");
    renderRun(doc, root, declined(step));
    return has(root, "runlog-answer")[0].textContent;
  };

  test("one sentence per reason, never the raw code", () => {
    const sentences = ["blocked", "no-access", "no-result", "failed", undefined].map((declineReason) => answerOf({ declineReason }));
    expect(new Set(sentences).size).toBe(4);
    for (const s of sentences) expect(s).not.toMatch(/blocked|no-access|no-result|failed/);
  });

  test("a chain renders each run in order; a missing one shows a note at its place", () => {
    const root = new FakeNode("main");
    renderRuns(doc, root, [run, null, run]);
    expect(has(root, "runlog-part").length).toBe(2);
    expect(has(root, "runlog-head").length).toBe(2);
    expect(has(root, "runlog-note").length).toBe(1);
  });
});

describe("renderNote", () => {
  test("replaces the content with one note", () => {
    const root = new FakeNode("main");
    renderRun(doc, root, run);
    renderNote(doc, root, "runlog_not_found");
    expect(root.children.length).toBe(1);
    expect(root.children[0].className).toBe("runlog-note");
    expect(root.text().length).toBeGreaterThan(0);
  });
});

describe("page sources", () => {
  test("no innerHTML, no link in the run-log files", () => {
    for (const f of ["runlog.js", "runlog-render.js"]) {
      const src = readFileSync(join(import.meta.dir, "..", "..", "extension", "runlog", f), "utf8");
      expect(src.includes("innerHTML")).toBe(false);
      expect(src.includes('"a"')).toBe(false);
    }
  });

  test("referrer policy meta present", () => {
    const html = readFileSync(join(import.meta.dir, "..", "..", "extension", "runlog", "runlog.html"), "utf8");
    expect(html).toContain('name="referrer" content="no-referrer"');
  });
});
