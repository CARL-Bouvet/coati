// Tests for extension/panel/markdown.js — the side panel's DOM-based
// markdown renderer (replaces the old string/innerHTML renderSafeMarkdown).
// Same pattern/location as the other ui-*.test.ts files (pure logic,
// imported straight from extension/panel/). No DOM library exists in this
// repo (no bundler, no new dependency — CLAUDE.md), so renderMarkdown is
// exercised against a tiny hand-rolled DOM shim defined right here, built
// only from createElement/createTextNode/createDocumentFragment/
// appendChild/setAttribute/style/textContent — exactly the subset
// markdown.js is allowed to use.
import { describe, expect, test } from "bun:test";
import { parseMarkdown, parseInline, renderMarkdown } from "../../extension/panel/markdown.js";

// --- minimal DOM shim ------------------------------------------------------

class FakeNode {
  childNodes: any[] = [];
  appendChild(node: any) {
    this.childNodes.push(node);
    return node;
  }
}

class FakeText {
  nodeType = 3;
  constructor(public data: string) {}
}

class FakeElement extends FakeNode {
  nodeType = 1;
  tagName: string;
  attrs: Record<string, string> = {};
  style: Record<string, string> = {};
  className = "";
  constructor(tag: string) {
    super();
    this.tagName = tag.toLowerCase();
  }
  setAttribute(name: string, value: string) {
    this.attrs[name] = value;
  }
  set textContent(value: string) {
    this.childNodes = [new FakeText(value)];
  }
  get textContent() {
    return this.childNodes.map(serializeText).join("");
  }
}

class FakeFragment extends FakeNode {}

class FakeDocument {
  createElement(tag: string) {
    return new FakeElement(tag);
  }
  createTextNode(data: string) {
    return new FakeText(data);
  }
  createDocumentFragment() {
    return new FakeFragment();
  }
}

function serializeText(node: any): string {
  if (node instanceof FakeText) return node.data;
  return node.childNodes.map(serializeText).join("");
}

// Simplified nested-tag dump, e.g. "<h3>Title</h3><ul><li>a</li></ul>" —
// enough to assert structure without pulling in a real serializer.
function dump(node: any): string {
  if (node instanceof FakeText) return node.data;
  const inner = node.childNodes.map(dump).join("");
  if (node instanceof FakeFragment) return inner;
  const attrs = Object.keys(node.attrs || {})
    .map((k) => ` ${k}="${node.attrs[k]}"`)
    .join("");
  return `<${node.tagName}${attrs}>${inner}</${node.tagName}>`;
}

function tagsOf(node: any, tag: string, acc: any[] = []): any[] {
  if (node.tagName === tag) acc.push(node);
  for (const child of node.childNodes || []) tagsOf(child, tag, acc);
  return acc;
}

const doc = new FakeDocument();

// --- parseMarkdown / parseInline --------------------------------------------

describe("parseInline", () => {
  test("bold and italic", () => {
    expect(parseInline("**bold** and *em*")).toEqual([
      { type: "strong", children: [{ type: "text", value: "bold" }] },
      { type: "text", value: " and " },
      { type: "em", children: [{ type: "text", value: "em" }] },
    ]);
  });

  test("inline code stays literal, no nested emphasis", () => {
    expect(parseInline("`**not bold**`")).toEqual([{ type: "code", value: "**not bold**" }]);
  });

  test("link becomes plain text, never a link node", () => {
    expect(parseInline("[label](https://example.com)")).toEqual([
      { type: "text", value: "label (https://example.com)" },
    ]);
  });

  test("bare URL stays untouched text", () => {
    expect(parseInline("see https://example.com/x for details")).toEqual([
      { type: "text", value: "see https://example.com/x for details" },
    ]);
  });

  test("image becomes its alt text only", () => {
    expect(parseInline("![a photo](https://example.com/x.png)")).toEqual([{ type: "text", value: "a photo" }]);
  });

  test("raw HTML is literal text, not parsed", () => {
    expect(parseInline("<b>hi</b>")).toEqual([{ type: "text", value: "<b>hi</b>" }]);
  });
});

describe("parseMarkdown — headings", () => {
  test("levels 1-6 all parse, capped to h3-h5 at render time", () => {
    const blocks = parseMarkdown("# one\n\n###### six");
    expect(blocks[0]).toEqual({ type: "heading", level: 1, inline: [{ type: "text", value: "one" }] });
    expect(blocks[1]).toEqual({ type: "heading", level: 6, inline: [{ type: "text", value: "six" }] });
  });
});

describe("parseMarkdown — blockquote", () => {
  test("nested blockquotes", () => {
    const blocks = parseMarkdown("> outer\n>> inner");
    expect(blocks).toEqual([
      {
        type: "blockquote",
        children: [
          { type: "paragraph", inline: [{ type: "text", value: "outer" }] },
          { type: "blockquote", children: [{ type: "paragraph", inline: [{ type: "text", value: "inner" }] }] },
        ],
      },
    ]);
  });
});

describe("parseMarkdown — nested lists", () => {
  test("3 levels of indentation", () => {
    const md = "- a\n  - b\n    - c";
    const [list] = parseMarkdown(md);
    expect(list.type).toBe("list");
    const level2 = list.items[0].blocks[1];
    expect(level2.type).toBe("list");
    const level3 = level2.items[0].blocks[1];
    expect(level3.type).toBe("list");
    expect(level3.items[0].blocks[0]).toEqual({ type: "paragraph", inline: [{ type: "text", value: "c" }] });
  });
});

describe("parseMarkdown — tables", () => {
  test("header + alignment row + body", () => {
    const md = "| A | B | C |\n|:--|:-:|--:|\n| 1 | 2 | 3 |";
    const [table] = parseMarkdown(md);
    expect(table.type).toBe("table");
    expect(table.align).toEqual(["left", "center", "right"]);
    expect(table.header.map((c: any) => c[0].value)).toEqual(["A", "B", "C"]);
    expect(table.rows[0].map((c: any) => c[0].value)).toEqual(["1", "2", "3"]);
  });

  test("header row without a separator yet (streaming) stays a paragraph", () => {
    const md = "| A | B |";
    const [block] = parseMarkdown(md);
    expect(block.type).toBe("paragraph");
  });
});

describe("parseMarkdown — fenced code", () => {
  test("script tags and ** stay literal inside the fence", () => {
    const md = "```js\n<script>**not bold**</script>\n```";
    const [block] = parseMarkdown(md);
    expect(block).toEqual({ type: "code", lang: "js", text: "<script>**not bold**</script>" });
  });

  test("unclosed fence while streaming runs to end of input", () => {
    const md = "```js\nfunction f() {\n  return 1;";
    const [block] = parseMarkdown(md);
    expect(block.type).toBe("code");
    expect(block.lang).toBe("js");
    expect(block.text).toBe("function f() {\n  return 1;");
  });
});

// --- renderMarkdown (DOM shim) ----------------------------------------------

describe("renderMarkdown", () => {
  test("heading levels are capped to h3-h5, never h1/h2", () => {
    const frag = renderMarkdown(doc, "# one\n\n## two\n\n###### six");
    const tags = frag.childNodes.map((n: any) => n.tagName);
    expect(tags).toEqual(["h3", "h4", "h5"]);
  });

  test("fenced code with <script> and ** renders as text, no <script> element and no <strong>", () => {
    const frag = renderMarkdown(doc, "```js\n<script>**not bold**</script>\n```");
    expect(tagsOf(frag, "script").length).toBe(0);
    expect(tagsOf(frag, "strong").length).toBe(0);
    const code = tagsOf(frag, "code")[0];
    expect(code.textContent).toBe("<script>**not bold**</script>");
    expect(code.attrs["data-lang"]).toBe("js");
  });

  test("link renders as plain text, never an <a>", () => {
    const frag = renderMarkdown(doc, "See [my site](https://example.com) for more.");
    expect(tagsOf(frag, "a").length).toBe(0);
    expect(dump(frag)).toContain("my site (https://example.com)");
  });

  test("raw HTML in the source renders as literal text", () => {
    const frag = renderMarkdown(doc, "This is <b>not</b> bold markup.");
    expect(tagsOf(frag, "b").length).toBe(0);
    expect(dump(frag)).toContain("<b>not</b>");
  });

  test("blockquote renders nested <blockquote> elements", () => {
    const frag = renderMarkdown(doc, "> outer\n>> inner");
    const outer = tagsOf(frag, "blockquote")[0];
    expect(outer).toBeDefined();
    expect(tagsOf(frag, "blockquote").length).toBe(2);
  });

  test("nested list renders nested <ul> elements 3 deep", () => {
    const frag = renderMarkdown(doc, "- a\n  - b\n    - c");
    expect(tagsOf(frag, "ul").length).toBe(3);
  });

  test("table renders a wrapped <table> with aligned cells", () => {
    const frag = renderMarkdown(doc, "| A | B |\n|:--|--:|\n| 1 | 2 |");
    const table = tagsOf(frag, "table")[0];
    expect(table).toBeDefined();
    const ths = tagsOf(frag, "th");
    expect(ths[0].style.textAlign).toBe("left");
    expect(ths[1].style.textAlign).toBe("right");
  });

  test("no innerHTML/outerHTML/insertAdjacentHTML/DOMParser used anywhere", async () => {
    const src = await Bun.file(new URL("../../extension/panel/markdown.js", import.meta.url)).text();
    expect(/\.innerHTML\s*=|\.outerHTML\s*=|\.insertAdjacentHTML\(|new DOMParser\(/.test(src)).toBe(false);
  });
});
