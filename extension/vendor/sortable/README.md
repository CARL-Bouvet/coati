# SortableJS — copie fournisseur

- **Version** : 1.15.7 (publiée sur npm).
- **Source** : `https://registry.npmjs.org/sortablejs/-/sortablejs-1.15.7.tgz`.
- **Intégrité** (`dist.integrity` du registre npm, vérifiée par `sha512sum` contre le tarball
  téléchargé avant extraction) :
  `sha512-Kk8wLQPlS+yi1ZEf48a4+fzHa4yxjC30M/Sr2AnQu+f/MPwvvX9XjZ6OWejiz8crBsLwSq8GHqaxaET7u6ux0A==`
- **Fichier copié** : `package/modular/sortable.esm.js` du tarball, tel quel (aucune modification),
  sous le nom `sortable.esm.js`. Choisi plutôt que `Sortable.js` (UMD) car la page « Mes prompts »
  est un module ES (`<script type="module">`), même contrainte que `extension/lib/`.
- **Licence** : MIT, voir `LICENSE` dans ce dossier (copiée telle quelle depuis le tarball).
- **CSP** (`docs/PROTOCOL.md`, `default-src 'self'; style-src 'self'`) : fichier passé au crible
  (`grep`) — aucun `eval(`, aucun `new Function(`, aucun `<style>` injecté, aucun
  `setAttribute("style", …)`. Une seule écriture de style, `el.style.cssText = 'pointer-events:auto'`
  (ligne ~916) : une affectation CSSOM (`element.style.…`), pas un attribut HTML inline — `style-src`
  ne la bloque pas (seuls `<style>`, `style="…"` posé par le HTML/`setAttribute` et les feuilles
  externes sont concernés).
- **Ne jamais éditer ce fichier à la main.** Pour mettre à jour la version : retélécharger le
  tarball, revérifier l'intégrité contre le registre, recopier `modular/sortable.esm.js` et
  `LICENSE`, mettre à jour ce README.
