# Coati sur Firefox

Coati tourne aussi sur Firefox, à partir de la même arborescence source que la version
Chrome/Brave (`extension/`). Les différences entre les deux manifestes sont documentées dans
`extension/manifest.firefox.json` et dans `docs/extensions-101.md`, section « Chrome vs Firefox,
les différences qui coûtent du temps ». Ce document couvre uniquement ce qu'un humain doit faire :
charger l'extension pour développer, puis la signer pour l'installer de façon permanente.

## Ce qui diffère de Chrome, côté usage

- **Panneau latéral** : mêmes fonctions, ouvert différemment (`sidebar_action` au lieu de
  `side_panel`), mais un clic sur l'icône Coati dans la barre d'outils l'ouvre pareil.
- **Appairage** : identique à Chrome, sans aucun geste. Firefox lance l'hôte natif de Coati
  (installé avec le broker, voir `docs/INSTALL.md`) pour l'extension dont l'identifiant est
  `coati@getcoati.com`, et pour elle seule. Réinstaller l'extension ou la recharger ne demande
  rien de plus.
- **Firefox en Snap ou en Flatpak** : ces versions ne peuvent pas lancer l'hôte natif. Le Firefox
  livré par défaut avec Ubuntu est un Snap. Il faut alors l'appairage manuel décrit dans
  `docs/INSTALL.md`, section « Navigateur en Flatpak ou Snap ».

## Développement — chargement temporaire

Firefox ne charge pas un dossier directement comme Chrome : il exige un fichier `manifest.json`
réel sur disque (pas dans un `.zip`), et charge tout depuis là.

1. Construire les paquets :

   ```sh
   ./scripts/build.sh
   ```

   Ça produit, entre autres, `dist/stage/firefox/` — une copie non empaquetée de l'extension avec
   le bon manifest (celui de `extension/manifest.firefox.json`, posé en `manifest.json`).

2. Déclarer l'hôte natif des sources à Firefox (une fois) :

   ```sh
   bash scripts/dev-native-host.sh --all
   ```

   Sans `--all`, le script ne déclare que Brave. Firefox n'est déclaré que si son dossier
   `~/.mozilla` existe déjà.

3. Dans Firefox : `about:debugging#/runtime/this-firefox` → **Charger un module
   complémentaire temporaire…** → sélectionner `dist/stage/firefox/manifest.json`.

4. Démarrer le broker, puis ouvrir le panneau Coati (icône dans la barre d'outils) : il se
   connecte seul.

5. Après une modification du code source : relancer `./scripts/build.sh`, puis dans
   `about:debugging`, cliquer **Recharger** sur la ligne de l'extension. Un chargement temporaire
   disparaît à la fermeture de Firefox : à refaire à chaque session de développement.

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

**Pour republier une nouvelle version** : incrémenter `"version"` dans `extension/manifest.json`
**et** `extension/manifest.firefox.json` (les deux, ils doivent rester synchronisés — voir
`scripts/build.sh`) avant de reconstruire — AMO refuse de resigner deux fois le même numéro de
version pour un même `id` (`browser_specific_settings.gecko.id`, fixé à `coati@getcoati.com`).
Cet identifiant ne doit pas changer : c'est lui que l'hôte natif reconnaît.

## Dépannage

Les bandeaux du panneau (« Programme local introuvable », « Broker non vérifié », « Pas de
jeton ») sont les mêmes que sous Chrome : voir `docs/INSTALL.md`, section « Dépannage ». Sous
Firefox, le cas le plus courant de « Programme local introuvable » est un Firefox en Snap.
