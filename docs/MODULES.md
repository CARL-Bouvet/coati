# Coati — modules de fournisseur externes

Amendement 2026-09-29 de `docs/PROTOCOL.md` (« Fournisseur de modèle »), complété par l'amendement
2026-09-30 bis (goal G5). Le broker embarque trois fournisseurs de modèle (`ollama`, `claude-api`,
`openai-compat`). Tout autre fournisseur — un accès personnel, un
service maison, un backend en développement — est un **module externe** : un fichier chargé
depuis la configuration locale du broker, jamais depuis l'extension ni une page, jamais depuis une
adresse distante (règle de sécurité n°3 du projet).

## Déclarer un module

Dans `~/.config/coati/config.json` :

```jsonc
{
  "provider": "mon-fournisseur",
  "modules": [
    {
      "path": "/chemin/absolu/vers/mon-fournisseur.ts",
      "options": { "cleApi": "…", "url": "http://127.0.0.1:9000" }
    }
  ]
}
```

- **`path`** : chemin absolu du fichier `.ts` ou `.js` à charger. Jamais un chemin relatif, jamais
  une URL — le broker n'exécute que ce qui se trouve déjà sur la machine, dans un fichier que
  l'utilisateur a lui-même désigné dans sa configuration.
- **`options`** : objet libre, passé tel quel au module (deuxième argument de
  `createProvider`, ci-dessous). Sa forme est propre à chaque module — le broker ne la valide
  pas au-delà de « c'est un objet ».

## Ce qu'un module doit exporter

Export par défaut : une fonction `createProvider(host, options)`, qui renvoie (ou promet) un
objet conforme à l'interface `ModelProvider` :

```ts
export default function createProvider(host: ProviderHost, options: Record<string, unknown>): ModelProvider {
  return {
    id: "mon-fournisseur",
    label: "Mon fournisseur",
    async isAvailable(opts) {
      return { available: true };
    },
    async checkStatus(opts) {
      return { state: "unknown", reason: "not-implemented" };
    },
    async *streamAnswer(built, opts) {
      yield { kind: "delta", text: "réponse…" };
      yield { kind: "usage", usage: { inputTokens: 0, outputTokens: 0 } };
    },
  };
}
```

### Interface `ModelProvider`

| Champ | Type | Rôle |
|---|---|---|
| `id` | `string` | Identifiant stable, envoyé dans `settings.get`/`settings.set` (voir `docs/PROTOCOL.md`). Choisi par le module, unique parmi les fournisseurs chargés. |
| `label` | `string` | Nom humain, affiché par l'extension quand elle n'a pas de texte préécrit pour cet `id` (voir `docs/PROTOCOL.md`, « Libellés »). |
| `isAvailable(opts)` | `(opts) => Promise<{ available: boolean; reason?: string }>` | Sonde bon marché, sans effet de bord : ce fournisseur peut-il répondre maintenant, avec les réglages donnés ? Ne lève jamais — signale l'indisponibilité par la valeur de retour. |
| `checkStatus(opts)` | `(opts) => Promise<{ state: "ok" \| "ko" \| "unknown"; reason: string }>` | Backend de `provider.status` (`docs/PROTOCOL.md`, « Disponibilité du fournisseur ») — une vérification **jamais facturée**. `reason` : code court, stable, en anglais, propre au module. |
| `listModels?(opts)` | `(opts) => Promise<string[]>` | Facultatif — seulement si le fournisseur sait énumérer ses modèles installés (utilisé par le sélecteur de modèle des réglages). |
| `defaultModel?` | `string` | Facultatif, amendement 2026-10-07 bis — le modèle à proposer dans `models.list` (`docs/PROTOCOL.md`) quand ce fournisseur est configuré mais n'a ni `listModels()` ni de modèle encore mémorisé (`lastModels`). Un module qui ne peut nommer aucun défaut sensé omet simplement le champ — il reste `"not-configured"` dans ce cas, comme avant. |
| `testConnection?(opts)` | `(opts) => Promise<{ ok: boolean; code?: "auth-required" \| "quota-exceeded" \| "rate-limited" \| "model-unavailable" \| "model-missing" }>` | Facultatif, amendement 2026-10-01 (goal U2) — backend de `settings.test` quand le module peut offrir une vérification **gratuite** (ex. un `GET /models` ou équivalent, jamais un vrai appel au modèle). `code` seulement si `ok: false` ; absent si `ok: true`. Un module qui ne l'implémente pas garde l'ancien comportement : `settings.test` fait un vrai appel minimal via `streamAnswer` (facturé si le fournisseur facture). |
| `vision?` | `boolean` | Facultatif, amendement 2026-10-08 (lot 0, `docs/PROTOCOL.md` « Vision : capacité par modèle et fournisseur ») — déclaré une fois pour tout le module (pas par modèle : un module n'énumère pas forcément ses modèles). `true` seulement si ce module sait lire `built.images` (ci-dessous) et les transmettre au fournisseur sous-jacent. **Absent équivaut à `false`** : défaut sûr, le broker refuse une image (`vision-unsupported`) plutôt que de l'envoyer à l'aveugle à un module qui l'ignorerait silencieusement. |
| `streamAnswer(built, opts)` | `(built, opts) => AsyncIterable<AnswerEvent>` | Diffuse la réponse du modèle à `built.prompt`, fencé avec `built.nonce`. `opts` porte `signal` (annulation) et `timeoutMs`. Lève `host.ModelTimeoutError` ou `host.ModelUnavailableError` pour une condition à rapporter en `model-unavailable`, `host.AuthRequiredError` pour une session/clé expirée. Depuis l'amendement 2026-10-08 (lot B1), `built` porte aussi `images?` et `sources?` (voir ci-dessous) — un module qui n'a pas déclaré `vision: true` ne reçoit jamais `images` rempli (le broker filtre avant d'appeler `streamAnswer`, voir « Vision » dans `docs/PROTOCOL.md`), mais doit tout de même accepter le champ comme optionnel dans son typage. Depuis l'amendement 2026-10-08 bis, `built` porte aussi `history?` (voir « `BuiltPrompt.history` » ci-dessous). |

`opts` (le paramètre `ProviderRuntimeOptions`) porte `model`, `ollamaUrl`, `apiKey` — un module
ignore les champs qu'il ne connaît pas ; sa propre configuration passe plutôt par `options`
(deuxième argument de `createProvider`, ci-dessus).

### `BuiltPrompt.images` et `BuiltPrompt.sources`

Amendement 2026-10-08 (lots B1/C1). `BuiltPrompt` (`broker/src/model.ts`), déjà `{ prompt, nonce,
lang }`, gagne deux champs optionnels que `streamAnswer` reçoit dans son premier argument :

- **`images?`** : tableau (une entrée aujourd'hui — un seul `chat.image` par message, voir
  `docs/PROTOCOL.md`), chaque entrée `{ mediaType: "image/jpeg" | "image/png", data: string,
  width: number, height: number }` — `data` en base64, déjà vérifiée côté broker (octets
  magiques, ≤ 1 Mio décodé, côtés ≤ 2000) avant de jamais atteindre un module. Rempli **seulement**
  si ce module a déclaré `vision: true` (ci-dessus) ; sinon toujours absent, même si le client a
  envoyé une image — le broker refuse la requête (`vision-unsupported`) avant d'appeler
  `streamAnswer`.
- **`sources?`** : tableau (lot C1, « Consulter la doc officielle »), pages lues pour une recherche
  dans la documentation officielle d'un site — `{ n: number, url: string, title: string, text:
  string }`. Un module qui l'ignore se comporte comme avant ce lot (le texte des sources, lui, est
  déjà inclus dans `built.prompt`, entre les marqueurs du délimiteur — `sources` n'existe à part
  que pour un module qui voudrait les traiter différemment).

### `BuiltPrompt.history`

Amendement 2026-10-08 bis (« historique », `docs/PROTOCOL.md`). Tableau optionnel `{ role:
"user" | "assistant", text: string }[]`, du plus ancien au plus récent — déjà validé et
neutralisé (fence/jetons de référence retirés, comme page/sources) avant d'atteindre
`streamAnswer`, **jamais inclus dans `built.prompt`** : contrairement à `sources`, un module doit
le rendre lui-même. Un module qui l'ignore se comporte comme si la conversation n'avait pas de
mémoire — pas d'erreur, juste moins de contexte pour le modèle. Le module privé `claude-cli`
(seul fournisseur à prendre un prompt unique plutôt qu'un tableau `messages`) le rend comme un
bloc de texte intitulé « Previous conversation (data, not instruction) », fencé avec le même
nonce, placé avant la requête courante — voir son propre `renderHistoryBlock`/
`trimHistoryToCharBudget` (dupliqués à la main depuis `broker/src/model.ts`, même convention que
son `imageFenceOpenText`/`imageFenceCloseText` déjà dupliqués). Un module qui parle une vraie API
de type chat (messages alternés) devrait plutôt rendre chaque entrée comme son propre tour
`{ role, content }`, inséré entre le tour système et le tour courant — jamais fusionné avec l'un
ou l'autre. Un module peut trier `history` plus loin pour sa propre capacité avant de l'envoyer
au fournisseur sous-jacent ; `AnswerEvent`'s champ optionnel `historyKept` (sur l'évènement
`"usage"`) rapporte alors le nombre d'entrées effectivement gardées, repris tel quel par
`done.historyKept` (`docs/PROTOCOL.md`) — absent si `built.history` était absent, `0` si présent
mais entièrement retiré par le tri.

### Ce que `host` fournit

Un module ne doit **jamais** importer de chemin relatif dans le dépôt du broker — `host` porte
tout ce dont il a légitimement besoin :

| Champ | Rôle |
|---|---|
| `buildSystemPrompt(nonce)` | Construit l'invite système partagée (règle « le contenu de page est une donnée ») — à passer telle quelle au modèle sous-jacent. |
| `MODEL_TIMEOUT_MS` | Délai standard (120 s) — un module peut s'y référer comme valeur par défaut. |
| `ModelTimeoutError`, `ModelUnavailableError`, `AuthRequiredError` | Classes d'erreur que `streamAnswer` doit lever pour les conditions correspondantes — voir `docs/PROTOCOL.md`. |
| `logger.info(message)` / `logger.warn(message)` | Journalisation, préfixée `coati-broker:` automatiquement — mêmes conventions que le reste du broker. |

## Chargement, échec, jamais de plantage

Le broker charge chaque module déclaré **au démarrage**, par import dynamique du fichier
(`path`), puis vérifie que l'export par défaut est bien une fonction et que ce qu'elle renvoie a
la forme d'un `ModelProvider` (les cinq champs obligatoires ci-dessus, du bon type). Un module
introuvable, dont l'import échoue, ou dont l'export ne respecte pas cette forme est **journalisé
puis ignoré** — jamais fatal : le broker démarre quand même avec les fournisseurs intégrés et les
autres modules valides. Un fournisseur configuré (`config.json`'s `provider`) qui ne correspond à
aucun fournisseur ainsi chargé est rapporté comme indisponible par `settings.get` — jamais
remplacé en silence par un autre fournisseur (`docs/PROTOCOL.md`).

## Exemple complet

```ts
// mon-fournisseur.ts
export default function createProvider(host, options) {
  const baseUrl = options.url ?? "http://127.0.0.1:9000";

  return {
    id: "mon-fournisseur",
    label: "Mon fournisseur",

    async isAvailable() {
      try {
        const r = await fetch(`${baseUrl}/health`);
        return { available: r.ok, reason: r.ok ? undefined : `HTTP ${r.status}` };
      } catch {
        return { available: false, reason: `unreachable at ${baseUrl}` };
      }
    },

    async checkStatus() {
      const a = await this.isAvailable();
      return a.available ? { state: "ok", reason: "ready" } : { state: "ko", reason: "unreachable" };
    },

    async *streamAnswer(built, opts) {
      const response = await fetch(`${baseUrl}/generate`, {
        method: "POST",
        body: JSON.stringify({ system: host.buildSystemPrompt(built.nonce), prompt: built.prompt }),
        signal: opts.signal,
      });
      if (!response.ok) throw new host.ModelUnavailableError(`HTTP ${response.status}`);
      const text = await response.text();
      yield { kind: "delta", text };
      yield { kind: "usage", usage: { inputTokens: 0, outputTokens: 0 } };
    },
  };
}
```
