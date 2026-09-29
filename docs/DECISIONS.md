> Les décisions produit (prix, juridique, marché, plans) sont dans un dépôt privé séparé, non
> publié ici.

# Coati — décisions de conception (technique)

Le produit s'est appelé Wingpen jusqu'au 27/09 (P23, voir le dossier interne) ; les entrées
antérieures gardent l'ancien nom.

Figées le 2026-09-16, à l'issue d'un cadrage et de quatre études internes.
Complétées le 2026-09-17 par le volet distribué payant (étude interne).
Une décision ne se rouvre que sur élément neuf, pas sur intuition.

## Technique

| # | Décision | Motif |
|---|---|---|
| T1 | Chromium d'abord, Firefox ensuite | Le panneau latéral diverge : `chrome.sidePanel` (par onglet) contre `browser.sidebarAction` (par fenêtre). Un codebase unique reste possible avec un manifest scindé + `webextension-polyfill`. |
| T2 | Un broker local **écrit par nous**, pas une bibliothèque tierce | Rien d'existant ne combine réutilisation du CLI local + pont Pyramid + politique par origine. ~400 lignes. |
| T3 | Transport WebSocket, pas `fetch` | Local Network Access soumet `fetch` vers `127.0.0.1` à une permission utilisateur, et un service worker ne peut pas la demander lui-même. Les WebSockets y échappent encore (crbug.com/421156866) — échappatoire datée, repli documenté dans `PROTOCOL.md`. |
| T4 | Aucun secret dans `chrome.storage.local` | Non chiffré sur disque. Le jeton de pairage vit dans `chrome.storage.session` (mémoire vive) ; les identifiants du modèle ne quittent jamais le broker. |
| T5 | Pas de `<all_urls>` : `activeTab` + permissions d'hôte optionnelles | Réduit le rayon de souffle d'un content script compromis, et évite la file de revue manuelle de la boutique. |
| T6 | Le content script envoie du **texte** assaini, jamais du HTML ; le broker traite ce texte comme une donnée, jamais comme une instruction | Une page hostile écrit dans le DOM que le content script lit. C'est le vecteur d'injection principal de cette forme d'extension. |
| T7 | **Fournisseur de modèle par défaut du dépôt public : `ollama`, 100 % local.** `claude-api` (BYOK, clé personnelle de l'utilisateur) est le second fournisseur intégré. | L'étude marché désigne le BYOK et le local comme les deux seuls modèles tenables hors revente de tokens — voir dossier interne pour le détail produit (verticale, prix). |
| T8 | **Un dépôt, une interface de fournisseur commune** (`broker/src/providers/types.ts`) : deux fournisseurs intégrés (`ollama`, `claude-api`) et des modules externes chargés dynamiquement depuis `config.json`, hors du dépôt | Le protocole, le panneau et l'extraction — l'essentiel du travail — sont communs. Seul l'accès au modèle diverge. Voir `docs/MODULES.md`. |
| T9 | **Un module de fournisseur externe (dépendances comprises) ne doit jamais entrer dans le dépôt public ni le binaire distribué par défaut** ; chargement dynamique uniquement, depuis un chemin fourni par `config.json` | Garde chaque dépendance propre à un fournisseur (SDK propriétaire, bibliothèque cliente lourde) hors du dépôt et de la compilation `bun build --compile` par défaut. Voir `docs/MODULES.md`. |

Historique complet des décisions d'origine (17/09, fournisseur personnel) : dossier interne,
« Décisions techniques retirées du public (29/09) ».
| T10 | Les recettes par site sont **déclaratives** (sélecteurs, champs, gabarit de prompt), validées contre un schéma et **signées Ed25519**, distribuées sur CDN | MV3 interdit le code distant (« functionality easily discernible from its submitted code ») — retrait automatique sinon. Et un CDN compromis deviendrait une exécution de code arbitraire chez tous les utilisateurs. La signature couvre le gabarit de prompt, sans quoi une recette altérée devient un vecteur d'injection. Bénéfice : corriger un site qui change son HTML sans repasser par la revue du store. |
| T11 | **Aucun serveur au lancement, sauf celui des licences.** Ni synchronisation, ni relais d'inférence | Le relais détruirait l'avantage (T7). La synchronisation avait été demandée pour les « repères par site » — ce sont en réalité des données produit, identiques pour tous, qui se distribuent en fichier statique (T10). Le serveur de licences doit **échouer en laissant passer** : on ne punit pas un client payant pour une panne. |
| T12 | Signature de code du broker **différée** ; distribution par `brew`/`scoop`/`npm`/binaire au lancement | ~400 €/an (certificat Windows + Apple Developer) pour supprimer un avertissement que l'audience technique de la verticale sait franchir. Nécessaire le jour où le public cesse d'être technique, pas avant. |
| T13 | Encaissement par **marchand de référence** (Paddle ou Lemon Squeezy), pas Stripe nu | La TVA d'un abonnement vendu à un particulier de l'UE est due dans le pays de l'acheteur. Le marchand de référence est juridiquement le vendeur : il la collecte et la reverse. ~2 points de commission en plus pour ne jamais toucher à la TVA intracommunautaire. |

### Volet distribué payant — décisions techniques (17/09)

Extrait technique de l'étude interne du 17/09 ; le volet produit correspondant (verticale, prix,
ToS) est dans le dépôt privé.

| # | Décision | Motif |
|---|---|---|
| T17 | **Les recettes ancrent sur le texte visible, jamais sur les classes CSS** | `.css-1x7bf3q` d'un build CSS-in-JS change à chaque déploiement ; le libellé « Montant de vos cotisations » ne change qu'à la refonte. Chercher une valeur *à côté d'un libellé* est ce que fait un humain, et c'est nettement plus stable. |
| T18 | **Une recette qui échoue dégrade, elle ne casse jamais** | Il y a un LLM dans la boucle : quand les ancres ne répondent plus, on envoie une tranche plus large de texte assaini et le modèle retrouve l'information. Plus lent, moins précis, mais fonctionnel. Un scraper classique casse net. Corollaire : le chemin générique gratuit marche toujours, la recette l'améliore sans jamais en être l'unique voie. |
| T19 | **Maintenance : canari quotidien sur les pages publiques, utilisateurs-capteurs sur les pages connectées** | Une page connectée n'est pas vérifiable automatiquement sans détenir des identifiants — exclu. Compensations, par ordre d'efficacité : un bouton « cette recette ne correspond plus » (sans bouton, l'utilisateur part en silence) ; un signalement **opt-in, sans contenu** — structure fixe du type `recette impots-avis v3, ancres 2 et 5 introuvables`, zéro texte de page, aperçu exact affiché avant envoi ; et l'auteur lui-même, qui visite ces sites de toute façon. Charge estimée : ~20 recettes sur des sites publics lents = quelques heures par mois ; 50 recettes sur du SaaS à déploiement continu = un mi-temps. D'où la stratégie : **peu de recettes, sur des sites lents, bien faites.** |
| T16 | **L'adaptateur modèle local (Ollama/LM Studio) passe devant le BYOK HTTP dans l'ordre de construction** | Cette verticale porte les données les plus sensibles d'un utilisateur — revenus, cotisations, avis d'imposition. Avec un modèle local, elles ne quittent jamais la machine : ni broker distant, ni API, ni Anthropic. Personne d'autre ne peut prononcer cette phrase. Sous BYOK avec clé Anthropic, la donnée part chez un sous-traitant choisi par l'utilisateur, qui en est responsable de traitement — acceptable, mais à **dire avant** la première requête sur ce type de page, pas à enfouir dans les CGU. |
| T14 | **Une recette payante par site exige un contrôle ToS préalable.** Critère : (a) aucune clause anti-outil, ou (b) le contenu appartient à l'utilisateur, ou (c) API officielle autorisant un client tiers | Une recette nommée est un engagement contractuel, pas un détail technique : la livrer, c'est viser le site et se faire opposer ses conditions. Le contrôle passe avant l'écriture, au même rang que le test technique. La condition (b) est la plus robuste — personne ne peut interdire à quelqu'un de lire ce qui lui appartient, la question des droits d'auteur et des clauses *NonCommercial* disparaît, et c'est là que les agents cloud sont les plus aveugles puisqu'il faut être connecté. |
| T15 | La distinction qui préserve le produit : **le gratuit générique n'est pas visé, le premium nommé l'est** | « Lis la page que je regarde » est universel, indifférent au site, déclenché par l'utilisateur sur son propre écran — au même titre que le mode lecture de Chrome. Ce qu'un ToS interdit, c'est de **vendre** une fonction nommée pour son service. |

## Contrainte dure — la règle du geste

> **Coati accompagne un geste de l'utilisateur, il n'en fabrique jamais.**

Au même rang que les quatre règles de sécurité. Ce n'est pas une précaution morale, c'est la
condition d'existence du produit : les trois cadres qui nous protègent tracent exactement la même
ligne, et la franchir les fait perdre tous les trois d'un coup.

| | Côté licite | Côté interdit |
|---|---|---|
| Cloudflare (taxonomie juillet 2026) | humain en temps réel | boucle automatisée = catégorie *Agent*, bloquée par défaut depuis le 15/09/2026 sur toute page affichant de la publicité |
| ToS des plateformes | l'utilisateur agit, l'outil assiste | l'outil agit à sa place — ban du compte **de l'utilisateur** |
| Chrome Web Store | enrichir ce qui est affiché | extraire en volume, transmettre, contourner |

Interdit : suivi de prix en arrière-plan, veille automatique, crawl multi-pages, publication
programmée, toute boucle sans geste. Autorisé : tout ce qui part d'un clic sur la page ouverte.

### L'exception nommée (18/09) — ouvrir la transcription YouTube

Un seul clic, sur le bouton « Afficher la transcription » que YouTube affiche déjà, **uniquement**
en réponse au clic de l'utilisateur sur « Résumer cette vidéo », sur l'onglet qu'il regarde. Jamais
au chargement, jamais en boucle, jamais sur une autre vidéo que celle affichée. Code isolé dans
`panel.js:openYouTubeTranscript`, séparé de l'extraction pour rester lisible par un examinateur de
boutique.

Motif : ce que visent les trois régimes, c'est le **volume et l'autonomie** — un moissonneur. Une
interaction unique, sur instruction directe et simultanée d'un utilisateur connecté, est son acte à
lui, outillé. C'est l'axe de hiQ v. LinkedIn et de Meta v. Bright Data : ce qui a fait basculer les
décisions, c'est l'accès massif derrière un login, jamais une interaction isolée avec une interface.
Une lecture stricte interdirait aussi de faire défiler une page pour charger du contenu différé, ce
qui rendrait l'extension inutilisable.

Cette exception est **nommée et bornée** : elle vaut pour ce bouton, pas comme précédent. Toute
extension du principe repasse par une décision explicite.

**Élargie le 26/09, par décision explicite de Romain** : elle couvre aussi le clic sur une autre
suggestion vidéo de l'encart de site (T27), par exemple « Points clés minutés ». Mêmes bornes : un
seul clic sur le bouton que YouTube affiche, en réponse au clic de l'utilisateur, sur l'onglet
qu'il regarde, pour la vidéo affichée.

**Principe accepté le 26/09 par Romain, à cadrer avant tout code — « une action à la fois,
décidée par l'utilisateur »** : le modèle peut proposer une action sur la page ouverte ; le panneau
l'affiche en nommant exactement ce qui sera cliqué ; le clic de l'utilisateur déclenche ce seul
clic. Jamais d'enchaînement, jamais d'initiative, jamais sur un autre onglet. D'abord les actions
qui font apparaître du contenu (déplier, afficher plus, commentaires) ; les actions qui ont un
effet sur le compte (s'abonner, aimer, commenter, acheter, réglages) viendront plus tard. Romain
envisage de lever davantage les restrictions de clic ; point à clarifier avant d'écrire du code,
notamment la responsabilité : l'examen du Chrome Web Store juge le code de l'extension, pas le
modèle (plus bas, « La contrainte vit dans le code »), et une page piégée peut dicter ses
propositions au modèle.

⚠️ **Ce qui a été écarté au passage** : faire dire au produit « clique à ma place, je n'ai pas le
droit de le faire ». Cette phrase n'aurait protégé de rien et aurait tout aggravé — un aveu écrit,
livré à chaque client, que l'éditeur estime l'action interdite, doublé d'une instruction de la
commettre. C'est la définition de la **facilitation** que vise la politique du Chrome Web Store, et
la preuve du savoir en cas de litige. Règle générale qui en découle : **ne jamais écrire dans le
produit qu'on estime quelque chose illégal.** Le cadre juridique s'énonce une fois, en termes
factuels et neutres, dans les CGU et la fiche de boutique. Les messages d'interface restent
factuels : ce qui s'est passé, ce que l'utilisateur peut faire — jamais une qualification de droit.

Corollaire de risque : l'exposition réelle n'est pas un procès — aucune plateforme ne poursuit un
développeur solo pour un clic — mais un **retrait du Chrome Web Store**, administratif, sans recours
pratique, immédiat. On optimise pour la lecture d'un examinateur, pas pour un tribunal.

**La contrainte vit dans le code, pas dans l'interface.** L'idée d'afficher dans chaque réponse ce
que Wingpen a le droit de faire a été examinée et écartée : le CWS juge le code et non l'interface
(la responsabilité ne se transfère pas par mention légale) ; l'encart répété reproduit la plainte
n°5 de `niches.md` (« UX écrasante ») alors que la simplicité est ce qu'on vend ; et expliquer
*comment* contourner une restriction est qualifié de **facilitation** par la politique CWS — une
extension qui refuse d'agir mais publie le mode d'emploi est plus exposée qu'une qui se tait.
Forme retenue : la fonction n'existe pas, c'est énoncé une fois à l'installation et dans les CGU, et
un message d'une ligne n'apparaît que si l'utilisateur demande ce que Wingpen ne fera pas.

## Appairage et connexion au modèle (25/09)

Issues du goal du 25/09 (audits du jeton et de la connexion, revue de sécurité du lot 7). Étude
et comparaison des transports : note interne.

| # | Décision | Motif |
|---|---|---|
| T20 | **La frontière de menace est le compte utilisateur du système, et le code l'applique** : liste `Host` exacte, puis UID du pair sous Linux, avant tout routage ; hors Linux, non appliqué et dit au démarrage | L'ancienne note promettait le compte alors que tout processus de la machine passait, autres comptes compris (`PROTOCOL.md`, « Frontière de menace », « Admission HTTP et WebSocket »). |
| T21 | **`hello-ok` délivre un jeton de session** : 256 bits, en mémoire seulement, lié à l'origine, 64 au plus ; le secret permanent ne sert plus qu'à épingler un uuid Firefox | L'extension ne détient plus de secret durable, et un redémarrage du broker invalide tout ce qui a été délivré (`PROTOCOL.md`, « Poignée de main », « Jeton de session »). |
| T22 | **Chemin « un clic » retiré** : plus d'`externally_connectable`, de message `wingpen:pair` ni de bouton sur `/pair` | Inutile pour un ID autorisé (appairage silencieux), impossible pour un ID inconnu (refusé à l'`Origin`), et ouvert à toute page servie sur le port, donc à un programme qui l'occuperait (`PROTOCOL.md`, « Chemin « un clic » retiré »). |
| T23 | **`/pair` réservée à Firefox**, sans ID ni script, servie seulement à une navigation de premier niveau (`Sec-Fetch-Mode: navigate`, `Sec-Fetch-Dest: document`) | C'était la plus grosse exposition du secret permanent ; le filtre écarte le `fetch()` d'une autre extension, seul Native Messaging ferme le reste (`PROTOCOL.md`, « Page `/pair` (Firefox seulement) »). |
| T24 | **Port 8787 figé** : `config.port` n'est plus lu, `WINGPEN_PORT` sert aux tests | L'adresse du service worker et le `connect-src` de la CSP sont littéraux : un autre port est injoignable (`PROTOCOL.md`, « Transport »). |
| T25 | **Disponibilité du fournisseur vérifiée à l'ouverture du panneau seulement, sans appel facturé** (`provider.status`, cache de 60 s) | Règle du geste, et aucune dépense sur la clé ou l'abonnement de l'utilisateur pour un simple affichage (`PROTOCOL.md`, « Disponibilité du fournisseur »). |
| T26 | **Aucune bascule automatique de fournisseur** : seul un `settings.set` venu de l'utilisateur en change | Changer de fournisseur change le destinataire des pages (T16) ; ce choix appartient à l'utilisateur (`PROTOCOL.md`, « Disponibilité du fournisseur », « Règles invariantes »). |

Élément neuf, sans rouvrir de décision ici : le motif de T3 et du risque ouvert n°1
(crbug.com/421156866, « pas encore » appliqué aux WebSockets) est daté. Chrome 147 et Firefox 154
filtrent désormais les WebSockets des sites web ; les origines d'extension restent hors de portée,
sans garantie écrite. Détail : note interne.

## Panneau et suggestions par site (26/09) — volet technique

Décidé par Romain le 26/09, après ses premiers essais du panneau. Le volet produit (choix visuels,
absence de maquette) est dans le dépôt privé.

| # | Décision | Motif |
|---|---|---|
| T27 | **Suggestions par site dans un encart à place fixe** : indicateur d'attente au changement de page, puis l'icône du site et les prompts recommandés dessous ; jeu générique sur un site inconnu | Des boutons qui apparaissent et disparaissent sous la barre feraient sauter la mise en page à chaque changement d'onglet. **Amendement 2026-09-28** : le jeu générique sur site inconnu disparaît. L'encart y montre son en-tête et « Mes prompts ↗ », plus les prompts que l'utilisateur a rangés dans la case « Tous les sites » — voir T33, T41. |
| T28 | **L'icône de l'encart est celle que le site fournit (favicon)**, jamais un logo embarqué ; jamais non plus une requête vers une adresse choisie par la page : Chromium la sert depuis son cache (`_favicon/`, permission `favicon`, sans avertissement tant que ni `tabs` ni permission d'hôte obligatoire ne sont déclarées), Firefox seulement si c'est une URL `data:` ; la CSP garde `img-src 'self'` (`data:` en plus sous Firefox) | Vaut pour tous les sites, et l'extension ne transporte aucune marque d'autrui (examen du Chrome Web Store). Charger `tab.favIconUrl` aurait ouvert la CSP à tout `https:` et dit à la page, par une requête qu'elle contrôle, que Wingpen est ouvert. **Amendement 2026-09-28** : l'icône disparaît entièrement de l'encart (ni favicon, ni repli visuel) — voir T31. La mécanique de service (`_favicon/`, CSP) décrite ici n'est plus utilisée ; conservée ici pour l'historique. |
| T29 | **Pas de permission `tabs`** : sur un site non activé, l'encart montre le jeu générique et « Activer ce site » | `tabs` ferait afficher « Lire votre historique de navigation » à l'installation. Le panneau ne connaît l'adresse d'un onglet que sur un site activé ou après un clic (T5). |
| T30 | **Suggestions par site : un fichier de données livré avec l'extension** (site → prompts), appelé à rejoindre les recettes | Du texte seulement, sans extraction propre au site : rien de ce que T14 et T15 encadrent pour une recette nommée. **Amendement 2026-09-28** : le jeu générique (`GENERIC`) disparaît. Le gratuit ne couvre plus que cinq sites populaires (YouTube, Google résultats, Wikipédia, Reddit fil, Amazon fiche produit) ; immobilier, Leboncoin et achat en ligne générique sortent du gratuit et rejoignent le payant (par site, nommé) — voir T31, P25 (dossier interne). |

## Mes prompts par site, encart épuré, sites populaires (28/09) — volet technique

Décidé par Romain le 28/09 (plan interne). Couvre l'encart, le pied
du panneau, le fil, la nouvelle page « Mes prompts » et le stockage des prompts/préférences. Le
volet produit (stockage côté broker, données d'usage) est dans le dépôt privé.

| # | Décision | Motif |
|---|---|---|
| T31 | **Contenu et ordre de l'encart** : les prompts de la case du site (suggestions de Coati et prompts de l'utilisateur mêlés, même apparence, sans mention « à vous »), dans l'ordre de la case, puis ceux de « Tous les sites », puis « Mes prompts ↗ » en dernier bouton discret (ouvre la page dans un onglet). La première suggestion de Coati d'un site populaire garde le style principal (caramel). Au-delà de trois lignes de boutons, l'encart défile. Aucune icône de site (amende T28). | Un seul flux visuel, sans distinguer visuellement « ce que Coati propose » de « ce que l'utilisateur a écrit » — la distinction n'aide pas l'usage et alourdit l'encart (P19, dossier interne). |
| T32 | **Libellé d'un bouton de prompt** : le titre s'il existe, sinon le début du texte coupé par « … » | Le titre devient facultatif (T41), il faut un repli qui ne casse jamais l'affichage. |
| T33 | **Pied du panneau simplifié** : pas de croix dans l'encart ; la liste « Mes prompts » du pied (zone 5b) disparaît ; le pied ne garde que la disquette, qui enregistre la question tout de suite, sans demander de titre, dans la case du site en cours (« Tous les sites » si l'adresse est inconnue, T29) | Un geste, pas un formulaire : le titre se donne plus tard, dans la page « Mes prompts » (T38), si l'utilisateur le veut. |
| T34 | **Bouton « Relancer »** sur chaque message de l'utilisateur du fil (visible au survol et au focus clavier, sous la bulle), qui le renvoie selon l'état actuel de l'interrupteur de lecture de page | Reprendre une question sans la retaper ; même règle de lecture qu'un envoi normal — pas de lecture figée au moment du premier envoi. |
| T35 | **Page « Mes prompts » : grille pleine page, une case par site**, ordre fixe (« Tous les sites », les cinq sites populaires, puis les sites de l'utilisateur par ordre alphabétique) ; une case apparaît au premier prompt enregistré pour un site ; un site = l'adresse sans `www` (`crisco4.unicaen.fr` et `unicaen.fr` sont deux sites) | Un site inconnu doit pouvoir accumuler des prompts sans qu'il ait fallu le prévoir dans le fichier de données (T30). |
| T36 | **Une ligne de prompt** : une poignée et un bouton pour l'effacer, en deux temps (`confirm-arm.js`) ; pas de case à cocher | Cohérent avec l'usage existant de la confirmation en deux temps ailleurs dans le panneau ; pas de sélection multiple, hors périmètre. |
| T37 | **La poignée réordonne dans la case et déplace vers une autre case** (changement de site) ; une suggestion de Coati non modifiée reste dans sa case ; boutons « monter » / « descendre » sur chaque ligne pour le clavier et le tactile | SortableJS (bibliothèque retenue, voir « Librairie » du plan) n'a pas de mode clavier — les boutons comblent ce trou plutôt que d'exiger la souris. |
| T38 | **Édition d'un prompt** : au clic, la ligne s'agrandit et montre titre (facultatif) et texte ; enregistrement par bouton explicite ou à la sortie du champ, le plus simple qui ne perde rien | Pas de sauvegarde automatique à chaque frappe (coût réseau, risque de course) ; pas de perte si l'utilisateur clique ailleurs sans bouton dédié. |
| T39 | **Suggestions de Coati dans la page** : effaçables (retirées de ce site) et modifiables ; modifier une suggestion la transforme en prompt de l'utilisateur à la même place, l'original compte comme effacé ; lien discret « Rétablir les suggestions de Coati » tant qu'il en manque dans une case | Une suggestion n'est pas un texte figé : l'utilisateur doit pouvoir se l'approprier sans perdre sa place dans la case, et revenir en arrière si l'essai ne convient pas. |
| T40 | **Hors périmètre de la page** : ni recherche, ni « Déplacer vers… », ni « Masquer », ni déplacement des cases | KISS (P19, dossier interne) : la page gère des prompts, pas une bibliothèque à facettes. |
| T41 | **Stockage** : pas de migration — l'ancien `prompts.json` à plat est ignoré par le broker, sans être supprimé ; `DEFAULT_PROMPTS` (les cinq prompts d'office) disparaît, bibliothèque vide à l'installation ; `PromptEntry` devient `{ id, site, title?, body }`, `id` stable attribué par le broker (le titre, facultatif, ne peut plus servir d'identifiant) ; `site` vaut `"*"` ou une clé de site sans `www` | Décision de Romain : ne pas écrire de code de migration pour cinq prompts par défaut que personne n'a demandés ; un identifiant stable est nécessaire dès que le titre devient facultatif et modifiable. Détail du format : `docs/PROTOCOL.md`, « Bibliothèque de prompts et préférences par site ». |
| T42 | **Activation case par case, dans la page « Mes prompts »** : un interrupteur « Actif » dans l'en-tête de chaque case de site (les cinq sites populaires et les sites de l'utilisateur), qui demande ou retire l'autorisation d'accès (`permissions.request` / `permissions.remove`) ; sites populaires : tous leurs domaines reconnus d'un coup (Google et Amazon : les neuf pays déjà couverts) ; pas de lien « Activer les sites populaires » dans l'encart | Décision de Romain (28/09) : l'activation se fait à l'endroit où l'utilisateur voit déjà tous ses sites, pas en aveugle depuis l'encart d'une seule page. Pas de raccourci « tous les sites » (permission trop large pour un clic). |
| T43 | **Lien « Activer » dans l'encart** : petit texte gris discret, à droite du nom du site sur la ligne d'en-tête, visible dès que Coati connaît l'adresse d'une page non activée ; disparaît une fois le site actif | Complète T42 sans le remplacer : l'utilisateur qui est déjà sur la page peut activer sans détour par « Mes prompts », mais rien n'y fait le travail à sa place (pas de sites populaires ni « tous les sites »). |
| T44 | **Case de tête de la page « Mes prompts », en deux parties** : pleine largeur, colorée (fond caramel très clair / teinte sombre équivalente), sans titre de case propre. Première partie, seul intitulé de la case : « Sur tous les sites » (l'actuelle case `"*"`, affichée dans tous les encarts). Seconde partie, sans nom du tout (ni « À ranger » ni aucun intitulé), séparée par un filet discret : prompts enregistrés sur une page dont Coati ne voit pas l'adresse, clé interne `@unsorted`, jamais affichée à l'utilisateur ; montrés dans l'encart seulement sur une page d'adresse inconnue, jusqu'à ce que l'utilisateur les glisse ailleurs | Correction de Romain au lancement du goal : la seconde partie ne porte aucun nom, pour ne pas laisser croire que « ranger plus tard » est le geste attendu — c'est un simple accueil temporaire, pas une case comme les autres. |

**Amendement 2026-09-28 (T29)** : sur un site non activé, l'encart ne montre plus « Activer ce
site » comme repli d'échec de lecture seul — le lien « Activer » (T43) apparaît dès que l'adresse
est connue, avant même une tentative de lecture.

**Amendement 2026-09-28 (T33)** : la disquette range désormais dans `@unsorted`, pas dans
« Tous les sites » (`"*"`), quand l'adresse de la page est inconnue — voir T44. « Tous les sites »
reste la case que l'utilisateur choisit lui-même en glissant un prompt.

## Lecture des pages (29/09)

Décidé par Romain le 29/09 sur les propositions L1-L7 d'une étude interne.

| # | Décision | Motif |
|---|---|---|
| T45 | **La lecture générique passe avant tout module payant.** D'abord le choix du bloc principal : ne jamais retenir un bloc non affiché (`checkVisibility`, `getClientRects`, sous-arbres `aria-hidden`), préférer `main`/`article` affichés (L1). Puis, dans l'ordre : regrouper les blocs frères répétés (fils de commentaires), lire le shadow DOM ouvert et fermé (`openOrClosedShadowRoot`), prévenir l'utilisateur quand une page est illisible (PDF, `canvas`, texte vide), garder titres et listes, écarter le texte invisible à l'œil (L2). Chaque changement se mesure avant/après au banc `scripts/lecture/` | 6 pages ratées sur 19 mesurées, dont 3 à 4 par une seule cause (blocs cachés choisis comme contenu). La correction profite à tous les sites, gratuitement. |
| T46 | **Deux gestes de plus donnent accès à la page** : une entrée « Lire cette page avec Coati » au clic droit sur la page, et un raccourci clavier. Le clic sur l'icône relit l'onglet (`openPanelOnActionClick: false` + `action.onClicked`, fait le 29/09) ; l'icône ne ferme plus le panneau sous Chrome (L3) | Sous Chrome, un clic dans le panneau n'accorde pas `activeTab`. Ces gestes, si, sans permission `tabs`. Vérifié par Romain le 29/09 : le clic sur l'icône fait apparaître l'icône du site et « Activer » (L4) ; sous Firefox, un envoi depuis la barre latérale lit la page (L5). |
| T47 | **`extractOriginFromError` est retirée** si l'erreur d'injection de Firefox ne contient pas non plus l'adresse (L7) | Sous Chrome/Brave, l'erreur ne contient plus l'adresse : le code est sans effet. |

**Report (L6)** : la frontière gratuit / module et l'ordre des modules se décident après la
publication sur GitHub de l'extension gratuite.

**Amendement 2026-09-29 (T29)** : pas de permission `tabs`, inchangé. Les gestes qui donnent
l'adresse d'un site non activé sont le clic sur l'icône, le clic droit et le raccourci (T46) ; sous
Firefox, aussi un envoi depuis la barre latérale.
