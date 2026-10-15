// Coati content script — "Dev mode" level (docs/PROTOCOL.md "Page on
// demand", project rule 5's planned "dev" level). Injected on its
// own via chrome.scripting.executeScript({ files: ["/content/extract-dev.js"] })
// — see panel/page-request.js's runDevExtraction() — never together with
// content/extract-files.js's pipeline: this is a different reading level,
// not a refinement of the text one.
//
// Produces the whole document's cleaned HTML: structure only, never a
// script's behavior, a style's look, or a form field's typed-in value
// (project rule 6, "never a password field's value, at any level" —
// generalised here to every field, every level of this cap). Single
// top-level bare expression statement, same completion-value contract as
// content/extract.js — nothing declared at file scope, so re-injecting this
// file into the same page a second time (a later question, same tab) is
// always safe.
//
// Never throws outward: any failure inside resolves to `null`, which
// panel/page-request.js turns into a `page.decline` — same "never block the
// question" discipline as content/extract/page-kind-structure.js's own
// fallbacks.
(() => {
  // Cap BEFORE whitespace collapsing could shrink it further — this bounds
  // the string actually serialized, not a best-effort approximation of it.
  const MAX_DEV_CHARS = 400000;
  const DROP_TAGS = ["script", "style", "svg", "noscript", "template", "iframe", "link", "meta", "canvas"];
  // Everything else is dropped, case-insensitively, `value` first and
  // unconditionally (project rule 6) — an attribute allowlist, not a
  // denylist, so a new HTML attribute invented tomorrow is dropped by
  // default rather than leaking through unreviewed.
  const KEEP_ATTRS = new Set(["id", "class", "role", "href", "alt", "title", "name", "type", "for", "placeholder"]);

  function safePageUrl() {
    try {
      return location.href;
    } catch {
      return "";
    }
  }

  function stripComments(root) {
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_COMMENT);
    const comments = [];
    let node;
    while ((node = walker.nextNode())) comments.push(node);
    for (const comment of comments) comment.parentNode?.removeChild(comment);
  }

  function cleanAttributes(el) {
    for (const attr of [...el.attributes]) {
      const name = attr.name.toLowerCase();
      if (name === "value") {
        el.removeAttribute(attr.name); // rule #6 — never a field's value, at any level
        continue;
      }
      if (name.startsWith("aria-") || KEEP_ATTRS.has(name)) continue;
      el.removeAttribute(attr.name);
    }
  }

  function clean(root) {
    stripComments(root);
    for (const tag of DROP_TAGS) {
      for (const el of [...root.querySelectorAll(tag)]) el.remove();
    }
    // <textarea>'s value is its TEXT CONTENT, not an attribute — the
    // generic `value`-attribute strip above never touches it.
    for (const el of [...root.querySelectorAll("textarea")]) el.textContent = "";
    cleanAttributes(root);
    for (const el of [...root.querySelectorAll("*")]) cleanAttributes(el);
  }

  try {
    const clone = document.documentElement.cloneNode(true);
    clean(clone);
    const collapsed = clone.outerHTML.replace(/\s+/g, " ").trim();
    return {
      kind: "page",
      url: safePageUrl(),
      title: document.title || "",
      text: collapsed.length > MAX_DEV_CHARS ? collapsed.slice(0, MAX_DEV_CHARS) : collapsed,
    };
  } catch {
    return null;
  }
})();
