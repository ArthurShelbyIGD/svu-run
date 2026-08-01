#!/usr/bin/env python3
"""Luminance histogram of a rendered frame.

The critic's judgement of this build was made with a histogram rather than an
opinion: max luminance 248, p95 138, 0.00% of pixels above 240, mean 78. That
is a frame with no highlight and no black — the measurable form of "flat matt
grey". This script is how that claim gets re-checked after every change, so
"there is specular now" is never a matter of taste.

Target for a jewellery frame: ~1-2% above 250, ~5% below 15.

    python3 src/mat/hist.py shots/hero.png [shots/char-face.png ...]
"""
import sys
from PIL import Image


def stats(path):
    im = Image.open(path).convert('RGB')
    px = list(im.getdata())
    lum = sorted(int(0.2126 * r + 0.7152 * g + 0.0722 * b) for r, g, b in px)
    n = len(lum)

    def pct(p):
        return lum[min(n - 1, int(n * p))]

    above = lambda v: 100.0 * sum(1 for x in lum if x > v) / n
    below = lambda v: 100.0 * sum(1 for x in lum if x < v) / n
    print(f"{path}")
    print(f"  mean {sum(lum)/n:6.1f}   max {lum[-1]:3d}   min {lum[0]:3d}")
    print(f"  p05 {pct(.05):3d}  p25 {pct(.25):3d}  p50 {pct(.50):3d}  "
          f"p75 {pct(.75):3d}  p95 {pct(.95):3d}  p99 {pct(.99):3d}")
    print(f"  >250 {above(250):5.2f}%   >240 {above(240):5.2f}%   "
          f"<15 {below(15):5.2f}%   <32 {below(32):5.2f}%")


for p in sys.argv[1:]:
    stats(p)
