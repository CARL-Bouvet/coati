// Coati state lab — visual zone annotation for the "propositions" page
// (scripts/lab/propositions/, section 1: "Plan du panneau").
//
// Draws an outline + numbered badge over each zone tagged by
// panel-zones.js (data-zone), using the vocabulary agreed with Romain
// (1, 2, 3, 3a, 3b, 4, 5, 5a, 5b, 5c — see scripts/lab/propositions/README
// or the propositions page itself for the legend). No-op unless the page
// URL carries `&annotate=1`: never runs during normal state-lab browsing.
//
// Lab-only, never shipped: appended to panel.html only by build-lab.ts
// (extraScriptRelPaths), same mechanism as panel-zones.js.
(function () {
  "use strict";

  var params = new URLSearchParams(location.search);
  if (params.get("annotate") !== "1") return;

  var ORDER = ["Z1", "Z2", "Z3", "Z3a", "Z3b", "Z4", "Z5", "Z5a", "Z5b", "Z5c"];
  var NUMS = {
    Z1: "1",
    Z2: "2",
    Z3: "3",
    Z3a: "3a",
    Z3b: "3b",
    Z4: "4",
    Z5: "5",
    Z5a: "5a",
    Z5b: "5b",
    Z5c: "5c",
  };

  function clearPrevious() {
    var nodes = document.querySelectorAll(".coati-annotate-box");
    for (var i = 0; i < nodes.length; i++) nodes[i].remove();
  }

  function draw() {
    clearPrevious();
    var topbar = document.querySelector(".topbar");
    for (var i = 0; i < ORDER.length; i++) {
      var code = ORDER[i];
      var el = document.querySelector('[data-zone="' + code + '"]');
      if (!el) continue;
      var rect = el.getBoundingClientRect();
      var isHidden = rect.width === 0 && rect.height === 0;

      if (isHidden) {
        // #connectionBanner only shows during an outage: it occupies the
        // exact spot #siteCard sits in the rest of the time, so a full-size
        // outline there would sit exactly on top of zone 3's (drawn next)
        // and hide it. A small dashed tag hanging off the topbar's corner
        // avoids the collision entirely; the legend carries the "visible
        // seulement en cas de panne" note.
        var tRect = topbar ? topbar.getBoundingClientRect() : { left: 0, right: 360, bottom: 0 };
        var tag = document.createElement("span");
        tag.className = "coati-annotate-box";
        tag.textContent = NUMS[code];
        tag.style.position = "fixed";
        tag.style.left = tRect.right - 24 + "px";
        tag.style.top = tRect.bottom + 3 + "px";
        tag.style.background = "#fff";
        tag.style.color = "#D6336C";
        tag.style.border = "2px dashed #D6336C";
        tag.style.font = "700 11px/16px 'Figtree', sans-serif";
        tag.style.minWidth = "16px";
        tag.style.height = "16px";
        tag.style.borderRadius = "8px";
        tag.style.textAlign = "center";
        tag.style.padding = "0 2px";
        tag.style.pointerEvents = "none";
        tag.style.zIndex = "9999";
        document.body.appendChild(tag);
        continue;
      }

      var box = document.createElement("div");
      box.className = "coati-annotate-box";
      box.style.position = "fixed";
      box.style.left = rect.left + "px";
      box.style.top = rect.top + "px";
      box.style.width = Math.max(rect.width, 20) + "px";
      box.style.height = Math.max(rect.height, 20) + "px";
      box.style.outline = "2px solid #D6336C";
      box.style.outlineOffset = "-1px";
      box.style.pointerEvents = "none";
      box.style.zIndex = "9998";
      box.style.boxSizing = "border-box";

      // Kept fully inside the box (never a negative offset): several zones
      // sit flush against the panel's own left/top edge (topbar, messages),
      // and a badge straddling that edge gets clipped by the iframe itself.
      // Lettered (nested) zones share their parent's top-left corner once
      // padding is this small (site-card, composer): anchoring them at the
      // BOTTOM-left instead keeps every badge visible on its own, never
      // stacked behind its parent's.
      var nested = /[a-z]$/.test(code);
      var badge = document.createElement("span");
      badge.textContent = NUMS[code];
      badge.style.position = "absolute";
      if (nested) {
        badge.style.bottom = "2px";
        badge.style.left = "2px";
      } else {
        badge.style.top = "2px";
        badge.style.left = "2px";
      }
      badge.style.background = "#D6336C";
      badge.style.color = "#fff";
      badge.style.font = "700 11px/18px 'Figtree', sans-serif";
      badge.style.minWidth = "18px";
      badge.style.height = "18px";
      badge.style.borderRadius = "9px";
      badge.style.textAlign = "center";
      badge.style.padding = "0 2px";
      badge.style.boxShadow = "0 1px 2px rgba(0,0,0,.35)";
      box.appendChild(badge);
      document.body.appendChild(box);
    }
  }

  window.addEventListener("load", function () {
    setTimeout(draw, 50);
  });
  new MutationObserver(function () {
    setTimeout(draw, 30);
  }).observe(document.body, { childList: true, subtree: true });
})();
