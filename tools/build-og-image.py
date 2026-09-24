#!/usr/bin/env python3
"""
build-og-image.py — single source of truth for the STATIC social card.

Renders og-image.png (1200x630), the card that X/Twitter, iMessage, Slack,
Discord, LinkedIn and Facebook show when someone links exspacetrash.com.

WHY THIS FILE EXISTS
--------------------
Until now the card was produced from an orphaned og-image.svg that nothing
rendered and nothing checked. When the price changed, the card did not, and
the stale "$1.99" shipped for weeks. See README, "The social card".

The rule this file enforces structurally: THIS IS COLD-TRAFFIC SURFACE.
The card must never carry a price, in any form. A visitor meeting the product
for the first time in a timeline has not been sold yet — the number belongs on
certificate-app.html, one page deeper. See README, "Pricing is revealed in the
funnel, not on the homepage".

Rendered with Pillow (not SVG) because the card is built from real raster
assets — the actual certificate artwork and the actual die-cut character
stickers — which rsvg-convert cannot load from a referenced href.

Usage:
    python3 tools/build-og-image.py            # writes og-image.png
    python3 tools/build-og-image.py --preview  # also writes a 600px proof
"""

import os
import sys
import zipfile
import numpy as np
from PIL import Image, ImageDraw, ImageFont, ImageFilter

# --------------------------------------------------------------------------
# paths
# --------------------------------------------------------------------------
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def P(*parts):
    return os.path.join(ROOT, *parts)


OUT = P('og-image.png')

# --------------------------------------------------------------------------
# canvas + brand palette
#
# Colours are lifted from index.html so the card and the page a cold visitor
# lands on are the same surface: dark navy field, cyan accent, cream type.
# --------------------------------------------------------------------------
W, H = 1200, 630

BG_CORE = (38, 62, 102)      # #263e66  radial centre
BG_MID = (16, 27, 51)        # #101b33
BG_EDGE = (9, 16, 31)        # #09101f
CYAN = (112, 240, 227)       # #70f0e3
CREAM = (255, 248, 232)      # #fff8e8
SUB = (138, 180, 248)        # soft blue subline

# Fonts. index.html asks for Inter; Inter is not installed in this sandbox and
# the card is a raster file, so we render with the closest available grotesque.
# Both faces are metric-similar enough at display sizes.
FONT_BOLD = '/usr/share/fonts/truetype/noto/NotoSans-Bold.ttf'
FONT_REG = '/usr/share/fonts/truetype/noto/NotoSans-Regular.ttf'

# --------------------------------------------------------------------------
# the copy that appears on the card.
#
# Read from tools/og-image-copy.json so the guard and the renderer agree by
# construction: tests/check-og-image.mjs asserts the same file carries no
# price and that the rendered card actually contains these lines.
#
# NOTE FOR EVERYONE: no currency symbol may appear in this JSON. The card is
# cold-traffic surface — a shop window, not a shelf. See README.
# --------------------------------------------------------------------------
import json

COPY = json.load(open(P('tools/og-image-copy.json'), encoding='utf-8'))
BRAND = COPY['brand']
HEADLINE = COPY['headline']
SUBLINE = COPY['subline']

# --------------------------------------------------------------------------
# layout
#
# Characters ring the certificate and overlap its edges, so the eye reads
# "certificate with the cast around it" rather than "picture, then some
# stickers". The certificate's own centre stays clear for the same reason.
#
# Each entry: (asset, centre_x, centre_y, drawn_height)
# --------------------------------------------------------------------------
CERT_SRC = P('assets/certs/cert-sample-b.png')
CERT_CROP = (148, 30, 884, 758)   # trim the starfield, keep the light frame
CERT_CX, CERT_CY, CERT_H = 600, 350, 434

# The die-cut sticker artwork ships in the committed pack
# assets/stickers/sticker-pack-png.zip. We read straight out of that archive
# (preferring an unpacked copy when one exists), so the card is reproducible
# from the repository alone with no untracked scratch files.
CHARACTERS = [
    ('01-robot-blocker.png',    292, 352, 232),   # left, overlapping the edge
    ('04-telescope.png',        912, 346, 232),   # right, mirror balance
    ('03-trash-can.png',        388, 532, 146),   # lower left
    ('05-stop-button.png',      848, 536, 146),   # lower right
]


STICKER_PACK = P('assets/stickers/sticker-pack-png.zip')


def load_character(name):
    """Return a die-cut character as RGBA, from disk or the committed pack."""
    for cand in (P('assets/characters/stickers', name),
                 P('assets/characters', name)):
        if os.path.isfile(cand):
            return Image.open(cand).convert('RGBA')
    if os.path.isfile(STICKER_PACK):
        with zipfile.ZipFile(STICKER_PACK) as z:
            for member in z.namelist():
                if os.path.basename(member) == name:
                    with z.open(member) as fh:
                        return Image.open(fh).convert('RGBA')
    return None


# --------------------------------------------------------------------------
# helpers
# --------------------------------------------------------------------------
def background():
    """Homepage radial gradient plus a scatter of stars."""
    yy, xx = np.mgrid[0:H, 0:W].astype(np.float32)
    cx, cy = W * 0.5, 0.0
    d = np.sqrt(((xx - cx) / (W * 0.52)) ** 2 + ((yy - cy) / (H * 0.92)) ** 2)
    d = np.clip(d, 0.0, 1.0)

    a = np.array(BG_CORE, np.float32)
    b = np.array(BG_MID, np.float32)
    c = np.array(BG_EDGE, np.float32)
    stop = 0.53
    t1 = np.clip(d / stop, 0, 1)[..., None]
    t2 = np.clip((d - stop) / (1 - stop), 0, 1)[..., None]
    img = a * (1 - t1) + b * t1
    img = img * (1 - t2) + c * t2

    rng = np.random.default_rng(20240918)   # fixed seed: the card is reproducible
    field = np.zeros((H, W), np.float32)
    for _ in range(150):
        sx, sy = rng.integers(0, W), rng.integers(0, H)
        r = rng.integers(1, 3)
        y0, y1 = max(0, sy - r), min(H, sy + r + 1)
        x0, x1 = max(0, sx - r), min(W, sx + r + 1)
        field[y0:y1, x0:x1] = rng.uniform(0.25, 0.85)
    field = np.array(Image.fromarray((field * 255).astype(np.uint8)).filter(
        ImageFilter.GaussianBlur(0.4)), np.float32) / 255.0
    img = img + field[..., None] * np.array((225, 232, 255), np.float32) * 0.9
    return Image.fromarray(np.clip(img, 0, 255).astype(np.uint8), 'RGB')


def glow(base, cx, cy, rx, ry, colour, strength):
    """Soft radial wash, used to lift the certificate off the field."""
    layer = Image.new('RGB', (W, H), (0, 0, 0))
    d = ImageDraw.Draw(layer)
    steps = 46
    for i in range(steps, 0, -1):
        t = i / steps
        box = [cx - rx * t, cy - ry * t, cx + rx * t, cy + ry * t]
        d.ellipse(box, fill=tuple(int(v * strength * (1 - t) ** 1.6) for v in colour))
    layer = layer.filter(ImageFilter.GaussianBlur(34))
    return Image.fromarray(
        np.clip(np.array(base, np.int16) + np.array(layer, np.int16), 0, 255)
        .astype(np.uint8), 'RGB')


def drop_shadow(base, sprite, x, y, blur=18, opacity=150):
    """Composite a sprite onto base with a soft drop shadow at (x, y)."""
    alpha = sprite.getchannel('A')
    sh = Image.new('RGBA', (W, H), (0, 0, 0, 0))
    sh.paste(Image.new('RGBA', sprite.size, (0, 0, 0, opacity)), (x + 4, y + 8), alpha)
    sh = sh.filter(ImageFilter.GaussianBlur(blur))
    out = Image.alpha_composite(base.convert('RGBA'), sh)
    out.paste(sprite, (x, y), sprite)
    return out


def fit_font(text, max_w, start, path, tracking=0.0):
    """Largest size at which `text` (with tracking) fits inside max_w."""
    size = start
    while size > 8:
        f = ImageFont.truetype(path, size)
        w = tracking_func_width(text, f, size * tracking)
        if w <= max_w:
            return f, size
        size -= 1
    return ImageFont.truetype(path, 8), 8


def _char_width(font, ch, track):
    try:
        return font.getlength(ch)
    except AttributeError:
        return font.getsize(ch)[0]


def tracking_func_width(text, font, track):
    return sum(_char_width(font, ch, track) + track for ch in text) - (track if text else 0)


def draw_center_tracked(draw, cy, text, font, fill, track, cx=W / 2, anchor_middle=True):
    """Draw `text` centred at cx with letter-spacing, vertically centred at cy."""
    total = tracking_func_width(text, font, track)
    x = cx - total / 2 if anchor_middle else cx
    asc, desc = font.getmetrics()
    y = cy - (asc + desc) / 2
    for ch in text:
        draw.text((x, y), ch, font=font, fill=fill)
        x += _char_width(font, ch, track) + track


# --------------------------------------------------------------------------
# compose
# --------------------------------------------------------------------------
def build():
    card = background()

    # cyan halo behind the certificate
    card = glow(card, CERT_CX, CERT_CY - 10, 470, 330, CYAN, 0.18)

    # --- certificate, dead centre -----------------------------------------
    cert = Image.open(CERT_SRC).convert('RGBA').crop(CERT_CROP)
    cw = int(round(CERT_H * cert.size[0] / cert.size[1]))
    cert = cert.resize((cw, CERT_H), Image.LANCZOS)
    cert_x = int(round(CERT_CX - cw / 2))
    cert_y = int(round(CERT_CY - CERT_H / 2))
    card = drop_shadow(card, cert, cert_x, cert_y, blur=26, opacity=165)

    # --- the cast, overlapping the edges ----------------------------------
    for name, ccx, ccy, ch in CHARACTERS:
        spr = load_character(name)
        if spr is None:
            print(f'  ! missing character {name} — skipped', file=sys.stderr)
            continue
        cwid = int(round(ch * spr.size[0] / spr.size[1]))
        spr = spr.resize((cwid, ch), Image.LANCZOS)
        card = drop_shadow(card, spr, int(round(ccx - cwid / 2)),
                           int(round(ccy - ch / 2)), blur=16, opacity=140)

    # --- type -------------------------------------------------------------
    d = ImageDraw.Draw(card)

    f_brand = ImageFont.truetype(FONT_BOLD, 22)
    draw_center_tracked(d, 46, BRAND, f_brand, CYAN, 6.0)

    f_head, size = fit_font(HEADLINE, W - 150, 44, FONT_BOLD, tracking=0.5)
    draw_center_tracked(d, 96, HEADLINE, f_head, CREAM, size * 0.012)

    f_sub = ImageFont.truetype(FONT_BOLD, 23)
    draw_center_tracked(d, 131, SUBLINE, f_sub, SUB, 1.5)

    # --- brand frame: the same hairline cyan border the page family uses ---
    overlay = Image.new('RGBA', (W, H), (0, 0, 0, 0))
    od = ImageDraw.Draw(overlay)
    od.rounded_rectangle([16, 16, W - 17, H - 17], radius=12,
                         outline=(112, 240, 227, 120), width=3)
    card = Image.alpha_composite(card.convert('RGBA'), overlay).convert('RGB')

    return card


def main():
    card = build()

    # Social crawlers fetch this on every unfurl, so size matters: a straight
    # RGB save is ~635 KB. The artwork is a flat illustration palette, so a
    # 256-colour quantisation is visually indistinguishable (verified against
    # the full-RGB render at 2x on both the certificate and the gradient) and
    # lands at ~220 KB. Dithering keeps the die-cut characters smooth.
    card.quantize(colors=256, method=Image.MEDIANCUT,
                  dither=Image.FLOYDSTEINBERG).save(OUT, 'PNG', optimize=True)

    kb = os.path.getsize(OUT) / 1024
    print(f'wrote {OUT}  {card.size[0]}x{card.size[1]}  {kb:,.0f} KB')

    if '--preview' in sys.argv:
        prev = '/tmp/og-preview.png'
        card.resize((W // 2, H // 2), Image.LANCZOS).save(prev)
        print(f'wrote {prev}')


if __name__ == '__main__':
    main()
