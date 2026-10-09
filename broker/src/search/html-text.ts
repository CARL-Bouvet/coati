// Readable-text extraction for a fetched documentation page — Bun's built-in
// HTMLRewriter (lol-html), zero dependency (CLAUDE.md: "pas de bundler, pas de
// no build dependency" unless a real need — the broker already relies on
// Bun's own runtime, this is the same contract). Strips `script`, `style`,
// `nav`, `footer` and `noscript` content — docs/PROTOCOL.md
// docs": "text outside script/style/nav/footer". Everything that
// comes out of this function is PAGE CONTENT — a data value, never treated
// as instructions by anything downstream (model.ts fences it exactly like
// any other page text — see doc-search.ts).

const SUPPRESSED_SELECTOR = "script, style, nav, footer, noscript";

/**
 * Extracts visible text from an HTML document, dropping script/style/nav/
 * footer/noscript content wherever it appears (any nesting depth — a
 * counter, not a one-shot flag, so a `<nav>` nested inside another
 * suppressed element doesn't under- or over-count). Whitespace is collapsed
 * to single spaces and the result trimmed; callers (doc-search.ts) are
 * responsible for any further length cap. Never throws on malformed HTML —
 * HTMLRewriter is a best-effort streaming parser, same tolerance as every
 * other "page content" extractor in this project.
 */
export async function extractReadableText(html: string): Promise<string> {
  let suppressDepth = 0;
  let out = "";

  const rewriter = new HTMLRewriter()
    .on(SUPPRESSED_SELECTOR, {
      element(el: { onEndTag(cb: () => void): void }) {
        suppressDepth++;
        el.onEndTag(() => {
          suppressDepth = Math.max(0, suppressDepth - 1);
        });
      },
    })
    .on("*", {
      text(chunk: { text: string }) {
        if (suppressDepth === 0) out += chunk.text;
      },
    });

  const response = new Response(html, { headers: { "content-type": "text/html; charset=utf-8" } });
  const transformed = rewriter.transform(response);
  // Draining the body is what actually drives the streaming parser/handlers
  // above — transform() itself returns synchronously without having parsed
  // anything yet.
  await transformed.text();

  return out.replace(/\s+/g, " ").trim();
}
