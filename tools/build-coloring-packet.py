#!/usr/bin/env python3
# tools/build-coloring-packet.py
#
# Assembles the PAID coloring packet PDFs from the generated page masters.
#
# WHAT THIS DOES
#   1. resamples each page to the exact print width (300 dpi)
#   2. thresholds it to 1-BIT with Otsu, so the PDF contains pure black and
#      white with no grey, no anti-aliasing halo and no halftone
#   3. draws the title, the rule, the footer and the page number as VECTOR
#      text with ReportLab (never baked into the image, so they stay crisp)
#   4. writes a US Letter and an A4 edition
#
# WHY THRESHOLD RATHER THAN SHIP THE GENERATED PNGs AS-IS
#   Generated art arrives with soft edges. Printed, that reads as grey fuzz
#   around every line and wastes toner. A 1-bit page prints as clean line art,
#   which is what a coloring page is supposed to be.
#
# SOURCE PAGES ARE NOT COMMITTED
#   12 masters at 3584x4800 are ~7 MB each (~84 MB), which does not belong in
#   git. Point COLORING_SRC at a directory of numbered masters named
#   00-cover.png and 01-*.png .. 12-*.png (see TITLES for the expected set).
#   The committed output is the two PDFs in assets/coloring/.
#
# USAGE
#   python3 tools/build-coloring-packet.py
#   COLORING_SRC=/path/to/masters python3 tools/build-coloring-packet.py
#
# IMPORTANT: the two PDFs are content-hash named BY HAND after generation. A
# rebuild changes the bytes, so re-hash and update BOTH the filenames and
# PACKET_FILES in api/coloring-download.js, or the paid download 404s. The
# guard tests/check-coloring-packet.mjs reads the real filenames out of that
# endpoint, so it will catch a mismatch rather than let it ship.
from PIL import Image
from reportlab.pdfgen import canvas
from reportlab.lib.utils import ImageReader
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont
import numpy as np
import os

SRC = os.environ.get("COLORING_SRC", "/tmp/cbook/gen")
DST = os.environ.get("COLORING_DST", os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "assets", "coloring"))
os.makedirs(DST, exist_ok=True)

FD = '/usr/share/fonts/truetype/dejavu'
pdfmetrics.registerFont(TTFont('DJB', os.path.join(FD, 'DejaVuSans-Bold.ttf')))
pdfmetrics.registerFont(TTFont('DJ', os.path.join(FD, 'DejaVuSans.ttf')))

LETTER = (612.0, 792.0)
A4 = (595.276, 841.890)

TITLES = {
    '01-junkfield': 'THE JUNK FIELD',
    '02-mission-control': 'MISSION CONTROL',
    '03-launch-pad': 'LIFT-OFF',
    '04-spacewalk': 'SPACEWALK',
    '05-alien-moon': 'THE NEIGHBORS',
    '06-moonscape': 'BOOTPRINTS',
    '07-planet-parade': 'THE NEIGHBORHOOD',
    '08-radio-telescope': 'LISTENING STATION',
    '09-space-station': 'THE OUTPOST',
    '10-comet-asteroids': 'COMETS & STRAYS',
    '11-cockpit': 'THE COCKPIT',
    '12-goodbye-porthole': 'LAST LOOK BACK',
}


def otsu(a):
    h = np.bincount(a.ravel(), minlength=256).astype(np.float64)
    tot = a.size
    st = float(np.dot(np.arange(256), h))
    sB = wB = 0.0
    best = 0.0
    thr = 128
    for i in range(256):
        wB += h[i]
        if wB == 0:
            continue
        wF = tot - wB
        if wF == 0:
            break
        sB += i * h[i]
        var = wB * wF * ((sB / wB) - ((st - sB) / wF)) ** 2
        if var > best:
            best = var
            thr = i
    return thr


def prep(name, target_w_in, dpi=300):
    """Load a source page, resample, threshold to pure 1-bit, return ImageReader + size."""
    p = os.path.join(SRC, name + '.png')
    im = Image.open(p).convert('L')
    tw = int(round(target_w_in * dpi))
    th = int(round(tw * 4 / 3.0))
    im = im.resize((tw, th), Image.LANCZOS)
    a = np.asarray(im)
    bw = im.point(lambda v, t=otsu(a): 0 if v < t else 255).convert('L')
    return ImageReader(bw), bw.size


def interior(c, name, title, idx, total, W, H):
    m = 0.52 * 72
    # vector title band
    c.setFillColorRGB(0, 0, 0)
    c.setFont('DJB', 19)
    c.drawCentredString(W / 2.0, H - m - 16, title)
    c.setLineWidth(1.1)
    c.line(W / 2.0 - 92, H - m - 26, W / 2.0 + 92, H - m - 26)

    top_of_art = H - m - 40
    bot_of_art = m + 26
    avail_h = top_of_art - bot_of_art
    avail_w = W - 2 * m
    aw = min(avail_w, avail_h * 3 / 4.0)
    ah = aw * 4 / 3.0

    reader, px = prep(name, aw / 72.0)
    x = (W - aw) / 2.0
    y = bot_of_art + (avail_h - ah) / 2.0
    c.drawImage(reader, x, y, width=aw, height=ah)

    c.setFont('DJ', 8.5)
    c.setFillColorRGB(0.35, 0.35, 0.35)
    c.drawCentredString(W / 2.0, m + 8, 'EXSPACETRASH.COM')
    c.drawRightString(W - m, m + 8, '%d / %d' % (idx, total))


def cover(c, W, H):
    m = 0.55 * 72
    aw = min(W - 2 * m, 4.55 * 72)
    ah = aw * 4 / 3.0
    reader, px = prep('00-cover', aw / 72.0)
    c.drawImage(reader, (W - aw) / 2.0, H - m - ah, width=aw, height=ah)

    y = H - m - ah - 34
    c.setFillColorRGB(0, 0, 0)
    c.setFont('DJB', 34)
    c.drawCentredString(W / 2.0, y, 'EXSPACETRASH')
    y -= 26
    c.setFont('DJB', 20)
    c.drawCentredString(W / 2.0, y, 'COLORING PACKET')
    y -= 22
    c.setLineWidth(1.3)
    c.line(W / 2.0 - 120, y, W / 2.0 + 120, y)
    y -= 20
    c.setFont('DJ', 11.5)
    c.setFillColorRGB(0.25, 0.25, 0.25)
    c.drawCentredString(W / 2.0, y, '12 PAGES TO FILL IN')
    c.showPage()


def build(path, size, label):
    W, H = size
    c = canvas.Canvas(path, pagesize=size)
    c.setTitle('EXSPACETRASH COLORING PACKET')
    c.setAuthor('EXSPACETRASH.COM')
    c.setSubject('Printable coloring packet - 12 pages')
    cover(c, W, H)
    names = sorted(TITLES)
    for i, n in enumerate(names, start=1):
        interior(c, n, TITLES[n], i, len(names), W, H)
        c.showPage()
    c.save()
    print('%-8s %-46s %6.2f MB' % (label, os.path.basename(path),
                                   os.path.getsize(path) / 1048576.0))
    return path


print('building...')
lp = build(os.path.join(DST, 'coloring-packet-letter.pdf'), LETTER, 'Letter')
ap = build(os.path.join(DST, 'coloring-packet-a4.pdf'), A4, 'A4')

# verify with an independent reader
import pypdf
for p in (lp, ap):
    r = pypdf.PdfReader(p)
    b = r.pages[0].mediabox
    print('  %-34s pages=%d  page1=%.0fx%.0f pt' %
          (os.path.basename(p), len(r.pages), b.width, b.height))
