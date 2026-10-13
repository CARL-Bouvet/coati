// Coati state lab — options page zone map (workflow-front, phase 2). Same rules as panel-zones.js:
// lab-only (annotations never ship), applied to the REAL markup on load and after every render;
// nested codes are DOM descendants; one "primary" per parent.
(function () {
  "use strict";

  var ZONES = [
    { selector: ".page-head", zone: "Z1", rank: "tertiary" },
    { selector: "#modelSection", zone: "Z2", rank: "primary" },
    { selector: "#modelSection .current-model", zone: "Z2a", rank: "primary" },
    { selector: "#modelTabs", zone: "Z2b", rank: "secondary" },
    { selector: "#panelLocal", zone: "Z2c", rank: "secondary" },
    { selector: "#panelOnline", zone: "Z2d", rank: "secondary" },
    { selector: "section[aria-labelledby='h-attach']", zone: "Z3", rank: "secondary" },
    { selector: "section[aria-labelledby='h-shortcut']", zone: "Z4", rank: "tertiary" },
    { selector: "section[aria-labelledby='h-sites']", zone: "Z5", rank: "tertiary" },
    { selector: "section[aria-labelledby='h-history']", zone: "Z6", rank: "tertiary" },
    { selector: "section[aria-labelledby='h-about']", zone: "Z7", rank: "tertiary", type: "text" },
    { selector: "#legacyPairing", zone: "Z8", rank: "tertiary" },
  ];

  function apply() {
    for (var i = 0; i < ZONES.length; i++) {
      var z = ZONES[i];
      var el = document.querySelector(z.selector);
      if (!el) continue;
      if (el.getAttribute("data-zone") !== z.zone) el.setAttribute("data-zone", z.zone);
      if (z.rank && el.getAttribute("data-rank") !== z.rank) el.setAttribute("data-rank", z.rank);
      if (z.type && el.getAttribute("data-type") !== z.type) el.setAttribute("data-type", z.type);
    }
  }

  window.__COATI_LAB_ZONES__ = ZONES;
  apply();
  new MutationObserver(apply).observe(document.body, { childList: true, subtree: true });
})();
