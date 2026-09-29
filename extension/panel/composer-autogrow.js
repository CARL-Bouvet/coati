// Composer autogrow (lot 4, internal design plan, 28/09). The textarea
// starts at one line, grows with its text up to MAX_LINES, then scrolls.
// Done in JS because `field-sizing: content` is missing from Firefox.
//
// The height goes through the CSSOM (`el.style.height = ...`), which the CSP
// (style-src 'self') allows — never a `style` attribute, never inline CSS.
// `autogrowHeight()` is pure so bun test can cover it without a DOM, same
// pattern as scroll.js / card-state.js.

export const MAX_LINES = 4;

/**
 * @param {{ scrollHeight: number, lineHeight: number, paddingY: number,
 *           borderY: number, maxLines?: number }} args
 *   `scrollHeight` is measured with the field collapsed to one line, so it
 *   is the content height plus vertical padding (never less than one line).
 *   The page uses `box-sizing: border-box`, so the returned height includes
 *   padding and border.
 * @returns {{ height: number, overflow: boolean }} the height to apply, and
 *   whether the text is taller than MAX_LINES (scrollbar needed).
 */
export function autogrowHeight({ scrollHeight, lineHeight, paddingY, borderY, maxLines = MAX_LINES }) {
  const content = Math.max(lineHeight, scrollHeight - paddingY);
  const max = lineHeight * maxLines;
  // 1px of slack: sub-pixel line heights (1.45 × 13.3px) round differently
  // in scrollHeight and would otherwise flicker the scrollbar at 4 lines.
  const overflow = content > max + 1;
  const inner = Math.min(content, max);
  return { height: Math.ceil(inner + paddingY + borderY), overflow };
}

/**
 * Wires autogrow on `textarea` and returns the recompute function. Call it
 * after every programmatic value change (a prompt inserted, the field cleared
 * after sending) — those fire no "input" event. Typing and a panel width
 * change (window resize: the panel is its own window) are handled here.
 * @param {HTMLTextAreaElement} textarea
 * @param {{ overflowClass: string, maxLines?: number }} opts
 * @returns {() => void}
 */
export function bindAutogrow(textarea, { overflowClass, maxLines = MAX_LINES }) {
  const resize = () => {
    const cs = getComputedStyle(textarea);
    const fontSize = parseFloat(cs.fontSize) || 14;
    const lineHeight = parseFloat(cs.lineHeight) || fontSize * 1.2; // "normal" -> NaN
    const paddingY = parseFloat(cs.paddingTop) + parseFloat(cs.paddingBottom);
    const borderY = parseFloat(cs.borderTopWidth) + parseFloat(cs.borderBottomWidth);

    // Measure collapsed and without a scrollbar, so the width the text wraps
    // in never depends on the previous measurement.
    textarea.classList.remove(overflowClass);
    textarea.style.height = `${Math.ceil(lineHeight + paddingY + borderY)}px`;
    const { height, overflow } = autogrowHeight({
      scrollHeight: textarea.scrollHeight,
      lineHeight,
      paddingY,
      borderY,
      maxLines,
    });
    textarea.style.height = `${height}px`;
    textarea.classList.toggle(overflowClass, overflow);
  };

  let frame = 0;
  const resizeNextFrame = () => {
    cancelAnimationFrame(frame);
    frame = requestAnimationFrame(resize);
  };

  textarea.addEventListener("input", resize);
  window.addEventListener("resize", resizeNextFrame);
  // Figtree loads with font-display: swap — its metrics differ from the
  // fallback face's, so re-measure once it is in.
  document.fonts?.ready?.then(resizeNextFrame);
  resize();
  return resize;
}
