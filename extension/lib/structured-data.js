// Structured product/software data of a page (docs/PROTOCOL.md "Search"),
// read from its JSON-LD blocks. No imports and no module state: the function
// is injected as-is with scripting.executeScript({ func }).

/**
 * Runs inside a page. Returns a few short plain-text lines (name, price and
 * currency, availability, rating, license, repository) for the Product,
 * Offer/AggregateOffer, SoftwareApplication, SoftwareSourceCode and
 * AggregateRating nodes of its `application/ld+json` scripts (`@graph`
 * arrays included), at most 800 characters; "" when there is none.
 */
export function readStructuredData() {
  const MAX = 800;
  const FIELD_MAX = 120;
  const clean = (v) => (typeof v === "string" || typeof v === "number" ? String(v).replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim().slice(0, FIELD_MAX) : "");
  const types = (node) => [].concat(node?.["@type"] ?? []).map((x) => String(x).replace(/^.*[/#]/, ""));
  const named = (v) => clean(v && typeof v === "object" ? v.name ?? v.url : v);
  const nodes = [];
  const walk = (node, depth) => {
    if (!node || typeof node !== "object" || depth > 6) return;
    if (Array.isArray(node)) {
      for (const n of node) walk(n, depth + 1);
      return;
    }
    nodes.push(node);
    walk(node["@graph"], depth + 1);
    for (const key of ["offers", "aggregateRating", "mainEntity", "mainEntityOfPage"]) walk(node[key], depth + 1);
  };
  for (const script of document.querySelectorAll('script[type="application/ld+json"]')) {
    try {
      walk(JSON.parse(script.textContent || ""), 0);
    } catch {
      // malformed JSON-LD is ignored
    }
  }
  const lines = [];
  const seen = new Set();
  const add = (label, value) => {
    const v = clean(value);
    const line = v && `${label}: ${v}`;
    if (line && !seen.has(line)) {
      seen.add(line);
      lines.push(line);
    }
  };
  for (const node of nodes) {
    const kind = types(node);
    const has = (...names) => names.some((n) => kind.includes(n));
    if (has("Product", "SoftwareApplication", "SoftwareSourceCode")) {
      add("Name", node.name);
      add("License", named(node.license));
      add("Repository", node.codeRepository);
      add("Category", node.applicationCategory);
    }
    if (has("Offer", "AggregateOffer")) {
      const price = node.price ?? node.lowPrice;
      const high = node.highPrice !== undefined && node.highPrice !== node.lowPrice ? `–${clean(node.highPrice)}` : "";
      if (price !== undefined) add("Price", `${clean(price)}${high} ${clean(node.priceCurrency)}`);
      add("Availability", clean(node.availability).replace(/^.*[/#]/, ""));
    }
    if (has("AggregateRating")) {
      const count = node.ratingCount ?? node.reviewCount;
      if (node.ratingValue !== undefined) add("Rating", `${clean(node.ratingValue)}${count !== undefined ? ` (${clean(count)} reviews)` : ""}`);
    }
  }
  let out = "";
  for (const line of lines) {
    if (out.length + line.length + 1 > MAX) break;
    out += (out ? "\n" : "") + line;
  }
  return out;
}
