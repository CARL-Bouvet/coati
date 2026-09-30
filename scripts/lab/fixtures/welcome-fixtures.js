// Coati state lab — welcome/welcome.html fixtures (G5, docs/DECISIONS.md T51).
// The page is static; the only thing that varies is the engine, which picks
// the "pin the icon" wording (lib/browser-compat.js IS_GECKO).
(function () {
  "use strict";

  window.__COATI_LAB_FIXTURES__ = {
    // Chrome, Brave, Edge : menu des extensions (pièce de puzzle), épingle.
    chromium: {
      status: "connected",
    },

    // Firefox : bouton des extensions, roue dentée, « Épingler à la barre d'outils ».
    firefox: {
      status: "connected",
      gecko: true,
    },
  };
})();
