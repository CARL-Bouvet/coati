# Sécurité

## Signaler une vulnérabilité

Passer par le signalement privé de GitHub : onglet **Security** du dépôt → **Report a
vulnerability**, ou directement
[github.com/CARL-Bouvet/coati/security/advisories/new](https://github.com/CARL-Bouvet/coati/security/advisories/new).
Le rapport n'est visible que des mainteneurs. Merci de ne pas ouvrir d'issue publique pour une
faille.

Utile dans un rapport : la version (ou le commit), le système et le navigateur, les étapes pour
reproduire, et ce qu'un attaquant obtient.

## Ce que Coati protège

La frontière de sécurité est votre compte utilisateur sur la machine. Le détail est dans
`docs/PROTOCOL.md`, « Frontière de menace, révisée ».

- Le broker n'écoute que sur `127.0.0.1` : une autre machine du réseau ne peut pas le joindre.
- Une page web ne peut pas se connecter au broker : il vérifie l'origine de chaque connexion et
  exige une preuve cryptographique avant de traiter quoi que ce soit.
- Une autre extension ne peut pas obtenir la clé du broker. Seul l'hôte natif la délivre, et le
  navigateur ne le lance que pour l'identifiant de l'extension Coati. Réécrire les en-têtes de
  sa connexion ne suffit pas.
- La clé ne circule jamais sur la connexion : chaque côté prouve qu'il la détient sans la
  transmettre. L'extension n'envoie rien à un programme qui n'a pas fait cette preuve.
- Les identifiants du modèle restent dans le broker, sur votre machine. L'extension ne les
  détient jamais.

Un programme lancé sous votre compte, ou un administrateur de la machine, peut lire la clé. C'est
hors de ce que Coati protège.

## Limites connues

- **Contrôle du compte de l'appelant.** Sous Linux, le broker refuse dès l'ouverture une
  connexion venue d'un autre compte. Sous macOS et Windows, ce contrôle n'existe pas : la
  protection repose sur les droits du fichier de clé, lisible par votre seul compte. Un autre
  compte peut ouvrir une connexion, mais sans la clé il n'obtient rien.
- **Windows.** Les droits Unix ne s'y appliquent pas. Le dossier de données
  (`%USERPROFILE%\.local\share\coati`) est protégé par la restriction d'accès que pose
  l'installateur : votre compte, `SYSTEM` et les Administrateurs. Un profil déplacé vers un
  emplacement partagé, ou des droits modifiés à la main, peuvent rendre la clé lisible par un
  autre compte.
- **Appairage manuel (navigateurs Flatpak ou Snap).** Éteint par défaut. Une fois activé, le
  secret d'appairage est permanent et lisible par tout programme de votre compte. Il ne change
  jamais de lui-même : pour le renouveler, supprimer `~/.local/share/coati/pairing-secret`,
  redémarrer le broker et recoller le nouveau secret (`docs/INSTALL.md`).
- **Exécutables non signés.** Les exécutables publiés ne portent pas de signature de développeur
  Apple ou Microsoft. Vérifier leur empreinte avec le fichier `SHA256SUMS` de la version
  (`docs/INSTALL.md`).
- **Plafond de connexions non authentifiées (macOS, Windows).** Sur ces deux systèmes, un autre
  compte local peut ouvrir les 16 connexions non authentifiées autorisées et bloquer tout
  appairage légitime (déni de service) — sans jamais obtenir la clé elle-même.
