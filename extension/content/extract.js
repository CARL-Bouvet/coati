// Coati content script — injected on demand via chrome.scripting.executeScript.
//
// Extracts plain, sanitized TEXT from the page. Never returns HTML, never
// touches innerHTML: page content is data for the model, never an
// instruction (see CLAUDE.md, security rule 3). The completion value of this
// IIFE becomes the injection result read by the caller (panel.js).
//
// Why innerText and not textContent: textContent returns the raw source text,
// including hidden elements, and inserts nothing between block elements. On
// pages whose HTML is generated without whitespace between tags — most React
// and JSX sites, Medium among them — "<h1>Title</h1><p>Body</p>" comes out as
// "TitleBody". innerText returns the text as rendered: line breaks at block
// boundaries, hidden elements skipped. It costs a layout pass, which is fine
// for a one-shot extraction on a page the user is looking at.

(() => {
  const MAX_CHARS = 40000;

  // Zero-width characters (U+200B-U+200D, U+2060 word joiner, U+FEFF BOM/
  // zero-width no-break space) carry no visible glyph but do carry bytes a
  // hostile page can use to smuggle a hidden instruction past a human eye —
  // strip them everywhere, unconditionally (T45, section 5 point 6). Built
  // from numeric code points, not a `\u` regex escape: this source file is
  // plain-text-reviewed, and a literal invisible character sitting in the
  // regex source itself would be both unreadable in review and fragile
  // across editors/encodings.
  const ZERO_WIDTH_CODEPOINTS = [0x200b, 0x200c, 0x200d, 0x2060, 0xfeff];
  const ZERO_WIDTH_CHARS = ZERO_WIDTH_CODEPOINTS.map((code) => String.fromCharCode(code));

  function stripZeroWidth(text) {
    let out = text;
    for (const ch of ZERO_WIDTH_CHARS) out = out.split(ch).join("");
    return out;
  }

  function truncate(text, max = MAX_CHARS) {
    const clean = stripZeroWidth(text || "")
      .replace(/[ \t]+/g, " ")
      .replace(/\n{3,}/g, "\n\n")
      .replace(/^[ \t]+|[ \t]+$/gm, "")
      .trim();
    return clean.length > max ? clean.slice(0, max) : clean;
  }

  function visibleText(el) {
    if (!el) return "";
    // innerText is undefined on some non-HTMLElement nodes; fall back rather
    // than throwing.
    return typeof el.innerText === "string" ? el.innerText : el.textContent || "";
  }

  // A [contenteditable] subtree (a draft email, an unsent comment box) is
  // "visible" as far as innerText is concerned, so it rides along with
  // whatever container contains it. It was never intentionally shared by the
  // user's click — exclude it before the text is sent anywhere. We can't just
  // skip the container itself (the draft is usually nested a few levels
  // inside an otherwise legitimate article/main), so instead strip out each
  // editable descendant's own rendered text from the container's text.
  function textExcludingEditable(el) {
    return textExcludingNodes(el, []);
  }

  // Generalization of the above: also subtracts the rendered text of any
  // element in `extraExcludedEls` that sits inside `el` (an excluded overlay
  // layer nested inside the body, a repeated list entry nested inside the
  // region a fact scan runs over…). Used by the Amendement 2026-09-25 page-
  // type pipeline below; `textExcludingEditable` keeps its old, narrower
  // behavior for the density heuristic's existing callers/tests.
  function textExcludingNodes(el, extraExcludedEls) {
    const text = visibleText(el);
    if (!el || typeof el.querySelectorAll !== "function") return text;
    let editableDescendants = [];
    try {
      editableDescendants = Array.from(el.querySelectorAll("[contenteditable]"));
    } catch {
      editableDescendants = [];
    }
    const excludedDescendants = (extraExcludedEls || []).filter(
      (node) => node && node !== el && typeof el.contains === "function" && el.contains(node),
    );
    const allExcluded = editableDescendants.concat(excludedDescendants);
    if (!allExcluded.length) return text;
    // Longest fragment first: a region nested inside another excluded
    // region must not be subtracted twice from an already-shortened string.
    const fragments = allExcluded
      .map((node) => visibleText(node))
      .filter(Boolean)
      .sort((a, b) => b.length - a.length);
    return fragments.reduce((acc, fragment) => acc.split(fragment).join(""), text);
  }

  // T45 (docs/DECISIONS.md), point 1: "innerText d'un élément non affiché renvoie son
  // textContent" — a hidden settings dialog, a closed popin, a menu with
  // `display:none` all measure as if they were on screen. Never let one win
  // a text-length/density contest. `checkVisibility` is the modern, cheap
  // check (feature-detected: not every embedder ships it); `getClientRects`
  // catches `display:none`/detached nodes even where it's missing; an
  // `aria-hidden="true"` ancestor is excluded outright — it is also used in
  // the wild to hide dialogs/menus from sighted users, not just assistive
  // tech (measured on Le Monde, Amazon, PAP).
  function isRenderedCandidate(el) {
    if (!el) return false;
    // `display: contents` generates no box of its own, so getClientRects() is
    // empty and checkVisibility() says false even when everything inside is on
    // screen (measured on MDN, whose <main> is `display: contents`). Such an
    // element is visible when one of its children is — checked before
    // isElementUsable(), which would reject it for having no box.
    let displayContents = false;
    try {
      displayContents =
        typeof getComputedStyle === "function" && getComputedStyle(el).display === "contents";
    } catch {
      displayContents = false;
    }
    if (displayContents) {
      try {
        if (typeof el.closest === "function" && el.closest('[aria-hidden="true"]')) return false;
      } catch {
        // Fake/degenerate DOM — fall through.
      }
      return Array.from(el.children || []).some((child) => isRenderedCandidate(child));
    }
    if (!isElementUsable(el)) return false;
    try {
      if (
        typeof el.checkVisibility === "function" &&
        el.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true }) === false
      ) {
        return false;
      }
    } catch {
      // Not implemented reliably everywhere — fall through to the other
      // checks rather than treating a throw as "hidden".
    }
    try {
      if (typeof el.closest === "function" && el.closest('[aria-hidden="true"]')) return false;
    } catch {
      // Fake/degenerate DOM — don't let a harness quirk hide real content.
    }
    return true;
  }

  // Picks the element that most likely holds the article body.
  //
  // Semantic containers win outright when they carry enough text. Otherwise we
  // score candidates by text density — characters of rendered text per
  // descendant element. A navigation column is long but tag-heavy; an article
  // body is long and tag-light. Raw length alone would always elect the
  // outermost wrapper, which is the whole page.
  function articleText() {
    for (const el of document.querySelectorAll("article, main, [role='main']")) {
      if (!isRenderedCandidate(el)) continue;
      const text = textExcludingEditable(el);
      if (text.trim().length > 200) return text;
    }

    let best = null;
    let bestScore = 0;
    const candidates = document.body ? document.body.querySelectorAll("div, section") : [];
    for (const el of candidates) {
      // A container that IS an editable region (not just one that contains
      // one) is skipped outright, same as nav/footer/header/aside.
      if (el.closest("nav, footer, header, aside, [contenteditable]")) continue;
      if (!isRenderedCandidate(el)) continue;
      const text = textExcludingEditable(el);
      const length = text.trim().length;
      if (length < 200) continue;
      const density = length / (el.getElementsByTagName("*").length + 1);
      if (density > bestScore) {
        bestScore = density;
        best = el;
      }
    }

    return best ? textExcludingEditable(best) : textExcludingEditable(document.body);
  }

  function getYouTubeVideoId() {
    try {
      const url = new URL(location.href);
      if (url.hostname.includes("youtube.com") && url.pathname === "/watch") {
        return url.searchParams.get("v") || undefined;
      }
      if (url.hostname === "youtu.be") {
        return url.pathname.slice(1) || undefined;
      }
    } catch {
      // Not a URL we understand; treat the page as an ordinary one.
    }
    return undefined;
  }

  // Reads the transcript only if it is already open in the DOM: either the
  // user opened the transcript panel themselves, or the panel's own "Résumer
  // cette vidéo" button did it on their behalf, in direct response to their
  // click — the one documented exception to the gesture rule (DECISIONS.md,
  // "Contrainte dure — la règle du geste"). Either way this function itself
  // never opens the panel and never calls YouTube's internal endpoints.
  function getYouTubeTranscript() {
    // YouTube migrated its transcript to the "view model" architecture; the
    // older custom element is kept as a fallback for slower rollouts.
    // Measured 2026-09-18: transcript-segment-view-model yields 133 segments on
    // a 17-minute video, ytd-transcript-segment-renderer yields none.
    const segments = document.querySelectorAll(
      "transcript-segment-view-model, ytd-transcript-segment-renderer",
    );
    if (!segments.length) return undefined;

    const lines = [];
    let previous = null;
    for (const segment of segments) {
      // A segment renders as three lines: the timestamp, a screen-reader
      // duplicate of it ("7 secondes"), then the spoken text. Keep the
      // timestamp — it lets the model cite a moment — and drop the duplicate.
      const parts = visibleText(segment)
        .split("\n")
        .map((part) => part.trim())
        .filter(Boolean);

      const stamp = parts.find((part) => /^\d{1,2}:\d{2}(:\d{2})?$/.test(part));
      const spoken = parts
        .filter(
          (part) =>
            part !== stamp &&
            !/^\d+\s+(seconde|secondes|minute|minutes|heure|heures|second|seconds|minute|minutes|hour|hours)\b/i.test(
              part,
            ),
        )
        .join(" ")
        .trim();

      if (!spoken || spoken === previous) continue;
      previous = spoken;
      lines.push(stamp ? `${stamp} ${spoken}` : spoken);
    }

    return lines.length ? lines.join("\n") : undefined;
  }

  // The query string and hash can carry session tokens (?token=…,
  // #access_token=…). The model, the broker, and its logs never need them —
  // only origin + path identify "which page", so that's all that leaves the
  // page. Falls back to the raw href if location is somehow not a URL (should
  // not happen in a browser tab, but truncate() elsewhere shows the same
  // defensive style).
  function safePageUrl() {
    try {
      return location.origin + location.pathname;
    } catch {
      return location.href;
    }
  }

  // Extra signals for the page-type classifier (extension/content/detect.js).
  // Gathering them needs the DOM, so it happens here; deciding what they mean
  // does not, which is why that logic lives in a separate, DOM-free module.
  function hasVideoElement() {
    return !!document.querySelector("video");
  }

  function hasArticleMarkup() {
    if (document.querySelector("article, [role='main']")) return true;
    const ogType = document.querySelector('meta[property="og:type"]');
    return !!ogType && ogType.getAttribute("content") === "article";
  }

  // ==========================================================================
  // Amendement 2026-09-25 (types de page) — docs/PROTOCOL.md, "Types de page,
  // faits et entrées". Everything below decides `pageKind` and fills
  // `facts`/`items`. Any exception in here is caught by buildPageKindContext()
  // and degrades to `pageKind: "other"` with today's plain text — "Une
  // exception … ne fait jamais échouer l'extraction."
  //
  // NOTE on the detect.js/extract.js split (read before touching this): the
  // same decision logic (overlay exclusion, pageKind rules, facts/items caps)
  // is also implemented, exported, and unit-tested as pure functions in
  // extension/content/detect.js. It is duplicated here, not imported: this
  // file is injected as a classic (non-module) content script via
  // `chrome.scripting.executeScript({ files: [...] })|, which cannot `import`
  // an ES module, and there is no browser available in this sandbox to verify
  // a dynamic `import()` of an extension resource from a content script's
  // isolated world. Duplication was the conservative, verifiable choice.
  // Keep the two in sync by construction: same constants, same thresholds,
  // same order of checks — detect.test.ts is the source of truth for the
  // rules; extract.test.ts checks this copy produces the same outcomes on
  // realistic DOM shapes.
  // ==========================================================================

  // Page-content heuristic (detects cookie-consent banners on arbitrary
  // pages, in whatever language they're written), not extension UI text —
  // deliberately mixes French and English words, see below.
  const CONSENT_LEXICON = [
    "cookie",
    "cookies",
    "consentement", // i18n-allow: page-content heuristic word, not UI text
    "vie privée", // i18n-allow: page-content heuristic word, not UI text
    "confidentialité", // i18n-allow: page-content heuristic word, not UI text
    "rgpd",
    "traceurs",
    "consent",
    "privacy",
    "gdpr",
  ];
  const CONSENT_CONTROL_WORDS = [
    "tout accepter",
    "j'accepte",
    "tout refuser",
    "continuer sans accepter",
    "accepter",
    "refuser",
    "accept",
    "agree",
    "reject",
  ];
  const OVERLAY_COVERAGE_THRESHOLD = 0.3;
  const EDGE_BAND_WIDTH_RATIO = 0.8;
  const CONTENT_LAYER_MIN_CHARS = 500;
  const LEXICAL_ONLY_MAX_CHARS = 1500;
  const OVERLAY_FALLBACK_MIN_VISIBLE_CHARS = 200;
  const EDGE_SNAP_PX = 40; // "collé au bord" — small tolerance, not a protocol constant.
  const ARTICLE_TEXT_THRESHOLD = 1200; // same value as detect.js's classifyPageType.
  const OVERLAY_SELECTOR =
    'dialog, [role="dialog"], [role="alertdialog"], [aria-modal], div, section, aside, header, footer, nav';
  const FACT_CAPS = { count: 40, label: 60, value: 160 };
  const ITEM_CAPS = { count: 40, title: 160, price: 40, location: 80, detail: 200 };
  const LIST_MIN_GROUP_SIZE = 5;
  const LIST_ENTRY_MIN_CHARS = 20;
  const LIST_ENTRY_MAX_CHARS = 1000;
  // Correction n°1 — "se cherche en remontant, sur six niveaux au plus."
  // Mesuré le 25/09 : sur la page de résultats de bienici, le bloc le plus dense (la
  // description de l'annonce mise en avant) est à plus de six niveaux du conteneur
  // des résultats. Douze niveaux suffisent et restent bornés.
  const MAX_ANCESTOR_LEVELS = 12;

  function normalizeFieldText(text) {
    return (text || "")
      .replace(/[\u0000-\u001f\u007f]/g, " ")
      .replace(/\s+/g, " ")
      .trim();
  }

  function truncateField(text, max) {
    if (text.length <= max) return text;
    return `${text.slice(0, Math.max(0, max - 1))}…`;
  }

  // A number is `\d(?:[\d\s.,]*\d)?` — starts AND ENDS with a digit, so a
  // separator (comma, period, space) can never bridge an unrelated number to
  // a unit further down the string. Without the trailing `\d`, "2007, p.
  // 1076" (a bibliography citation) matched as "2007" + unit "p." — measured
  // 25/09 on the Wikipedia "Coati" corpus page: it is what actually made the
  // infobox's chief-numeric-fact check pass and misclassified the page as
  // `listing`. Never a bare number either way ("21 langues" still has no
  // match: no currency, and "langues" isn't a listed unit).
  const NUMERIC_VALUE_RE = /(?:[€$£]\s?\d(?:[\d\s.,]*\d)?|\d(?:[\d\s.,]*\d)?\s?(?:€|EUR|\$|£|m²|m2|km|pièces?|p\.|ch\.))/i; // i18n-allow: page-content unit heuristic, not UI text
  function hasNumericValue(text) {
    return NUMERIC_VALUE_RE.test(text || "");
  }
  const CURRENCY_VALUE_RE = /(?:[€$£]\s?\d(?:[\d\s.,]*\d)?|\d(?:[\d\s.,]*\d)?\s?(?:€|EUR|\$|£))/i;
  function firstCurrencyValue(text) {
    const match = CURRENCY_VALUE_RE.exec(text || "");
    return match ? match[0].trim() : undefined;
  }
  const LOCATION_RE = /\b\d{5}\b|\(\d{2,3}\)/;
  function looksLikeLocation(text) {
    return LOCATION_RE.test(text || "");
  }

  function hasConsentLexicon(text) {
    const lower = (text || "").toLowerCase();
    return CONSENT_LEXICON.some((word) => lower.includes(word));
  }
  function hasConsentControlWords(texts) {
    return (texts || []).some((raw) => {
      const lower = (raw || "").trim().toLowerCase();
      return CONSENT_CONTROL_WORDS.some((word) => lower === word || lower.startsWith(`${word} `));
    });
  }
  function isDialogLike(sig) {
    return !!(sig.isDialogRole || sig.isAriaModal || sig.isOpenDialogElement);
  }
  function isFixedOrSticky(sig) {
    return sig.position === "fixed" || sig.position === "sticky";
  }
  // Amendement 2026-09-25 (ter), mesuré sur bienici : un élément fixe n'est ni
  // une couche à écarter ni le contenu sur sa seule position. La liste des
  // résultats (#searchSideView, 4 535 car.) et la carte de contact d'une fiche
  // sont fixes. Seul un dialogue est un signal fort.
  function hasStrongStructuralSignal(sig) {
    return isDialogLike(sig);
  }
  function hasWeakStructuralSignal(sig) {
    return (
      !isDialogLike(sig) &&
      isFixedOrSticky(sig) &&
      ((sig.coverageRatio || 0) >= OVERLAY_COVERAGE_THRESHOLD || !!sig.dockedToEdge)
    );
  }
  function hasLexicalConfirmation(sig) {
    return hasConsentLexicon(sig.visibleText || "") && hasConsentControlWords(sig.controlTexts || []);
  }
  // "Exclusion lexicale seule" — trois garde-fous.
  function isLexicalOnlyExcludable(sig) {
    if (hasStrongStructuralSignal(sig) || isFixedOrSticky(sig)) return false;
    return (
      hasLexicalConfirmation(sig) &&
      (sig.visibleText || "").length < LEXICAL_ONLY_MAX_CHARS &&
      !sig.containsH1 &&
      !sig.containsMainRegion
    );
  }
  // "Une couche peut être le contenu".
  function isContentLayer(sig) {
    return (
      hasStrongStructuralSignal(sig) &&
      (sig.visibleText || "").length >= CONTENT_LAYER_MIN_CHARS &&
      !hasLexicalConfirmation(sig)
    );
  }
  function shouldExcludeLayer(sig) {
    if (hasStrongStructuralSignal(sig)) return !isContentLayer(sig);
    // Un bandeau est court : un élément fixe long n'est jamais écarté.
    if (hasWeakStructuralSignal(sig)) {
      return hasLexicalConfirmation(sig) && (sig.visibleText || "").length < LEXICAL_ONLY_MAX_CHARS;
    }
    return isLexicalOnlyExcludable(sig);
  }

  function viewportSize() {
    const w =
      typeof window !== "undefined" && typeof window.innerWidth === "number" && window.innerWidth > 0
        ? window.innerWidth
        : 1024;
    const h =
      typeof window !== "undefined" && typeof window.innerHeight === "number" && window.innerHeight > 0
        ? window.innerHeight
        : 768;
    return { w, h };
  }

  function safeComputedPosition(el) {
    try {
      if (typeof getComputedStyle !== "function") return "static";
      const style = getComputedStyle(el);
      return (style && style.position) || "static";
    } catch {
      return "static";
    }
  }

  function safeRect(el) {
    try {
      return typeof el.getBoundingClientRect === "function" ? el.getBoundingClientRect() : null;
    } catch {
      return null;
    }
  }

  function rectMetrics(rect, viewport) {
    if (!rect) return { coverageRatio: 0, dockedToEdge: false };
    const width = Math.max(0, rect.width != null ? rect.width : (rect.right || 0) - (rect.left || 0));
    const height = Math.max(0, rect.height != null ? rect.height : (rect.bottom || 0) - (rect.top || 0));
    const area = viewport.w * viewport.h;
    const coverageRatio = area > 0 ? (width * height) / area : 0;
    const wideEnough = width >= EDGE_BAND_WIDTH_RATIO * viewport.w;
    const top = rect.top != null ? rect.top : 0;
    const bottom = rect.bottom != null ? rect.bottom : top + height;
    const dockedToEdge = wideEnough && (Math.abs(top) <= EDGE_SNAP_PX || Math.abs(viewport.h - bottom) <= EDGE_SNAP_PX);
    return { coverageRatio, dockedToEdge };
  }

  function controlTextsOf(el) {
    if (typeof el.querySelectorAll !== "function") return [];
    try {
      return Array.from(el.querySelectorAll('button, a, [role="button"]'))
        .map((c) => visibleText(c).trim())
        .filter(Boolean);
    } catch {
      return [];
    }
  }

  function collectOverlayCandidates(viewport, guardMainRegionEl, h1El) {
    if (!document.body || typeof document.body.querySelectorAll !== "function") return [];
    let nodes;
    try {
      nodes = document.body.querySelectorAll(OVERLAY_SELECTOR);
    } catch {
      return [];
    }
    const out = [];
    for (const el of nodes) {
      // A layer the user cannot see is neither content nor an obstacle. Without
      // this, a closed dialog (display:none: its innerText falls back to the raw
      // textContent) passed the content-layer test and replaced the whole page —
      // measured on Le Monde, Amazon and Stack Overflow, all hidden role=dialog.
      if (!isRenderedCandidate(el)) continue;
      const rect = safeRect(el);
      const { coverageRatio, dockedToEdge } = rectMetrics(rect, viewport);
      out.push({
        el,
        isDialogRole: el.getAttribute("role") === "dialog" || el.getAttribute("role") === "alertdialog",
        isAriaModal: el.getAttribute("aria-modal") === "true",
        isOpenDialogElement: el.tagName === "DIALOG" && el.getAttribute("open") != null,
        position: safeComputedPosition(el),
        coverageRatio,
        dockedToEdge,
        visibleText: normalizeFieldText(visibleText(el)),
        controlTexts: controlTextsOf(el),
        containsH1: !!(h1El && typeof el.contains === "function" && el.contains(h1El)),
        containsMainRegion: !!(guardMainRegionEl && typeof el.contains === "function" && el.contains(guardMainRegionEl)),
      });
    }
    return out;
  }

  // Step 1 — "Couches superposées — exclusion avant toute mesure". Returns
  // `{ contentRoot, excludedEls }`: when a layer is judged to BE the content
  // (docs/PROTOCOL.md "une couche peut être le contenu"), `contentRoot` is
  // that element and the rest of the page is ignored; otherwise `contentRoot`
  // is null and `excludedEls` lists what to subtract from every measurement.
  function resolveOverlayExclusion() {
    const viewport = viewportSize();
    const h1El = typeof document.querySelector === "function" ? document.querySelector("h1") : null;
    const guardMainRegionEl =
      typeof document.querySelector === "function" ? document.querySelector("article, main, [role='main']") : null;
    const candidates = collectOverlayCandidates(viewport, guardMainRegionEl, h1El);

    const contentLayers = candidates.filter(isContentLayer);
    if (contentLayers.length) {
      // "S'il y en a plusieurs, le plus haut dans l'empilement (le dernier
      // dans l'ordre du document, à défaut de mieux)."
      const chosen = contentLayers[contentLayers.length - 1];
      return { contentRoot: chosen.el, excludedEls: [] };
    }

    const excludedEls = candidates.filter(shouldExcludeLayer).map((c) => c.el);
    return { contentRoot: null, excludedEls };
  }

  function isWithinExcluded(el, excludedEls) {
    return (excludedEls || []).some((ex) => ex === el || (typeof ex.contains === "function" && ex.contains(el)));
  }

  // Step 2 — "région principale" (unchanged rule, applied within whatever
  // survived step 1). Returns the element, not its text.
  // Une région principale n'est jamais dans un élément fixe ou collant (carte de
  // contact, panneau latéral) : mesuré le 25/09, la carte de contact d'une fiche
  // bienici porte la mention CNIL de son formulaire, bloc dense que l'extraction
  // prenait pour le contenu.
  // Mais sur la page de résultats de bienici, c'est toute la liste qui est dans
  // un panneau fixe (#searchSideView, 4 535 caractères sur 4 543). D'où la part
  // de texte : un élément fixe qui porte la moitié du texte de la page ou plus
  // est la surface principale, pas une barre latérale.
  const FIXED_SIDEBAR_MAX_SHARE = 0.5;
  const fixedShareCache = new Map();
  function isInsideFixedOrSticky(el) {
    let node = el;
    for (let i = 0; node && i < 25; i += 1) {
      const pos = safeComputedPosition(node);
      if (pos === "fixed" || pos === "sticky") {
        if (!fixedShareCache.has(node)) {
          const bodyLen = ((document.body && document.body.innerText) || "").length || 1;
          const ownLen = (node.innerText || "").length;
          fixedShareCache.set(node, ownLen / bodyLen);
        }
        return fixedShareCache.get(node) < FIXED_SIDEBAR_MAX_SHARE;
      }
      node = node.parentElement;
    }
    return false;
  }

  function findMainRegion(searchRoot, excludedEls) {
    if (searchRoot && typeof searchRoot.querySelectorAll === "function") {
      let semanticCandidates = [];
      try {
        semanticCandidates = searchRoot.querySelectorAll("article, main, [role='main']");
      } catch {
        semanticCandidates = [];
      }
      for (const el of semanticCandidates) {
        if (isWithinExcluded(el, excludedEls)) continue;
        if (!isRenderedCandidate(el)) continue;
        const text = textExcludingNodes(el, excludedEls);
        if (text.trim().length > 200) return el;
      }
    }

    let best = null;
    let bestScore = 0;
    let bestLength = 0;
    let candidates = [];
    try {
      candidates = searchRoot && searchRoot.querySelectorAll ? searchRoot.querySelectorAll("div, section") : [];
    } catch {
      candidates = [];
    }
    for (const el of candidates) {
      if (el.closest("nav, footer, header, aside, form, [contenteditable]")) continue;
      if (isWithinExcluded(el, excludedEls)) continue;
      if (isInsideFixedOrSticky(el)) continue; // barre latérale fixe : jamais la région principale
      if (!isRenderedCandidate(el)) continue;
      const text = textExcludingNodes(el, excludedEls);
      const length = text.trim().length;
      if (length < 200) continue;
      const density = length / (el.getElementsByTagName("*").length + 1);
      if (density > bestScore) {
        bestScore = density;
        best = el;
        bestLength = length;
      }
    }

    // T45 section 5 point 2 — "regrouper les blocs frères répétés". A comment
    // thread (Hacker News's table rows) or a Q&A page (Stack Overflow's
    // question + answers) has no single densest block: each entry, taken
    // alone, is denser than the entries-holding container, so the density
    // scan above elects one comment/answer and drops the rest. When a
    // repeated-shape sibling group's COMBINED text beats the single winner
    // above, prefer its container instead — same DENSITY LOSES, VOLUME WINS
    // trade the "list"/"listing" pipeline already makes for structured
    // entries (findCandidateEntryGroup below), applied here to prose
    // threads that never pass that pipeline's link/numeric-value gates.
    let threadGroup = null;
    try {
      threadGroup = findThreadGroupContainer(searchRoot, excludedEls);
    } catch {
      threadGroup = null;
    }
    if (threadGroup && threadGroup.length > bestLength) {
      const container = threadGroup.container;
      const containerOk =
        !isWithinExcluded(container, excludedEls) &&
        !isInsideFixedOrSticky(container) &&
        isRenderedCandidate(container) &&
        !(typeof container.closest === "function" && container.closest("nav, footer, header, aside, form, [contenteditable]"));
      if (containerOk) return container;
    }

    return best || searchRoot || document.body;
  }

  // Finds the smallest container holding a group of >= LIST_MIN_GROUP_SIZE
  // same-shape siblings whose COMBINED rendered text is largest — the
  // container itself (e.g. a comment `<table>`'s `<tbody>`, an `#answers`
  // wrapper), not any single entry. `bestSameShapeGroup`/`shapeKey` are the
  // same "→ list" shape test the structured-entries pipeline uses (step 3a
  // below); this walk is deliberately narrower than that pipeline (no link/
  // numeric-value requirement) because prose threads often have neither.
  const THREAD_GROUP_MIN_SIZE = LIST_MIN_GROUP_SIZE; // same bar as a "list" group
  const THREAD_ENTRY_MIN_CHARS = 40; // a real comment/answer, not a byline or a vote count

  function findThreadGroupContainer(searchRoot, excludedEls) {
    if (!searchRoot || typeof searchRoot.querySelectorAll !== "function") return null;
    let allEls = [];
    try {
      allEls = Array.from(searchRoot.querySelectorAll("*"));
    } catch {
      return null;
    }
    let bestContainer = null;
    let bestGroup = null;
    let bestCombined = 0;
    for (const container of allEls) {
      if (isWithinExcluded(container, excludedEls)) continue;
      try {
        if (container.closest && container.closest("nav, footer, header, aside, form, [contenteditable]")) continue;
      } catch {
        // treat as not excluded
      }
      const group = bestSameShapeGroup(container);
      if (!group || group.length < THREAD_GROUP_MIN_SIZE) continue;
      let combined = 0;
      let qualifying = 0;
      for (const entry of group) {
        if (!isRenderedCandidate(entry)) continue;
        const t = textExcludingNodes(entry, excludedEls).trim();
        if (t.length >= THREAD_ENTRY_MIN_CHARS) {
          combined += t.length;
          qualifying += 1;
        }
      }
      if (qualifying < THREAD_GROUP_MIN_SIZE) continue;
      if (combined > bestCombined) {
        bestCombined = combined;
        bestContainer = container;
        bestGroup = group;
      }
    }
    return bestContainer ? { container: bestContainer, group: bestGroup, length: bestCombined } : null;
  }

  // Step 3a — repeated entries ("→ list"). Shape = own tag + child tags, one
  // level deep ("même suite de balises enfants sur deux niveaux").
  function shapeKey(el) {
    if (!el) return "";
    const childTags = Array.from(el.children || []).map((c) => c.tagName).join(",");
    return `${el.tagName}[${childTags}]`;
  }

  function bestSameShapeGroup(parent) {
    if (!parent || !parent.children || parent.children.length < LIST_MIN_GROUP_SIZE) return null;
    const buckets = new Map();
    for (const child of parent.children) {
      const key = shapeKey(child);
      if (!buckets.has(key)) buckets.set(key, []);
      buckets.get(key).push(child);
    }
    let best = null;
    for (const group of buckets.values()) {
      if (group.length >= LIST_MIN_GROUP_SIZE && (!best || group.length > best.length)) best = group;
    }
    return best;
  }

  // "dans la région principale — ou, si la région principale est elle-même
  // une entrée, dans son plus proche ancêtre qui en contient plusieurs".
  //
  // Correction n°1 (docs/PROTOCOL.md): that closest ancestor is searched by
  // WALKING UP, six levels at most — not just the direct parent. Measured on
  // bienici: the region picked above is the promoted ad (3 253 chars), sitting
  // inside a box of 3 ads; the real results container (`search-results-list`,
  // 25 children, 24 same-shape `ARTICLE`) is two levels further up. Stopping
  // at the direct parent (the box of 3, too small to be a group of >=5) missed
  // the list entirely.
  function findCandidateEntryGroup(mainRegionEl) {
    if (!mainRegionEl) return null;

    // The region itself may already BE the results container (found directly
    // via `article, main, [role=main]`, or the density fallback).
    const ownGroup = bestSameShapeGroup(mainRegionEl);
    if (ownGroup) return { container: mainRegionEl, group: ownGroup };

    let ancestor = mainRegionEl.parentElement;
    for (let level = 0; ancestor && level < MAX_ANCESTOR_LEVELS; level += 1) {
      const group = bestSameShapeGroup(ancestor);
      if (group) return { container: ancestor, group };
      ancestor = ancestor.parentElement;
    }

    if (mainRegionEl.children) {
      for (const child of mainRegionEl.children) {
        const nested = bestSameShapeGroup(child);
        if (nested) return { container: child, group: nested };
      }
    }
    return null;
  }

  function entryLinkAndText(entry, excludedEls) {
    let hasLink = false;
    try {
      hasLink = typeof entry.querySelector === "function" && !!entry.querySelector("a[href]");
    } catch {
      hasLink = false;
    }
    const text = textExcludingNodes(entry, excludedEls).trim();
    return { hasLink, text };
  }

  // Validates the candidate group against every "list" condition in
  // docs/PROTOCOL.md before it is trusted, and computes the facts-outside
  // count needed both for the list/carousel distinction and for `listing`.
  //
  // Correction n°2: "une entrée hors bornes est écartée seule, elle ne
  // condamne pas le groupe." A promoted ad carrying its full description past
  // 1 000 chars used to invalidate the whole group; now it is dropped and the
  // group survives as long as >=5 in-bounds entries remain. The "at least
  // half numeric" and "at least 50% of main region text" ratios are then
  // judged against the surviving entries, not the original (possibly larger)
  // candidate group — an entry that was skipped never gets a vote either way.
  function evaluateListCandidate(container, group, mainRegionText, excludedEls) {
    if (!group || group.length < LIST_MIN_GROUP_SIZE) return null;

    let numericCount = 0;
    let cumulativeLength = 0;
    const entries = [];
    for (const entry of group) {
      if (!isElementUsable(entry)) continue; // out of bounds, skipped individually
      const { hasLink, text } = entryLinkAndText(entry, excludedEls);
      if (!hasLink) continue; // out of bounds, skipped individually
      if (text.length < LIST_ENTRY_MIN_CHARS || text.length > LIST_ENTRY_MAX_CHARS) continue;
      if (hasNumericValue(text)) numericCount += 1;
      cumulativeLength += text.length;
      entries.push({ el: entry, text });
    }
    if (entries.length < LIST_MIN_GROUP_SIZE) return null; // group no longer valid
    if (numericCount * 2 < entries.length) return null; // "au moins la moitié"
    const mainLength = (mainRegionText || "").trim().length || 1;
    if (cumulativeLength / mainLength < 0.5) return null; // "au moins 50 %"

    return { container, entries };
  }

  // Correction n°4 (docs/PROTOCOL.md, "Corrections mesurées sur des pages
  // réelles"). "Un fait ne se lit que dans un élément affiché." DOM trap:
  // `innerText` of a `display: none` element still returns its
  // `textContent` — reading it without this check is exactly how the 40
  // fact slots on the bienici fiche got filled with a hidden phone
  // country-code dropdown ("Afghanistan : +93"…) and form validation
  // messages. `getClientRects()` catches `display: none` (and detachment);
  // it does NOT catch `visibility: hidden` (the box still has layout), which
  // is why that is checked separately via computed style.
  function isElementUsable(el) {
    if (!el) return false;
    try {
      if (typeof el.getClientRects !== "function" || el.getClientRects().length === 0) return false;
    } catch {
      return false;
    }
    try {
      if (typeof getComputedStyle === "function") {
        const style = getComputedStyle(el);
        if (style && style.visibility === "hidden") return false;
      }
    } catch {
      // Can't tell — don't let a styling failure hide legitimate content.
    }
    return true;
  }

  // "jamais [un fait qui vit] dans un formulaire" — nor a hidden container,
  // nor anything explicitly marked non-visible for assistive tech.
  const FACT_HIDDEN_ANCESTOR_SELECTOR = 'form, select, option, datalist, [hidden], [aria-hidden="true"]';

  // A fact/entry label or value cell that IS or CONTAINS an editable region
  // (a draft comment typed into a <div contenteditable> nested in a table
  // cell, a <dd>, one half of an adjacent pair…) must never be read: the
  // guard in isFactsExcludedContext() only catches the container living
  // INSIDE an editable ancestor, not an editable descendant living inside an
  // otherwise ordinary label/value cell. Same promise as textExcludingEditable
  // above, applied to the smaller, per-cell granularity facts/items read at.
  function isOrContainsEditable(el) {
    if (!el) return false;
    try {
      if (typeof el.getAttribute === "function" && el.getAttribute("contenteditable") != null) return true;
    } catch {
      // fall through
    }
    try {
      if (typeof el.querySelector === "function" && el.querySelector("[contenteditable]")) return true;
    } catch {
      // not a real element / no querySelector — can't contain one.
    }
    return false;
  }

  // Step 3b — "Faits" (docs/PROTOCOL.md "Faits — context.facts"), the four
  // recognized shapes, read within `scopeEl` and excluding `excludedEls` and
  // any element in `excludedListEntries` (candidate list entries: facts never
  // read inside them, whether or not the page ends up being `list`).
  function isFactsExcludedContext(el, excludedEls, excludedListEntries) {
    if (isWithinExcluded(el, excludedEls)) return true;
    if (isWithinExcluded(el, excludedListEntries)) return true;
    if (!isElementUsable(el)) return true;
    try {
      if (el.closest("nav, footer, [role='navigation'], [role='contentinfo'], [contenteditable]")) return true;
      if (el.closest(FACT_HIDDEN_ANCESTOR_SELECTOR)) return true;
      const bannerAncestor = el.closest("header, [role='banner']");
      if (bannerAncestor && !bannerAncestor.closest("article")) return true;
    } catch {
      // Fake/degenerate DOM without closest(): treat as not excluded rather
      // than throwing — the caller's own try/catch is the real safety net.
    }
    return false;
  }

  // Measured 25/09 (notes/corpus/observations.md, piège n°3): MDN's `dt`/`dd`
  // pairs are navigation menus ("HTML reference : Elements"), not facts. A
  // `dd` that renders as several lines (a `<ul><li>` of links, one per line
  // via innerText's block-boundary breaks) or holds 2+ links is that kind of
  // menu, not a read-at-a-glance value — the whole dt/dd group is rejected,
  // not truncated, so it never dilutes real facts.
  function valueLooksLikeMenu(el) {
    if (!el) return false;
    const raw = visibleText(el);
    if (raw.includes("\n")) return true;
    try {
      const links = el.querySelectorAll ? el.querySelectorAll("a") : [];
      if (links.length >= 2) return true;
    } catch {
      // not a real element / no querySelectorAll — can't be a link list.
    }
    return false;
  }

  function factFromDefinitionLists(scopeEl, excludedEls, excludedListEntries, out) {
    let lists = [];
    try {
      lists = scopeEl.querySelectorAll ? Array.from(scopeEl.querySelectorAll("dl")) : [];
    } catch {
      lists = [];
    }
    for (const dl of lists) {
      if (isFactsExcludedContext(dl, excludedEls, excludedListEntries)) continue;
      const children = dl.children || [];
      let i = 0;
      while (i < children.length) {
        const node = children[i];
        if (node.tagName !== "DT") {
          i += 1;
          continue;
        }
        const label = normalizeFieldText(visibleText(node));
        const values = [];
        let isMenu = false;
        let isEditable = isOrContainsEditable(node);
        let j = i + 1;
        while (j < children.length && children[j].tagName === "DD") {
          if (valueLooksLikeMenu(children[j])) isMenu = true;
          if (isOrContainsEditable(children[j])) isEditable = true;
          values.push(normalizeFieldText(visibleText(children[j])));
          j += 1;
        }
        if (values.length && !isMenu && !isEditable) out.push({ label, value: values.join(", ") });
        i = j > i ? j : i + 1;
      }
    }
  }

  function factFromTwoCellRows(scopeEl, excludedEls, excludedListEntries, out) {
    let rows = [];
    try {
      rows = scopeEl.querySelectorAll ? Array.from(scopeEl.querySelectorAll("tr")) : [];
    } catch {
      rows = [];
    }
    for (const tr of rows) {
      if (isFactsExcludedContext(tr, excludedEls, excludedListEntries)) continue;
      const cells = Array.from(tr.children || []).filter((c) => c.tagName === "TH" || c.tagName === "TD");
      if (cells.length !== 2) continue;
      if (isOrContainsEditable(cells[0]) || isOrContainsEditable(cells[1])) continue;
      const label = normalizeFieldText(visibleText(cells[0]));
      const value = normalizeFieldText(visibleText(cells[1]));
      out.push({ label, value });
    }
  }

  // "Paire adjacente répétée" — an element with exactly two text-bearing
  // children, at least 2 siblings of the same shape (a characteristics grid).
  function factFromAdjacentPairs(scopeEl, excludedEls, excludedListEntries, out) {
    let containers = [];
    try {
      containers = scopeEl.querySelectorAll ? Array.from(scopeEl.querySelectorAll("*")) : [];
    } catch {
      containers = [];
    }
    containers.push(scopeEl);
    const seenParents = new Set();
    for (const parent of containers) {
      if (!parent || !parent.children || seenParents.has(parent)) continue;
      seenParents.add(parent);
      const pairShaped = Array.from(parent.children).filter((child) => {
        const textChildren = Array.from(child.children || []).filter((c) => visibleText(c).trim().length > 0);
        return textChildren.length === 2;
      });
      if (pairShaped.length < 3) continue; // self + at least 2 siblings
      for (const el of pairShaped) {
        if (isFactsExcludedContext(el, excludedEls, excludedListEntries)) continue;
        const [labelEl, valueEl] = Array.from(el.children).filter((c) => visibleText(c).trim().length > 0);
        if (valueLooksLikeMenu(valueEl)) continue; // same guard as the dl shape
        if (isOrContainsEditable(labelEl) || isOrContainsEditable(valueEl)) continue;
        const label = normalizeFieldText(visibleText(labelEl));
        const value = normalizeFieldText(visibleText(valueEl));
        out.push({ label, value });
      }
    }
  }

  // "Ligne « libellé : valeur »" — a leaf-ish element whose whole visible
  // text is one line shaped like `libellé : valeur`.
  const LABEL_VALUE_LINE_RE = /^([^\n:.!?]{1,60}):\s*(.+)$/;
  function factFromLabelValueLines(scopeEl, excludedEls, excludedListEntries, out) {
    let elements = [];
    try {
      elements = scopeEl.querySelectorAll ? Array.from(scopeEl.querySelectorAll("*")) : [];
    } catch {
      elements = [];
    }
    for (const el of elements) {
      if ((el.children || []).length > 0) continue; // "sans enfant de bloc" (approximation)
      if (isFactsExcludedContext(el, excludedEls, excludedListEntries)) continue;
      if (isOrContainsEditable(el)) continue;
      const raw = visibleText(el).trim();
      if (!raw || raw.includes("\n")) continue; // "l'élément a d'autres lignes"
      const match = LABEL_VALUE_LINE_RE.exec(raw);
      if (!match) continue;
      out.push({ label: normalizeFieldText(match[1]), value: normalizeFieldText(match[2]) });
    }
  }

  function findFacts(scopeEl, excludedEls, excludedListEntries) {
    const out = [];
    factFromDefinitionLists(scopeEl, excludedEls, excludedListEntries, out);
    factFromTwoCellRows(scopeEl, excludedEls, excludedListEntries, out);
    factFromAdjacentPairs(scopeEl, excludedEls, excludedListEntries, out);
    factFromLabelValueLines(scopeEl, excludedEls, excludedListEntries, out);
    return out;
  }

  // "Faits" caps and drop order, docs/PROTOCOL.md.
  function capFacts(rawFacts) {
    const seen = new Set();
    const out = [];
    for (const fact of rawFacts) {
      if (!fact || typeof fact.label !== "string" || typeof fact.value !== "string") continue;
      if (fact.label.length > FACT_CAPS.label) continue; // prose, not a fact
      // Une question ou une exclamation est un encart publicitaire, pas un fait
      // (mesuré le 25/09 sur une fiche bienici : « Besoin de déménager ? Comparez
      // les déménageurs ! », « … découvrez l'avantage fiscal dès maintenant ! »).
      if (/[?!]/.test(fact.label) || /!\s*$/.test(fact.value)) continue;
      if (!fact.label || !fact.value) continue;
      const key = `${fact.label}\u0000${fact.value}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ label: fact.label, value: truncateField(fact.value, FACT_CAPS.value) });
      if (out.length >= FACT_CAPS.count) break;
    }
    return out;
  }

  // Step 4 — "Entrées" (docs/PROTOCOL.md "Entrées — context.items").
  function buildItem(entryText) {
    const lines = entryText
      .split("\n")
      .map((l) => normalizeFieldText(l))
      .filter(Boolean);
    if (!lines.length) return null;

    const title = lines[0];
    const price = firstCurrencyValue(entryText);
    const priceLine = price ? lines.find((l) => l.includes(price)) : undefined;
    const locationLine = lines.find((l) => l !== title && l !== priceLine && looksLikeLocation(l));
    const detailLines = lines.filter((l) => l !== title && l !== priceLine && l !== locationLine);
    const detail = detailLines.join(" · ");

    const item = { title };
    if (price) item.price = price;
    if (locationLine) item.location = locationLine;
    if (detail) item.detail = detail;
    return item;
  }

  function titleForEntry(entry, fallbackText) {
    try {
      const heading = entry.querySelector && entry.querySelector("h2, h3, h4");
      if (heading && !isOrContainsEditable(heading)) {
        const t = normalizeFieldText(visibleText(heading));
        if (t) return t;
      }
      const link = entry.querySelector && entry.querySelector("a");
      if (link && !isOrContainsEditable(link)) {
        const t = normalizeFieldText(visibleText(link));
        if (t) return t;
      }
    } catch {
      // fall through to first line below
    }
    const firstLine = (fallbackText.split("\n")[0] || "").trim();
    return normalizeFieldText(firstLine);
  }

  function findItems(listCandidate, excludedEls) {
    const out = [];
    for (const { el, text } of listCandidate.entries) {
      const title = titleForEntry(el, text);
      if (!title) continue; // "une entrée sans titre non vide est écartée"
      const item = buildItem(text);
      if (!item) continue;
      item.title = title;
      out.push(item);
    }
    return out;
  }

  // "Entrées" caps: price/location over cap are omitted, not truncated.
  function capItems(rawItems) {
    const out = [];
    for (const item of rawItems) {
      if (!item || typeof item.title !== "string" || !item.title) continue;
      const capped = { title: truncateField(item.title, ITEM_CAPS.title) };
      if (typeof item.price === "string" && item.price && item.price.length <= ITEM_CAPS.price) {
        capped.price = item.price;
      }
      if (typeof item.location === "string" && item.location && item.location.length <= ITEM_CAPS.location) {
        capped.location = item.location;
      }
      if (typeof item.detail === "string" && item.detail) {
        capped.detail = truncateField(item.detail, ITEM_CAPS.detail);
      }
      out.push(capped);
      if (out.length >= ITEM_CAPS.count) break;
    }
    return out;
  }

  function textExcludingEntries(el, excludedEls, entries) {
    const entryEls = entries.map((e) => e.el);
    return textExcludingNodes(el, (excludedEls || []).concat(entryEls));
  }

  // "une ligne à moins de 3 éléments du h1" — a LINE, not an ancestor's whole
  // subtree. Checking the full text of each ancestor up to 3 levels made this
  // match arbitrarily far prose: on the Wikipedia "Coati" page, the 3rd
  // ancestor up from `h1` contains the entire article body, bibliography
  // included, and a citation ("2007, p. 1076") tripped the numeric check.
  // Restricting to individual short lines is a second, independent guard on
  // top of the regex fix above (NUMERIC_VALUE_RE) — either alone would have
  // fixed the Coati case, both together are cheap insurance.
  const CHIEF_FACT_LINE_MAX_CHARS = 200;
  function hasChiefNumericFact(facts, mainRegionEl, h1El, excludedEls) {
    if (facts.some((f) => hasNumericValue(f.value))) return true;
    if (!h1El || !mainRegionEl) return false;
    try {
      let el = h1El;
      for (let i = 0; i < 3 && el; i += 1) {
        el = el.parentElement || null;
        if (!el) break;
        const lines = textExcludingNodes(el, excludedEls).split("\n");
        for (const rawLine of lines) {
          const line = rawLine.trim();
          if (line && line.length <= CHIEF_FACT_LINE_MAX_CHARS && hasNumericValue(line)) return true;
        }
      }
    } catch {
      // ignore — this is a bonus signal, not required for correctness.
    }
    return false;
  }

  // ==========================================================================
  // T45 (docs/DECISIONS.md) — shadow DOM, invisible text, structure, readability.
  // points 3, 5, 6 and 4 of T45.
  // ==========================================================================

  // Step — shadow DOM (section 5 point 3). `innerText`/`querySelectorAll`
  // never pierce a shadow boundary; MDN alone measured 57 shadow hosts,
  // 53 000 hidden characters. Both API shapes are feature-detected and
  // wrapped: `el.shadowRoot` is null for a closed root, Chrome exposes
  // `chrome.dom.openOrClosedShadowRoot(el)`, Firefox exposes
  // `el.openOrClosedShadowRoot()` — never assume either exists.
  function getOpenOrClosedShadowRoot(el) {
    if (!el) return null;
    try {
      if (el.shadowRoot) return el.shadowRoot;
    } catch {
      // fall through
    }
    try {
      if (
        typeof chrome !== "undefined" &&
        chrome &&
        chrome.dom &&
        typeof chrome.dom.openOrClosedShadowRoot === "function"
      ) {
        const root = chrome.dom.openOrClosedShadowRoot(el);
        if (root) return root;
      }
    } catch {
      // fall through
    }
    try {
      if (typeof el.openOrClosedShadowRoot === "function") {
        const root = el.openOrClosedShadowRoot();
        if (root) return root;
      }
    } catch {
      // fall through
    }
    return null;
  }

  const SHADOW_MAX_DEPTH = 6; // bounded — a shadow tree recursing further is a bug in the page, not content.

  // A ShadowRoot is a DocumentFragment: it has no `.innerText`. Approximate
  // its rendered text by summing each direct child's own rendered text,
  // through the same `isRenderedCandidate` gate as everything else — a
  // closed-off, hidden custom element inside a shadow tree should not leak
  // in either.
  function shadowRootOwnText(root) {
    let children = [];
    try {
      children = root && root.children ? Array.from(root.children) : [];
    } catch {
      children = [];
    }
    const parts = [];
    for (const child of children) {
      if (!isRenderedCandidate(child)) continue;
      const t = visibleText(child).trim();
      if (t) parts.push(t);
    }
    return parts.join("\n");
  }

  function shadowRootText(root, depth) {
    if (!root || depth > SHADOW_MAX_DEPTH) return "";
    const ownText = shadowRootOwnText(root);
    let hostEls = [];
    try {
      hostEls = typeof root.querySelectorAll === "function" ? Array.from(root.querySelectorAll("*")) : [];
    } catch {
      hostEls = [];
    }
    const nestedParts = [];
    for (const host of hostEls) {
      const nestedRoot = getOpenOrClosedShadowRoot(host);
      if (nestedRoot) {
        const t = shadowRootText(nestedRoot, depth + 1);
        if (t) nestedParts.push(t);
      }
    }
    return [ownText, ...nestedParts].filter(Boolean).join("\n\n");
  }

  // Collects the rendered text of every shadow root found inside `root`
  // (root included). Never throws — a page that throws on `querySelectorAll`
  // or exposes a broken shadow API degrades to "no shadow text found", same
  // as the rest of this file's "an exception never fails the extraction".
  function collectShadowText(root, excludedEls) {
    if (!root) return "";
    let hostEls = [];
    try {
      hostEls = typeof root.querySelectorAll === "function" ? Array.from(root.querySelectorAll("*")) : [];
    } catch {
      hostEls = [];
    }
    hostEls.unshift(root);
    const parts = [];
    const seen = new Set();
    for (const host of hostEls) {
      if (seen.has(host)) continue;
      seen.add(host);
      if (isWithinExcluded(host, excludedEls)) continue;
      const shadow = getOpenOrClosedShadowRoot(host);
      if (!shadow) continue;
      const t = shadowRootText(shadow, 0);
      if (t) parts.push(t);
    }
    return parts.join("\n\n");
  }

  // Step — invisible-to-the-eye text (section 5 point 6). Zero-width
  // characters are handled textually in `truncate()`; the checks below catch
  // the DOM-level techniques (screen-reader-only clipping, off-screen
  // positioning, near-zero font size, same-colour-as-background) and feed
  // their elements into the SAME `excludedEls` subtraction mechanism already
  // used for overlays and contenteditable drafts (`textExcludingNodes`) —
  // no new plumbing, every caller downstream benefits automatically. Page
  // content stays data, never an instruction (CLAUDE.md rule 3); this is a
  // conservative reduction of the injection surface, not a security boundary
  // on its own.
  function isNearZeroFontSize(el) {
    try {
      if (typeof getComputedStyle !== "function") return false;
      const style = getComputedStyle(el);
      if (!style || !style.fontSize) return false;
      const px = parseFloat(style.fontSize);
      return Number.isFinite(px) && px > 0 && px <= 1.5;
    } catch {
      return false;
    }
  }

  const CLIP_ZERO_RE = /rect\(\s*0(px)?[,\s]+0(px)?[,\s]+0(px)?[,\s]+0(px)?\s*\)/i;
  function isClippedSrOnly(el) {
    try {
      if (typeof getComputedStyle !== "function") return false;
      const style = getComputedStyle(el);
      if (!style) return false;
      if (style.clip && CLIP_ZERO_RE.test(style.clip)) return true;
      if (style.clipPath && /inset\(\s*100%/i.test(style.clipPath)) return true;
    } catch {
      return false;
    }
    return false;
  }

  const OFFSCREEN_MARGIN_PX = 100; // tolerance — a lazy-load offset just above the fold is not "off-screen"
  // `getBoundingClientRect` is relative to the CURRENT viewport, not the
  // document — and extract.js can run at any scroll position (it's injected
  // on a user gesture on whatever the tab currently shows). A long article's
  // opening paragraphs, scrolled past, would have a negative top/bottom at
  // that instant: reading that as "off-screen" would delete real content.
  // The classic hiding technique (`left: -9999px` and relatives) always
  // pairs with `position: fixed`/`absolute` — normal flowed prose can't
  // reach those coordinates any other way — so require that position too.
  function isOffscreen(el, viewport) {
    const position = safeComputedPosition(el);
    if (position !== "fixed" && position !== "absolute") return false;
    const rect = safeRect(el);
    if (!rect) return false;
    const right = rect.right != null ? rect.right : (rect.left || 0) + (rect.width || 0);
    const bottom = rect.bottom != null ? rect.bottom : (rect.top || 0) + (rect.height || 0);
    const left = rect.left != null ? rect.left : 0;
    return (
      right < -OFFSCREEN_MARGIN_PX ||
      bottom < -OFFSCREEN_MARGIN_PX ||
      left > viewport.w + OFFSCREEN_MARGIN_PX * 10
    );
  }

  // Conservative on purpose (docs/DECISIONS.md T45 motif): exact string
  // equality only, both values present and non-transparent. Misses
  // near-matches and inherited backgrounds; a false negative here just
  // means the text is kept, same as today.
  function sameColorAsBackground(el) {
    try {
      if (typeof getComputedStyle !== "function") return false;
      const style = getComputedStyle(el);
      if (!style || !style.color || !style.backgroundColor) return false;
      if (style.backgroundColor === "transparent" || style.backgroundColor === "rgba(0, 0, 0, 0)") return false;
      return style.color === style.backgroundColor;
    } catch {
      return false;
    }
  }

  function isInvisibleToEye(el, viewport) {
    return (
      isNearZeroFontSize(el) || isClippedSrOnly(el) || isOffscreen(el, viewport) || sameColorAsBackground(el)
    );
  }

  function findInvisibleTextElements(root) {
    if (!root || typeof root.querySelectorAll !== "function") return [];
    let all = [];
    try {
      all = Array.from(root.querySelectorAll("*"));
    } catch {
      return [];
    }
    const viewport = viewportSize();
    const out = [];
    for (const el of all) {
      if (isInvisibleToEye(el, viewport)) out.push(el);
    }
    return out;
  }

  // Step — structure as plain text (section 5 point 5): headings become
  // `# `/`## `/`### ` lines, list items become `- ` lines. Deliberately NOT
  // a DOM-walking serializer: `innerText` already produces correct
  // paragraph breaks (see file header — that's why it was chosen over
  // `textContent`). Reinventing that walk risks fragmenting a sentence's own
  // inline markup (`<em>`, `<a>`) into separate lines. Instead: find each
  // heading/list item's OWN rendered text as an exact line already present
  // in the innerText-derived string (searching forward-only, so repeated
  // labels don't tag the wrong occurrence), and prefix that line in place.
  // A heading whose text does not surface as a single exact line (e.g. it
  // contains a hard <br>) simply keeps no prefix — degrades silently, never
  // throws, never touches the text otherwise.
  function headingPrefixFor(tag) {
    if (tag === "H1") return "# ";
    if (tag === "H2") return "## ";
    if (tag === "H3" || tag === "H4" || tag === "H5" || tag === "H6") return "### ";
    return "";
  }

  function applyStructurePrefixes(text, scopeEl, excludedEls) {
    if (!text || !scopeEl || typeof scopeEl.querySelectorAll !== "function") return text;
    let structuralEls = [];
    try {
      structuralEls = Array.from(scopeEl.querySelectorAll("h1, h2, h3, h4, h5, h6, li"));
    } catch {
      return text;
    }
    if (!structuralEls.length) return text;

    const lines = text.split("\n");
    let searchFrom = 0;
    for (const el of structuralEls) {
      if (isWithinExcluded(el, excludedEls)) continue;
      if (!isRenderedCandidate(el)) continue;
      const prefix = el.tagName === "LI" ? "- " : headingPrefixFor(el.tagName);
      if (!prefix) continue;
      const own = normalizeFieldText(visibleText(el));
      if (!own) continue;
      for (let i = searchFrom; i < lines.length; i += 1) {
        const trimmed = lines[i].trim();
        if (trimmed === own && !/^(#{1,3}|-)\s/.test(trimmed)) {
          lines[i] = `${prefix}${trimmed}`;
          searchFrom = i + 1;
          break;
        }
      }
    }
    return lines.join("\n");
  }

  // Step — readability (section 6, T45): tells the panel a page could not be
  // read, instead of silently sending near-nothing to the model. Measured
  // failure modes: a PDF viewer (no injection possible → empty), a map drawn
  // on `<canvas>` (structured pixels, no extractable text). "canvas" only
  // fires when BOTH signals agree (a dominant canvas AND little text) — a
  // canvas-based ad banner next to a normal article must never flip a good
  // read to "canvas".
  const CANVAS_COVERAGE_THRESHOLD = 0.5;
  const READABILITY_CANVAS_MAX_CHARS = 300;
  const READABILITY_EMPTY_MAX_CHARS = 200;

  function hasLargeCanvas() {
    try {
      if (typeof document.querySelectorAll !== "function") return false;
      const canvases = document.querySelectorAll("canvas");
      const viewport = viewportSize();
      for (const c of canvases) {
        const { coverageRatio } = rectMetrics(safeRect(c), viewport);
        if (coverageRatio >= CANVAS_COVERAGE_THRESHOLD) return true;
      }
    } catch {
      return false;
    }
    return false;
  }

  function computeReadability(text, items, facts) {
    let len = (text || "").length;
    if (Array.isArray(items)) {
      for (const it of items) {
        len += (it.title || "").length + (it.detail || "").length + (it.price || "").length + (it.location || "").length;
      }
    }
    if (Array.isArray(facts)) {
      for (const f of facts) len += (f.label || "").length + (f.value || "").length;
    }
    if (hasLargeCanvas() && len < READABILITY_CANVAS_MAX_CHARS) return "canvas";
    if (len < READABILITY_EMPTY_MAX_CHARS) return "empty";
    return "ok";
  }

  // Orchestrates steps 1-5 for `kind: "page"`. Never throws: any failure
  // degrades to today's plain-text `other` behavior (docs/PROTOCOL.md,
  // "other": "Une exception … ne fait jamais échouer l'extraction.").
  function buildPageKindContext() {
    const fallbackWholePageText = () => truncate(articleText());

    let contentRoot = null;
    let excludedEls = [];
    try {
      const resolved = resolveOverlayExclusion();
      contentRoot = resolved.contentRoot;
      excludedEls = resolved.excludedEls;
    } catch {
      contentRoot = null;
      excludedEls = [];
    }

    // T45 section 5 point 6 — feed elements invisible to the eye into the
    // same subtraction mechanism overlays already use. Downstream (main
    // region, facts, items, structure prefixes) all thread `excludedEls`
    // through, so this one merge covers the whole pipeline.
    try {
      excludedEls = excludedEls.concat(findInvisibleTextElements(document.body));
    } catch {
      // keep excludedEls as resolved above — a broken scan here must not
      // block extraction.
    }

    // Garde-fou : exclusion trop agressive → on l'annule et on reprend la
    // page entière, comportement d'aujourd'hui, avec pageKind "other" —
    // pas juste un reset silencieux qui laisserait retenter list/listing
    // sur une exclusion qu'on vient de juger excessive.
    try {
      if (!contentRoot && excludedEls.length) {
        const wholePageAfterExclusion = textExcludingNodes(document.body, excludedEls).trim();
        if (wholePageAfterExclusion.length < OVERLAY_FALLBACK_MIN_VISIBLE_CHARS) {
          const fallbackText = fallbackWholePageText();
          return {
            kind: "page",
            url: safePageUrl(),
            title: document.title || "",
            pageKind: "other",
            text: fallbackText,
            hasVideoElement: hasVideoElement(),
            hasArticleMarkup: hasArticleMarkup(),
            readability: computeReadability(fallbackText, undefined, undefined),
          };
        }
      }
    } catch {
      excludedEls = [];
    }

    const searchRoot = contentRoot || document.body;

    let mainRegionEl;
    try {
      mainRegionEl = findMainRegion(searchRoot, excludedEls);
    } catch {
      const fallbackText = fallbackWholePageText();
      return {
        kind: "page",
        url: safePageUrl(),
        title: document.title || "",
        text: fallbackText,
        hasVideoElement: hasVideoElement(),
        hasArticleMarkup: hasArticleMarkup(),
        readability: computeReadability(fallbackText, undefined, undefined),
      };
    }

    let mainRegionText = "";
    try {
      mainRegionText = textExcludingNodes(mainRegionEl, excludedEls);
    } catch {
      mainRegionText = "";
    }

    // T45 section 5 point 3 — shadow DOM read within the chosen region only:
    // it supplements the region the rest of the pipeline already trusts,
    // rather than risking pulling in an unrelated web-component's content.
    try {
      const shadowText = collectShadowText(mainRegionEl, excludedEls);
      if (shadowText) {
        mainRegionText = mainRegionText ? `${mainRegionText}\n\n${shadowText}` : shadowText;
      }
    } catch {
      // shadow read is a bonus signal — never block extraction on it.
    }

    let listCandidate = null;
    let facts = [];
    try {
      const candidateGroup = findCandidateEntryGroup(mainRegionEl);
      const excludedListEntries = candidateGroup ? candidateGroup.group : [];
      // `facts` (returned as `context.facts` when the page ends up NOT being
      // a list) only excludes the entries themselves — a fiche followed by a
      // carousel of "annonces similaires" must still report the fiche's own
      // facts, the carousel entries excluded.
      facts = findFacts(searchRoot, excludedEls, excludedListEntries);

      if (candidateGroup) {
        // Correction n°3: "aucun bloc de faits hors de la liste" is judged
        // hors du CONTENEUR, pas hors de ses entrées. The promoted ad's
        // description (inside the container, outside any single entry) can
        // legitimately contain "libellé : valeur" lines ("Taxes foncières :
        // 503 €") without turning the page into a `listing` — so this check
        // excludes the whole container, not just `group`, before counting.
        const factsOutsideContainer = findFacts(searchRoot, excludedEls, [candidateGroup.container]);
        if (factsOutsideContainer.length < 4) {
          listCandidate = evaluateListCandidate(
            candidateGroup.container,
            candidateGroup.group,
            mainRegionText,
            excludedEls,
          );
        }
      }
    } catch {
      facts = [];
      listCandidate = null;
    }

    const h1El = typeof document.querySelector === "function" ? document.querySelector("h1") : null;

    if (listCandidate) {
      let items = [];
      try {
        items = capItems(findItems(listCandidate, excludedEls));
      } catch {
        items = [];
      }
      if (items.length) {
        let text = "";
        try {
          text = textExcludingEntries(mainRegionEl, excludedEls, listCandidate.entries).trim();
          text = applyStructurePrefixes(text, mainRegionEl, excludedEls);
        } catch {
          text = "";
        }
        const budgetUsed = items.reduce(
          (sum, it) => sum + (it.title || "").length + (it.price || "").length + (it.location || "").length + (it.detail || "").length,
          0,
        );
        const cappedText = truncate(text, Math.max(0, MAX_CHARS - budgetUsed));
        return {
          kind: "page",
          url: safePageUrl(),
          title: document.title || "",
          pageKind: "list",
          items,
          text: cappedText,
          hasVideoElement: hasVideoElement(),
          hasArticleMarkup: hasArticleMarkup(),
          readability: computeReadability(cappedText, items, undefined),
        };
      }
      // "pageKind: 'list' sans aucune entrée valide → consigne other".
    }

    const cappedFacts = capFacts(facts);
    if (cappedFacts.length >= 4 && hasChiefNumericFact(cappedFacts, mainRegionEl, h1El, excludedEls)) {
      const budgetUsed = cappedFacts.reduce((sum, f) => sum + f.label.length + f.value.length, 0);
      const listingText = truncate(
        applyStructurePrefixes(mainRegionText, mainRegionEl, excludedEls),
        Math.max(0, MAX_CHARS - budgetUsed),
      );
      return {
        kind: "page",
        url: safePageUrl(),
        title: document.title || "",
        pageKind: "listing",
        facts: cappedFacts,
        text: listingText,
        hasVideoElement: hasVideoElement(),
        hasArticleMarkup: hasArticleMarkup(),
        readability: computeReadability(listingText, undefined, cappedFacts),
      };
    }

    const articleMarkup = hasArticleMarkup();
    const structuredMainText = applyStructurePrefixes(mainRegionText, mainRegionEl, excludedEls);
    const text = truncate(structuredMainText || fallbackWholePageText());
    if (articleMarkup || mainRegionText.trim().length > ARTICLE_TEXT_THRESHOLD) {
      return {
        kind: "page",
        url: safePageUrl(),
        title: document.title || "",
        pageKind: "article",
        text,
        hasVideoElement: hasVideoElement(),
        hasArticleMarkup: articleMarkup,
        readability: computeReadability(text, undefined, undefined),
      };
    }

    return {
      kind: "page",
      url: safePageUrl(),
      title: document.title || "",
      pageKind: "other",
      text,
      hasVideoElement: hasVideoElement(),
      hasArticleMarkup: articleMarkup,
      readability: computeReadability(text, undefined, undefined),
    };
  }

  const videoId = getYouTubeVideoId();

  if (videoId) {
    const transcript = getYouTubeTranscript();
    // Without a transcript, the densest block of a YouTube page is the
    // description plus the recommendations plus the comments. Summarising that
    // yields a plausible, wrong answer — worse than none. Say so instead, and
    // let the caller tell the user which gesture is missing.
    if (!transcript) {
      return {
        kind: "youtube",
        url: safePageUrl(),
        title: document.title || "",
        videoId,
        text: "",
        needsTranscript: true,
        hasVideoElement: hasVideoElement(),
        hasArticleMarkup: false,
        readability: "empty",
      };
    }
    const transcriptText = truncate(transcript);
    return {
      kind: "youtube",
      url: safePageUrl(),
      title: document.title || "",
      videoId,
      text: transcriptText,
      hasVideoElement: hasVideoElement(),
      hasArticleMarkup: false,
      // A short video has a short transcript: still the whole content.
      readability: transcriptText.trim() ? "ok" : "empty",
    };
  }

  try {
    return buildPageKindContext();
  } catch {
    // docs/PROTOCOL.md: an exception during pageKind/facts/items detection
    // never fails the extraction — degrade to today's plain text.
    const fallbackText = truncate(articleText());
    return {
      kind: "page",
      url: safePageUrl(),
      title: document.title || "",
      text: fallbackText,
      hasVideoElement: hasVideoElement(),
      hasArticleMarkup: hasArticleMarkup(),
      readability: computeReadability(fallbackText, undefined, undefined),
    };
  }
})();
