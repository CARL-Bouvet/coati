# Coati — architecture, expliquée

## L'essentiel en une minute

Cinq morceaux. Trois meurent tout le temps, deux survivent.

| Morceau | Où | Vit | Rôle |
|---|---|---|---|
| Panneau latéral | navigateur | tant qu'il est ouvert | l'interface, et **le seul** à garder la conversation |
| Service worker | navigateur | meurt après ~30 s d'inactivité | tient l'unique WebSocket vers le broker, relaie |
| Content script | dans la page | une exécution, puis meurt | lit le texte visible, ne l'écrit jamais |
| Page d'options | navigateur | onglet ouvert | y coller le jeton de pairage, une fois |
| Broker | hors navigateur | tant qu'il tourne | détient le jeton, appelle le modèle |

Un clic « Résumer » fait ce trajet : **panneau → content script (lit la page) → service worker →
WebSocket → broker → fournisseur de modèle → et le texte revient par fragments en sens inverse.**

Trois choses à retenir :

- **Le secret n'est jamais dans le navigateur.** Le jeton vit dans un fichier `0600` chez
  l'utilisateur et, côté extension, en mémoire vive seulement. Les identifiants du modèle ne sont
  jamais dans l'extension non plus — `ollama` n'en a pas, la clé de `claude-api` reste dans
  `config.json` côté broker (voir §5).
- **Le broker ne se souvient de rien.** Chaque demande est indépendante. Toute la mémoire est dans
  le panneau, parce que le service worker, lui, peut mourir au milieu d'une phrase.
- **Rien ne part sans clic.** Aucun morceau n'a de branchement pour lire une page de sa propre
  initiative. Ce n'est pas une politesse, c'est l'absence de câblage.

Le reste du document détaille chaque point. Les faiblesses connues sont en §7.

## 1. Qu'est-ce qu'un broker, ici

Un « broker » (courtier) est un programme intermédiaire : il ne fait rien lui-même, il fait
passer une demande d'un côté vers un fournisseur de l'autre, et relaie la réponse. Ici : un
petit serveur qui tourne **sur la machine de l'utilisateur**, écrit en TypeScript sur Bun
(`broker/src/server.ts:1`), lancé à la main ou par un service système, séparé du navigateur.

Il existe pour une seule raison : sortir le secret du rayon d'action du navigateur. Une
extension de navigateur vit dans un environnement hostile par construction — pages web
arbitraires, autres extensions, bugs du moteur de rendu. Si l'extension détenait elle-même les
identifiants d'accès au modèle de langage, n'importe quelle faille dans ce périmètre les
exposerait. Le broker les tient à distance : il tourne comme un processus normal du système
d'exploitation, l'extension ne lui parle qu'à travers un canal étroit et authentifié (§5), et
ne reçoit jamais les identifiants en retour.

Sans broker, deux options existent, toutes deux pires : soit l'extension appelle l'API du
modèle directement avec une clé embarquée dans son code (extractible par quiconque installe
l'extension), soit elle passe par un service tiers hébergé qui voit défiler le contenu de
toutes les pages visitées. Le broker local évite les deux : le secret reste sur la machine, et
aucun contenu de page ne quitte cette machine vers un tiers autre que le fournisseur du modèle
lui-même, au moment précis d'une demande explicite de l'utilisateur.

Contrepartie assumée : le broker doit être lancé pour que l'extension fonctionne. Ce n'est pas
un service cloud toujours disponible — c'est délibéré (§6).

## 2. Les cinq morceaux et qui parle à qui

**Service worker** (`extension/background/service-worker.js:1`) — le chef d'orchestre côté
navigateur. C'est un script d'arrière-plan MV3 : « MV3 » (Manifest V3) est le format d'extension
Chrome actuel, dans lequel le code d'arrière-plan n'est pas un processus permanent mais un
« service worker », un script que le navigateur démarre à la demande et **tue dès qu'il est
inactif** (quelques dizaines de secondes), pour économiser la mémoire. Il détient l'unique
connexion WebSocket vers le broker et relaie les messages dans les deux sens. Il ne peut rien
retenir de façon fiable en mémoire — d'où le commentaire en tête de fichier : la conversation
n'y vit jamais. Il se relance sur `onInstalled`, `onStartup`, une alarme périodique, ou tout
message reçu (`service-worker.js:20-56`).

**Content script** (`extension/content/extract.js:1`) — le seul morceau de code qui touche
réellement la page visitée. Un « content script » est un script injecté dans le contexte d'une
page web, distinct du script de la page elle-même. Il n'est **pas** persistant : il est injecté
à la demande via `chrome.scripting.executeScript` (`panel.js:263-266`), s'exécute une fois comme
une fonction immédiate (IIFE), retourne sa valeur, et meurt. Il ne peut lire que le texte visible
rendu (`innerText`), jamais écrire dans la page, jamais persister d'état.

**Side panel** (`extension/panel/panel.js:1`) — l'interface que l'utilisateur voit. Un « side
panel » est un panneau latéral de Chrome, un document HTML normal ancré au bord de la fenêtre.
C'est un document, donc il vit tant que l'utilisateur ne le ferme pas, et lui seul détient
l'historique de conversation, persisté dans `chrome.storage.local` (`panel.js:8,416-417`) —
précisément parce que le service worker, lui, peut mourir à tout moment.

**Options page** (`extension/options.js:1`) — un document ouvert en onglet (`open_in_tab: true`,
`manifest.json:17`) où l'utilisateur colle une seule fois le jeton de pairage. Ne fait rien
d'autre. Vit tant que l'onglet reste ouvert.

**Broker** (`broker/src/server.ts:1`) — décrit en §1. C'est le seul des cinq morceaux qui n'est
pas dans le navigateur : un processus Bun autonome, qui vit tant que l'utilisateur (ou son
système d'init) ne l'arrête pas. Seul lui détient le jeton de pairage et l'accès au modèle.

## 3. Le trajet complet d'un clic « Résumer cette page »

1. L'utilisateur clique sur le bouton `#mainAction` dans le panneau — écouteur posé en
   `panel.js:37`, qui appelle `summarize("page")` (`panel.js:185`).
2. `summarize()` trouve l'onglet actif : `activeTabId()` → `chrome.tabs.query(...)`
   (`panel.js:256-260`).
3. Il injecte le content script dans cet onglet : `extractFromTab()` →
   `chrome.scripting.executeScript({ files: ["content/extract.js"] })` (`panel.js:262-266`).
4. `extract.js` s'exécute dans la page, calcule le texte le plus dense (`articleText()`,
   `extract.js:42-64`), le tronque à 40 000 caractères (`extract.js:17-26`), et retourne
   `{ kind: "page", url, title, text }` comme valeur de complétion de l'IIFE (`extract.js:155-160`).
5. De retour dans le panneau, `context` contient ce résultat. Un id de requête est généré
   (`newId()`), un message utilisateur et un message assistant vide (en streaming) sont ajoutés
   à la conversation (`panel.js:241-244`).
6. Le panneau envoie au service worker : `chrome.runtime.sendMessage({ type:
   "coati:client-message", payload: { type: "summarize", id, context, length: "medium" } })`
   (`panel.js:250-253`).
7. Le service worker reçoit ce message dans son écouteur `chrome.runtime.onMessage`
   (`service-worker.js:36-56`), reconnaît `"coati:client-message"` et appelle
   `sendToBroker(payload)` (`service-worker.js:50-52`).
8. `sendToBroker()` sérialise le payload et l'envoie tel quel sur le WebSocket déjà ouvert et
   authentifié : `ws.send(JSON.stringify(payload))` (`service-worker.js:156`).
9. Côté broker, `Bun.serve` reçoit la frame dans `websocket.message` (`server.ts:197-211`). La
   connexion est déjà authentifiée (§5), donc le message passe par `parseClientMessage()`
   (`protocol.ts:220-228`) puis `handleMessage()`, cas `"summarize"` (`server.ts:105-113`).
10. Le broker vérifie la taille du contexte (`contextTooLarge`, `server.ts:106`), construit le
    prompt final avec `buildPrompt({ kind: "summarize", context, length })` (`model.ts:73,81-87`)
    — c'est le seul endroit du broker qui assemble un prompt, précisément pour garder la règle
    « contenu de page = donnée » en un seul point.
11. `runStream()` (`server.ts:51-84`) appelle `streamAnswer(prompt, { signal })` du fournisseur de
    modèle actif (`ollama`, `claude-api`, ou un module externe — voir `docs/MODULES.md`).
12. À chaque fragment de texte reçu du modèle, le broker envoie sur le WebSocket :
    `{ type: "chunk", id, delta }` (`server.ts:67`).
13. Le service worker reçoit la frame dans `handleBrokerMessage()` et la retransmet telle quelle
    à tous les documents à l'écoute : `broadcast({ type: "coati:broker-message", message })`
    (`service-worker.js:122-139`).
14. Le panneau reçoit ce message via `onRuntimeMessage` → `handleBrokerMessage()`, cas `"chunk"` :
    il retrouve le message assistant par id, concatène `delta`, et le redessine à l'écran
    (`panel.js:82-92`). C'est ce qui produit l'effet de texte qui s'écrit progressivement.
15. Quand le modèle a fini, le broker envoie `{ type: "done", id, usage }` (`server.ts:72`) ; le
    panneau marque le message comme non-streaming et persiste la conversation dans
    `chrome.storage.local` (`panel.js:94-102`).

## 4. Le protocole en pratique

Messages client → broker (tous avec `id` sauf `hello`) : `hello`, `chat`, `summarize`, `act`,
`prompts.list`, `prompts.save`, `prompts.delete`, `cancel`. Messages broker → client : `chunk`,
`done`, `error`, `prompts`, `hello-ok`. Définis en double — texte en `docs/PROTOCOL.md`, types et
parseur en `broker/src/protocol.ts:1-266` — et le code applique en pratique exactement le tracé
du document pour la poignée de main, les champs de `Context`, et la limite de 256 Ko
(`protocol.ts:4,171-178`) comme celle de 40 000 caractères (`server.ts:19`, `extract.js:17`).

`PROTOCOL.md:87-88` documente six codes : « `bad-request`, `unauthorized`, `model-unavailable`,
`context-too-large`, `cancelled`, `internal` ». `protocol.ts:6-12` les déclare tous, et `server.ts`
les émet désormais tous : un échec de poignée de main envoie un message `error` (code
`unauthorized`, message générique « unauthorized » — voir plus bas) avant de fermer en 4401
(`server.ts:rejectHandshake`) ; une panne modèle authentique — quota épuisé, démon Ollama ou API
injoignable — ressort en `model-unavailable` via `isModelUnavailableError()` (`model.ts`), tout comme un
appel qui dépasse le délai de 120 s sans réponse (`MODEL_TIMEOUT_MS`, `model.ts` — voir §7) ; le
reste tombe dans `internal`.

**Poignée de main : un seul message, générique, sur les trois échecs possibles.** `Origin`
refusé, jeton invalide, ou pas de `hello` sous 3 s envoient tous les trois exactement le même
`{"type":"error","id":"hello","code":"unauthorized","message":"unauthorized"}` avant de fermer en
4401 avec la même raison générique — un programme local qui sonderait la poignée de main ne peut
pas distinguer laquelle des trois vérifications a échoué. La raison précise part uniquement dans le
log stderr du broker (`rejectHandshake()`, `server.ts`), jamais sur le fil.

⚠ **divergence — la moitié du protocole n'a pas d'interrupteur côté extension.** Le broker
implémente entièrement `act` (`server.ts:114-127`) et `prompts.delete`
(`server.ts:136-138`) ; `panel.js` ne les émet jamais nulle part — aucun menu contextuel sur une
sélection de texte, aucun bouton de suppression dans la bibliothèque de prompts
(`panel.js:309-355` ne couvre que lister et sauvegarder). Ce que `PROTOCOL.md` décrit comme un
aller-retour fonctionnel n'est, pour ces deux types, qu'une moitié de circuit : accessible en
théorie (par exemple via `wscat`), inatteignable depuis l'interface livrée.

## 5. Où vivent les secrets

**Jeton de pairage.** Créé côté broker, une seule fois, au premier démarrage :
`loadOrCreatePairingSecret()` génère 16 octets aléatoires en hex et les écrit dans
`~/.local/share/coati/pairing.txt`, permissions `0600` (`config.ts:67-79`). Il rejoint l'extension
selon le navigateur (voir `docs/PROTOCOL.md` « Appairage » pour le détail de chaque chemin) :

- **Chromium/Brave** — octroi silencieux à la poignée de main : le broker connaît l'identifiant
  de l'extension, insère le jeton dans le champ `token` du message `hello-ok`, et l'extension le
  lit sans aucune interaction de l'utilisateur. Les connexions suivantes sont elles aussi silencieuses.
- **Firefox** — l'UUID de l'extension est instable (il change à chaque rechargement pour une
  extension temporaire). Au premier démarrage — ou à chaque rechargement d'une extension temporaire —
  l'utilisateur colle le secret permanent affiché par `GET /pair` dans la page d'options.
  Une fois l'UUID épinglé côté broker (`docs/PROTOCOL.md` « Épinglage Firefox »), les connexions
  ultérieures sont silencieuses.

Dans les deux cas, le jeton est stocké côté extension dans `chrome.storage.session`
(jamais `chrome.storage.local`) — une mémoire vive au sens propre : elle n'est jamais écrite sur
disque et s'efface à la fermeture du navigateur. À chaque connexion, le service worker le relit
et l'envoie dans le message `hello` (`service-worker.js:73,90`).
Le broker le vérifie par comparaison à temps constant, `checkSecret()`
(`server.ts:32-38,161`) — un détail qui compte : une comparaison naïve fuiterait le secret
octet par octet via le temps de réponse.

**Identifiants du modèle.** `ollama` n'en a pas besoin (démon local). `claude-api` stocke la clé
API de l'utilisateur dans `~/.config/coati/config.json` (0600, jamais renvoyée à l'extension — voir
`docs/PROTOCOL.md` « La clé API »). Un fournisseur chargé comme module externe (`docs/MODULES.md`)
gère ses propres identifiants, hors de ce dépôt.

**Liste des extensions autorisées.** `~/.config/coati/config.json`, clé
`allowedExtensionIds`, permissions `0600` (`config.ts:36-45`) — sert à la vérification d'`Origin`
(`checkOrigin()`, `server.ts:26-29,189`).

## 6. Ce que cette architecture interdit

- **Pas de veille en arrière-plan.** Le service worker n'ouvre le WebSocket que pour parler au
  broker sur `127.0.0.1` ; il ne fait aucune requête vers une page ni un service distant de sa
  propre initiative. Une fonctionnalité qui voudrait scruter des pages en tâche de fond, ou
  interroger le modèle sans clic, n'a pas de branchement dans ce schéma — il faudrait
  contourner la règle du geste (`CLAUDE.md`, règle 5), pas juste ajouter du code.
- **Le broker reste local, structurellement.** `hostname: "127.0.0.1"` est écrit en dur
  (`server.ts:171`) et toute la défense (`Origin` + jeton) suppose un attaquant venant du
  navigateur, pas d'un autre poste réseau. Ouvrir le broker à distance n'est pas une option de
  configuration : c'est un changement de modèle de menace, à documenter d'abord dans
  `PROTOCOL.md`.
- **Aucun canal d'exécution distante.** `parseClientMessage()` n'accepte qu'un `switch` fermé
  de types connus (`protocol.ts:212-264`) ; un type inconnu est rejeté (`bad-request`). Il n'y a
  pas de chemin où un message client ferait exécuter du code arbitraire côté broker.
- **Le modèle ne peut jamais agir sur une page.** Le protocole ne transporte que du texte dans
  un sens et dans l'autre — pas de coordonnées DOM, pas de commande de clic. Le panneau
  n'écrit jamais dans un onglet ; il affiche la réponse en Markdown restreint et échappé
  (`panel.js:391-398`). Une fonctionnalité « le modèle remplit ce formulaire » ne peut pas
  s'ajouter sans créer un tout nouveau canal — ce n'est pas un oubli à combler, c'est la
  frontière de la règle du geste.
- **Pas de mémoire de conversation côté broker.** Chaque `summarize`/`chat`/`act` produit un appel
  indépendant au fournisseur actif ; le broker ne garde aucun historique entre deux
  requêtes. Une fonctionnalité qui suppose que le broker « se souvient » du tour précédent sans
  que le panneau renvoie le contexte est fausse par construction.

## 7. Les points faibles que j'ai vus

- **Délai maximal d'un appel modèle et plafond de flux simultanés.** Un appel qui dépasse 120 s
  (`MODEL_TIMEOUT_MS`, `model.ts`) est abandonné et ressort en `model-unavailable` plutôt que de
  laisser le client sans `done` ni `error` indéfiniment ; un quatrième `chat`/`summarize`/`act`
  simultané sur la même connexion est refusé en `bad-request` (`MAX_CONCURRENT_STREAMS = 3`,
  `server.ts`) plutôt que de laisser un client spammer des appels fournisseur. Les deux limites
  sont documentées dans `PROTOCOL.md` « Limites côté broker ».
- **Fonctionnalités à moitié câblées.** `act` et `prompts.delete` marchent côté broker sans
  aucune façon de les déclencher depuis l'interface livrée — voir §4. Code mort en pratique,
  jusqu'à ce qu'un menu contextuel ou un bouton de suppression soit ajouté.
- **Désaccord de délai à la poignée de main.** Le broker ferme la connexion si `hello` n'arrive
  pas sous 3 s (`server.ts:193-195`), mais le service worker programme son propre délai
  d'attente de `hello-ok` à 5 s (`HELLO_TIMEOUT_MS`, `service-worker.js:13,91-95`). Comme le
  serveur ferme toujours en premier, ce délai de 5 s ne peut jamais se déclencher tel quel : la
  branche `setTimeout` de `service-worker.js:91-95` est du code mort en pratique, et rien ne
  distingue côté client « le serveur a fermé » de « la poignée de main est juste lente ».
- **Erreur WebSocket silencieuse.** L'écouteur `error` du WebSocket ne fait rien, avec le
  commentaire « the close event follows » (`service-worker.js:110-112`). C'est vrai selon la
  spécification, mais si cette hypothèse est un jour fausse (bug navigateur, cas limite), il n'y
  a aucune trace, aucun log — l'échec est complètement invisible.
- **Course sur `prompts.json`.** `savePrompt()` et `deletePrompt()` font chacun un
  lire-modifier-écrire non atomique (`prompts.ts:71-81,90-94`) : lecture complète du fichier,
  modification en mémoire, réécriture complète. Le broker accepte plusieurs connexions
  WebSocket (une par panneau ouvert) ; deux panneaux qui sauvegardent un prompt au même instant
  peuvent s'écraser l'un l'autre silencieusement — la deuxième écriture gagne, la première est
  perdue sans message d'erreur.
