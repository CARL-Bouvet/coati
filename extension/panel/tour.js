// Coati side panel — guided tour: one arrowed bubble at a time over a dimmed
// panel, the element it explains left visible through a cut-out. Opened by
// the header's "?" button, and once on its own when the first-run card is
// completed. The dev look (`mode-dev` on <html>) gets its own, shorter tour.
import { t } from "../lib/i18n-page.js";
import { api, IS_GECKO } from "../lib/browser-compat.js";
import { shortcutKeys, actionShortcut } from "../lib/shortcut.js";

// Not a secret: only records that the tour was shown once.
export const TOUR_SEEN_KEY = "coati:tourSeen";

// A step without a target is shown centered, without an arrow; a step whose
// target is absent in the current state is skipped.
const NORMAL_STEPS = [
  { target: "#modelPill", text: "panel_tour_model" },
  { target: "#siteCard", text: "panel_tour_site" },
  { target: "#savePrompt", text: "panel_tour_save" },
  { target: ".composer-field", text: "panel_tour_input" },
  { text: "panel_tour_end", shortcut: true },
];
const DEV_STEPS = [
  { target: "#devMode", text: "panel_tour_dev_switch" },
  { target: ".message-page-mention", text: "panel_tour_dev_mention" },
  { text: "panel_tour_dev_end" },
];

let tour = null;

/** Last visible match: for the read/not-read mention, the latest answer's. */
function findTarget(selector) {
  return [...document.querySelectorAll(selector)].reverse().find((el) => el.getClientRects().length > 0) ?? null;
}

function makeButton(className, onClick) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = className;
  button.addEventListener("click", onClick);
  return button;
}

/** The real shortcut for opening Coati, read from the browser (the manifest
 * only suggests one), or a button to the browser's shortcut page. */
async function appendShortcut(container) {
  const commands = await Promise.resolve(api.commands?.getAll?.()).catch(() => []);
  const keys = shortcutKeys(actionShortcut(commands));
  const line = document.createElement("p");
  line.className = "tour-shortcut";
  line.textContent = keys.length > 0 ? t("panel_help_shortcut", [keys.join("+")]) : t("panel_help_shortcut_none");
  container.appendChild(line);
  if (keys.length === 0 && !IS_GECKO) {
    const set = makeButton("c-link",() => api.tabs.create({ url: "chrome://extensions/shortcuts" }));
    set.textContent = t("panel_help_shortcut_set");
    container.appendChild(set);
  }
}

function place() {
  if (!tour) return;
  const { bubble, hole, overlay } = tour;
  const step = tour.steps[tour.index];
  const target = step.target ? findTarget(step.target) : null;
  overlay.classList.toggle("tour--centered", !target);
  hole.hidden = !target;
  if (!target) {
    bubble.dataset.side = "none";
    bubble.style.left = "";
    bubble.style.top = "";
    return;
  }
  target.scrollIntoView({ block: "nearest" });
  const pad = 4;
  const gap = 12;
  const margin = 12;
  const r = target.getBoundingClientRect();
  hole.style.left = `${r.left - pad}px`;
  hole.style.top = `${r.top - pad}px`;
  hole.style.width = `${r.width + 2 * pad}px`;
  hole.style.height = `${r.height + 2 * pad}px`;
  const b = bubble.getBoundingClientRect();
  const below = r.bottom + pad + gap + b.height <= window.innerHeight - margin || r.top - pad - gap - b.height < margin;
  const left = Math.min(Math.max(margin, r.left + r.width / 2 - b.width / 2), window.innerWidth - margin - b.width);
  bubble.dataset.side = below ? "below" : "above";
  bubble.style.left = `${left}px`;
  bubble.style.top = `${below ? r.bottom + pad + gap : r.top - pad - gap - b.height}px`;
  bubble.style.setProperty("--arrow-x", `${Math.min(Math.max(16, r.left + r.width / 2 - left), b.width - 16)}px`);
}

function show(index) {
  tour.index = index;
  const step = tour.steps[index];
  const last = index === tour.steps.length - 1;
  tour.text.textContent = t(step.text);
  tour.extra.replaceChildren();
  if (step.shortcut) appendShortcut(tour.extra);
  tour.counter.textContent = t("panel_tour_counter", [String(index + 1), String(tour.steps.length)]);
  tour.next.textContent = t(last ? "panel_tour_done" : "panel_tour_next");
  tour.skip.hidden = last;
  place();
  tour.next.focus();
}

function next() {
  if (tour.index < tour.steps.length - 1) show(tour.index + 1);
  else endTour();
}

export function endTour() {
  if (!tour) return;
  const { overlay, returnFocus } = tour;
  tour = null;
  window.removeEventListener("resize", place);
  overlay.remove();
  if (returnFocus?.isConnected) returnFocus.focus();
}

// Modal: Escape closes, Tab cycles through the bubble's own buttons only.
function onKeydown(event) {
  if (event.key === "Escape") {
    event.preventDefault();
    endTour();
    return;
  }
  if (event.key !== "Tab") return;
  event.preventDefault();
  const items = [...tour.overlay.querySelectorAll("button:not([hidden])")];
  const at = items.indexOf(document.activeElement);
  items[(at + (event.shiftKey ? -1 : 1) + items.length) % items.length]?.focus();
}

export function startTour() {
  if (tour) return;
  const dev = document.documentElement.classList.contains("mode-dev");
  const steps = (dev ? DEV_STEPS : NORMAL_STEPS).filter((step) => !step.target || findTarget(step.target));
  const overlay = document.createElement("div");
  overlay.className = "tour";
  overlay.setAttribute("role", "dialog");
  overlay.setAttribute("aria-modal", "true");
  overlay.setAttribute("aria-label", t("panel_tour_title"));
  const hole = document.createElement("div");
  hole.className = "tour-hole";
  const bubble = document.createElement("div");
  bubble.className = "tour-bubble";
  const text = document.createElement("p");
  text.className = "tour-text";
  text.id = "tourText";
  overlay.setAttribute("aria-describedby", text.id);
  const extra = document.createElement("div");
  const foot = document.createElement("div");
  foot.className = "tour-foot";
  const counter = document.createElement("span");
  counter.className = "tour-counter";
  const skip = makeButton("c-link tour-skip", endTour);
  skip.textContent = t("panel_tour_skip");
  const nextButton = makeButton("c-button c-button--primary c-button--large tour-next", next);
  foot.append(counter, skip, nextButton);
  bubble.append(text, extra, foot);
  overlay.append(hole, bubble);
  overlay.addEventListener("keydown", onKeydown);
  // A click on the dimmed area keeps focus inside the dialog.
  overlay.addEventListener("mousedown", (event) => {
    if (!bubble.contains(event.target)) event.preventDefault();
  });
  document.body.appendChild(overlay);
  tour = { overlay, hole, bubble, text, extra, counter, skip, next: nextButton, steps, index: 0, returnFocus: document.activeElement };
  window.addEventListener("resize", place);
  show(0);
}

/** Once per install, right after the first-run card is completed. */
export async function startTourOnce() {
  const stored = await api.storage.local.get([TOUR_SEEN_KEY]).catch(() => ({}));
  if (stored?.[TOUR_SEEN_KEY] === true) return;
  api.storage.local.set({ [TOUR_SEEN_KEY]: true }).catch(() => {});
  startTour();
}
