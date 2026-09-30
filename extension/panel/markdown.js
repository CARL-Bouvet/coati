// Coati side panel — markdown renderer.
//
// CLAUDE.md rule #3: model/page text is data, never markup. This module
// never touches innerHTML/outerHTML/insertAdjacentHTML/DOMParser — every
// node it produces goes through createElement/createTextNode, so whatever
// a model writes (including literal "<script>" or HTML-looking text) can
// only ever become a text node, never a parsed tag.
//
// Two entry points:
//   parseMarkdown(text)      -> block AST, pure, DOM-free (unit-testable).
//   renderMarkdown(doc, text) -> DocumentFragment built against `doc`
//                                 (passed in, not the global `document`,
//                                 so tests can supply a minimal DOM shim).
//
// Supported: ATX headings, paragraphs with soft line breaks, unordered/
// ordered lists (indent-based nesting), blockquotes (nested), fenced code
// blocks, inline code, **bold**, *italic*/_italic_, GFM pipe tables
// (header + alignment row), horizontal rules. Links `[label](url)` and
// bare URLs are rendered as plain text ("label (url)") — never an <a>,
// never an href — and images `![alt](url)` render as their alt text only.
// Raw HTML in the source text is not parsed at all: it just flows through
// as literal characters in a text node.
//
// Streaming tolerance: renderMessage() re-parses the FULL accumulated text
// on every chunk. An unclosed fenced code block runs to the end of input
// (rendered as a code block); a table header row with no separator row
// yet is rendered as an ordinary paragraph until the separator arrives.

// --- Block parsing --------------------------------------------------------

const HEADING_RE = /^ {0,3}(#{1,6})(?:\s+(.*))?$/;
const HR_RE = /^ {0,3}([-*_])(?:[ \t]*\1){2,}[ \t]*$/;
const FENCE_RE = /^ {0,3}(```+|~~~+)[ \t]*(\S*)[ \t]*$/;
const BLOCKQUOTE_RE = /^ {0,3}>[ \t]?(.*)$/;
const LIST_ITEM_RE = /^( *)([-*+]|\d{1,9}[.)])(?:[ \t]+(.*)|)$/;
const TABLE_SEPARATOR_RE = /^ {0,3}\|?\s*:?-{1,}:?\s*(\|\s*:?-{1,}:?\s*)*\|?\s*$/;

function splitLines(text) {
  return String(text ?? "").replace(/\r\n?/g, "\n").split("\n");
}

/** Parses markdown source into a block AST. Pure function, no DOM. */
export function parseMarkdown(text) {
  return parseBlocks(splitLines(text));
}

function isBlank(line) {
  return line.trim() === "";
}

function parseBlocks(lines) {
  const blocks = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (isBlank(line)) {
      i++;
      continue;
    }

    const fenceMatch = line.match(FENCE_RE);
    if (fenceMatch) {
      const fenceChar = fenceMatch[1][0];
      const fenceLen = fenceMatch[1].length;
      const lang = fenceMatch[2] || "";
      const codeLines = [];
      i++;
      const closeRe = new RegExp(`^ {0,3}${fenceChar === "`" ? "`" : "~"}{${fenceLen},}\\s*$`);
      while (i < lines.length && !closeRe.test(lines[i])) {
        codeLines.push(lines[i]);
        i++;
      }
      if (i < lines.length) i++; // consume closing fence; if absent (streaming), we just ran to EOF
      blocks.push({ type: "code", lang, text: codeLines.join("\n") });
      continue;
    }

    if (HR_RE.test(line) && !LIST_ITEM_RE.test(line)) {
      blocks.push({ type: "hr" });
      i++;
      continue;
    }

    const headingMatch = line.match(HEADING_RE);
    if (headingMatch) {
      const level = headingMatch[1].length;
      const content = (headingMatch[2] || "").replace(/\s+#+\s*$/, "").trim();
      blocks.push({ type: "heading", level, inline: parseInline(content) });
      i++;
      continue;
    }

    const bqMatch = line.match(BLOCKQUOTE_RE);
    if (bqMatch) {
      const inner = [];
      while (i < lines.length) {
        const m = lines[i].match(BLOCKQUOTE_RE);
        if (m) {
          inner.push(m[1]);
          i++;
        } else if (isBlank(lines[i]) && i + 1 < lines.length && BLOCKQUOTE_RE.test(lines[i + 1])) {
          inner.push("");
          i++;
        } else {
          break;
        }
      }
      blocks.push({ type: "blockquote", children: parseBlocks(inner) });
      continue;
    }

    const listMatch = line.match(LIST_ITEM_RE);
    if (listMatch) {
      const { list, consumed } = parseList(lines.slice(i), listMatch[1].length);
      blocks.push(list);
      i += consumed;
      continue;
    }

    if (line.includes("|") && i + 1 < lines.length && TABLE_SEPARATOR_RE.test(lines[i + 1]) && lines[i + 1].includes("-")) {
      const { table, consumed } = parseTable(lines.slice(i));
      blocks.push(table);
      i += consumed;
      continue;
    }

    // Paragraph: contiguous non-blank lines that do not start a new block.
    const paraLines = [line];
    i++;
    while (i < lines.length && !isBlank(lines[i]) && !startsNewBlock(lines[i])) {
      paraLines.push(lines[i]);
      i++;
    }
    blocks.push({ type: "paragraph", inline: parseInline(paraLines.join("\n")) });
  }
  return blocks;
}

function startsNewBlock(line) {
  return (
    FENCE_RE.test(line) ||
    HEADING_RE.test(line) ||
    (HR_RE.test(line) && !LIST_ITEM_RE.test(line)) ||
    BLOCKQUOTE_RE.test(line) ||
    LIST_ITEM_RE.test(line)
  );
}

function parseList(lines, indent) {
  const items = [];
  let ordered = null;
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (isBlank(line)) break;
    const m = line.match(LIST_ITEM_RE);
    if (!m || m[1].length !== indent) break;
    if (ordered === null) ordered = /\d/.test(m[2]);
    const isOrdered = /\d/.test(m[2]);
    if (isOrdered !== ordered) break; // marker kind switched: a new list, not this one

    const markerCol = m[1].length + m[2].length; // indent + marker, before the required space
    const hasSpace = line.length > markerCol && /[ \t]/.test(line[markerCol]);
    const markerLen = markerCol + (hasSpace ? 1 : 0);
    const firstContent = m[3] || "";
    i++;

    const raw = [firstContent];
    while (i < lines.length) {
      const next = lines[i];
      if (isBlank(next)) {
        raw.push("");
        i++;
        continue;
      }
      const leading = next.match(/^ */)[0].length;
      if (leading >= markerLen) {
        raw.push(next.slice(Math.min(markerLen, next.length)));
        i++;
      } else {
        break;
      }
    }
    const itemBlocks = parseBlocks(raw);
    items.push({ blocks: itemBlocks });
  }
  return { list: { type: "list", ordered: !!ordered, items }, consumed: i };
}

function splitTableRow(line) {
  let cells = line.trim();
  cells = cells.replace(/^\|/, "").replace(/\|$/, "");
  const out = [];
  let buf = "";
  for (let i = 0; i < cells.length; i++) {
    const ch = cells[i];
    if (ch === "\\" && cells[i + 1] === "|") {
      buf += "|";
      i++;
      continue;
    }
    if (ch === "|") {
      out.push(buf.trim());
      buf = "";
      continue;
    }
    buf += ch;
  }
  out.push(buf.trim());
  return out;
}

function parseAlignRow(line) {
  return splitTableRow(line).map((cell) => {
    const left = cell.startsWith(":");
    const right = cell.endsWith(":");
    if (left && right) return "center";
    if (right) return "right";
    if (left) return "left";
    return null;
  });
}

function parseTable(lines) {
  const header = splitTableRow(lines[0]).map(parseInline);
  const align = parseAlignRow(lines[1]);
  const rows = [];
  let i = 2;
  while (i < lines.length && !isBlank(lines[i]) && lines[i].includes("|")) {
    rows.push(splitTableRow(lines[i]).map(parseInline));
    i++;
  }
  return { table: { type: "table", header, align, rows }, consumed: i };
}

// --- Inline parsing --------------------------------------------------------

// `[label](url)` / bare autolinks stay text (never an <a>, CLAUDE.md #3);
// `![alt](url)` keeps only the alt text. Matched before delimiter scanning
// so their brackets never get mistaken for emphasis markers.
const IMAGE_RE = /^!\[([^\]]*)\]\(([^)]*)\)/;
const LINK_RE = /^\[([^\]]*)\]\(([^)]*)\)/;

/** Parses one run of inline markdown into an inline AST. Pure, DOM-free. */
export function parseInline(text) {
  const nodes = [];
  let buf = "";
  let i = 0;
  const flush = () => {
    if (buf) {
      nodes.push({ type: "text", value: buf });
      buf = "";
    }
  };

  while (i < text.length) {
    const rest = text.slice(i);

    const backtickRun = rest.match(/^`+/);
    if (backtickRun) {
      const fence = backtickRun[0];
      const closeIdx = text.indexOf(fence, i + fence.length);
      if (closeIdx !== -1) {
        flush();
        nodes.push({ type: "code", value: text.slice(i + fence.length, closeIdx) });
        i = closeIdx + fence.length;
        continue;
      }
    }

    const imgMatch = rest.match(IMAGE_RE);
    if (imgMatch) {
      flush();
      buf += imgMatch[1];
      i += imgMatch[0].length;
      continue;
    }

    const linkMatch = rest.match(LINK_RE);
    if (linkMatch) {
      flush();
      buf += linkMatch[2] ? `${linkMatch[1]} (${linkMatch[2]})` : linkMatch[1];
      i += linkMatch[0].length;
      continue;
    }

    const strongMatch = rest.match(/^(\*\*|__)/);
    if (strongMatch) {
      const delim = strongMatch[1];
      const closeIdx = text.indexOf(delim, i + delim.length);
      if (closeIdx !== -1 && closeIdx > i + delim.length) {
        flush();
        nodes.push({ type: "strong", children: parseInline(text.slice(i + delim.length, closeIdx)) });
        i = closeIdx + delim.length;
        continue;
      }
    }

    const emMatch = rest.match(/^([*_])/);
    if (emMatch) {
      const delim = emMatch[1];
      const closeIdx = text.indexOf(delim, i + 1);
      if (closeIdx !== -1 && closeIdx > i + 1) {
        flush();
        nodes.push({ type: "em", children: parseInline(text.slice(i + 1, closeIdx)) });
        i = closeIdx + 1;
        continue;
      }
    }

    buf += text[i];
    i++;
  }
  flush();
  return nodes;
}

// --- DOM rendering -----------------------------------------------------

// Markdown levels 1-6 collapse onto h3-h5: the panel's own layout owns
// h1/h2 (never available to model output).
function headingTag(level) {
  return `h${Math.min(level + 2, 5)}`;
}

function renderInlineInto(doc, container, inlineNodes) {
  for (const node of inlineNodes) {
    if (node.type === "text") {
      container.appendChild(doc.createTextNode(node.value));
    } else if (node.type === "code") {
      const code = doc.createElement("code");
      code.textContent = node.value;
      container.appendChild(code);
    } else if (node.type === "strong") {
      const strong = doc.createElement("strong");
      renderInlineInto(doc, strong, node.children);
      container.appendChild(strong);
    } else if (node.type === "em") {
      const em = doc.createElement("em");
      renderInlineInto(doc, em, node.children);
      container.appendChild(em);
    }
  }
}

function renderBlockInto(doc, container, block) {
  switch (block.type) {
    case "heading": {
      const heading = doc.createElement(headingTag(block.level));
      renderInlineInto(doc, heading, block.inline);
      container.appendChild(heading);
      break;
    }
    case "paragraph": {
      const p = doc.createElement("p");
      renderInlineInto(doc, p, block.inline);
      container.appendChild(p);
      break;
    }
    case "hr": {
      container.appendChild(doc.createElement("hr"));
      break;
    }
    case "code": {
      const pre = doc.createElement("pre");
      const code = doc.createElement("code");
      if (block.lang) code.setAttribute("data-lang", block.lang);
      code.textContent = block.text;
      pre.appendChild(code);
      container.appendChild(pre);
      break;
    }
    case "blockquote": {
      const bq = doc.createElement("blockquote");
      for (const child of block.children) renderBlockInto(doc, bq, child);
      container.appendChild(bq);
      break;
    }
    case "list": {
      const list = doc.createElement(block.ordered ? "ol" : "ul");
      for (const item of block.items) {
        const li = doc.createElement("li");
        if (item.blocks.length === 1 && item.blocks[0].type === "paragraph") {
          renderInlineInto(doc, li, item.blocks[0].inline);
        } else {
          for (const child of item.blocks) renderBlockInto(doc, li, child);
        }
        list.appendChild(li);
      }
      container.appendChild(list);
      break;
    }
    case "table": {
      const wrap = doc.createElement("div");
      wrap.className = "md-table-wrap";
      const table = doc.createElement("table");
      table.className = "md-table";

      const thead = doc.createElement("thead");
      const headRow = doc.createElement("tr");
      block.header.forEach((cellInline, idx) => {
        const th = doc.createElement("th");
        if (block.align[idx]) th.style.textAlign = block.align[idx];
        renderInlineInto(doc, th, cellInline);
        headRow.appendChild(th);
      });
      thead.appendChild(headRow);
      table.appendChild(thead);

      const tbody = doc.createElement("tbody");
      for (const row of block.rows) {
        const tr = doc.createElement("tr");
        row.forEach((cellInline, idx) => {
          const td = doc.createElement("td");
          if (block.align[idx]) td.style.textAlign = block.align[idx];
          renderInlineInto(doc, td, cellInline);
          tr.appendChild(td);
        });
        tbody.appendChild(tr);
      }
      table.appendChild(tbody);

      wrap.appendChild(table);
      container.appendChild(wrap);
      break;
    }
    default:
      break;
  }
}

/**
 * Renders markdown source into a DocumentFragment built against `doc`
 * (never the implicit global `document` — tests pass their own DOM shim).
 * Every node is created via doc.createElement/createTextNode: no
 * innerHTML/outerHTML/insertAdjacentHTML/DOMParser anywhere in this file.
 */
export function renderMarkdown(doc, text) {
  const fragment = doc.createDocumentFragment();
  const blocks = parseMarkdown(text);
  for (const block of blocks) renderBlockInto(doc, fragment, block);
  return fragment;
}
