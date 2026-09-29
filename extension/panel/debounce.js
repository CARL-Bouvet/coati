// Minimal trailing-edge debounce — used by panel.js to coalesce
// `chrome.tabs.onUpdated` events (a navigation typically fires several:
// "loading" with a new url, then one or more "complete") into a single
// metadata-only re-detection, ~200ms after the last one.

/**
 * @param {(...args: any[]) => void} fn
 * @param {number} waitMs
 * @returns {(...args: any[]) => void} a debounced wrapper around `fn`.
 */
export function debounce(fn, waitMs) {
  let timer = null;
  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), waitMs);
  };
}
