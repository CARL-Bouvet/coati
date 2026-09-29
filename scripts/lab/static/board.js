// Coati state lab — identity board.
//
// Reads ?pair=p1..p4, renders the pairing's name/hexes/type specimen (in the
// pairing's own font) above two iframes: the real panel, light and dark,
// state=conversation, with the same pairing applied via lab-pair.js.
//
// Regenerated verbatim into .tmp/lab/identity/board.js by build-lab.ts —
// never edit the copy in .tmp/lab, edit this file instead.
(function () {
  "use strict";

  var params = new URLSearchParams(location.search);
  var pairId = params.get("pair");
  var table = window.__COATI_LAB_PAIRS__ || {};
  var pair = table[pairId];

  var board = document.getElementById("board");
  var errorEl = document.getElementById("boardError");

  if (!pair) {
    if (errorEl) errorEl.hidden = false;
    return;
  }

  var scriptSrc = document.currentScript.src;
  var fontUrl = new URL("../assets/fonts/" + pair.fontFile, scriptSrc).href;

  var fontFace = document.createElement("style");
  fontFace.textContent =
    "@font-face{font-family:'" + pair.fontFamily + "';src:url('" + fontUrl + "') format('woff2');" +
    "font-weight:100 900;font-display:block;}";
  document.head.appendChild(fontFace);

  var header = document.createElement("div");
  header.className = "board__header";
  header.innerHTML =
    '<p class="board__name">' + pair.label + "</p>" +
    '<p class="board__hexes">accent du thème clair ' + pair.light.accent + " · accent du thème sombre " + pair.dark.accent + "</p>";

  var specimen = document.createElement("div");
  specimen.className = "board__specimen";
  specimen.style.fontFamily = "'" + pair.fontFamily + "', system-ui, sans-serif";

  var huge = document.createElement("div");
  huge.className = "board__specimen-huge";
  huge.textContent = "Coati";
  specimen.appendChild(huge);

  var LINE = "Résumer cette page — àâçéèêëîïôœùûü « guillemets » 0123456789";
  var line15 = document.createElement("div");
  line15.className = "board__specimen-15";
  line15.textContent = LINE;
  specimen.appendChild(line15);

  var line13 = document.createElement("div");
  line13.className = "board__specimen-13";
  line13.textContent = LINE;
  specimen.appendChild(line13);

  header.appendChild(specimen);
  board.appendChild(header);

  var panels = document.createElement("div");
  panels.className = "board__panels";

  [
    { tree: "light", title: "Thème clair" },
    { tree: "dark", title: "Thème sombre" },
  ].forEach(function (entry) {
    var wrap = document.createElement("div");
    wrap.className = "board__panel";

    var label = document.createElement("p");
    label.className = "board__panel-label";
    label.textContent = entry.title;
    wrap.appendChild(label);

    var iframe = document.createElement("iframe");
    iframe.src = "../" + entry.tree + "/panel/panel.html?state=conversation&pair=" + pair.id;
    wrap.appendChild(iframe);

    panels.appendChild(wrap);
  });

  board.appendChild(panels);
})();
