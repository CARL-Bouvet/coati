// Pure "is the scroll position near the bottom" check, extracted so it can
// be unit-tested without a DOM (see broker/test/ui-scroll.test.ts, following
// the pattern of retention.js/retention.test.ts).
//
// Used by panel.js to decide whether an incoming streaming chunk should pull
// the view back down, or leave it alone because the user scrolled up to read
// (bug report symptom 2).

export const AUTO_SCROLL_THRESHOLD_PX = 40;

/**
 * @param {number} scrollHeight
 * @param {number} scrollTop
 * @param {number} clientHeight
 * @param {number} [threshold] - px of slack still counted as "at the bottom".
 * @returns {boolean}
 */
export function isNearBottom(scrollHeight, scrollTop, clientHeight, threshold = AUTO_SCROLL_THRESHOLD_PX) {
  return scrollHeight - scrollTop - clientHeight <= threshold;
}
