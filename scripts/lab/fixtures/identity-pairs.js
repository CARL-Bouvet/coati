// Coati state lab — identity board fixtures.
//
// The four fixed typeface x accent pairings the founder chooses from (see
// worker brief). Pure data, consumed by static/lab-pair.js (applies a
// pairing to a real panel/options page via ?pair=) and static/board.js
// (renders the identity board). Copied verbatim into every generated tree
// by build-lab.ts — never edit a copy in .tmp/lab, edit this file instead.
(function () {
  "use strict";

  // c1 only: the anthracite header, identical in both themes.
  var C1_HEADER_CSS =
    ".topbar{--bg:#2A2C30;--fg:#EDEEF0;--muted:#B4B7BE;--surface:#34373D;--border:#2A2C30;" +
    "--accent:#D98323;--accent-fg:#1F2023;--status-connected:#5fd88a;--status-connecting:#f0b429;" +
    "--status-disconnected:#f2b8b5;--status-idle:#8A8E96;color:var(--fg);}" +
    ".topbar .icon-button{color:var(--fg);}";
  // Slate blue, the secondary tone, on the panel's plain links ("Mes prompts").
  var C1_LINK = ".link-button:not(.link-button--danger):not(.link-button--confirm){color:";
  var C1_CSS_LIGHT = C1_HEADER_CSS + C1_LINK + "#4A6A88;}";
  var C1_CSS_DARK = C1_HEADER_CSS + C1_LINK + "#8AA4BE;}";

  window.__COATI_LAB_PAIRS__ = {
    p1: {
      id: "p1",
      label: "Manrope + lavande",
      fontFamily: "Manrope",
      fontFile: "manrope.woff2",
      light: { accent: "#7E62AD", accentFg: "#FFFFFF" },
      dark: { accent: "#937BBA", accentFg: "#16181D" },
    },
    p2: {
      id: "p2",
      label: "Inter + océan",
      fontFamily: "Inter",
      fontFile: "inter.woff2",
      light: { accent: "#2B6CB0", accentFg: "#FFFFFF" },
      dark: { accent: "#4489D1", accentFg: "#16181D" },
    },
    p3: {
      id: "p3",
      label: "Figtree + forêt",
      fontFamily: "Figtree",
      fontFile: "figtree.woff2",
      light: { accent: "#1E7C5F", accentFg: "#FFFFFF" },
      dark: { accent: "#249773", accentFg: "#16181D" },
    },
    p4: {
      id: "p4",
      label: "Geist + roux coati",
      fontFamily: "Geist",
      fontFile: "geist.woff2",
      light: { accent: "#A4502A", accentFg: "#FFFFFF" },
      dark: { accent: "#CD693C", accentFg: "#16181D" },
    },

    // --- Round 2: Ubuntu-like identity — figtree + warm greys + one
    // brown/orange accent. `neutrals` overrides the neutral tokens on top of
    // theme.css's defaults; absent in p1-p4 (those keep theme.css neutrals).
    g1: {
      id: "g1",
      label: "Figtree + caramel",
      fontFamily: "Figtree",
      fontFile: "figtree.woff2",
      light: {
        accent: "#9C5A12",
        accentFg: "#FFFFFF",
        neutrals: {
          "--bg": "#FFFFFF",
          "--surface": "#F4F3F1",
          "--fg": "#2C2A28",
          "--muted": "#6B6560",
          "--border": "#A8A29B",
          "--message-user-bg": "#ECEAE7",
          "--message-assistant-bg": "#F4F3F1",
        },
      },
      dark: {
        accent: "#C77317",
        accentFg: "#1C1B1A",
        neutrals: {
          "--bg": "#1C1B1A",
          "--surface": "#262422",
          "--fg": "#F2F1F0",
          "--muted": "#B5AFA8",
          "--border": "#6E6862",
          "--message-user-bg": "#33302D",
          "--message-assistant-bg": "#262422",
        },
      },
    },
    g2: {
      id: "g2",
      label: "Figtree + noisette",
      fontFamily: "Figtree",
      fontFile: "figtree.woff2",
      light: {
        accent: "#8B5E3C",
        accentFg: "#FFFFFF",
        neutrals: {
          "--bg": "#FFFFFF",
          "--surface": "#F4F3F1",
          "--fg": "#2C2A28",
          "--muted": "#6B6560",
          "--border": "#A8A29B",
          "--message-user-bg": "#ECEAE7",
          "--message-assistant-bg": "#F4F3F1",
        },
      },
      dark: {
        accent: "#B47B51",
        accentFg: "#1C1B1A",
        neutrals: {
          "--bg": "#1C1B1A",
          "--surface": "#262422",
          "--fg": "#F2F1F0",
          "--muted": "#B5AFA8",
          "--border": "#6E6862",
          "--message-user-bg": "#33302D",
          "--message-assistant-bg": "#262422",
        },
      },
    },
    g3: {
      id: "g3",
      label: "Figtree + cuivre",
      fontFamily: "Figtree",
      fontFile: "figtree.woff2",
      light: {
        accent: "#B35C1E",
        accentFg: "#FFFFFF",
        neutrals: {
          "--bg": "#FFFFFF",
          "--surface": "#F4F3F1",
          "--fg": "#2C2A28",
          "--muted": "#6B6560",
          "--border": "#A8A29B",
          "--message-user-bg": "#ECEAE7",
          "--message-assistant-bg": "#F4F3F1",
        },
      },
      dark: {
        accent: "#D26C23",
        accentFg: "#1C1B1A",
        neutrals: {
          "--bg": "#1C1B1A",
          "--surface": "#262422",
          "--fg": "#F2F1F0",
          "--muted": "#B5AFA8",
          "--border": "#6E6862",
          "--message-user-bg": "#33302D",
          "--message-assistant-bg": "#262422",
        },
      },
    },
    g4: {
      id: "g4",
      label: "Figtree + caramel, fond gris",
      fontFamily: "Figtree",
      fontFile: "figtree.woff2",
      light: {
        accent: "#9C5A12",
        accentFg: "#FFFFFF",
        neutrals: {
          "--bg": "#F4F3F1",
          "--surface": "#EAE8E5",
          "--fg": "#2C2A28",
          "--muted": "#6B6560",
          "--border": "#A8A29B",
          "--message-user-bg": "#ECEAE7",
          "--message-assistant-bg": "#F4F3F1",
        },
      },
      dark: {
        accent: "#C77317",
        accentFg: "#1C1B1A",
        neutrals: {
          "--bg": "#1C1B1A",
          "--surface": "#262422",
          "--fg": "#F2F1F0",
          "--muted": "#B5AFA8",
          "--border": "#6E6862",
          "--message-user-bg": "#33302D",
          "--message-assistant-bg": "#262422",
        },
      },
    },
    // --- Round 3 (27/09, validated direction): the Coati palette. Same values
    // as THEMES in scripts/brand/build-brand.py (private palette notes) —
    // keep both in sync. Neutral technical greys, caramel primary, slate-blue
    // tint on the user bubble, anthracite header in both themes (lab-only CSS:
    // the header re-scopes the dark-theme tokens, so its text, status dots and
    // gear stay readable on anthracite).
    c1: {
      id: "c1",
      label: "Coati — caramel, anthracite, bleu ardoise",
      fontFamily: "Figtree",
      fontFile: "figtree.woff2",
      light: {
        accent: "#9C5A12",
        accentFg: "#FFFFFF",
        neutrals: {
          "--bg": "#FFFFFF",
          "--surface": "#F4F5F7",
          "--fg": "#2A2C30",
          "--muted": "#61646C",
          "--border": "#8A8E96",
          "--message-user-bg": "#E4EAF1",
          "--message-assistant-bg": "#F4F5F7",
        },
        css: C1_CSS_LIGHT,
      },
      dark: {
        accent: "#D98323",
        accentFg: "#1F2023",
        neutrals: {
          "--bg": "#1F2023",
          "--surface": "#2A2C30",
          "--fg": "#EDEEF0",
          "--muted": "#A9ACB3",
          "--border": "#777B83",
          "--message-user-bg": "#2F3B48",
          "--message-assistant-bg": "#2A2C30",
        },
        css: C1_CSS_DARK,
      },
    },
  };
})();
