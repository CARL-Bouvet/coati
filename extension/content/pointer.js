// Coati content script — highlights an element ("Show"). Injected by the panel
// with `chrome.scripting.executeScript({ files })`; loading it does nothing. The
// panel then calls `globalThis.__coatiPoint` in a second `executeScript`, always
// in direct response to the user's own click (docs/DECISIONS.md "gesture rule").
//
// It verifies the target against the live page first: `__coatiRefs` (isolated
// world only, set by content/extract/clickable-elements.js, never a DOM
// attribute a page could forge) must carry the same extractionId, the element
// must still be attached, and its live role and label must match what was
// recorded at extraction time. Any mismatch returns "stale".
//
// It only draws (scroll + a thin rim with orbiting halos, plus a dimming
// overlay at the stronger levels and a comet arrow with a label at the
// strongest): never a click, a focus or an input.
// `normalizeEffect`/`perimeterPoint`/`layoutComet` are pure and exposed on
// `globalThis.__coatiPointerInternals` for unit tests (no browser in bun test).

(() => {
  // Levels with a timeout; "spectacular" is deliberately absent — it is
  // dismissed by the user only (Escape / click anywhere), never by a clock.
  const HIGHLIGHT_MS = { subtle: 6000, strong: 10000 };
  const HOST_ID = "__coati-pointer-host";
  // scrollIntoView() itself fires a native "scroll" event; the "remove on
  // the NEXT scroll" rule means the user's OWN scroll,
  // not the one this function just caused. Arming the listener only after a
  // short grace period lets that one settle first. Applies to every level —
  // even "spectacular", which otherwise never dismisses on scroll, must not
  // dismiss on this particular, self-inflicted one either.
  const SCROLL_GUARD_MS = 400;
  const LABEL_MAX = 80;

  const CARAMEL_DARK = "#9C5A12";
  const CARAMEL = "#D98323";
  // Effect-only accent, never used elsewhere in Coati.
  const BLUE = "#4F8CFF";
  const CYAN = "#00E5FF";
  const MAGENTA = "#FF2BD6";
  const YELLOW = "#FFE600";

  // Per level: halo colours (orbiting, evenly spaced along the perimeter),
  // halo diameter and peak opacity, white-hot halo core, rim thickness, and
  // the soft light the spotlight hole spills onto the dimmed page.
  const LOOKS = {
    subtle: { colours: [CARAMEL, BLUE], halo: 120, alpha: 0.6, hot: false, rim: 2, spill: "" },
    strong: {
      colours: [CARAMEL, BLUE],
      halo: 170,
      alpha: 0.75,
      hot: true,
      rim: 2,
      spill: "0 0 16px 2px rgba(255, 255, 255, 0.16), ",
    },
    spectacular: {
      colours: [CYAN, MAGENTA, YELLOW],
      halo: 200,
      alpha: 0.8,
      hot: true,
      rim: 2.5,
      spill: "0 0 26px 4px rgba(255, 255, 255, 0.24), ",
    },
  };
  const HALO_STRETCH = 1.6; // halo length along the edge, relative to its depth
  const RIM_GAP = 2; // px between the element's edge and the rim
  const ORBIT_PX_PER_S = 110; // halo speed along the perimeter…
  const ORBIT_MIN_S = 4; // …bounded so a lap takes between 4 and 9 seconds
  const ORBIT_MAX_S = 9;

  const EDGE = 8; // px kept clear of the viewport edges
  const PILL_GAP = 12; // px between the label pill and the element
  const COMET_REACH = 16; // px between the comet's head and the element
  const COMET_SWING = 140; // vertical offset of the comet's entry point
  const SVG_NS = "http://www.w3.org/2000/svg";

  // --- Minimal live role/label readout -------------------------------------
  // Deliberately duplicated, not imported, from extract.js's own
  // roleOf()/elementLabel() — same non-module-injection constraint already
  // documented at the top of extract.js's "types de page" section (a
  // classic content script loaded via `files` cannot `import`). Kept
  // intentionally small: only enough to notice that a node's role/label
  // drifted from what was recorded at extraction time, not a full copy of
  // extract.js's rendering rules.
  const KNOWN_ROLES = new Set([
    "button",
    "link",
    "textbox",
    "checkbox",
    "radio",
    "combobox",
    "menuitem",
    "tab",
    "option",
    "switch",
  ]);

  function normalize(text) {
    return (text || "").replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim();
  }

  function truncateLabel(text) {
    if (text.length <= LABEL_MAX) return text;
    return `${text.slice(0, Math.max(0, LABEL_MAX - 1))}…`;
  }

  function liveVisibleText(el) {
    return typeof el.innerText === "string" ? el.innerText : el.textContent || "";
  }

  function liveInputRole(el) {
    const type = (el.getAttribute("type") || "text").toLowerCase();
    if (type === "checkbox") return "checkbox";
    if (type === "radio") return "radio";
    if (type === "submit" || type === "button" || type === "reset" || type === "image") return "button";
    return "textbox";
  }

  function liveRole(el) {
    const explicit = (el.getAttribute("role") || "").toLowerCase();
    if (explicit && KNOWN_ROLES.has(explicit)) return explicit;
    const tag = el.tagName;
    if (tag === "INPUT") return liveInputRole(el);
    if (tag === "SELECT") return "combobox";
    if (tag === "TEXTAREA") return "textbox";
    if (tag === "A") return "link";
    if (tag === "BUTTON") return "button";
    if (el.hasAttribute && el.hasAttribute("contenteditable")) return "textbox";
    return "button";
  }

  function liveLabel(el) {
    const text = normalize(liveVisibleText(el));
    if (text) return truncateLabel(text);
    const ariaLabel = normalize(el.getAttribute("aria-label") || "");
    if (ariaLabel) return truncateLabel(ariaLabel);
    const placeholder = normalize(el.getAttribute("placeholder") || el.getAttribute("title") || "");
    return truncateLabel(placeholder);
  }

  // --- Pure effect maths ----------------------------------------------------
  // No DOM access — easy to unit-test without a browser, which the rest of
  // this file cannot be.

  function normalizeEffect(value) {
    return value === "subtle" || value === "spectacular" ? value : "strong";
  }

  function clamp(value, min, max) {
    return Math.max(min, Math.min(max, value));
  }

  /** Point at distance `d` along a w×h box's edge, clockwise from its top-left corner. */
  function perimeterPoint(d, w, h) {
    const perimeter = 2 * (w + h);
    let rest = perimeter > 0 ? ((d % perimeter) + perimeter) % perimeter : 0;
    if (rest < w) return { x: rest, y: 0 };
    rest -= w;
    if (rest < h) return { x: w, y: rest };
    rest -= h;
    if (rest < w) return { x: w - rest, y: h };
    rest -= w;
    return { x: 0, y: h - Math.min(rest, h) };
  }

  // "spectacular": where the label pill goes and the curve the comet follows
  // from the viewport's right edge (where the browser side panel sits) to the
  // element. The pill goes above the element, else below, else beside it —
  // never over it unless the element leaves no room at all. The comet enters
  // from the vertical side opposite the pill, so the two do not cross.
  function layoutComet(rect, vw, vh, pillW, pillH) {
    const cx = clamp(rect.left + rect.width / 2, EDGE, vw - EDGE);
    const cy = clamp(rect.top + rect.height / 2, EDGE, vh - EDGE);
    let pill;
    if (rect.top - PILL_GAP - pillH >= EDGE) {
      pill = { left: rect.left, top: rect.top - PILL_GAP - pillH, side: "above" };
    } else if (rect.bottom + PILL_GAP + pillH <= vh - EDGE) {
      pill = { left: rect.left, top: rect.bottom + PILL_GAP, side: "below" };
    } else {
      const top = clamp(cy - pillH / 2, EDGE, vh - EDGE - pillH);
      pill =
        rect.left - PILL_GAP - pillW >= EDGE
          ? { left: rect.left - PILL_GAP - pillW, top, side: "left" }
          : { left: rect.right + PILL_GAP, top, side: "right" };
    }
    if (pill.side === "above" || pill.side === "below") {
      pill.left = clamp(pill.left, EDGE, vw - EDGE - pillW);
    }

    const startX = vw + 4;
    let start;
    let c1;
    let c2;
    let end;
    if (vw - rect.right >= COMET_REACH + 64) {
      // Room on the right: arrive horizontally on the element's right side.
      end = { x: rect.right + COMET_REACH, y: cy };
      const swing = pill.side === "below" ? -COMET_SWING : COMET_SWING;
      start = { x: startX, y: clamp(cy + swing, EDGE, vh - EDGE) };
      const dx = startX - end.x;
      c1 = { x: startX - dx * 0.6, y: start.y };
      c2 = { x: end.x + dx * 0.3, y: end.y };
    } else {
      // Pinned to the right edge: arrive on top or bottom, away from the pill.
      const roomAbove = rect.top >= COMET_REACH + 48;
      const roomBelow = vh - rect.bottom >= COMET_REACH + 48;
      const fromTop = pill.side === "above" ? !roomBelow : roomAbove;
      const dir = fromTop ? 1 : -1;
      end = { x: cx, y: fromTop ? rect.top - COMET_REACH : rect.bottom + COMET_REACH };
      start = { x: startX, y: clamp(end.y - dir * COMET_SWING, EDGE, vh - EDGE) };
      c1 = { x: startX - (startX - end.x) * 0.6, y: start.y };
      c2 = { x: end.x, y: end.y - dir * 80 };
    }
    const angle = (Math.atan2(end.y - c2.y, end.x - c2.x) * 180) / Math.PI;
    return { pill: { left: pill.left, top: pill.top }, start, c1, c2, end, angle };
  }

  // Test-only hook (bun test has no browser to drive __coatiPoint itself).
  // Harmless: pure functions, no reference to page state.
  globalThis.__coatiPointerInternals = { normalizeEffect, perimeterPoint, layoutComet };

  // --- Highlight lifecycle --------------------------------------------------

  function removeExistingHighlight() {
    if (typeof globalThis.__coatiPointerCleanup === "function") {
      try {
        globalThis.__coatiPointerCleanup();
      } catch {
        // best-effort — fall through to the direct DOM removal below too.
      }
    }
    globalThis.__coatiPointerCleanup = null;
    const existing = document.getElementById(HOST_ID);
    if (existing && existing.parentNode) existing.parentNode.removeChild(existing);
  }

  function positionAt(el, rect) {
    el.style.top = `${rect.top}px`;
    el.style.left = `${rect.left}px`;
    el.style.width = `${rect.width}px`;
    el.style.height = `${rect.height}px`;
  }

  function inflate(rect, by) {
    return { top: rect.top - by, left: rect.left - by, width: rect.width + 2 * by, height: rect.height + 2 * by };
  }

  function hexToRgb(hex) {
    const n = parseInt(hex.slice(1), 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  }

  function rgba(rgb, alpha) {
    return `rgba(${rgb[0]}, ${rgb[1]}, ${rgb[2]}, ${alpha})`;
  }

  // Everything below is built entirely via createElement/createElementNS and
  // style properties — no innerHTML, no markup string ever touches this
  // (project rule 16). It lives inside a CLOSED shadow root so the page's
  // own script cannot read or restyle any of it via `host.shadowRoot`. The
  // one <style> element only ever carries a literal, hardcoded keyframes
  // string written here — never anything derived from page content.
  // Continuous motion (the orbit) is driven by the rAF loop that already
  // follows the element; CSS keyframes only run one-shot entrances and the
  // comet's runner, both on opacity or a thin stroke.

  function buildStyle(reducedMotion) {
    const style = document.createElement("style");
    if (!reducedMotion) {
      style.textContent = `
        @keyframes coati-in { from { opacity: 0; } }
        @keyframes coati-draw { from { stroke-dashoffset: 1; } }
        @keyframes coati-run { from { stroke-dashoffset: 0.12; } to { stroke-dashoffset: -1; } }
      `;
    }
    return style;
  }

  function fixedBox() {
    const box = document.createElement("div");
    box.style.position = "fixed";
    box.style.boxSizing = "border-box";
    box.style.pointerEvents = "none";
    return box;
  }

  function fadeIn(node, reducedMotion, delayS) {
    if (!reducedMotion) node.style.animation = `coati-in 0.35s ease-out ${delayS}s both`;
  }

  // Keeps only the box's padding ring visible: the content box (the element
  // itself, for the glow layer) is masked out, so no light ever covers the
  // target. The shorthands go first since `mask` resets `mask-composite`.
  function cutOut(box, ring) {
    const layers = "linear-gradient(#000 0 0) content-box, linear-gradient(#000 0 0)";
    box.style.padding = `${ring}px`;
    box.style.setProperty("-webkit-mask", layers);
    box.style.setProperty("mask", layers);
    box.style.setProperty("-webkit-mask-composite", "xor");
    box.style.setProperty("mask-composite", "exclude");
  }

  // The dimming layer, "strong"/"spectacular" only: a box sized exactly to
  // the rim whose shadow is a 9999px-wide spread — the classic CSS spotlight
  // trick. Dims everything outside without a clip-path, and
  // `pointer-events: none` means it never intercepts the click it is framing.
  // A softer white shadow on top spills a little light around the hole.
  function buildSpotlight(look) {
    const hole = fixedBox();
    hole.style.borderRadius = "8px";
    hole.style.boxShadow = `${look.spill}0 0 0 9999px rgba(0, 0, 0, 0.55)`;
    return hole;
  }

  // One soft light per colour: an elliptical radial gradient (no blur
  // filter), centred on the element's edge and turned along it by the orbit,
  // its inner half hidden by the glow layer's mask so only the light
  // bleeding outwards shows.
  function buildHalo(rgb, look) {
    const halo = document.createElement("div");
    halo.style.position = "absolute";
    halo.style.top = "0";
    halo.style.left = "0";
    halo.style.width = `${look.halo * HALO_STRETCH}px`;
    halo.style.height = `${look.halo}px`;
    halo.style.willChange = "transform";
    const core = look.hot ? "rgba(255, 255, 255, 0.75) 0%, " : "";
    const a = look.alpha;
    halo.style.background = `radial-gradient(closest-side, ${core}${rgba(rgb, a)} ${look.hot ? 8 : 0}%, ${rgba(rgb, a * 0.55)} 24%, ${rgba(rgb, a * 0.2)} 52%, ${rgba(rgb, 0)} 100%)`;
    return halo;
  }

  // The rim's colour follows the halos: each halo's colour at full strength
  // where it sits, fading to a dimmer blend halfway to the next one. Halos
  // walk the perimeter clockwise, so their angles around the centre are
  // already in increasing order from the first one.
  function rimGradient(points, rgbs, w, h) {
    const angles = points.map((p) => ((Math.atan2(p.x - w / 2, h / 2 - p.y) * 180) / Math.PI + 360) % 360);
    const from = angles[0];
    const stops = [];
    for (let i = 0; i < points.length; i++) {
      const at = (angles[i] - from + 360) % 360;
      const next = i + 1 < points.length ? (angles[i + 1] - from + 360) % 360 : 360;
      const a = rgbs[i];
      const b = rgbs[(i + 1) % rgbs.length];
      const mid = [0, 1, 2].map((k) => Math.round((a[k] + b[k]) / 2));
      stops.push(`${rgba(a, 1)} ${at}deg`, `${rgba(mid, 0.45)} ${(at + next) / 2}deg`);
    }
    stops.push(`${rgba(rgbs[0], 1)} 360deg`);
    return `conic-gradient(from ${from}deg, ${stops.join(", ")})`;
  }

  function svgNode(tag, attrs) {
    const node = document.createElementNS(SVG_NS, tag);
    for (const [name, value] of Object.entries(attrs)) node.setAttribute(name, String(value));
    return node;
  }

  // "spectacular": a thin glowing stroke from the viewport's right edge to
  // the element, drawn in once, with a chevron head and a bright runner that
  // keeps travelling along it toward the element.
  function buildComet(reducedMotion) {
    const svg = svgNode("svg", { width: "100%", height: "100%" });
    svg.style.position = "fixed";
    svg.style.top = "0";
    svg.style.left = "0";
    svg.style.width = "100%";
    svg.style.height = "100%";
    svg.style.overflow = "visible";
    svg.style.pointerEvents = "none";
    // The trail and the runner both fade in from the viewport edge.
    const gradients = [];
    const defs = svgNode("defs", {});
    for (const [id, stops] of [
      ["coati-trail", [[0, CYAN, 0], [0.45, CYAN, 0.8], [0.85, MAGENTA, 1], [1, "#FFFFFF", 1]]],
      ["coati-runner", [[0, "#FFFFFF", 0], [0.5, "#FFFFFF", 0.9], [1, "#FFFFFF", 1]]],
    ]) {
      const gradient = svgNode("linearGradient", { id, gradientUnits: "userSpaceOnUse" });
      for (const [offset, colour, opacity] of stops) {
        gradient.appendChild(svgNode("stop", { offset, "stop-color": colour, "stop-opacity": opacity }));
      }
      defs.appendChild(gradient);
      gradients.push(gradient);
    }
    svg.appendChild(defs);

    const stroke = { fill: "none", "stroke-linecap": "round", "stroke-linejoin": "round", pathLength: 1 };
    const glow = svgNode("path", { ...stroke, stroke: "url(#coati-trail)", "stroke-width": 8, opacity: 0.3 });
    const core = svgNode("path", { ...stroke, stroke: "url(#coati-trail)", "stroke-width": 2 });
    const runner = svgNode("path", { ...stroke, stroke: "url(#coati-runner)", "stroke-width": 3 });
    const head = svgNode("g", {});
    const chevron = "M -10 -7 L 0 0 L -10 7";
    head.appendChild(svgNode("path", { ...stroke, d: chevron, stroke: MAGENTA, "stroke-width": 9, opacity: 0.35 }));
    head.appendChild(svgNode("path", { ...stroke, d: chevron, stroke: "#FFFFFF", "stroke-width": 2.5 }));
    for (const node of [glow, core, runner, head]) svg.appendChild(node);

    for (const path of [glow, core]) path.style.strokeDasharray = "1 1";
    runner.style.strokeDasharray = "0.12 1.2";
    if (reducedMotion) {
      runner.style.display = "none";
    } else {
      for (const path of [glow, core]) path.style.animation = "coati-draw 0.7s ease-out both";
      runner.style.animation = "coati-run 1.6s linear 0.8s infinite backwards";
      fadeIn(head, false, 0.55);
    }
    return { svg, gradients, paths: [glow, core, runner], head };
  }

  function placeComet(comet, layout) {
    const { start, c1, c2, end } = layout;
    const d = `M ${start.x} ${start.y} C ${c1.x} ${c1.y}, ${c2.x} ${c2.y}, ${end.x} ${end.y}`;
    for (const path of comet.paths) path.setAttribute("d", d);
    for (const gradient of comet.gradients) {
      gradient.setAttribute("x1", String(start.x));
      gradient.setAttribute("y1", String(start.y));
      gradient.setAttribute("x2", String(end.x));
      gradient.setAttribute("y2", String(end.y));
    }
    comet.head.setAttribute("transform", `translate(${end.x} ${end.y}) rotate(${layout.angle})`);
  }

  function buildLabelPill(label) {
    const pill = document.createElement("div");
    pill.style.position = "fixed";
    pill.style.top = "0";
    pill.style.left = "0";
    pill.style.pointerEvents = "none";
    pill.style.maxWidth = "280px";
    pill.style.padding = "6px 12px";
    pill.style.borderRadius = "999px";
    pill.style.background = CARAMEL_DARK;
    pill.style.color = "#fff";
    pill.style.font = "600 13px/1.3 system-ui, sans-serif";
    pill.style.whiteSpace = "nowrap";
    pill.style.overflow = "hidden";
    pill.style.textOverflow = "ellipsis";
    pill.style.boxShadow = "0 2px 6px rgba(0, 0, 0, 0.35), 0 0 14px rgba(217, 131, 35, 0.45)";
    pill.textContent = label || ""; // textContent only — project rule 16.
    return pill;
  }

  /** The live element behind `opts.ref`, or null when it is gone or changed. */
  function liveElement(opts) {
    const refs = globalThis.__coatiRefs;
    if (!refs || refs.extractionId !== (opts && opts.extractionId)) return null;
    const entry = refs.map && typeof refs.map.get === "function" ? refs.map.get(opts.ref) : null;
    if (!entry) return null;
    const el = entry.weakRef && typeof entry.weakRef.deref === "function" ? entry.weakRef.deref() : null;
    if (!el || !el.isConnected) return null;
    if (entry.role !== opts.role || entry.label !== opts.label) return null;
    // The page may have reused the SAME node for a different control since
    // extraction: re-derive role and label now.
    try {
      if (liveRole(el) !== entry.role || liveLabel(el) !== entry.label) return null;
    } catch {
      return null;
    }
    return el;
  }

  /**
   * @param {{extractionId: string, ref: string, role: string, label: string, effect?: "subtle"|"strong"|"spectacular"}|{clear: true}} opts
   * @returns {"ok"|"stale"}
   */
  globalThis.__coatiPoint = function coatiPoint(opts) {
    removeExistingHighlight(); // "one highlight at a time"

    // panel.js's toggle: a second click on the SAME "Montrer : …" button
    // calls `__coatiPoint({clear: true})` to remove the effect immediately,
    // without drawing anything new.
    if (opts && opts.clear) return "ok";

    const el = liveElement(opts);
    if (!el) return "stale";

    const effect = normalizeEffect(opts.effect);

    try {
      el.scrollIntoView({ block: "center" });
    } catch {
      // best-effort — still try to draw the frame at wherever the element is.
    }

    const rect = typeof el.getBoundingClientRect === "function" ? el.getBoundingClientRect() : null;
    if (!rect) return "stale";

    const reducedMotion = !!(window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches);

    const host = document.createElement("div");
    host.id = HOST_ID;
    host.style.position = "fixed";
    host.style.top = "0";
    host.style.left = "0";
    host.style.width = "0";
    host.style.height = "0";
    host.style.zIndex = "2147483647";
    host.style.pointerEvents = "none";
    const shadow = host.attachShadow({ mode: "closed" });
    shadow.appendChild(buildStyle(reducedMotion));

    const look = LOOKS[effect];
    const rgbs = look.colours.map(hexToRgb);

    const spotlight = effect !== "subtle" ? buildSpotlight(look) : null;
    if (spotlight) shadow.appendChild(spotlight);

    const glowPad = (look.halo * HALO_STRETCH) / 2;
    const glow = fixedBox();
    cutOut(glow, glowPad);
    fadeIn(glow, reducedMotion, 0);
    const halos = rgbs.map((rgb) => buildHalo(rgb, look));
    for (const halo of halos) glow.appendChild(halo);
    shadow.appendChild(glow);

    const rim = fixedBox();
    rim.style.borderRadius = "8px";
    cutOut(rim, look.rim);
    fadeIn(rim, reducedMotion, 0);
    shadow.appendChild(rim);

    let comet = null;
    let pill = null;
    if (effect === "spectacular") {
      comet = buildComet(reducedMotion);
      pill = buildLabelPill(opts.label);
      fadeIn(pill, reducedMotion, 0.6);
      shadow.appendChild(comet.svg);
      shadow.appendChild(pill);
    }

    (document.documentElement || document.body).appendChild(host);

    // Draws one frame: re-places everything when the element or the viewport
    // moved, and advances the orbit (a fraction of a lap, so it survives a
    // resize) unless motion is reduced. Halos start on the element's left and
    // right sides, which is also where they stay under reduced motion.
    let last = null;
    let lap = (2 * rect.width + 1.5 * rect.height) / (2 * (rect.width + rect.height) || 1);
    let lastTime = null;
    const render = (now) => {
      const r = el.getBoundingClientRect();
      const vw = window.innerWidth;
      const vh = window.innerHeight;
      const moved =
        !last ||
        r.top !== last.top ||
        r.left !== last.left ||
        r.width !== last.width ||
        r.height !== last.height ||
        vw !== last.vw ||
        vh !== last.vh;
      const perimeter = 2 * (r.width + r.height);
      if (!reducedMotion && lastTime !== null) {
        const lapSeconds = clamp(perimeter / ORBIT_PX_PER_S, ORBIT_MIN_S, ORBIT_MAX_S);
        lap = (lap + (now - lastTime) / 1000 / lapSeconds) % 1;
      }
      lastTime = now;
      if (moved) {
        last = { top: r.top, left: r.left, width: r.width, height: r.height, vw, vh };
        const rimBox = inflate(r, RIM_GAP + look.rim);
        if (spotlight) positionAt(spotlight, rimBox);
        positionAt(rim, rimBox);
        positionAt(glow, inflate(r, glowPad));
        if (comet && pill) {
          const layout = layoutComet(r, vw, vh, pill.offsetWidth, pill.offsetHeight);
          placeComet(comet, layout);
          pill.style.transform = `translate(${layout.pill.left}px, ${layout.pill.top}px)`;
        }
      }
      if (moved || !reducedMotion) {
        // The edge direction is taken across a short span, so a halo turns
        // smoothly around a corner instead of snapping by 90°.
        const span = Math.max(1, Math.min(24, r.width / 2, r.height / 2));
        const points = halos.map((halo, i) => {
          const d = (lap + i / halos.length) * perimeter;
          const p = perimeterPoint(d, r.width, r.height);
          const ahead = perimeterPoint(d + span, r.width, r.height);
          const behind = perimeterPoint(d - span, r.width, r.height);
          const turn = Math.atan2(ahead.y - behind.y, ahead.x - behind.x);
          const x = glowPad + p.x - (look.halo * HALO_STRETCH) / 2;
          const y = glowPad + p.y - look.halo / 2;
          halo.style.transform = `translate(${x}px, ${y}px) rotate(${turn}rad)`;
          return p;
        });
        rim.style.background = rimGradient(points, rgbs, r.width, r.height);
      }
    };
    render(performance.now());

    // Tracks the live element every frame — covers both the page's own
    // scroll/resize during the effect and this function's own
    // scrollIntoView() above, so the overlay never lags or snaps away.
    let rafId = null;
    const follow = (now) => {
      render(now);
      rafId = requestAnimationFrame(follow);
    };
    rafId = requestAnimationFrame(follow);

    let scrollGuardArmed = false;
    const armTimeoutId = setTimeout(() => {
      scrollGuardArmed = true;
    }, SCROLL_GUARD_MS);

    // "subtle"/"strong" dismiss on the user's next real scroll (after the
    // scrollIntoView grace period above); "spectacular" never does — it
    // already tracks the element continuously, and per spec is dismissed by
    // Escape or a click only.
    const dismissOnScroll = effect !== "spectacular";
    // "strong"/"spectacular" also dismiss on a click anywhere on the page —
    // the click still reaches whatever is underneath first, since every
    // node here is `pointer-events: none`.
    const dismissOnClick = effect !== "subtle";

    function onKeydown(e) {
      if (e.key === "Escape") cleanup();
    }
    function onScroll() {
      if (scrollGuardArmed) cleanup();
    }
    function onClick() {
      cleanup();
    }
    document.addEventListener("keydown", onKeydown, true);
    if (dismissOnScroll) window.addEventListener("scroll", onScroll, true);
    if (dismissOnClick) window.addEventListener("click", onClick, true);

    const timeoutMs = HIGHLIGHT_MS[effect];
    const removeTimeoutId = timeoutMs ? setTimeout(cleanup, timeoutMs) : null;

    function cleanup() {
      if (rafId !== null) cancelAnimationFrame(rafId);
      clearTimeout(armTimeoutId);
      if (removeTimeoutId !== null) clearTimeout(removeTimeoutId);
      document.removeEventListener("keydown", onKeydown, true);
      if (dismissOnScroll) window.removeEventListener("scroll", onScroll, true);
      if (dismissOnClick) window.removeEventListener("click", onClick, true);
      if (host.parentNode) host.parentNode.removeChild(host);
      if (globalThis.__coatiPointerCleanup === cleanup) globalThis.__coatiPointerCleanup = null;
    }
    globalThis.__coatiPointerCleanup = cleanup;

    return "ok";
  };
})();
