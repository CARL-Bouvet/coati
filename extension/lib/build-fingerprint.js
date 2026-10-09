// Code fingerprint: SHA-256 of the files the browser ACTUALLY loaded
// (fetched through runtime.getURL, not read from disk), first 7 hex chars.
// Compared by eye with scripts/stamp.sh's output to catch testing against a
// stale unpacked build.
//
// Shared by the panel footer and the settings page. The file list MUST stay
// identical to scripts/stamp.sh (FILES), or the hashes stop being comparable —
// broker/test/ui-options-page.test.ts fails if they drift apart.

export const FINGERPRINT_FILES = [
  "_locales/en/messages.json",
  "_locales/fr/messages.json",
  "_locales/zh_CN/messages.json",
  "background/service-worker.js",
  "content/detect.js",
  "content/extract-files.js",
  "content/extract.js",
  "content/extract/article-youtube.js",
  "content/extract/clickable-elements.js",
  "content/extract/dom-visibility.js",
  "content/extract/page-kind-facts-items.js",
  "content/extract/page-kind-overlay.js",
  "content/extract/page-kind-region.js",
  "content/extract/page-kind-structure.js",
  "content/extract/sanitize.js",
  "content/pointer.js",
  "lib/browser-compat.js",
  "lib/build-fingerprint.js",
  "lib/deadline.js",
  "lib/handshake-crypto.js",
  "lib/i18n-page.js",
  "lib/i18n.js",
  "lib/key-input.js",
  "lib/labels.js",
  "lib/language-selector.js",
  "lib/model-list.js",
  "lib/model-provider-presets.js",
  "lib/native-host.js",
  "lib/setup-data.js",
  "lib/shortcut.js",
  "lib/suggestions-data.js",
  "lib/suggestions.js",
  "lib/theme.css",
  "lib/ui-lang.js",
  "manifest.json",
  "options-setup.js",
  "options.css",
  "options.html",
  "options.js",
  "options/dom-helpers.js",
  "options/dom-refs.js",
  "options/model-core.js",
  "options/model-services.js",
  "options/provider-tests.js",
  "options/shortcut-about.js",
  "options/site-toggles.js",
  "panel/attach-toggle.js",
  "panel/card-state.js",
  "panel/card.css",
  "panel/chat-stream.js",
  "panel/composer-autogrow.js",
  "panel/composer-send.js",
  "panel/confirm-arm.js",
  "panel/conversation-store.js",
  "panel/debounce.js",
  "panel/dom-refs.js",
  "panel/element-refs.js",
  "panel/encart-items.js",
  "panel/first-run-wiring.js",
  "panel/first-run.js",
  "panel/history.js",
  "panel/markdown.js",
  "panel/message-render.js",
  "panel/model-advice.js",
  "panel/model-status.js",
  "panel/page-detect.js",
  "panel/page-extract.js",
  "panel/panel-state.js",
  "panel/panel.css",
  "panel/panel.html",
  "panel/panel.js",
  "panel/pending-action.js",
  "panel/point-at.js",
  "panel/point-effect.js",
  "panel/prompts-wiring.js",
  "panel/read-button.js",
  "panel/recovery-blocks.js",
  "panel/redetect-dedupe.js",
  "panel/request-watch.js",
  "panel/retention.js",
  "panel/screenshot.js",
  "panel/scroll.js",
  "panel/site-card.js",
  "panel/timestamps.js",
  "panel/unreadable.js",
  "prompts/prompts-cases.js",
  "prompts/prompts.css",
  "prompts/prompts.html",
  "prompts/prompts.js",
  "vendor/sortable/sortable.esm.js",
  "welcome/welcome.css",
  "welcome/welcome.html",
  "welcome/welcome.js",
];

/** @param {{ runtime: { getURL(path: string): string } }} api
 * @returns {Promise<string>} 7 hex chars. Rejects if any file can't be read. */
export async function computeCodeFingerprint(api) {
  const buffers = await Promise.all(
    FINGERPRINT_FILES.map((path) => fetch(api.runtime.getURL(path)).then((res) => res.arrayBuffer())),
  );
  let totalLength = 0;
  for (const buf of buffers) totalLength += buf.byteLength;
  const concatenated = new Uint8Array(totalLength);
  let offset = 0;
  for (const buf of buffers) {
    concatenated.set(new Uint8Array(buf), offset);
    offset += buf.byteLength;
  }
  const digest = await crypto.subtle.digest("SHA-256", concatenated);
  const hex = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
  return hex.slice(0, 7);
}
