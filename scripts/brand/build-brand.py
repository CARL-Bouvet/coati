#!/usr/bin/env python3
"""Build every Coati brand asset from the master trace (coati.svg) and Figtree.

Rule of the project (docs/DECISIONS.md, "aucune forme nouvelle"): this script only
crops, recolours, clips and composes the ~60 existing paths of coati.svg with flat
backgrounds and outlined text. It never invents a new shape.

Run:
    .tmp/brand-venv/bin/python3 scripts/brand/build-brand.py

Everything under docs/logo/coati/ is regenerated from scratch on each run (the
directory is not wiped first, so stray manual files would survive -- don't add any).
"""
from __future__ import annotations

import os
import re
import shutil
import subprocess
from pathlib import Path

import uharfbuzz as hb
from fontTools.pens.svgPathPen import SVGPathPen
from fontTools.pens.transformPen import TransformPen
from fontTools.ttLib import TTFont

ROOT = Path(__file__).resolve().parents[2]
LOGO_SRC = ROOT / "docs/logo/coati/coati.svg"
FONTS_SRC = ROOT / ".tmp/fonts"
OUT = ROOT / "docs/logo/coati"
# Private design folder (palette.md, identity boards): the sibling private repository
# ~/projets/coati/interne (../interne from this repository), or $COATI_INTERNE. Absent in a public clone.
DESIGN = Path(os.environ.get("COATI_INTERNE", ROOT.parent / "interne")) / "design"

VIEWBOX = 1200  # coati.svg is viewBox="0 0 1200 1200"
EYE_CX, EYE_CY, EYE_R = 406.3, 265.9, 23  # documented in the mission spec

# ---------------------------------------------------------------------------
# Palette. Every UI role has one value PER THEME (see THEMES further down, which
# also writes a copy to the private design notes). "LIGHT"/"DARK" below name the theme a
# value serves, not its lightness: the light-theme caramel is the darker one.
# ---------------------------------------------------------------------------
CARAMEL_LIGHT = "#9C5A12"   # caramel for the light theme (on white)
CARAMEL_DARK = "#D98323"    # caramel for the dark theme (on anthracite)
ANTHRACITE_SURFACE = "#2A2C30"
ANTHRACITE_BG = "#1F2023"
CREME = "#F7F5F1"           # the logo's cream fur; logotype colour on dark
BLANC = "#FFFFFF"
GRIS_CLAIR = "#F4F5F7"      # neutral light grey: light publication backgrounds

# Negative colour mapping applied to coati.svg fills (see LISEZMOI.md).
# Anything not listed here is kept unchanged (roux, beige, dark brown, mid greys).
NEGATIVE_MAP = {
    "#050403": CREME,       # outline / mask / nose / claws / dark rings / magnifier -> cream
    "#F7F5F1": "#050403",   # cream family -> black
    "#F6F4F0": "#050403",
    "#F4F2EE": "#050403",
    "#F3F1ED": "#050403",
    "#E2DEDB": "#3A3836",   # light greys -> dark grey (inverted lightness)
    "#E2DCD8": "#3A3836",
    "#E1DDDA": "#3A3836",
}

SLOGAN_FR = "Votre IA lit la page, quand vous le demandez."
SLOGAN_EN = "Your AI reads the page, when you ask."


# ---------------------------------------------------------------------------
# SVG helpers -- parse coati.svg into an ordered list of <path> tags and
# recompose subsets of them. No path data is ever generated or edited here.
# ---------------------------------------------------------------------------

def load_paths() -> list[str]:
    svg_text = LOGO_SRC.read_text(encoding="utf-8")
    tags = re.findall(r"<path[^>]*/?>", svg_text)
    assert len(tags) >= 60, f"expected ~63 paths, found {len(tags)}"
    return tags


def fill_of(tag: str) -> str | None:
    m = re.search(r'fill="([^"]*)"', tag)
    return m.group(1) if m else None


def with_fill(tag: str, new_fill: str) -> str:
    if 'fill="' in tag:
        return re.sub(r'fill="[^"]*"', f'fill="{new_fill}"', tag, count=1)
    return tag.replace("<path ", f'<path fill="{new_fill}" ', 1)


def recolour(tags: list[str], mapping: dict[str, str]) -> list[str]:
    out = []
    for t in tags:
        f = fill_of(t)
        if f and f in mapping:
            out.append(with_fill(t, mapping[f]))
        else:
            out.append(t)
    return out


def svg_wrap(inner: str, *, min_x=0, min_y=0, w=VIEWBOX, h=VIEWBOX,
             out_w: int | None = None, out_h: int | None = None,
             extra_defs: str = "") -> str:
    ow = out_w if out_w is not None else w
    oh = out_h if out_h is not None else h
    return (
        f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="{min_x} {min_y} {w} {h}" '
        f'width="{ow}" height="{oh}">{extra_defs}{inner}</svg>'
    )


def write_svg(path: Path, content: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(content, encoding="utf-8")


def render_png(svg_path: Path, png_path: Path, size: int | None = None,
               w: int | None = None, h: int | None = None) -> None:
    png_path.parent.mkdir(parents=True, exist_ok=True)
    cmd = ["rsvg-convert", "-o", str(png_path)]
    if size is not None:
        cmd += ["-w", str(size), "-h", str(size)]
    elif w is not None and h is not None:
        cmd += ["-w", str(w), "-h", str(h)]
    cmd.append(str(svg_path))
    subprocess.run(cmd, check=True)


def eye_clip_defs(uid: str) -> str:
    return f'<clipPath id="{uid}"><circle cx="{EYE_CX}" cy="{EYE_CY}" r="{EYE_R}"/></clipPath>'


# Head crop content box (viewBox units of coati.svg), measured on a grid by
# the admin: head top ~y15, ears x320-650, whiskers to x~90, nose x150-240,
# window top edge ~y405, paw x560-700. Revision 2 (26/09 admin review):
# widened right/bottom to stop cutting the right ear and the paw, and to
# shrink the window to a thin ledge under the chin instead of ~37% of the box.
HEAD_CROP_BOX = (80, 15, 760, 470)  # x0, y0, x1, y1
HEAD_CROP_SIDE = 680  # square canvas the content box is centred into


def main() -> None:
    OUT.mkdir(parents=True, exist_ok=True)
    tags = load_paths()
    all_paths = "".join(tags)
    negative_tags = recolour(tags, NEGATIVE_MAP)
    negative_paths = "".join(negative_tags)

    build_fonts()
    build_wordmarks()
    build_lockups()
    build_icons(tags, all_paths, negative_paths)
    build_publications()
    build_palette_doc()
    build_lisezmoi()
    build_recap_sheet()
    print("Brand build complete ->", OUT)


# ---------------------------------------------------------------------------
# 1. police/
# ---------------------------------------------------------------------------

def build_fonts() -> None:
    dest = OUT / "police"
    dest.mkdir(parents=True, exist_ok=True)
    for name in ("Figtree-SemiBold.ttf", "Figtree-Bold.ttf", "Figtree-ExtraBold.ttf"):
        shutil.copy2(FONTS_SRC / name, dest / name)
    shutil.copy2(FONTS_SRC / "LICENSE-figtree.txt", dest / "LICENSE-figtree.txt")


# ---------------------------------------------------------------------------
# Text -> outlines (Figtree). No glyph is drawn: fontTools extracts the
# outlines HarfBuzz already shaped, we only translate/flip/scale them.
# ---------------------------------------------------------------------------

def _shape(text: str, font_path: Path) -> tuple[TTFont, list, list]:
    data = font_path.read_bytes()
    face = hb.Face(data)
    hb_font = hb.Font(face)
    buf = hb.Buffer()
    buf.add_str(text)
    buf.guess_segment_properties()
    hb.shape(hb_font, buf)
    tt = TTFont(font_path)
    return tt, buf.glyph_infos, buf.glyph_positions


def glyph_group(text: str, font_path: Path, fill: str, tracking_em: float = -0.02) -> str:
    """SVG <g> of outlined glyphs, baseline at y=0, font-unit coordinates (y-up)."""
    tt, infos, positions = _shape(text, font_path)
    glyph_set = tt.getGlyphSet()
    units_per_em = tt["head"].unitsPerEm
    tracking = tracking_em * units_per_em
    cursor = 0.0
    parts = []
    for info, pos in zip(infos, positions):
        glyph_name = tt.getGlyphName(info.codepoint)
        pen = SVGPathPen(glyph_set)
        glyph_set[glyph_name].draw(pen)
        d = pen.getCommands()
        if d:
            x = cursor + pos.x_offset
            parts.append(f'<path d="{d}" transform="translate({x},{-pos.y_offset})"/>')
        cursor += pos.x_advance + tracking
    return f'<g fill="{fill}">{"".join(parts)}</g>'


def flatten_bbox(svg_content: str, min_x: float, min_y: float, w: float, h: float,
                  res: int = 1200) -> tuple[float, float, float, float]:
    """Render svg_content (already a full <svg>) and return its opaque-pixel
    bbox, expressed back in the original viewBox units."""
    import numpy as np
    from PIL import Image

    tmp_svg = ROOT / ".tmp/_bbox.svg"
    tmp_png = ROOT / ".tmp/_bbox.png"
    write_svg(tmp_svg, svg_content)
    render_png(tmp_svg, tmp_png, w=res, h=round(res * h / w))
    im = np.array(Image.open(tmp_png).convert("RGBA"))
    ys, xs = np.where(im[:, :, 3] > 10)
    if len(xs) == 0:
        return (min_x, min_y, min_x + w, min_y + h)
    sx = w / res
    sy = h / round(res * h / w)
    return (
        min_x + xs.min() * sx,
        min_y + ys.min() * sy,
        min_x + (xs.max() + 1) * sx,
        min_y + (ys.max() + 1) * sy,
    )


def text_group_normalized(text: str, font_path: Path, fill: str) -> tuple[str, float, float]:
    """<g> of outlined text translated so its tight bbox starts at (0,0).
    Returns (group_svg, width, height) in font units."""
    tt = TTFont(font_path)
    units_per_em = tt["head"].unitsPerEm
    ascent = tt["hhea"].ascent
    descent = tt["hhea"].descent
    group = glyph_group(text, font_path, fill)
    flipped = f'<g transform="scale(1,-1)">{group}</g>'
    # generous provisional box to measure against
    prov_w = units_per_em * len(text) * 1.2
    probe = svg_wrap(flipped, min_x=0, min_y=-ascent, w=prov_w, h=ascent - descent)
    x0, y0, x1, y1 = flatten_bbox(probe, 0, -ascent, prov_w, ascent - descent)
    w, h = x1 - x0, y1 - y0
    normalized = f'<g transform="translate({-x0},{-y0})">{flipped}</g>'
    return normalized, w, h


def text_tight_svg(text: str, font_path: Path, fill: str) -> tuple[str, float, float]:
    """Full standalone SVG with a tight viewBox around the outlined text.
    Returns (svg_string, width, height) in font units."""
    group, w, h = text_group_normalized(text, font_path, fill)
    final = svg_wrap(group, min_x=0, min_y=0, w=w, h=h)
    return final, w, h


# ---------------------------------------------------------------------------
# 2. mot/ -- standalone logotype, three colourways
# ---------------------------------------------------------------------------

WORDMARK_COLOURS = {
    "anthracite": ANTHRACITE_SURFACE,
    "creme": CREME,
    "caramel": CARAMEL_LIGHT,
}


WORDMARK_PNG_HEIGHT_2X = 240  # 2x export; 1x reference is 120px tall


def build_wordmarks() -> None:
    dest = OUT / "mot"
    dest.mkdir(parents=True, exist_ok=True)
    font_path = FONTS_SRC / "Figtree-Bold.ttf"
    for name, colour in WORDMARK_COLOURS.items():
        svg, w, h = text_tight_svg("Coati", font_path, colour)
        svg_path = dest / f"coati-logotype-{name}.svg"
        write_svg(svg_path, svg)
        png_h = WORDMARK_PNG_HEIGHT_2X
        png_w = round(png_h * w / h)
        render_png(svg_path, dest / f"coati-logotype-{name}.png", w=png_w, h=png_h)


# ---------------------------------------------------------------------------
# 3. mot/ -- lockups (icon + wordmark), horizontal and vertical, light/dark
# ---------------------------------------------------------------------------

def full_logo_bbox(paths_joined: str) -> tuple[float, float, float, float]:
    probe = svg_wrap(paths_joined, min_x=0, min_y=0, w=VIEWBOX, h=VIEWBOX)
    return flatten_bbox(probe, 0, 0, VIEWBOX, VIEWBOX, res=600)


LOCKUP_PNG_PAD_RATIO = 0.12  # of the lockup's larger side, on all four sides


def _padded_wrap(inner: str, w: float, h: float, pad_ratio: float = LOCKUP_PNG_PAD_RATIO,
                  bg: str | None = None) -> tuple[str, float, float]:
    """Wrap tight `inner` content (occupying 0,0..w,h) with a transparent (or
    flat-coloured) margin of pad_ratio * max(w,h) on every side. Padding a
    viewBox is cropping/framing, not drawing."""
    pad = pad_ratio * max(w, h)
    pw, ph = w + 2 * pad, h + 2 * pad
    rect = f'<rect x="{-pad}" y="{-pad}" width="{pw}" height="{ph}" fill="{bg}"/>' if bg else ""
    svg = svg_wrap(rect + inner, min_x=-pad, min_y=-pad, w=pw, h=ph)
    return svg, pw, ph


def build_lockups() -> None:
    dest = OUT / "mot"
    font_path = FONTS_SRC / "Figtree-Bold.ttf"
    tags = load_paths()
    all_paths = "".join(tags)
    negative_paths = "".join(recolour(tags, NEGATIVE_MAP))
    negative_with_eye = negative_paths + eye_fix_group(tags)

    lx0, ly0, lx1, ly1 = full_logo_bbox(all_paths)
    lw, lh = lx1 - lx0, ly1 - ly0

    variants = {
        "clair": (all_paths, ANTHRACITE_SURFACE, None),
        "sombre": (negative_with_eye, CREME, ANTHRACITE_BG),
    }

    for theme, (logo_paths, text_colour, bg) in variants.items():
        word_group, ww, wh = text_group_normalized("Coati", font_path, text_colour)

        # --- horizontal: logo left, wordmark right, vertically centred ---
        # proportions approved, unchanged: wordmark cap-height ~= half the
        # coati's height, gap ~= 12% of the coati's width.
        word_scale_h = lh * 0.5 / wh
        gap_h = lw * 0.12
        word_w_h = ww * word_scale_h
        word_h_h = wh * word_scale_h
        total_w = lw + gap_h + word_w_h
        total_h = max(lh, word_h_h)
        logo_y = (total_h - lh) / 2
        word_y = (total_h - word_h_h) / 2
        inner = (
            f'<g transform="translate({-lx0},{logo_y - ly0})">{logo_paths}</g>'
            f'<g transform="translate({lw + gap_h},{word_y}) scale({word_scale_h})">{word_group}</g>'
        )
        svg = svg_wrap(inner, min_x=0, min_y=0, w=total_w, h=total_h)
        svg_path = dest / f"coati-horizontal-{theme}.svg"
        write_svg(svg_path, svg)
        padded, pw, ph = _padded_wrap(inner, total_w, total_h)
        png_h = 320 + round(320 * 2 * LOCKUP_PNG_PAD_RATIO)
        _render_svg_string(padded, pw, ph, dest / f"coati-horizontal-{theme}.png", png_h)
        if bg:
            padded_bg, pwb, phb = _padded_wrap(inner, total_w, total_h, bg=bg)
            svg_path_fond = dest / f"coati-horizontal-{theme}-fond.svg"
            write_svg(svg_path_fond, padded_bg)
            _render_svg_string(padded_bg, pwb, phb, dest / f"coati-horizontal-{theme}-fond.png", png_h)

        # --- vertical: logo above, wordmark below, horizontally centred ---
        # wordmark is much wider than tall (~1.7x the logo's width unscaled),
        # so it is scaled by width instead of height: target width ~= 0.9x
        # the logo's width, gap ~= 8% of the logo's height.
        word_scale_v = (lw * 0.9) / ww
        vgap = lh * 0.08
        word_w_v = ww * word_scale_v
        word_h_v = wh * word_scale_v
        total_w_v = max(lw, word_w_v)
        total_h_v = lh + vgap + word_h_v
        logo_x = (total_w_v - lw) / 2
        word_x = (total_w_v - word_w_v) / 2
        inner_v = (
            f'<g transform="translate({logo_x - lx0},{-ly0})">{logo_paths}</g>'
            f'<g transform="translate({word_x},{lh + vgap}) scale({word_scale_v})">{word_group}</g>'
        )
        svg_v = svg_wrap(inner_v, min_x=0, min_y=0, w=total_w_v, h=total_h_v)
        svg_path_v = dest / f"coati-vertical-{theme}.svg"
        write_svg(svg_path_v, svg_v)
        padded_v, pwv, phv = _padded_wrap(inner_v, total_w_v, total_h_v)
        png_h_v = 360 + round(360 * 2 * LOCKUP_PNG_PAD_RATIO)
        _render_svg_string(padded_v, pwv, phv, dest / f"coati-vertical-{theme}.png", png_h_v)
        if bg:
            padded_v_bg, pwvb, phvb = _padded_wrap(inner_v, total_w_v, total_h_v, bg=bg)
            svg_path_v_fond = dest / f"coati-vertical-{theme}-fond.svg"
            write_svg(svg_path_v_fond, padded_v_bg)
            _render_svg_string(padded_v_bg, pwvb, phvb, dest / f"coati-vertical-{theme}-fond.png", png_h_v)


def _render_svg_string(svg_content: str, vb_w: float, vb_h: float, out_png: Path, png_h: int) -> None:
    tmp_svg = ROOT / ".tmp/_render.svg"
    write_svg(tmp_svg, svg_content)
    render_png(tmp_svg, out_png, w=round(png_h * vb_w / vb_h), h=png_h)


def eye_fix_group(tags: list[str]) -> str:
    """Clip the ORIGINAL (non-negated) artwork to a circle around the eye and
    stack it on top, so the pupil stays dark in negative variants."""
    uid = "eyefix"
    defs = eye_clip_defs(uid)
    return f'<defs>{defs}</defs><g clip-path="url(#{uid})">{"".join(tags)}</g>'


def _luminance(hexc: str) -> float:
    hexc = hexc.lstrip("#")
    r, g, b = int(hexc[0:2], 16) / 255, int(hexc[2:4], 16) / 255, int(hexc[4:6], 16) / 255

    def lin(c: float) -> float:
        return c / 12.92 if c <= 0.03928 else ((c + 0.055) / 1.055) ** 2.4

    r, g, b = lin(r), lin(g), lin(b)
    return 0.2126 * r + 0.7152 * g + 0.0722 * b


MONO_LUMINANCE_THRESHOLD = 0.45  # below -> "dark" shape kept in monochrome icons


def crop_svg(paths_joined: str, x0: float, y0: float, x1: float, y1: float,
             extra_defs: str = "") -> str:
    return svg_wrap(extra_defs + paths_joined, min_x=x0, min_y=y0, w=x1 - x0, h=y1 - y0)


def head_crop_svg(paths_joined: str, box: tuple[float, float, float, float],
                   side: float) -> str:
    """Clip `paths_joined` to `box` (a clipPath rect -- cropping, not drawing)
    then centre that box in a `side`x`side` transparent square. `paths_joined`
    may itself already contain nested <defs>/<g clip-path> (e.g. the eye-fix
    overlay) -- it is treated as one opaque blob of content to clip+centre."""
    x0, y0, x1, y1 = box
    w, h = x1 - x0, y1 - y0
    uid = "headbox"
    clip = f'<clipPath id="{uid}"><rect x="{x0}" y="{y0}" width="{w}" height="{h}"/></clipPath>'
    tx = (side - w) / 2 - x0
    ty = (side - h) / 2 - y0
    inner = (
        f'<defs>{clip}</defs>'
        f'<g transform="translate({tx},{ty})"><g clip-path="url(#{uid})">{paths_joined}</g></g>'
    )
    return svg_wrap(inner, min_x=0, min_y=0, w=side, h=side)


def centred_svg(paths_joined: str, lx0: float, ly0: float, lx1: float, ly1: float,
                 canvas: int, drawing: int, extra_defs: str = "") -> str:
    """Logo (bbox lx0..ly1) scaled to fit a `drawing`x`drawing` box, centred on a
    `canvas`x`canvas` transparent square (Chrome Web Store 128px rule: 96px art
    + 16px margin)."""
    lw, lh = lx1 - lx0, ly1 - ly0
    scale = drawing / max(lw, lh)
    tx = (canvas - lw * scale) / 2
    ty = (canvas - lh * scale) / 2
    inner = (
        f'{extra_defs}<g transform="translate({tx},{ty}) scale({scale}) '
        f'translate({-lx0},{-ly0})">{paths_joined}</g>'
    )
    return svg_wrap(inner, min_x=0, min_y=0, w=canvas, h=canvas)


def build_icons(tags: list[str], all_paths: str, negative_paths: str) -> None:
    dest = OUT / "icones"
    dest.mkdir(parents=True, exist_ok=True)
    eyefix = eye_fix_group(tags)
    negative_with_eye = negative_paths + eyefix

    # -- negatif (full logo) --------------------------------------------
    lx0, ly0, lx1, ly1 = full_logo_bbox(all_paths)
    neg_svg = crop_svg(negative_with_eye, lx0, ly0, lx1, ly1)
    write_svg(dest / "coati-negatif.svg", neg_svg)
    render_png(dest / "coati-negatif.svg", dest / "coati-negatif-512.png", size=512)

    # -- monochrome --------------------------------------------------------
    dark_tags = [t for t in tags if fill_of(t) and _luminance(fill_of(t)) < MONO_LUMINANCE_THRESHOLD]
    for name, colour in (("anthracite", ANTHRACITE_SURFACE), ("blanc", BLANC)):
        mono_tags = [with_fill(t, colour) for t in dark_tags]
        mono_svg = crop_svg("".join(mono_tags), lx0, ly0, lx1, ly1)
        write_svg(dest / f"coati-mono-{name}.svg", mono_svg)
        render_png(dest / f"coati-mono-{name}.svg", dest / f"coati-mono-{name}-512.png", size=512)

    # -- head crop (16/32 px source): clip to HEAD_CROP_BOX (ears, eye, nose,
    # whiskers, paw), centred in a HEAD_CROP_SIDE square with transparent
    # padding top/bottom -- window reduced to a thin ledge under the chin.
    side = HEAD_CROP_SIDE
    tete_svg = head_crop_svg(all_paths, HEAD_CROP_BOX, side)
    write_svg(dest / "coati-tete.svg", tete_svg)
    tete_neg_svg = head_crop_svg(negative_with_eye, HEAD_CROP_BOX, side)
    write_svg(dest / "coati-tete-negatif.svg", tete_neg_svg)

    # -- toolbar icons -------------------------------------------------
    for sz in (16, 32):
        render_png(dest / "coati-tete.svg", dest / f"icon{sz}.png", size=sz)
        render_png(dest / "coati-tete-negatif.svg", dest / f"icon{sz}-negatif.png", size=sz)

    # 48px: the full logo is legible at 48 (tested visually, kept); 128px
    # follows the Chrome Web Store rule (96px art + 16px transparent margin).
    full48 = centred_svg(all_paths, lx0, ly0, lx1, ly1, canvas=48, drawing=48)
    write_svg(dest / "icon48.svg", full48)
    render_png(dest / "icon48.svg", dest / "icon48.png", size=48)
    full48n = centred_svg(negative_with_eye, lx0, ly0, lx1, ly1, canvas=48, drawing=48)
    write_svg(dest / "icon48-negatif.svg", full48n)
    render_png(dest / "icon48-negatif.svg", dest / "icon48-negatif.png", size=48)

    full128 = centred_svg(all_paths, lx0, ly0, lx1, ly1, canvas=128, drawing=96)
    write_svg(dest / "icon128.svg", full128)
    render_png(dest / "icon128.svg", dest / "icon128.png", size=128)
    full128n = centred_svg(negative_with_eye, lx0, ly0, lx1, ly1, canvas=128, drawing=96)
    write_svg(dest / "icon128-negatif.svg", full128n)
    render_png(dest / "icon128-negatif.svg", dest / "icon128-negatif.png", size=128)

    # store icon = same 128 drawing, delivered under its own name
    render_png(dest / "icon128.svg", dest / "icone-boutique-128.png", size=128)

    build_test_barres(dest)


def build_test_barres(dest: Path) -> None:
    import numpy as np
    from PIL import Image

    bars = {"clair": "#F1F3F4", "sombre": "#292A2D"}
    rows = [
        ("icon16", 16, False), ("icon16-negatif", 16, True),
        ("icon32", 32, False), ("icon32-negatif", 32, True),
        ("icon48", 48, False), ("icon48-negatif", 48, True),
        ("icon128", 128, False), ("icon128-negatif", 128, True),
    ]
    pad = 20
    scales = (1, 2)
    col_w = 128 * 2 + pad
    row_h = 128 * 2 + pad
    canvas_w = col_w * len(scales) + pad
    canvas_h = row_h * len(rows) + pad
    sheet = Image.new("RGB", (canvas_w * len(bars), canvas_h), "white")
    for bar_i, (bar_name, bar_colour) in enumerate(bars.items()):
        band = Image.new("RGBA", (canvas_w, canvas_h), bar_colour)
        for row_i, (stem, base_sz, _is_neg) in enumerate(rows):
            icon = Image.open(dest / f"{stem}.png").convert("RGBA")
            for s_i, scale in enumerate(scales):
                px = base_sz * scale
                icon_s = icon.resize((px, px), Image.LANCZOS)
                x = pad + s_i * col_w + (col_w - pad - px) // 2
                y = pad + row_i * row_h + (row_h - pad - px) // 2
                band.alpha_composite(icon_s, (x, y))
        sheet.paste(band.convert("RGB"), (bar_i * canvas_w, 0))
    sheet.save(dest / "test-barres.png")


def _horizontal_lockup_group(logo_paths: str, lbbox: tuple[float, float, float, float],
                              word_group: str, ww: float, wh: float,
                              gap_ratio: float = 0.12) -> tuple[str, float, float]:
    """Compose icon (left) + wordmark (right), vertically centred. Returns
    (group_svg, total_w, total_h) in the same units as lbbox/word bbox."""
    lx0, ly0, lx1, ly1 = lbbox
    lw, lh = lx1 - lx0, ly1 - ly0
    word_scale = lh * 0.5 / wh
    ww_s, wh_s = ww * word_scale, wh * word_scale
    gap = lw * gap_ratio
    total_w = lw + gap + ww_s
    total_h = max(lh, wh_s)
    logo_y = (total_h - lh) / 2
    word_y = (total_h - wh_s) / 2
    group = (
        f'<g transform="translate({-lx0},{logo_y - ly0})">{logo_paths}</g>'
        f'<g transform="translate({lw + gap},{word_y}) scale({word_scale})">{word_group}</g>'
    )
    return group, total_w, total_h


def _publication_canvas(w: int, h: int, bg: str, lockup_group: str, lw: float, lh: float,
                         slogan_group: str | None, sw: float, sh: float,
                         max_h_ratio: float = 0.34) -> str:
    """Flat background + centred lockup (+ optional slogan below). No new
    shapes: bg is a flat full-canvas rect, everything else is composed paths."""
    margin_ratio = 0.62  # lockup width relative to canvas width (lots of empty space)
    scale = (w * margin_ratio) / lw
    max_h = h * max_h_ratio
    if lh * scale > max_h:
        scale = max_h / lh
    lockup_w, lockup_h = lw * scale, lh * scale

    parts = [f'<rect x="0" y="0" width="{w}" height="{h}" fill="{bg}"/>']

    if slogan_group is not None:
        s_scale_w = (w * 0.7) / sw
        s_scale_h = (h * 0.08) / sh
        s_scale = min(s_scale_w, s_scale_h)
        slogan_w, slogan_h = sw * s_scale, sh * s_scale
        block_h = lockup_h + h * 0.06 + slogan_h
        top = (h - block_h) / 2
        lx = (w - lockup_w) / 2
        ly = top
        parts.append(f'<g transform="translate({lx},{ly}) scale({scale})">{lockup_group}</g>')
        sx = (w - slogan_w) / 2
        sy = top + lockup_h + h * 0.06
        parts.append(f'<g transform="translate({sx},{sy}) scale({s_scale})">{slogan_group}</g>')
    else:
        lx = (w - lockup_w) / 2
        ly = (h - lockup_h) / 2
        parts.append(f'<g transform="translate({lx},{ly}) scale({scale})">{lockup_group}</g>')

    return svg_wrap("".join(parts), min_x=0, min_y=0, w=w, h=h)


PUBLICATION_SIZES = {
    "tuile": (440, 280),
    "banniere": (1400, 560),
    "github": (1280, 640),
    "partage": (1200, 630),
}

SLOGANS = {"fr": SLOGAN_FR, "en": SLOGAN_EN}


def build_publications() -> None:
    dest = OUT / "publications"
    dest.mkdir(parents=True, exist_ok=True)
    tags = load_paths()
    all_paths = "".join(tags)
    negative_with_eye = "".join(recolour(tags, NEGATIVE_MAP)) + eye_fix_group(tags)
    lbbox = full_logo_bbox(all_paths)

    bold = FONTS_SRC / "Figtree-Bold.ttf"
    semibold = FONTS_SRC / "Figtree-SemiBold.ttf"

    themes = {
        "clair": (all_paths, ANTHRACITE_SURFACE, GRIS_CLAIR, CARAMEL_LIGHT),
        "sombre": (negative_with_eye, CREME, ANTHRACITE_BG, CARAMEL_DARK),
    }

    # pre-render wordmark once per theme (colour depends on theme only)
    for theme, (logo_paths, word_colour, bg, slogan_colour) in themes.items():
        word_group, ww, wh = text_group_normalized("Coati", bold, word_colour)
        lockup_group, lw, lh = _horizontal_lockup_group(logo_paths, lbbox, word_group, ww, wh)

        for lang, slogan in SLOGANS.items():
            slogan_group, sw, sh = text_group_normalized(slogan, semibold, slogan_colour)
            for name, (w, h) in PUBLICATION_SIZES.items():
                svg = _publication_canvas(w, h, bg, lockup_group, lw, lh, slogan_group, sw, sh)
                svg_path = dest / f"{name}-{w}x{h}-{theme}-{lang}.svg"
                write_svg(svg_path, svg)
                render_png(svg_path, dest / f"{name}-{w}x{h}-{theme}-{lang}.png", w=w, h=h)

        # avatar: icon only (no wordmark), square, generous margin
        lx0, ly0, lx1, ly1 = lbbox
        icon_group = f'<g transform="translate({-lx0},{-ly0})">{logo_paths}</g>'
        icon_lw, icon_lh = lx1 - lx0, ly1 - ly0
        avatar_svg = _publication_canvas(400, 400, bg, icon_group, icon_lw, icon_lh, None, 0, 0,
                                          max_h_ratio=0.7)
        avatar_path = dest / f"avatar-400x400-{theme}.svg"
        write_svg(avatar_path, avatar_svg)
        render_png(avatar_path, dest / f"avatar-400x400-{theme}.png", size=400)


def _contrast(a: str, b: str) -> float:
    la, lb = _luminance(a), _luminance(b)
    l1, l2 = max(la, lb), min(la, lb)
    return (l1 + 0.05) / (l2 + 0.05)


# ---------------------------------------------------------------------------
# UI palette, one value per role and per THEME. "clair"/"sombre" name the
# interface theme a value serves, not its lightness: on the white light theme a
# text colour must be darker to stay readable, on the anthracite dark theme it
# must be lighter. Mirrored by the lab pairing "c1"
# (scripts/lab/fixtures/identity-pairs.js) — keep both in sync.
# ---------------------------------------------------------------------------
THEMES = {
    "clair": {
        "titre": "Thème clair",
        "fond": "#FFFFFF",
        "surface": "#F4F5F7",
        "entete": ANTHRACITE_SURFACE,
        "entete_texte": "#EDEEF0",
        "texte": ANTHRACITE_SURFACE,
        "texte_attenue": "#61646C",
        "bordure": "#8A8E96",
        "caramel": CARAMEL_LIGHT,
        "caramel_libelle": "#FFFFFF",
        "ardoise": "#4A6A88",
        "bulle_utilisateur": "#E4EAF1",
        "erreur": "#B3261E",
    },
    "sombre": {
        "titre": "Thème sombre",
        "fond": ANTHRACITE_BG,
        "surface": ANTHRACITE_SURFACE,
        "entete": ANTHRACITE_SURFACE,
        "entete_texte": "#EDEEF0",
        "texte": "#EDEEF0",
        "texte_attenue": "#A9ACB3",
        "bordure": "#777B83",
        "caramel": CARAMEL_DARK,
        "caramel_libelle": ANTHRACITE_BG,
        "ardoise": "#8AA4BE",
        "bulle_utilisateur": "#2F3B48",
        "erreur": "#F2B8B5",
    },
}

# (role, label, usage, minimum contrast against BOTH fond and surface, or None)
PALETTE_ROWS = [
    ("fond", "Fond", "fond du panneau", None),
    ("surface", "Surface", "cartes, champ de saisie, bulle de réponse", None),
    ("entete", "En-tête", "barre du haut, anthracite dans les deux thèmes", None),
    ("texte", "Texte", "texte courant", 4.5),
    ("texte_attenue", "Texte atténué", "dates, aides, états", 4.5),
    ("bordure", "Bordure", "contour des champs et des boutons", 3.0),
    ("caramel", "Caramel", "couleur primaire : bouton principal, accent, focus", 4.5),
    ("ardoise", "Bleu ardoise", "second ton : liens, états d'information", 4.5),
    ("bulle_utilisateur", "Bulle de l'utilisateur", "teinte d'ardoise très légère", None),
    ("erreur", "Erreur", "texte et icône d'erreur", 4.5),
]


def _fr(x: float) -> str:
    return f"{x:.2f}".replace(".", ",")


def _worst_contrast(theme: dict, role: str) -> float:
    return min(_contrast(theme[role], theme["fond"]), _contrast(theme[role], theme["surface"]))


def check_palette() -> list[str]:
    """Every thresholded role must clear its minimum on both fond and surface,
    plus the button label on caramel and the header text on the header."""
    problems = []
    for key, theme in THEMES.items():
        for role, label, _usage, minimum in PALETTE_ROWS:
            if minimum is not None and _worst_contrast(theme, role) < minimum:
                problems.append(f"{key}/{role}: {_worst_contrast(theme, role):.2f} < {minimum}")
        for fg, bg, minimum in (("caramel_libelle", "caramel", 4.5), ("entete_texte", "entete", 4.5),
                                ("texte", "bulle_utilisateur", 4.5)):
            ratio = _contrast(theme[fg], theme[bg])
            if ratio < minimum:
                problems.append(f"{key}/{fg} on {bg}: {ratio:.2f} < {minimum}")
    return problems


def build_palette_doc() -> None:
    problems = check_palette()
    if problems:
        raise SystemExit("palette below WCAG thresholds: " + "; ".join(problems))
    light, dark = THEMES["clair"], THEMES["sombre"]

    def cell(theme: dict, role: str, minimum) -> str:
        value = f"`{theme[role]}`"
        if minimum is None:
            return value
        return f"{value} — {_fr(_worst_contrast(theme, role))}:1"

    rows = "\n".join(
        f"| {label} | {usage} | {cell(light, role, minimum)} | {cell(dark, role, minimum)} |"
        for role, label, usage, minimum in PALETTE_ROWS
    )
    md = f"""# Coati — palette (27/09, révisée)

Couleur primaire : **caramel**, la teinte du roux du logo. Fenêtres et surfaces : **gris
anthracite**, avec des gris neutres, sans nuance beige. Second ton : **bleu ardoise**, la
couleur opposée du caramel.

**Pourquoi deux valeurs par couleur.** Chaque couleur existe en deux valeurs, une par thème de
l'interface. « Clair » et « sombre » désignent le thème, pas la teinte : sur le fond blanc du
thème clair, une couleur de texte doit être assez foncée pour se lire ; sur l'anthracite du
thème sombre, assez claire. Le caramel du thème clair est donc plus foncé que celui du thème
sombre, et c'est voulu.

Les contrastes suivent la norme WCAG : au moins 4,5:1 pour du texte, 3:1 pour le contour d'un
champ. Le chiffre donné est le plus faible des deux, sur le fond et sur la surface. Ils sont
recalculés par `scripts/brand/build-brand.py` à chaque reconstruction, qui s'arrête si l'un
passe sous son seuil. Rendu dans le vrai panneau : banc d'essai, paire `c1`
(voir les notes de design privées).

| Rôle | Usage | Thème clair | Thème sombre |
|---|---|---|---|
{rows}

Autres paires vérifiées : libellé du bouton sur le caramel ({_fr(_contrast(light['caramel_libelle'], light['caramel']))}:1 et
{_fr(_contrast(dark['caramel_libelle'], dark['caramel']))}:1), texte de l'en-tête sur l'anthracite
({_fr(_contrast(light['entete_texte'], light['entete']))}:1), texte dans la bulle de l'utilisateur
({_fr(_contrast(light['texte'], light['bulle_utilisateur']))}:1 et {_fr(_contrast(dark['texte'], dark['bulle_utilisateur']))}:1).

## Règles

- L'en-tête est anthracite dans les deux thèmes ; il prend les couleurs du thème sombre (texte
  `{dark['entete_texte']}`, caramel `{dark['caramel']}`).
- Le bleu ardoise ne sert que dans l'interface (liens, états d'information), jamais dans les
  publications, qui s'en tiennent au caramel, à l'anthracite et au gris clair `{GRIS_CLAIR}`.
- Une erreur se signale par une icône et un texte, jamais par la couleur seule.
- Le panneau lui-même n'applique pas encore cette palette : ce sera fait avec sa mise en page
  finale (phase 2 du plan d'action), sur le modèle du banc d'essai.
"""
    if not DESIGN.is_dir():
        print(f"palette.md not written: private design folder not found ({DESIGN})")
        return
    (DESIGN / "palette.md").write_text(md, encoding="utf-8")


def build_lisezmoi() -> None:
    content = """# Identité Coati — dossier `docs/logo/coati/`

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
"""
    (OUT / "LISEZMOI.md").write_text(content, encoding="utf-8")


def _font(weight: str, size: int):
    from PIL import ImageFont

    try:
        return ImageFont.truetype(str(FONTS_SRC / f"Figtree-{weight}.ttf"), size)
    except Exception:
        return ImageFont.load_default()


def _theme_panel(theme: dict, width: int):
    """One theme's palette as it is really seen: every colour on that theme's
    own background, then a small specimen of real interface elements."""
    from PIL import Image, ImageDraw

    f_title, f_label, f_small = _font("Bold", 30), _font("SemiBold", 24), _font("SemiBold", 20)
    pad, row_h, header_h, specimen_h = 32, 78, 64, 300
    height = header_h + pad + len(PALETTE_ROWS) * row_h + pad // 2 + 40 + specimen_h + pad
    img = Image.new("RGB", (width, height), theme["fond"])
    d = ImageDraw.Draw(img)

    d.rectangle([0, 0, width, header_h], fill=theme["entete"])
    d.text((pad, 14), "Coati", fill=theme["entete_texte"], font=f_title)
    d.text((pad + 120, 22), theme["titre"], fill="#B4B7BE", font=f_small)

    y = header_h + pad
    sw_w, sw_h = 132, 56
    for role, label, usage, minimum in PALETTE_ROWS:
        colour = theme[role]
        d.rounded_rectangle([pad, y, pad + sw_w, y + sw_h], radius=10, fill=colour,
                            outline=theme["bordure"], width=1)
        d.text((pad + sw_w + 24, y + 2), f"{label}   {colour}", fill=theme["texte"], font=f_label)
        detail = usage if minimum is None else f"{usage} · contraste {_fr(_worst_contrast(theme, role))}:1"
        d.text((pad + sw_w + 24, y + 32), detail, fill=theme["texte_attenue"], font=f_small)
        y += row_h

    y += pad // 2
    d.text((pad, y), "En situation", fill=theme["texte"], font=f_label)
    y += 40
    d.rounded_rectangle([pad, y, width - pad, y + specimen_h - 20], radius=12,
                        fill=theme["surface"], outline=theme["bordure"], width=1)
    cx, cy = pad + 24, y + 20
    d.text((cx, cy), "Texte courant de la réponse.", fill=theme["texte"], font=f_label)
    d.text((cx, cy + 36), "Texte atténué : il y a 2 minutes", fill=theme["texte_attenue"], font=f_small)
    link = "Mes prompts"
    d.text((cx, cy + 70), link, fill=theme["ardoise"], font=f_label)
    d.line([cx, cy + 101, cx + d.textlength(link, font=f_label), cy + 101], fill=theme["ardoise"], width=2)
    d.text((cx, cy + 116), "Erreur : le programme local ne répond pas", fill=theme["erreur"], font=f_small)
    button = "Résumer cette page"
    bx, by = cx, cy + 160
    bw = d.textlength(button, font=f_label) + 48
    d.rounded_rectangle([bx, by, bx + bw, by + 52], radius=10, fill=theme["caramel"])
    d.text((bx + 24, by + 11), button, fill=theme["caramel_libelle"], font=f_label)
    bubble = "Peux-tu résumer cet article ?"
    ubw = d.textlength(bubble, font=f_small) + 40
    ux = width - pad - 24 - ubw
    d.rounded_rectangle([ux, by, ux + ubw, by + 52], radius=14, fill=theme["bulle_utilisateur"])
    d.text((ux + 20, by + 14), bubble, fill=theme["texte"], font=f_small)
    return img


def build_recap_sheet() -> None:
    from PIL import Image, ImageDraw

    if not DESIGN.is_dir():
        print(f"recap sheet skipped: private design folder not found ({DESIGN})")
        return
    identite_dir = DESIGN / "identite"
    identite_dir.mkdir(parents=True, exist_ok=True)
    mot, icones, pubs = OUT / "mot", OUT / "icones", OUT / "publications"

    W, pad, gap = 2200, 48, 40
    f_h1, f_h2, f_txt = _font("ExtraBold", 44), _font("Bold", 30), _font("SemiBold", 22)
    ink, muted, frame = ANTHRACITE_SURFACE, THEMES["clair"]["texte_attenue"], "#D0D3D8"
    sheet = Image.new("RGB", (W, 8000), "#FFFFFF")
    d = ImageDraw.Draw(sheet)
    y = pad
    d.text((pad, y), "Identité Coati", fill=ink, font=f_h1)
    y += 64
    d.text((pad, y), "État du 27/09. Les versions pour fond sombre et les icônes de barre d'outils "
                     "attendent un dessin Kling (dernière section).", fill=muted, font=f_txt)
    y += 60

    def section(title: str) -> None:
        nonlocal y
        d.text((pad, y), title, fill=ink, font=f_h2)
        y += 50

    def framed(img, x: int, top: int) -> None:
        sheet.paste(img, (x, top))
        d.rectangle([x - 1, top - 1, x + img.width, top + img.height], outline=frame, width=1)

    section("Palette : chaque couleur en deux valeurs, une par thème")
    panel_w = (W - 2 * pad - gap) // 2
    panels = [_theme_panel(THEMES["clair"], panel_w), _theme_panel(THEMES["sombre"], panel_w)]
    for i, panel in enumerate(panels):
        framed(panel, pad + i * (panel_w + gap), y)
    y += max(p.height for p in panels) + gap

    section("Dans le vrai panneau (banc d'essai, paire c1)")
    capture = identite_dir / "c1-coati.png"
    if capture.exists():
        from PIL import ImageChops

        img = Image.open(capture).convert("RGB")
        # The board is wider than its content: trim the white margin first.
        bbox = ImageChops.difference(img, Image.new("RGB", img.size, "#FFFFFF")).getbbox()
        if bbox:
            img = img.crop((max(0, bbox[0] - 24), max(0, bbox[1] - 24),
                            min(img.width, bbox[2] + 24), min(img.height, bbox[3] + 24)))
        img.thumbnail((W - 2 * pad, 1500))
        framed(img, pad, y)
        y += img.height + gap
    else:
        d.text((pad, y), "Capture absente : node scripts/lab/capture-identity.mjs c1",
               fill=THEMES["clair"]["erreur"], font=f_txt)
        y += 40 + gap

    section("Logo et nom, fond clair")
    x, row_bottom = pad, y
    for stem, label, box in (("coati-horizontal-clair", "assemblage horizontal", (620, 300)),
                             ("coati-vertical-clair", "assemblage vertical", (300, 300)),
                             ("coati-logotype-caramel", "logotype caramel", (380, 150))):
        img = Image.open(mot / f"{stem}.png").convert("RGBA")
        img.thumbnail(box)
        flat = Image.new("RGBA", (img.width + 48, img.height + 48), "#FFFFFF")
        flat.alpha_composite(img, (24, 24))
        framed(flat.convert("RGB"), x, y)
        d.text((x, y + flat.height + 8), label, fill=muted, font=f_txt)
        row_bottom = max(row_bottom, y + flat.height + 44)
        x += flat.width + 60
    y = row_bottom + gap

    section("Publications, fond clair")
    x, row_bottom = pad, y
    for stem in ("banniere-1400x560-clair-fr", "partage-1200x630-clair-en",
                 "github-1280x640-clair-fr", "tuile-440x280-clair-fr"):
        path = pubs / f"{stem}.png"
        if not path.exists():
            continue
        img = Image.open(path).convert("RGB")
        img.thumbnail((1030, 420))
        if x + img.width > W - pad:
            x, y = pad, row_bottom
        framed(img, x, y)
        d.text((x, y + img.height + 8), stem, fill=muted, font=f_txt)
        row_bottom = max(row_bottom, y + img.height + 48)
        x += img.width + gap
    y = row_bottom + gap

    section("En attente du dessin Kling")
    for line in ("Logo pour fond sombre, sans contour : la fourrure brune directement contre l'anthracite.",
                 "Ensuite ses assemblages, ses publications et l'icône Firefox des thèmes sombres.",
                 "Icône de barre d'outils simplifiée : la tête seule, lisible à 16 et 32 px.",
                 "Version à une seule couleur : celle obtenue par seuil de luminosité perd le visage."):
        d.text((pad, y), "•  " + line, fill=ink, font=f_txt)
        y += 36
    y += pad
    sheet.crop((0, 0, W, y)).save(identite_dir / "planche-finale.png")


if __name__ == "__main__":
    main()
