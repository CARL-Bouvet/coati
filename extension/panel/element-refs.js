// Coati side panel — "Montrer du doigt" element-reference parsing.
//
// Pure, DOM-free parsing of `[[eN]]` tokens the model may write when
// `context.elements` was sent (plan-montrer-voir-chercher-08-10.md §3A, flow
// (4)). Kept separate from the rendering path in panel.js so it can be unit
// tested the same way extension/panel/timestamps.js is — no chrome.* here,
// no DOM. panel.js decides whether and how to turn a known ref token into a
// real DOM node (a button), the same split timestamps.js/linkifyTimestamps()
// already uses.
//
// `[[eN]]` whose ref is NOT among the elements the extraction actually
// produced is dropped from the output entirely (plan: "unknown token
// removed") — the model is never trusted to invent a target, and the label
// shown on a known ref's button always comes from `elements` (the
// extraction), never from the model's own words around the token.

const ELEMENT_REF_RE = /\[\[(e[1-9][0-9]{0,2})\]\]/g;

/**
 * Splits text into a token list of plain-text runs and known element
 * references. `elements` is the `[{ref, role, label}]` array the panel kept
 * in memory from the last send (panel.js's `lastSentElements.elements`) —
 * an `[[eN]]` whose ref isn't in it is removed from the token stream
 * silently rather than kept as literal "[[eN]]" text.
 *
 * Streaming tolerance: panel.js re-parses the full accumulated message text
 * on every chunk (same as markdown.js), so a token still open at the end of
 * a partial chunk ("[[e1" with no closing "]]" yet) simply doesn't match the
 * regex yet and is left as ordinary text until the closing brackets arrive
 * on a later chunk — no special-casing needed here.
 *
 * @param {string} text
 * @param {Array<{ref: string, role: string, label: string}>} elements
 * @returns {Array<{type: 'text', value: string} | {type: 'ref', ref: string, role: string, label: string}>}
 */
export function parseElementRefs(text, elements) {
  const known = new Map((elements || []).filter((e) => e && typeof e.ref === "string").map((e) => [e.ref, e]));
  const input = text ?? "";
  const tokens = [];
  let lastIndex = 0;
  ELEMENT_REF_RE.lastIndex = 0;
  let match;
  while ((match = ELEMENT_REF_RE.exec(input))) {
    const [raw, ref] = match;
    if (match.index > lastIndex) {
      tokens.push({ type: "text", value: input.slice(lastIndex, match.index) });
    }
    const entry = known.get(ref);
    if (entry) {
      tokens.push({ type: "ref", ref, role: entry.role, label: entry.label });
    }
    // Unknown ref: nothing pushed for the token itself — it disappears from
    // the rendered text, it is never left as literal "[[eN]]".
    lastIndex = match.index + raw.length;
  }
  if (lastIndex < input.length) {
    tokens.push({ type: "text", value: input.slice(lastIndex) });
  }
  if (tokens.length === 0) tokens.push({ type: "text", value: input });
  return tokens;
}

/**
 * Resolves a ref (e.g. "e12") against a SPECIFIC elements snapshot
 * (`{extractionId, elements}`), returning the full
 * `{extractionId, ref, role, label}` click payload panel.js's
 * `pointAtElement()` sends to pointer.js, or `null` if that ref isn't in
 * THAT snapshot. Pure — takes the snapshot explicitly rather than reading
 * any "current"/shared state, which is exactly the bug this guards against
 * (fixed 08/10, admin review): resolving an assistant message's button
 * against a DIFFERENT (newer) extraction can silently point at the wrong
 * element even though the button's own label still reads the old one.
 *
 * @param {{extractionId: string, elements: Array<{ref: string, role: string, label: string}>}|null|undefined} elementsSnapshot
 * @param {string} ref
 * @returns {{extractionId: string, ref: string, role: string, label: string}|null}
 */
export function resolveElementClick(elementsSnapshot, ref) {
  if (!elementsSnapshot || !Array.isArray(elementsSnapshot.elements)) return null;
  const entry = elementsSnapshot.elements.find((e) => e && e.ref === ref);
  if (!entry) return null;
  return { extractionId: elementsSnapshot.extractionId, ref: entry.ref, role: entry.role, label: entry.label };
}

/**
 * Strips extraction-only fields from a page `context` before it is sent to
 * the broker, and gates `context.elements` behind the negotiated `elements`
 * capability (`hello-ok.features`, plan-montrer-voir-chercher-08-10.md §2).
 * `extractionId` and `elementsFrameLimited` are local-only (pointer.js's
 * verification key / a UI hint) — the broker's Context shape has neither
 * (docs/PROTOCOL.md). Returns a new object; never mutates `context`. Pure,
 * no DOM.
 *
 * @param {object|undefined} context
 * @param {boolean} elementsFeatureEnabled
 * @returns {object|undefined}
 */
export function prepareContextForWire(context, elementsFeatureEnabled) {
  if (!context || typeof context !== "object") return context;
  const { extractionId, elementsFrameLimited, elements, ...rest } = context;
  if (elementsFeatureEnabled && Array.isArray(elements)) {
    return { ...rest, elements };
  }
  return rest;
}
