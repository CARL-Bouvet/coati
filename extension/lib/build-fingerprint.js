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
  "content/extract.js",
  "lib/browser-compat.js",
  "lib/build-fingerprint.js",
  "lib/handshake-crypto.js",
  "lib/i18n.js",
  "lib/i18n-page.js",
  "lib/key-input.js",
  "lib/language-selector.js",
  "lib/model-provider-presets.js",
  "lib/native-host.js",
  "lib/setup-data.js",
  "lib/ui-lang.js",
  "manifest.json",
  "options-setup.js",
  "options.css",
  "options.html",
  "options.js",
  "panel/card.css",
  "panel/first-run.js",
  "panel/markdown.js",
  "panel/panel.css",
  "panel/panel.html",
  "panel/panel.js",
  "panel/read-button.js",
  "panel/retention.js",
  "panel/timestamps.js",
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
