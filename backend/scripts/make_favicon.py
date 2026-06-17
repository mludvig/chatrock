#!/usr/bin/env python3
# /// script
# requires-python = ">=3.11"
# dependencies = ["Pillow", "cairosvg"]
# ///
"""Generate favicon.svg, favicon.png, favicon.ico from the faComments FA icon."""

import io, os, struct
import cairosvg
from PIL import Image

OUT_DIR = os.path.dirname(os.path.abspath(__file__))

# faComments path from @fortawesome/free-solid-svg-icons
FA_WIDTH  = 576
FA_HEIGHT = 512
FA_PATH   = (
    "M384 144c0 97.2-86 176-192 176-26.7 0-52.1-5-75.2-14L35.2 349.2"
    "c-9.3 4.9-20.7 3.2-28.2-4.2s-9.2-18.9-4.2-28.2l35.6-67.2"
    "C14.3 220.2 0 183.6 0 144 0 46.8 86-32 192-32S384 46.8 384 144z"
    "m0 368c-94.1 0-172.4-62.1-188.8-144"
    " 120-1.5 224.3-86.9 235.8-202.7"
    " 83.3 19.2 145 88.3 145 170.7"
    " 0 39.6-14.3 76.2-38.4 105.6l35.6 67.2"
    "c4.9 9.3 3.2 20.7-4.2 28.2s-18.9 9.2-28.2 4.2"
    "L459.2 498c-23.1 9-48.5 14-75.2 14z"
)

# White background + gradient speech bubbles (matches app theme)
SVG_TEMPLATE = """\
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">
  <defs>
    <linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0%"   stop-color="#3b82f6"/>
      <stop offset="100%" stop-color="#6366f1"/>
    </linearGradient>
  </defs>
  <!-- white rounded square background -->
  <rect width="100" height="100" rx="22" ry="22" fill="white"/>
  <!-- faComments icon in gradient, centred with ~10px padding -->
  <g transform="translate(10,12) scale({sx},{sy})">
    <path d="{path}" fill="url(#g)"/>
  </g>
</svg>
""".format(
    sx=round(80 / FA_WIDTH, 6),
    sy=round(76 / FA_HEIGHT, 6),
    path=FA_PATH,
)

# ── favicon.svg ─────────────────────────────────────────────────────────────
svg_path = os.path.join(OUT_DIR, "favicon.svg")
with open(svg_path, "w") as f:
    f.write(SVG_TEMPLATE)
print("wrote favicon.svg")

# ── favicon.png (256×256) ───────────────────────────────────────────────────
png256 = cairosvg.svg2png(bytestring=SVG_TEMPLATE.encode(), output_width=256, output_height=256)
png_path = os.path.join(OUT_DIR, "favicon.png")
with open(png_path, "wb") as f:
    f.write(png256)
print("wrote favicon.png")

# ── favicon.ico (16, 32, 48 px PNGs packed in ICO container) ─────────────────
sizes = [16, 32, 48]

def to_png_bytes(size):
    return cairosvg.svg2png(bytestring=SVG_TEMPLATE.encode(), output_width=size, output_height=size)

images = [(sz, to_png_bytes(sz)) for sz in sizes]

n = len(images)
header    = struct.pack("<HHH", 0, 1, n)
dir_start = 6 + n * 16
pos = dir_start
offsets = []
for _, data in images:
    offsets.append(pos)
    pos += len(data)

directory = b""
for (sz, data), off in zip(images, offsets):
    w = h = 0 if sz >= 256 else sz
    directory += struct.pack("<BBBBHHII", w, h, 0, 0, 1, 32, len(data), off)

ico_path = os.path.join(OUT_DIR, "favicon.ico")
with open(ico_path, "wb") as f:
    f.write(header + directory)
    for _, data in images:
        f.write(data)
print("wrote favicon.ico")
