#!/usr/bin/env python3
# /// script
# requires-python = ">=3.11"
# dependencies = ["Pillow"]
# ///
"""Generate favicon.png and favicon.ico with a speech-bubble icon."""

from PIL import Image, ImageDraw
import struct, io, os

OUT_DIR = os.path.dirname(os.path.abspath(__file__))

# ── colours ────────────────────────────────────────────────────────────────
BG      = (0, 0, 0, 0)          # transparent
BUBBLE1 = (59, 130, 246, 255)   # blue-500 (primary bubble)
BUBBLE2 = (99, 102, 241, 255)   # indigo-500 (secondary bubble)
WHITE   = (255, 255, 255, 255)

def draw_bubble(draw, x, y, w, h, r, fill):
    """Rounded-rectangle speech bubble pointing bottom-left."""
    draw.rounded_rectangle([x, y, x + w, y + h], radius=r, fill=fill)
    # small triangle tail pointing bottom-left
    tail = [(x + r, y + h), (x, y + h + r * 2), (x + r * 3, y + h)]
    draw.polygon(tail, fill=fill)

def make_icon(size):
    img = Image.new("RGBA", (size, size), BG)
    d   = ImageDraw.Draw(img)

    s = size / 64  # scale factor (design at 64 px)

    # back bubble (indigo, slightly right/down)
    bx, by = int(22 * s), int(14 * s)
    bw, bh = int(36 * s), int(28 * s)
    br      = int(8  * s)
    draw_bubble(d, bx, by, bw, bh, br, BUBBLE2)

    # front bubble (blue, top-left)
    fx, fy = int(6 * s),  int(6  * s)
    fw, fh = int(36 * s), int(28 * s)
    fr      = int(8  * s)
    draw_bubble(d, fx, fy, fw, fh, fr, BUBBLE1)

    # three dots in the front bubble
    dot_r = max(int(3 * s), 2)
    cy    = int(fy + fh / 2)
    for cx in [int(fx + fw * 0.25),
               int(fx + fw * 0.50),
               int(fx + fw * 0.75)]:
        d.ellipse([cx - dot_r, cy - dot_r, cx + dot_r, cy + dot_r], fill=WHITE)

    return img

# ── favicon.png (256×256) ───────────────────────────────────────────────────
img256 = make_icon(256)
img256.save(os.path.join(OUT_DIR, "favicon.png"))
print("wrote favicon.png")

# ── favicon.ico (multi-size: 16, 32, 48) ───────────────────────────────────
sizes = [16, 32, 48]

def img_to_png_bytes(img):
    buf = io.BytesIO()
    img.save(buf, format="PNG")
    return buf.getvalue()

images = [(sz, img_to_png_bytes(make_icon(sz))) for sz in sizes]

# ICO format: header + directory + image data
n = len(images)
header = struct.pack("<HHH", 0, 1, n)   # reserved, type=1 (ICO), count
dir_offset = 6 + n * 16
offsets = []
pos = dir_offset
for _, data in images:
    offsets.append(pos)
    pos += len(data)

directory = b""
for (sz, data), off in zip(images, offsets):
    w = h = 0 if sz >= 256 else sz      # 0 means 256
    directory += struct.pack("<BBBBHHII", w, h, 0, 0, 1, 32, len(data), off)

ico_path = os.path.join(OUT_DIR, "favicon.ico")
with open(ico_path, "wb") as f:
    f.write(header + directory)
    for _, data in images:
        f.write(data)
print("wrote favicon.ico")
