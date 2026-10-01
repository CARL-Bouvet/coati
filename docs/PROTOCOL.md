# Coati — protocole extension ↔ broker

Contrat figé le 2026-09-16. **Les deux côtés se développent en parallèle contre ce document.**
Toute modification se fait ici d'abord, jamais dans un seul des deux camps.

Amendement 2026-09-20 : ajout de l'action `shorten` (Raccourcir) au message `act`, pour le menu
contextuel de sélection du panneau.

Amendement 2026-09-20 (2) : ajout de la route `GET /pair` et du message externe `wingpen:pair`,
pour l'appairage en un clic. *Le message externe et le bouton sont retirés par l'amendement
2026-09-25 ; `/pair` ne sert plus qu'à Firefox — voir « Page `/pair` » plus bas.*

Amendement 2026-09-20 (3) : ajout des messages `settings.get` / `settings.set` (et de la réponse
`settings`), pour choisir le fournisseur de modèle depuis la page d'options — voir « Fournisseur de
modèle » plus bas.

Amendement 2026-09-20 (4) : le broker accepte désormais aussi une origine `moz-extension://<uuid>`
(extension Firefox), en plus de `chrome-extension://<ID>` — voir « Poignée de main » plus bas, et
`docs/FIREFOX.md` côté extension.

Amendement 2026-09-21 : appairage silencieux pour une origine `chrome-extension://<ID>` déjà
présente dans `allowedExtensionIds` — le `hello` peut omettre `secret`, le broker en octroie alors
un directement dans `hello-ok`, sans passage par `/pair`. Ne s'applique jamais à `moz-extension://`
(Firefox, comportement inchangé). Voir « Poignée de main » et « Appairage silencieux » plus bas.
*Étendu par l'amendement 2026-09-25 aux uuid Firefox épinglés ; le jeton octroyé devient un jeton
de session.*

Amendement 2026-09-21 (2) : nouveau code d'erreur `auth-required` (task C3), distinct de
`model-unavailable`, pour le cas où un fournisseur détecte que la session ou les identifiants de
l'utilisateur ne sont plus valides — voir « Fournisseur de modèle » plus bas.

Amendement 2026-09-21 (3) : nouveau fournisseur `claude-api` (BYOK — l'utilisateur apporte sa
propre clé Anthropic), en HTTPS direct avec streaming SSE, aucune dépendance ajoutée côté broker.
`settings.set` gagne un champ `apiKey`, write-only de bout en bout ; la réponse `settings` gagne un
booléen `configured` par fournisseur ; nouveaux messages `settings.test` / `settings.test-result`
pour le bouton « Tester la connexion » du panneau d'options — voir « Fournisseur de modèle » plus
bas pour le détail des trois.

Amendement 2026-09-25 (appairage et connexion au modèle) : frontière de menace = le compte
utilisateur du système, appliquée par le code ; admission HTTP et WebSocket (`Host`, UID du pair) ;
`hello-ok.token` devient un jeton de session frais tenu en mémoire ; appairage silencieux étendu aux
uuid Firefox épinglés (liste relue à chaud) ; chemin « un clic » retiré, `/pair` réservé à Firefox ;
nouveau couple `provider.status` / `provider.status-result` ; port 8787 figé ; journalisation des octrois,
épinglages et refus ; les 11 écarts relevés par l'audit du jeton (`notes/audit_jeton_2026-09-25.md`
§5) résolus. Chaque passage touché porte la mention « Amendement 2026-09-25 ». **Là où ce texte
contredit le code, c'est le code qui se corrige** (lots 4 et 5).

Amendement 2026-09-25 (types de page) : le `context` d'une page gagne trois champs optionnels —
`pageKind` (`list` / `listing` / `article` / `other`), `facts` (paires « libellé : valeur »
affichées) et `items` (entrées visibles d'une liste de résultats) ; les couches superposées
(bandeaux de consentement, dialogues modaux) sont écartées avant toute mesure de densité ; un
budget de taille commun aux trois ; une consigne de résumé par type de page. Un client qui n'envoie
aucun de ces champs obtient exactement le comportement antérieur. Voir « Types de page, faits et
entrées » sous « Context », « Construction du prompt » et « Limites côté broker ». Motif : deux
défauts mesurés le 2026-09-25 (bandeau RGPD retenu à la place de la fiche ; sur une page de
résultats, une seule annonce gardée ; sur une fiche, les chiffres affichés perdus au profit de la
prose de l'agence). Code à suivre : lot L6 (extension), lot L7 (broker).

Amendement 2026-09-29 (ménage du dépôt public, goal G1b) : un fournisseur de modèle est soit
**intégré** au broker (`ollama`, `claude-api`, et depuis l'amendement 2026-09-30 bis
`openai-compat` — les trois seuls fournisseurs que ce dépôt embarque),
soit un **module externe** déclaré dans la configuration locale du broker
(`~/.config/coati/config.json`, clé `modules`), chargé au démarrage depuis un chemin de fichier —
jamais depuis l'extension ni une page (règle de sécurité n°3, `CLAUDE.md`). L'identifiant d'un
fournisseur (`provider`) est une **chaîne ouverte** : ni `settings.set` ni `settings.test` ne le
valident plus contre une liste fermée — seule sa forme (chaîne non vide, ASCII imprimable, courte)
est vérifiée ; c'est le broker, à l'exécution, qui sait si cet identifiant correspond à un
fournisseur connu. Chaque entrée de `available` (réponse `settings`) porte désormais un `label`
humain fourni par le fournisseur lui-même (intégré ou module) — c'est ce qui permet à l'extension
d'afficher un fournisseur pour lequel elle n'a aucun texte préécrit (voir « Libellés », plus bas).
Le fournisseur par défaut d'une configuration neuve est **`ollama`** (100 % local) — ce n'était pas
le cas avant cet amendement. **Un fournisseur configuré mais indisponible (module manquant, mal
formé, ou dont le chargement a échoué) est signalé comme indisponible ; il n'est jamais remplacé en
silence par un autre.** Interface complète qu'un module doit implémenter, et ce que le broker lui
fournit en retour (invite système, délai, classes d'erreur, journal) : `docs/MODULES.md`. Tout
passage touché par cet amendement porte la mention « Amendement 2026-09-29 ».

Amendement 2026-09-30 (Native Messaging, goal G4) : le broker tire une clé à chaque démarrage et
l'écrit dans un fichier 0600 ; un hôte natif `com.getcoati.broker`, que le navigateur ne lance que
pour l'ID épinglé de l'extension, la lui remet. La poignée de main WebSocket passe en `v: 2`,
défi-réponse HMAC dans les deux sens. L'appairage silencieux sur l'`Origin` seul disparaît ; `/pair`,
le collage du secret et la poignée de main `v: 1` passent derrière la clé `legacyPairing` de
`config.json`, éteinte par défaut. Motif : une autre extension peut réécrire l'`Origin` (prouvé le
25/09). Voir la section du même nom en fin de document.

Amendement 2026-09-30 ter (goal G6, langue) : le `hello` v: 2 gagne un champ
optionnel `lang` — la langue d'interface du navigateur, chaîne BCP 47 brute
telle que rendue par `chrome.i18n.getUILanguage()` (`"fr"`, `"en-US"`,
`"zh-CN"`…). Le broker la normalise une fois, à la poignée de main, vers l'une
de ses trois langues (`messages.ts`'s `normalizeLang()`) : `fr*` → `fr` ;
`zh*` dans ses variantes simplifiées (`zh`, `zh-CN`, `zh-Hans`, `zh-SG`,
`zh-Hans-*`) → `zh_CN` ; tout le reste, y compris `lang` absent ou les
variantes traditionnelles (`zh-Hant`, `zh-TW`, `zh-HK`, `zh-MO`) → `en`
(défaut). La langue négociée s'applique pour la durée de la connexion : elle
choisit la langue des messages humains du broker (`broker/src/messages.ts` —
table `code → { en, fr, zh_CN }`, un code stable par phrase) et instruit le
modèle de répondre dans cette langue, sauf demande explicite contraire de
l'utilisateur (voir « Construction du prompt »). Aucun message `hello` ne
force plus rien côté extension : `lang` est informatif, jamais vérifié contre
une liste fermée — une valeur absurde normalise silencieusement vers `en`.

Amendement 2026-09-30 bis (goal G5, fournisseur générique « Compatible OpenAI ») : troisième
fournisseur **intégré**, `openai-compat` — un seul adaptateur pour toute API qui parle le format
`/v1/chat/completions` d'OpenAI (LM Studio, Ollama via son `/v1`, OpenAI, Mistral, OpenRouter,
DeepSeek, et « Autre adresse »). `settings.set` gagne un champ `baseUrl` (adresse du serveur,
PAS un secret — voir plus bas pourquoi) ; la réponse `settings` l'expose donc en clair pour le
fournisseur actif, contrairement à `apiKey` qui reste write-only. `apiKey` devient optionnel pour
ce fournisseur (LM Studio, Ollama n'en demandent pas). Pas de nouveau message `settings.models` :
la liste des modèles réutilise le mécanisme existant de `settings`'s `models` (`ModelProvider.
listModels`, déjà utilisé par `ollama`) — `openai-compat` l'implémente via `GET {baseUrl}/models`.
Partout où ce document disait « les deux seuls fournisseurs que ce dépôt embarque » ou
équivalent, lire désormais « les trois ». Détail complet, y compris la contrainte de sécurité sur
`baseUrl` (HTTPS, ou HTTP loopback seulement) : voir « Fournisseur de modèle » plus bas.

Amendement 2026-10-01 (lot BROKER + PROTOCOL, goal U1) : deux nouveaux codes d'erreur,
`quota-exceeded` et `rate-limited`, distincts de `model-unavailable` et `auth-required` — voir
« Fournisseur de modèle » plus bas pour la classification exacte par fournisseur et « Codes
d'erreur » pour la liste complète. Une extension plus ancienne qui ne connaît pas ces deux codes
n'est pas cassée : son texte de repli générique pour un code inconnu (étiquette générique +
`message` du broker en détail secondaire) s'applique, comme pour tout code qu'elle ne reconnaît
pas déjà.

## Transport

WebSocket, `ws://127.0.0.1:8787/ws`.

**Pourquoi WebSocket et pas `fetch`** — Chrome applique désormais Local Network Access : une
requête HTTP vers `127.0.0.0/8` déclenche une demande de permission utilisateur, et un service
worker ne peut même pas la déclencher lui-même (il faut un accord préalable obtenu depuis un
document). Les WebSockets ne sont pas encore soumis à cette règle (crbug.com/421156866). C'est
une échappatoire datée : si elle se ferme, le repli est un canal `fetch` + prompt de permission
assumé, déclenché depuis le panneau (qui est un document, donc autorisé à demander).

Amendement 2026-09-25 (recherche du lot 1, note interne). Le paragraphe précédent
est dépassé pour les sites web : Chrome 147 et Firefox 154 soumettent aussi les WebSockets vers
loopback à Local Network Access, et crbug.com/421156866 est clos. Les **origines d'extension** ne
sont pas visées aujourd'hui : Coati se connecte sans permission d'hôte sur `127.0.0.1` (constaté
le 25/09 dans Brave 152). Aucune source ne garantit que cela durera. Si les navigateurs étendent la
règle aux extensions, deux voies : déclarer la permission d'hôte `http://127.0.0.1:8787/*`, ou
passer à Native Messaging, que Local Network Access ne concerne pas.

Le broker écoute **exclusivement** sur `127.0.0.1` — jamais `0.0.0.0`, jamais `::`, jamais une
interface réseau.

**Port — amendement 2026-09-25 : 8787, figé pour l'extension.** L'extension ne connaît que 8787 :
`WS_URL` du service worker et `connect-src` de la CSP des deux manifestes sont littéraux, et une CSP
de manifeste n'admet aucune variable. Un broker sur un autre port est donc injoignable, collage
manuel compris ; le protocole cesse de promettre le contraire.
- La clé `port` de `config.json` **n'est plus lue**. Si elle est présente avec une valeur différente
  de 8787, le broker écrit une ligne d'avertissement au démarrage et écoute quand même sur 8787.
- La variable d'environnement `COATI_PORT` reste, **pour les tests seulement** (serveurs de test
  sur un port libre). Quand elle est définie, le broker écrit au démarrage une ligne qui le dit :
  `coati-broker: COATI_PORT=<n> — mode test, l'extension ne se connectera pas`.
- Toutes les vérifications qui citent « le port » (liste `Host` ci-dessous) utilisent le port
  effectivement écouté.

## Frontière de menace

*Remplacé par défaut par l'amendement du 2026-09-30 (Native Messaging, en fin de document).*

Amendement 2026-09-25. Remplace la « Note honnête » du 2026-09-16, qui promettait « le compte
utilisateur » alors que le code laissait passer tout processus de la machine, y compris sous un
autre compte (audit du jeton, écart n°8).

**La frontière est le compte utilisateur du système d'exploitation sous lequel tourne le broker, et
le code l'applique.** Ce qui est arrêté, et par quoi :

| Adversaire | Arrêté par |
|---|---|
| Machine du réseau local | l'écoute sur `127.0.0.1` seulement |
| Page web hostile | l'en-tête `Origin`, imposé par le navigateur (voir « Poignée de main ») |
| Page web par *DNS rebinding* (`attacker.tld` résolu en `127.0.0.1`) | la liste `Host` (voir « Admission ») : sa requête porte `Host: attacker.tld:8787` |
| Processus d'un **autre compte** de la même machine | la vérification de l'UID du pair (Linux), voir « Admission » ; fichiers en 0600, dossiers en 0700 |
| Autre extension, Chromium | l'`Origin` : son origine est `chrome-extension://<autre ID>`, absente de `allowedExtensionIds` |
| Autre extension, Firefox | l'`Origin` tant que son uuid n'est pas épinglé ; épingler exige le secret permanent (voir « Poignée de main ») |

Fichiers du broker : `~/.config/coati/` et `~/.local/share/coati/` sont créés en **0700** et
remis à 0700 à chaque démarrage ; les fichiers qu'ils contiennent (`config.json`, `pairing.txt`,
`firefox-extension-uuids.txt`, prompts) en 0600, comme aujourd'hui.

**Ce qui reste accepté, écrit ici pour ne pas être redécouvert :**
- **Un processus qui tourne sous le même compte.** Il lit `pairing.txt` et `config.json`, charge
  `/pair`, ouvre un WebSocket brut avec l'`Origin` de son choix et obtient une session complète :
  exécuter le modèle sur l'abonnement ou la clé de l'utilisateur, changer de fournisseur, écraser la
  clé API, lire et effacer les prompts. Aucune mesure de ce protocole ne s'y oppose ; un tel
  processus peut de toute façon lire directement les fichiers du broker.
- **Hors Linux** (macOS, Windows), la vérification de l'UID du pair **n'est pas appliquée** : un
  processus d'un autre compte a le même accès qu'un processus du même compte. Le broker l'écrit une
  fois au démarrage (voir « Journalisation »).
- **Une autre extension Firefox munie d'une permission d'hôte sur `127.0.0.1`** peut lire `/pair`,
  donc le secret permanent, et s'épingler elle-même. Native Messaging, où le navigateur vérifie
  lui-même l'ID de l'extension, en est le vrai remède ; il n'est pas implémenté ici.
- **Réécriture de l'`Origin` d'un WebSocket par une autre extension** (Chrome
  `declarativeNetRequest`, Firefox `webRequest` bloquant) : **prouvé le 25/09 sur les deux
  navigateurs** (note interne). Une extension munie de ces permissions et d'une
  permission d'hôte sur `127.0.0.1` se fait passer pour Coati et obtient l'appairage silencieux.
  Aucune parade simple n'existe avec le WebSocket ; Native Messaging est le remède, décision à Romain.
- **Usurpation du port** : l'extension n'authentifie pas le broker. Un processus qui occupe
  `127.0.0.1:8787` pendant que le broker est arrêté reçoit le `hello` puis le texte des pages et
  les prompts. Depuis cet amendement, l'extension ne détient plus qu'un jeton de session (inutile
  après un redémarrage du broker) ; le secret permanent ne transite que dans le `hello` qui suit un
  collage Firefox.
- Conteneurs et applications isolées qui partagent l'espace réseau de l'hôte : ils sont vus avec
  leur UID ; s'il est égal à celui du broker, ils sont traités comme le même compte.

## Admission HTTP et WebSocket

*Complété par l'amendement du 2026-09-30 (Native Messaging, en fin de document).*

Amendement 2026-09-25. **Avant tout routage**, sur chaque requête HTTP — `/pair`, `/ws` avant la
montée en WebSocket, route inconnue comprise —, le broker applique dans cet ordre :

1. **En-tête `Host`.** Accepté seulement s'il vaut exactement, après passage en minuscules,
   `127.0.0.1:<port>` ou `localhost:<port>` (`<port>` = port écouté). Absent, vide, sans port, avec
   un autre port ou un autre nom : refusé. Pare le *DNS rebinding*.
2. **UID du pair (Linux).** Le broker prend l'adresse et le port source de la connexion
   (`server.requestIP(req)` sous Bun), cherche dans `/proc/net/tcp` la ligne dont
   `local_address` est ce couple et `rem_address` est `127.0.0.1:<port>` (adresses en hexadécimal
   petit-boutiste, format du noyau), et compare sa colonne `uid` à `process.getuid()`. Différent :
   refusé. **Ligne introuvable ou fichier illisible : refusé** (on échoue fermé). Si l'adresse du
   pair est une adresse IPv6 (`::ffff:127.0.0.1`), la recherche se fait aussi dans `/proc/net/tcp6`.
   Hors Linux : pas de vérification ; une seule ligne au démarrage, voir « Journalisation ».

Refus à l'étape 1 ou 2 : réponse `403`, corps `forbidden` en `text/plain`, rien d'autre (ni jeton,
ni raison), une ligne de journal. Aucune montée en WebSocket n'a lieu.

Puis le routage (remplace la phrase « tout le reste répond 404 », fausse pour `/ws` — audit, écart
n°10) :

| Requête | Réponse |
|---|---|
| `GET /pair` | `200 text/html` — voir « Page `/pair` » |
| `/pair` avec une autre méthode | `405`, en-tête `Allow: GET` |
| `/ws` avec en-têtes de montée WebSocket | `101`, puis « Poignée de main » |
| `/ws` sans montée | `400` `expected websocket upgrade` |
| toute autre route | `404` `not found` |

**Aucune route HTTP ne modifie l'état du broker.** `GET /pair` est en lecture seule. La révocation
d'un uuid Firefox et la rotation du secret permanent se font à la main, dans les fichiers (voir
« Poignée de main »), jamais par une requête.

## Poignée de main

*Remplacé par défaut par l'amendement du 2026-09-30 (Native Messaging, en fin de document).*

Après l'admission HTTP ci-dessus, à l'ouverture du WebSocket, le broker vérifie **dans cet
ordre**, et ferme la connexion au premier échec (code 4401, raison **générique** `unauthorized` —
amendement 2026-09-25 : le texte disait « raison en clair », ce qui contredisait le paragraphe
« Échec de poignée de main » plus bas ; c'est ce dernier qui fait foi, audit écart n°3) :

1. En-tête `Origin` strictement égal à l'une de ces formes :
   - `chrome-extension://<ID>` où `<ID>` est dans la config du broker
     (`~/.config/coati/config.json`, clé `allowedExtensionIds`, tableau) — origine **autorisée** ;
   - `moz-extension://<uuid>` où `<uuid>` figure dans la liste des uuid Firefox épinglés — origine
     **épinglée** (voir « Cas Firefox » ci-dessous) ;
   - `moz-extension://<uuid>` absent de la liste — origine **provisoire** : admise jusqu'à l'étape 2,
     mais seul le secret permanent peut l'authentifier (et l'épingler).

   Toute autre origine, ou une origine absente, est refusée ici, avant la lecture de tout secret.
   `allowedExtensionIds` n'est lu qu'au démarrage : ajouter un ID demande un redémarrage du broker
   (inchangé). La liste des uuid Firefox, elle, est **relue sur disque à chaque ouverture de
   WebSocket** (amendement 2026-09-25).

   L'ID d'une extension non empaquetée est dérivé par Chrome du chemin de son dossier — il change
   si le dossier bouge, ce qui casse silencieusement le pairing (`checkOrigin()` ne matche plus
   rien). Pour l'éviter, l'extension embarque une clé publique fixe (`extension/manifest.json`,
   champ `key`, RSA 2048 en DER/base64) : Chrome dérive alors l'ID de cette clé, indépendamment du
   dossier. L'ID en résultant, `hehlgipomfminodhahcjbencblepjhah`, est celui présent par défaut
   dans `allowedExtensionIds` (`broker/src/config.ts`). La clé privée correspondante vit dans
   `~/.config/coati/extension-key.pem` (droits 600), hors de tout dépôt, jamais commitée — sa
   perte oblige à régénérer une paire et à republier l'extension sous un nouvel ID.
2. Premier message client = `{"type":"hello","v":1}` avec un champ `secret` **facultatif**, dans
   les **3 secondes**. Amendement 2026-09-25 — `secret`, s'il est présent, est l'un des deux :
   - le **secret permanent** : écrit par le broker dans `~/.local/share/coati/pairing.txt` au
     premier démarrage (128 bits aléatoires, 32 caractères hexadécimaux, 0600) ; comparé en temps
     constant ;
   - un **jeton de session** : délivré par un `hello-ok` précédent de ce même broker (voir
     ci-dessous).

   Décision du broker :

   | Origine (étape 1) | `hello` sans `secret` | secret permanent valide | jeton de session valide | autre valeur |
   |---|---|---|---|---|
   | autorisée (`chrome-extension://`) | octroi silencieux | octroi | octroi | octroi **silent-renew** (jeton frais) |
   | épinglée (`moz-extension://`) | octroi silencieux | octroi | octroi | octroi **silent-renew** (jeton frais) |
   | provisoire (`moz-extension://`) | refus | octroi **et épinglage** | refus | refus |

   Un jeton de session n'est valide que s'il a été délivré **à la même origine** et que cette
   origine est encore autorisée ou épinglée au moment du `hello`. Un jeton de session n'épingle
   jamais rien.

**Réponse — amendement 2026-09-25 (`models`/`capabilities` retirés le 26/09 bis, voir annexe).**
Tout octroi, quel qu'en soit le chemin, répond :
`{"type":"hello-ok","v":1,"token":"<jeton de session>"}`.
`token` est désormais **toujours présent** :
- jeton de session **frais** si le `hello` n'en portait pas (sans `secret`, ou avec le secret
  permanent) ; c'est ce que ce document promettait déjà, le code renvoyait le secret permanent
  (audit, écart n°1) ;
- le **même** jeton si le `hello` présentait un jeton de session valide (pas de rotation à chaque
  reconnexion) ;
- jeton de session **frais** (`via=silent-renew`) si l'origine est autorisée ou épinglée et que le
  `hello` présentait une autre valeur qu'un jeton de session valide (jeton périmé, faux, ou secret
  invalide) — voir « Appairage silencieux », amendement quater.

**Jeton de session.** 256 bits d'un générateur cryptographique (`randomBytes(32)`), 64 caractères
hexadécimaux — la longueur le distingue du secret permanent. Tenu **en mémoire seulement** par le
broker, jamais écrit sur disque : **un redémarrage du broker invalide tous les jetons de session.**
Le broker range chaque jeton sous son empreinte SHA-256 (la recherche ne dépend pas des premiers
caractères présentés), avec l'origine à laquelle il a été délivré, dans l'ordre de dernier usage. Au
plus 64 jetons ; au-delà, le moins récemment utilisé est oublié. Pas d'autre expiration.
L'extension range le jeton reçu dans `chrome.storage.session` sous la clé `pairingToken`, **à la
place** de ce qui s'y trouvait — en particulier, un secret permanent collé à la main est remplacé
par le jeton de session dès le premier `hello-ok`, et ne séjourne donc plus dans l'extension.

**Cas Firefox — amendement 2026-09-25 (remplace le passage du 2026-09-20).** L'origine est
`moz-extension://<uuid>`, où `<uuid>` est tiré au sort par Firefox à **chaque installation**
(`browser_specific_settings.gecko.id` ne l'influence pas). Le broker ne peut pas le connaître à
l'avance ; il l'apprend :
- **Épinglage.** Une origine provisoire qui présente le secret permanent valide est authentifiée,
  et son uuid est ajouté à la liste des uuid épinglés. Épingler exige le secret permanent ; rien
  d'autre ne l'accorde.
- **Liste, pas valeur unique.** Plusieurs uuid peuvent être épinglés (deux profils Firefox, une
  réinstallation, un chargement temporaire) ; le premier épinglé n'exclut pas les suivants.
- **Fichier.** `~/.local/share/coati/firefox-extension-uuids.txt`, 0600. Une entrée par ligne :
  `<uuid> <épinglé-le> <vu-le>`, séparés par une espace, uuid en minuscules, dates en ISO 8601 UTC
  (`2026-09-25T14:03:00Z`). Lignes vides et lignes commençant par `#` ignorées ; ligne malformée
  ignorée, avec une ligne de journal.
- **Relu à chaud.** Le broker relit le fichier à chaque ouverture de WebSocket : une modification
  à la main prend effet à la connexion suivante, **sans redémarrage** (audit, écart n°9). Les
  connexions déjà ouvertes ne sont pas coupées ; pour les couper, redémarrer le broker.
- **`vu-le`** est mis à jour à chaque octroi pour cet uuid. Toute écriture relit d'abord le fichier,
  modifie, puis écrit dans un fichier temporaire renommé par-dessus (atomique), en 0600 ; une
  entrée supprimée à la main n'est jamais recréée par une mise à jour de `vu-le`.
- **Plafond : 16 uuid.** Épingler un 17e oublie l'entrée au `vu-le` le plus ancien, avec une ligne
  de journal (`evict`).
- **Révocation** : supprimer la ligne. **Rotation du secret permanent** : supprimer `pairing.txt`
  et redémarrer le broker (tous les jetons de session tombent avec le redémarrage ; les uuid
  épinglés restent épinglés).
- **Migration.** Retirée (voir amendement du 26/09 ci-dessous, item 6) : aucune installation
  n'utilise plus l'ancien format `firefox-extension-uuid.txt` (valeur unique).

**Ce que ça donne à l'usage (remplace « le colle une fois », audit écart n°6) :**
- Chromium (ID autorisé) : aucun collage, jamais.
- Firefox, extension **installée** (signée, non listée — voir `docs/FIREFOX.md`) : l'uuid est
  stable d'un redémarrage à l'autre. Un collage du secret permanent **par installation** ; ensuite
  appairage silencieux, y compris après un redémarrage du navigateur ou du broker.
- Firefox, extension **chargée temporairement** (`about:debugging`) : elle disparaît à la fermeture
  de Firefox et doit être rechargée. Si elle déclare un ID gecko (c'est le cas de Coati), son
  uuid **reste le même** d'un chargement à l'autre et après un redémarrage, sur un même profil
  (prouvé le 25/09, note interne) : un seul collage **par profil**, puis
  l'appairage silencieux reconnaît l'uuid épinglé.

### Appairage silencieux

*Remplacé par défaut par l'amendement du 2026-09-30 (Native Messaging, en fin de document).*

Amendement 2026-09-21. Problème : le jeton vit en `chrome.storage.session` (règle de sécurité n°1,
non négociable — jamais `storage.local`), donc il est effacé à **chaque** redémarrage du
navigateur, et sans ça l'utilisateur devait rouvrir `/pair` et cliquer à chaque fois. Trop de
friction pour un geste qui ne protège déjà rien de plus, une fois l'extension déjà connue.

Si le premier message du client est `{"type":"hello","v":1}` (sans `secret`) **et** que son
`Origin` est autorisée (`chrome-extension://<ID>` avec `<ID>` dans `allowedExtensionIds`) ou —
amendement 2026-09-25 — **épinglée** (`moz-extension://<uuid>` avec `<uuid>` dans la liste des
uuid Firefox), le broker octroie directement un jeton de session frais dans `hello-ok.token`.

Une origine qui n'est ni autorisée ni épinglée ne reçoit rien ici :
- un `chrome-extension://<ID>` inconnu est refusé **dès l'étape 1**, avant la lecture de tout
  secret. Ni `/pair` ni un collage ne peuvent le repêcher (le texte d'avant disait qu'il
  « retombe sur le flux `/pair` » : c'était faux, audit écart n°4). Le seul remède est d'ajouter
  l'ID à `allowedExtensionIds` puis de redémarrer le broker ;
- un `moz-extension://<uuid>` non épinglé (provisoire) doit présenter le secret permanent : la
  première utilisation reste un geste humain délibéré.

**Pourquoi ça ne réduit pas la protection.** Une page web ne peut pas forger l'en-tête `Origin` —
c'est le navigateur qui l'impose — donc un site hostile reste bloqué. Un programme qui tourne sous
le compte de l'utilisateur peut usurper l'origine de l'extension, mais il peut aussi lire
`pairing.txt` : il est dans la frontière acceptée (voir « Frontière de menace »). Un programme d'un
autre compte est arrêté avant, à l'admission (UID du pair, Linux). Pour Firefox, l'uuid épinglé est
connu du broker exactement comme un ID Chromium l'est d'avance : l'ancien motif d'exclusion (« il
n'y a jamais de moment où le broker pourrait le reconnaître d'avance ») tombe une fois l'uuid
épinglé.

**Côté extension — amendement 2026-09-25** (`background/service-worker.js`) :
- À froid (pas de `pairingToken` en `chrome.storage.session`), `connectIfNeeded()` ouvre le
  WebSocket et envoie `hello` **sans** `secret` (inchangé).
- Avec un `pairingToken` en mémoire, il l'envoie dans `hello.secret`.
- À chaque `hello-ok`, il range `hello-ok.token` dans `pairingToken` (remplacement).
- **Jeton refusé.** Si la connexion se ferme avec le code `4401` pendant la poignée de main
  **alors qu'un `secret` a été envoyé** : effacer `pairingToken`, puis retenter **aussitôt, une
  seule fois, sans `secret`**. Cet unique nouvel essai est permis **une fois par cycle de
  connexion** — un cycle va d'une déconnexion au `hello-ok` suivant ; le drapeau se remet à zéro
  sur `hello-ok`. S'il échoue aussi, l'état devient `"no-token"` et la reconnexion reprend son
  rythme habituel (backoff, alarme de 30 s). C'est ce qui rattrape un redémarrage du broker (jetons
  de session perdus) sans boucle infinie ni geste de l'utilisateur (audit §2, « Token rotation »).
  L'effacement est **attendu** avant le nouvel essai : sans cela, l'extension relisait le jeton
  périmé et enchaînait les refus (journal du broker, 25/09 à 8 h 48).
- **Amendement 2026-09-25 (quater) — côté broker, un jeton périmé ne ferme plus la porte à une
  origine connue.** Une origine éligible à l'appairage silencieux (ID Chromium autorisé, uuid
  Firefox épinglé) qui présente un `secret` invalide (jeton de session perdu au redémarrage du
  broker, ou valeur fausse) reçoit un **jeton de session frais**, comme si elle n'avait rien
  envoyé. Refuser n'apportait aucune protection, puisque la même origine obtient un jeton sans
  secret. En revanche, cela forçait Romain à recoller le secret après chaque redémarrage du
  broker (25/09). Seule une origine **non encore approuvée** (uuid Firefox provisoire) voit encore
  un `secret` faux refusé. Le journal note `grant via=silent-renew`.
- Refus sans `secret` envoyé : état `"no-token"`, comme avant.
- **Collage (options, Firefox).** Le champ est en écriture seule : jamais pré-rempli avec le jeton
  en mémoire. Coller une valeur non vide la range dans `pairingToken` et déclenche une reconnexion
  **immédiate**, qui annule le délai de backoff en cours. Coller une chaîne vide efface
  `pairingToken` (au lieu de ranger `""`).
- **Bandeau `"no-token"`**, reformulé :
  - sous Chromium, il dit que l'ID de cette extension (`chrome.runtime.id`, affiché) n'est pas
    dans `allowedExtensionIds` du broker, et qu'il faut l'y ajouter puis redémarrer le broker.
    **Aucun lien vers `/pair`** ;
  - sous Firefox, il renvoie vers `http://127.0.0.1:8787/pair` pour copier le secret permanent,
    et vers les options pour le coller.

**Échec de poignée de main : un seul message générique.** Quel que soit l'échec (mauvais `Origin`,
mauvais secret ou jeton de session, premier message qui n'est pas un `hello` valide — message de
plus de 256 Ko compris —, pas de `hello` dans les 3 s), le broker envoie exactement
`{"type":"error","id":"hello","code":"unauthorized","message":"unauthorized"}` puis ferme en 4401
avec la même raison générique. Un programme local qui teste la poignée de main ne peut pas
distinguer laquelle des vérifications a échoué — la raison précise part seulement dans le
journal du broker (voir « Journalisation »).

## Page `/pair` (Firefox seulement)

*Remplacé par défaut par l'amendement du 2026-09-30 (Native Messaging, en fin de document).*

Amendement 2026-09-25 — remplace « Appairage en un clic » (2026-09-20 (2)).

**`GET /pair`**, après l'admission (`Host`, UID du pair), répond `200 text/html; charset=utf-8`,
une page générée côté serveur (`broker/src/pair.ts`) qui sert **uniquement** à épingler une
extension Firefox. Elle contient, échappés :
- le **secret permanent** (contenu de `pairing.txt`), à copier puis coller dans les options de
  l'extension Firefox ;
- la **liste, en lecture seule, des uuid Firefox épinglés**, avec `épinglé-le` et `vu-le`, et le
  chemin du fichier où les révoquer à la main ;
- une phrase qui dit que Chromium n'a pas besoin de cette page.

Elle ne contient **aucun ID d'extension, aucun bouton, aucun script** (le texte d'avant disait que
seul le premier ID était injecté, le code les injectait tous : la question disparaît avec eux,
audit écart n°2). Le secret est présenté dans un bloc de texte sélectionnable ; la copie se fait
à la main.

En-têtes de la réponse :
- `Cache-Control: no-store` ;
- `Referrer-Policy: no-referrer` ;
- `Content-Security-Policy: default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'`
  (aucun script ne peut s'exécuter dans la page, et elle ne peut pas être encadrée) ;
- `X-Content-Type-Options: nosniff` ;
- `Cross-Origin-Resource-Policy: same-origin`.

Amendement 2026-09-25 ter (revue de sécurité, L5). `/pair` n'est servie qu'à une navigation de
premier niveau : `Sec-Fetch-Mode: navigate` **et** `Sec-Fetch-Dest: document`, sinon `403`. Un
`fetch()` depuis le service worker d'une autre extension munie d'une permission d'hôte sur
`127.0.0.1` n'obtient donc plus le secret. Défense en profondeur seulement : une extension qui ouvre
un onglet sur `/pair` et y injecte un script de contenu le lit encore ; seul Native Messaging ferme
ce chemin. Un outil en ligne de commande qui veut le secret lit `pairing.txt`.

Aucune en-tête CORS : une page d'une autre origine ne peut pas lire la réponse. Elle n'est **pas**
une page d'extension : la CSP des manifestes ne s'y applique pas, d'où le `<style>` en ligne.

L'extension n'ouvre `/pair` que sous Firefox (bandeau `"no-token"`, page d'options). Sous
Chromium, aucun lien n'y mène.

### Chemin « un clic » retiré

Amendement 2026-09-25. Sont supprimés : le bouton « Connecter Wingpen » de `/pair`, le message
externe `wingpen:pair`, l'écouteur `chrome.runtime.onMessageExternal` du service worker et la clé
`externally_connectable` de `manifest.json`.

Pourquoi : ce chemin ne servait plus à rien et exposait une surface.
- Pour un ID **autorisé**, l'appairage silencieux donne déjà un jeton sans geste.
- Pour un ID **inconnu**, le broker refuse la connexion à l'étape `Origin`, avant de lire le
  moindre jeton (audit jeton §5, point 4) : le jeton transmis en un clic ne pouvait donc jamais
  servir.
- `externally_connectable` ne peut viser qu'un port littéral (`http://127.0.0.1:8787/*`), et
  ouvrait à toute page servie sur ce port — donc à un processus qui l'occuperait — un canal de
  messages vers le service worker.
- Firefox n'a jamais eu ce chemin (`externally_connectable` est absent de `manifest.firefox.json`).

Le paragraphe « Limitation connue — le port ne peut pas être dynamique » disparaît avec lui : le
port est figé (voir « Transport »). Il reste en dur dans `background/service-worker.js`
(`BROKER_PORT`, `WS_URL`), dans `panel/panel.js` (lien `/pair`, Firefox) et dans la CSP
`connect-src` des deux manifestes.

## Messages client → broker

Tout message porte un `id` (chaîne, unique par requête, généré côté extension) et un `type`.

```jsonc
// Conversation libre. `context` est optionnel.
{ "type": "chat", "id": "c1", "text": "...", "context": { /* voir Context */ } }

// Résumé d'une page ou d'une vidéo. Le broker choisit la stratégie selon context.kind.
// `length` retiré le 26/09 (bis, voir annexe) : comportement fixé sur l'ancien "medium".
{ "type": "summarize", "id": "c2", "context": { /* voir Context */ } }

// Action sur la sélection de l'utilisateur. Déclenché depuis le menu
// contextuel du navigateur (clic droit sur une sélection) : Reformuler →
// rewrite, Raccourcir → shorten, Expliquer → explain, Traduire → translate.
{ "type": "act", "id": "c3", "action": "translate" | "rewrite" | "explain" | "shorten",
  "text": "...", "params": { "targetLang": "fr" } }

// Bibliothèque de prompts et préférences par site (stockées côté broker).
// Voir « Bibliothèque de prompts et préférences par site » plus bas.
{ "type": "prompts.list", "id": "c4" }
{ "type": "prompts.save", "id": "c5", "prompt": { "id": "p_1a2b3c4d5e6f", "site": "@youtube", "title": "...", "body": "..." } }
{ "type": "prompts.save", "id": "c5b", "prompt": { "site": "*", "body": "..." } } // sans id : création
{ "type": "prompts.delete", "id": "c6", "promptId": "p_1a2b3c4d5e6f" }
{ "type": "prompts.move", "id": "c6b", "promptId": "p_1a2b3c4d5e6f", "site": "crisco4.unicaen.fr", "order": ["p_1a2b3c4d5e6f", "coati:youtube:key-points"] }
{ "type": "prefs.get", "id": "c6c" }
{ "type": "prefs.set", "id": "c6d", "site": "@youtube", "prefs": { "order": ["coati:youtube:key-points", "p_1a2b3c4d5e6f"], "removed": ["coati:youtube:further"] } }

// Annulation d'une requête en cours.
{ "type": "cancel", "id": "c7", "target": "c2" }

// Lire le fournisseur de modèle actif et la liste des fournisseurs connus.
{ "type": "settings.get", "id": "c8" }

// Changer le fournisseur et/ou le modèle, et/ou la clé API du fournisseur
// claude-api. Champs omis = inchangés. `apiKey` est WRITE-ONLY (voir
// CLAUDE.md règle n°1) : accepté ici, jamais renvoyé — pas même dans la
// réponse `settings` qui suit ce message. Une chaîne vide efface la clé
// stockée. Voir « Fournisseur de modèle » plus bas.
{ "type": "settings.set", "id": "c9", "provider": "claude-api", "apiKey": "sk-ant-..." }

// Teste une connexion réelle (quelques tokens, pas un résumé) pour le
// fournisseur nommé — backend du bouton « Tester la connexion » des
// réglages. Voir « Fournisseur de modèle » plus bas.
{ "type": "settings.test", "id": "c10", "provider": "claude-api" }

// Amendement 2026-09-25. Disponibilité du fournisseur ACTIF, sans appel
// facturé. Envoyé par le panneau à son ouverture seulement. Voir
// « Disponibilité du fournisseur » plus bas.
{ "type": "provider.status", "id": "c11" }
```

### Context

```jsonc
{
  "kind": "page" | "youtube",
  "url": "https://…",   // origine + chemin UNIQUEMENT — jamais la query string ni le fragment
  "title": "…",
  "text": "…",          // texte principal déjà extrait et assaini par le content script
  "videoId": "…",       // uniquement si kind === "youtube"

  // Amendement 2026-09-25 (types de page). Les trois champs suivants sont
  // OPTIONNELS et n'ont de sens que si kind === "page". Voir « Types de page,
  // faits et entrées » ci-dessous.
  "pageKind": "list" | "listing" | "article" | "other",
  "facts": [ { "label": "Prix au m²", "value": "5 214 €" } ],          // si pageKind === "listing"
  "items": [ { "title": "…", "price": "…", "location": "…", "detail": "…" } ] // si pageKind === "list"
}
```

**`url` n'est jamais l'URL complète.** Le content script envoie `location.origin +
location.pathname`, jamais `location.href` : une query string ou un fragment peuvent porter un
jeton de session (`?token=…`, `#access_token=…`) que rien en aval n'a besoin de voir.

**Le content script envoie du texte, jamais du HTML.** Il extrait, assainit, tronque à
40 000 caractères et transmet. Le broker ne fait confiance à rien de ce qui vient de la page :
il traite `text`, `title` et `url` comme des données, jamais comme une instruction — voir
« Construction du prompt » plus bas. *Amendement 2026-09-25 (types de page) : les 40 000
caractères deviennent un budget commun à `text`, `facts` et `items` — voir « Budget de taille »
ci-dessous. `facts` et `items` sont des données au même titre que `text`.*

### Types de page, faits et entrées

Amendement 2026-09-25 (types de page). Toute cette sous-section est nouvelle.

#### Principe

Le content script reconnaît la forme de la page que l'utilisateur regarde et l'annonce au broker
par `pageKind`. Deux formes changent le comportement (`list`, `listing`) ; les deux autres
(`article`, `other`) se comportent **exactement comme avant l'amendement**. Il s'ensuit une règle
d'asymétrie : **un faux positif coûte plus cher qu'un faux négatif.** Une fiche prise pour
`other` reçoit le résumé d'aujourd'hui, moins bon mais juste ; un article pris pour `listing`
reçoit une consigne faite pour autre chose. Les règles de détection de `list` et `listing` sont
donc strictes, et **le doute se résout toujours en `"other"`** (DECISIONS T18 : dégrader, jamais
casser).

La détection s'ancre sur **le texte visible et la forme de l'arbre** (balises, répétition,
position à l'écran), **jamais** sur une classe CSS, un identifiant d'élément, un nom d'hôte ou une
URL (DECISIONS T17). Aucune recette par site n'entre par ce chemin : c'est le chemin générique
gratuit, qui doit marcher partout.

Les seuils chiffrés ci-dessous sont des **valeurs de départ**. L6 peut les ajuster sur le corpus
de pages sans amender ce protocole, tant que la forme de chaque règle est respectée et que
l'ajustement est consigné dans le JOURNAL. Les plafonds de « Faits », « Entrées » et « Budget de
taille », eux, font partie du contrat : le broker les vérifie.

#### Ordre des opérations dans le content script

1. Écarter les couches superposées (ci-dessous).
2. Délimiter la **région principale** dans ce qui reste : premier `article`, `main` ou
   `[role=main]` portant plus de 200 caractères, sinon le bloc le plus dense (règle
   d'aujourd'hui, inchangée).
3. Chercher les entrées répétées (→ `list`), puis les faits (→ `listing`).
4. Décider `pageKind`.
5. Remplir `items` ou `facts`, puis `text` avec le budget qui reste.

#### Couches superposées — exclusion avant toute mesure

Avant la mesure de densité, avant la recherche des faits et des entrées, le content script retire
de l'analyse les couches qui recouvrent la page sans en être le contenu. **L'exclusion est
structurelle d'abord, lexicale ensuite.**

*Signaux structurels, suffisants seuls :*

- `role="dialog"`, `role="alertdialog"`, `aria-modal="true"`, élément `<dialog>` ouvert ;
- élément dont le style calculé est `position: fixed` ou `position: sticky` et dont le rectangle
  affiché couvre **au moins 30 %** de la surface du viewport.

*Signaux structurels faibles, qui exigent une confirmation lexicale :*

- élément `fixed` ou `sticky` collé au bord haut ou bas du viewport et large d'au moins 80 % de sa
  largeur (le bandeau de consentement en bas d'écran).

*Confirmation lexicale* : le texte visible du conteneur contient au moins un mot du lexique de
consentement — `cookie(s)`, `consentement`, `vie privée`, `confidentialité`, `RGPD`, `traceurs`,
`partenaires`, `consent`, `privacy`, `GDPR` — **et** un contrôle cliquable (`button`, `a`,
`[role=button]`) dont le texte visible est un mot d'acceptation ou de refus : `Accepter`,
`Tout accepter`, `J'accepte`, `Refuser`, `Tout refuser`, `Continuer sans accepter`,
`Paramétrer`, `Accept`, `Agree`, `Reject`.

*Exclusion lexicale seule* (conteneur ni modal ni fixe) : permise seulement si les trois
conditions tiennent — confirmation lexicale ci-dessus, texte visible de moins de 1 500
caractères, et le conteneur ne contient ni le `h1` de la page ni la région principale. Sans
cette garde, un article **sur** les cookies serait effacé de lui-même.

Le lexique est un **indice**, pas une recette de site : il ne nomme aucun éditeur, aucune
plateforme de consentement, aucune classe. Il est court exprès ; l'étendre ne demande pas
d'amendement, le transformer en liste de sélecteurs par site en demanderait un (et contredirait
T17).

*Une couche peut être le contenu.* Sur beaucoup de sites de petites annonces, cliquer un résultat
ouvre la fiche **dans une modale**. Règle : un dialogue ou un élément fixe qui couvre au moins
30 % du viewport, porte au moins 500 caractères de texte visible et **ne** reçoit **pas** la
confirmation lexicale est le contenu que l'utilisateur regarde — l'extraction se restreint alors
à lui, et le reste de la page est ignoré. S'il y en a plusieurs, le plus haut dans l'empilement
(le dernier dans l'ordre du document, à défaut de mieux).

*Pourquoi la position CSS ne décide jamais seule — mesuré le 25/09.* Sur la page de résultats de
bienici, l'élément `position: fixed` de la page est `DIV#searchSideView`, 4 535 caractères : c'est
le panneau qui contient les annonces. Sur une fiche, l'élément fixe est la carte de contact de
l'agence. Une règle « fixe, donc superposé, donc écarté » supprimerait la liste des résultats.
D'où la confirmation lexicale, et la règle « une couche peut être le contenu » ci-dessus. Relevés
dans `notes/corpus/observations.md`.

*Garde-fou* : si, après exclusion, la page ne porte plus 200 caractères de texte visible, le
content script annule l'exclusion et reprend la page entière (comportement d'aujourd'hui), avec
`pageKind: "other"`.

Les éléments exclus ne sont ni envoyés, ni mesurés, ni lus pour `facts` ou `items`. Rien n'est
cliqué, fermé ni masqué dans la page : l'exclusion est une lecture, pas une action (règle du
geste).

#### Définition et détection de chaque type

Évaluation dans l'ordre `list`, `listing`, `article`, `other` ; le premier qui répond l'emporte.

**`list`** — une page de résultats : plusieurs objets comparables, chacun résumé en quelques
lignes et menant ailleurs (recherche d'annonces, catalogue, résultats de moteur interne).
Détection, toutes conditions requises :

- dans la région principale — ou, si la région principale est elle-même une entrée, dans son
  plus proche ancêtre qui en contient plusieurs — un conteneur a **au moins 5 enfants de même
  forme** : même balise, même suite de balises enfants sur deux niveaux (la forme de l'arbre, pas
  les classes) ;
- chacun de ces enfants contient un lien (`a[href]`) et porte entre 20 et 1 000 caractères de
  texte visible ;
- au moins la moitié d'entre eux contient une **valeur chiffrée** : un nombre suivi ou précédé
  d'une devise (`€`, `EUR`, `$`, `£`) ou d'une unité (`m²`, `m2`, `km`, `pièces`, `p.`, `ch.`) ;
- le texte cumulé de ces enfants fait **au moins 50 %** du texte visible de la région principale ;
- aucun bloc de faits (≥ 4 faits, voir `listing`) n'existe **hors** de ces enfants.

La dernière condition écarte la fiche suivie d'un carrousel « annonces similaires » : elle est
une `listing`, et le carrousel n'est ni un fait ni une entrée.

**`listing`** — une fiche : la page d'un seul objet (bien immobilier, produit, véhicule, offre
d'emploi), qui en affiche les caractéristiques sous forme « libellé : valeur » et en général un
texte descriptif rédigé par le vendeur. Détection, toutes conditions requises :

- pas `list` ;
- au moins **4 faits** trouvés (voir « Faits » ci-dessous) hors des couches exclues ;
- au moins un de ces faits, ou une ligne à moins de 3 éléments du `h1`, porte une valeur
  chiffrée au sens ci-dessus.

Une infobox d'encyclopédie a souvent 4 faits mais rarement un prix ou une surface ; c'est la
raison de la troisième condition. Un `og:type` égal à `product` est un indice concordant, jamais
une condition suffisante.

**`article`** — un texte suivi à lire : article de presse, billet, documentation, tutoriel.
Détection : les signaux qui existent déjà (`article`, `[role=main]`, `og:type` = `article`, ou
plus de 1 200 caractères de prose dans la région principale — cf. `extension/content/detect.js`).
Ne change aucun comportement : sa seule utilité est l'étiquette (libellé du bouton côté panneau).

**`other`** — tout le reste, **et tout cas douteux** : deux règles qui se contredisent, un seuil
atteint de justesse, une exception pendant la détection, un DOM inattendu. Le content script
envoie alors `pageKind: "other"`, sans `facts` ni `items`, et le `text` d'aujourd'hui (après
exclusion des couches). Une exception levée dans la détection ou l'extraction des faits et
entrées est rattrapée et ramène à `"other"` ; elle ne fait jamais échouer l'extraction.

#### Corrections mesurées sur des pages réelles

Amendement 2026-09-25 (bis). La première implémentation passait ses tests sur un faux DOM et
échouait sur les vraies pages. Sonde : `notes/corpus/apres/` et `notes/corpus/observations.md`.
Ces quatre règles **précisent** celles qui précèdent et l'emportent en cas de doute.

1. **« Le plus proche ancêtre qui en contient plusieurs » se cherche en remontant**, sur six
   niveaux au plus. Sur la page de résultats de bienici, la région principale est l'annonce mise
   en avant (3 253 caractères), rangée dans un encart de 3 annonces. Le conteneur des résultats
   est deux niveaux plus haut : `search-results-list`, 25 enfants, dont 24 `article` de même
   forme. S'arrêter au parent direct manque la liste.
2. **Une entrée hors bornes est écartée seule, elle ne condamne pas le groupe.** Une annonce mise
   en avant qui porte toute sa description dépasse 1 000 caractères. Le groupe reste valable s'il
   garde au moins 5 entrées dans les bornes.
3. **« Aucun bloc de faits hors de la liste » se juge hors du conteneur de la liste, pas hors de
   ses entrées.** La description de l'annonce mise en avant contient des lignes « libellé :
   valeur » (« Taxes foncières : 503 € »). Elle est dans le conteneur des résultats : elle ne fait
   pas de la page une fiche. Le cas « fiche puis carrousel d'annonces similaires » reste une
   `listing`, parce que les faits de la fiche sont hors du conteneur du carrousel.
4. **Un fait ne se lit que dans un élément affiché**, et jamais dans un formulaire. Piège du DOM :
   `innerText` d'un élément non affiché (`display: none`) renvoie son `textContent`. Sur la fiche
   bienici, les 40 places de faits étaient prises par la liste cachée des indicatifs téléphoniques
   du formulaire de contact (« Afghanistan : +93 ») et par ses messages de validation. Sont donc
   écartés : les éléments sans rectangle affiché (`getClientRects().length === 0`), `visibility:
   hidden`, et tout descendant de `form`, `select`, `option`, `datalist`, `[hidden]` ou
   `[aria-hidden="true"]`.

**Amendement 2026-09-25 (ter), après une deuxième sonde sur les vraies pages.** Les règles
suivantes remplacent celles des sections précédentes là où elles diffèrent.

5. **Seul un dialogue est un signal structurel fort** (`role="dialog"`, `role="alertdialog"`,
   `aria-modal="true"`, `<dialog>` ouvert). Un élément `fixed` ou `sticky`, même s'il couvre plus
   de 30 % de l'écran, n'est qu'un signal faible. Il n'est écarté qu'avec la confirmation lexicale
   **et** s'il porte moins de 1 500 caractères : un bandeau est court. Il n'est jamais « la couche
   qui est le contenu » : cette règle ne vaut que pour un dialogue (la fiche ouverte en modale).
   Mesuré : les 4 535 caractères de la liste des résultats bienici sont dans un panneau fixe, qui
   contient aussi les mots « partenaires » et « Paramétrer ».
6. **La région principale n'est jamais dans un formulaire, ni dans un élément fixe ou collant qui
   porte moins de la moitié du texte de la page** : c'est une barre latérale. Un élément fixe qui
   en porte la moitié ou plus est la surface principale de la page. Mesuré : la carte de contact
   d'une fiche bienici (fixe, 723 caractères sur 8 571) contient la mention CNIL de son
   formulaire, et c'est elle que Romain a reçue le 25/09 en guise d'annonce.
7. **La remontée vers le conteneur de la liste va jusqu'à douze niveaux**, et non six. Sur la
   page de résultats, le bloc le plus dense (la description de l'annonce mise en avant) est plus
   profond que six niveaux sous le conteneur des résultats.
8. **Lexique de consentement resserré.** « partenaires » et « Paramétrer » en sortent, trop
   courants sur une page ordinaire. Il reste les mots qui ne désignent que le consentement, et
   les boutons d'acceptation ou de refus.
9. **Une question ou une exclamation n'est pas un fait.** Un libellé qui contient `?` ou `!`, ou
   une valeur qui finit par `!`, est un encart publicitaire (« Besoin de déménager ? Comparez les
   déménageurs ! »).

Résultat de la sonde après ces corrections (`notes/corpus/comparaison.md`) :
- page de résultats bienici → `list`, 24 entrées ;
- fiche → `listing`, 5 faits : prix, date du DPE, chauffage, fibre, et « classe G » ;
- Wikipédia → `article`.

Rappel pour la « valeur chiffrée » : c'est un nombre accompagné d'une devise ou d'une des unités
listées, jamais un nombre seul. « 21 langues » (au-dessus du titre d'un article Wikipédia) n'en
est pas une. Faute de ce rappel, l'infobox de l'article « Coati » faisait classer la page en
`listing`.

#### Faits — `context.facts`

Un fait est une paire `{ "label": string, "value": string }` **lue à l'écran**, jamais déduite ni
calculée. Formes reconnues, dans la région principale et ses voisins, hors couches exclues, hors
`nav`, `footer`, `[role=navigation]`, `[role=contentinfo]`, hors `header` / `[role=banner]` de
premier niveau (celui du site, pas celui d'un `article`), hors `[contenteditable]` et hors
entrées d'une liste :

1. **Liste de définitions** : chaque `dt` associé aux `dd` qui le suivent (plusieurs `dd`
   joints par `", "`).
2. **Ligne à deux cellules** : un `tr` d'exactement deux cellules (`th` + `td` ou `td` + `td`).
3. **Paire adjacente répétée** : un élément ayant exactement deux enfants porteurs de texte, le
   premier court (le libellé), le second la valeur — **seulement** s'il a au moins 2 frères de
   même forme (une grille de caractéristiques : « Prix au m² / 5 214 € », « DPE / D »…). Une paire
   isolée n'est pas un fait.
4. **Ligne « libellé : valeur »** : un élément sans enfant de bloc dont tout le texte visible
   tient sur une ligne de la forme `libellé : valeur`, le libellé sans ponctuation de phrase
   (`.`, `!`, `?`). Une phrase de prose qui contient deux-points n'en est pas une : le libellé
   dépasse la borne, ou contient une ponctuation, ou l'élément a d'autres lignes.

Lecture : texte visible uniquement (`innerText`), jamais un attribut (`title`, `alt`,
`aria-label`, `value`, `data-*`), jamais la valeur d'un champ de formulaire. Espaces et retours à
la ligne réduits à un espace, caractères de contrôle retirés, deux-points final du libellé retiré.

Plafonds (contrat, vérifiés par le broker) :

| Borne | Valeur |
|---|---|
| Nombre de faits | 40 |
| Longueur d'un `label` | 60 caractères |
| Longueur d'une `value` | 160 caractères |

Ce qui tombe, dans cet ordre :

1. une paire dont le libellé dépasse 60 caractères **n'est pas un fait** (c'est de la prose) :
   écartée, pas tronquée ;
2. une paire au libellé ou à la valeur vide : écartée ;
3. les doublons exacts (`label` et `value` identiques après normalisation) : seule la première
   occurrence reste — une fiche répète souvent son prix dans l'encart de contact ;
4. une valeur de plus de 160 caractères : **tronquée** à 159 caractères suivis de `…` ;
5. au-delà de 40 faits : on garde les 40 premiers **dans l'ordre du document** et on laisse tomber
   la fin — les caractéristiques de tête de fiche passent avant celles du bas de page.

Deux faits de même libellé et de valeurs différentes restent tous deux (ex. deux « Surface »).

#### Entrées — `context.items`

Pour `pageKind: "list"` seulement : une entrée par enfant répété retenu par la détection,
`{ "title": string, "price"?: string, "location"?: string, "detail"?: string }`.

- `title` : texte du premier titre (`h2` à `h4`) de l'entrée, sinon du premier lien, sinon sa
  première ligne. Obligatoire : une entrée sans titre non vide est écartée.
- `price` : la première valeur chiffrée à devise de l'entrée, **telle qu'affichée** (`"349 000 €"`),
  jamais convertie. Absent si l'entrée n'en montre pas.
- `location` : une ligne de l'entrée qui porte un code postal à 5 chiffres ou un département entre
  parenthèses (`Nantes (44)`). Absent au moindre doute — la ligne reste alors dans `detail`.
- `detail` : le reste du texte visible de l'entrée, lignes jointes par `" · "`, sans ce qui est
  déjà dans les trois autres champs.

Lecture identique aux faits : texte visible, jamais un attribut. **Jamais le `href`** des liens :
ni envoyé, ni suivi (une URL peut porter un jeton, cf. `url`).

**Seul ce qui est affiché est lu.** Les entrées sont celles rendues dans le document au moment
du clic, qu'elles soient ou non dans la partie visible du viewport. Le content script ne fait
défiler rien, ne clique ni « page suivante », ni « voir plus », ni « charger plus », n'ouvre
aucune entrée, n'émet aucune requête réseau. Une liste virtualisée ou paginée donne ce qu'elle a
rendu, pas plus (règle du geste, CLAUDE.md règle 5). Les entrées sponsorisées ou mises en avant
sont des entrées comme les autres ; si elles l'affichent (« Sponsorisé »), ce mot reste dans
`detail`.

Plafonds (contrat, vérifiés par le broker) :

| Borne | Valeur |
|---|---|
| Nombre d'entrées | 40 |
| `title` | 160 caractères |
| `price` | 40 caractères |
| `location` | 80 caractères |
| `detail` | 200 caractères |

Un champ trop long est tronqué à sa borne moins un, suivi de `…` ; `price` ou `location` trop
long est plutôt omis (une « valeur » de 40 caractères n'est plus un prix). Au-delà de 40 entrées :
les 40 premières dans l'ordre du document, la fin tombe. Le nombre d'entrées envoyées est le seul
décompte que le broker connaisse.

Pour `list`, `text` porte le texte visible de la région principale **hors entrées** (en-tête de
résultats, rappel des filtres, total affiché par la page), dans le budget restant.

#### Budget de taille

Le plafond de 40 000 caractères, qui portait sur `text`, devient **un budget commun** :

```
text.length
+ Σ facts  (label.length + value.length)
+ Σ items  (title.length + price.length + location.length + detail.length)
≤ 40 000
```

(`String.prototype.length`, en unités UTF-16, comme aujourd'hui.) Les plafonds de `facts`
(40 × 220 = 8 800 caractères au plus) et d'`items` (40 × 480 = 19 200 au plus) laissent toujours
au moins 20 800 caractères à `text`.

Ordre de remplissage côté content script : `facts` ou `items` d'abord, `text` ensuite avec ce qui
reste. **`text` est tronqué le premier**, par la fin, comme aujourd'hui. Motif : les faits et
les entrées sont denses et déjà bornés ; c'est précisément eux que le texte en vrac faisait perdre.

Côté broker, voir « Limites côté broker ».

#### Compatibilité

Un client antérieur à cet amendement n'envoie ni `pageKind`, ni `facts`, ni `items`. **Le broker
se comporte alors exactement comme aujourd'hui** : même validation, même limite, même prompt
octet pour octet (au nonce près). La même règle vaut pour chacun des cas suivants, traités comme
un champ absent :

- `pageKind` absent, ou valeur hors des quatre prévues (un client plus récent pourrait en
  ajouter) → comportement `other` ;
- `kind` différent de `page` (`youtube`) → `pageKind`, `facts` et `items` ignorés ;
- `facts` qui n'est pas un tableau, `items` qui n'est pas un tableau → champ ignoré ;
- `facts` avec un `pageKind` autre que `listing`, `items` avec un `pageKind` autre que `list` →
  champ ignoré (ni rendu, ni compté dans le budget) ;
- élément de tableau qui n'a pas la forme attendue (`label` ou `value` non chaîne, `title`
  absent, champ optionnel non chaîne) → cet élément ignoré, les autres gardés ;
- `pageKind: "list"` sans aucune entrée valide, `pageKind: "listing"` sans aucun fait valide →
  consigne `other`.

Cette tolérance porte sur la **forme** ; les **plafonds** (nombre, longueurs, budget), eux, sont
refusés net — voir « Limites côté broker ».

## Bibliothèque de prompts et préférences par site

Amendement 2026-09-28 (plan interne, `docs/DECISIONS.md` T41, P25).
Remplace entièrement la bibliothèque à plat décrite jusqu'ici : `prompts.json` (identifiant =
`name`) disparaît de ce document, mais **le fichier n'est ni lu, ni migré, ni supprimé** — voir
« Stockage » plus bas. Sans migration : un utilisateur qui avait des prompts dans l'ancien format
repart d'une bibliothèque vide.

### `PromptEntry`

```jsonc
{
  "id": "p_1a2b3c4d5e6f",   // attribué par le broker, jamais par le client
  "site": "@youtube",        // "*" (tous les sites) ou une clé de site
  "title": "Points clés",    // facultatif
  "body": "Liste les points clés…"
}
```

- **`id`** : attribué par le broker à la création, jamais par le client (un `id` envoyé dans
  `prompts.save.prompt.id` sert uniquement à désigner un prompt existant à modifier — voir
  `prompts.save`). Forme : `p_` suivi de 12 caractères hexadécimaux tirés de `crypto.randomBytes`
  (`broker/src/prompts.ts`). Jamais réutilisé : un `id` effacé ne redevient pas libre.
- **`site`** : soit `"*"` (le prompt apparaît dans la case « Tous les sites » de l'encart et de la
  page), soit une **clé de site**. Deux formes possibles :
  - une des cinq clés des sites populaires — `@youtube`, `@google`, `@wikipedia`, `@reddit`,
    `@amazon` — dès que l'hôte de l'URL appartient à l'un de ces cinq sites, quel que soit le
    chemin (voir `extension/lib/suggestions.js:siteKeyFor`) ;
  - sinon, l'hôte en minuscules, **`www.` initial retiré** (`crisco4.unicaen.fr` et `unicaen.fr`
    sont deux sites distincts — aucun autre repli n'est retiré, seul `www.`).
  - **`@unsorted`** (amendement 2026-09-28, plan interne,
    `docs/DECISIONS.md` T44) : clé réservée pour un prompt enregistré depuis une page dont Coati ne
    voit pas l'adresse (pas de site populaire reconnu, pas d'hôte lisible — onglet interne,
    permission non accordée, etc.). Ce n'est **pas** un site populaire au sens de la liste
    ci-dessus, seulement une clé qui respecte la même forme ; elle ne désigne aucun domaine et
    n'a donc aucun motif d'autorisation (`permissionPatternsFor("@unsorted")` renvoie `[]`, voir
    `extension/lib/suggestions-data.js`). Jamais affichée comme un nom de site dans l'interface —
    seconde partie sans intitulé de la case de tête (T44). Le broker ne fait aucune distinction de
    traitement : la validation `/^@[a-z0-9-]{1,40}$/` l'acceptait déjà avant cet amendement, sans
    changement de code (test : `broker/test/prompts.test.ts`).
  - Validation côté broker (`broker/src/protocol.ts`) : `site === "*"`, ou
    `/^@[a-z0-9-]{1,40}$/` (site populaire ou `@unsorted`), ou `/^[a-z0-9.-]{1,253}$/` **et** ne
    commençant pas par `www.` (site de l'utilisateur). Tout le reste est un `bad-request`.
  - **La clé de site ne sert jamais à construire un chemin de fichier** — CLAUDE.md règle
    implicite de prudence sur une donnée qui vient, indirectement, d'une URL visitée : les deux
    fichiers de stockage (`prompts-v2.json`, `prefs.json`) ont un nom fixe, la clé de site n'est
    qu'une valeur dans leur JSON.
- **`title`** : facultatif. Le broker le découpe des espaces de bord (`trim`) ; un titre vide après
  découpe est traité comme absent. Borné à **120 caractères**
  (`PROMPT_TITLE_MAX`, `broker/src/protocol.ts`) — au-delà, `bad-request`.
- **`body`** : obligatoire, non vide après découpe. Borné à **8000 caractères**
  (`PROMPT_BODY_MAX`) — au-delà, `bad-request`.

### `prompts.list`

```jsonc
{ "type": "prompts.list", "id": "c4" }
```

Réponse : `{ "type": "prompts", "id": "c4", "items": [ /* tous les PromptEntry, tous sites confondus */ ] }`.
L'extension trie et groupe par site elle-même (voir « Bibliothèque de prompts et préférences par
site » côté panneau, lot 3/4) ; le broker ne connaît pas d'ordre d'affichage — voir `prefs`.

### `prompts.save`

```jsonc
{ "type": "prompts.save", "id": "c5", "prompt": { "site": "@youtube", "title": "…", "body": "…" } }              // création
{ "type": "prompts.save", "id": "c5b", "prompt": { "id": "p_1a2b3c4d5e6f", "site": "@youtube", "body": "…" } }   // modification
```

- **`prompt.id` absent** : création. Le broker valide `site`/`title`/`body`, attribue un nouvel
  `id`, ajoute l'entrée. `site` est obligatoire (pas de défaut implicite : un prompt créé sans site
  précisé est un `bad-request`, jamais silencieusement rangé dans `"*"`).
- **`prompt.id` présent** : modification. Le broker retrouve le prompt existant par `id` et
  remplace `title`/`body` — **`site` est ignoré sur une modification** (déplacer un prompt d'un
  site à l'autre passe par `prompts.move`, jamais par `prompts.save`, pour garder `prefs.json`
  cohérent avec `prompts-v2.json` en une seule opération verrouillée). Un `id` inconnu →
  `{ "type": "error", "code": "bad-request", "message": "prompts.save: unknown id" }`.
- Réponse dans les deux cas : `{ "type": "prompts", "id": "c5", "items": [ /* liste complète, tous sites */ ] }` — même forme que `prompts.list`.

### `prompts.delete`

```jsonc
{ "type": "prompts.delete", "id": "c6", "promptId": "p_1a2b3c4d5e6f" }
```

Efface le prompt par `id`. Réponse : la liste complète (même forme que `prompts.list`). **Idempotent** :
un `promptId` inconnu ne produit pas d'erreur, seulement la liste inchangée — un double clic ou une
réponse perdue puis rejouée ne casse rien. Ne touche jamais `prefs.json` : un `id` de prompt effacé
encore présent dans un `order` est simplement ignoré à la lecture (« Lecture tolérante » plus bas),
il n'est pas nécessaire de le retirer activement.

### `prompts.move`

```jsonc
{ "type": "prompts.move", "id": "c6b", "promptId": "p_1a2b3c4d5e6f", "site": "crisco4.unicaen.fr",
  "order": ["p_1a2b3c4d5e6f", "coati:youtube:key-points"] }
```

Déplace un prompt d'une case à l'autre (glisser-déposer de la page « Mes prompts », lot 4) :
- change `site` du prompt désigné par `promptId` dans `prompts-v2.json` (`bad-request` si l'`id`
  est inconnu) ;
- dans `prefs.json`, retire `promptId` de l'`order` du site **source** (celui que le prompt
  quitte, retrouvé à partir de son ancien `site`) ;
- remplace l'`order` du site **de destination** (`site`, le nouveau) par le tableau `order` donné
  — c'est la page qui connaît le nouvel ordre complet de la case cible après l'avoir réarrangée,
  pas le broker.
- `site` et chaque élément d'`order` suivent les mêmes validations que partout ailleurs (voir
  « Identifiants dans `order` et `removed` » ci-dessous) ; toute entrée invalide → `bad-request`
  pour tout le message (aucune écriture partielle).
- Les deux fichiers (`prompts-v2.json`, `prefs.json`) sont réécrits **sous le même verrou** — voir
  « Stockage » — pour qu'un lecteur ne voie jamais le prompt déjà déplacé de site sans que son
  ordre le soit aussi.

Réponse : `{ "type": "prompts", "id": "c6b", "items": [ /* liste complète */ ], "prefs": { "sites": { /* préférences complètes */ } } }`
— les deux à la fois, pour que la page reconstruise son affichage sans un second aller-retour.

### `prefs.get` / `prefs.set`

```jsonc
{ "type": "prefs.get", "id": "c6c" }
{ "type": "prefs.set", "id": "c6d", "site": "@youtube",
  "prefs": { "order": ["coati:youtube:key-points", "p_1a2b3c4d5e6f"], "removed": ["coati:youtube:further"] } }
```

`prefs.get` répond avec l'intégralité des préférences :

```jsonc
{ "type": "prefs", "id": "c6c",
  "sites": { "@youtube": { "order": ["…"], "removed": ["…"] }, "crisco4.unicaen.fr": { "order": ["…"] } } }
```

`prefs.set` **remplace entièrement** l'entrée d'un site (`order` et `removed` sont chacun
facultatifs et indépendants — un champ omis n'efface pas l'autre, mais un champ présent remplace,
il ne fusionne pas) : envoyer `{ "prefs": { "order": [...] } }` laisse `removed` inchangé ; envoyer
`{ "prefs": { "order": [...], "removed": [] } }` vide `removed`. Une entrée de site devenue vide
(ni `order` ni `removed`, ou les deux tableaux vides) est retirée de `prefs.json` plutôt que
persistée vide. Réponse : les préférences complètes, même forme que `prefs.get`.

### Identifiants dans `order` et `removed`

Chaque élément de `order` ou de `removed` est soit l'`id` d'un `PromptEntry` (`p_` + 12 hex), soit
l'identifiant d'une suggestion de Coati : `coati:<site>:<slug>`, en minuscules, 80 caractères au
plus, stable et défini dans `extension/lib/suggestions-data.js`. **Le broker ne connaît pas la
liste des suggestions existantes** — il ne fait que vérifier la forme de chaque identifiant
(`bad-request` sinon), jamais son existence ; c'est le rôle de la « Lecture tolérante » ci-dessous
de faire disparaître un identifiant devenu obsolète sans jamais lever d'erreur.

Bornes, par message (`bad-request` au-delà) : au plus **200 éléments** par tableau `order` ou
`removed`, doublons retirés (silencieusement — pas une erreur) ; au plus **500 sites** dans
`prefs.json`.

### Lecture tolérante

Le broker écrit deux fichiers séparés (`prompts-v2.json`, `prefs.json`) qui peuvent diverger un
instant après un crash entre les deux écritures d'un `prompts.move` (protégé par un seul verrou en
mémoire, pas par une transaction inter-fichiers). La lecture absorbe cet écart, jamais l'écriture :

- un identifiant présent dans `order` ou `removed` qui ne correspond plus à rien (prompt effacé,
  suggestion qui n'existe plus dans `suggestions-data.js`) est **ignoré à l'affichage**, sans
  erreur ;
- un prompt ou une suggestion de la case qui n'apparaît dans aucun `order` est **ajouté à la fin**
  — ordre par défaut : les suggestions de Coati dans l'ordre de `suggestions-data.js`, puis les
  prompts de l'utilisateur par ordre de création.

C'est cette tolérance, pas une transaction, qui rend l'écriture en deux fichiers sûre après un
crash : la pire divergence observable est un ordre partiellement retombé sur le défaut, jamais une
entrée perdue ni une erreur.

### Stockage

`broker/src/prompts.ts` persiste `prompts-v2.json` = `{ "version": 2, "prompts": [ /* PromptEntry[] */ ] }`
dans le même dossier que l'ancien `prompts.json`. **L'ancien fichier à plat n'est jamais lu, jamais
renommé, jamais supprimé** — décision de Romain, T41 : pas de code de migration pour cinq prompts
par défaut que personne n'a demandés ; un utilisateur qui avait des prompts dans l'ancien format ne
les revoit pas. `broker/src/prefs.ts` persiste `prefs.json` = `{ "version": 1, "sites": { /* … */ } }`
à côté. Les deux fichiers gardent les garanties déjà en place pour `prompts.json` : écriture
atomique (fichier temporaire puis renommage), verrou en mémoire par dossier de données (une
deuxième écriture concurrente attend la première plutôt que de la corrompre), lecture tolérante
(fichier absent, illisible ou de forme inconnue → bibliothèque/préférences vides, jamais une
exception qui remonterait au client). `DEFAULT_PROMPTS` (les cinq prompts d'office) est retiré :
la bibliothèque est vide à l'installation.

## Construction du prompt (assainissement et anti-injection)

`buildPrompt()` (`broker/src/model.ts`) est le seul endroit du broker qui assemble un prompt. Tout
contenu page-contrôlé (`context.text`, `context.title`, `context.url`, le texte sélectionné d'un
`act`) est encadré par un délimiteur généré à neuf, aléatoirement, à **chaque** appel :
`<<<coati-<16 hex>` … `coati-<16 hex>>>>`. Le system prompt nomme ce délimiteur comme seule
frontière valable et précise que tout ce qui est dedans est une donnée, jamais une instruction. En
plus de l'aléa du nonce : toute occurrence de la forme du délimiteur et toute suite de 3 guillemets
ou plus sont neutralisées dans le texte avant interpolation (défense en profondeur — l'ancien
format de délimiteur figé, `"""`, ne doit plus pouvoir servir de frontière). `title` et `url` sont
en plus aplatis (tous les espaces/retours à la ligne réduits à un seul espace) et tronqués à
300 caractères, et placés **à l'intérieur** du délimiteur — jamais au-dessus, là où le system
prompt traite le contenu comme la requête de l'utilisateur.

### Faits et entrées dans le prompt

Amendement 2026-09-25 (types de page). `facts` et `items` sont du contenu page-contrôlé, au même
titre que `text` (CLAUDE.md règle 3). Ils passent par le même traitement et **dans le même
délimiteur**, dans cet ordre : `Title`, `URL`, puis les faits ou les entrées, puis le texte.

- Chaque `label`, `value`, `title`, `price`, `location`, `detail` est neutralisé comme `text`
  (forme du délimiteur, suites de 3 guillemets ou plus), puis aplati comme `title` : tout espace
  ou retour à la ligne réduit à un seul espace. Un champ ne peut donc pas ouvrir une ligne à lui,
  ni simuler un intitulé de section.
- Rendu d'un fait : une ligne `- <label> : <value>`. Rendu d'une entrée : une ligne
  `<n>. <title> | <price> | <location> | <detail>`, les champs absents omis avec leur séparateur,
  `<n>` compté par le broker à partir de 1.
- Les intitulés de section à l'intérieur du délimiteur sont des chaînes fixes écrites par le
  broker : `Faits affichés par la page :`, `Entrées affichées par la page (<N> lues) :`,
  `Texte de la page :`. Le texte de la page vient **en dernier** : un faux intitulé glissé dans
  `text` ne peut qu'ajouter des lignes après les vraies sections, pas s'insérer avant.
- `pageKind` n'est pas du texte libre : le broker le compare aux quatre valeurs prévues **avant**
  tout usage, et ne l'interpole que sous sa forme validée. Il peut alors figurer hors du
  délimiteur, sur la ligne d'en-tête (`… — kind: page, pageKind: listing`), comme `kind`
  aujourd'hui. Une valeur inconnue n'est jamais recopiée nulle part.
- `<N>` (nombre d'entrées) est calculé par le broker, jamais lu dans la page.

Le system prompt reste inchangé : tout ce qui est entre les marqueurs est une donnée. Un libellé
qui dit « Instruction : ignore ce qui précède » est un fait comme un autre, à restituer, pas à
suivre.

### Consigne de résumé selon le type de page

Amendement 2026-09-25 (types de page). La consigne de `summarize` (hors délimiteur, texte de
confiance, **rien de page-contrôlé dedans**) dépend de `pageKind`. Les exigences ci-dessous sont
le contrat ; la formulation exacte appartient au broker (L7) et est figée par ses tests.

Communes à toutes : sortie **en français** quelle que soit la langue de la page, ton factuel,
aucun préambule ni conclusion de politesse. **Aucun conseil d'expert, aucun jugement juridique,
fiscal ou financier** : ni « bonne affaire », ni « surévalué », ni « conforme », ni
recommandation d'achat ou de location. Les chiffres sont ceux que la page affiche, attribués à
elle ; **le modèle ne calcule aucun chiffre que la page ne montre pas** (pas de prix au m² refait,
pas de moyenne présentée comme un fait de la page). `length` retiré le 26/09 (bis, voir annexe) :
les bornes ci-dessous sont celles de l'ancien `medium`, désormais fixes.

- **`list`** — le résumé d'une page de résultats, sur les `N` entrées lues :
  - la **fourchette de prix** parmi les entrées qui en affichent un (minimum, maximum), en disant
    combien n'en affichent pas ;
  - la **répartition** que les données permettent (par tranche de prix, par lieu, par type), sans
    en inventer une que les entrées ne portent pas ;
  - les **entrées qui sortent du lot**, désignées par leur titre tel qu'affiché, et ce qui les
    distingue sur la page ;
  - le décompte : « `N` annonces lues sur cette page ». **Jamais un nombre total supérieur à `N`
    présenté comme su** ; si le texte de la page affiche un total (« 1 234 résultats »), il peut
    être cité, attribué à la page (« la page annonce 1 234 résultats »), distinct de `N`.
  - Pas de ligne « Ce que l'annonce ne dit pas » ; la ligne finale « À retenir : » reste.
- **`listing`** — le résumé d'une fiche, en trois temps, dans cet ordre :
  1. **Les faits** : les caractéristiques affichées (prix, surface, prix au m², DPE, charges, taxe
     foncière… selon ce que la page montre), reprises telles quelles, les plus déterminantes
     d'abord ; 12 au plus.
  2. **Points à vérifier** : les questions qu'un lecteur attentif poserait, ou les documents qu'il
     demanderait, **à partir de ce que la page montre** (une incohérence entre deux faits, un fait
     que le texte contredit, un chiffre sans unité ou sans date) — formulés comme des questions à
     poser, jamais comme un avis ; 4 à 6.
  3. **Ce qu'en dit l'annonce** : le texte descriptif du vendeur ou de l'agence, résumé et
     **attribué** (« selon l'annonce… »), en dernier.
  - Ligne finale obligatoire, commençant par « Ce que l'annonce ne dit pas : », qui énumère les
    informations usuelles pour ce genre d'objet que ni les faits ni le texte ne donnent. Si rien
    ne manque, la ligne le dit. Elle **remplace** « À retenir : » pour ce type.
- **`article`** — la consigne d'aujourd'hui, inchangée.
- **`other`** — la consigne d'aujourd'hui, inchangée. C'est aussi celle de tout cas de repli
  (voir « Compatibilité »).

`chat` n'a pas de consigne par type : les faits et les entrées figurent dans le contexte rendu
(ci-dessus), la requête de l'utilisateur fait le reste.

## Fournisseur de modèle

Amendement 2026-09-20 (3). Le broker parle à plusieurs fournisseurs de modèle, choisis derrière une
interface commune (`broker/src/providers/types.ts`, voir docs/DECISIONS.md T8). **Amendement
2026-09-29** (complété par l'amendement 2026-09-30 bis, goal G5) : un fournisseur est soit
**intégré** au broker (ce dépôt en embarque exactement trois), soit un **module externe**, déclaré
dans `~/.config/coati/config.json` et chargé au
démarrage depuis un chemin de fichier — jamais depuis l'extension ni une page, jamais depuis une
adresse distante (règle de sécurité n°3). L'identifiant d'un fournisseur (`provider`) est une
**chaîne ouverte** : le broker ne connaît pas à l'avance la liste complète des identifiants
possibles — voir « Modules externes » plus bas et `docs/MODULES.md` pour l'interface qu'un module
doit implémenter.

Fournisseurs intégrés :

- **`ollama`** (fournisseur par défaut d'une configuration neuve, amendement 2026-09-29) — un
  démon Ollama local (`http://127.0.0.1:11434` par défaut, surchargeable par la clé `ollamaUrl` de
  `config.json`). C'est le seul fournisseur pour lequel Coati peut honnêtement affirmer que rien ne
  sort de la machine.
- **`claude-api`** (amendement 2026-09-21 (3)) — l'API Anthropic en HTTPS direct, avec la clé de
  l'utilisateur (BYOK, « bring your own key ») : c'est le chemin du produit distribué. Streaming
  SSE via `fetch`/`ReadableStream` de Bun, aucune dépendance ajoutée
  (`broker/src/providers/claude-api.ts`). Modèle par défaut `claude-opus-5`, surchargeable par le
  même champ `model` que les autres fournisseurs. La clé n'est jamais transmise à l'extension —
  voir juste en dessous. Un 401/403 de l'API échoue en `auth-required` avec :
  ```jsonc
  { "type": "error", "id": "c1", "code": "auth-required",
    "message": "Clé API refusée — vérifiez-la dans les réglages." }
  ```
  Une 5xx échoue en `model-unavailable`. Amendement 2026-10-01 (goal U1) — le compte Anthropic de
  l'utilisateur peut être à court de crédit, ce qui n'est ni un identifiant refusé ni un modèle
  indisponible : un 402, ou un 400 dont le corps contient un message de facturation (texte
  "credit balance is too low", ou un objet d'erreur dont le `type` est `billing_error`), échoue en
  `quota-exceeded` avec un message figé (voir `broker/src/messages.ts`, code `quotaExceeded`) :
  ```jsonc
  { "type": "error", "id": "c1", "code": "quota-exceeded",
    "message": "Votre compte chez le fournisseur n'a plus de crédit. Rechargez-le sur son site, ou choisissez un modèle gratuit dans les réglages." }
  ```
  Un 429 est examiné : si le corps porte un objet d'erreur dont `code`/`type` vaut
  `insufficient_quota`, c'est aussi `quota-exceeded` ; sinon c'est un simple trop-plein de
  requêtes, classé `rate-limited` (message figé, code `rateLimited`), avec un champ optionnel
  `retryAfterSec` (entier, secondes) repris de l'en-tête HTTP `Retry-After` quand le fournisseur
  l'envoie :
  ```jsonc
  { "type": "error", "id": "c1", "code": "rate-limited",
    "message": "Le fournisseur reçoit trop de requêtes en ce moment. Réessayez dans quelques instants.",
    "retryAfterSec": 20 }
  ```
  Comme pour `auth-required`, `message` est ici un texte français figé, affichable tel quel à
  l'utilisateur — pas le détail technique anglais du contrat `model-unavailable`/`internal`.
- **`openai-compat`** (amendement 2026-09-30 bis, goal G5) — un seul adaptateur pour tout serveur
  qui parle le format `/v1/chat/completions` d'OpenAI (`broker/src/providers/openai-compat.ts`).
  Couvre en pratique LM Studio, Ollama (via son propre `/v1`, alternative à l'API native `ollama`
  ci-dessus), OpenAI, Mistral, OpenRouter, DeepSeek — et toute autre adresse compatible. Deux champs
  de configuration propres à ce fournisseur, tous deux dans le même slot `model`/`apiKey` que les
  autres pour ce dernier, plus un nouveau :
  - **`baseUrl`** (`settings.set`) — l'adresse du serveur, par ex. `http://localhost:1234/v1`
    (LM Studio) ou `https://api.mistral.ai/v1`. Ce n'est **pas** un secret : contrairement à
    `apiKey`, la réponse `settings` la renvoie en clair pour le fournisseur actif (voir plus bas).
    **Contrainte de sécurité, imposée par le broker, jamais par l'extension seule** : `baseUrl` doit
    être soit `https://`, soit `http://` vers une adresse loopback exclusivement (`localhost`,
    `127.0.0.1`, `[::1]`) — toute autre adresse `http://` est refusée en `bad-request` avec un
    message lisible (« l'adresse doit être en HTTPS, ou en HTTP vers une adresse locale
    (localhost/127.0.0.1) »). Motif : un `http://` non loopback enverrait la clé API en clair sur le
    réseau. `fetch` est appelé avec `redirect: "error"` — jamais de redirection suivie, pour ne
    jamais réexpédier la clé vers une autre adresse que celle configurée.
  - **`apiKey`** — optionnel pour ce fournisseur (LM Studio et Ollama n'en demandent pas) ; même
    champ write-only que `claude-api`, voir « La clé API » plus bas. Envoyé en en-tête
    `Authorization: Bearer <clé>` seulement quand une clé est configurée.
  Requête `POST {baseUrl}/chat/completions`, `stream: true`, réponse SSE (`data: {...}`, terminée
  par `data: [DONE]`) — même famille de format que `claude-api`, tolérant les variantes des
  fournisseurs qui n'envoient pas de bloc `usage` ou de rôle sur chaque chunk. Liste des modèles :
  pas de nouveau message `settings.models` — `openai-compat` implémente `ModelProvider.
  listModels()` (le même mécanisme qu'`ollama`, déjà câblé dans `settings`'s champ `models`) via
  `GET {baseUrl}/models`, qui retourne les identifiants annoncés par le serveur ou une erreur
  lisible ; l'extension retombe alors sur un champ de modèle libre (même comportement que pour
  `claude-api` aujourd'hui). Erreurs classées ainsi :
  - clé refusée (HTTP 401/403) → `auth-required`, message « Clé API refusée — vérifiez-la dans les
    réglages. » (même texte que `claude-api`). Le panneau n'affiche pas ce `message` : il choisit
    son propre texte d'après le fournisseur connu par la dernière réponse `provider.status`
    (session à renouveler pour `claude-cli`, clé à vérifier dans les réglages pour un fournisseur à
    clé API, texte neutre tant que le fournisseur est inconnu) ;
  - modèle inconnu (HTTP 404, ou message d'erreur du corps de réponse quand le serveur répond 200
    avec un objet d'erreur) → `model-unavailable`, nomme le modèle demandé ;
  - serveur injoignable (connexion refusée, DNS, etc.) → `model-unavailable`, ne répète jamais
    l'adresse configurée verbatim au-delà de ce que l'utilisateur a lui-même saisi ;
  - délai dépassé → `model-unavailable` (même timeout de 120 s que les autres fournisseurs) ;
  - flux interrompu en cours de réponse → l'erreur remonte telle quelle, la partie de réponse déjà
    reçue reste affichée (comportement du panel, inchangé) ;
  - HTTP 402 → `quota-exceeded` (amendement 2026-10-01, goal U1) : le compte du fournisseur n'a
    plus de crédit (OpenRouter, DeepSeek, Mistral… renvoient ce statut pour ce cas) — même message
    figé et même contrat `message` que pour `claude-api`, voir plus haut ;
  - HTTP 429 → examiné comme pour `claude-api` : un corps d'erreur dont `error.code`/`error.type`
    vaut `insufficient_quota` échoue en `quota-exceeded` ; sinon c'est `rate-limited` (trop-plein de
    requêtes, cas typique des modèles gratuits d'OpenRouter), avec le même `retryAfterSec`
    optionnel tiré de l'en-tête `Retry-After` quand présent.
  Adresses proposées par la page d'options (préremplissage seulement — l'utilisateur peut toujours
  taper une autre adresse) : LM Studio `http://localhost:1234/v1`, Ollama `http://localhost:11434/v1`,
  OpenAI `https://api.openai.com/v1`, Mistral `https://api.mistral.ai/v1`, OpenRouter
  `https://openrouter.ai/api/v1`, DeepSeek `https://api.deepseek.com/v1`, ou « Autre adresse ». Liste
  côté extension : `extension/lib/model-provider-presets.js`.

### Modules externes — amendement 2026-09-29

Au-delà de `ollama`, `claude-api` et `openai-compat`, tout autre fournisseur est un **module** : un fichier
`.ts`/`.js` dont l'export par défaut est une fonction `createProvider(host, options)`, déclaré dans
`config.json` :
```jsonc
{ "modules": [ { "path": "/chemin/absolu/vers/mon-fournisseur.ts", "options": { "…": "…" } } ] }
```
Le broker charge chaque module au démarrage par import dynamique, valide la forme de ce qu'il
exporte (un objet avec `id`, `label`, `isAvailable`, `checkStatus`, `streamAnswer`), et — **sans
jamais planter** — journalise puis ignore un module dont le fichier est introuvable, dont l'import
échoue, ou dont l'export ne respecte pas cette forme. Un module cassé n'empêche ni le démarrage du
broker, ni le fonctionnement des autres fournisseurs. Ce que le broker fournit à un module
(`host`) — l'assembleur d'invite système, le délai standard, les classes d'erreur, le journal — et
l'interface complète attendue en retour sont documentés dans `docs/MODULES.md`, avec un exemple
générique. **Un fournisseur configuré (`config.json`'s `provider`) qui ne correspond à aucun
fournisseur intégré ni module chargé avec succès est rapporté comme indisponible dans la réponse
`settings` — jamais remplacé en silence par un autre fournisseur.**

### La clé API : stockée par le broker, jamais transmise à l'extension

`settings.set` accepte un champ `apiKey` optionnel, WRITE-ONLY de bout en bout : persistée dans
`~/.config/coati/config.json` (0600, écriture atomique — comme le reste du fichier) mais **jamais**
renvoyée dans une réponse `settings`, quelle que soit la question posée — c'est la règle de sécurité
n°1 du projet (aucun secret ne doit atteindre l'extension). Une chaîne vide (`"apiKey": ""`) efface
la clé stockée. La clé n'est jamais journalisée, même tronquée, et n'apparaît jamais dans le texte
d'une erreur. **Amendement 2026-09-30 bis** : `openai-compat` accepte le même champ `apiKey`, mais
optionnel (LM Studio, Ollama n'en demandent pas) — un fournisseur `openai-compat` sans clé n'est pas
en soi indisponible, seulement `configured: false` s'il n'a pas non plus de `baseUrl`.

**Amendement 2026-09-30 ter (correctif de sécurité)** : une clé n'atteint jamais que le service pour
lequel elle a été saisie. `config.json` stocke désormais les clés **par fournisseur** (`apiKeys:
{ "claude-api"?: string, "openai-compat"?: { key, origin } }`), jamais un champ global unique — un
champ global aurait envoyé la clé Anthropic en `Bearer` à n'importe quel `baseUrl` choisi ensuite
(OpenRouter, DeepSeek…), et un changement de `baseUrl` d'un hôte à un autre aurait envoyé la clé du
premier hôte au second. Pour `openai-compat`, la clé est liée à l'*origine* (schéma + hôte + port)
de `baseUrl` au moment où elle est enregistrée ; le broker ne la ressert que si l'origine courante
de `baseUrl` correspond encore à l'origine enregistrée. Un `settings.set` qui déplace `baseUrl` vers
une autre origine efface la clé stockée pour `openai-compat` (le booléen `configured` de l'entrée
`openai-compat` dans `available` redevient `false`) ; un `settings.set` qui porte à la fois un
nouveau `baseUrl` et une nouvelle `apiKey` lie la clé à la nouvelle origine. Un `config.json` légué
(l'ancien champ global `apiKey`, forcément la clé `claude-api` puisque `openai-compat` n'existait
pas encore) est migré tel quel vers `apiKeys["claude-api"]` à la prochaine lecture, et réécrit sous
la nouvelle forme dès le premier `settings.set` qui suit. `claude-api` ne lit jamais la clé
`openai-compat`, et réciproquement — chacun ne connaît que sa propre entrée.

`settings.set` gagne aussi (amendement 2026-09-30 bis) un champ `baseUrl`, propre à `openai-compat` —
**pas un secret** : contrairement à `apiKey`, il est renvoyé tel quel dans la réponse `settings`
pour le fournisseur actif (`{ "baseUrl": "http://localhost:1234/v1" }`), pour que la page d'options
puisse le réafficher (l'utilisateur voit et modifie l'adresse, jamais la clé). Une chaîne vide
efface l'adresse stockée, même sémantique que `apiKey`. Le broker rejette en `bad-request` toute
`baseUrl` qui n'est ni `https://`, ni `http://` vers `localhost`/`127.0.0.1`/`[::1]` — voir
« Fournisseur de modèle » plus haut pour le motif.

En échange, chaque entrée de `available` dans la réponse `settings` gagne un booléen `configured` :
vrai quand ce fournisseur a ce qu'il lui faut pour fonctionner — une clé stockée pour `claude-api`,
un démon qui répond pour `ollama`, une adresse configurée pour `openai-compat` (voir juste
au-dessus), ce qu'un module externe juge nécessaire pour le sien —
indépendamment du modèle actuellement choisi (c'est `available` qui couvre déjà cette
dimension-là). L'extension affiche un état, jamais une valeur :
```jsonc
{ "id": "claude-api", "label": "Claude (clé API)", "available": false,
  "reason": "no Anthropic API key configured", "configured": false }
```

### `settings.test` — tester une connexion réelle

Backend du bouton « Tester la connexion » des réglages, borné à 20 s pour ne jamais bloquer le
panneau — teste le fournisseur nommé, pas forcément celui actuellement sélectionné, l'utilisateur
peut tester avant de basculer :
```jsonc
{ "type": "settings.test", "id": "c10", "provider": "claude-api" }
{ "type": "settings.test-result", "id": "c10", "provider": "claude-api", "ok": true,
  "message": "Connexion à l'API Anthropic réussie." }
```
`message` est en français (ou dans la langue de la connexion, voir « Langue de la connexion »),
une phrase, affichée telle quelle à un humain ; en cas d'échec elle nomme le remède : clé refusée
(« Clé API refusée — vérifiez-la dans les réglages. »), Ollama non lancé (« Ollama ne répond pas —
vérifiez qu'il est bien lancé sur cette machine. »), ou tout autre texte qu'un module externe
choisit de renvoyer pour le sien. Sur échec, un champ optionnel `code` reprend un code stable
déjà connu du protocole — voir ci-dessous.

**Amendement 2026-10-01, goal U2 — une vérification GRATUITE, pas un vrai appel.** Avant cet
amendement, `settings.test` faisait un vrai appel minimal (quelques tokens, pas un résumé) contre
le fournisseur — donc facturé pour les fournisseurs à clé. Le tutoriel débutant (goal U2) a besoin
d'un bouton « Tester la connexion » utilisable à volonté, y compris avant que l'utilisateur ait
chargé le moindre crédit. Le coût **zéro** devient l'invariant pour les trois fournisseurs intégrés :

- **`claude-api`** : `GET https://api.anthropic.com/v1/models` (en-têtes `x-api-key`,
  `anthropic-version`) — gratuit (confirmé par une source citée au moment de cet amendement,
  2026-10-01). HTTP 200 → `ok: true`. HTTP 401/403 → `ok: false`, `code: "auth-required"`. HTTP 402
  → `code: "quota-exceeded"` (rare sur cette route, mais traité s'il apparaît). HTTP 429 →
  `code: "rate-limited"`. Toute autre réponse, timeout ou erreur réseau → `code: "model-unavailable"`.
- **`openai-compat`** : `GET {baseUrl}/models` avec `Authorization: Bearer <clé>` — **sauf** quand
  l'origine de `baseUrl` est `https://openrouter.ai` : chez OpenRouter, `/models` est une liste
  publique qui ne valide ni la clé ni le compte (répond 200 même sans clé ou avec une clé invalide).
  Dans ce cas précis, la sonde utilise `GET https://openrouter.ai/api/v1/key` (même en-tête
  `Authorization`) : 200 → clé valide, 401 → clé refusée. Pour toute autre origine (locale —
  Ollama `/v1`, LM Studio — ou hébergée), `GET {baseUrl}/models` reste la sonde, déjà gratuite
  (voir « Disponibilité du fournisseur » ci-dessous pour le même constat côté `provider.status`).
  Mêmes codes que `claude-api` ci-dessus selon le statut HTTP reçu.
- **`ollama`** : inchangé — `GET <ollamaUrl>/api/tags` était déjà gratuit (local). Si le modèle
  configuré n'apparaît pas dans la liste, `code: "model-missing"` (distinct de
  `model-unavailable`, qui couvre le démon injoignable) — même code que la colonne `reason` de
  `provider.status` pour ce même cas.

**Limite connue, documentée pour ne jamais être redécouverte en incident : une vérification de clé
ne voit pas un solde de crédit épuisé.** `GET /v1/models` (Anthropic) et `GET /models` ou
`GET /api/v1/key` (OpenAI-compatible / OpenRouter) confirment que la clé est *acceptée*, pas que le
compte a du crédit — un compte à zéro crédit peut très bien répondre 200 à ces routes-là. Un
problème de crédit ne se révèle donc qu'à la première requête réelle (`chat`/`summarize`/`act`),
sous la forme `error.code: "quota-exceeded"` (voir « Fournisseur de modèle », amendement
2026-10-01, goal U1) — jamais pendant `settings.test`, qui reste par construction incapable de le
détecter pour ces deux fournisseurs.

Un fournisseur externe qui ne peut pas offrir de sonde gratuite garde l'ancien comportement (vrai
appel minimal) — voir `docs/MODULES.md` : `testConnection` reste optionnel dans le contrat
`ModelProvider`.

**`settings.get`** ne prend rien d'autre qu'un `id`. Réponse :

```jsonc
{
  "type": "settings",
  "id": "c8",
  "provider": "ollama",         // fournisseur actuellement sélectionné
  "model": "llama3.2",          // optionnel — nom de modèle propre au fournisseur
  "available": [
    { "id": "ollama", "label": "Ollama (local)", "available": true, "configured": true },
    { "id": "claude-api", "label": "Claude (clé API)", "available": false,
      "reason": "no Anthropic API key configured", "configured": false },
    { "id": "openai-compat", "label": "Compatible OpenAI", "available": false,
      "reason": "no base URL configured", "configured": false },
    { "id": "mon-fournisseur-perso", "label": "Mon fournisseur perso", "available": true,
      "configured": true }
  ],
  "models": ["llama3.2:latest", "mistral:latest"],  // seulement si le fournisseur actif sait lister ses modèles
  "baseUrl": "http://localhost:11434/v1"  // seulement si le fournisseur actif est openai-compat — jamais un secret
}
```

`available` liste **toujours** tous les fournisseurs connus du broker — les trois intégrés, plus
tout module chargé avec succès — y compris ceux qui ne sont pas utilisables maintenant : un
fournisseur indisponible n'est jamais caché, seulement signalé avec une raison courte (`reason`).
**Libellés (amendement 2026-09-29)** : `label` est fourni par le fournisseur lui-même (intégré ou
module) — c'est ce qui permet à l'extension d'afficher, sans texte préécrit pour lui, un
fournisseur qu'elle ne connaît pas d'avance ; voir `extension/lib/labels.js` côté extension, qui
n'a de texte fixe que pour `ollama`, `claude-api` et `openai-compat` et retombe sur ce `label` pour
tout le reste.

**`settings.set`** accepte `provider`, `model`, `apiKey` et `baseUrl`, tous optionnels — un champ
omis reste inchangé côté broker. **Amendement 2026-09-29** : `provider` n'est plus vérifié contre une
liste fermée — `parseClientMessage()` (`broker/src/protocol.ts`) rejette seulement une valeur qui
n'a pas la forme d'un identifiant (chaîne vide, trop longue, caractères hors ASCII imprimable) en
`bad-request`. Que cet identifiant corresponde à un fournisseur réellement connu du broker est
vérifié à l'exécution, pas au parsing — un identifiant inconnu est accepté et persisté, puis
rapporté comme indisponible par `settings.get`/`provider.status` (voir plus haut). Seul `apiKey`
est un secret (voir « La clé API » ci-dessus, amendement 2026-09-21 (3), complétée par l'amendement
2026-09-30 bis) — write-only, jamais renvoyé ; `baseUrl` n'en est pas un et est renvoyé tel quel
(amendement 2026-09-30 bis). Sur succès, le broker persiste le changement dans `~/.config/coati/config.json`
(permissions `0600`, comme le reste du fichier) et répond avec un `settings` frais, construit de la
même façon que pour `settings.get`.

Si le modèle configuré pour `ollama` n'apparaît pas dans la réponse de son `/api/tags`, une
requête `chat`/`summarize`/`act` échoue en `model-unavailable`, avec le nom du modèle manquant dans
le message — jamais de repli silencieux sur un autre modèle installé.

**Session expirée ou identifiants non authentifiés (amendement 2026-09-21 (2), task C3).** Un
fournisseur peut détecter que la session ou les identifiants de l'utilisateur ne sont plus valides
— par exemple `claude-api` ou `openai-compat` sur un 401/403 (voir plus haut) — et le signale avec le code
`auth-required` plutôt que `model-unavailable`, pour que l'extension nomme le bon remède plutôt que
de laisser l'appel courir jusqu'au timeout de 120 s sans jamais dire pourquoi. Un module externe
suit le même contrat — voir `docs/MODULES.md` et son propre `LISEZMOI.md` le cas échéant.

### Disponibilité du fournisseur — `provider.status`

Amendement 2026-09-25. Comble l'écart relevé par l'audit de connexion (§4 et §6) : le panneau
affichait « Connecté » alors que la première requête allait échouer. Le panneau demande l'état du
fournisseur **actif** à son ouverture et l'affiche en texte dans les bandeaux existants.

```jsonc
{ "type": "provider.status", "id": "c11" }
{ "type": "provider.status-result", "id": "c11", "provider": "ollama",
  "state": "ko", "reason": "model-missing", "checkedAt": "2026-09-25T14:03:00Z" }
```

- `provider` : le fournisseur dont l'état est rapporté, c'est-à-dire celui qui était actif à la
  réception de la demande. Un `settings.set` concurrent vide
  le cache ; la demande suivante rapporte le nouveau fournisseur.
  La requête ne prend aucun autre champ que `id` : elle ne vise que le fournisseur actif.
- `state` :
  - `ok` — une vérification **non facturée** a établi que le fournisseur acceptera une requête ;
  - `ko` — une vérification non facturée a établi que la prochaine requête échouera ;
  - `unknown` — aucune vérification non facturée ne permet de conclure ; un échec éventuel sera
    signalé à la première requête, comme aujourd'hui.
- `reason` : code court, stable, en anglais, lu par le code du panneau (jamais affiché tel quel) ;
  toujours présent. Liste fermée ci-dessous.
- `checkedAt` : date ISO 8601 UTC de la vérification **effective** (pour une réponse servie depuis
  le cache, la date de la vérification d'origine).

`provider.status-result` est le terminal de son `id` ; `provider.status` ne répond jamais
`error`, sauf `bad-request` pour un message malformé. Une panne interne de la vérification donne
`state: "unknown"`, `reason: "probe-failed"`.

**Sémantique par fournisseur :**

| Fournisseur | Vérification | `state` / `reason` |
|---|---|---|
| `claude-api` | présence d'une clé dans `config.json` | pas de clé : `ko` / `no-key` ; clé présente : `unknown` / `key-unverified` |
| `ollama` | `GET <ollamaUrl>/api/tags`, délai 1,5 s (celui d'`isAvailable()`) | injoignable, délai dépassé ou HTTP non 2xx : `ko` / `ollama-unreachable` ; modèle configuré absent de la liste (même règle de correspondance que `isAvailable()`, suffixe `:latest` toléré) : `ko` / `model-missing` ; aucun modèle configuré et liste vide : `ko` / `no-model-installed` ; sinon `ok` / `ready` |
| `openai-compat` | pas de `baseUrl` configurée : aucune requête. Sinon `GET {baseUrl}/models`, délai 1,5 s | pas de `baseUrl` : `ko` / `no-base-url` ; injoignable ou délai dépassé : `unknown` / `base-url-unreachable` ; HTTP 401/403 : `ko` / `key-rejected` ; toute autre réponse non 2xx : `unknown` / `probe-failed` ; 2xx : `ok` / `ready` |
| module externe | propre à chaque module — voir sa propre documentation | même contrat `state`/`reason` que ci-dessus ; le `reason` d'un module externe n'est pas dans cette liste fermée, l'extension le traite comme un `état inconnu` faute d'entrée reconnue |

- **`claude-api`** : une clé présente n'est **pas** annoncée `ok`, puisque rien n'a vérifié
  qu'elle est acceptée. Une validation non facturée (`GET /v1/models`) n'est ajoutée que **si une
  sonde non facturée est confirmée** par une source citée (recherche du lot 1) ; elle passera alors
  par un amendement de ce document, avec les codes `ready` (`ok`), `key-rejected` (`ko`, HTTP 401
  ou 403) et `api-unreachable` (`unknown`, réseau, 429 ou 5xx). **Jusque-là, présence seulement.**
- **`ollama`** : `/api/tags` est local et gratuit.
- **`openai-compat`** (amendement 2026-09-30 bis) : contrairement à `claude-api`, une sonde
  `GET /models` est faite ici directement — décision par défaut du goal G5, faute d'un tarif connu
  et unifié pour cette route chez tous les fournisseurs couverts (LM Studio et Ollama : locale et
  gratuite ; OpenAI/Mistral/OpenRouter/DeepSeek : cette route est documentée gratuite chez chacun au
  moment de l'implémentation, à revérifier si un nouveau preset est ajouté un jour). À rouvrir si un
  fournisseur `openai-compat` facturé confirme le contraire.

**Cache côté broker : 60 s.** Un résultat est réutilisé pendant 60 s pour le même fournisseur et
la même configuration (fournisseur, modèle, `ollamaUrl`, `baseUrl`, présence de la clé). Un `settings.set`
réussi vide le cache. Deux demandes simultanées pendant une vérification en cours partagent la
même vérification.

**Quand le panneau le demande — uniquement à son ouverture**, c'est-à-dire en réponse à un geste
de l'utilisateur (règle du geste, `CLAUDE.md` n°5) : **une** demande par ouverture du panneau.
Jamais au démarrage du navigateur, jamais sur une reconnexion en soi, jamais périodiquement, jamais
depuis le service worker de sa propre initiative. Si le panneau s'ouvre alors que la connexion
n'est pas établie, la demande part une fois, dès l'état `connected`, tant que ce panneau reste
ouvert. Affichage : texte dans les bandeaux existants, aucun nouvel élément visuel.

**Aucune bascule automatique.** Le broker ne change **jamais** de fournisseur de lui-même — ni
sur un `ko`, ni sur un échec de requête. Seul un `settings.set` venu de l'utilisateur change le
fournisseur. `provider.status` ne modifie aucun état du broker (hormis son cache).

## Limites côté broker

- **Délai maximal d'un appel modèle : 120 s** (`MODEL_TIMEOUT_MS`, `broker/src/model.ts`). Passé
  ce délai sans réponse, le broker abandonne l'appel et envoie `{"type":"error","code":
  "model-unavailable", ...}` — sans ce garde-fou, un appel qui reste bloqué ne renvoie jamais ni
  `done` ni `error`, ce qui viole l'invariant « tout `id` reçoit un terminal » ci-dessous.
- **Flux modèle simultanés par connexion : 3** (`MAX_CONCURRENT_STREAMS`,
  `broker/src/server.ts`). Un `chat`/`summarize`/`act` de plus alors que 3 sont déjà en cours reçoit
  `{"type":"error","code":"bad-request","message":"too many concurrent requests (max 3 per
  connection)"}` sans lancer d'appel fournisseur supplémentaire.
- **Taille d'un message client : 256 Ko** (`MAX_MESSAGE_BYTES`, `broker/src/protocol.ts`).
  Amendement 2026-09-25 (audit écart n°11 : le code n'envoyait l'erreur que si un `id` était
  lisible, et ne fermait jamais) :
  - pendant la poignée de main : échec générique `unauthorized`, fermeture 4401 (voir « Poignée de
    main ») ;
  - après authentification : le broker envoie
    `{"type":"error","id":"oversized","code":"bad-request","message":"message exceeds 262144 byte cap"}`,
    puis ferme la connexion avec le code **1009** (*message too big*), ce qui interrompt les flux
    en cours de cette connexion. Le message n'est pas analysé : son `id` n'est pas cherché.
    L'extension légitime n'atteint jamais cette taille (texte tronqué à 40 000 caractères) ; un
    tel message vient d'un client défaillant.
- **Message invalide sans `id` lisible, après authentification** (JSON illisible, `id` absent) :
  ignoré, sans réponse ni fermeture — il n'y a pas d'`id` à qui répondre. Invalide avec un `id` :
  `error` `bad-request` pour cet `id` (inchangé).
- **Budget du contexte de page : 40 000 caractères** pour `text` + `facts` + `items` (amendement
  2026-09-25 (types de page) — voir « Budget de taille » sous « Context »). Le broker vérifie,
  après avoir écarté les éléments de forme invalide (« Compatibilité ») : plus de 40 faits ou 40
  entrées, un champ au-delà de sa borne, ou un total au-delà de 40 000 → `{"type":"error","code":
  "context-too-large", ...}` pour cet `id`, sans appel au modèle, le `message` nommant la borne
  franchie. Le broker **refuse, il ne tronque pas** : l'extension légitime respecte ces bornes, un
  dépassement signale un client défaillant, et une troncature silencieuse côté broker cacherait le
  défaut. Sans `facts` ni `items`, la vérification est exactement celle d'aujourd'hui (`text` seul).
- **Journalisation des requêtes** : la ligne de réception d'un `summarize` / `chat` peut porter
  `pageKind` validé et les **nombres** de faits et d'entrées ; jamais un libellé, une valeur, un
  titre ni aucun autre contenu de page.

## Messages broker → client

```jsonc
{ "type": "chunk", "id": "c1", "delta": "texte partiel…" }   // flux, n fois
{ "type": "done",  "id": "c1", "usage": { "inputTokens": 0, "outputTokens": 0 } }
{ "type": "error", "id": "c1", "code": "…", "message": "…" } // terminal pour cet id
// "quota-exceeded"/"rate-limited" seulement (amendement 2026-10-01) ; "retryAfterSec" absent
// pour tout autre code, et absent même pour "rate-limited" quand le fournisseur ne l'a pas donné.
{ "type": "error", "id": "c1", "code": "rate-limited", "message": "…", "retryAfterSec": 20 }
{ "type": "prompts", "id": "c4", "items": [ { "id": "p_1a2b3c4d5e6f", "site": "@youtube", "title": "…", "body": "…" } ] }
// Réponse à prompts.move uniquement : la liste complète des prompts ET les
// préférences complètes, dans le même message — voir « prompts.move ».
{ "type": "prompts", "id": "c6b", "items": [ /* … */ ], "prefs": { "sites": { /* … */ } } }
// Réponse à prefs.get et prefs.set.
{ "type": "prefs", "id": "c6c", "sites": { "@youtube": { "order": ["…"], "removed": ["…"] } } }
// Amendement 2026-09-25 — voir « Disponibilité du fournisseur ».
{ "type": "provider.status-result", "id": "c11", "provider": "claude-api",
  "state": "ok" | "ko" | "unknown", "reason": "…", "checkedAt": "2026-09-25T14:03:00Z" }
```

Codes d'erreur : `bad-request`, `unauthorized`, `model-unavailable`, `auth-required`,
`quota-exceeded`, `rate-limited`, `context-too-large`, `cancelled`, `internal`.

## Journalisation

*Complété par l'amendement du 2026-09-30 (Native Messaging, en fin de document).*

Amendement 2026-09-25. Le broker écrit sur sa sortie d'erreur (donc dans `journalctl` sous systemd)
**une ligne par octroi, par épinglage et par refus**, préfixée `coati-broker:` :

```
coati-broker: grant via=silent|secret|session origin=<origine>
coati-broker: pin uuid=<uuid>
coati-broker: evict uuid=<uuid> lastSeen=<date>
coati-broker: reject stage=host host=<valeur>
coati-broker: reject stage=peer peerUid=<n>          (ou reason=not-found)
coati-broker: reject stage=origin origin=<origine>
coati-broker: reject stage=handshake origin=<origine> reason=<raison précise>
coati-broker: reject stage=oversized origin=<origine>
```

Au démarrage, une ligne `peer-uid check: enforced (linux)` ou
`peer-uid check: NOT enforced on <plateforme>`, et les avertissements `port` / `COATI_PORT`
décrits dans « Transport ».

**Jamais** le secret permanent, un jeton de session ni la clé API — ni entiers, ni tronqués, ni
leur empreinte. Les valeurs venues du client (`Host`, `Origin`) sont journalisées assainies :
caractères de contrôle remplacés par `?`, coupées à 200 caractères.

**Amendement 2026-09-26 — `error.message` et `reason=` du journal.** Constat du 25/09 : un
fournisseur en sous-processus peut échouer sans que la cause reste identifiable si son explication
part sur un canal que le broker ne lisait pas encore. Un provider est encouragé à capturer ce texte
quand il en a un, l'assainir (caractères de contrôle retirés, espaces réduits, coupé à ~300
caractères) et :
- l'ajouter au `message` de l'erreur envoyée au client (`{ "type": "error", "code":
  "model-unavailable", "message": "…: <texte assaini du fournisseur>" }`) — un texte qui, lui,
  correspondrait à une session non authentifiée est classé `auth-required` avant d'atteindre cette
  étape, inchangé depuis l'amendement 2026-09-21 (2) ;
- l'ajouter à la ligne `request completed` du journal, sous la forme `reason="…"` :
  `coati-broker: request completed id=… outcome=error:model-unavailable elapsedMs=… reason="…"`.

**Contrat `error.message` pour `model-unavailable` et `internal`.** Pour ces deux codes,
`message` porte (et a toujours porté — voir par ex. `ModelUnavailableError`, ou le texte brut d'une
`fetch failed`) le détail technique, **en anglais**, destiné au journal et à une ligne secondaire
dans le panneau — jamais le texte principal affiché à l'utilisateur. Le panneau choisit son libellé
français d'après `code` seul, pas d'après `message`. **Ne s'applique pas à `auth-required`,
`quota-exceeded` ni `rate-limited`** (ce dernier couple ajouté par l'amendement 2026-10-01, goal
U1) : leur `message` reste un texte figé dans la langue de la connexion, affichable tel quel —
mêmes tables `broker/src/messages.ts` (`auth.apiKeyRejected`, `provider.quotaExceeded`,
`provider.rateLimited`) que pour `auth-required`.

## Règles invariantes

*Complété par l'amendement du 2026-09-30 (Native Messaging, en fin de document).*

- Un `id` reçoit **toujours** un terminal : `done`, `error` ou la réponse propre à son type
  (`prompts`, `settings`, `settings.test-result`, `provider.status-result`). Jamais deux, jamais
  aucun — **sauf si la connexion se ferme** : l'extension traite alors la fermeture comme le
  terminal de tous les `id` encore en vol sur cette connexion (amendement 2026-09-25).
- Le broker ne renvoie jamais la clé API, ni le secret permanent, ni un jeton de session, quelle
  que soit la question posée. **Exceptions, nommées et limitées à elles seules** (amendement
  2026-09-25, audit écart n°7) :
  1. `hello-ok.token` : un jeton de session, délivré seulement à la connexion qu'il authentifie
     (voir « Poignée de main ») ;
  2. `GET /pair` : le secret permanent, affiché pour l'épinglage d'une extension Firefox (voir
     « Page `/pair` »), après l'admission `Host` et UID du pair.
- Le broker ne renvoie jamais le contenu brut de `config.json`. `settings` expose le fournisseur,
  le modèle et un état par fournisseur (`available`, `configured`, `reason`), rien d'autre.
- Les requêtes sont sérialisées par connexion ; une deuxième requête pendant qu'une autre coule
  est acceptée, mais le broker ne garantit pas l'ordre d'arrivée entre `id` distincts.
- Taille maximale d'un message client : 256 Ko. Au-delà : `error` puis fermeture (4401 pendant la
  poignée de main, 1009 après) — voir « Limites côté broker ».
- Aucune route HTTP ne modifie l'état du broker.
- Le broker ne change jamais de fournisseur de lui-même.
- Amendement 2026-09-25 (types de page). Un `context` sans `pageKind`, `facts` ni `items` produit
  exactement la validation et le prompt d'avant l'amendement. Tout type de page douteux, inconnu
  ou vide de données retombe sur ce comportement ; il ne produit jamais d'erreur.
- Amendement 2026-09-25 (types de page). L'extraction lit, elle n'agit pas : aucun clic, aucun
  défilement, aucune fermeture de bandeau, aucune requête réseau, aucun lien suivi pour remplir
  `facts` ou `items`.

## Annexe — écarts de l'audit du jeton (§5), résolution

Amendement 2026-09-25. Référence : `notes/audit_jeton_2026-09-25.md` §5.

| # | Écart | Résolution |
|---|---|---|
| 1 | « Jeton frais » promis, secret permanent renvoyé | Le code change : jeton de session frais en mémoire (« Poignée de main ») |
| 2 | `/pair` : « premier ID » écrit, tous injectés | Texte corrigé : `/pair` n'injecte plus aucun ID ; le code retire les ID de la page |
| 3 | 4401 « raison en clair » contre raison générique | Texte corrigé : raison générique `unauthorized` |
| 4 | ID inconnu « retombe sur `/pair` » | Texte corrigé : refus à l'`Origin`, remède = `allowedExtensionIds` + redémarrage ; chemin un clic retiré |
| 5 | Port personnalisé « marche par collage » | Texte corrigé : port 8787 figé ; le code cesse de lire `port` |
| 6 | « Collé une fois » | Texte corrigé (Chromium : jamais ; Firefox installé : une fois par installation ; temporaire : une fois par profil, prouvé le 25/09) ; le code ajoute l'appairage silencieux des uuid épinglés |
| 7 | « Ne renvoie jamais le jeton » sans exception `/pair` | Texte corrigé : deux exceptions nommées |
| 8 | Frontière « même compte » non appliquée | Texte précisé (« Frontière de menace ») ; le code ajoute `Host` et UID du pair |
| 9 | Ré-appairage Firefox sans redémarrage promis | Le code change : liste relue à chaud ; texte : révocation = supprimer une ligne |
| 10 | « Tout le reste répond 404 » | Texte corrigé : table des routes (400, 403, 405) ; le code ajoute 403 et 405 |
| 11 | Message trop gros : `error` + fermeture promis | Le code change : `error` `oversized` puis fermeture 1009 après authentification |

## 2026-09-26 (bis) — simplifications

Suite à `notes/kiss_audit_2026-09-26.md`. Quatre éléments retirés du protocole, sans changement de
comportement observable côté extension (le panneau n'utilisait déjà que la valeur qui reste) :

1. **`summarize.length`** (`"short" | "medium"`) supprimé. Le panneau n'envoyait jamais `"short"` —
   seul `"medium"` partait en pratique. Le comportement figé est celui d'aujourd'hui pour
   `"medium"` (6 à 8 puces, 12 faits maximum, 4 à 6 points à vérifier). Un broker qui reçoit encore un
   `summarize` avec un champ `length` l'ignore silencieusement (compatibilité : un champ en trop
   n'est jamais une erreur).
2. **`ContextKind` `"selection"`** supprimé — grep confirmé (26/09) : rien dans l'extension ne
   construit jamais un `Context` avec ce `kind` (les `contexts: ["selection"]` de
   `background/service-worker.js` sont l'API `chrome.contextMenus`, sans rapport). `ContextKind`
   ne vaut plus que `"page" | "youtube"`.
3. **`hello-ok.models` et `hello-ok.capabilities`** supprimés — valeurs figées
   (`["claude"]`/`["chat","summarize"]`) que rien ne lisait ni côté extension ni dans les tests. Un
   `hello-ok` ne porte plus que `type`, `v` et `token`.
4. **Migration `firefox-extension-uuid.txt` (valeur unique)** retirée (item 6 de l'audit) — vérifié
   le 26/09 : aucune installation existante ne porte plus ce fichier pré-25/09 (seuls
   `chrome-profile/`, `firefox-extension-uuids.txt`, `pairing.txt`, `profile-*/` sont présents dans
   `~/.local/share/wingpen`, le dossier de l'époque — voir amendement 2026-09-27 ci-dessous). Voir
   "Poignée de main" → "Cas Firefox" ci-dessus.

Un broker mis à jour et une extension mise à jour partent toujours ensemble (même paquet) ; ces
quatre champs disparaissent des deux côtés du même geste, il n'y a pas de fenêtre où l'un des deux
seulement les connaît.

## Amendement 2026-09-27 : renommage Wingpen → Coati

Le produit décrit par ce document s'appelait Wingpen ; il s'appelle désormais **Coati**. Rien ne
change dans le comportement décrit plus haut — ce paragraphe recense les identifiants qui changent
de nom, côté fil, disque, variables d'environnement et service. **Aucune compatibilité
rétroactive** : un seul utilisateur, une seule machine, migrée une fois par
`scripts/migrate-wingpen-to-coati.sh`. Les passages qui racontent une fonctionnalité déjà retirée
(le message externe `wingpen:pair`, le bouton « Connecter Wingpen ») gardent l'ancien nom : ils
sont de l'histoire, pas du présent.

| Catégorie | Avant | Après |
|---|---|---|
| Dossier de configuration | `~/.config/wingpen/` | `~/.config/coati/` |
| Dossier de données | `~/.local/share/wingpen/` | `~/.local/share/coati/` |
| Variable d'environnement (port de test) | `WINGPEN_PORT` | `COATI_PORT` |
| Préfixe des lignes de journal du broker | `wingpen-broker:` | `coati-broker:` |
| Délimiteur du prompt système (anti-injection) | `<<<wingpen-<16 hex>` … `wingpen-<16 hex>>>>` | `<<<coati-<16 hex>` … `coati-<16 hex>>>>` |
| ID gecko Firefox (`browser_specific_settings.gecko.id`) | `wingpen@localhost` | `coati@getcoati.com` — nouvel appairage Firefox obligatoire (l'uuid `moz-extension://` change avec l'ID gecko) |
| Unité systemd utilisateur | `packaging/wingpen-broker.service` | `packaging/coati-broker.service` |
| Nom affiché (manifestes, options, panneau) | « Wingpen » | « Coati » |

Ce qui **ne change pas** : l'ID d'extension Chromium `hehlgipomfminodhahcjbencblepjhah` (dérivé de
la clé `extension/manifest.json:key`, `extension-key.pem` inchangée) ; le port 8787 ; le dossier du
dépôt (`~/projets/wingpen`) et son dépôt GitHub, renommés par Romain hors de ce protocole, GitHub
redirigeant l'ancien nom.

## Amendement 2026-09-30 : Native Messaging (G4)

**Pourquoi.** Le 25/09, une autre extension munie d'une permission d'hôte sur `127.0.0.1` a réécrit
l'en-tête `Origin` de son WebSocket (Brave : `declarativeNetRequest` depuis une page d'extension ;
Firefox : `webRequest` bloquant) et obtenu l'appairage silencieux, donc une session complète (voir
« Frontière de menace »). Tant que l'`Origin` est la seule chose qui distingue Coati d'une autre
extension, ce trou reste ouvert. Native Messaging le ferme : c'est le navigateur qui lance le
programme natif, et il ne le lance que pour une extension dont l'ID figure dans le manifeste d'hôte
(`allowed_origins` sous Chromium, `allowed_extensions` sous Firefox), sans joker. Une autre
extension ne peut pas l'appeler, quels que soient ses en-têtes.

**Ce qui change, en bref.**
- À chaque démarrage, le broker tire au sort une **clé de broker** (256 bits), la garde en mémoire
  et l'écrit dans un fichier 0600. Un **hôte natif** — le même exécutable que le broker, lancé par
  le navigateur — lit ce fichier et remet la clé à l'extension, et à elle seule.
- Le WebSocket reste le transport, sur `ws://127.0.0.1:8787/ws`. Sa poignée de main passe en
  `v: 2` : un défi-réponse HMAC dans les deux sens. Le broker prouve qu'il détient la clé avant que
  l'extension n'envoie quoi que ce soit ; l'extension prouve ensuite la même chose. La clé ne
  circule jamais sur le WebSocket.
- L'appairage silencieux sur l'`Origin` seul, `/pair`, le collage historique, la poignée de main
  `v: 1` et les jetons de session disparaissent du code, dans tous les modes — pas seulement
  derrière un drapeau. Pour les navigateurs en Flatpak ou Snap, qui ne peuvent pas lancer d'hôte
  natif, la clé `legacyPairing` de `config.json` (éteinte par défaut) ajoute juste une seconde clé
  possible — un secret permanent `S` — à la même poignée de main `v: 2`.
- L'épinglage des uuid Firefox est retiré : c'est la clé, pas l'`Origin`, qui authentifie.

Native Messaging sert ici à **livrer une clé**, pas à transporter les messages : pas de relais, pas
de fichier de socket par système, pas de plafond d'1 Mo à contourner pour la réponse `prompts`. Le
reste du protocole (messages, limites, fournisseurs) est inchangé ; seuls les messages de la
poignée de main portent `v: 2`.

### Hôte natif : nom et manifestes

Nom : **`com.getcoati.broker`**. Il respecte les règles des deux familles (minuscules, chiffres,
`_`, points non consécutifs, ni en tête ni en fin).

Un fichier par famille de navigateurs, jamais les deux clés dans un même fichier.

Chromium (Chrome, Chromium, Brave, Edge) :

```json
{
  "name": "com.getcoati.broker",
  "description": "Coati local broker - pairing helper",
  "path": "<chemin absolu de l'exécutable ou du lanceur>",
  "type": "stdio",
  "allowed_origins": ["chrome-extension://hehlgipomfminodhahcjbencblepjhah/"]
}
```

Firefox :

```json
{
  "name": "com.getcoati.broker",
  "description": "Coati local broker - pairing helper",
  "path": "<chemin absolu de l'exécutable ou du lanceur>",
  "type": "stdio",
  "allowed_extensions": ["coati@getcoati.com"]
}
```

- `allowed_origins` ne contient que l'ID épinglé, avec la barre oblique finale exigée par Chrome ;
  `allowed_extensions` ne contient que l'ID gecko. Une copie de l'extension publiée sous un autre ID
  ne peut pas se servir de l'hôte : c'est voulu.
- `path` est absolu sur tous les systèmes (Windows admet un chemin relatif au manifeste ; on ne s'en
  sert pas). Il désigne soit l'exécutable compilé `coati-broker`, soit un petit script lanceur (voir
  « Lanceur »). Un manifeste d'hôte ne peut pas porter d'arguments : d'où la détection décrite plus
  bas.
- Le manifeste ne contient aucun secret : 0644, dans un dossier `NativeMessagingHosts/` créé en
  0700 s'il n'existe pas.

### Emplacements des manifestes

Aucun droit d'administrateur. Linux et macOS : un fichier `com.getcoati.broker.json` dans le
dossier indiqué.

| Navigateur | Linux | macOS |
|---|---|---|
| Chrome | `~/.config/google-chrome/NativeMessagingHosts/` | `~/Library/Application Support/Google/Chrome/NativeMessagingHosts/` |
| Chromium | `~/.config/chromium/NativeMessagingHosts/` | `~/Library/Application Support/Chromium/NativeMessagingHosts/` |
| Brave | `~/.config/BraveSoftware/Brave-Browser/NativeMessagingHosts/` | `~/Library/Application Support/BraveSoftware/Brave-Browser/NativeMessagingHosts/` |
| Edge | `~/.config/microsoft-edge/NativeMessagingHosts/` | `~/Library/Application Support/Microsoft Edge/NativeMessagingHosts/` |
| Firefox | `~/.mozilla/native-messaging-hosts/` | `~/Library/Application Support/Mozilla/NativeMessagingHosts/` |

L'installateur écrit dans chaque dossier dont le dossier de configuration du navigateur existe déjà
(par exemple `~/.config/BraveSoftware/Brave-Browser/`), pas ailleurs ; une option `--all` force
l'écriture dans tous. Brave sous Linux lit son propre dossier et ignore celui de Chrome (mesuré le
25/09, Brave 152) ; les emplacements Brave et Edge hors Linux sont ceux de leur dossier de profil,
non mesurés à ce jour (voir « Risques »).

Windows : les deux manifestes sont écrits dans `%LOCALAPPDATA%\Coati\native-host\`
(`com.getcoati.broker.chromium.json`, `com.getcoati.broker.firefox.json`, barres obliques inverses
échappées dans `path`). Pour chaque navigateur, une clé de registre sous `HKEY_CURRENT_USER`, dont
la **valeur par défaut** (`REG_SZ`) est le chemin complet du manifeste de sa famille :

| Navigateur | Clé |
|---|---|
| Chrome | `HKCU\Software\Google\Chrome\NativeMessagingHosts\com.getcoati.broker` |
| Chromium | `HKCU\Software\Chromium\NativeMessagingHosts\com.getcoati.broker` |
| Brave | `HKCU\Software\BraveSoftware\Brave-Browser\NativeMessagingHosts\com.getcoati.broker`, et la clé Chrome ci-dessus |
| Edge | `HKCU\Software\Microsoft\Edge\NativeMessagingHosts\com.getcoati.broker` |
| Firefox | `HKCU\Software\Mozilla\NativeMessagingHosts\com.getcoati.broker` |

Forme : `reg add "HKCU\Software\Google\Chrome\NativeMessagingHosts\com.getcoati.broker" /ve /t
REG_SZ /d "<chemin du manifeste>" /f`. Écrire la clé Chrome en plus de celle de Brave ne coûte rien
et couvre une version de Brave qui lirait celle de Chrome.

### Clé de broker

- **Tirage.** `randomBytes(32)` à chaque démarrage du broker, gardée en mémoire. Représentation :
  64 caractères hexadécimaux minuscules. La clé HMAC est les 32 octets, pas la chaîne.
- **Fichier.** `~/.local/share/coati/broker-key.json` (le dossier de données actuel, sur tous les
  systèmes), contenu :
  `{"v":1,"key":"<64 hex>","pid":<pid du broker>,"startedAt":"<ISO 8601 UTC>"}`.
- **Écriture** seulement **après** que l'écoute sur le port a réussi : un second broker qui échoue à
  écouter ne touche jamais le fichier du premier. Écriture atomique : fichier temporaire
  `broker-key.json.tmp` créé en 0600 dans le dossier 0700, remis à 0600, puis renommé par-dessus.
- **Effacement** à l'arrêt propre (`SIGTERM`, `SIGINT`), seulement si le `pid` du fichier est celui
  du broker qui s'arrête.
- **Durée de vie** : celle du processus broker. **Rotation** : redémarrer le broker. Pas d'autre
  expiration.
- Jamais journalisée, ni entière, ni tronquée, ni son empreinte ; jamais envoyée sur le WebSocket.
- **Tests.** Nouvelle variable `COATI_DATA_DIR`, pour les tests seulement : elle remplace
  `~/.local/share/coati` pour le broker et pour l'hôte, et le broker le dit au démarrage. Quand
  `COATI_PORT` est défini sans `COATI_DATA_DIR`, le broker **n'écrit pas** `broker-key.json` : un
  broker de test n'écrase jamais la clé du vrai.

### Écoute exclusive du port, durcissement du dossier et fichiers temporaires

**Pourquoi pas de MAC par trame.** Relayer le WebSocket d'une extension légitime demanderait soit
d'intercepter la connexion ouverte par une autre extension (les navigateurs ne le permettent pas :
aucune extension ne peut lire le WebSocket d'une autre), soit de partager le port 8787 avec un
second processus. La parade porte donc sur le port, pas sur chaque trame :

- **Écoute exclusive.** `Bun.serve` est appelé avec `reusePort: false` (son défaut, rendu explicite
  ici) : un second processus qui tente d'écouter sur `127.0.0.1:8787` échoue à l'appel (erreur
  `EADDRINUSE` ou équivalente), jamais un partage silencieux du port. Sous Windows, faute d'un
  réglage plus fin exposé par Bun, l'exclusivité par défaut du système suffit au même effet.
  **Test** : un second `startServer` sur le même port lève, jamais n'écoute.
- **Risque résiduel.** Le fichier de clé n'est écrit qu'après une écoute réussie (voir « Clé de
  broker » ci-dessus) : un processus qui échouerait à écouter, pour une raison qui ne serait pas le
  port déjà pris (droits, ressource système), n'écrit jamais de clé et ne peut donc jamais être pris
  pour le broker. Repris dans « Frontière de menace, révisée ».

**Durcissement du dossier de données.** Au démarrage, avant toute lecture ou écriture dans
`~/.local/share/coati` (ou `COATI_DATA_DIR`) : `lstat` du dossier. Un lien symbolique, ou un dossier
existant dont le propriétaire (UID, POSIX seulement) n'est pas celui du broker, fait **refuser le
démarrage** avec un message clair, plutôt que de suivre le lien ou d'écrire chez un autre compte. Un
dossier existant du bon compte mais aux droits plus larges que 0700 est remis à 0700. Même règle
pour le dossier de configuration (`~/.config/coati`).

**Fichiers temporaires.** `broker-key.json`, `pairing-secret` et `config.json` s'écrivent tous de la
même façon : un fichier `<nom>.tmp` ouvert `O_CREAT | O_EXCL | O_NOFOLLOW`, mode 0600 — un `.tmp`
laissé par un plantage précédent est supprimé d'abord, jamais réouvert ni suivi s'il s'agit d'un
lien — puis renommage atomique par-dessus le fichier final.

### Hôte natif : lancement et détection

**Même exécutable que le broker.** Il passe en mode hôte si l'une de ces conditions tient :
- un argument `--native-host` (tests, lanceurs) ;
- un argument de la forme `chrome-extension://<32 lettres a-p>/` — Chrome passe l'origine de
  l'appelant en argument ; sous Windows il ajoute `--parent-window=<n>`, l'ordre n'est pas supposé :
  tous les arguments sont examinés ;
- un argument égal à `coati@getcoati.com` — Firefox passe le chemin du manifeste puis l'ID de
  l'extension.

Sinon, mode broker (systemd le lance sans argument ; `--check-modules` reste un mode à part). La
bascule se fait **avant tout le reste** : en mode hôte, aucun port ouvert, aucune configuration lue,
aucun module chargé, rien écrit sur la sortie standard hormis la réponse. Aucun module importé par
l'exécutable ne doit écrire sur la sortie standard au chargement.

**Contrôle de l'appelant** (défense en profondeur : le navigateur a déjà vérifié l'appelant avant de
lancer le processus, via `allowed_origins`/`allowed_extensions` ci-dessus ; ce qui suit ne protège
que contre un appel direct de l'exécutable, hors navigateur) :
- forme Chromium : un argument valant exactement `chrome-extension://hehlgipomfminodhahcjbencblepjhah/` ;
- forme Firefox : **les deux** doivent être présents — un argument égal à `coati@getcoati.com` **et**
  un autre argument qui ressemble à un chemin de fichier (le chemin du manifeste, que Firefox
  transmet toujours avant l'ID). L'ID seul, sans second argument, est un appelant non reconnu :
  Firefox ne l'invoque jamais ainsi ; un exécutable lancé à la main avec le seul ID ne doit pas
  passer pour lui.

Aucun appelant reconnu (par exemple `--native-host` seul, un ID Firefox sans chemin, ou un autre ID
ou une autre origine) : réponse `forbidden-caller`.

**Lanceur.** Pour un broker lancé depuis les sources, `path` désigne un script (0700), par
exemple :

```sh
#!/bin/sh
exec /chemin/absolu/vers/bun /chemin/absolu/vers/coati/broker/src/native-host.ts "$@"
```

- Chemins absolus obligatoires : l'hôte hérite de l'environnement du navigateur, pas de celui du
  service ; sous macOS, un navigateur lancé depuis le Dock n'a qu'un `PATH` minimal.
- `"$@"` obligatoire : le contrôle de l'appelant lit les arguments.
- Le lanceur n'écrit rien sur la sortie standard.

`broker/src/native-host.ts` s'exécute seul (`import.meta.main`) ; l'exécutable compilé, construit
depuis `broker/src/server.ts`, y bascule selon la règle ci-dessus.

**Pourquoi le même exécutable.** Un seul fichier à installer, à débloquer (binaire non signé) et à
mettre à jour ; aucun décalage de version possible entre l'hôte et le format de `broker-key.json` ;
l'hôte réutilise le code des dossiers de `config.ts`. Le coût, charger tout l'exécutable pour
répondre à une question, se paie une fois par session de navigateur.

### Cadrage et échange avec l'hôte

- **Trame** : 4 octets de longueur, entier non signé dans l'ordre natif de la machine
  (petit-boutiste sur toutes les plateformes visées : x86-64, arm64), puis le JSON UTF-8 de cette
  longueur **en octets**.
- L'hôte lit **exactement une** trame et n'attend pas la fin de l'entrée (Chrome garde l'entrée
  ouverte en mode « un coup »). Longueur hors de 1 à 4 096 : aucune réponse, sortie 1. Pas de trame
  complète dans les 5 s, ou fin de l'entrée avant : aucune réponse, sortie 1. JSON invalide ou
  message inattendu : réponse `bad-request`.
- **Requête** (extension → hôte) : `{"type":"key.get","v":1}`.
- **Réponses** (hôte → extension), une seule :
  - `{"type":"key","v":1,"key":"<64 hex>"}` ;
  - `{"type":"error","v":1,"code":"broker-not-running"}` : fichier absent, illisible ou malformé,
    ou `pid` qui ne désigne pas un processus vivant du même compte (`process.kill(pid, 0)` échoue,
    `ESRCH` comme `EPERM` : un processus d'un autre compte n'est pas notre broker) ;
  - `{"type":"error","v":1,"code":"forbidden-caller"}`, `"bad-request"`, `"internal"`.
- La réponse part en **une seule écriture** (longueur et corps ensemble). L'hôte ne se termine
  (code 0) qu'une fois l'écriture confirmée : sous Windows, un tube peut perdre des données non
  vidées à la sortie.
- Journal de l'hôte : sur sa sortie d'erreur seulement (lue par le navigateur), une ligne préfixée
  `coati-native-host:` par erreur, jamais la clé.
- L'hôte n'écrit rien sur le disque et n'ouvre aucune connexion.

**Côté extension** : `runtime.sendNativeMessage("com.getcoati.broker", {"type":"key.get","v":1})`,
en mode « un coup » : le navigateur lance un processus par appel et le ferme après la réponse. Pas
de `connectNative` : rien à garder ouvert, le WebSocket reste le transport et garde son alarme de
30 s. L'extension borne l'appel à 5 s.

| Résultat | Conduite de l'extension |
|---|---|
| `key` | range la clé dans `chrome.storage.session` sous `brokerKey`, puis poignée de main `v: 2` |
| erreur `broker-not-running` | état `"disconnected"`, reconnexion au rythme habituel ; l'essai suivant rappelle l'hôte |
| promesse rejetée (hôte non installé, manifeste absent ou mauvais ID, navigateur en Flatpak ou Snap, hôte planté, 5 s dépassées) | `S` (secret permanent) présent en `chrome.storage.session` : poignée de main `v: 2` avec `key: "pasted"` ; sinon état `"no-host"`, nouvel essai au rythme de l'alarme de 30 s |
| autre code d'erreur | état `"no-host"`, une ligne dans la console de l'extension |

Les messages d'erreur des navigateurs ne sont pas analysés : ils varient d'un navigateur et d'une
version à l'autre.

### Poignée de main `v: 2`

Après l'admission HTTP (liste `Host`, UID du pair sous Linux — inchangées) :

1. **`Origin`** : `chrome-extension://<ID>` avec `<ID>` dans `allowedExtensionIds`, ou
   `moz-extension://<uuid>` bien formé (n'importe quel uuid : c'est la clé qui authentifie, plus
   l'uuid). Sinon refus, avant la lecture de tout message. Cette étape n'arrête plus que les pages
   web.
2. Client → `{"type":"hello","v":2,"nonce":"<cN>","key":"native"|"pasted","lang":"fr"}`. `cN` : 32
   octets aléatoires, 64 hex minuscules, nouveau à chaque connexion. `key` dit quelle clé sert de
   `K` pour la suite : `"native"` (la clé de broker, obtenue par l'hôte natif) si absent, ou
   `"pasted"` (le secret permanent `S` du mode hérité, collé à la main — voir « Mode hérité »).
   `"pasted"` alors que `legacyPairing` est éteint est un échec, raison `legacy-pairing-disabled`
   (journal seulement, jamais sur le fil). `lang` (amendement 2026-09-30 ter, goal G6, voir le paragraphe daté en tête de
   ce document) : optionnel, chaîne BCP 47 brute, normalisée côté broker vers `en`/`fr`/`zh_CN`.
   Une valeur absente ou de forme invalide n'échoue jamais la poignée de main ;
   seule une valeur qui n'est pas une chaîne, ou une chaîne de plus de 64 caractères, est un
   `bad-request` (avant même l'authentification — la langue n'a rien de secret).
3. Broker → `{"type":"challenge","v":2,"nonce":"<bN>","proof":"<bP>"}`. `bN` : 32 octets frais du
   générateur cryptographique ; `bP = HMAC-SHA256(K, "coati-v2-broker:" + cN + ":" + bN)`, en hex
   minuscules, `K` étant les 32 octets de la clé désignée par `key` à l'étape 2.
4. L'extension vérifie `bP`. **Différent** : elle ferme (code 4000) sans rien envoyer d'autre,
   efface `brokerKey`, rappelle l'hôte et retente **une fois par cycle de connexion** (un broker
   redémarré entre la lecture de la clé et la connexion en a changé). Nouvel échec : état
   `"broker-untrusted"` ; ni texte de page ni prompt ne part jusqu'au cycle suivant.
5. Client → `{"type":"auth","v":2,"proof":"<eP>"}`,
   `eP = HMAC-SHA256(K, "coati-v2-extension:" + cN + ":" + bN)`.
6. Le broker compare `eP` en temps constant (`timingSafeEqual` sur 32 octets). Égal :
   `{"type":"hello-ok","v":2}`, sans jeton, et `grant via=<key>` au journal (`native` ou `pasted`).
   Sinon, l'échec générique habituel (`error` `unauthorized`, fermeture 4401).

Un seul délai de **3 s**, de l'ouverture du WebSocket à la réception d'`auth`. Tout message de forme
inattendue (`auth` avant `hello`, second `hello`) est un échec. `cN`, `bN`, `bP` et `eP` sont chacun
validés contre `^[0-9a-f]{64}$` **avant** tout décodage hexadécimal ; une valeur qui ne passe pas ce
filtre est un échec immédiat, jamais une exception qui remonterait. La comparaison en temps constant
ne s'exécute qu'une fois ce filtre passé, sur deux tampons de 32 octets chacun, et ne lève jamais —
une entrée qui la ferait échouer produit `false`, jamais une exception non rattrapée. Un `hello`
`v: 1` — quel que soit `legacyPairing` — est un échec : `v` non reconnu, comme toute valeur hors `2`
(voir « Mode hérité » : la poignée de main `v: 1` est retirée du code, pas seulement masquée).

**Pourquoi cette forme.** Les deux libellés distincts empêchent de renvoyer au broker sa propre
preuve comme preuve d'extension ; `bN`, frais à chaque connexion, empêche de rejouer un `auth`
capturé. Le broker prouve le premier : un programme qui occupe le port pendant que le broker est
arrêté ne reçoit qu'un nonce aléatoire, puis plus rien. Un HMAC ne révèle pas la clé.

**4401 avant le défi** (origine refusée, typiquement un ID absent d'`allowedExtensionIds`) ou après
`auth` : l'extension efface `brokerKey`, rappelle l'hôte une fois et retente une fois par cycle ;
nouvel échec : état `"no-token"`. L'hôte natif ne sert jamais que l'ID épinglé (`allowed_origins` du
manifeste Chromium) : un `"no-token"` persistant signale presque toujours un `allowedExtensionIds`
modifié à la main dans `config.json` pour un ID différent de celui que l'hôte sert — le corriger là,
pas côté extension.

**Plafond de connexions non authentifiées.** Le broker n'accepte pas plus de **16** connexions
WebSocket simultanées n'ayant pas encore atteint `hello-ok` (comptées dès l'ouverture, décomptées à
l'authentification ou à la fermeture). Une dix-septième est refusée immédiatement (fermeture 4401,
avant tout message). Les refus sont journalisés avec une limite de débit : une ligne au plus toutes
les 10 s, portant le nombre de refus survenus dans cette fenêtre — pas une ligne par refus, pour
qu'une machine qui ouvrirait des connexions en boucle ne remplisse pas le journal.

**Cycle de vie côté extension.**
- Redémarrage du service worker : `chrome.storage.session` survit, la clé est réutilisée, aucun
  appel à l'hôte.
- Redémarrage du navigateur : `chrome.storage.session` est vidé, un appel à l'hôte (15 à 25 ms
  mesurés le 25/09).
- Redémarrage du broker : la preuve du broker ne correspond plus (étape 4), un appel à l'hôte.
- Aucun geste de l'utilisateur, dans aucun de ces cas. L'alarme de 30 s est inchangée.

### Mode hérité : `legacyPairing`

Clé `legacyPairing` de `~/.config/coati/config.json`, booléen, absente par défaut (équivaut à
`false`). Lue au démarrage seulement, comme `allowedExtensionIds`. Une valeur présente autre que
`true` ou `false` vaut `false`, avec une ligne d'avertissement au démarrage.

Pour les navigateurs qui ne peuvent pas lancer d'hôte natif (Flatpak, Snap) : `legacyPairing: true`
ne rouvre ni jeton de session, ni page HTML, ni poignée de main distincte. Il ajoute une **seconde
clé possible** à la même poignée de main `v: 2` (« Poignée de main `v: 2` ») :

- Le broker crée, **une seule fois**, un secret permanent `S` de 32 octets, au premier besoin
  (premier `--show-pairing-secret`, ou premier démarrage avec `legacyPairing: true`) —
  `~/.local/share/coati/pairing-secret`, mêmes règles de dossier et de fichier que
  `broker-key.json` (« Durcissement du dossier de données »). `S` ne change jamais de lui-même ;
  seule sa suppression à la main en force le renouvellement.
- `coati-broker --show-pairing-secret` l'imprime sur la sortie standard et se termine (code 0),
  sans ouvrir de port ni rien d'autre que lire `legacyPairing` : c'est le seul moyen de le lire, à
  copier dans les options de l'extension. Si `legacyPairing` vaut `false`, la commande refuse avec
  un message clair plutôt que d'imprimer ou de créer `S` — pas de secret permanent créé pour un mode
  éteint.
- Le client colle `S` dans les options de l'extension ; celles-ci envoient
  `{"type":"hello","v":2,"nonce":cN,"key":"pasted"}` à la place de `"native"`, et déroulent
  exactement la même poignée de main `v: 2` avec `K = S`. `"pasted"` alors que `legacyPairing` est
  éteint est un échec, raison `legacy-pairing-disabled` (journal seulement).
- Jamais journalisé, ni entier ni tronqué ; jamais servi par une page HTML — il n'en existe plus,
  dans aucun mode ; jamais transmis par Native Messaging (l'hôte ne connaît que la clé de broker).

**Retiré, dans tous les modes, y compris hérité** : la poignée de main `v: 1`, les jetons de
session, la page `GET /pair`, le champ de collage historique, et l'appairage silencieux sur la seule
foi de l'`Origin`. Un `hello` `v: 1` — quel que soit `legacyPairing` — est un échec : `v` non
reconnu, comme n'importe quelle valeur hors `2`.

Conséquence : en mode hérité, `S` est permanent et lisible par n'importe quel processus du même
compte (comme l'était `pairing.txt` avant lui) — un tel processus peut s'authentifier. Ce risque,
déjà accepté dans l'amendement 2026-09-25 pour le secret permanent, subsiste ici sous la même forme,
mais réduit à la même poignée de main `v: 2` que le mode par défaut : pas de jeton, pas de page HTML,
pas d'octroi silencieux. Écrit dans `docs/INSTALL.md`, à côté de la commande `--show-pairing-secret`.

### Frontière de menace, révisée

En mode par défaut, cette table remplace celle de l'amendement 2026-09-25.

| Adversaire | Arrêté par |
|---|---|
| Machine du réseau local | l'écoute sur `127.0.0.1` seulement |
| Page web hostile | l'en-tête `Origin` ; elle ne peut ni appeler l'hôte natif ni connaître la clé |
| Page web par *DNS rebinding* | la liste `Host` |
| Autre extension, Chromium ou Firefox, `Origin` réécrit compris | la clé : seul l'hôte natif la délivre, et le navigateur ne le lance que pour l'ID épinglé ; sans elle, pas de preuve |
| Processus d'un autre compte, Linux | l'UID du pair (inchangé) ; `broker-key.json` en 0600 dans un dossier 0700 |
| Processus d'un autre compte, macOS | `broker-key.json` en 0600 dans un dossier 0700 : il ne peut pas lire la clé, donc pas prouver |
| Processus d'un autre compte, Windows | `broker-key.json` sous le profil de l'utilisateur, protégé par l'ACL héritée du profil (voir « Windows ») |
| Programme qui occupe le port 8787 pendant que le broker est arrêté | la preuve du broker : l'extension n'envoie rien à qui ne connaît pas la clé (vrai aussi en mode hérité : la preuve porte sur `S`, pas sur l'`Origin`) |
| Un second processus qui tente d'écouter sur le port 8787 pendant que le broker tourne | `reusePort: false` : l'écoute échoue, aucune clé n'est jamais écrite par ce second processus (« Écoute exclusive du port ») |

**UID du pair hors Linux : non porté.** Il faudrait `proc_pidinfo` ou `lsof` sous macOS, et
`GetExtendedTcpTable` plus le jeton du processus propriétaire sous Windows : des appels natifs que
Bun n'offre pas sans FFI. La clé et les droits de son fichier suffisent contre un autre compte. La
différence qui reste : hors Linux, un processus d'un autre compte peut encore ouvrir une connexion
et envoyer un `hello` ; il reçoit un défi (un nonce aléatoire et une preuve inutilisable sans la
clé), puis un refus. Sous Linux, il est refusé dès l'admission. Dans les deux cas il n'obtient rien.
La ligne de démarrage `peer-uid check: NOT enforced on <plateforme>` reste.

**Ce qui reste accepté :**
- un processus du même compte : il lit `broker-key.json` comme il lisait `pairing.txt`
  (inchangé) ;
- un administrateur de la machine (`root`, groupe Administrateurs de Windows) ;
- avec `legacyPairing` à `true` : `S` est lisible par tout processus du même compte, comme
  `broker-key.json` — mais l'authentification reste la poignée de main `v: 2` complète (défi-réponse,
  jamais d'octroi sur la seule foi de l'`Origin`) ; aucune page HTML ne le sert, il ne peut être lu
  qu'en console via `--show-pairing-secret`, gagné par un accès au compte du même niveau que celui
  qui suffisait déjà à lire `pairing.txt`.
- la dépendance à Local Network Access (voir « Transport ») ne change pas : le WebSocket reste le
  transport.

### Windows

- **Lancement.** Chrome lance l'hôte par `cmd.exe /d /c`, entrée et sortie redirigées vers des
  tubes, avec `--parent-window=<n>` en plus de l'origine ; Firefox lance l'exécutable directement.
  `path` désigne `coati-broker.exe`, par exemple sous `%LOCALAPPDATA%\Coati\`. Un lanceur `.bat`
  fonctionne aussi (il commence par `@echo off` et transmet `%*`), mais l'exécutable compilé n'en a
  pas besoin.
- **Mode binaire.** Bun, comme Node, lit l'entrée et écrit la sortie standard en octets, sans
  conversion des fins de ligne. En mode hôte : jamais d'encodage fixé sur ces flux, jamais de
  `console.log`.
- **Vidage** avant la sortie : voir « Cadrage ».
- **Droits des fichiers.** Les modes Unix ne s'appliquent pas (`chmod` n'y bascule que la lecture
  seule). Le broker ne pose pas d'ACL lui-même : son dossier de données est sous le profil
  (`%USERPROFILE%\.local\share\coati`), dont l'ACL par défaut, héritée, ne laisse passer que
  l'utilisateur, `SYSTEM` et les Administrateurs. Un profil déplacé vers un emplacement partagé perd
  cette protection ; la politique de sécurité le dit.
- **ACL explicite.** L'installateur (`scripts/install/`) applique en plus `icacls` à ce dossier pour
  n'y laisser que l'utilisateur courant, `SYSTEM` et les Administrateurs, en défense en profondeur au-delà de l'héritage
  du profil. Le broker lui-même ne pose toujours pas d'ACL (voir « Droits des fichiers » ci-dessus).
- **Binaire non signé.** L'installateur retire la marque « téléchargé depuis Internet » de
  l'exécutable qu'il pose (`Unblock-File`) ; sans cela SmartScreen peut bloquer son lancement par le
  navigateur sans message visible, et l'extension affiche `"no-host"`.

### macOS

- Emplacements : voir la table ci-dessus. Modes 0600 et 0700 comme sous Linux.
- Un navigateur lancé depuis le Dock transmet un environnement minimal : chemins absolus dans le
  lanceur.
- **Binaire non signé.** Sur puce Apple, un exécutable doit porter au moins une signature ad hoc
  (`codesign -s -`), qui n'est pas une signature de développeur. L'installateur retire l'attribut
  `com.apple.quarantine` de l'exécutable qu'il pose ; sans cela Gatekeeper bloque le lancement et
  l'extension affiche `"no-host"`.

### Côté extension

- **Permission `nativeMessaging` obligatoire**, dans `manifest.json` et `manifest.firefox.json`.
  Les tables de compatibilité de MDN la donnent facultative depuis Chrome 29 et Firefox 87, mais un
  bogue Firefox (1630415) l'a signalée en échec sous Firefox 90, sans correction établie ; et une
  permission facultative exigerait un `permissions.request()` depuis un geste dans un document avant
  le premier appairage, donc un clic de plus. Obligatoire : un avertissement à l'installation,
  accepté.
- Aucun changement de `connect-src` : Native Messaging n'est pas soumis à la CSP.
- Clés de `chrome.storage.session` : `brokerKey` (la clé de broker, ou `S` en mode hérité — même
  emplacement, même règle). Jamais `storage.local`, jamais `storage.session.setAccessLevel` (voir
  « Règles invariantes »).
- **Ordre des essais** dans `connectIfNeeded()` : `brokerKey` déjà en mémoire, ou à défaut un appel à
  l'hôte natif, puis la poignée de main `v: 2` avec la clé obtenue ; hôte injoignable et `S` collé
  présent (mode hérité) : la même poignée de main `v: 2` avec `key: "pasted"`.
- **États et bandeaux.**
  - `"no-host"` (nouveau) : Coati ne joint pas son programme d'appairage ; réinstaller le broker ;
    navigateur en Flatpak ou Snap : voir `docs/INSTALL.md`, appairage manuelle avec `S`.
  - `"broker-untrusted"` (nouveau) : le programme qui écoute sur le port 8787 n'a pas prouvé qu'il
    est le broker Coati ; rien ne lui a été envoyé.
  - `"no-token"` : ID absent d'`allowedExtensionIds`, ou `S` collé refusé en mode hérité.
- **Collage.** Le champ n'est plus affiché d'office, sur aucun navigateur. Il vit dans les options,
  sous un volet « Navigateur en Flatpak ou Snap (appairage manuel) » qui dit que le broker doit
  avoir `legacyPairing` à `true` et que `S` s'obtient par `coati-broker --show-pairing-secret`.
  Coller range `S` dans `brokerKey` et déclenche la poignée de main `v: 2` avec `key: "pasted"`.

### Journalisation, ajouts

```
coati-broker: grant via=native origin=<origine>
coati-broker: grant via=pasted origin=<origine>
coati-broker: reject stage=handshake origin=<origine> reason=legacy-pairing-disabled
coati-broker: reject stage=unauth-cap count=<n depuis 10s>
coati-broker: legacy pairing: off
coati-broker: legacy pairing: ON (secret permanent, --show-pairing-secret)
coati-broker: broker key: written
coati-broker: broker key: not written (COATI_PORT sans COATI_DATA_DIR)
coati-native-host: <raison>
```

`grant via=silent`, `via=silent-renew`, `pin`, `evict` et toute mention de `/pair` disparaissent.
Jamais la clé, ni `S`, ni une preuve.

### Règles invariantes, ajouts

- Le broker n'envoie jamais la clé de broker ni `S`. Elles ne sortent de leur fichier 0600 que vers
  l'appelant que le navigateur a vérifié (clé) ou vers l'opérateur en console (`S`, uniquement par
  `--show-pairing-secret`).
- Aucun octroi sur la seule foi de l'`Origin`, dans aucun mode.
- `hello-ok.token` et `GET /pair`, les deux exceptions nommées de l'amendement 2026-09-25,
  n'existent plus, dans aucun mode : ni jeton de session, ni page `/pair`.
- Côté extension (`extension/`) : jamais `chrome.storage.session.setAccessLevel` ; pas
  d'`externally_connectable` dans le manifeste ; pas de `runtime.onMessageExternal` ni de
  `runtime.onConnectExternal` ; le `onMessage` du service worker vérifie `sender.id ===
  chrome.runtime.id` et ne répond jamais avec `brokerKey` ; le content script ne relaie jamais un
  `postMessage` de la page vers le service worker. Une vérification statique
  (`broker/test/extension-invariants.test.ts`) fait échouer `bun test` si `setAccessLevel`,
  `externally_connectable`, `onMessageExternal` ou `onConnectExternal` apparaît sous `extension/`.

### Plan de test

**Tests unitaires** (`bun test`, sur les trois systèmes sauf mention) :
- *Cadrage* : aller-retour encodage-décodage ; préfixe coupé entre deux morceaux ; caractères UTF-8
  multi-octets (longueur en octets) ; longueurs 1 et 4 096 acceptées, 0 et 4 097 refusées (sortie 1,
  aucune réponse) ; fin de l'entrée avant la trame complète : sortie 1 ; deux trames : seule la
  première est traitée.
- *Détection de l'appelant* : Chrome Linux, Chrome Windows avec `--parent-window` avant et après
  l'origine (`forbidden-caller` si l'origine attendue est absente), Firefox avec le chemin du
  manifeste **et** l'ID (accepté), Firefox avec l'ID seul sans chemin (`forbidden-caller`),
  `--native-host` seul (`forbidden-caller`), autre ID ou autre origine (`forbidden-caller`), aucun
  argument (mode broker).
- *Fichier de clé* : créé en 0600 dans un dossier 0700 (modes vérifiés hors Windows ; sous Windows,
  présence et contenu) ; aucun `.tmp` laissé ; clé différente à chaque démarrage ; pas d'écriture
  si l'écoute échoue ; pas d'écriture sous `COATI_PORT` sans `COATI_DATA_DIR` ; effacement à
  `SIGTERM` seulement si le `pid` correspond (hors Windows).
- *Durcissement du dossier* : dossier symbolique refusé (POSIX) ; dossier d'un autre UID refusé
  (POSIX) ; dossier aux droits plus larges que 0700 remis à 0700 ; un `.tmp` laissé par un plantage
  précédent est supprimé avant réécriture, jamais suivi s'il s'agit d'un lien.
- *Hôte* : fichier absent, malformé ou `pid` mort : `broker-not-running` ; fichier valide : la même
  clé.
- *Vecteurs HMAC* : un fichier de valeurs fixes (`K`, `cN`, `bN`, `bP`, `eP` attendus,
  `broker/test/fixtures/hmac-v2-vectors.json`) vérifié par le code du broker (`node:crypto`) et par
  celui de l'extension (WebCrypto sous Bun) — même fichier des deux côtés.
- *Poignée de main `v: 2`* : succès (`key` absent ou `"native"`) ; preuve fausse, ou de longueur
  63/65, ou en majuscules, ou non hexadécimale : 4401 générique, jamais une exception ; preuve du
  broker renvoyée comme `auth` : 4401 ; `auth` d'une connexion précédente rejoué : 4401 ; `auth`
  avant `hello` : 4401 ; délai de 3 s ; `Origin` seul sans `hello` valide : 4401 ; `key: "pasted"`
  avec `legacyPairing` éteint : 4401, raison `legacy-pairing-disabled` au journal ; `key: "pasted"`
  avec `legacyPairing` allumé et `S` correct : `hello-ok` ; un `hello` `v: 1` : 4401, quel que soit
  `legacyPairing`.
- *Plafond de connexions non authentifiées* : la 17ᵉ connexion simultanée non authentifiée est
  refusée (4401, avant tout message) ; les refus sont journalisés avec une limite de débit (une
  ligne par fenêtre de 10 s, avec le compte).
- *Écoute exclusive* : un second `startServer` sur le port déjà pris par le premier échoue à
  écouter, n'écrit aucun fichier de clé.
- *Vérification statique de l'extension* : `bun test` échoue si `setAccessLevel`,
  `externally_connectable`, `onMessageExternal` ou `onConnectExternal` apparaît sous `extension/`.
- *Mode hérité* : `--show-pairing-secret` imprime et crée `S` si absent quand `legacyPairing` est
  allumé, refuse sans rien créer ni imprimer quand il est éteint.
- *Extension* : logique du service worker avec un `runtime.sendNativeMessage` simulé — clé rangée
  en `storage.session`, jamais en `storage.local` ; preuve du broker fausse : un seul rappel de
  l'hôte, puis `"broker-untrusted"` et plus aucun message envoyé ; promesse rejetée : `"no-host"`,
  ou chemin `key: "pasted"` si `S` est présent en `storage.session`.

**Poignée de main Native Messaging simulée** (CI, exécuteurs Linux, macOS et Windows) :
1. Démarrer un broker sur un port libre (`COATI_PORT`) avec `COATI_DATA_DIR` pointant vers un
   dossier temporaire ; attendre `broker-key.json`.
2. Lancer l'hôte comme le ferait le navigateur : `bun broker/src/native-host.ts
   chrome-extension://hehlgipomfminodhahcjbencblepjhah/` (Windows : plus `--parent-window=0`), puis
   la forme Firefox `<chemin d'un manifeste> coati@getcoati.com`, avec `COATI_DATA_DIR` ; écrire la
   trame `key.get` ; lire une trame ; vérifier la clé et une sortie 0 en moins de 2 s.
3. Ouvrir le WebSocket avec l'`Origin` Chromium, dérouler `v: 2` avec cette clé, vérifier
   `hello-ok`, puis un aller-retour `settings.get`.
4. Refaire l'étape 2 avec l'exécutable compilé (`bun build --compile broker/src/server.ts`) lancé
   directement : c'est ce qui éprouve la détection par les arguments, une sortie standard polluée
   et le vidage sous Windows.
5. Installateur à blanc : `--dry-run` avec un faux dossier personnel ; vérifier les chemins et le
   contenu des manifestes. Sous Windows, le mode à blanc affiche les commandes `reg add` sans
   toucher au registre.

**Vérification à la main avant publication** (non simulable) : lancement réel par Brave, Chrome et
Firefox sous Linux ; Chrome et Firefox sous macOS et Windows.

### Risques

| # | Risque | Parade |
|---|---|---|
| 1 | Navigateurs Flatpak et Snap : pas d'hôte natif | `legacyPairing`, éteint par défaut, réutilise la poignée de main `v: 2` (pas de jeton, pas de page HTML, pas d'octroi silencieux) ; motif et risques écrits dans `docs/INSTALL.md` |
| 2 | Emplacements Brave et Edge hors Linux, et un Firefox récent qui rangerait son profil sous `~/.config/mozilla/`, non mesurés | l'installateur écrit dans chaque dossier existant ; vérification à la main par système avant publication |
| 3 | Binaire non signé bloqué sans message (Gatekeeper, SmartScreen) | l'installateur retire la quarantaine et la marque web ; bandeau `"no-host"` qui renvoie à `docs/INSTALL.md` |
| 4 | Avertissement `nativeMessaging` : refus d'installer, ou revue de boutique plus lente | précédents de gestionnaires de mots de passe sur les deux boutiques ; aucun contournement |
| 5 | Local Network Access étendu aux origines d'extension : le transport WebSocket casse | repli déjà écrit (« Transport ») : permission d'hôte `http://127.0.0.1:8787/*`, ou relais Native Messaging complet |
| 6 | Windows : profil déplacé ou ACL modifiée, la clé devient lisible par un autre compte | écrit dans la politique de sécurité ; hors de portée du broker sans ACL explicite |
| 7 | Fichier de clé périmé après un plantage, `pid` réutilisé | la preuve du broker échoue ou la connexion est refusée ; un rappel de l'hôte, sans effet de bord |
| 8 | Une boutique publie l'extension sous un autre ID que l'ID épinglé | publier avec la clé `key` ; sinon `allowed_origins` ne correspond pas et l'extension affiche `"no-host"` |
| 9 | Une plateforme ignorerait `reusePort: false` et laisserait un second processus partager le port 8787 | testé qu'un second `startServer` sur le même port échoue à écouter ; aucune clé n'est jamais écrite sans écoute réussie |
| 10 | L'ID Firefox `coati@getcoati.com` n'est pas encore enregistré sur AMO à la date de cet amendement | à faire avant publication de l'hôte (action Romain) ; le manifeste Firefox reste sans effet tant que l'extension n'est pas publiée sous cet ID |
| 11 | macOS et Windows : un autre compte local peut occuper les 16 connexions non authentifiées et bloquer l'appairage légitime (déni de service, aucune exposition de clé) | hors de portée sans le contrôle de compte de l'appelant (Linux seulement, ligne 1 des « Limites connues » de `SECURITY.md`) |
| 12 | Revue de sécurité finale (lot G4) : durcissement du workflow de release CI | `TAG` en variable d'environnement (jamais interpolé dans `run:`), `persist-credentials: false`, `bun install --frozen-lockfile`, version de bun figée, job `build` (lecture seule) séparé du job `release` (`contents: write`) |

### Passages remplacés ou complétés

Une ligne en tête de chacun le signale, sans rien retirer du texte historique : « Frontière de
menace », « Poignée de main » (remplacés) ; « Appairage silencieux », « Page `/pair` (Firefox
seulement) », « Jeton de session » (retirés, dans tous les modes — voir « Mode hérité ») ;
« Admission HTTP et WebSocket », « Journalisation », « Règles invariantes » (complétés). Décisions :
T48 et T49 de `docs/DECISIONS.md`.
