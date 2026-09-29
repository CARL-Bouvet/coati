// Coati state lab — panel zone map (workflow-front, phase 2).
//
// The extension has no build step, so zone annotations (data-zone /
// data-type / data-rank) must never live in extension/ source: they would
// ship. This lab-only script applies them to the REAL panel markup, on load
// and after every render (a MutationObserver on childList — the panel
// rebuilds messages, suggestions and the prompt list on the fly).
//
// Codes: Z<n> for top-level blocks in DOM order, Z<n><letter> for their
// children (nested codes must be DOM descendants — audit rule H2). Ranks:
// exactly one "primary" per parent (H4). Types are declared only where the
// nature is certain; otherwise left to the audit's inference ("a wrong type
// costs more than a missing one"). The textarea itself is not a zone: a form
// field has no child node, so the audit reads it as an empty box (C3).
(function () {
  "use strict";

  var ZONES = [
    { selector: ".topbar", zone: "Z1", rank: "tertiary" },
    { selector: "#connectionBanner", zone: "Z2", rank: "secondary" },
    { selector: "#siteCard", zone: "Z3", rank: "secondary" },
    { selector: "#siteCard .site-card-head", zone: "Z3a", rank: "secondary" },
    { selector: "#siteCard .site-card-actions", zone: "Z3b", rank: "primary" },
    { selector: "#messages", zone: "Z4", rank: "primary" },
    { selector: ".composer", zone: "Z5", rank: "secondary" },
    { selector: ".composer .composer-bar", zone: "Z5a", rank: "tertiary" },
    { selector: ".composer .composer-actions", zone: "Z5c", rank: "secondary" },
    { selector: "#buildInfo", zone: "Z6", rank: "tertiary", type: "text" },
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
