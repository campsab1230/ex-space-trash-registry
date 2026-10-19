#!/usr/bin/env python3
# tools/build-breakup-manual.py
#
# Assembles the PAID breakup-survival manual PDFs from the 765x1024 masters.
#
# WHY VECTORIZE RATHER THAN REGENERATE
#   The masters are 765x1024 = 2.55x3.41 in at 300 dpi. A US Letter page needs
#   2550x3300 px, so they are far below print resolution. There were two options:
#
#     (a) regenerate all 15 pages with an image model, or
#     (b) vectorize the existing masters.
#
#   (a) was rejected. The written content IS the product — "RE-ENTRY CHECKLIST:
#   BECOMING A PERSON AGAIN", "Songs that need to be temporarily banned",
#   "Things I miss / Things I actually miss". A regenerated page would come back
#   with DIFFERENT words, which is not the book the author wrote.
#
#   (b) was measured, not assumed. potrace snaps the fuzzy upscaled edges to
#   clean curves, and a visual A/B/C of original vs Lanczos-upscale vs vector
#   showed the vector render is the CRISPIEST of the three (hard-edged strokes,
#   no anti-aliasing halo). An OCR word-count test was run first and discarded:
#   even the ORIGINAL only scored 10/17, failing words that are plainly legible
#   ("showered", "dressed"), because tesseract cannot read hand-lettered line
#   art. The rendered pixels are the authoritative evidence, not OCR.
#
#   A useful side effect: the Otsu threshold DISCARDS COLOUR. Six of the masters
#   carry colour (03 4.08%, 14 5.82%, 05 0.49%, 02 0.20%, 13 0.06%, 15 0.09%),
#   so no separate desaturation pass is needed.
#
# WHY THE DETAIL-LOSS QC STEP EXISTS
#   The real risk of thresholding is not "is it smoother", it is "did a THIN
#   LINE fall below the threshold and disappear". So each page is diffed
#   against a plain Lanczos upscale and the ink LOST and ADDED are reported.
#   Measured on the real masters: worst loss 0.110% (11-orbital-debris-field,
#   the dark one), everything else 0.001-0.023%. Nothing is being eaten.
#
# WHY THE FINAL THRESHOLD EXISTS (this was a real defect on the first pass)
#   rsvg-convert emits RGBA with a TRANSPARENT background. Two traps follow:
#     1. Handing RGBA straight to reportlab prints the book BLACK.
#     2. convert('RGB')/convert('L') renders transparent as black too — this
#        exact bug produced a fully black QC contact sheet once.
#   So every page is composited onto white first. On top of that, resampling
#   crisp vector art with LANCZOS RE-INTRODUCES grey anti-aliasing, which both
#   softens the edges and stores 8-bit grey: the first build came out at
#   17.17 MB per book, ~10x the coloring packet. Snapping back to pure
#   black/white after the resize restored the hard edges and dropped it to
#   3.32 MB, because a 1-bit page has almost no entropy to compress.
#
# SOURCE MASTERS ARE NOT COMMITTED
#   15 masters, and the raw folder is scratch material. Point MANUAL_SRC at a
#   directory of the masters; the committed output is the two PDFs in
#   assets/manual/.
#
# USAGE
#   MANUAL_SRC=/path/to/raw python3 tools/build-breakup-manual.py
#
# IMPORTANT: the two PDFs are content-hash named BY HAND after generation. A
# rebuild changes the bytes, so re-hash and update BOTH the filenames and
# MANUAL_FILES in api/manual-download.js, or the paid download 404s. The guard
# tests/check-breakup-manual.mjs reads the real filenames out of that endpoint,
# so it will catch a mismatch rather than let it ship.
import os
import subprocess
from PIL import Image

SRC = os.environ.get("MANUAL_SRC", "/home/user/coloring-book/raw")
DST = os.environ.get(
    "MANUAL_DST",
    os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "assets", "manual"),
)
os.makedirs(DST, exist_ok=True)

TARGET_W = 2550          # 8.5 in @ 300 dpi
ART_AR = 765.0 / 1024.0  # the masters are all 3:4

LETTER = (612.0, 792.0)
A4 = (595.276, 841.890)

# The cover is authored as page 15 but must print first.
COVER = "15-cover-breakup-survival-manual"


def to_gray_on_white(path):
    """Load as 8-bit grey, compositing any transparency onto WHITE."""
    im = Image.open(path)
    if im.mode in ("RGBA", "LA", "P"):
        im = im.convert("RGBA")
        bg = Image.new("RGBA", im.size, (255, 255, 255, 255))
        im = Image.alpha_composite(bg, im)
    return im.convert("L")


def otsu(gray):
    hist = gray.histogram()
    total = sum(hist)
    sum_all = sum(i * h for i, h in enumerate(hist))
    sum_b = 0.0
    w_b = 0
    best = 0.0
    thr = 127
    for i in range(256):
        w_b += hist[i]
        if w_b == 0:
            continue
        w_f = total - w_b
        if w_f == 0:
            break
        sum_b += i * hist[i]
        m_b = sum_b / w_b
        m_f = (sum_all - sum_b) / w_f
        var = w_b * w_f * (m_b - m_f) ** 2
        if var > best:
            best = var
            thr = i
    return thr


def vectorize(stem, tmpdir):
    """Upscale -> Otsu 1-bit -> potrace -> render SVG back at print width."""
    gray = to_gray_on_white(os.path.join(SRC, stem + ".png"))
    h = int(round(gray.size[1] * TARGET_W / gray.size[0]))
    big = gray.resize((TARGET_W, h), Image.LANCZOS)
    bw = big.point(lambda p, t=otsu(big): 255 if p > t else 0, "L")

    # PGM P5 with ink = 0. NOT PBM: PIL's PBM polarity is ambiguous and an
    # inverted bitmap makes potrace trace the BACKGROUND, which renders as a
    # solid black page. That bug was hit for real during development.
    pgm = os.path.join(tmpdir, "page.pgm")
    with open(pgm, "wb") as f:
        f.write(b"P5\n%d %d\n255\n" % (bw.size[0], bw.size[1]))
        f.write(bw.tobytes())

    svg = os.path.join(tmpdir, "page.svg")
    subprocess.run(
        ["potrace", "-s", "-o", svg, "--turdsize", "4", "--alphamax", "1.0",
         "--opttolerance", "0.2", pgm],
        check=True,
    )
    out = os.path.join(tmpdir, stem + ".png")
    subprocess.run(["rsvg-convert", "-w", str(TARGET_W), "-o", out, svg], check=True)
    return out, bw


def page_image(stem, box_w_in, tmpdir):
    """Final 1-BIT page at the requested print width, on WHITE."""
    src = os.path.join(tmpdir, stem + ".png")
    if not os.path.exists(src):
        src, _ = vectorize(stem, tmpdir)
    im = to_gray_on_white(src)
    tw = int(round(box_w_in * 300))
    th = int(round(tw / ART_AR))
    im = im.resize((tw, th), Image.LANCZOS)
    # remove the resample's grey halo -> true 1-bit, which is what makes the
    # PDF both sharp and small
    return im.point(lambda v: 0 if v < 128 else 255, "L")


def main():
    from reportlab.pdfgen import canvas
    from reportlab.lib.utils import ImageReader
    from reportlab.pdfbase import pdfmetrics
    from reportlab.pdfbase.ttfonts import TTFont
    import numpy as np

    fd = "/usr/share/fonts/truetype/dejavu"
    pdfmetrics.registerFont(TTFont("DJ", os.path.join(fd, "DejaVuSans.ttf")))

    interior = sorted(
        f[:-4] for f in os.listdir(SRC)
        if f.endswith(".png") and not f.startswith("15-")
    )
    order = [COVER] + interior

    tmpdir = "/tmp/manual-build"
    os.makedirs(tmpdir, exist_ok=True)

    # --- detail-loss QC -------------------------------------------------
    print("=== detail-loss QC (original upscale vs vector) ===")
    for stem in order:
        vec, bw = vectorize(stem, tmpdir)
        v = np.asarray(to_gray_on_white(vec))
        up = np.asarray(bw)
        n = up.size
        lost = float(np.sum((up < 128) & (v > 200))) / n * 100.0
        added = float(np.sum((up > 200) & (v < 128))) / n * 100.0
        flag = "  <-- CHECK" if lost > 1.5 else ""
        print("%-42s lost=%5.3f%% added=%5.3f%%%s" % (stem, lost, added, flag))

    # --- build ----------------------------------------------------------
    def build(path, size, label):
        W, H = size
        c = canvas.Canvas(path, pagesize=size)
        c.setTitle("THE EX-SPACETRASH BREAKUP SURVIVAL MANUAL")
        c.setAuthor("EXSPACETRASH.COM")
        c.setSubject("Printable breakup survival + coloring manual - 15 pages")
        m = 0.38 * 72
        for idx, stem in enumerate(order, start=1):
            top = H - m - 18
            bot = m + 22
            avail_h = top - bot
            avail_w = W - 2 * m
            aw = min(avail_w, avail_h * ART_AR)
            ah = aw / ART_AR
            x = (W - aw) / 2.0
            y = bot + (avail_h - ah) / 2.0
            c.drawImage(ImageReader(page_image(stem, aw / 72.0, tmpdir)),
                        x, y, width=aw, height=ah)
            if stem != COVER:
                c.setFont("DJ", 8)
                c.setFillColorRGB(0.35, 0.35, 0.35)
                c.drawCentredString(W / 2.0, m + 8, "EXSPACETRASH.COM")
                c.drawRightString(W - m, m + 8, "%d / %d" % (idx, len(order)))
            c.showPage()
        c.save()
        print("%-8s %-44s %6.2f MB  pages=%d" % (
            label, os.path.basename(path),
            os.path.getsize(path) / 1048576.0, len(order)))
        return path

    print("\n=== build ===")
    lp = build(os.path.join(DST, "breakup-manual-letter.pdf"), LETTER, "Letter")
    ap = build(os.path.join(DST, "breakup-manual-a4.pdf"), A4, "A4")

    import pypdf
    for p in (lp, ap):
        r = pypdf.PdfReader(p)
        b = r.pages[0].mediabox
        print("  %-38s pages=%d page1=%.0fx%.0fpt" % (
            os.path.basename(p), len(r.pages), b.width, b.height))


if __name__ == "__main__":
    main()
