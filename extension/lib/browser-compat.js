// Cross-browser extension API shim.
//
// Firefox injects `browser.*` (promise-based, the WebExtensions standard) and
// `chrome.*` (callback-based, kept for web compatibility). Chrome injects
// `chrome.*`, promisified for most MV3 APIs.
//
// The naive rule — `globalThis.browser ?? globalThis.chrome` — is WRONG on
// Chromium, and silently so. Measured in Brave on 2026-09-20: a `browser`
// global exists, it is NOT the same object as `chrome` (`browser === chrome`
// is false), and it carries sidePanel/scripting/storage. Preferring it would
// route the whole extension through an object nothing here has ever been
// tested against — including `sidePanel.open()`, which Chrome only accepts
// inside a real user gesture and which fails silently otherwise. Worse, the
// failure mode is invisible: no exception, just a panel that never opens.
//
// So: Gecko is detected positively, by an API that exists nowhere else
// (`runtime.getBrowserInfo` is Firefox-only), and every other engine keeps the
// `chrome` object it was built and verified on. Feature-detect the engine
// once, here; never sniff the user agent, and never branch on it elsewhere.
const isGecko =
  typeof globalThis.browser !== "undefined" &&
  typeof globalThis.browser.runtime?.getBrowserInfo === "function";

/** The extension API namespace. Import this instead of touching `chrome` or
 * `browser` directly, so one source runs unpacked in Chrome and as a signed
 * .xpi in Firefox. See docs/FIREFOX.md. */
export const api = isGecko ? globalThis.browser : globalThis.chrome;

/** True on Firefox and its derivatives. Exported for the handful of places
 * where the two engines genuinely differ (sidebar vs side panel, the
 * no-token banner's wording and the Firefox-only /pair link) rather than
 * merely spelling an API differently. */
export const IS_GECKO = isGecko;
