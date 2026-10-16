// Coati state lab — panel.html fixtures.
//
// One entry per state id, consumed by static/browser-stub.js and
// static/lab-runtime.js. Pure data (+ two small text builders) — no chrome.*,
// no DOM. Copied verbatim into every generated tree by build-lab.ts.
//
// This file only carries what a fixture can actually reach through
// the REAL panel.js/lib code (never modified).
(function () {
  "use strict";

  function repeatParagraph(paragraph, timesWords, wordsPerRepeat) {
    var repeats = Math.ceil(timesWords / wordsPerRepeat);
    var out = [];
    for (var i = 0; i < repeats; i++) out.push(paragraph);
    return out.join(" ");
  }

  var EXTREME_PARAGRAPH =
    "Le programme local reste local et n'expose jamais votre historique à un tiers, ce qui signifie que " +
    "chaque échange demeure sur cette machine, chiffré nulle part sur le disque mais jamais " +
    "transmis ailleurs que vers le fournisseur de modèle choisi dans les réglages, et cette " +
    "distinction compte parce qu'elle change ce que vous devez surveiller vous-même.";
  // ~50 words per repeat, 50 repeats ≈ 2500 words.
  var EXTREME_ANSWER =
    "Résumé détaillé\n\n" +
    repeatParagraph(EXTREME_PARAGRAPH, 2500, 50) +
    "\n\nSource : " +
    "https://exemple-tres-long-domaine-de-test.example.com/chemin/vers/une/ressource/particuliere" +
    "?utm_source=coati-lab&utm_medium=fixture&session=abcdef0123456789abcdef0123456789&page=4&trace=true";

  var CONVERSATION_ANSWER =
    "# Points clés de l'article\n\n" +
    "Voici ce qui ressort de la lecture, en gardant la structure de l'article d'origine.\n\n" +
    "- Le premier point porte sur le **contexte** : la mesure a été prise le 25 septembre.\n" +
    "- Le second point porte sur la méthode, décrite comme *reproductible*.\n" +
    "- Le troisième point renvoie vers la source primaire.\n\n" +
    "Plus de détails ici : https://exemple-actu.fr/dossier/mesure-25-09 — c'est le lien cité " +
    "deux fois dans l'article, une fois en note de bas de page.";

  // Exercises the DOM-based markdown renderer (extension/panel/markdown.js):
  // a heading, a nested list, a 4-column table, a fenced code block, a
  // blockquote and a link (rendered as plain "label (url)" text, never an
  // <a> — project rule 16).
  var RICH_ANSWER =
    "### Ce que dit la page\n\n" +
    "- Point principal\n" +
    "  - Sous-point avec un **mot important**\n" +
    "  - Autre sous-point, voir [la source](https://exemple-actu.fr/dossier/mesure-25-09)\n" +
    "- Second point\n\n" +
    "| Site | Prix | Latence | Note |\n" +
    "|:--|--:|--:|:-:|\n" +
    "| Fournisseur A | 12€ | 80ms | ✅ |\n" +
    "| Fournisseur B | 9€ | 140ms | ⚠️ |\n\n" +
    "```js\n" +
    "function score(latencyMs) {\n" +
    "  return latencyMs < 100 ? \"bon\" : \"moyen\";\n" +
    "}\n" +
    "```\n\n" +
    "> À vérifier avant de trancher : ces chiffres datent du 25 septembre.";

  // Guided tour (tour.js) opened from "?", then `nextClicks` steps forward.
  // Dev: an answer with its read mention, dev mode on.
  function tourState(dev, nextClicks) {
    var steps = [{ type: "click", selector: "#helpButton", delayMs: 150 }];
    // Delays count from page load, not from the previous step.
    for (var i = 0; i < nextClicks; i++) steps.push({ type: "click", selector: ".tour-next", delayMs: 400 + i * 150 });
    var storage = dev
      ? {
          "coati:conversation": [
            { id: "tour-u", role: "user", text: "Résumer cet article" },
            { id: "tour-a", role: "assistant", text: CONVERSATION_ANSWER, streaming: false, pageOnDemand: true, pageMention: "A lu le code de la page · 4.1 k tokens" },
          ],
          "coati:devMode": true,
          "coati:devModeAcknowledged": true,
        }
      : { "coati:conversation": [], "coati:attachPage": true, "coati:modelEverAnswered": true };
    return {
      status: "connected",
      tab: ARTICLE_TAB,
      extraction: { context: extractionContextFor(ARTICLE_TAB, "page") },
      faviconUrl: FAVICON,
      features: ["pageOnDemand"],
      storageLocal: storage,
      prompts: [],
      providerStatus: PROVIDER_OK,
      models: MODELS_LOCAL_AND_ONLINE,
      autoAction: { steps: steps },
    };
  }

  var YOUTUBE_TAB = {
    id: 501,
    url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
    title: "Conférence : comprendre les brokers locaux (vidéo)",
    favIconUrl: "https://www.youtube.com/favicon.ico",
  };

  var ARTICLE_TAB = {
    id: 502,
    url: "https://exemple-actu.fr/dossier/mesure-25-09",
    title: "Une mesure publiée le 25 septembre — exemple-actu.fr",
    favIconUrl: "https://exemple-actu.fr/favicon.ico",
  };

  var LONG_HOST_TAB = {
    id: 503,
    url: "https://www.this-is-a-very-long-subdomain-used-for-lab-testing-only.example.com/article/1",
    title: "Un article sur un domaine à nom délibérément très long",
    favIconUrl: "https://www.this-is-a-very-long-subdomain-used-for-lab-testing-only.example.com/favicon.ico",
  };

  // Recognised only by the lab bundle (build-lab.ts, LAB_EXTRA_SITES): a
  // site entry with an empty suggestion list.
  // New tabs/prompts — declared here, not
  // inline in the fixtures table below, so every top-level state key stays a
  // plain `"key": { ... }` object literal: stateIdsFromFixtureFile()
  // (build-lab.ts) matches states with a regex expecting exactly that shape.
  var POMOFOCUS_TAB = {
    id: 505,
    url: "https://pomofocus.io/",
    title: "Pomofocus — minuteur Pomodoro",
    favIconUrl: "https://pomofocus.io/favicon.ico",
  };

  var CRISCO_TAB = {
    id: 506,
    url: "https://crisco4.unicaen.fr/des/",
    title: "Dictionnaire Électronique des Synonymes — CRISCO",
    favIconUrl: "https://crisco4.unicaen.fr/favicon.ico",
  };

  // The "Activer" link (T43) states — a popular
  // site (Wikipédia) read via the gesture (activeTab, no persisted host
  // permission yet).
  var WIKIPEDIA_TAB = {
    id: 507,
    url: "https://fr.wikipedia.org/wiki/Coati",
    title: "Coati — Wikipédia",
    favIconUrl: "https://fr.wikipedia.org/favicon.ico",
  };

  // Hoisted: sitePrompt()/starPrompt() are function declarations, defined
  // further down, callable here regardless of source order.
  var YOUTUBE_MIXED_USER_PROMPT = sitePrompt(
    "@youtube",
    "Traduire les sous-titres",
    "Traduis les sous-titres de cette vidéo en français.",
  );

  var RECOGNISED_NO_SUGGESTION_TAB = {
    id: 504,
    url: "https://site-reconnu.example/articles/la-mesure-du-25-septembre",
    title: "La mesure du 25 septembre — Site reconnu",
    favIconUrl: "https://site-reconnu.example/favicon.ico",
  };

  // Neutral grey square generated by build-lab.ts — deliberately NOT the
  // Coati head, which the card now draws itself next to the site's icon.
  var FAVICON = "../../assets/favicon-sample.svg";

  // More than four lines in a ~300px composer, whatever the font metrics.
  var LONG_COMPOSER_TEXT =
    "Peux-tu relire ce passage et me dire ce qui cloche ?\n" +
    "Première ligne du passage, recopiée telle quelle.\n" +
    "Deuxième ligne, un peu plus longue que la première, pour voir le retour à la ligne.\n" +
    "Troisième ligne.\n" +
    "Quatrième ligne.\n" +
    "Cinquième ligne : à partir d'ici, la barre de défilement doit apparaître.\n" +
    "Sixième ligne.";

  // PromptEntry shape (docs/PROTOCOL.md
  // préférences par site"): {id, site, title?, body}.
  // `starPrompt`/`sitePrompt` just save on repetition below.
  var promptIdCounter = 0;
  function nextPromptId() {
    promptIdCounter += 1;
    return "p_fixture" + String(promptIdCounter).padStart(6, "0");
  }
  function starPrompt(title, body) {
    return { id: nextPromptId(), site: "*", title: title, body: body };
  }
  function sitePrompt(site, title, body) {
    return { id: nextPromptId(), site: site, title: title, body: body };
  }

  // Five user prompts in "Tous les sites" — same wording as the pre-28/09
  // library, just re-shaped.
  var STAR_PROMPTS_5 = [
    starPrompt("Résumé neutre", "Résume cette page de façon neutre, sans jugement de valeur."),
    starPrompt("Traduction FR", "Traduis le contenu principal de cette page en français."),
    starPrompt("Liste de risques", "Liste les risques ou points de vigilance mentionnés sur cette page."),
    starPrompt("Contre-arguments", "Donne les contre-arguments les plus solides à la thèse de cette page."),
    starPrompt("Version courte", "Réduis ce texte à trois phrases, sans perdre l'idée centrale."),
  ];

  var STAR_PROMPTS_10 = STAR_PROMPTS_5.concat([
    starPrompt("Plan détaillé", "Propose un plan détaillé du contenu de cette page."),
    starPrompt("Questions ouvertes", "Quelles questions cette page laisse-t-elle sans réponse ?"),
    starPrompt("Vocabulaire", "Explique les termes techniques employés sur cette page."),
    starPrompt("Chronologie", "Remets les événements de cette page dans l'ordre chronologique."),
    starPrompt("Ton et intention", "Décris le ton de cette page et l'intention probable de son auteur."),
  ]);

  function extractionContextFor(tab, kind) {
    return {
      url: tab.url,
      title: tab.title,
      text: "Contenu de page simulé pour le laboratoire d'états — assez long pour être un article. ".repeat(20),
      kind: kind || "page",
      pageKind: kind === "youtube" ? undefined : "article",
      hasVideoElement: kind === "youtube",
      hasArticleMarkup: kind !== "youtube",
      needsTranscript: false,
      videoId: kind === "youtube" ? "dQw4w9WgXcQ" : undefined,
    };
  }

  // --- (docs/DECISIONS.md T50/T51): "Lire cette page" button and the
  // first-launch card. A tab the panel can't see into: Chrome answers
  // tabs.query/get without `url` when no host permission covers it.
  var HIDDEN_TAB = { id: 508, title: undefined, url: undefined };
  var ALL_SITES = ["http://*/*", "https://*/*"];
  var PROVIDER_OK = { provider: "ollama", state: "ok", reason: "ready" };
  var PROVIDER_KO = { provider: "claude-api", state: "ko", reason: "no-key" };

  // models.list: the model pill next to « Connecté »
  // and its menu. Local + online, one « thinking » model, sizes in GB.
  var MODELS_LOCAL_AND_ONLINE = {
    current: { provider: "ollama", model: "qwen3:4b" },
    entries: [
      { provider: "ollama", model: "qwen3:4b", local: true, sizeBytes: 2_600_000_000, thinks: true },
      { provider: "ollama", model: "llama3.2:latest", local: true, sizeBytes: 2_019_393_189 },
      { provider: "ollama", model: "gemma3:12b", local: true, sizeBytes: 8_149_190_253 },
      { provider: "claude-cli", model: "claude-sonnet-4-5", local: false },
      { provider: "openai-compat", model: "meta-llama/llama-3.3-70b-instruct:free", local: false },
    ],
    sources: [
      { provider: "ollama", state: "ok" },
      { provider: "claude-cli", state: "ok" },
      { provider: "openai-compat", state: "ok" },
    ],
  };
  // Ollama down, an online model answering: the calm line replaces the
  // local section.
  var MODELS_OLLAMA_DOWN = {
    current: { provider: "claude-cli", model: "claude-sonnet-4-5" },
    entries: [{ provider: "claude-cli", model: "claude-sonnet-4-5", local: false }],
    sources: [
      { provider: "ollama", state: "unreachable" },
      { provider: "claude-cli", state: "ok" },
      { provider: "openai-compat", state: "not-configured" },
    ],
  };
  // Machine capacity — Romain's machine (16 GB, 6.4 GB VRAM). The
  // loaded model carries a measured gpuPercent, which wins over its fit.
  var MODELS_WITH_FIT = {
    current: { provider: "ollama", model: "qwen3:8b" },
    entries: [
      { provider: "ollama", model: "qwen3:8b", local: true, sizeBytes: 5_225_387_923, fit: "shared", gpuPercent: 74 },
      { provider: "ollama", model: "qwen3.5:4b", local: true, sizeBytes: 3_300_000_000, fit: "gpu" },
      { provider: "ollama", model: "qwen3:4b", local: true, sizeBytes: 2_600_000_000, fit: "gpu", thinks: true },
      { provider: "ollama", model: "gemma3:27b", local: true, sizeBytes: 17_396_936_315, fit: "too-big" },
      { provider: "claude-cli", model: "claude-sonnet-4-5", local: false },
    ],
    sources: [
      { provider: "ollama", state: "ok" },
      { provider: "claude-cli", state: "ok" },
    ],
    host: { ramGb: 16, vramGb: 6.4 },
  };
  // Same machine, qwen3:4b in use: picking
  // qwen3:8b (« partagé ») in the menu adds the calm notice line.
  var MODELS_FIT_4B_CURRENT = Object.assign({}, MODELS_WITH_FIT, {
    current: { provider: "ollama", model: "qwen3:4b" },
  });
  var ARTICLE_QUESTION = "Résumer cet article : Une mesure publiée le 25 septembre";
  function sendQuestion() {
    return {
      steps: [
        { type: "fill", selector: "#input", value: ARTICLE_QUESTION, delayMs: 40 },
        { type: "click", selector: "#send", delayMs: 20 },
      ],
    };
  }
  // `settings` answered to the panel's one settings.get: module labels for
  // the menu's online entries (never the raw id « claude-cli »).
  function settingsFor(provider, model) {
    return {
      provider: provider,
      model: model,
      models: [],
      available: [
        { id: "ollama", available: true, configured: true, label: "Ollama" },
        { id: "claude-cli", available: true, configured: true, label: "Claude (abonnement)" },
        { id: "openai-compat", available: true, configured: true, label: "Compatible OpenAI" },
      ],
    };
  }
  var PROVIDER_CLAUDE_CLI_OK ={ provider: "claude-cli", state: "ok", reason: "logged-in" };

  window.__COATI_LAB_FIXTURES__ = {
    // Connecté, site reconnu (favicon + nom + suggestions), fil vide.
    // État requis : site connu avec favicon.
    idle: {
      status: "connected",
      tab: YOUTUBE_TAB,
      extraction: { context: extractionContextFor(YOUTUBE_TAB, "youtube") },
      faviconUrl: FAVICON,
      storageLocal: { "coati:conversation": [], "coati:attachPage": true },
      prompts: [],
    },

    // U1 — language selector (lib/language-selector.js), menu open: the
    // header button next to the gear, same "idle" ground state, the menu
    // popped open by a scripted click (no real extension runtime behind
    // the lab, so there is nothing to preload for "open" — it's a UI state,
    // reached the same way a user reaches it).
    "lang-menu-open": {
      status: "connected",
      tab: YOUTUBE_TAB,
      extraction: { context: extractionContextFor(YOUTUBE_TAB, "youtube") },
      faviconUrl: FAVICON,
      storageLocal: { "coati:conversation": [], "coati:attachPage": true },
      prompts: [],
      autoAction: {
        steps: [{ type: "click", selector: "#langSelectorButton", delayMs: 0 }],
      },
    },

    // Model pill, menu closed: local model named next to « Connecté ».
    "model-pill": {
      status: "connected",
      tab: YOUTUBE_TAB,
      extraction: { context: extractionContextFor(YOUTUBE_TAB, "youtube") },
      faviconUrl: FAVICON,
      storageLocal: { "coati:conversation": [], "coati:attachPage": true },
      prompts: [],
      providerStatus: PROVIDER_OK,
      models: MODELS_LOCAL_AND_ONLINE,
    },

    // Menu open: « Sur cet ordinateur » (sizes, qwen3 « réfléchit avant de
    // répondre »), « En ligne », « Ajouter un modèle… »; qwen3:4b checked.
    "model-menu-open": {
      status: "connected",
      tab: YOUTUBE_TAB,
      extraction: { context: extractionContextFor(YOUTUBE_TAB, "youtube") },
      faviconUrl: FAVICON,
      storageLocal: { "coati:conversation": [], "coati:attachPage": true },
      prompts: [],
      providerStatus: PROVIDER_OK,
      models: MODELS_LOCAL_AND_ONLINE,
      settings: settingsFor("ollama", "qwen3:4b"),
      echoSettingsSet: true,
      autoAction: {
        steps: [{ type: "click", selector: "#modelPill", delayMs: 60 }],
      },
    },

    // Menu open with fit words: « chargé à 74 % dans la carte
    // graphique » (measured, current), « tient dans la carte graphique »,
    // « trop gros pour cet ordinateur » (muted, still selectable).
    "model-menu-fit": {
      status: "connected",
      tab: YOUTUBE_TAB,
      extraction: { context: extractionContextFor(YOUTUBE_TAB, "youtube") },
      faviconUrl: FAVICON,
      storageLocal: { "coati:conversation": [], "coati:attachPage": true },
      prompts: [],
      providerStatus: PROVIDER_OK,
      models: MODELS_WITH_FIT,
      settings: settingsFor("ollama", "qwen3:8b"),
      echoSettingsSet: true,
      autoAction: {
        steps: [{ type: "click", selector: "#modelPill", delayMs: 60 }],
      },
    },

    // Ollama not answering, Claude in use: pill « en ligne », menu open with
    // « Ollama ne répond pas » instead of the local models.
    "model-menu-ollama-down": {
      status: "connected",
      tab: YOUTUBE_TAB,
      extraction: { context: extractionContextFor(YOUTUBE_TAB, "youtube") },
      faviconUrl: FAVICON,
      storageLocal: { "coati:conversation": [], "coati:attachPage": true },
      prompts: [],
      providerStatus: PROVIDER_CLAUDE_CLI_OK,
      models: MODELS_OLLAMA_DOWN,
      settings: settingsFor("claude-cli", "claude-sonnet-4-5"),
      autoAction: {
        steps: [{ type: "click", selector: "#modelPill", delayMs: 60 }],
      },
    },

    // Older local program, no models.list: the
    // pill stays visible (calm "update the local program" state) instead of
    // hiding, and still names the current model from settings.get.
    "model-pill-stale-broker": {
      status: "connected",
      tab: YOUTUBE_TAB,
      extraction: { context: extractionContextFor(YOUTUBE_TAB, "youtube") },
      faviconUrl: FAVICON,
      storageLocal: { "coati:conversation": [], "coati:attachPage": true },
      prompts: [],
      providerStatus: PROVIDER_OK,
      modelsUnsupported: true,
      settings: settingsFor("ollama", "qwen3:8b"),
    },

    // Same state, menu open: one calm line explaining why, plus « Ouvrir les
    // réglages » — no model list, no switching (the local program can't say).
    "model-menu-stale-broker-open": {
      status: "connected",
      tab: YOUTUBE_TAB,
      extraction: { context: extractionContextFor(YOUTUBE_TAB, "youtube") },
      faviconUrl: FAVICON,
      storageLocal: { "coati:conversation": [], "coati:attachPage": true },
      prompts: [],
      providerStatus: PROVIDER_OK,
      modelsUnsupported: true,
      settings: settingsFor("ollama", "qwen3:8b"),
      autoAction: {
        steps: [{ type: "click", selector: "#modelPill", delayMs: 60 }],
      },
    },

    // provider.status reason "model-missing":
    // the pill names the (wrongly) configured model, the status text next
    // to « Connecté » carries the only real problem and is itself a button
    // (underline on hover/focus) — clicking it opens the same model menu.
    "status-model-missing": {
      status: "connected",
      tab: YOUTUBE_TAB,
      extraction: { context: extractionContextFor(YOUTUBE_TAB, "youtube") },
      faviconUrl: FAVICON,
      storageLocal: { "coati:conversation": [], "coati:attachPage": true },
      prompts: [],
      providerStatus: { provider: "ollama", state: "ko", reason: "model-missing" },
      models: MODELS_LOCAL_AND_ONLINE,
    },

    // Same state, status text clicked: the model menu opens, same as a pill
    // click would.
    "status-model-missing-menu-open": {
      status: "connected",
      tab: YOUTUBE_TAB,
      extraction: { context: extractionContextFor(YOUTUBE_TAB, "youtube") },
      faviconUrl: FAVICON,
      storageLocal: { "coati:conversation": [], "coati:attachPage": true },
      prompts: [],
      providerStatus: { provider: "ollama", state: "ko", reason: "model-missing" },
      models: MODELS_LOCAL_AND_ONLINE,
      autoAction: {
        steps: [{ type: "click", selector: "#status .status-label", delayMs: 60 }],
      },
    },

    // Waiting line before the first
    // word, Ollama « loading » stage: « Chargement du modèle… » in the
    // pending answer, no blinking cursor.
    "progress-loading": {
      status: "connected",
      tab: ARTICLE_TAB,
      extraction: { context: extractionContextFor(ARTICLE_TAB, "page") },
      faviconUrl: FAVICON,
      storageLocal: { "coati:conversation": [], "coati:attachPage": true },
      prompts: [],
      providerStatus: PROVIDER_OK,
      models: MODELS_WITH_FIT,
      settings: settingsFor("ollama", "qwen3:8b"),
      chatScript: [{ delayMs: 40, message: { type: "progress", stage: "loading" } }],
      autoAction: sendQuestion(),
    },

    // Same, then « reading »: « Le modèle lit la page… » (page attached).
    "progress-reading": {
      status: "connected",
      tab: ARTICLE_TAB,
      extraction: { context: extractionContextFor(ARTICLE_TAB, "page") },
      faviconUrl: FAVICON,
      storageLocal: { "coati:conversation": [], "coati:attachPage": true },
      prompts: [],
      providerStatus: PROVIDER_OK,
      models: MODELS_WITH_FIT,
      settings: settingsFor("ollama", "qwen3:8b"),
      chatScript: [
        { delayMs: 30, message: { type: "progress", stage: "loading" } },
        { delayMs: 90, message: { type: "progress", stage: "reading" } },
      ],
      autoAction: sendQuestion(),
    },

    // Thinking-only model (qwen3:4b) reasoning before its first word:
    // « Le modèle réfléchit… » + the hint line « …c'est plus long. ».
    "progress-thinking": {
      status: "connected",
      tab: ARTICLE_TAB,
      extraction: { context: extractionContextFor(ARTICLE_TAB, "page") },
      faviconUrl: FAVICON,
      storageLocal: { "coati:conversation": [], "coati:attachPage": true },
      prompts: [],
      providerStatus: PROVIDER_OK,
      models: MODELS_FIT_4B_CURRENT,
      settings: settingsFor("ollama", "qwen3:4b"),
      chatScript: [
        { delayMs: 30, message: { type: "progress", stage: "reading" } },
        { delayMs: 90, message: { type: "progress", stage: "thinking" } },
      ],
      autoAction: sendQuestion(),
    },

    // Point 3 — qwen3:4b in use, qwen3:8b (« partagé ») picked in the menu:
    // the switch happens, and one calm line follows in the conversation
    // (« … ne tient pas entièrement … il sera lent. qwen3.5:4b y tient. »).
    "shared-model-advice": {
      status: "connected",
      tab: ARTICLE_TAB,
      extraction: { context: extractionContextFor(ARTICLE_TAB, "page") },
      faviconUrl: FAVICON,
      storageLocal: { "coati:conversation": [], "coati:attachPage": true },
      prompts: [],
      providerStatus: PROVIDER_OK,
      models: MODELS_FIT_4B_CURRENT,
      settings: settingsFor("ollama", "qwen3:4b"),
      echoSettingsSet: true,
      autoAction: {
        steps: [
          { type: "click", selector: "#modelPill", delayMs: 60 },
          { type: "click", selector: '#modelMenu .model-item[data-model="qwen3:8b"]', delayMs: 60 },
        ],
      },
    },

    // Points 6-7 — qwen3:8b goes silent mid-answer (model-stalled): the
    // words stay, the reason follows, « Réessayer », then the tip
    // (« essayez qwen3.5:4b… », « Passer à qwen3.5:4b », « Accélérer Ollama »).
    "answer-stalled-tip": {
      status: "connected",
      tab: ARTICLE_TAB,
      extraction: { context: extractionContextFor(ARTICLE_TAB, "page") },
      faviconUrl: FAVICON,
      storageLocal: { "coati:conversation": [], "coati:attachPage": true },
      prompts: [],
      providerStatus: PROVIDER_OK,
      models: MODELS_WITH_FIT,
      settings: settingsFor("ollama", "qwen3:8b"),
      chatScript: [
        { delayMs: 20, message: { type: "progress", stage: "reading" } },
        {
          delayMs: 50,
          message: {
            type: "chunk",
            delta: "L'article décrit une mesure publiée le 25 septembre. La méthode est présentée comme reproductible, et",
          },
        },
        { delayMs: 90, message: { type: "error", code: "model-stalled", message: "no text from the model for 60 s" } },
      ],
      autoAction: sendQuestion(),
    },

    // Question + longue réponse markdown (gras, liste, lien), case "lit
    // cette page" cochée.
    conversation: {
      status: "connected",
      tab: ARTICLE_TAB,
      extraction: { context: extractionContextFor(ARTICLE_TAB, "page") },
      faviconUrl: FAVICON,
      storageLocal: {
        "coati:conversation": [
          { id: "m1-u", role: "user", text: "Peux-tu résumer cet article ?\n\n*avec le contenu de la page*" },
          { id: "m1", role: "assistant", text: CONVERSATION_ANSWER, streaming: false },
        ],
        "coati:attachPage": true,
      },
      prompts: [],
    },

    // Réponse markdown riche (titre, liste imbriquée, tableau 4 colonnes,
    // bloc de code, citation, lien) — état requis pour vérifier le rendu
    // DOM du nouveau markdown.js hors des cas déjà couverts par
    // "conversation" (deliverable 5, mission markdown DOM).
    "rich-answer": {
      status: "connected",
      tab: ARTICLE_TAB,
      extraction: { context: extractionContextFor(ARTICLE_TAB, "page") },
      faviconUrl: FAVICON,
      storageLocal: {
        "coati:conversation": [
          { id: "ra-u", role: "user", text: "Compare les deux fournisseurs avec un tableau." },
          { id: "ra1", role: "assistant", text: RICH_ANSWER, streaming: false },
        ],
        "coati:attachPage": true,
      },
      prompts: [],
    },

    // Réponse en cours : composeur pré-rempli puis Envoyer cliqué au chargement
    // (aucun `done`/`error` n'arrive jamais côté broker simulé) — Annuler visible.
    streaming: {
      status: "connected",
      tab: null,
      faviconUrl: FAVICON,
      storageLocal: {
        "coati:conversation": [
          { id: "m0-u", role: "user", text: "Quelle est la différence entre les deux fournisseurs ?" },
          { id: "m0", role: "assistant", text: "Le premier tourne localement, le second appelle une API distante." },
        ],
        "coati:attachPage": false,
      },
      prompts: [],
      autoAction: {
        steps: [
          { type: "fill", selector: "#input", value: "Et question de coût, laquelle recommandes-tu ?", delayMs: 0 },
          { type: "click", selector: "#send", delayMs: 20 },
        ],
      },
    },

    // Bandeau de connexion — "no-token" (4401) : id d'extension refusé après
    // toutes les tentatives automatiques (anti-oracle, texte neutre panel_banner_pairing_refused +
    // « Réessayer » ; la cause exacte n'est pas divulguée). Plus de variante Firefox/Chromium
    // (Native Messaging).
    disconnected: {
      status: "no-token",
      tab: null,
      faviconUrl: FAVICON,
      storageLocal: { "coati:conversation": [], "coati:attachPage": null },
      prompts: [],
    },

    // Bandeau de connexion — "no-host" : programme natif introuvable (docs/PROTOCOL.md). Deux liens
    // : doc d'install et réglages (section Flatpak/Snap).
    "no-host": {
      status: "no-host",
      tab: null,
      faviconUrl: FAVICON,
      storageLocal: { "coati:conversation": [], "coati:attachPage": null },
      prompts: [],
    },

    // Bandeau de connexion — "broker-untrusted" (4000) : un programme répond
    // sur le port 8787 mais n'a pas prouvé être le broker Coati (preuve HMAC
    // fausse). Texte propre au cas
    // (panel_banner_broker_untrusted) + « Réessayer ».
    "broker-untrusted": {
      status: "broker-untrusted",
      tab: null,
      faviconUrl: FAVICON,
      storageLocal: { "coati:conversation": [], "coati:attachPage": null },
      prompts: [],
    },

    // Bandeau de connexion — "pairing-retry" : le programme a refusé la
    // poignée de main ; relances automatiques en cours (backoff). Pas de
    // bouton Réessayer (doublon avec la tentative automatique). Texte :
    // panel_banner_pairing_retry.
    "pairing-retry": {
      status: "pairing-retry",
      tab: null,
      faviconUrl: FAVICON,
      storageLocal: { "coati:conversation": [], "coati:attachPage": null },
      prompts: [],
    },

    // "Activer Coati sur ce site" — extraction refusée pour défaut de permission.
    "not-activated": {
      status: "connected",
      tab: ARTICLE_TAB,
      extraction: { error: "no-access", origin: "https://exemple-actu.fr" },
      permissions: [],
      faviconUrl: FAVICON,
      storageLocal: { "coati:conversation": [], "coati:attachPage": null },
      prompts: [],
    },

    // Aucun onglet lisible : carte "Cette page", adresse inconnue -> carré
    // gris neutre; interrupteur "Lire la page" grisé (état
    // requis : interrupteur désactivé).
    unreadable: {
      status: "connected",
      tab: null,
      faviconUrl: FAVICON,
      storageLocal: { "coati:conversation": [], "coati:attachPage": null },
      prompts: [],
    },

    // docs/DECISIONS.md T43 (le lien "Activer" est remplacé
    // par le bouton "Lire cette page", T50) — adresse connue (lue via le
    // geste, activeTab, sans permission persistée), site non actif.
    "site-inactive": {
      status: "connected",
      tab: WIKIPEDIA_TAB,
      extraction: { context: extractionContextFor(WIKIPEDIA_TAB, "page") },
      permissions: [],
      faviconUrl: FAVICON,
      storageLocal: { "coati:conversation": [], "coati:attachPage": null },
      prompts: [],
    },

    // Même page, permission déjà accordée pour tous les domaines Wikipédia
    // (T42 — un site populaire s'active domaine par domaine, tous à la
    // fois) : le bouton "Lire cette page" (T50) doit disparaître.
    "site-active": {
      status: "connected",
      tab: WIKIPEDIA_TAB,
      extraction: { context: extractionContextFor(WIKIPEDIA_TAB, "page") },
      permissions: ["https://*.wikipedia.org/*"],
      faviconUrl: FAVICON,
      storageLocal: { "coati:conversation": [], "coati:attachPage": null },
      prompts: [],
    },

    // docs/DECISIONS.md T44 — encart d'une page d'adresse inconnue : les
    // prompts "@unsorted" (partie sans nom de la case de tête) d'abord,
    // puis "Tous les sites".
    "unknown-unsorted": {
      status: "connected",
      tab: null,
      faviconUrl: FAVICON,
      storageLocal: { "coati:conversation": [], "coati:attachPage": null },
      prompts: [
        sitePrompt("@unsorted", "", "Explique ce que je viens de coller ici."),
        sitePrompt("@unsorted", "Reformuler", "Reformule ce texte plus simplement."),
        starPrompt("Résumé neutre", "Résume cette page de façon neutre, sans jugement de valeur."),
      ],
    },

    // Disquette cliquée sur une page d'adresse inconnue : notice exacte
    // "Enregistré, sans site : Coati ne voit pas l'adresse de cette page."
    "saved-unsorted": {
      status: "connected",
      tab: null,
      faviconUrl: FAVICON,
      storageLocal: { "coati:conversation": [], "coati:attachPage": null },
      prompts: [],
      autoAction: {
        steps: [
          { type: "fill", selector: "#input", value: "Explique ce que je viens de coller ici.", delayMs: 0 },
          { type: "click", selector: "#savePrompt", delayMs: 20 },
        ],
      },
    },

    // Plus de liste
    // dépliable dans le panneau (zone 5b disparue, page "Mes prompts" à
    // part) — cet état montre désormais l'encart avec des prompts déjà
    // enregistrés dans "Tous les sites", à la suite des suggestions Coati.
    "prompts-list": {
      status: "connected",
      tab: YOUTUBE_TAB,
      extraction: { context: extractionContextFor(YOUTUBE_TAB, "youtube") },
      faviconUrl: FAVICON,
      storageLocal: { "coati:conversation": [], "coati:attachPage": true },
      prompts: STAR_PROMPTS_5,
    },

    // Le champ "nom du prompt" a disparu avec la
    // zone 5b — la disquette enregistre maintenant tout de suite, sans
    // titre. Cet état déclenche ce nouveau chemin : texte saisi puis 💾
    // cliquée, la notice "Enregistré pour …" doit apparaître.
    "prompts-name": {
      status: "connected",
      tab: YOUTUBE_TAB,
      extraction: { context: extractionContextFor(YOUTUBE_TAB, "youtube") },
      faviconUrl: FAVICON,
      storageLocal: { "coati:conversation": [], "coati:attachPage": true },
      prompts: [],
      autoAction: {
        steps: [
          { type: "fill", selector: "#input", value: "Explique-moi ce concept comme à un débutant.", delayMs: 0 },
          { type: "click", selector: "#savePrompt", delayMs: 20 },
        ],
      },
    },

    // Message d'erreur dans le fil : session Claude expirée (auth-required).
    "error-auth": {
      status: "connected",
      tab: ARTICLE_TAB,
      extraction: { context: extractionContextFor(ARTICLE_TAB, "page") },
      faviconUrl: FAVICON,
      storageLocal: {
        "coati:conversation": [
          { id: "e1-u", role: "user", text: "Résumer cet article : Une mesure publiée le 25 septembre" },
          { id: "e1", role: "assistant", text: "⚠ La session Claude a expiré.", authRequired: true, streaming: false },
        ],
        "coati:attachPage": true,
      },
      prompts: [],
    },

    // auth-required d'un fournisseur à clé
    //  « [Fournisseur] refuse la clé » (nommé quand connu),
    // « Ouvrir les réglages » (profond vers la carte du fournisseur) et
    // « Créer une clé chez [Fournisseur] » (lien externe keysUrl). Fournisseur
    // claude-api ici : getProviderLinks résout par id (pas besoin de baseUrl).
    "error-auth-key": {
      status: "connected",
      tab: ARTICLE_TAB,
      extraction: { context: extractionContextFor(ARTICLE_TAB, "page") },
      faviconUrl: FAVICON,
      providerStatus: { provider: "claude-api", state: "ok", reason: "ready" },
      storageLocal: {
        "coati:conversation": [
          { id: "ek-u", role: "user", text: "Résumer cet article : Une mesure publiée le 25 septembre" },
          {
            id: "ek",
            role: "assistant",
            text: "⚠ Claude (Anthropic) refuse la clé. Vérifiez-la dans les réglages.",
            authRequired: true,
            authKind: "key",
            streaming: false,
          },
        ],
        "coati:attachPage": true,
      },
      prompts: [],
    },

    // auth-required arrivé avant toute réponse provider.status : texte qui
    // nomme les deux remèdes, bouton « Ouvrir les réglages ».
    "error-auth-unknown": {
      status: "connected",
      tab: ARTICLE_TAB,
      extraction: { context: extractionContextFor(ARTICLE_TAB, "page") },
      faviconUrl: FAVICON,
      storageLocal: {
        "coati:conversation": [
          { id: "eu-u", role: "user", text: "Résumer cet article : Une mesure publiée le 25 septembre" },
          {
            id: "eu",
            role: "assistant",
            text: "⚠ Le fournisseur a refusé l'accès (session expirée ou clé refusée) : vérifiez les réglages.",
            authRequired: true,
            authKind: "unknown",
            streaming: false,
          },
        ],
        "coati:attachPage": true,
      },
      prompts: [],
    },

    // Message d'erreur dans le fil : le modèle ne répond pas.
    "error-model": {
      status: "connected",
      tab: ARTICLE_TAB,
      extraction: { context: extractionContextFor(ARTICLE_TAB, "page") },
      faviconUrl: FAVICON,
      storageLocal: {
        "coati:conversation": [
          { id: "e2-u", role: "user", text: "Résumer cet article : Une mesure publiée le 25 septembre" },
          {
            id: "e2",
            role: "assistant",
            // Exact copy of panel_error_model_unavailable (_locales/fr) — the
            // The UI never says "broker": it says "programme local".
            text: "⚠ Le modèle ne répond pas (indisponible). Le programme local fonctionne normalement ; c'est le modèle qui pose problème. Réessayez dans un instant.",
            // Now carries a "Connecter un modèle" action (tutorial) —
            // this banner had none before.
            modelUnavailable: true,
            streaming: false,
          },
        ],
        "coati:attachPage": true,
      },
      prompts: [],
    },

    // Quota-exceeded : « Recharger
    // chez Claude (Anthropic) » (lien externe billingUrl) + « Réessayer »
    // (l'utilisateur peut avoir rechargé entre temps). Fournisseur claude-api :
    // getProviderLinks résout par id. Round-trip live via chatErrorReply pour
    // que pendingRetries soit peuplé et le bouton Réessayer visible.
    "error-quota": {
      status: "connected",
      tab: ARTICLE_TAB,
      extraction: { context: extractionContextFor(ARTICLE_TAB, "page") },
      faviconUrl: FAVICON,
      providerStatus: { provider: "claude-api", state: "ok", reason: "ready" },
      chatErrorReply: {
        code: "quota-exceeded",
        message: "Votre compte chez le fournisseur n'a plus de crédit. Rechargez-le sur son site, ou choisissez un modèle gratuit dans les réglages.",
      },
      storageLocal: {
        "coati:conversation": [
          { id: "eq-u", role: "user", text: "Résumer cet article : Une mesure publiée le 25 septembre" },
        ],
        "coati:attachPage": true,
      },
      prompts: [],
      autoAction: {
        steps: [
          { type: "fill", selector: "#input", value: "Résumer cet article : Une mesure publiée le 25 septembre", delayMs: 0 },
          { type: "click", selector: "#send", delayMs: 20 },
        ],
      },
    },

    // Trop de requêtes chez le fournisseur (rate-limited),
    // avec un retryAfterSec connu : bouton « Réessayer » désactivé, décompte
    // en texte brut (sûr avec "réduire les animations"). Round-trip live via chatErrorReply pour
    // que pendingRetries soit peuplé et le bouton Réessayer visible.
    "error-rate-limited": {
      status: "connected",
      tab: ARTICLE_TAB,
      extraction: { context: extractionContextFor(ARTICLE_TAB, "page") },
      faviconUrl: FAVICON,
      providerStatus: { provider: "openai-compat", state: "ok", reason: "ready" },
      chatErrorReply: {
        code: "rate-limited",
        retryAfterSec: 20,
        message: "Le fournisseur reçoit trop de requêtes en ce moment. Patientez un instant puis réessayez.",
      },
      storageLocal: {
        "coati:conversation": [
          { id: "er-u", role: "user", text: "Résumer cet article : Une mesure publiée le 25 septembre" },
        ],
        "coati:attachPage": true,
      },
      prompts: [],
      autoAction: {
        steps: [
          { type: "fill", selector: "#input", value: "Résumer cet article : Une mesure publiée le 25 septembre", delayMs: 0 },
          { type: "click", selector: "#send", delayMs: 20 },
        ],
      },
    },

    // Provider-overloaded : le
    // fournisseur lui-même est surchargé (transient, pas de réglage à changer).
    // Bloc de récupération : « Réessayer » seulement (buildProviderOverload-
    // RecoveryBlock). Round-trip live via chatErrorReply.
    "error-provider-overloaded": {
      status: "connected",
      tab: ARTICLE_TAB,
      extraction: { context: extractionContextFor(ARTICLE_TAB, "page") },
      faviconUrl: FAVICON,
      providerStatus: { provider: "claude-api", state: "ok", reason: "ready" },
      chatErrorReply: {
        code: "provider-overloaded",
        message: "Le fournisseur est surchargé en ce moment. Patientez un instant puis réessayez.",
      },
      storageLocal: {
        "coati:conversation": [
          { id: "epo-u", role: "user", text: "Résumer cet article : Une mesure publiée le 25 septembre" },
        ],
        "coati:attachPage": true,
      },
      prompts: [],
      autoAction: {
        steps: [
          { type: "fill", selector: "#input", value: "Résumer cet article : Une mesure publiée le 25 septembre", delayMs: 0 },
          { type: "click", selector: "#send", delayMs: 20 },
        ],
      },
    },

    // Model-missing (fournisseur
    // distant, non-Ollama) : ce modèle précis n'est pas disponible sur le
    // compte. Bloc : « Ouvrir les réglages » (profond vers la carte). Pas de
    // Réessayer (le payload n'est pas conservé — changer de modèle d'abord).
    "error-model-missing": {
      status: "connected",
      tab: ARTICLE_TAB,
      extraction: { context: extractionContextFor(ARTICLE_TAB, "page") },
      faviconUrl: FAVICON,
      providerStatus: { provider: "claude-api", state: "ok", reason: "ready" },
      storageLocal: {
        "coati:conversation": [
          { id: "emm-u", role: "user", text: "Résumer cet article : Une mesure publiée le 25 septembre" },
          {
            id: "emm",
            role: "assistant",
            text: "⚠ Ce modèle n'est pas disponible sur votre compte. Choisissez-en un autre dans les réglages.",
            modelMissing: true,
            streaming: false,
          },
        ],
        "coati:attachPage": true,
      },
      prompts: [],
    },

    // Model missing on Ollama: settings button, no Retry.
    "error-ollama-model-absent": {
      status: "connected",
      tab: ARTICLE_TAB,
      extraction: { context: extractionContextFor(ARTICLE_TAB, "page") },
      faviconUrl: FAVICON,
      providerStatus: { provider: "ollama", state: "ok", reason: "ready" },
      storageLocal: {
        "coati:conversation": [
          { id: "eom-u", role: "user", text: "Résumer cet article : Une mesure publiée le 25 septembre" },
          {
            id: "eom",
            role: "assistant",
            text: "⚠ Ce modèle n'est pas installé dans Ollama. Installez-le avec la commande ci-dessous.",
            modelMissing: true,
            streaming: false,
          },
        ],
        "coati:attachPage": true,
      },
      prompts: [],
    },

    // Model-unavailable : diagnostic
    // incertain (modèle injoignable ou timeout 120 s du broker). Bloc :
    // « Réessayer » + « Ouvrir les réglages » (profond). Round-trip live.
    "error-model-unavailable": {
      status: "connected",
      tab: ARTICLE_TAB,
      extraction: { context: extractionContextFor(ARTICLE_TAB, "page") },
      faviconUrl: FAVICON,
      providerStatus: { provider: "claude-api", state: "ok", reason: "ready" },
      chatErrorReply: {
        code: "model-unavailable",
        message: "Le modèle n'a pas répondu (indisponible). Le programme local fonctionne normalement ; c'est le modèle qui pose problème. Réessayez dans un instant.",
      },
      storageLocal: {
        "coati:conversation": [
          { id: "emu-u", role: "user", text: "Résumer cet article : Une mesure publiée le 25 septembre" },
        ],
        "coati:attachPage": true,
      },
      prompts: [],
      autoAction: {
        steps: [
          { type: "fill", selector: "#input", value: "Résumer cet article : Une mesure publiée le 25 septembre", delayMs: 0 },
          { type: "click", selector: "#send", delayMs: 20 },
        ],
      },
    },

    // Auth-required sur claude-cli :
    // session expirée. Bloc : commande copiable « claude auth login --claudeai »
    // + « Ouvrir les réglages » + « Réessayer » (même chemin que l'auth session
    // normale — SESSION_AUTH_PROVIDERS contient "claude-cli").
    "error-claude-session": {
      status: "connected",
      tab: ARTICLE_TAB,
      extraction: { context: extractionContextFor(ARTICLE_TAB, "page") },
      faviconUrl: FAVICON,
      providerStatus: { provider: "claude-cli", state: "ok", reason: "ready" },
      storageLocal: {
        "coati:conversation": [
          { id: "ecs-u", role: "user", text: "Résumer cet article : Une mesure publiée le 25 septembre" },
          {
            id: "ecs",
            role: "assistant",
            text: "⚠ La session Claude a expiré. Reconnectez-vous avec la commande ci-dessous.",
            authRequired: true,
            authKind: "session",
            streaming: false,
          },
        ],
        "coati:attachPage": true,
      },
      prompts: [],
    },

    // T51 — premier lancement, Ollama installé mais pas
    // démarré : commande copiable « ollama serve » sous l'étape « modèle ».
    "first-run-ollama-not-running": {
      firstRun: true,
      faviconUrl: FAVICON,
      prompts: [],
      storageLocal: { "coati:conversation": [], "coati:attachPage": null },
      status: "connected",
      providerStatus: { provider: "ollama", state: "ko", reason: "ollama-unreachable" },
      tab: HIDDEN_TAB,
      extraction: { error: "no-access", origin: "https://exemple-actu.fr" },
      tabAfterGrant: ARTICLE_TAB,
      extractionAfterGrant: { context: extractionContextFor(ARTICLE_TAB, "page") },
      permissions: [],
    },

    // Programme local introuvable : bandeau de connexion
    // avec lien d'installation ET bouton « Réessayer » ("no-host" repris
    // sous un nom explicite pour ce lot).
    "program-missing": {
      status: "no-host",
      tab: null,
      faviconUrl: FAVICON,
      storageLocal: { "coati:conversation": [], "coati:attachPage": null },
      prompts: [],
    },

    // Extrême : nom de site (hôte) de 60 caractères, réponse ~2500 mots, URL
    // longue et non coupée dans le texte du message.
    // Note (déviation documentée) : les données réelles de
    // extension/lib/suggestions-data.js plafonnent à 3 suggestions par site —
    // ni "4" ni "8" n'existent dans le code sans le modifier (contrainte 1),
    // ce fixture montre donc les 3 suggestions génériques réelles.
    extreme: {
      status: "connected",
      tab: LONG_HOST_TAB,
      extraction: { context: extractionContextFor(LONG_HOST_TAB, "page") },
      faviconUrl: FAVICON,
      storageLocal: {
        "coati:conversation": [
          { id: "x1-u", role: "user", text: "Résumer cette page : Un article sur un domaine à nom délibérément très long" },
          { id: "x1", role: "assistant", text: EXTREME_ANSWER, streaming: false },
        ],
        "coati:attachPage": true,
      },
      prompts: [],
    },

    // Site reconnu (entrée de suggestions-data.js) mais liste vide : l'encart
    // garde son en-tête et le seul bouton « Résumer cet article ».
    "site-no-suggestion": {
      status: "connected",
      tab: RECOGNISED_NO_SUGGESTION_TAB,
      extraction: { context: extractionContextFor(RECOGNISED_NO_SUGGESTION_TAB, "page") },
      faviconUrl: FAVICON,
      storageLocal: { "coati:conversation": [], "coati:attachPage": true },
      prompts: [],
    },

    // Site inconnu mais adresse lisible : favicon affichée quand même (Lot
    // 1), nom d'hôte à la place du nom de site, jeu générique. État requis :
    // site inconnu avec favicon.
    "site-unknown": {
      status: "connected",
      tab: ARTICLE_TAB,
      extraction: { context: extractionContextFor(ARTICLE_TAB, "page") },
      faviconUrl: FAVICON,
      storageLocal: { "coati:conversation": [], "coati:attachPage": true },
      prompts: [],
    },

    // Site connu, interrupteur "Lire la page" décoché par l'utilisateur (état
    // requis : interrupteur coupé, page par ailleurs lisible).
    "switch-off": {
      status: "connected",
      tab: YOUTUBE_TAB,
      extraction: { context: extractionContextFor(YOUTUBE_TAB, "youtube") },
      faviconUrl: FAVICON,
      storageLocal: { "coati:conversation": [], "coati:attachPage": false },
      prompts: [],
    },

    // Saisie de plus de 4 lignes : la zone plafonne à 4 lignes, barre de
    // défilement visible.
    "composer-long": {
      status: "connected",
      tab: YOUTUBE_TAB,
      extraction: { context: extractionContextFor(YOUTUBE_TAB, "youtube") },
      faviconUrl: FAVICON,
      storageLocal: {
        "coati:conversation": [
          { id: "c1-u", role: "user", text: "Peux-tu résumer cette vidéo ?" },
          { id: "c1", role: "assistant", text: CONVERSATION_ANSWER, streaming: false },
        ],
        "coati:attachPage": true,
      },
      prompts: [],
      autoAction: { steps: [{ type: "fill", selector: "#input", value: LONG_COMPOSER_TEXT, delayMs: 20 }] },
    },

    // Plus de liste déroulante par-dessus le fil —
    // cet état garde son intention (beaucoup de prompts enregistrés, encart
    // qui défile) mais via l'encart lui-même, ici sur un site inconnu
    // (10 prompts "Tous les sites"), une conversation déjà ouverte dessous.
    "prompts-overlay": {
      status: "connected",
      tab: ARTICLE_TAB,
      extraction: { context: extractionContextFor(ARTICLE_TAB, "page") },
      faviconUrl: FAVICON,
      storageLocal: {
        "coati:conversation": [
          { id: "p1-u", role: "user", text: "Peux-tu résumer cet article ?\n\n*avec le contenu de la page*" },
          { id: "p1", role: "assistant", text: CONVERSATION_ANSWER, streaming: false },
        ],
        "coati:attachPage": true,
      },
      prompts: STAR_PROMPTS_10,
    },

    // --- New states (panel half) --------

    // YouTube : suggestion Coati + 1 prompt utilisateur du site, réordonné
    // avant elle via prefs.sites (order mêle coati:… et p_…).
    "youtube-mixed": {
      status: "connected",
      tab: YOUTUBE_TAB,
      extraction: { context: extractionContextFor(YOUTUBE_TAB, "youtube") },
      faviconUrl: FAVICON,
      storageLocal: { "coati:conversation": [], "coati:attachPage": true },
      prompts: [YOUTUBE_MIXED_USER_PROMPT],
      prefs: {
        sites: {
          "@youtube": {
            order: [
              YOUTUBE_MIXED_USER_PROMPT.id,
              "coati:youtube:summarize",
            ],
          },
        },
      },
    },

    // Site inconnu, rien enregistré nulle part : l'encart ne montre que
    // l'en-tête et "Mes prompts ↗" (favicon quand même affichée).
    "unknown-empty": {
      status: "connected",
      tab: POMOFOCUS_TAB,
      extraction: { context: extractionContextFor(POMOFOCUS_TAB, "page") },
      faviconUrl: FAVICON,
      storageLocal: { "coati:conversation": [], "coati:attachPage": true },
      prompts: [],
    },

    // Site de l'utilisateur (crisco4.unicaen.fr, sans correspondance Coati) :
    // 2 prompts du site + 1 prompt "Tous les sites".
    "crisco-prompts": {
      status: "connected",
      tab: CRISCO_TAB,
      extraction: { context: extractionContextFor(CRISCO_TAB, "page") },
      faviconUrl: FAVICON,
      storageLocal: { "coati:conversation": [], "coati:attachPage": true },
      prompts: [
        sitePrompt("crisco4.unicaen.fr", "Synonymes soutenus", "Donne des synonymes plus soutenus pour le mot cherché."),
        sitePrompt("crisco4.unicaen.fr", "Registre familier", "Donne des synonymes de registre familier pour le mot cherché."),
        starPrompt("Résumer en 3 phrases", "Réduis ce texte à trois phrases, sans perdre l'idée centrale."),
      ],
    },

    // Un prompt sans titre : le bouton montre le début du corps, coupé par
    // "…" (encart-items.js's truncateLabel), à côté des suggestions Coati.
    "untitled-prompt": {
      status: "connected",
      tab: YOUTUBE_TAB,
      extraction: { context: extractionContextFor(YOUTUBE_TAB, "youtube") },
      faviconUrl: FAVICON,
      storageLocal: { "coati:conversation": [], "coati:attachPage": true },
      prompts: [
        sitePrompt(
          "@youtube",
          undefined,
          "Explique ce que dit la vidéo comme si je n'y connaissais absolument rien, avec des exemples simples.",
        ),
      ],
    },

    // Assez de prompts pour dépasser trois lignes de boutons : l'encart
    // défile (max-height + overflow-y, card.css).
    "encart-scroll": {
      status: "connected",
      tab: YOUTUBE_TAB,
      extraction: { context: extractionContextFor(YOUTUBE_TAB, "youtube") },
      faviconUrl: FAVICON,
      storageLocal: { "coati:conversation": [], "coati:attachPage": true },
      prompts: [
        sitePrompt("@youtube", "Chapitres", "Découpe la vidéo en chapitres."),
        sitePrompt("@youtube", "Citations", "Relève les citations marquantes."),
        sitePrompt("@youtube", "Public visé", "Décris le public visé par la vidéo."),
        sitePrompt("@youtube", "Ton", "Décris le ton de la vidéo."),
        sitePrompt("@youtube", "Sources citées", "Liste les sources citées dans la vidéo."),
        sitePrompt("@youtube", "Angle critique", "Donne un angle critique sur le propos de la vidéo."),
      ],
    },

    // Deux messages utilisateur dans le fil, chacun avec son bouton
    // "Relancer" sous la bulle ; le second est amené au clavier (focus
    // scripté — voir lab-runtime.js's "focus" step et card.css/panel.css:
    // la visibilité du bouton suit :focus, pas seulement :focus-visible,
    // pour rester démontrable ici).
    relancer: {
      status: "connected",
      tab: ARTICLE_TAB,
      extraction: { context: extractionContextFor(ARTICLE_TAB, "page") },
      faviconUrl: FAVICON,
      storageLocal: {
        "coati:conversation": [
          {
            id: "r1-u",
            role: "user",
            text: "Peux-tu résumer cet article ?\n\n*avec le contenu de la page*",
            relaunch: { type: "chat", text: "Peux-tu résumer cet article ?" },
          },
          { id: "r1", role: "assistant", text: CONVERSATION_ANSWER, streaming: false },
          {
            id: "r2-u",
            role: "user",
            text: "Et en trois phrases ?\n\n*avec le contenu de la page*",
            relaunch: { type: "chat", text: "Et en trois phrases ?" },
          },
          { id: "r2", role: "assistant", text: "Trois phrases : contexte, méthode, source.", streaming: false },
        ],
        "coati:attachPage": true,
      },
      prompts: [],
      autoAction: { steps: [{ type: "focus", selector: "#msg-r2-u .message-relaunch", delayMs: 20 }] },
    },
    // T50 — page inaccessible, adresse inconnue : bouton « Lire cette page », anneau qui respire (figé ici; ?motion=live pour le voir bouger). Un clic accorde « tous les sites » et lit la page.
    "read-invite": {
      status: "connected",
      faviconUrl: FAVICON,
      prompts: [],
      tab: HIDDEN_TAB,
      extraction: { error: "no-access", origin: "https://exemple-actu.fr" },
      tabAfterGrant: ARTICLE_TAB,
      extractionAfterGrant: { context: extractionContextFor(ARTICLE_TAB, "page") },
      permissions: [],
      storageLocal: { "coati:conversation": [], "coati:attachPage": null },
    },

    // T50 — premier lancement, Wikipédia lue par le geste de l'icône (activeTab) sans accès durable : l'invitation reste (dernière étape de la carte), favicon du site dans l'anneau, nom du site à côté.
    "read-invite-known": {
      firstRun: true,
      providerStatus: PROVIDER_OK,
      status: "connected",
      faviconUrl: FAVICON,
      prompts: [],
      tab: WIKIPEDIA_TAB,
      extraction: { context: extractionContextFor(WIKIPEDIA_TAB, "page") },
      permissions: [],
      storageLocal: { "coati:conversation": [], "coati:attachPage": null },
    },

    // T50 — bouton déjà utilisé une fois (coati:readButtonUsed), accès retiré depuis : même bouton, sans halo.
    "read-calm": {
      status: "connected",
      faviconUrl: FAVICON,
      prompts: [],
      tab: HIDDEN_TAB,
      extraction: { error: "no-access", origin: "https://exemple-actu.fr" },
      permissions: [],
      storageLocal: { "coati:conversation": [], "coati:attachPage": null, "coati:readButtonUsed": true },
    },

    // T50 — clic accepté, lecture en cours : l'anneau s'ouvre en arc et tourne, « Lecture… », aria-busy.
    "read-reading": {
      status: "connected",
      faviconUrl: FAVICON,
      prompts: [],
      tab: HIDDEN_TAB,
      extraction: { error: "no-access", origin: "https://exemple-actu.fr" },
      tabAfterGrant: ARTICLE_TAB,
      extractionAfterGrant: { pending: true },
      permissions: [],
      storageLocal: { "coati:conversation": [], "coati:attachPage": null },
      autoAction: { steps: [{ type: "click", selector: "#readPage", delayMs: 50 }] },
    },

    // T50 — « tous les sites » refusé, adresse inconnue : pas d'animation, ligne d'explication, le bouton peut redemander.
    "read-refused": {
      status: "connected",
      faviconUrl: FAVICON,
      prompts: [],
      tab: HIDDEN_TAB,
      extraction: { error: "no-access", origin: "https://exemple-actu.fr" },
      permissions: [],
      permissionRequestResult: false,
      storageLocal: { "coati:conversation": [], "coati:attachPage": null },
      autoAction: { steps: [{ type: "click", selector: "#readPage", delayMs: 50 }] },
    },

    // T50 — refus déjà enregistré, adresse connue : repli sur l'activation site par site, « Activer ce site ».
    "read-refused-site": {
      status: "connected",
      faviconUrl: FAVICON,
      prompts: [],
      tab: WIKIPEDIA_TAB,
      extraction: { context: extractionContextFor(WIKIPEDIA_TAB, "page") },
      permissions: [],
      storageLocal: { "coati:conversation": [], "coati:attachPage": null, "coati:allSitesDeclined": true },
    },

    // T50 — « tous les sites » accordé : plus de bouton, l'encart montre le site et ses suggestions.
    "read-granted": {
      status: "connected",
      faviconUrl: FAVICON,
      prompts: [],
      tab: ARTICLE_TAB,
      extraction: { context: extractionContextFor(ARTICLE_TAB, "page") },
      permissions: ALL_SITES,
      storageLocal: { "coati:conversation": [], "coati:attachPage": null, "coati:readButtonUsed": true },
    },

    // T51 — premier lancement, programme local introuvable (no-host) : ✗ programme (lien releases), modèle en attente, ✗ page.
    "first-run-no-program": {
      firstRun: true,
      faviconUrl: FAVICON,
      prompts: [],
      storageLocal: { "coati:conversation": [], "coati:attachPage": null },
      status: "no-host",
      tab: HIDDEN_TAB,
      extraction: { error: "no-access", origin: "https://exemple-actu.fr" },
      tabAfterGrant: ARTICLE_TAB,
      extractionAfterGrant: { context: extractionContextFor(ARTICLE_TAB, "page") },
      permissions: [],
    },

    // T51 — premier lancement, connexion en cours : programme et modèle « … », ✗ page.
    "first-run-searching": {
      firstRun: true,
      faviconUrl: FAVICON,
      prompts: [],
      storageLocal: { "coati:conversation": [], "coati:attachPage": null },
      status: "connecting",
      tab: HIDDEN_TAB,
      extraction: { error: "no-access", origin: "https://exemple-actu.fr" },
      tabAfterGrant: ARTICLE_TAB,
      extractionAfterGrant: { context: extractionContextFor(ARTICLE_TAB, "page") },
      permissions: [],
    },

    // T51 — programme détecté, provider.status pas encore revenu : ✓, …, ✗.
    "first-run-model-pending": {
      firstRun: true,
      faviconUrl: FAVICON,
      prompts: [],
      storageLocal: { "coati:conversation": [], "coati:attachPage": null },
      status: "connected",
      tab: HIDDEN_TAB,
      extraction: { error: "no-access", origin: "https://exemple-actu.fr" },
      tabAfterGrant: ARTICLE_TAB,
      extractionAfterGrant: { context: extractionContextFor(ARTICLE_TAB, "page") },
      permissions: [],
    },

    // T51 — programme détecté, modèle KO (aucune clé) : ✓, ✗ (Ouvrir les réglages), ✗.
    "first-run-model-missing": {
      firstRun: true,
      faviconUrl: FAVICON,
      prompts: [],
      storageLocal: { "coati:conversation": [], "coati:attachPage": null },
      status: "connected",
      providerStatus: PROVIDER_KO,
      tab: HIDDEN_TAB,
      extraction: { error: "no-access", origin: "https://exemple-actu.fr" },
      tabAfterGrant: ARTICLE_TAB,
      extractionAfterGrant: { context: extractionContextFor(ARTICLE_TAB, "page") },
      permissions: [],
    },

    // T51 — dernière étape : ✓, ✓, ✗ page — la carte désigne le bouton de l'encart (« Montrer le bouton »), rien ne part tout seul.
    "first-run-page-missing": {
      firstRun: true,
      faviconUrl: FAVICON,
      prompts: [],
      storageLocal: { "coati:conversation": [], "coati:attachPage": null },
      status: "connected",
      providerStatus: PROVIDER_OK,
      tab: HIDDEN_TAB,
      extraction: { error: "no-access", origin: "https://exemple-actu.fr" },
      tabAfterGrant: ARTICLE_TAB,
      extractionAfterGrant: { context: extractionContextFor(ARTICLE_TAB, "page") },
      permissions: [],
    },

    // T51 — « Montrer le bouton » cliqué : focus et contour sur le bouton de l'encart.
    "first-run-pointed": {
      firstRun: true,
      faviconUrl: FAVICON,
      prompts: [],
      storageLocal: { "coati:conversation": [], "coati:attachPage": null },
      status: "connected",
      providerStatus: PROVIDER_OK,
      tab: HIDDEN_TAB,
      extraction: { error: "no-access", origin: "https://exemple-actu.fr" },
      tabAfterGrant: ARTICLE_TAB,
      extractionAfterGrant: { context: extractionContextFor(ARTICLE_TAB, "page") },
      permissions: [],
      autoAction: { steps: [{ type: "click", selector: ".first-run-step[data-check=\"page\"] .first-run-action", delayMs: 100 }] },
    },

    // T51 — accès déjà accordé mais modèle KO : ✓, ✗, ✓.
    "first-run-model-missing-page-ok": {
      firstRun: true,
      faviconUrl: FAVICON,
      prompts: [],
      storageLocal: { "coati:conversation": [], "coati:attachPage": null },
      status: "connected",
      providerStatus: PROVIDER_KO,
      tab: ARTICLE_TAB,
      extraction: { context: extractionContextFor(ARTICLE_TAB, "page") },
      permissions: ALL_SITES,
    },

    // T51 — accès accordé, programme introuvable : ✗, …, ✓.
    "first-run-no-program-page-ok": {
      firstRun: true,
      faviconUrl: FAVICON,
      prompts: [],
      storageLocal: { "coati:conversation": [], "coati:attachPage": null },
      status: "no-host",
      tab: ARTICLE_TAB,
      extraction: { context: extractionContextFor(ARTICLE_TAB, "page") },
      permissions: ALL_SITES,
    },

    // T51 — ✓, ✓, puis clic sur « Lire cette page » : accès accordé, page lue, carte masquée pour de bon (coati:firstRunDone).
    "first-run-last-click": {
      firstRun: true,
      faviconUrl: FAVICON,
      prompts: [],
      storageLocal: { "coati:conversation": [], "coati:attachPage": null },
      status: "connected",
      providerStatus: PROVIDER_OK,
      tab: HIDDEN_TAB,
      extraction: { error: "no-access", origin: "https://exemple-actu.fr" },
      tabAfterGrant: ARTICLE_TAB,
      extractionAfterGrant: { context: extractionContextFor(ARTICLE_TAB, "page") },
      permissions: [],
      autoAction: { steps: [{ type: "click", selector: "#readPage", delayMs: 100 }] },
    },

    // T51 — les trois coches déjà réunies à l'ouverture : pas de carte.
    "first-run-all-met": {
      firstRun: true,
      faviconUrl: FAVICON,
      prompts: [],
      storageLocal: { "coati:conversation": [], "coati:attachPage": null },
      status: "connected",
      providerStatus: PROVIDER_OK,
      tab: ARTICLE_TAB,
      extraction: { context: extractionContextFor(ARTICLE_TAB, "page") },
      permissions: ALL_SITES,
    },

    // La carte des premiers pas est déjà passée (firstRunDone),
    // mais aucune réponse réelle n'a jamais été reçue (coati:modelEverAnswered
    // absent avant ce goal, ici explicitement false) : l'avis autonome
    // s'affiche seul, avec son bouton « Connecter un modèle ».
    "never-connected-notice": {
      status: "connected",
      tab: ARTICLE_TAB,
      extraction: { context: extractionContextFor(ARTICLE_TAB, "page") },
      faviconUrl: FAVICON,
      storageLocal: {
        "coati:conversation": [],
        "coati:attachPage": true,
        "coati:modelEverAnswered": false,
      },
      prompts: [],
    },

    // La carte des premiers pas est encore visible (étape modèle
    // manquante) : l'avis autonome reste masqué, l'action « Connecter un
    // modèle » vit dans l'étape « model » de la carte elle-même (pas
    // d'empilement de deux avis).
    "never-connected-inside-first-run": {
      firstRun: true,
      faviconUrl: FAVICON,
      prompts: [],
      storageLocal: {
        "coati:conversation": [],
        "coati:attachPage": null,
        "coati:modelEverAnswered": false,
      },
      status: "connected",
      providerStatus: { provider: "ollama", state: "ko", reason: "ollama-unreachable" },
      tab: ARTICLE_TAB,
      extraction: { context: extractionContextFor(ARTICLE_TAB, "page") },
      permissions: ALL_SITES,
    },

    // Le drapeau est déjà posé (une vraie réponse a déjà été
    // reçue) : ni carte des premiers pas, ni avis autonome.
    "model-ever-answered": {
      status: "connected",
      tab: ARTICLE_TAB,
      extraction: { context: extractionContextFor(ARTICLE_TAB, "page") },
      faviconUrl: FAVICON,
      providerStatus: PROVIDER_OK,
      storageLocal: {
        "coati:conversation": [
          { id: "ma-u", role: "user", text: "Résumer cet article : Une mesure publiée le 25 septembre" },
          { id: "ma", role: "assistant", text: CONVERSATION_ANSWER, streaming: false },
        ],
        "coati:attachPage": true,
        "coati:modelEverAnswered": true,
      },
      prompts: [],
    },

    // Bouton « ? » du bandeau, popover ouvert (hover/focus) : texte
    // d'aide, image de fond discrète (tête existante, place de la future
    // illustration coati surpris/indécis).
    "tour-normal-step-1": tourState(false, 0),
    "tour-normal-step-2": tourState(false, 1),
    "tour-normal-step-3": tourState(false, 2),
    "tour-normal-step-4": tourState(false, 3),
    "tour-normal-step-5": tourState(false, 4),
    "tour-dev-step-1": tourState(true, 0),
    "tour-dev-step-2": tourState(true, 1),
    "tour-dev-step-3": tourState(true, 2),

    // "Montrer : …" buttons in
    // an assistant answer. `elementsSnapshot` is hand-authored directly on
    // the stored message, same convention this file already uses for
    // other runtime-only flags (authRequired, modelMissing…) that are
    // normally computed live: it's the exact shape renderMessage()/
    // renderElementRefs() (real, unmodified panel.js code) already know how
    // to read, see element-refs.js.
    "answer-with-point-buttons": {
      status: "connected",
      tab: ARTICLE_TAB,
      extraction: { context: extractionContextFor(ARTICLE_TAB, "page") },
      faviconUrl: FAVICON,
      features: ["elements"],
      storageLocal: {
        "coati:conversation": [
          { id: "pt-u", role: "user", text: "Comment je lance la génération ?\n\n*avec le contenu de la page*" },
          {
            id: "pt1",
            role: "assistant",
            text: "Cliquez sur [[e1]] pour lancer la génération, ou sur [[e2]] pour en savoir plus avant.",
            streaming: false,
            elementsSnapshot: {
              extractionId: "lab-x1",
              elements: [
                { ref: "e1", role: "button", label: "Générer" },
                { ref: "e2", role: "link", label: "En savoir plus" },
              ],
            },
          },
        ],
        "coati:attachPage": true,
      },
      prompts: [],
    },

    // README screenshot (English content, captured with lang=en).
    readme: {
      status: "connected",
      tab: ARTICLE_TAB,
      extraction: { context: extractionContextFor(ARTICLE_TAB, "page") },
      faviconUrl: FAVICON,
      features: ["elements"],
      storageLocal: {
        "coati:conversation": [
          { id: "rd-u", role: "user", text: "How do I download my data from this site?" },
          {
            id: "rd-a",
            role: "assistant",
            text:
              "Two steps:\n\n1. Open your account: [[e1]]\n2. In the privacy section, use [[e2]]. The archive arrives by email within a few minutes.\n\nThe page does not mention any fee.",
            streaming: false,
            pageOnDemand: true,
            pageMention: "Read the page · 3.2 k tokens",
            elementsSnapshot: {
              extractionId: "lab-rd",
              elements: [
                { ref: "e1", role: "link", label: "My account" },
                { ref: "e2", role: "button", label: "Export my data" },
              ],
            },
          },
        ],
        "coati:attachPage": true,
      },
      prompts: [],
    },

    // "Joindre l'écran", switch ON (clicked once at load) + the
    // "reste sur cet ordinateur" destination line (current model local).
    "attach-screen-on": {
      status: "connected",
      tab: ARTICLE_TAB,
      extraction: { context: extractionContextFor(ARTICLE_TAB, "page") },
      faviconUrl: FAVICON,
      features: ["vision"],
      models: MODELS_LOCAL_AND_ONLINE,
      storageLocal: { "coati:conversation": [], "coati:attachPage": false },
      prompts: [],
      autoAction: { steps: [{ type: "click", selector: "#attachScreen", delayMs: 20 }] },
    },

    // "Joindre l'écran", current model known NOT to see images:
    // switch greyed, destination line replaced by the remedy text.
    "attach-screen-no-vision": {
      status: "connected",
      tab: ARTICLE_TAB,
      extraction: { context: extractionContextFor(ARTICLE_TAB, "page") },
      faviconUrl: FAVICON,
      features: ["vision"],
      models: {
        current: { provider: "ollama", model: "llama3.2:latest" },
        entries: [{ provider: "ollama", model: "llama3.2:latest", local: true, vision: false }],
        sources: [{ provider: "ollama", state: "ok" }],
      },
      storageLocal: { "coati:conversation": [], "coati:attachPage": false },
      prompts: [],
    },

    // Capture refused for lack of `activeTab` (B0 finding):
    // the system message captureScreenIfChecked() would show, hand-authored
    // directly (same convention as the auth-required/quota states above —
    // the LIVE failure path is a Chromium-only behavior, out of reach here).
    "attach-screen-need-gesture": {
      status: "connected",
      tab: ARTICLE_TAB,
      extraction: { context: extractionContextFor(ARTICLE_TAB, "page") },
      faviconUrl: FAVICON,
      features: ["vision"],
      models: MODELS_LOCAL_AND_ONLINE,
      storageLocal: {
        "coati:conversation": [
          {
            id: "sg-sys",
            role: "system",
            text: "Cliquez l'icône de Coati (ou son raccourci clavier) sur cet onglet pour autoriser la capture, puis renvoyez votre question.",
          },
        ],
        "coati:attachPage": false,
      },
      prompts: [],
    },

    // docs/PROTOCOL.md "Page on demand" — "Dev mode" switch, off, visible
    // (broker offers the "pageOnDemand" feature). Ground state for the
    // three states below.
    "dev-mode-off": {
      status: "connected",
      tab: ARTICLE_TAB,
      extraction: { context: extractionContextFor(ARTICLE_TAB, "page") },
      faviconUrl: FAVICON,
      features: ["pageOnDemand"],
      storageLocal: { "coati:conversation": [], "coati:devMode": false },
      prompts: [],
    },

    // Same ground state, switch on (already acknowledged once before —
    // coati:devModeAcknowledged true — so the click below doesn't reopen
    // the confirmation dialog).
    "dev-mode-on": {
      status: "connected",
      tab: ARTICLE_TAB,
      extraction: { context: extractionContextFor(ARTICLE_TAB, "page") },
      faviconUrl: FAVICON,
      features: ["pageOnDemand"],
      storageLocal: { "coati:conversation": [], "coati:devMode": true, "coati:devModeAcknowledged": true },
      prompts: [],
    },

    // First-ever activation: the risk/cost confirmation dialog (dev-
    // mode.js's confirmDevModeActivation()), reached the same way a user
    // reaches it — a scripted click on the still-off switch, no
    // coati:devModeAcknowledged preloaded.
    "dev-mode-confirm": {
      status: "connected",
      tab: ARTICLE_TAB,
      extraction: { context: extractionContextFor(ARTICLE_TAB, "page") },
      faviconUrl: FAVICON,
      features: ["pageOnDemand"],
      storageLocal: { "coati:conversation": [], "coati:devMode": false },
      prompts: [],
      autoAction: {
        steps: [{ type: "click", selector: "#devMode", delayMs: 60 }],
      },
    },

    // Transient status line while the metadata-path extraction is read back
    // ("Reading the page (~N k tokens)…", message-render.js) — a streaming
    // assistant message with no text yet and msg.pageReading set.
    "page-reading-status": {
      status: "connected",
      tab: ARTICLE_TAB,
      extraction: { context: extractionContextFor(ARTICLE_TAB, "page") },
      faviconUrl: FAVICON,
      features: ["pageOnDemand"],
      storageLocal: {
        "coati:conversation": [
          { id: "pr-u", role: "user", text: "Résumer cet article : Une mesure publiée le 25 septembre" },
          { id: "pr1", role: "assistant", text: "", streaming: true, pageReading: { kTokens: "3.2" } },
        ],
        "coati:devMode": false,
        "coati:devModeAcknowledged": true,
      },
      prompts: [],
    },

    // The three mention-line variants under a finished answer
    // (buildPageMention(), chat-stream.js) — read at text level, read at
    // dev level, and declined/not read.
    "page-mention-read-text": {
      status: "connected",
      tab: ARTICLE_TAB,
      extraction: { context: extractionContextFor(ARTICLE_TAB, "page") },
      faviconUrl: FAVICON,
      features: ["pageOnDemand"],
      storageLocal: {
        "coati:conversation": [
          { id: "pmt-u", role: "user", text: "Résumer cet article : Une mesure publiée le 25 septembre" },
          {
            id: "pmt1",
            role: "assistant",
            text: CONVERSATION_ANSWER,
            streaming: false,
            pageOnDemand: true,
            pageMention: "A lu la page · 3.2 k tokens",
          },
        ],
        "coati:devMode": false,
        "coati:devModeAcknowledged": true,
      },
      prompts: [],
    },

    "page-mention-read-dev": {
      status: "connected",
      tab: ARTICLE_TAB,
      extraction: { context: extractionContextFor(ARTICLE_TAB, "page") },
      faviconUrl: FAVICON,
      features: ["pageOnDemand"],
      storageLocal: {
        "coati:conversation": [
          { id: "pmd-u", role: "user", text: "Résumer cet article : Une mesure publiée le 25 septembre" },
          {
            id: "pmd1",
            role: "assistant",
            text: CONVERSATION_ANSWER,
            streaming: false,
            pageOnDemand: true,
            pageMention: "A lu le code de la page · 4.1 k tokens",
          },
        ],
        "coati:devMode": true,
        "coati:devModeAcknowledged": true,
      },
      prompts: [],
    },

    "page-mention-not-read": {
      status: "connected",
      tab: ARTICLE_TAB,
      extraction: { context: extractionContextFor(ARTICLE_TAB, "page") },
      faviconUrl: FAVICON,
      features: ["pageOnDemand"],
      storageLocal: {
        "coati:conversation": [
          { id: "pmn-u", role: "user", text: "Résumer cet article : Une mesure publiée le 25 septembre" },
          {
            id: "pmn1",
            role: "assistant",
            text: "Je n'ai pas eu besoin de relire la page pour répondre.",
            streaming: false,
            pageOnDemand: true,
            pageMention: "N'a pas lu la page · 0.4 k tokens",
          },
        ],
        "coati:devMode": false,
        "coati:devModeAcknowledged": true,
      },
      prompts: [],
    },
  };
})();
