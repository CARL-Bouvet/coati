// Coati state lab — welcome/welcome.html fixtures (docs/DECISIONS.md T51).
// What varies: the engine (pin wording, lib/browser-compat.js IS_GECKO), the
// connection state (program step), the system (download buttons) and, for
// review only, the open step ("coati:welcomeStep" in storage; production never
// sets it).
(function () {
  "use strict";

  // Step 2 with a way chosen: the frame shows options.html in state "embed-access".
  function access(o) {
    var f = welcome({ status: "connected", step: "access" });
    if (o.choice) f.autoAction = { steps: [{ type: "click", selector: 'input[value="' + o.choice + '"]', delayMs: 100 }] };
    return f;
  }

  function welcome(o) {
    var storage = {};
    if (o.step) storage["coati:welcomeStep"] = o.step;
    return {
      status: o.status || "no-host",
      labPlatformInfo: { os: "mac", arch: "arm64" },
      // Any state may open the access frame (a click in step 2): it always gets this options state.
      labFrameState: "embed-access",
      storageLocal: storage,
    };
  }

  window.__COATI_LAB_FIXTURES__ = {
    // Chrome, Brave, Edge : menu des extensions (pièce de puzzle), épingle.
    chromium: {
      status: "connected",
      labFrameState: "embed-access",
    },

    // Firefox : bouton des extensions, roue dentée, « Épingler à la barre d'outils ».
    firefox: {
      status: "connected",
      gecko: true,
      labFrameState: "embed-access",
    },

    waiting: welcome({}),
    connected: welcome({ status: "connected" }),
    theme: welcome({ status: "connected", step: "theme" }),
    access: access({}),
    "access-local": access({ choice: "local" }),
    "access-openrouter": access({ choice: "openrouter" }),
  };
})();
