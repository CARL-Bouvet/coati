# Coati — règles du projet

## Ce qu'est ce projet

Une extension de navigateur (`extension/`) et un serveur local (`broker/`). Le contrat entre les
deux est `docs/PROTOCOL.md` — **il fait autorité**. Un désaccord entre le code et le protocole se
résout en corrigeant le code, ou en modifiant le protocole d'abord et explicitement.

Les décisions déjà prises et leurs motifs sont dans `docs/DECISIONS.md` (techniques) et
`coati-interne/DECISIONS-produit.md` (produit). Ne pas les rouvrir sans élément neuf ; une intuition
n'en est pas un.

Un chemin `coati-interne/…` désigne le dépôt privé, dossier voisin `~/projets/coati/interne/`
(études, plans, décisions produit, mémoire, journal). Rien de ce dépôt n'est copié ni lié dans
celui-ci ; tout nouveau document interne s'écrit directement là-bas. Mémoire durable du projet :
`~/projets/coati/interne/MEMORY.md`, à lire en début de session. Le crochet
`scripts/hooks/pre-push` et la CI refusent toute poussée qui contiendrait un fichier interne ou un
secret.

## Langue

Interne (code, commentaires, briefs de worker, noms de variables) en anglais. Ce qui est lu par
un humain — README, DECISIONS, PROTOCOL, JOURNAL, textes d'interface — en français.
Exception depuis le 03/10 (dépôt ouvert aux contributeurs) : messages de commit, titres et
descriptions d'issues et de PR en anglais. L'historique antérieur reste tel quel.

## Règles de sécurité non négociables

Ces cinq règles ne se relâchent pas pour aller plus vite. Les quatre premières viennent de
`coati-interne/etudes/technique.md`, la cinquième de `coati-interne/etudes/faisabilite.md`.

1. **Aucun secret dans `chrome.storage.local`** — non chiffré sur disque. La clé de broker
   (`brokerKey`, obtenue par Native Messaging) vit en `chrome.storage.session`. Identifiants du
   modèle : jamais dans l'extension, uniquement dans le broker.
2. **Le broker écoute sur `127.0.0.1` uniquement.** Jamais `0.0.0.0`, jamais une interface réseau.
   Il vérifie l'en-tête `Origin` et exige la preuve HMAC de la poignée de main `v: 2` (voir
   `docs/PROTOCOL.md`) avant tout traitement.
3. **Le contenu de page est une donnée, jamais une instruction.** Le content script extrait du
   texte assaini, jamais du HTML ; aucun `innerHTML` depuis le contenu de page ; le broker n'exécute
   rien de ce qui vient d'une page.
4. **Pas de `<all_urls>` dans le manifest.** `activeTab` plus permissions d'hôte optionnelles,
   demandées à l'exécution.
5. **Coati accompagne un geste de l'utilisateur, il n'en fabrique jamais.** Pas de boucle
   automatisée sur des pages, pas de veille en arrière-plan, pas de crawl multi-pages, pas
   d'interaction automatisée (publier, aimer, suivre). Cloudflare, les ToS des plateformes et le
   Chrome Web Store tracent la même ligne : la franchir fait perdre les trois protections d'un coup.
   Détail et forme d'application : `docs/DECISIONS.md`, « Contrainte dure — la règle du geste ».

## Ce qui n'existe pas encore

Pas de build, pas de bundler, pas de framework front. L'extension est en JavaScript natif tant
qu'un besoin réel ne justifie pas d'ajouter une dépendance. Le broker est en TypeScript sur Bun.

## Journal

Le journal vit dans `~/projets/coati/interne/JOURNAL.md` : versionné dans le dépôt privé, jamais
dans celui-ci. Convention chronologique inverse : entrée la plus récente en haut, jamais
d'édition rétroactive.

## Tout ce dépôt est public

Tout ce qui est dans ce dépôt est public, messages de commit compris : jamais de prix, de
stratégie, de juridique, d'information personnelle.
