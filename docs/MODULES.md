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
| `streamAnswer(built, opts)` | `(built, opts) => AsyncIterable<AnswerEvent>` | Diffuse la réponse du modèle à `built.prompt`, fencé avec `built.nonce`. `opts` porte `signal` (annulation) et `timeoutMs`. Lève `host.ModelTimeoutError` ou `host.ModelUnavailableError` pour une condition à rapporter en `model-unavailable`, `host.AuthRequiredError` pour une session/clé expirée. |

`opts` (le paramètre `ProviderRuntimeOptions`) porte `model`, `ollamaUrl`, `apiKey` — un module
ignore les champs qu'il ne connaît pas ; sa propre configuration passe plutôt par `options`
(deuxième argument de `createProvider`, ci-dessus).

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
