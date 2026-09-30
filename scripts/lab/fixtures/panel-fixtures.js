// Coati state lab — panel.html fixtures.
//
// One entry per state id, consumed by static/browser-stub.js and
// static/lab-runtime.js. Pure data (+ two small text builders) — no chrome.*,
// no DOM. Copied verbatim into every generated tree by build-lab.ts.
//
// Deviations from the brief, and why, are recorded in the worker report, not
// here — this file only carries what a fixture can actually reach through
// the REAL panel.js/lib code (never modified, task constraint 1).
(function () {
  "use strict";

  function repeatParagraph(paragraph, timesWords, wordsPerRepeat) {
    var repeats = Math.ceil(timesWords / wordsPerRepeat);
    var out = [];
    for (var i = 0; i < repeats; i++) out.push(paragraph);
    return out.join(" ");
  }

  var EXTREME_PARAGRAPH =
    "Le broker reste local et n'expose jamais votre historique à un tiers, ce qui signifie que " +
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
  // <a> — CLAUDE.md rule #3).
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
  // New tabs/prompts (plan-mes-prompts-28-09.md, lot 5) — declared here, not
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

  // goal-8qVhz10H, lot 4/panel: the "Activer" link (T43) states — a popular
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

  // PromptEntry shape (docs/PROTOCOL.md "Bibliothèque de prompts et
  // préférences par site", amendement 2026-09-28): {id, site, title?, body}.
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

  // --- G5 (docs/DECISIONS.md T50/T51): "Lire cette page" button and the
  // first-launch card. A tab the panel can't see into: Chrome answers
  // tabs.query/get without `url` when no host permission covers it.
  var HIDDEN_TAB = { id: 508, title: undefined, url: undefined };
  var ALL_SITES = ["http://*/*", "https://*/*"];
  var PROVIDER_OK = { provider: "ollama", state: "ok", reason: "ready" };
  var PROVIDER_KO = { provider: "claude-api", state: "ko", reason: "no-key" };

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

    // Bandeau de connexion — "no-token" : id d'extension refusé par le
    // broker (allowedExtensionIds), même texte sur tous les navigateurs
    // depuis le G4 (Native Messaging) — plus de variante Firefox/Chromium.
    disconnected: {
      status: "no-token",
      tab: null,
      faviconUrl: FAVICON,
      storageLocal: { "coati:conversation": [], "coati:attachPage": null },
      prompts: [],
    },

    // Bandeau de connexion — "no-host" : programme natif introuvable (G4,
    // docs/PROTOCOL.md amendement 2026-09-30). Deux liens : doc d'install et
    // réglages (section Flatpak/Snap).
    "no-host": {
      status: "no-host",
      tab: null,
      faviconUrl: FAVICON,
      storageLocal: { "coati:conversation": [], "coati:attachPage": null },
      prompts: [],
    },

    // Bandeau de connexion — "broker-untrusted" : un programme répond sur le
    // port 8787 mais n'a pas prouvé être le broker Coati (preuve HMAC
    // fausse). Aucun lien : rien à faire depuis l'extension.
    "broker-untrusted": {
      status: "broker-untrusted",
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
    // gris neutre (Lot 1) ; interrupteur "Lire la page" grisé (Lot 2, état
    // requis : interrupteur désactivé).
    unreadable: {
      status: "connected",
      tab: null,
      faviconUrl: FAVICON,
      storageLocal: { "coati:conversation": [], "coati:attachPage": null },
      prompts: [],
    },

    // docs/DECISIONS.md T43 (amendé le 30/09 : le lien "Activer" est remplacé
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

    // Amendement 2026-09-28 (plan-mes-prompts-28-09.md) : plus de liste
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

    // Amendement 2026-09-28 : le champ "nom du prompt" a disparu avec la
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

    // auth-required d'un fournisseur à clé (claude-api, openai-compat) :
    // « Clé refusée par le fournisseur », bouton « Ouvrir les réglages ».
    "error-auth-key": {
      status: "connected",
      tab: ARTICLE_TAB,
      extraction: { context: extractionContextFor(ARTICLE_TAB, "page") },
      faviconUrl: FAVICON,
      providerStatus: { provider: "openai-compat", state: "ok", reason: "ready" },
      storageLocal: {
        "coati:conversation": [
          { id: "ek-u", role: "user", text: "Résumer cet article : Une mesure publiée le 25 septembre" },
          {
            id: "ek",
            role: "assistant",
            text: "⚠ Clé refusée par le fournisseur : vérifiez-la dans les réglages.",
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
            text: "⚠ Le modèle ne répond pas (indisponible). Le broker fonctionne normalement ; c'est le modèle qui pose problème. Réessayez dans un instant.",
            streaming: false,
          },
        ],
        "coati:attachPage": true,
      },
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

    // Amendement 2026-09-28 : plus de liste déroulante par-dessus le fil —
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

    // --- New states (plan-mes-prompts-28-09.md, lot 5, panel half) --------

    // YouTube : suggestions Coati + 1 prompt utilisateur du site, réordonné
    // ENTRE elles via prefs.sites (order mêle coati:… et p_…).
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
              "coati:youtube:key-points",
              YOUTUBE_MIXED_USER_PROMPT.id,
              "coati:youtube:summarize",
              "coati:youtube:fact-check",
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
    // G5 T50 — page inaccessible, adresse inconnue : bouton « Lire cette page », anneau qui respire (figé ici ; ?motion=live pour le voir bouger). Un clic accorde « tous les sites » et lit la page.
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

    // G5 T50 — premier lancement, Wikipédia lue par le geste de l'icône (activeTab) sans accès durable : l'invitation reste (dernière étape de la carte), favicon du site dans l'anneau, nom du site à côté.
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

    // G5 T50 — bouton déjà utilisé une fois (coati:readButtonUsed), accès retiré depuis : même bouton, sans halo.
    "read-calm": {
      status: "connected",
      faviconUrl: FAVICON,
      prompts: [],
      tab: HIDDEN_TAB,
      extraction: { error: "no-access", origin: "https://exemple-actu.fr" },
      permissions: [],
      storageLocal: { "coati:conversation": [], "coati:attachPage": null, "coati:readButtonUsed": true },
    },

    // G5 T50 — clic accepté, lecture en cours : l'anneau s'ouvre en arc et tourne, « Lecture… », aria-busy.
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

    // G5 T50 — « tous les sites » refusé, adresse inconnue : pas d'animation, ligne d'explication, le bouton peut redemander.
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

    // G5 T50 — refus déjà enregistré, adresse connue : repli sur l'activation site par site, « Activer ce site ».
    "read-refused-site": {
      status: "connected",
      faviconUrl: FAVICON,
      prompts: [],
      tab: WIKIPEDIA_TAB,
      extraction: { context: extractionContextFor(WIKIPEDIA_TAB, "page") },
      permissions: [],
      storageLocal: { "coati:conversation": [], "coati:attachPage": null, "coati:allSitesDeclined": true },
    },

    // G5 T50 — « tous les sites » accordé : plus de bouton, l'encart montre le site et ses suggestions.
    "read-granted": {
      status: "connected",
      faviconUrl: FAVICON,
      prompts: [],
      tab: ARTICLE_TAB,
      extraction: { context: extractionContextFor(ARTICLE_TAB, "page") },
      permissions: ALL_SITES,
      storageLocal: { "coati:conversation": [], "coati:attachPage": null, "coati:readButtonUsed": true },
    },

    // G5 T51 — premier lancement, programme local introuvable (no-host) : ✗ programme (lien releases), modèle en attente, ✗ page.
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

    // G5 T51 — premier lancement, connexion en cours : programme et modèle « … », ✗ page.
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

    // G5 T51 — programme détecté, provider.status pas encore revenu : ✓, …, ✗.
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

    // G5 T51 — programme détecté, modèle KO (aucune clé) : ✓, ✗ (Ouvrir les réglages), ✗.
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

    // G5 T51 — dernière étape : ✓, ✓, ✗ page — la carte désigne le bouton de l'encart (« Montrer le bouton »), rien ne part tout seul.
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

    // G5 T51 — « Montrer le bouton » cliqué : focus et contour sur le bouton de l'encart.
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

    // G5 T51 — accès déjà accordé mais modèle KO : ✓, ✗, ✓.
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

    // G5 T51 — accès accordé, programme introuvable : ✗, …, ✓.
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

    // G5 T51 — ✓, ✓, puis clic sur « Lire cette page » : accès accordé, page lue, carte masquée pour de bon (coati:firstRunDone).
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

    // G5 T51 — les trois coches déjà réunies à l'ouverture : pas de carte.
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
  };
})();
