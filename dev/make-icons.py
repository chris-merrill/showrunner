#!/usr/bin/env python3
"""Draw the Showrunner mark (a clapperboard on a yellow rounded square) at the
sizes Chrome wants. Run: dev/.venv/bin/python dev/make-icons.py"""
import os
from PIL import Image, ImageDraw

YELLOW = (255, 229, 0, 255)
INK = (17, 17, 17, 255)
OUT = os.path.join(os.path.dirname(__file__), "..", "icons")


def draw(size):
    S = 16  # supersample for clean edges
    W = size * S
    img = Image.new("RGBA", (W, W), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    d.rounded_rectangle((0, 0, W - 1, W - 1), radius=int(W * 0.22), fill=YELLOW)

    u = W / 24  # work in a 24-unit grid like the SVG mark
    # body
    d.rounded_rectangle((4 * u, 11 * u, 20 * u, 20 * u), radius=int(1.2 * u), fill=INK)
    # top strip, tilted open
    strip = [(3.6 * u, 10.2 * u), (19.2 * u, 5.0 * u), (20.2 * u, 8.0 * u), (4.6 * u, 13.2 * u)]
    d.polygon(strip, fill=INK)
    # stripes on the strip (yellow gaps)
    for t in (0.33, 0.62):
        x0 = strip[0][0] + (strip[1][0] - strip[0][0]) * t
        y0 = strip[0][1] + (strip[1][1] - strip[0][1]) * t
        x1 = strip[3][0] + (strip[2][0] - strip[3][0]) * t
        y1 = strip[3][1] + (strip[2][1] - strip[3][1]) * t
        d.line((x0, y0, x1, y1), fill=YELLOW, width=int(1.1 * u))
    return img.resize((size, size), Image.LANCZOS)


os.makedirs(OUT, exist_ok=True)
for s in (16, 32, 48, 128, 512):
    draw(s).save(os.path.join(OUT, f"icon-{s}.png"))
    print("icon", s)
