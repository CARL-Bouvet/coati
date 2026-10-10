// Coati content script — gestures Coati refuses to perform, whatever the model asks
// and whatever the user would confirm (docs/PROTOCOL.md "Acting"; public rule 13).
// Injected by the panel just before content/pointer.js, which calls
// `globalThis.__coatiForbiddenGesture(el, action)` before any click or typing.
// Returns a short reason code, or null when the gesture is allowed.
//
// Codes: "sensitive-field" (password, card, IBAN, one-time code), "not-editable"
// (typing into something that is not a text field), "form-submit" (a button that
// submits a form that is not a plain GET search or filter), "forbidden-label" (pay, buy, send, delete, publish, sign in…
// in English, French or Chinese). A link whose target is local or private is
// refused by the panel (lib/open-guard.js), which knows the page address.

(() => {
  // Latin words match whole words (plus an ending: "payer", "payment"); Chinese
  // has no word boundaries, so those match as substrings.
  const LATIN_WORDS =
    "pay|buy|checkout|check out|order|send|delete|remove|publish|post|log ?in|sign ?in|sign ?up|" +
    "payer|acheter|commander|envoyer|supprimer|publier|connexion|se connecter|s'inscrire|inscription";
  const NO_ENDING = new Set(["post", "order"]);
  const LATIN_RE = new RegExp(
    `(?:^|[^\\p{L}])(?:${LATIN_WORDS.split("|")
      .map((w) => (NO_ENDING.has(w) ? `${w}s?` : `${w}\\p{L}*`))
      .join("|")})(?![\\p{L}])`,
    "iu",
  );
  const CHINESE_RE = /支付|付款|购买|下单|发送|删除|发布|登录|注册/;

  const SENSITIVE_NAME_RE = /card|cvv|cvc|iban/i;
  const SENSITIVE_AUTOCOMPLETE_RE = /(?:^|\s)(?:cc-[\w-]+|[\w-]*-password|one-time-code)(?:\s|$)/i;
  const BUTTON_TYPES = new Set(["button", "submit", "reset", "image", "checkbox", "radio", "file", "hidden"]);

  function attr(el, name) {
    return typeof el.getAttribute === "function" ? el.getAttribute(name) || "" : "";
  }

  function isSensitiveField(el) {
    const tag = el.tagName;
    if (tag !== "INPUT" && tag !== "TEXTAREA" && tag !== "SELECT") return false;
    if (attr(el, "type").toLowerCase() === "password") return true;
    if (SENSITIVE_AUTOCOMPLETE_RE.test(attr(el, "autocomplete"))) return true;
    return SENSITIVE_NAME_RE.test(attr(el, "name")) || SENSITIVE_NAME_RE.test(attr(el, "id"));
  }

  function isTextField(el) {
    if (el.tagName === "TEXTAREA") return true;
    return el.tagName === "INPUT" && !BUTTON_TYPES.has((attr(el, "type") || "text").toLowerCase());
  }

  function inForm(el) {
    return !!(el.form || (typeof el.closest === "function" && el.closest("form")));
  }

  // A button with no `type` submits its form, like type="submit". A GET form
  // without a password field (site search, filters) only reads: allowed.
  function submitsForm(el) {
    const type = attr(el, "type").toLowerCase();
    const submits =
      el.tagName === "INPUT" ? type === "submit" || type === "image" : el.tagName === "BUTTON" && (type === "submit" || (type === "" && inForm(el)));
    if (!submits) return false;
    const form = el.form || (typeof el.closest === "function" ? el.closest("form") : null);
    if (!form) return true;
    const method = (attr(el, "formmethod") || attr(form, "method") || "get").toLowerCase();
    return method !== "get" || (typeof form.querySelector === "function" && !!form.querySelector('input[type="password"]'));
  }

  function labelsOf(el) {
    const text = typeof el.innerText === "string" ? el.innerText : el.textContent || "";
    return [text, attr(el, "aria-label"), attr(el, "value"), attr(el, "title")]
      .map((s) => s.replace(/’/g, "'").replace(/\s+/g, " ").trim())
      .filter(Boolean);
  }

  function hasForbiddenLabel(el) {
    return labelsOf(el).some((s) => LATIN_RE.test(s) || CHINESE_RE.test(s));
  }

  /** @returns {string|null} */
  globalThis.__coatiForbiddenGesture = function forbiddenGesture(el, action) {
    if (isSensitiveField(el)) return "sensitive-field";
    if (action === "type" && !isTextField(el)) return "not-editable";
    if (action === "click" && submitsForm(el)) return "form-submit";
    if (hasForbiddenLabel(el)) return "forbidden-label";
    return null;
  };
})();
