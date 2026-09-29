# Coati sur Firefox

Coati tourne aussi sur Firefox, à partir de la même arborescence source que la version
Chrome/Brave (`extension/`). Les différences entre les deux manifestes sont documentées dans
`extension/manifest.firefox.json` et dans `docs/extensions-101.md`, section « Chrome vs Firefox,
les différences qui coûtent du temps ». Ce document couvre uniquement ce qu'un humain doit faire :
charger l'extension pour développer, puis la signer pour l'installer de façon permanente.

## Ce qui diffère de Chrome, côté usage

- **Panneau latéral** : mêmes fonctions, ouvert différemment (`sidebar_action` au lieu de
  `side_panel`), mais un clic sur l'icône Coati dans la barre d'outils l'ouvre pareil.
- **Appairage** : sur Chrome et Brave, l'extension se connecte seule, sans aucun geste : le
  broker connaît son identifiant d'avance (`docs/PROTOCOL.md`, « Appairage silencieux »). Sous
  Firefox, l'identifiant `moz-extension://<uuid>` est tiré au sort à l'installation : il faut le
  présenter une fois au broker, en collant dans les réglages de l'extension le code que la page
  `/pair` affiche. Ensuite la connexion se refait seule. Voir « Appairage » plus bas.
- **Réinstaller l'extension change son identifiant.** Firefox tire un `moz-extension://<uuid>`
  aléatoire à chaque installation — contrairement à Chrome, qui dérive un identifiant stable de la
  clé publique embarquée dans le manifest. Le broker ajoute cet uuid à sa liste d'uuid épinglés au
  premier collage réussi (16 au plus ; `docs/PROTOCOL.md`, « Cas Firefox »). Une nouvelle
  installation (nouveau chargement temporaire, ou désinstallation puis réinstallation) donne un
  nouvel uuid : il faut recoller le code une fois. L'ancien uuid reste dans la liste jusqu'à ce
  qu'on supprime sa ligne ou que le plafond le recycle ; voir « Dépannage » plus bas.
- **Migration Wingpen → Coati** : l'ID gecko a changé (`wingpen@localhost` →
  `coati@getcoati.com`), donc Firefox tire un nouvel uuid `moz-extension://` — un nouveau collage
  du code d'appairage est nécessaire une fois, même si l'extension n'a pas été réinstallée.

## Développement — chargement temporaire

Firefox ne charge pas un dossier directement comme Chrome : il exige un fichier `manifest.json`
réel sur disque (pas dans un `.zip`), et charge tout depuis là.

1. Construire les paquets :

   ```sh
   ./scripts/build.sh
   ```

   Ça produit, entre autres, `dist/stage/firefox/` — une copie non empaquetée de l'extension avec
   le bon manifest (celui de `extension/manifest.firefox.json`, posé en `manifest.json`).

2. Dans Firefox : `about:debugging#/runtime/this-firefox` → **Charger un module
   complémentaire temporaire…** → sélectionner `dist/stage/firefox/manifest.json`.

3. Démarrer le broker (`./scripts/start.sh`), ouvrir le panneau Coati (icône dans la barre
   d'outils), et appairer — voir « Appairage » plus bas.

4. Après une modification du code source : relancer `./scripts/build.sh`, puis dans
   `about:debugging`, cliquer **Recharger** sur la ligne de l'extension. Un chargement temporaire
   disparaît à la fermeture de Firefox — à refaire à chaque session de développement, et l'uuid
   change à chaque fois (voir « Dépannage »).

## Appairage

1. Le broker doit tourner (`./scripts/start.sh`).
2. Ouvrir `http://127.0.0.1:8787/pair` dans un onglet Firefox : adresse tapée, ou bouton « Ouvrir
   /pair » du bandeau du panneau tant que l'extension n'est pas appairée. La page ne répond qu'à
   une navigation d'onglet ; toute autre requête reçoit `forbidden`.
3. La page affiche le code d'appairage (le secret permanent du broker) dans un bloc à
   sélectionner, et la liste des uuid Firefox déjà épinglés. **Rien à cliquer** : la copie se fait
   à la main.
4. Copier le code, ouvrir les réglages de l'extension (icône Coati dans la barre d'outils → clic
   droit → **Gérer l'extension** → **Options**, ou `about:addons` → Coati → **Options**), le
   coller dans le champ prévu, **Enregistrer**. Le champ est en écriture seule : il n'affiche
   jamais le code déjà enregistré.
5. Le panneau passe à « Connecté » aussitôt : l'enregistrement relance la connexion. Le broker
   épingle l'uuid ; pour une extension installée, les connexions suivantes se font sans collage,
   y compris après un redémarrage de Firefox ou du broker. Une extension chargée temporairement
   revient avec un nouvel uuid à chaque chargement : un collage par chargement.

## Installation permanente — signature via AMO (auto-distribution)

Un module temporaire disparaît à chaque fermeture de Firefox. Pour une installation qui survit aux
redémarrages sans repasser par le mode développeur, Firefox exige que le `.xpi` soit signé par
Mozilla — même pour un usage strictement personnel, non publié. La voie « auto-distribution »
(« On your own ») fait ça sans mettre l'extension sur le store public addons.mozilla.org.

1. Créer un compte développeur sur
   [addons.mozilla.org](https://addons.mozilla.org/developers/) (gratuit).
2. Construire le paquet à soumettre :

   ```sh
   ./scripts/build.sh
   ```

   → `dist/coati-firefox.zip`.
3. Aller sur
   [addons.mozilla.org/developers/addon/submit/distribution](https://addons.mozilla.org/developers/addon/submit/distribution).
4. Choisir **On your own** (pas « On this site », qui publierait sur le store public).
5. Téléverser `dist/coati-firefox.zip`. La revue automatisée de Mozilla (validation du manifest,
   scan du code — pas de revue humaine pour cette voie) prend en général quelques minutes.
6. Une fois validée, télécharger le `.xpi` signé proposé par AMO.
7. L'installer : glisser le fichier `.xpi` dans une fenêtre Firefox, ou `about:addons` → l'icône
   en engrenage → **Installer un module depuis un fichier…**.
8. Réappairer une fois (voir « Appairage » ci-dessus) — le `.xpi` signé a son propre uuid, distinct
   de celui d'un chargement temporaire précédent.

**Pour republier une nouvelle version** : incrémenter `"version"` dans `extension/manifest.json`
**et** `extension/manifest.firefox.json` (les deux, ils doivent rester synchronisés — voir
`scripts/build.sh`) avant de reconstruire — AMO refuse de resigner deux fois le même numéro de
version pour un même `id` (`browser_specific_settings.gecko.id`, fixé à `coati@getcoati.com`).

## Dépannage

- **« Pas de jeton — voir réglages » persiste après le collage** : le code collé n'est pas le
  secret permanent actuel (copie incomplète, ou `pairing.txt` supprimé et régénéré depuis).
  Recopier le code depuis `/pair`. Le journal du broker (`journalctl --user -u coati-broker`, ou
  `./scripts/start.sh --log`) affiche dans ce cas `reject stage=handshake
  origin=moz-extension://…`. Un nouvel uuid (réinstallation, nouveau chargement temporaire,
  passage au `.xpi` signé) ne demande ni de supprimer un fichier ni de redémarrer le broker : le
  collage l'ajoute à la liste.
- **Révoquer un uuid** (profil abandonné, ancienne installation) : supprimer sa ligne dans
  `~/.local/share/coati/firefox-extension-uuids.txt`. Le broker relit ce fichier à chaque
  connexion : la suppression prend effet à la connexion suivante, sans redémarrage ; une connexion
  déjà ouverte n'est coupée que par un redémarrage du broker. L'ancien fichier à uuid unique,
  `firefox-extension-uuid.txt`, est migré au démarrage puis renommé en `.migrated`.
- **La page `/pair` affiche `forbidden`** : elle n'est servie qu'à une navigation dans un onglet,
  à l'adresse `127.0.0.1:8787` ou `localhost:8787`. Retaper l'adresse dans la barre d'adresse.
