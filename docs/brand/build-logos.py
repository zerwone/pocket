"""Builds the marks and horizontal logos for pocket and staked.
Wordmarks are IBM Plex Sans Medium converted to outlines, so the SVGs need no font."""
import os, sys
from fontTools.ttLib import TTFont
from fontTools.pens.svgPathPen import SVGPathPen
from fontTools.pens.transformPen import TransformPen
from fontTools.pens.boundsPen import BoundsPen

HERE = os.path.dirname(os.path.abspath(__file__))
FONT = os.path.join(HERE, 'node_modules/@fontsource/ibm-plex-sans/files/ibm-plex-sans-latin-500-normal.woff2')
OUT = sys.argv[1] if len(sys.argv) > 1 else os.path.join(HERE, 'out')

INK = {'light': '#181818', 'dark': '#F4F4F2'}
ACC = {'light': '#2457D6', 'dark': '#8BAEFF'}

# 24-unit marks, ~2-unit strokes. Geometry matched to the GPT-made PNGs (pixel diff < 25 px at 512).
MARKS = {
    'pocket': lambda c: (
        f'<path d="M4 8v9a4 4 0 0 0 4 4h8a4 4 0 0 0 4-4V8" fill="none" stroke="{c}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>'
        f'<rect x="12" y="2" width="4" height="10" fill="{c}"/>'
    ),
    'staked': lambda c: (
        ''.join(f'<path d="M{x} 3v18" fill="none" stroke="{c}" stroke-width="2" stroke-linecap="round"/>' for x in (3, 9, 15, 21))
        + f'<rect x="10.8" y="10" width="2.4" height="4" fill="{c}"/>'
    ),
}

font = TTFont(FONT)
gs = font.getGlyphSet()
cmap = font.getBestCmap()
upm = font['head'].unitsPerEm


def wordmark(text, size):
    """Outlined path for `text` at font size `size`, baseline y=0, plus its advance width."""
    scale = size / upm
    pen = SVGPathPen(gs)
    x = 0
    for ch in text:
        g = cmap[ord(ch)]
        tp = TransformPen(pen, (scale, 0, 0, -scale, x, 0))
        gs[g].draw(tp)
        x += gs[g].width * scale
    return pen.getCommands(), x


def mark_svg(name, theme, size=24):
    return (f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="{size}" height="{size}">'
            f'<title>{name}</title>{MARKS[name](ACC[theme])}</svg>\n')


def mono_mark_svg(name, color):
    return f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><title>{name}</title>{MARKS[name](color)}</svg>\n'


def logo_svg(name, theme):
    W, H = 360, 96
    mark_px = 56                    # mark drawn at 56px inside the 96px height
    mark_x, mark_y = 8, (H - mark_px) / 2
    size = 54                       # wordmark font size
    path, adv = wordmark(name, size)
    # vertically centre lowercase x-height on the mark
    xh = font['OS/2'].sxHeight * size / upm
    base_y = H / 2 + xh / 2
    text_x = mark_x + mark_px + 18
    width = text_x + adv + 8
    s = mark_px / 24
    return (f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {width:.0f} {H}" width="{width:.0f}" height="{H}">'
            f'<title>{name}</title>'
            f'<g transform="translate({mark_x} {mark_y}) scale({s})">{MARKS[name](ACC[theme])}</g>'
            f'<path transform="translate({text_x:.2f} {base_y:.2f})" fill="{INK[theme]}" d="{path}"/>'
            f'</svg>\n')


def favicon_svg(name):
    light, dark = ACC['light'], ACC['dark']
    body = MARKS[name]('currentColor')
    return (f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24">'
            f'<style>svg{{color:{light}}}@media (prefers-color-scheme:dark){{svg{{color:{dark}}}}}</style>'
            f'{body.replace("fill=\"currentColor\"", "fill=\"currentColor\"")}</svg>\n')


if __name__ == '__main__':
    for name in MARKS:
        d = os.path.join(OUT, name)
        os.makedirs(d, exist_ok=True)
        files = {
            'logo-on-light.svg': logo_svg(name, 'light'),
            'logo-on-dark.svg': logo_svg(name, 'dark'),
            'mark.svg': mark_svg(name, 'light'),
            'mark-on-dark.svg': mark_svg(name, 'dark'),
            'mark-black.svg': mono_mark_svg(name, '#000000'),
            'mark-white.svg': mono_mark_svg(name, '#FFFFFF'),
            'favicon.svg': favicon_svg(name),
        }
        for f, c in files.items():
            open(os.path.join(d, f), 'w').write(c)
        print(name, ', '.join(files))
