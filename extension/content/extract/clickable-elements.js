// ==========================================================================
// "Montrer
// du doigt". Numbers visible interactive elements e1, e2, … and keeps a
// ref -> element map ONLY in this isolated world's global scope
// (`globalThis.__coatiRefs`), never as a DOM attribute: a page could forge
// a matching `data-*` attribute of its own and retarget the user's click
// at a different element (project rule 16 — page content is read, never
// written). `pointer.js`, injected later by a separate
// `chrome.scripting.executeScript` call into the SAME isolated world,
// resolves a ref back against this exact map at the moment of the user's
// own click on "Montrer" — this file never clicks, focuses or fills
// anything itself.
//
// Part of the content/extract.js content script (split) — the
// clickable-elements table and the password-field guard. See
// content/extract-files.js for the full load order.
// ==========================================================================

var INTERACTIVE_SELECTOR =
  "button, a[href], input:not([type=hidden]), select, textarea, " +
  '[role="button"], [role="link"], [role="menuitem"], [role="tab"], ' +
  '[role="option"], [role="switch"], [role="checkbox"], [role="combobox"], ' +
  "[contenteditable]";

// Mirrors docs/PROTOCOL.md's closed `role` enum for `context.elements`
// (§2) — an element whose computed role would fall
// outside this list still gets a best-effort entry (the broker is the one
// that enforces the closed list on the wire; here a sane default is enough).
var ELEMENT_ROLES = new Set([
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

var ELEMENTS_DEFAULT_CAP = 120;
var ELEMENT_LABEL_MAX = 80;

function inputRole(el) {
  const type = (el.getAttribute("type") || "text").toLowerCase();
  if (type === "checkbox") return "checkbox";
  if (type === "radio") return "radio";
  if (type === "submit" || type === "button" || type === "reset" || type === "image") return "button";
  return "textbox";
}

function roleOf(el) {
  const explicit = (el.getAttribute("role") || "").toLowerCase();
  if (explicit && ELEMENT_ROLES.has(explicit)) return explicit;
  const tag = el.tagName;
  if (tag === "INPUT") return inputRole(el);
  if (tag === "SELECT") return "combobox";
  if (tag === "TEXTAREA") return "textbox";
  if (tag === "A") return "link";
  if (tag === "BUTTON") return "button";
  if (el.hasAttribute && el.hasAttribute("contenteditable")) return "textbox";
  return "button"; // unreachable given INTERACTIVE_SELECTOR; safe default.
}

function isPasswordField(el) {
  return el.tagName === "INPUT" && (el.getAttribute("type") || "").toLowerCase() === "password";
}

// Label precedence: visible text, then aria-label,
// then placeholder/title. NEVER a field's current value (could be a typed
// secret) and a password field is excluded outright by isPasswordField
// above, before this is even reached.
function elementLabel(el) {
  const text = normalizeFieldText(visibleText(el));
  if (text) return truncateField(text, ELEMENT_LABEL_MAX);
  const ariaLabel = normalizeFieldText(el.getAttribute("aria-label") || "");
  if (ariaLabel) return truncateField(ariaLabel, ELEMENT_LABEL_MAX);
  const placeholder = normalizeFieldText(el.getAttribute("placeholder") || el.getAttribute("title") || "");
  return truncateField(placeholder, ELEMENT_LABEL_MAX);
}

// The panel passes a tighter cap (40) via `window.__coatiMaxElements` when
// the active Ollama model's context is small — read
// from `window`, not `globalThis`: in a real content script they are the
// same object, but this keeps the test harness (a plain Function with
// `window` as a parameter distinct from the test runner's own globalThis)
// able to configure it without polluting process-wide state.
function elementCap() {
  let configured;
  try {
    configured = typeof window !== "undefined" ? window.__coatiMaxElements : undefined;
  } catch {
    configured = undefined;
  }
  if (typeof configured !== "number" || !(configured > 0)) return ELEMENTS_DEFAULT_CAP;
  return Math.min(configured, ELEMENTS_DEFAULT_CAP);
}

// "rendus seulement" — reuses the same rendered-candidate gate as the rest
// of the file (checkVisibility, aria-hidden ancestor…), plus a non-empty
// on-screen rect (a 0×0 button some sites keep for layout is not something
// a user could ever click either).
function collectInteractiveElements() {
  if (!document.body || typeof document.body.querySelectorAll !== "function") return [];
  let candidates = [];
  try {
    candidates = Array.from(document.body.querySelectorAll(INTERACTIVE_SELECTOR));
  } catch {
    return [];
  }

  const viewport = viewportSize();
  const inViewport = [];
  const rest = [];
  for (const el of candidates) {
    if (isPasswordField(el)) continue;
    if (!isRenderedCandidate(el)) continue;
    const rect = safeRect(el);
    if (!rect || (rect.width || 0) <= 0 || (rect.height || 0) <= 0) continue;
    const label = elementLabel(el);
    if (!label) continue;
    const entry = { el, role: roleOf(el), label };
    const top = rect.top != null ? rect.top : 0;
    const left = rect.left != null ? rect.left : 0;
    const bottom = rect.bottom != null ? rect.bottom : top + (rect.height || 0);
    const right = rect.right != null ? rect.right : left + (rect.width || 0);
    const onScreen = bottom > 0 && top < viewport.h && right > 0 && left < viewport.w;
    if (onScreen) inViewport.push(entry);
    else rest.push(entry);
  }

  // "viewport-visible first then document order" — both groups
  // individually keep querySelectorAll's own document order; only the two
  // groups are concatenated viewport-first.
  return inViewport.concat(rest).slice(0, elementCap());
}

// Builds the `{ extractionId, elements }` pair returned to the panel and
// the isolated-world side table pointer.js will later verify against.
// `extractionId` is never sent to the broker (panel.js strips it before
// building the wire payload) — it only has meaning inside this tab.
function buildElementsContext() {
  let collected = [];
  try {
    collected = collectInteractiveElements();
  } catch {
    collected = [];
  }
  const extractionId = `x${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
  const map = new Map();
  const elements = collected.map((entry, i) => {
    const ref = `e${i + 1}`;
    map.set(ref, { weakRef: new WeakRef(entry.el), role: entry.role, label: entry.label });
    return { ref, role: entry.role, label: entry.label };
  });
  // Isolated world only — see the header comment above this section.
  globalThis.__coatiRefs = { extractionId, map };
  let hasIframe = false;
  try {
    hasIframe = !!(document.body && document.body.querySelector && document.body.querySelector("iframe"));
  } catch {
    hasIframe = false;
  }
  return { extractionId, elements, elementsFrameLimited: hasIframe };
}
