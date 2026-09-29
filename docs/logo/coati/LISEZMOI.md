# Identité Coati — dossier `docs/logo/coati/`

Tout ce dossier sort d'un seul script, à partir du logo maître `coati.svg` et de la police
Figtree. Le script recadre, recolore et compose avec du texte ; il ne dessine rien.

## Reconstruire
`.tmp/brand-venv/bin/python3 scripts/brand/build-brand.py`

## Contenu
- `coati.svg`, `coati-512.png` : logo maître, pour fond clair. Ne pas modifier.
- `police/` : Figtree et sa licence OFL.
- `mot/` : logotype « Coati » seul, assemblages logo + nom (horizontal, vertical).
- `icones/` : versions monochromes, icônes de 16 à 128 px, icône de boutique.
- `publications/` : tuile, bannière, aperçu GitHub, image de partage (français et anglais),
  avatar.

## Provisoire, en attente d'un dessin Kling
- **Tout ce qui sert sur fond sombre** (fichiers `-negatif` et `-sombre`) : obtenu en recolorant
  le logo, contours noirs passés en blanc. Refusé le 27/09 ; sera refait à partir d'une version
  sombre dessinée sans contour.
- **Icônes de barre d'outils** (`icon16`, `icon32`) : réduction du logo, illisible à cette
  taille. Seront refaites à partir d'une icône simplifiée dessinée par Kling.
- **Versions à une seule couleur** (`coati-mono-*`) : obtenues par seuil de luminosité, elles
  perdent le visage (masque, œil). À redessiner aussi.

## Couleurs
Notes de palette et planche de référence : dans le dépôt de design privé (hors de ce dépôt).
