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
**intégré** au broker (`ollama`, `claude-api` — les deux seuls fournisseurs que ce dépôt embarque),
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
2026-09-29** : un fournisseur est soit **intégré** au broker (ce dépôt en embarque exactement
deux), soit un **module externe**, déclaré dans `~/.config/coati/config.json` et chargé au
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
  Un 429 ou une 5xx échoue en `model-unavailable`.

### Modules externes — amendement 2026-09-29

Au-delà de `ollama` et `claude-api`, tout autre fournisseur est un **module** : un fichier
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
d'une erreur.

En échange, chaque entrée de `available` dans la réponse `settings` gagne un booléen `configured` :
vrai quand ce fournisseur a ce qu'il lui faut pour fonctionner — une clé stockée pour `claude-api`,
un démon qui répond pour `ollama`, ce qu'un module externe juge nécessaire pour le sien —
indépendamment du modèle actuellement choisi (c'est `available` qui couvre déjà cette
dimension-là). L'extension affiche un état, jamais une valeur :
```jsonc
{ "id": "claude-api", "label": "Claude (clé API)", "available": false,
  "reason": "no Anthropic API key configured", "configured": false }
```

### `settings.test` — tester une connexion réelle

Backend du bouton « Tester la connexion » des réglages. Effectue un vrai appel minimal (quelques
tokens, pas un résumé) contre le fournisseur nommé — pas forcément celui actuellement sélectionné,
l'utilisateur peut tester avant de basculer — borné à 20 s pour ne jamais bloquer le panneau :
```jsonc
{ "type": "settings.test", "id": "c10", "provider": "claude-api" }
{ "type": "settings.test-result", "id": "c10", "provider": "claude-api", "ok": true,
  "message": "Connexion à l'API Anthropic réussie." }
```
`message` est en français, une phrase, affichée telle quelle à un humain ; en cas d'échec elle nomme
le remède : clé refusée (« Clé API refusée — vérifiez-la dans les réglages. »), Ollama non lancé
(« Ollama ne répond pas — vérifiez qu'il est bien lancé sur cette machine. »), ou tout autre texte
qu'un module externe choisit de renvoyer pour le sien.

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
    { "id": "mon-fournisseur-perso", "label": "Mon fournisseur perso", "available": true,
      "configured": true }
  ],
  "models": ["llama3.2:latest", "mistral:latest"]  // seulement si le fournisseur actif sait lister ses modèles
}
```

`available` liste **toujours** tous les fournisseurs connus du broker — les deux intégrés, plus
tout module chargé avec succès — y compris ceux qui ne sont pas utilisables maintenant : un
fournisseur indisponible n'est jamais caché, seulement signalé avec une raison courte (`reason`).
**Libellés (amendement 2026-09-29)** : `label` est fourni par le fournisseur lui-même (intégré ou
module) — c'est ce qui permet à l'extension d'afficher, sans texte préécrit pour lui, un
fournisseur qu'elle ne connaît pas d'avance ; voir `extension/lib/labels.js` côté extension, qui
n'a de texte fixe que pour `ollama` et `claude-api` et retombe sur ce `label` pour tout le reste.

**`settings.set`** accepte `provider`, `model` et `apiKey`, tous trois optionnels — un champ omis
reste inchangé côté broker. **Amendement 2026-09-29** : `provider` n'est plus vérifié contre une
liste fermée — `parseClientMessage()` (`broker/src/protocol.ts`) rejette seulement une valeur qui
n'a pas la forme d'un identifiant (chaîne vide, trop longue, caractères hors ASCII imprimable) en
`bad-request`. Que cet identifiant corresponde à un fournisseur réellement connu du broker est
vérifié à l'exécution, pas au parsing — un identifiant inconnu est accepté et persisté, puis
rapporté comme indisponible par `settings.get`/`provider.status` (voir plus haut). Seul `apiKey`
est un secret (voir « La clé API » ci-dessus, amendement 2026-09-21 (3)) — write-only, jamais
renvoyé. Sur succès, le broker persiste le changement dans `~/.config/coati/config.json`
(permissions `0600`, comme le reste du fichier) et répond avec un `settings` frais, construit de la
même façon que pour `settings.get`.

Si le modèle configuré pour `ollama` n'apparaît pas dans la réponse de son `/api/tags`, une
requête `chat`/`summarize`/`act` échoue en `model-unavailable`, avec le nom du modèle manquant dans
le message — jamais de repli silencieux sur un autre modèle installé.

**Session expirée ou identifiants non authentifiés (amendement 2026-09-21 (2), task C3).** Un
fournisseur peut détecter que la session ou les identifiants de l'utilisateur ne sont plus valides
— par exemple `claude-api` sur un 401/403 (voir plus haut) — et le signale avec le code
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
| module externe | propre à chaque module — voir sa propre documentation | même contrat `state`/`reason` que ci-dessus ; le `reason` d'un module externe n'est pas dans cette liste fermée, l'extension le traite comme un `état inconnu` faute d'entrée reconnue |

- **`claude-api`** : une clé présente n'est **pas** annoncée `ok`, puisque rien n'a vérifié
  qu'elle est acceptée. Une validation non facturée (`GET /v1/models`) n'est ajoutée que **si une
  sonde non facturée est confirmée** par une source citée (recherche du lot 1) ; elle passera alors
  par un amendement de ce document, avec les codes `ready` (`ok`), `key-rejected` (`ko`, HTTP 401
  ou 403) et `api-unreachable` (`unknown`, réseau, 429 ou 5xx). **Jusque-là, présence seulement.**
- **`ollama`** : `/api/tags` est local et gratuit.

**Cache côté broker : 60 s.** Un résultat est réutilisé pendant 60 s pour le même fournisseur et
la même configuration (fournisseur, modèle, `ollamaUrl`, présence de la clé). Un `settings.set`
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
`context-too-large`, `cancelled`, `internal`.

## Journalisation

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
français d'après `code` seul, pas d'après `message`. **Ne s'applique pas à `auth-required`** : son
`message` reste le texte français figé (`AUTH_REQUIRED_MESSAGE` ci-dessus), affichable tel quel —
contrat inchangé par cet amendement.

## Règles invariantes

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
