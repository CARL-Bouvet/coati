// Coati line icons: 16 px inline <svg> built with DOM APIs (never innerHTML,
// never a data: URL — the extension's CSP refuses those as images). Stroke,
// width and colour come from `.c-icon` in lib/components.css.

const SVG_NS = "http://www.w3.org/2000/svg";

/** One path per icon, on a 16 x 16 grid. */
const PATHS = {
  trash: "M2.5 4h11 M6 4V2.5h4V4 M4 4l.7 9.5h6.6L12 4 M6.6 6.5v4.5 M9.4 6.5v4.5",
  "chevron-up": "M4 10l4-4 4 4",
  "chevron-down": "M4 6l4 4 4-4",
  grip: "M6 3.5h.01 M10 3.5h.01 M6 8h.01 M10 8h.01 M6 12.5h.01 M10 12.5h.01",
};

/** @param {keyof typeof PATHS} name @returns {SVGSVGElement} decorative icon */
export function createIcon(name) {
  const svg = document.createElementNS(SVG_NS, "svg");
  svg.setAttribute("class", "c-icon");
  svg.setAttribute("viewBox", "0 0 16 16");
  svg.setAttribute("aria-hidden", "true");
  const path = document.createElementNS(SVG_NS, "path");
  path.setAttribute("d", PATHS[name]);
  svg.append(path);
  return svg;
}
