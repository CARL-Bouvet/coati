# Ce que Coati voit, et ce qu'il ne voit pas

Établi le 20/09/2026 par lecture du code, chaque affirmation citée à la ligne. Ce document
répond à une question précise : une extension installée dans le navigateur peut, en théorie,
lire l'historique, inventorier les onglets, siphonner les cookies. Coati en fait-il quoi que
ce soit ?

Vérifiable par quiconque : les citations pointent le fichier et la ligne. Un audit qui demande
qu'on le croie sur parole ne vaut rien.

Citations remises à jour le 25/09 sur l'arbre de travail ; réserve 3 et tableau « Ce qui est
écrit sur le disque » corrigés après le durcissement de l'appairage (`docs/PROTOCOL.md`,
amendement 2026-09-25).

## Non, prouvé par l'absence de permission

Ces trois-là ne relèvent pas d'une politique interne mais d'un refus du navigateur : sans la
permission déclarée au manifeste, l'API n'existe tout simplement pas pour l'extension.

| | |
|---|---|
| **Historique de navigation** | Permission `history` absente (`extension/manifest.json:12`), aucun appel `chrome.history.*` dans le code. |
| **Liste des onglets ouverts** | Permission `tabs` absente. `chrome.tabs.query` ne rend `url`/`title` que pour l'onglet couvert par `activeTab` ou par une permission d'hôte accordée. |
| **Cookies** | Permission `cookies` absente, aucun `document.cookie` dans le script injecté. |

S'y ajoutent, par construction : les mots de passe enregistrés (aucune API accessible), et le
`localStorage`/`sessionStorage` des pages visitées — le script injecté ne lit que le texte rendu
à l'écran (`extension/content/extract.js:28-33`).

## Ce qu'il voit, et à quel moment

- **L'onglet que vous regardez, et lui seul.** La seule requête d'onglets est
  `{active: true, currentWindow: true}` (`extension/panel/panel.js:1032`, `:1287`). Aucune boucle sur les
  fenêtres, aucun inventaire.
- **Le contenu d'une page, sur geste explicite** : clic « Résumer », envoi d'un message avec
  « Coati lit cette page » cochée, ou clic « Activer Coati sur ce site »
  (`extension/panel/panel.js:930`, `:525-536`, `:919-922`). Texte rendu seulement, plafonné à 40 000
  caractères (`extension/content/extract.js:17`).
- **Les métadonnées de l'onglet — URL et titre — au changement d'onglet**, tant que le panneau
  est ouvert (`extension/panel/panel.js:201-204`, `:896-917`). Aucune page n'est lue à ce moment ; l'origine
  reste en mémoire, n'est ni écrite sur disque ni transmise au broker. Sans permission d'hôte sur
  cet onglet, l'URL revient vide.
- **L'URL envoyée au modèle est réduite à l'origine et au chemin** : la query string et le
  fragment sont retirés, parce qu'ils portent fréquemment un jeton de session
  (`extension/content/extract.js:158-164`).
- **Les zones en cours de saisie sont retranchées** : tout `[contenteditable]` — brouillon
  d'e-mail, commentaire non publié — est exclu de l'extraction (`extension/content/extract.js:42-56`).

Le sondage de page en arrière-plan, apparu par régression le 19/09, est bien mort :
`chrome.scripting.executeScript` n'existe qu'en trois endroits, tous dans le panneau et tous
atteints par un geste : l'extraction, l'ouverture de la transcription YouTube, et le saut à un
horodatage de la vidéo sur clic (`extension/panel/panel.js:1064`, `:1090`, `:1289`). Le service worker ne l'appelle
jamais ; son alarme ne fait que rétablir la connexion WebSocket.

## Les trois réserves honnêtes

Un audit qui ne liste que des bonnes nouvelles n'a pas cherché.

1. ~~**Panneau restauré au démarrage.**~~ **Réserve fermée le 20/09 par un correctif.** Le panneau
   lisait la page de l'onglet actif à son ouverture — légitime quand il s'ouvre parce que vous
   venez de cliquer l'icône, illégitime si le navigateur restaure un panneau resté ouvert de la
   veille. Le service worker horodate désormais le démarrage du navigateur
   (`extension/background/service-worker.js:158-169`) et le panneau se rabat sur la seule
   classification par métadonnées dans les dix secondes qui suivent
   (`extension/panel/panel.js:openedFromGesture`). En cas de doute, il ne lit pas.
2. ~~**`<textarea>` et `<input>`.**~~ **Réserve levée le 20/09 par l'essai.** Page réelle, champs
   injectés avec contenu HTML initial *et* valeur tapée : l'extraction ne rend ni l'un ni l'autre,
   ni pour `<textarea>`, ni pour `<input>`, ni pour un `[contenteditable]`. Rien de ce qui est en
   cours de saisie ne remonte.
3. **`GET /pair` sert le secret permanent en clair** (`broker/src/server.ts:860-894`). Depuis le
   25/09 elle ne sert qu'à appairer Firefox, ne répond qu'après l'admission — en-tête `Host`
   exact et, sous Linux, compte du programme appelant (`broker/src/server.ts:738-774`) — et
   seulement à une navigation d'onglet. Le navigateur empêche une page web d'en lire la
   réponse, mais tout processus tournant sous votre compte le peut — exactement comme il peut
   lire `~/.local/share/coati/pairing.txt`. Une autre extension Firefox munie d'une permission
   d'hôte sur `127.0.0.1` peut aussi la lire en ouvrant un onglet (`docs/PROTOCOL.md`,
   « Frontière de menace »). Limite assumée du modèle « tout en local » : la
   frontière de sécurité est votre compte utilisateur, pas le processus.

## Ce qui est écrit sur le disque

| Quoi | Où | Forme |
|---|---|---|
| Conversation (réponses du modèle, libellés, extraits de sélection ≤ 220 car.) | `chrome.storage.local`, profil du navigateur | **En clair.** 200 messages max, péremption 30 jours par défaut (`extension/panel/panel.js:70`, `:69`) |
| Jeton de session (et, jusqu'à la connexion suivante, le secret collé sous Firefox) | `chrome.storage.session` | En mémoire, effacé à la fermeture du navigateur (`extension/background/service-worker.js:230`, `:382`) |
| Secret permanent, côté broker | `~/.local/share/coati/pairing.txt` | **En clair**, mode 0600 réaffirmé à chaque lecture, dossier en 0700, sans expiration (`broker/src/config.ts:158-172`) |
| uuid Firefox épinglés | `~/.local/share/coati/firefox-extension-uuids.txt` | Un uuid et deux dates par ligne, 0600, écriture atomique (`broker/src/config.ts:285-291`) |
| Réglages du broker | `~/.config/coati/config.json` | Mode 0600 imposé à la création et au chargement (`broker/src/config.ts:105-112`, `:150-151`) |

Le texte brut des pages n'est **jamais** écrit sur disque, ni l'URL visitée
(`extension/panel/panel.js:1008-1011`).

## Ce qui sort de la machine

Une seule destination pour l'extension : `ws://127.0.0.1:8787/ws`
(`extension/background/service-worker.js:22-23`). Ce n'est pas qu'une intention — la CSP déclarée au
manifeste n'autorise aucune autre connexion sortante (`extension/manifest.json:15`), donc un
`fetch` vers l'extérieur serait bloqué par le navigateur lui-même.

Le broker parle à ce que vous avez choisi : Ollama en local (`http://127.0.0.1:11434`), ou le CLI
`claude`, qui sort vers l'API d'Anthropic. **C'est le seul chemin par lequel le contenu d'une page
quitte la machine, et c'est vous qui le choisissez.**

D'où la formulation qui tient : *vos pages vont au modèle que vous avez choisi, et à personne
d'autre — pas même à nous.* Et non pas « rien ne quitte votre machine », qui ne serait vrai qu'en
mode Ollama.

## Toutes les permissions demandées, et leur usage

Aucune n'est décorative — chacune a un site d'appel cité.

- `sidePanel` → ouverture du panneau (`extension/background/service-worker.js:82`, `:108-109`)
- `activeTab` → autorise l'injection sur l'onglet actif après clic (`extension/panel/panel.js:1064`)
- `storage` → conversation et jeton (`extension/panel/panel.js:1341`, `:1347`, `service-worker.js:230`)
- `scripting` → les trois injections sur geste (`extension/panel/panel.js:1064`, `:1090`, `:1289`)
- `alarms` → reconnexion WebSocket, rien d'autre (`extension/background/service-worker.js:83`, `:172`)
- `contextMenus` → le menu sur sélection (`extension/background/service-worker.js:90-92`)
- `optional_host_permissions: http/https` → un **plafond**, jamais accordé en bloc : les demandes
  partent toujours par origine, une à la fois (`extension/panel/panel.js:922`,
  `extension/options.js:409`)
