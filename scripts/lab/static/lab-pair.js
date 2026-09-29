// Coati state lab — identity pairing override.
//
// Classic script, loaded AFTER the page's own CSS and after lab-runtime.js.
// If the URL carries `?pair=p1..p4`, injects a lab-only <style> that:
//   - declares an @font-face for the pairing's font (file copied by
//     build-lab.ts into <lab-root>/assets/fonts/), and
//   - overrides --font / --accent / --accent-fg on :root, picking the
//     light or dark accent depending on which tree this page belongs to
//     (detected from the computed `color-scheme`, set by theme.css in
//     light trees and forced to "dark" by build-lab.ts's rewriteCssForDark
//     in dark trees).
// No `pair` param -> no-op, page renders exactly as before (task
// constraint: "no pair parameter = unchanged behaviour").
//
// Regenerated verbatim into every .tmp/lab tree by build-lab.ts — never
// edit a copy in .tmp/lab, edit this file instead.
(function () {
  "use strict";

  var params = new URLSearchParams(location.search);
  var pairId = params.get("pair");
  if (!pairId) return;

  var table = window.__COATI_LAB_PAIRS__ || {};
  var pair = table[pairId];
  if (!pair) {
    console.error("[lab] unknown pair id '" + pairId + "'");
    return;
  }
  window.__COATI_LAB_PAIR__ = pair;

  // This script's own location is fixed at <lab-root>/lab/lab-pair.js in
  // every tree, so the font lives one level up, in assets/fonts/.
  var scriptSrc = document.currentScript.src;
  var fontUrl = new URL("../assets/fonts/" + pair.fontFile, scriptSrc).href;

  var scheme = getComputedStyle(document.documentElement).colorScheme.trim();
  var vars = scheme === "dark" ? pair.dark : pair.light;

  // --neutrals (--bg, --surface, --fg, --muted, --border, message bubbles,
  // ...) is optional — pairings that don't set it keep theme.css's own
  // neutrals (p1-p4). When present, one declaration per token, so a pair can
  // override a subset without touching the rest.
  var neutralDecls = "";
  if (vars.neutrals) {
    for (var token in vars.neutrals) {
      if (Object.prototype.hasOwnProperty.call(vars.neutrals, token)) {
        neutralDecls += token + ":" + vars.neutrals[token] + ";";
      }
    }
  }

  var style = document.createElement("style");
  style.textContent =
    "@font-face{font-family:'" + pair.fontFamily + "';src:url('" + fontUrl + "') format('woff2');" +
    "font-weight:100 900;font-display:block;}\n" +
    ":root{--font:'" + pair.fontFamily + "', system-ui, sans-serif;" +
    "--accent:" + vars.accent + ";--accent-fg:" + vars.accentFg + ";" +
    neutralDecls +
    "accent-color:var(--accent);}" +
    // Optional lab-only CSS (e.g. c1's anthracite header): previews a styling
    // the product does not ship yet, without touching extension/.
    (vars.css ? "\n" + vars.css : "");
  document.head.appendChild(style);
})();
