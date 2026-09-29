# Extensions de navigateur — l'antisèche

Ce que les tutoriels montrent, et ce qu'ils oublient. À relire avant de coder, pas à apprendre par
cœur.

## Le paysage réel

Deux cibles existent. Le reste est du folklore sympathique.

| Navigateur | Extensions | Ce qu'il faut savoir |
|---|---|---|
| **Chrome / Brave / Edge / Vivaldi** | MV3, identiques | Même moteur, même API, même magasin. Tester sur un suffit. |
| **Firefox** | MV3 aussi, mais **pas le même** | API très proche, différences réelles ci-dessous. Magasin séparé (AMO), examen plus rapide et plus humain. |
| **ungoogled-chromium** | Oui, mêmes extensions | Pas de Web Store câblé : l'utilisateur installe un `.crx` à la main. Le code marche, c'est la **distribution** qui change. |
| **GNOME Web (Epiphany)** | Non, en pratique | WebKitGTK a une API WebExtensions expérimentale et très partielle. Pas une cible. |
| **GNU IceCat** | Oui (base Firefox ESR) | Fork militant, très en retard sur les versions. Ce qui marche sur Firefox ESR y marche. |
| **Safari** | Oui, mais | Il faut empaqueter l'extension dans une app Xcode signée, sur un Mac. Autre monde. |

## Chrome vs Firefox, les différences qui coûtent du temps

- **`chrome.*` rend des callbacks, `browser.*` rend des promesses.** Firefox fournit les deux,
  Chrome n'a que `chrome.*` (promisifié depuis MV3 sur la plupart des API). Écrire `chrome.*` avec
  `await` marche des deux côtés aujourd'hui.
- **Le panneau latéral n'est pas le même objet.** Chrome : `chrome.sidePanel`, un panneau par
  fenêtre, `open()` exige un vrai clic. Firefox : `sidebar_action`, déclaré au manifest, ouverture
  libre. **Deux manifests, deux points d'entrée** — c'est la principale fourche pour Coati.
- **Firefox garde `webRequest` bloquant**, Chrome l'a supprimé au profit de
  `declarativeNetRequest`. Sans objet pour nous, mais c'est la vraie raison de la guerre des
  bloqueurs de pub.
- **Les permissions d'hôte sont optionnelles par défaut chez Firefox** : accordées à l'install,
  l'utilisateur peut les retirer d'un clic. Prévoir que la permission disparaisse en cours de route.
- **L'identifiant de l'extension.** Chrome dérive l'ID d'une extension non empaquetée **du chemin
  du dossier** : déplace le dossier, l'ID change. Firefox donne un ID aléatoire à chaque chargement
  temporaire. On épingle : champ `key` au manifest (Chrome), `browser_specific_settings.gecko.id`
  (Firefox). *Pour Coati c'est critique : le broker autorise l'extension par son ID.*

## Les huit pièges que les tutoriels ne montrent pas

1. **Le service worker meurt.** MV3 n'a plus de page d'arrière-plan permanente : le navigateur tue
   le script après quelques dizaines de secondes d'inactivité. Toute variable globale disparaît
   avec lui. Les tutoriels écrivent `let state = {}` en haut du fichier — c'est faux dès la
   deuxième minute. L'état va dans `chrome.storage`, ou dans un document qui vit (panneau, onglet).
2. **Le content script ne voit pas le JavaScript de la page.** Il vit dans un « monde isolé » :
   même DOM, variables séparées. Impossible de lire une variable de la page, sauf à demander
   `world: "MAIN"` — ce qui supprime l'isolation et ouvre la porte que toute notre architecture
   ferme. À ne jamais faire ici.
3. **Pas de code distant, jamais.** La politique de sécurité MV3 interdit `eval`, les scripts en
   ligne, et tout fichier chargé depuis un CDN. Une bibliothèque tierce doit être **copiée dans le
   dossier de l'extension**. (Plotly.js, par exemple : on vendorise le `.js`, on ne met pas de
   balise `<script src="https://…">`.) Enfreindre ça, c'est le retrait automatique.
4. **`return true` dans `onMessage`.** Si le gestionnaire répond de façon asynchrone et ne retourne
   pas `true`, le canal se ferme avant la réponse et l'appelant ne reçoit rien — sans erreur. Le
   bug silencieux numéro un des extensions.
5. **Les trois stockages ne se valent pas.** `storage.local` : sur disque, **non chiffré**, gros.
   `storage.session` : en mémoire vive, effacé à la fermeture — c'est là que vont les secrets.
   `storage.sync` : synchronisé chez Google, ~100 Ko en tout, 8 Ko par entrée, quota d'écritures
   horaire. On ne stocke pas une conversation dedans.
6. **Les permissions se paient à l'installation.** Demander `<all_urls>` affiche « peut lire et
   modifier toutes vos données sur tous les sites » — beaucoup de gens renoncent là. `activeTab`
   donne l'onglet courant **après un clic**, sans aucun avertissement. C'est autant un enjeu de
   conversion que de sécurité.
7. **Chaque contexte a sa propre console.** Le service worker se débogue depuis
   `chrome://extensions` (lien « service worker »), le content script écrit dans la console **de la
   page**, le panneau et les options ont chacun la leur. Chercher un log au mauvais endroit fait
   perdre des heures.
8. **Recharger ne suffit pas toujours.** Modifier le service worker → recharger l'extension.
   Modifier un content script → recharger l'extension **et** la page. Modifier le manifest →
   recharger, et parfois retirer/réinstaller.

## Les quatre fichiers d'une extension

- `manifest.json` — la déclaration. Tout ce que l'extension a le droit de faire y est écrit ; ce
  qui n'y est pas déclaré n'existe pas.
- Un **script d'arrière-plan** — l'orchestrateur, sans interface, éphémère.
- Un ou plusieurs **content scripts** — le seul code qui touche les pages visitées.
- Des **pages** (popup, options, panneau latéral) — du HTML/CSS/JS ordinaire, dans une fenêtre
  fournie par le navigateur.

Coati a exactement ces quatre-là, plus le broker. Le détail est dans `docs/ARCHITECTURE.md`.

## La messagerie native (Native Messaging)

Une extension ne peut pas lancer un programme de l'ordinateur. La messagerie native est la seule
porte officielle : l'extension appelle `chrome.runtime.connectNative("app.coati.broker")`, et
c'est **le navigateur** qui démarre le programme correspondant et branche son entrée et sa sortie
standard sur l'extension. Aucun port réseau, aucune adresse, aucune page ne s'y intercale
(https://developer.chrome.com/docs/extensions/develop/concepts/native-messaging).

**Comment le navigateur reconnaît l'extension.** Le programme se déclare dans un *manifeste
d'hôte*, un petit JSON qui dit qui a le droit de l'appeler : `allowed_origins` sous Chromium, une
liste exacte de `chrome-extension://<ID>/`, sans joker ; `allowed_extensions` sous Firefox, une
liste d'ID gecko comme `coati@getcoati.com`
(https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/Native_manifests). Une
autre extension qui tente l'appel est refusée par le navigateur avant que le programme démarre.
Le programme reçoit en argument l'identité de l'appelant : l'origine sous Chromium, le chemin du
manifeste et l'ID sous Firefox. Il n'y a ni jeton ni en-tête `Origin` à falsifier. La limite du
compte utilisateur reste la même : un programme de votre compte peut lancer ce binaire lui-même.

**Le manifeste d'hôte** contient `name`, `description`, `path` (absolu sous Linux et macOS),
`type: "stdio"` et la liste des appelants. Il se pose dans un dossier propre à chaque navigateur
(`~/.config/google-chrome/NativeMessagingHosts/`, `~/.mozilla/native-messaging-hosts/`…) ; sous
Windows, une clé de registre pointe vers le fichier. Un manifeste par famille de navigateurs.
C'est l'application native qui le pose, jamais l'extension, qui n'a aucun accès au disque.

**Le cadrage et le plafond.** Chaque message est du JSON en UTF-8, précédé de sa longueur sur
4 octets, dans l'ordre d'octets de la machine. Un message du programme vers l'extension pèse
**1 Mo au plus** ; dans l'autre sens, 64 Mio sous Chrome et 4 Go sous Firefox
(https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/Native_messaging). Une
réponse de modèle envoyée par morceaux passe sans peine ; un gros message unique doit être découpé.

**Le cycle de vie.** `connectNative` démarre **un** processus, qui vit tant que le port reste
ouvert ; à la fermeture, le navigateur envoie SIGTERM puis SIGKILL (un *Job object* sous
Windows). `sendNativeMessage` démarre un processus neuf à chaque appel. Le programme tourne dans
le dossier de son exécutable, avec l'environnement du navigateur. Depuis Chrome 105, un port
ouvert garde le service worker en vie, ce qui neutralise le piège n°1
(https://developer.chrome.com/docs/extensions/develop/concepts/service-workers/lifecycle). Mesuré
sous Firefox le 25/09 : un port ouvert a tenu 5 minutes d'inactivité (mesure interne n°5).

**Qui s'en sert.** KeePassXC, dont l'application écrit elle-même ses manifestes
(https://gitlab.com/nonguix/nonguix/-/issues/368) ; Bitwarden et 1Password [À VÉRIFIER].

**Les pièges.** Flatpak exige un script relais, Snap le portail XDG
(https://bugzilla.mozilla.org/show_bug.cgi?id=1661935) ; sous Firefox, `nativeMessaging` en permission
facultative échouait encore en version 90 (https://bugzilla.mozilla.org/show_bug.cgi?id=1630415).

**Ce que ça retirerait de Coati** : le port 8787, la page `/pair`, le secret d'appairage et les
jetons de session, les contrôles `Host`, UID et `Origin`, la liste d'uuid Firefox et son collage,
et avec eux le *DNS rebinding*, l'usurpation du port et la dépendance à Local Network Access. En
échange : un manifeste par navigateur, une clé de registre sous Windows, un avertissement à
l'installation, le plafond d'1 Mo. Le choix entre un petit relais vers le broker existant et un
broker lancé par le navigateur est discuté dans une étude interne.
