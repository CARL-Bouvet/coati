# Installer Coati

## Quick start (English)

1. From the [Releases page](https://github.com/CARL-Bouvet/coati/releases), download the binary
   for your OS, `SHA256SUMS`, and the "Source code" archive (all from the same release).
2. Verify the checksum:
   ```sh
   # Linux
   sha256sum --check --ignore-missing SHA256SUMS
   # macOS
   shasum -a 256 coati-broker-darwin-arm64   # compare with SHA256SUMS
   ```
   ```powershell
   # Windows (PowerShell)
   Get-FileHash .\coati-broker-windows-x64.exe -Algorithm SHA256
   ```
3. Decompress the "Source code" archive and run the installer from inside it:
   ```sh
   bash scripts/install/install-linux.sh ~/Downloads/coati-broker-linux-x64   # Linux
   bash scripts/install/install-macos.sh ~/Downloads/coati-broker-darwin-arm64 # macOS
   ```
   ```powershell
   powershell -ExecutionPolicy Bypass -File scripts\install\install-windows.ps1 `
     -Binary "$env:USERPROFILE\Downloads\coati-broker-windows-x64.exe"         # Windows
   ```
4. Load the extension unpacked: open `chrome://extensions`, enable Developer mode, click
   "Load unpacked", and choose the `extension/` folder from the decompressed archive.
   (Brave: `brave://extensions`; Edge: `edge://extensions`; Firefox: see `docs/FIREFOX.md`.)
5. Install a model: `ollama pull llama3.2` (~2 GB).
6. In the extension settings (click the Coati icon → "Open settings"), choose provider
   **Ollama (local)** and pick `llama3.2` in the model list.
7. Click the Coati icon to open the side panel, then click **Read the page**.

If unsigned-binary warnings appear, see section 3 ("Exécutables non signés") below.

---

Coati a deux morceaux : l'extension, dans le navigateur, et le **broker**, un petit programme qui
tourne sur votre machine et parle au modèle. Ce document installe le broker.

Le broker est livré comme un seul exécutable, `coati-broker`. Il sert aussi d'**hôte natif** :
un programme que le navigateur lance lui-même, à la demande de l'extension, pour lui remettre la
clé qui ouvre la connexion au broker. C'est ce qui appaire l'extension sans aucun geste de votre
part. Le détail est dans `docs/PROTOCOL.md`, « Amendement 2026-09-30 : Native Messaging ».

Navigateurs pris en charge : Chrome, Chromium, Brave, Edge et Firefox. Pour Firefox, voir aussi
`docs/FIREFOX.md`.

Aucune étape ne demande de droits d'administrateur.

## 1. Télécharger

Sur la page des [versions publiées](https://github.com/CARL-Bouvet/coati/releases), prendre dans
la même version :

- l'exécutable de votre système :

  | Système | Fichier |
  |---|---|
  | Linux, processeur Intel ou AMD | `coati-broker-linux-x64` |
  | Linux, processeur ARM | `coati-broker-linux-arm64` |
  | macOS, puce Apple | `coati-broker-darwin-arm64` |
  | macOS, processeur Intel | `coati-broker-darwin-x64` |
  | Windows | `coati-broker-windows-x64.exe` |

- le fichier `SHA256SUMS`, qui contient l'empreinte de chaque exécutable ;
- l'archive « Source code » : elle contient les scripts d'installation (`scripts/install/`) et les
  modèles de fichiers qu'ils utilisent (`packaging/`). La décompresser.

## 2. Vérifier l'empreinte

L'empreinte prouve que le fichier téléchargé est bien celui publié. Dans le dossier des
téléchargements :

```sh
# Linux
sha256sum --check --ignore-missing SHA256SUMS

# macOS
shasum -a 256 coati-broker-darwin-arm64    # comparer avec la ligne du fichier SHA256SUMS
```

```powershell
# Windows (PowerShell)
Get-FileHash .\coati-broker-windows-x64.exe -Algorithm SHA256
```

Sous Windows, comparer la valeur affichée avec la ligne de `SHA256SUMS` (majuscules et minuscules
ne comptent pas). Si l'empreinte diffère, ne pas installer le fichier.

## 3. Installer

Lancer l'installateur depuis le dossier décompressé de l'archive « Source code », en lui donnant le
chemin de l'exécutable téléchargé. Il peut être relancé sans risque : il réécrit les mêmes fichiers.

### Linux

```sh
bash scripts/install/install-linux.sh ~/Téléchargements/coati-broker-linux-x64
```

Ce qu'il installe :

- l'exécutable dans `~/.local/bin/coati-broker` ;
- un service utilisateur systemd, `~/.config/systemd/user/coati-broker.service`, activé et démarré :
  le broker se lance à chaque ouverture de session ;
- le fichier `com.getcoati.broker.json`, qui déclare l'hôte natif, dans le dossier
  `NativeMessagingHosts` de chaque navigateur (tableau plus bas).

Options : `--no-service` (pas de service systemd), `--all` (voir « Navigateurs déclarés »),
`--dry-run` (affiche ce qui serait fait, sans rien écrire).

### macOS

```sh
bash scripts/install/install-macos.sh ~/Downloads/coati-broker-darwin-arm64
```

Ce qu'il installe :

- l'exécutable dans `~/Library/Application Support/Coati/coati-broker` ;
- un agent launchd, `~/Library/LaunchAgents/com.getcoati.broker.plist`, chargé aussitôt : le
  broker se lance à chaque ouverture de session. Son journal est dans
  `~/Library/Logs/Coati/coati-broker.log` ;
- le fichier `com.getcoati.broker.json` dans le dossier `NativeMessagingHosts` de chaque navigateur.

Options : les mêmes que sous Linux (`--no-service`, `--all`, `--dry-run`).

### Windows

Dans PowerShell, depuis le dossier décompressé :

```powershell
powershell -ExecutionPolicy Bypass -File scripts\install\install-windows.ps1 -Binary "$env:USERPROFILE\Downloads\coati-broker-windows-x64.exe"
```

`-ExecutionPolicy Bypass` autorise ce seul script à s'exécuter, sans changer le réglage de la
machine.

Ce qu'il installe :

- l'exécutable dans `%LOCALAPPDATA%\Coati\coati-broker.exe` ;
- deux fichiers de déclaration de l'hôte natif dans `%LOCALAPPDATA%\Coati\native-host\` ;
- une clé de registre par navigateur sous `HKEY_CURRENT_USER`, qui pointe vers ces fichiers ;
- une tâche planifiée, `CoatiBroker`, qui lance le broker à l'ouverture de session et le démarre
  aussitôt ;
- une restriction d'accès sur le dossier de données `%USERPROFILE%\.local\share\coati` : seuls
  votre compte, `SYSTEM` et les Administrateurs peuvent le lire.

Options : `-NoService` (pas de tâche planifiée), `-DryRun`.

### Navigateurs déclarés

Sous Linux et macOS, l'installateur ne déclare Coati qu'aux navigateurs déjà installés, c'est-à-dire
ceux dont le dossier de configuration existe. Un navigateur installé plus tard : relancer
l'installateur, ou le lancer d'emblée avec `--all` pour déclarer tous les navigateurs.

| Navigateur | Linux | macOS |
|---|---|---|
| Chrome | `~/.config/google-chrome/NativeMessagingHosts/` | `~/Library/Application Support/Google/Chrome/NativeMessagingHosts/` |
| Chromium | `~/.config/chromium/NativeMessagingHosts/` | `~/Library/Application Support/Chromium/NativeMessagingHosts/` |
| Brave | `~/.config/BraveSoftware/Brave-Browser/NativeMessagingHosts/` | `~/Library/Application Support/BraveSoftware/Brave-Browser/NativeMessagingHosts/` |
| Edge | `~/.config/microsoft-edge/NativeMessagingHosts/` | `~/Library/Application Support/Microsoft Edge/NativeMessagingHosts/` |
| Firefox | `~/.mozilla/native-messaging-hosts/` | `~/Library/Application Support/Mozilla/NativeMessagingHosts/` |

Sous Windows, les cinq navigateurs sont toujours déclarés.

### Exécutables non signés

Les exécutables publiés ne portent pas de signature de développeur Apple ou Microsoft.
L'installateur retire lui-même la marque « téléchargé depuis Internet » de l'exécutable qu'il pose.
Si le système bloque malgré tout son lancement :

- **macOS (Gatekeeper)** : dans le Finder, clic droit sur l'exécutable → **Ouvrir**, puis
  confirmer ; ou dans un terminal :
  `xattr -d com.apple.quarantine ~/Library/Application\ Support/Coati/coati-broker`.
- **Windows (SmartScreen)** : dans la fenêtre bleue, **Informations complémentaires** →
  **Exécuter quand même**.

## 4. Configuration et données

Ces dossiers sont créés par le broker à son premier démarrage, sur tous les systèmes (sous Windows,
`~` désigne `%USERPROFILE%`) :

- `~/.config/coati/config.json` : la configuration ;
- `~/.local/share/coati/` : les données, dont `broker-key.json`, la clé tirée au sort à chaque
  démarrage du broker.

Si vous avez ajouté des modules de fournisseur (`docs/MODULES.md`), `coati-broker --check-modules`
vérifie qu'ils se chargent, sans ouvrir de port.

## 5. Charger l'extension

L'extension se trouve dans le dossier `extension/` de l'archive « Source code » décompressée.
Ne pas déplacer ni supprimer ce dossier : le supprimer désinstalle l'extension.

**Chrome, Chromium, Brave, Edge**

Ouvrir l'adresse selon le navigateur :

- Chrome, Chromium : `chrome://extensions`
- Brave : `brave://extensions`
- Edge : `edge://extensions`

Activer le **mode développeur** (interrupteur en haut à droite sous Chrome/Brave/Edge).
Cliquer sur **Charger l'extension non empaquetée**, puis choisir le dossier `extension/`.

L'identifiant de l'extension est fixé par le champ `key` du manifest : l'appairage avec le
programme local fonctionne sans aucun geste supplémentaire, même après un rechargement.

Après une mise à jour : remplacer le contenu du dossier `extension/` par la nouvelle version,
puis, sur la page des extensions, cliquer sur **Recharger** (icône ↺) à côté de Coati.

**Firefox**

Voir `docs/FIREFOX.md` — Firefox requiert une procédure différente (manifest dédié, chargement
depuis `about:debugging`, ou signature AMO pour une installation permanente).

## 6. Choisir un modèle

Le fournisseur par défaut de Coati est **Ollama** (`http://127.0.0.1:11434`). Coati ne
choisit pas de modèle tout seul : si aucun modèle n'est configuré, le programme local refuse
les requêtes. Il faut donc en choisir un.

### Avec Ollama (recommandé pour débuter)

1. Télécharger et installer [Ollama](https://ollama.com) pour votre système.
2. Dans un terminal, télécharger un modèle :

   ```sh
   ollama pull llama3.2
   ```

   `llama3.2` est petit (~2 Go) et polyvalent. N'importe quel modèle de dialogue fonctionne ;
   un modèle plus grand donne de meilleures réponses mais prend plus de temps à charger.

3. Dans les réglages de l'extension (icône Coati → **Ouvrir les réglages**) :
   - Choisir le fournisseur **Ollama (local)** ;
   - Dans **Nom du modèle**, choisir `llama3.2` dans la liste des modèles installés (ou saisir
     son nom, puis **Enregistrer le modèle**).

Ollama limite par défaut le texte lu par le modèle à 4 096 tokens et coupe le reste sans
prévenir. Coati lui demande une fenêtre adaptée à la page (jusqu'à 16 384 tokens) : une page
longue occupe donc plus de mémoire, et Ollama recharge le modèle quand la taille change.

### Autres fournisseurs

Les réglages proposent aussi :
- **Claude (clé API)** — votre propre clé Anthropic ;
- **Compatible OpenAI** — LM Studio, OpenAI, Mistral, OpenRouter, DeepSeek, ou toute autre
  adresse compatible. La clé est stockée par le programme local, pas dans l'extension.
  Pour Ollama, préférer le fournisseur **Ollama (local)** à son adresse compatible OpenAI
  (`/v1`) : par cette adresse, Coati ne peut pas agrandir la fenêtre de texte, et les pages
  longues sont coupées.

### Ce que vous devez voir

À la première ouverture du panneau (icône Coati dans la barre d'outils), un encart
**« Premiers pas avec Coati »** s'affiche avec trois points à cocher :
- **Programme local détecté** — vert si le broker tourne ;
- **Modèle connecté** — vert une fois le modèle configuré et Ollama lancé ;
- **Accès aux pages accordé** — vert une fois l'accès aux pages autorisé.

Les deux premiers points au vert, cliquer sur **Lire cette page**, autoriser l'accès aux sites
quand le navigateur le demande (le troisième point passe au vert), et attendre la réponse du
modèle.
Le statut du fournisseur s'affiche en bas du panneau (ex. : « Ollama (local) : prêt »).

## 7. Désinstaller

Depuis le dossier décompressé de l'archive « Source code » :

```sh
bash scripts/install/uninstall-linux.sh     # Linux
bash scripts/install/uninstall-macos.sh     # macOS
```

```powershell
powershell -ExecutionPolicy Bypass -File scripts\install\uninstall-windows.ps1
```

Le désinstallateur arrête le service, puis retire l'exécutable, le service (ou la tâche planifiée)
et les fichiers de déclaration de l'hôte natif. Il ne touche ni à `~/.config/coati` ni à
`~/.local/share/coati` : les supprimer à la main pour tout effacer.

## Navigateur en Flatpak ou Snap

Un navigateur installé en Flatpak ou en Snap vit dans un bac à sable qui l'empêche de lancer un
programme de la machine, donc l'hôte natif. Le Firefox livré par défaut avec Ubuntu est un Snap.
Pour ces navigateurs, il existe un appairage manuel, éteint par défaut :

1. Dans `~/.config/coati/config.json`, mettre `"legacyPairing": true` (ajouter la ligne si elle
   manque).
2. Redémarrer le broker : `systemctl --user restart coati-broker`.
3. Afficher le secret d'appairage :

   ```sh
   ~/.local/bin/coati-broker --show-pairing-secret
   ```

4. Dans les réglages de l'extension, ouvrir la section « Navigateur sans programme natif
   (Flatpak, Snap) », coller le secret, **Enregistrer**.

L'extension garde le secret en mémoire, jamais sur le disque : il faut le recoller à chaque
redémarrage du navigateur.

Ce secret est permanent. Tout programme lancé sous votre compte peut le lire dans
`~/.local/share/coati/pairing-secret` et s'en servir pour se connecter au broker. Pour le changer :
supprimer ce fichier, redémarrer le broker, relancer `--show-pairing-secret` et recoller le
nouveau secret. Pour revenir au mode par défaut : remettre `"legacyPairing": false` et redémarrer
le broker.

## Dépannage

Le panneau de l'extension affiche un bandeau quand la connexion échoue.

| Bandeau | Cause probable | Que faire |
|---|---|---|
| « Coati ne trouve pas son programme local sur cet ordinateur. » | Hôte natif non installé, navigateur installé après le broker, exécutable bloqué par Gatekeeper ou SmartScreen, ou navigateur en Flatpak ou Snap. | Relancer l'installateur (avec `--all` au besoin) puis redémarrer le navigateur. Voir « Exécutables non signés ». Flatpak ou Snap : section « Navigateur en Flatpak ou Snap ». |
| « Le programme local a refusé la connexion. » | Le broker a refusé la poignée de main. Le panneau réessaie automatiquement ; un bouton **Réessayer** est aussi disponible. | Si le bandeau reste : redémarrer le broker, puis cliquer sur **Réessayer**. Si `config.json` a été modifié à la main, vérifier que `allowedExtensionIds` contient l'identifiant de l'extension. En appairage manuel : vérifier que `legacyPairing` est activé et recoller le secret de `--show-pairing-secret`. |
| « Un autre programme répond à la place de celui de Coati, sans prouver qu'il est fiable. » | Un programme répond sur le port 8787 sans s'authentifier (ancienne version restée lancée, ou autre programme). L'extension n'a rien envoyé. | Trouver ce qui écoute sur ce port : `ss -ltnp 'sport = :8787'` (Linux), `lsof -iTCP:8787 -sTCP:LISTEN` (macOS), `netstat -ano \| findstr 8787` (Windows). L'arrêter, puis redémarrer le broker. |
| « Le programme local de Coati ne répond pas. » | Le broker ne tourne pas. | Linux : `systemctl --user status coati-broker`. macOS : `~/Library/Logs/Coati/coati-broker.log`. Windows : `Start-ScheduledTask -TaskName CoatiBroker` dans PowerShell. |

## Développement : installer depuis les sources

Pour travailler sur Coati, sous Linux, avec [Bun](https://bun.sh) **>= 1.4.2** installé.

```sh
cd broker && bun install
```

Pour lancer le broker directement sans le service systemd :

```sh
cd broker && bun run start
```

### Le broker en service systemd

```sh
bash scripts/install-service.sh
```

Le script copie `packaging/coati-broker.service` dans `~/.config/systemd/user/`, recharge systemd,
active le service au démarrage de session et le démarre. Il peut être relancé sans risque.

Commandes utiles :

```sh
systemctl --user status coati-broker        # état
journalctl --user -u coati-broker -n 100    # dernières lignes du journal
systemctl --user stop coati-broker          # arrêt
```

Désinstaller le service :

```sh
systemctl --user disable --now coati-broker
rm ~/.config/systemd/user/coati-broker.service
systemctl --user daemon-reload
```

### L'hôte natif depuis les sources

```sh
bash scripts/dev-native-host.sh          # Brave seulement
bash scripts/dev-native-host.sh --all    # tous les navigateurs présents
bash scripts/dev-native-host.sh --uninstall
```

Le script écrit un petit lanceur, `~/.local/share/coati/dev-native-host/coati-native-host.sh`, qui
exécute le broker des sources en mode hôte, et le déclare au navigateur. L'appairage est ensuite
automatique.

### L'extension

Chrome, Chromium, Brave, Edge : `chrome://extensions` → activer le mode développeur → « Charger
l'extension non empaquetée » → choisir le dossier `extension/`. Firefox : voir `docs/FIREFOX.md`.
