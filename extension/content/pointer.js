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
// It only draws (scroll + a frame, plus a dimming overlay, pulse rings and an
// arrow at the stronger levels): never a click, a focus or an input.
// `normalizeEffect`/`pickArrowSide` are pure and exposed on
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
  const ARROW_SIZE = 56;
  const ARROW_GAP = 14; // px between the arrow's tip and the element's edge
  const PILL_GAP = 8; // px between the pill's bottom edge and the arrow

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
  // this file cannot be. Kept tiny on purpose (same spirit as the
  // liveRole/liveLabel readout above): one normalizer, one "which side has
  // the most room" pick for the "spectacular" arrow.

  function normalizeEffect(value) {
    return value === "subtle" || value === "spectacular" ? value : "strong";
  }

  function pickArrowSide(rect, viewportWidth, viewportHeight) {
    const room = {
      top: rect.top,
      bottom: viewportHeight - rect.bottom,
      left: rect.left,
      right: viewportWidth - rect.right,
    };
    let best = "bottom";
    let bestRoom = -Infinity;
    for (const side of ["top", "bottom", "left", "right"]) {
      if (room[side] > bestRoom) {
        bestRoom = room[side];
        best = side;
      }
    }
    return best;
  }

  // Test-only hook (bun test has no browser to drive __coatiPoint itself).
  // Harmless: pure functions, no reference to page state.
  globalThis.__coatiPointerInternals = { normalizeEffect, pickArrowSide };

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

  // Everything below is built entirely via createElement/createElementNS and
  // style properties — no innerHTML, no markup string ever touches this
  // (CLAUDE.md rule #3). It lives inside a CLOSED shadow root so the page's
  // own script cannot read or restyle any of it via `host.shadowRoot`. The
  // one <style> element only ever carries a literal, hardcoded keyframes
  // string written here — never anything derived from page content.

  function buildStyle(reducedMotion) {
    const style = document.createElement("style");
    if (!reducedMotion) {
      style.textContent = `
        @keyframes coati-pulse {
          from { transform: scale(1); opacity: .85; }
          to { transform: scale(1.6); opacity: 0; }
        }
        @keyframes coati-bounce-top { 0%, 100% { transform: rotate(180deg) translateY(0); } 50% { transform: rotate(180deg) translateY(-10px); } }
        @keyframes coati-bounce-bottom { 0%, 100% { transform: translateY(0); } 50% { transform: translateY(10px); } }
        @keyframes coati-bounce-left { 0%, 100% { transform: rotate(90deg) translateX(0); } 50% { transform: rotate(90deg) translateX(-10px); } }
        @keyframes coati-bounce-right { 0%, 100% { transform: rotate(-90deg) translateX(0); } 50% { transform: rotate(-90deg) translateX(10px); } }
      `;
    }
    return style;
  }

  // The dimming layer, "strong"/"spectacular" only: a box sized exactly to
  // the element's rect whose shadow is a 9999px-wide spread — the classic
  // CSS spotlight trick. Dims everything outside the rect without a
  // clip-path, and `pointer-events: none` means it never intercepts the
  // click it is framing.
  function buildSpotlight(rect) {
    const hole = document.createElement("div");
    hole.style.position = "fixed";
    hole.style.boxSizing = "border-box";
    hole.style.borderRadius = "6px";
    hole.style.boxShadow = "0 0 0 9999px rgba(0, 0, 0, 0.55)";
    hole.style.pointerEvents = "none";
    positionAt(hole, rect);
    return hole;
  }

  function buildFrame(rect, effect) {
    const frame = document.createElement("div");
    frame.style.position = "fixed";
    frame.style.boxSizing = "border-box";
    frame.style.pointerEvents = "none";
    if (effect === "subtle") {
      frame.style.border = "3px solid " + CARAMEL;
      frame.style.borderRadius = "4px";
      // Soft outer glow — the only emphasis "subtle" gets beyond the
      // thicker border; "strong"/"spectacular" rely on the spotlight
      // instead, a glow would be lost against the dimmed backdrop.
      frame.style.boxShadow = "0 0 0 2px rgba(217, 131, 35, 0.35), 0 0 16px 4px rgba(217, 131, 35, 0.45)";
    } else {
      frame.style.border = "4px solid " + CARAMEL;
      frame.style.borderRadius = "6px";
    }
    positionAt(frame, rect);
    return frame;
  }

  // 3 rings, each a one-shot "expand and fade" from the element's own rect
  // — `transform: scale()` grows them from their own center, so no extra
  // position math is needed beyond matching the element's box. Staggered
  // delays spread the 3 over ~1.5 s total, then `forwards` leaves them
  // invisible (no need to remove them from the DOM afterwards).
  function buildPulseRings(rect) {
    const rings = [];
    for (let i = 0; i < 3; i++) {
      const ring = document.createElement("div");
      ring.style.position = "fixed";
      ring.style.boxSizing = "border-box";
      ring.style.border = "2px solid rgba(217, 131, 35, 0.6)";
      ring.style.borderRadius = "6px";
      ring.style.pointerEvents = "none";
      ring.style.animation = `coati-pulse 1.5s ease-out ${i * 0.45}s 1 forwards`;
      positionAt(ring, rect);
      rings.push(ring);
    }
    return rings;
  }

  // Triangle pointing "up" by default (apex first); rotated per side so its
  // tip always faces the element it bounces toward.
  const ARROW_ROTATION = { bottom: 0, top: 180, left: 90, right: -90 };

  function buildArrow(side, reducedMotion) {
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.setAttribute("width", String(ARROW_SIZE));
    svg.setAttribute("height", String(ARROW_SIZE));
    svg.setAttribute("viewBox", "0 0 64 64");
    svg.style.position = "fixed";
    svg.style.pointerEvents = "none";
    svg.style.filter = "drop-shadow(0 2px 4px rgba(0, 0, 0, 0.35))";
    const poly = document.createElementNS("http://www.w3.org/2000/svg", "polygon");
    poly.setAttribute("points", "32,4 58,56 6,56");
    poly.setAttribute("fill", CARAMEL);
    poly.setAttribute("stroke", CARAMEL_DARK);
    poly.setAttribute("stroke-width", "3");
    poly.setAttribute("stroke-linejoin", "round");
    svg.appendChild(poly);
    if (reducedMotion) {
      svg.style.transform = `rotate(${ARROW_ROTATION[side]}deg)`;
    } else {
      svg.style.animation = `coati-bounce-${side} 0.9s ease-in-out infinite`;
    }
    return svg;
  }

  function buildLabelPill(label) {
    const pill = document.createElement("div");
    pill.style.position = "fixed";
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
    pill.style.boxShadow = "0 2px 6px rgba(0, 0, 0, 0.35)";
    pill.textContent = label || ""; // textContent only — CLAUDE.md rule #3.
    return pill;
  }

  // Re-run every frame while the arrow is shown: the arrow sits just outside
  // the element's rect on `side`, the pill is centered above the arrow.
  function placeArrowAndPill(arrow, pill, rect, side) {
    const cx = rect.left + rect.width / 2;
    const cy = rect.top + rect.height / 2;
    let ax;
    let ay;
    if (side === "bottom") {
      ax = cx - ARROW_SIZE / 2;
      ay = rect.bottom + ARROW_GAP;
    } else if (side === "top") {
      ax = cx - ARROW_SIZE / 2;
      ay = rect.top - ARROW_GAP - ARROW_SIZE;
    } else if (side === "left") {
      ax = rect.left - ARROW_GAP - ARROW_SIZE;
      ay = cy - ARROW_SIZE / 2;
    } else {
      ax = rect.right + ARROW_GAP;
      ay = cy - ARROW_SIZE / 2;
    }
    arrow.style.left = `${ax}px`;
    arrow.style.top = `${ay}px`;
    pill.style.left = `${ax + ARROW_SIZE / 2}px`;
    pill.style.top = `${ay - PILL_GAP}px`;
    pill.style.transform = "translate(-50%, -100%)";
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

    const spotlight = effect !== "subtle" ? buildSpotlight(rect) : null;
    if (spotlight) shadow.appendChild(spotlight);

    const frame = buildFrame(rect, effect);
    shadow.appendChild(frame);

    const rings = effect !== "subtle" ? buildPulseRings(rect) : [];
    for (const ring of rings) shadow.appendChild(ring);

    let arrow = null;
    let pill = null;
    let side = null;
    if (effect === "spectacular") {
      side = pickArrowSide(rect, window.innerWidth, window.innerHeight);
      arrow = buildArrow(side, reducedMotion);
      pill = buildLabelPill(opts.label);
      placeArrowAndPill(arrow, pill, rect, side);
      shadow.appendChild(arrow);
      shadow.appendChild(pill);
    }

    (document.documentElement || document.body).appendChild(host);

    // Tracks the live element every frame — covers both the page's own
    // scroll/resize during the effect and this function's own
    // scrollIntoView() above, so the overlay never lags or snaps away.
    let rafId = null;
    const follow = () => {
      const r = el.getBoundingClientRect();
      if (spotlight) positionAt(spotlight, r);
      positionAt(frame, r);
      for (const ring of rings) positionAt(ring, r);
      if (arrow && pill) placeArrowAndPill(arrow, pill, r, side);
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
