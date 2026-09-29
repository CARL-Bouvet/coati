// Coati state lab — identity comparatif.
//
// A set of pairings side by side, light tree only, state=idle: one labelled
// column per pairing. Which pairings, via `?pairs=p1,p2,p3,p4` (comma
// separated ids); defaults to the round-1 set. Regenerated verbatim into
// .tmp/lab/identity/comparatif.js by build-lab.ts — never edit the copy in
// .tmp/lab, edit this file instead.
(function () {
  "use strict";

  var table = window.__COATI_LAB_PAIRS__ || {};
  var params = new URLSearchParams(location.search);
  var order = (params.get("pairs") || "p1,p2,p3,p4").split(",");
  var root = document.getElementById("comparatif");

  order.forEach(function (id) {
    var pair = table[id];
    if (!pair) return;

    var col = document.createElement("div");
    col.className = "comparatif__col";

    var label = document.createElement("p");
    label.className = "comparatif__label";
    label.textContent = pair.label;
    col.appendChild(label);

    var iframe = document.createElement("iframe");
    iframe.src = "../light/panel/panel.html?state=idle&pair=" + pair.id;
    col.appendChild(iframe);

    root.appendChild(col);
  });
})();
