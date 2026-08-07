#!/usr/bin/env python3
"""Cape contrast: p95/p50 of luminance over the cape pixels ONLY.

WHY THIS NUMBER. The cape is a mirror and the reference photograph is a mirror
in a light tent. What separates the two is not colour, not albedo and not
roughness — it is CONTRAST WITHIN ONE SURFACE. The reference skirt runs from
near-black in its creases to blown white on its ribs; a satin version of the
same geometry runs from mid-grey to slightly-lighter-mid-grey. Divide the 95th
percentile by the median and you get one scalar that says which of those two you
are looking at, and it is almost immune to exposure: doubling the brightness of
everything leaves the ratio unchanged. That is exactly the property you want
when the thing under test is the lighting.

MEASURED ON THE REFERENCE, four different windows inside the skirt of
docs/reference-rear.png:

    (430,680,830,960)   p05  43   p50  97.3   p95 219.0   ratio 2.252
    (400,690,860,1010)  p05  44   p50 102.6   p95 238.6   ratio 2.326
    (440,700,820,1000)  p05  42   p50  93.0   p95 209.4   ratio 2.252
    (380,680,880,1030)  p05  45   p50 111.5   p95 240.0   ratio 2.153

so the target is 2.15-2.33 and the commonly quoted 2.28 sits inside it. The
spread across window choice is +-4%, which is the honest precision of this
metric — a change of 0.05 is noise, a change of 0.3 is real.

THE MASK IS NOT A RECTANGLE. It cannot be: the skirt is a bell with a scalloped
hem, the pavé sleeves overlap its top corners and the boots overlap its bottom.
Any rectangle big enough to be representative also contains pavé, which is the
brightest thing in the frame and would dominate p95 all by itself. So the mask
comes from a render: tools/capture.mjs pose `env-back-mask` flips mesh `cape` to
an unlit green and shoots it from the `env-back` camera. See that pose for the
three ways of doing this that do NOT work.

The mask is STATIC. Lighting changes do not move a masked pixel; only cape
geometry or a camera move would, and neither is in src/mat/'s remit. Re-shoot it
if either changes:

    node tools/capture.mjs --only env-back-mask --out shots/base
    python3 src/mat/cape.py --rebuild-mask

Usage:
    python3 src/mat/cape.py --rebuild-mask
    python3 src/mat/cape.py shots/env-back.png [more.png ...]
    python3 src/mat/cape.py --ref            # print the reference windows
"""
import sys
import os
import numpy as np
from PIL import Image

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
MASK_SHOT = os.path.join(ROOT, 'shots', 'base', 'env-back-mask.png')
MASK = os.path.join(ROOT, 'shots', 'base', 'cape-mask.png')
REF = os.path.join(ROOT, 'docs', 'reference-rear.png')

# Reference skirt windows, all four of them, so the target is quoted as a range
# rather than as one suspiciously precise number.
REF_WINDOWS = [(430, 680, 830, 960), (400, 690, 860, 1010),
               (440, 700, 820, 1000), (380, 680, 880, 1030)]


def lum(path):
    a = np.asarray(Image.open(path).convert('RGB')).astype(np.float64)
    return 0.2126 * a[:, :, 0] + 0.7152 * a[:, :, 1] + 0.0722 * a[:, :, 2]


def erode(m, n):
    """Shrink a boolean mask by n pixels, 4-connected.

    The cape is bounded on every side by something brighter or darker than it —
    gold trim, pavé, black floor — and a screenshot is antialiased, so the outer
    ring of "cape" pixels is really a blend with the neighbour. Two pixels of
    erosion is the difference between measuring the cape and measuring its
    outline against the hall.
    """
    for _ in range(n):
        m = (m & np.roll(m, 1, 0) & np.roll(m, -1, 0)
             & np.roll(m, 1, 1) & np.roll(m, -1, 1))
    return m


def rebuild_mask():
    a = np.asarray(Image.open(MASK_SHOT).convert('RGB')).astype(int)
    R, G, B = a[:, :, 0], a[:, :, 1], a[:, :, 2]
    # DIFFERENCE, not ratio. A ratio test (G > 1.6*R) threw away 60% of the
    # cape: the bloom pass bleeds the surroundings back into R and B, so a
    # solidly green pixel reads (159, 229, 76) — unmistakably green to the eye
    # and only 1.44x on the ratio. The resulting mask was a handful of stripes
    # along the flute ridges, which is a biased sample of exactly the pixels the
    # metric is about.
    m = (G > 90) & (G - np.maximum(R, B) > 45)
    m = erode(m, 2)
    Image.fromarray((m * 255).astype('uint8')).save(MASK)
    ys, xs = np.nonzero(m)
    print(f'{MASK}: {m.sum()} px, bbox x {xs.min()}..{xs.max()} y {ys.min()}..{ys.max()}')


def stats(path, m):
    L = lum(path)
    if L.shape != m.shape:
        raise SystemExit(f'{path}: {L.shape} does not match mask {m.shape}')
    v = L[m]
    p = lambda q: float(np.percentile(v, q))
    p50, p95 = p(50), p(95)
    full = L.ravel()
    print(f'{os.path.relpath(path, ROOT)}')
    print(f'  cape  n {v.size:6d}  p05 {p(5):5.1f}  p25 {p(25):5.1f}  '
          f'p50 {p50:5.1f}  p75 {p(75):5.1f}  p95 {p95:5.1f}  max {v.max():5.1f}')
    print(f'  cape  P95/P50 {p95 / max(p50, 1e-6):5.3f}   '
          f'(reference 2.15-2.33)   <32 {100.0 * (v < 32).mean():5.2f}%  '
          f'>240 {100.0 * (v > 240).mean():5.2f}%')
    print(f'  frame mean {full.mean():6.2f}  p50 {np.percentile(full, 50):6.2f}  '
          f'p95 {np.percentile(full, 95):6.2f}')


if __name__ == '__main__':
    args = [a for a in sys.argv[1:] if not a.startswith('--')]
    if '--rebuild-mask' in sys.argv:
        rebuild_mask()
    if '--ref' in sys.argv:
        L = lum(REF)
        for (x0, y0, x1, y1) in REF_WINDOWS:
            v = L[y0:y1, x0:x1].ravel()
            a, b = np.percentile(v, 50), np.percentile(v, 95)
            print(f'  ref {x0},{y0},{x1},{y1}  p50 {a:6.1f}  p95 {b:6.1f}  '
                  f'ratio {b / a:5.3f}')
    if args:
        m = np.asarray(Image.open(MASK).convert('L')) > 127
        for p in args:
            stats(p, m)
