// The studio environment — a jeweller's light box, rendered into a cubemap.
//
// WHY THIS FILE EXISTS SEPARATELY. An independent critic measured the shipped
// frame instead of describing it: max luminance 248, p95 138, exactly 0.00% of
// pixels above 240, mean 78. No highlight, no black, everything crushed into
// one hazy mid-band. That is the numeric form of "a flat matt grey thing", and
// almost none of it was the materials' fault. Every metal in this game is a
// mirror, and a mirror has no appearance of its own — only the appearance of
// what it reflects. The old cubemap was a soft, evenly-lit dome whose brightest
// structure was a broad horizon smear, so every polished surface reflected a
// mid-grey wash. The materials were faithfully reproducing a grey room.
//
// The rule this file is built on:
//
//   VALUE SWING IS THE MATERIAL. Jewellery photography is a small area of
//   clipped white sitting directly against near-black. If the environment
//   contains nothing that reaches white and nothing that falls to black, no
//   material parameter anywhere can produce either.
//
// So the room now has:
//
//   a near-black shell        the default state of the room is DARK. Ambient
//                             lifted off zero only enough to stop dead facets.
//   four softbox panels       hard-edged rectangles in azimuth and elevation.
//                             A rectangle is the signature of a photographed
//                             object: curved metal reflects it as a straight-
//                             sided bright band with a crisp edge, which is
//                             what "product shot" looks like. A gaussian blob
//                             reflects as a soft smear, which is what "grey
//                             plastic" looks like.
//   a hard key                small angular size (about 6 degrees) at very
//                             high radiance. Small + bright is what clips to
//                             255 on a polished surface. Large + dim is what
//                             the old map had everywhere.
//   a thin horizon slot       a few degrees tall, not the 30-degree gradient
//                             smear it replaced. Draws one clean specular line
//                             across every curved surface.
//   a light tent              many small sources over the full sphere so each
//                             pavé facet catches SOMETHING. Without this the
//                             suit renders black — that failure is documented
//                             in pave.js and it is real.
//   floor and ceiling bounce  broad, dim, warm below and cool above, so a
//                             surface facing nowhere in particular still has a
//                             direction to its light.
//
// DYNAMIC RANGE. Stored RGBA16F where the GPU can filter it. The key is 260x
// the ambient shell. In 8 bits that ratio does not exist: a 260x key and a 1.2x
// bounce both store as 255 and reflect identically, which is precisely how a
// room full of lights ends up rendering as uniform haze.

import { toHalf } from './tex.js';

// DIRECTION PROBE. Set to true, `npm run build`, then
//
//     node tools/capture.mjs --only env-back-nodir --out shots/probe
//
// and the room becomes a uniform sphere whose colour ENCODES ITS OWN
// DIRECTION, while that pose zeroes the analytic lights. Every metal surface in
// the resulting frame is then a false-colour map of WHERE IT LOOKS. Red is +x,
// green is up, blue is +z — down the corridor, ahead of the runner.
//
// This is the most useful thing in this file and it exists because reasoning
// was wrong twice in one afternoon:
//
//   * A hand-built model of the fluted bell (src/mat/envstat.mjs --cape)
//     predicted the skirt reflects the forward quarters at azimuth 45 and 135.
//     Two hot cards went exactly there and the cape's environment-only
//     histogram did not move by one count.
//   * The reason it did not move is that the cape was receiving NO environment
//     light at all — see the long roughness note in polished(). The probe is
//     what showed that: pavé, floor, columns and boots all lit up in false
//     colour and the cape was a black hole in the middle of them.
//
// Guessing where a mirror looks is the same class of mistake as guessing what
// it looks like. The branch folds away at build time while this is false.
const PROBE = 0;

const clamp01 = (x) => (x < 0 ? 0 : x > 1 ? 1 : x);
const smooth = (a, b, x) => {
  const t = clamp01((x - a) / (b - a));
  return t * t * (3 - 2 * t);
};

/**
 * Build the six cube faces of the studio environment.
 *
 * @param size  face resolution
 * @param hdr   true if the target texture is half-float
 * @returns array of six typed arrays, +X -X +Y -Y +Z -Z
 */
export function buildStudioEnvFaces(size, hdr) {
  const faces = [];
  const px = size * size * 4;

  // Point sources: [x, y, z, angular radius, radiance, warmth]
  //
  // Radiance values are absurd by design. A 6-degree source at 260 is what a
  // real studio strobe looks like next to its own softbox, and it is the only
  // thing in the room that can put a genuinely clipped white pixel on a curved
  // polished surface. Everything else here is under 30.
  const lights = [
    [ 0.52,  0.74,  0.42, 0.105, 240,  0.05],   // HARD KEY, high front-left
    [ 0.14,  0.40, -0.94, 0.130,  70, -0.06],   // hard rim from behind, cool
    [-0.74,  0.30,  0.34, 0.240,   7, -0.04],   // soft fill, low left
    [-0.22,  0.95, -0.18, 0.075,  90,  0.02],   // hot pin overhead
    [ 0.86, -0.30,  0.30, 0.180,   5,  0.06],   // warm kicker from below right
  ];

  // A jeweller's light tent: many small sources over the FULL sphere. A pavé
  // stone tilted downward reflects what is below it, and with an upper-
  // hemisphere-only tent that is darkness — which once rendered the whole suit
  // black while the smooth face beside it lit correctly.
  //
  // TENT FLUX IS THE HAZE. This is the tuning that matters most in the file and
  // it was found by looking, not by reasoning. The first version of this room
  // used 48 sources at radius 0.030 and radiance 26; the pavé sparkled, and
  // every SMOOTH surface in the game — the face, the mitten hands, the wing —
  // went flat pale and evenly lit, because a rough-ish surface integrates the
  // tent into exactly the uniform mid-grey wash this file exists to remove. The
  // total flux of the tent is what a smooth surface sees. Its PER-SOURCE
  // radiance is what a near-mirror stone sees. So: fewer, smaller, hotter.
  // Total flux down by about two thirds, per-source radiance up by three.
  const TENT = 30;
  for (let i = 0; i < TENT; i++) {
    const t = (i + 0.5) / TENT;
    const y = 1 - 2 * t;
    const r = Math.sqrt(Math.max(0, 1 - y * y));
    const theta = i * 2.39996;                       // golden angle
    lights.push([
      r * Math.cos(theta),
      y * 0.92,
      r * Math.sin(theta),
      0.017,                                          // small: a sparkle, not a wash
      y > -0.15 ? 62 : 20,
      (i % 3 === 0) ? 0.05 : -0.02,
    ]);
  }

  // RESOLUTION-AWARE SOURCE SIZE. This is not a nicety, it is a correctness fix
  // found by capturing the low preset instead of assuming it matched. A tent
  // source of 0.017 rad is about one degree wide; the low preset's cube faces
  // are 64x64, where one texel already spans about 1.4 degrees, so the entire
  // light tent fell between the samples and simply did not exist. The pavé
  // renders from that tent, and on low it came out charcoal while the same
  // material at 256 sparkled. Any source smaller than a couple of texels is
  // widened to that size and its radiance dropped by the square of the same
  // ratio, which keeps its total flux — and therefore the surface's brightness —
  // identical across all three presets.
  const minRad = 2.2 / size;
  for (const L of lights) {
    const n = Math.hypot(L[0], L[1], L[2]);
    L[0] /= n; L[1] /= n; L[2] /= n;
    if (L[3] < minRad) {
      L[4] *= (L[3] / minRad) * (L[3] / minRad);
      L[3] = minRad;
    }
  }

  // Softbox PANELS, as rectangles in (azimuth, elevation) rather than discs.
  // [azimuth radians, half-width in azimuth, low dy, high dy, radiance, warmth]
  //
  // NARROW AND HOT, NOT WIDE AND BRIGHT. Three tunings were needed to find this
  // and both failures were instructive. At half-width 0.15 and radiance 34 the
  // game's polished columns rendered as floor-to-ceiling tubes of pure white: a
  // cylinder reflects a wide swathe of the room, so a wide panel fills the whole
  // shape. Dropping the radiance to 10 fixed the columns and took every
  // highlight in the frame with it — back to 0.01% of pixels above 250, which is
  // the flat grey the whole rebuild exists to escape. The answer is not radiance
  // and it is not solid angle, it is the RATIO: a strip three degrees wide at 46
  // puts a hot, hard-edged vertical streak down one side of a column and leaves
  // the rest of it near-black. That streak is what a photograph of a metal
  // cylinder looks like, and it is the single most recognisable signal of
  // "photographed jewellery" available for the price of one dot product.
  //
  // Their RADIANCE, though, has to stay near 10 and not near 46. A strip is an
  // AREA source: a mirror-finish cylinder reflects a whole one somewhere on its
  // curve no matter which way it faces, so at 46 every column in the game
  // rendered as a tube of blown white wearing a bloom halo. The rule that came
  // out of it: area sources set the level a mirror sits at and must stay near
  // the clipping point, while POINT sources — the 240x key below, the tent —
  // are what actually punch through it, because they land on a handful of
  // pixels rather than on a whole shape.
  const panels = [
    // azimuth, half-width, low dy, high dy, radiance, warmth
    [ 0.60, 0.055, -0.30, 0.88, 11,  0.05],   // key-side strip, tall and hot
    [ 1.35, 0.030, -0.10, 0.60,  4,  0.02],
    [ 2.30, 0.045, -0.20, 0.74,  5, -0.04],
    [ 3.55, 0.050, -0.34, 0.82,  7, -0.05],   // back-left, the rim strip
    [ 4.30, 0.028, -0.05, 0.55,  3,  0.03],
    [ 5.05, 0.035, -0.16, 0.68, 3.5, 0.03],
  ];
  const panelDir = panels.map((p) => [Math.cos(p[0]), Math.sin(p[0])]);

  for (let f = 0; f < 6; f++) {
    const data = hdr ? new Uint16Array(px) : new Uint8Array(px);
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const u = (2 * (x + 0.5)) / size - 1;
        const v = 1 - (2 * (y + 0.5)) / size;
        let dx, dy, dz;
        switch (f) {
          case 0: dx =  1; dy =  v; dz = -u; break; // +X
          case 1: dx = -1; dy =  v; dz =  u; break; // -X
          case 2: dx =  u; dy =  1; dz = -v; break; // +Y
          case 3: dx =  u; dy = -1; dz =  v; break; // -Y
          case 4: dx =  u; dy =  v; dz =  1; break; // +Z
          default: dx = -u; dy = v; dz = -1;        // -Z
        }
        const inv = 1 / Math.hypot(dx, dy, dz);
        dx *= inv; dy *= inv; dz *= inv;

        if (PROBE) {
          const o2 = (y * size + x) * 4;
          const K = 3.0;   // bright enough to read through the tone map, not so
                           // bright that every channel clips to white
          let pr, pg, pb;
          if (PROBE === 2) {
            // ELEVATION BANDS AS HUES. The smooth version above is prettier and
            // harder to read: recovering an angle from it means inverting the
            // tone map, which is not something you can do from a PNG. HUE
            // survives a neutral tone map, so seven saturated bands at one
            // radiance decode by eye and by `python3 src/mat/cape.py --probe`
            // with no calibration at all.
            //   red zenith, orange, yellow, GREEN AT THE HORIZON, cyan, blue,
            //   magenta nadir.
            const t = dy;
            const c = t >= 0.70 ? [1, 0, 0]
                    : t >= 0.35 ? [1, 0.5, 0]
                    : t >= 0.05 ? [1, 1, 0]
                    : t >= -0.05 ? [0, 1, 0]
                    : t >= -0.35 ? [0, 1, 1]
                    : t >= -0.70 ? [0, 0.35, 1]
                    : [1, 0, 1];
            pr = K * c[0]; pg = K * c[1]; pb = K * c[2];
          } else {
            pr = K * (0.5 + 0.5 * dx);
            pg = K * (0.5 + 0.5 * dy);
            pb = K * (0.5 + 0.5 * dz);
          }
          if (hdr) {
            data[o2] = toHalf(pr); data[o2 + 1] = toHalf(pg);
            data[o2 + 2] = toHalf(pb); data[o2 + 3] = 0x3c00;
          } else {
            data[o2] = Math.min(255, pr * 60) | 0;
            data[o2 + 1] = Math.min(255, pg * 60) | 0;
            data[o2 + 2] = Math.min(255, pb * 60) | 0;
            data[o2 + 3] = 255;
          }
          continue;
        }

        // --- the dark shell ------------------------------------------------
        // Six times darker than the map this replaces. The old floor of 0.07
        // rising to 0.20 was, after the per-zone environmentIntensity of ~1.9
        // that world/ applies on top, a 0.4 grey wash reflected by every metal
        // in the game from every angle. That wash IS the haze in the histogram.
        // It is not lifted to zero, though: a facet that reflects exactly black
        // is a dead facet, and pavé is mostly facets pointing away from the key.
        const up = dy * 0.5 + 0.5;
        let r = 0.011 + up * 0.030;
        let g = 0.012 + up * 0.034;
        let b = 0.016 + up * 0.044;

        // Warm bounce off the floor of the box, cool spill off the ceiling.
        const down = Math.max(0, -dy);
        r += down * 0.052; g += down * 0.036; b += down * 0.020;
        const ceil = Math.max(0, dy);
        r += ceil * ceil * 0.030; g += ceil * ceil * 0.034; b += ceil * ceil * 0.042;

        // --- the horizon slot ----------------------------------------------
        // Narrow. The previous version was exp(-|dy|*13) — visible over about
        // 30 degrees of elevation, which is a gradient, not a light. At 46 it
        // is a few degrees tall: one clean bright line that a curved polished
        // surface draws as a straight streak, exactly like a strip light in a
        // photograph.
        const slot = Math.exp(-Math.abs(dy) * 52.0) * 2.5;
        r += slot; g += slot * 0.985; b += slot * 0.94;

        // --- softbox panels ------------------------------------------------
        // Hard-edged rectangles. The edge is smoothed over roughly a degree,
        // which after the environment's own mip filtering is as sharp as it can
        // usefully be, and reads as a panel with a rim rather than a glow.
        const hLen = Math.sqrt(dx * dx + dz * dz);
        if (hLen > 1e-4) {
          const ax = dx / hLen, az = dz / hLen;
          for (let i = 0; i < panels.length; i++) {
            const P = panels[i];
            const D = panelDir[i];
            const c = ax * D[0] + az * D[1];
            if (c < 0.55) continue;
            // angular distance from the panel's centre azimuth
            const da = Math.acos(Math.min(1, c));
            const wA = 1 - smooth(P[1] * 0.86, P[1], da);
            if (wA <= 0) continue;
            const span = P[3] - P[2];
            const wE = smooth(P[2] - span * 0.05, P[2] + span * 0.05, dy)
                     * (1 - smooth(P[3] - span * 0.05, P[3] + span * 0.05, dy));
            const s = wA * wE * P[4];
            if (s <= 0) continue;
            r += s * (1 + P[5]); g += s; b += s * (1 - P[5]);
          }
        }

        // --- THE CEILING CARD ----------------------------------------------
        // The big white card of the light tent, and the only part of this room
        // the cape can actually see.
        //
        // WHERE IT GOES WAS MEASURED, and every guess before the measurement
        // was wrong. Set PROBE = 2 at the top of this file and shoot
        // `--only env-back-nodir`: the room becomes seven saturated hue bands
        // by elevation and every mirror in the frame reports which band it is
        // looking at. The skirt came back ORANGE with RED down the flute
        // valleys and a thread of yellow along its top hem — elevation 20 to 45
        // degrees over most of its area, 45 to 90 in the valleys, almost
        // nothing at the horizon and NOTHING AT ALL below it. The cape is
        // looking at the ceiling. Not at the room behind the runner (the
        // intuitive answer), and not at the forward quarters (the answer a
        // hand-built model of the bell gave, which was tested with two hot
        // cards there and moved the histogram by zero).
        //
        // That is also why this had to be a new feature and not a tweak.
        // Everything bright in this room was already either at the horizon (the
        // slot), in a vertical strip (the panels, which do span this elevation
        // but are three degrees wide), or a point (the key, the pin, the ring).
        // Between them the band from 15 to 75 degrees was bare shell, and the
        // shell is 0.04. A mirror pointed there renders black: 48% of the
        // cape's pixels below luminance 32, against 2% in the reference.
        //
        // MODULATED, NOT UNIFORM. A uniform dome here would lift the median and
        // flatten the swing in the same stroke — it is exactly the "broad
        // horizon smear" this file exists to delete, moved 40 degrees up. So
        // the tent is cut into hard-edged cards with real gaps, and a flute
        // crossing a card edge draws the light-against-dark boundary that makes
        // a mirror read as a mirror. The gap is NOT black: a light tent has no
        // black in it, and the reference skirt's creases sit at about a fifth
        // of its ribs rather than at zero.
        {
          const CEIL_LO = 0.26, CEIL_HI = 0.99;   // dy, i.e. sin(elevation)
          const CARDS = 5, DUTY = 0.56;
          const GAP_L = 0.150, CARD_L = 0.445;
          const band = smooth(CEIL_LO, CEIL_LO + 0.07, dy)
                     * (1 - smooth(CEIL_HI - 0.10, CEIL_HI, dy));
          if (band > 0) {
            const azm = Math.atan2(dz, dx);
            const ph = ((azm / (Math.PI * 2)) * CARDS + 8) % 1;
            // hard edge, smoothed over 3% of a card so it survives mip filtering
            const on = smooth(0, 0.03, ph) * (1 - smooth(DUTY - 0.03, DUTY, ph));
            const s = band * (GAP_L + (CARD_L - GAP_L) * on);
            r += s * 0.99; g += s; b += s * 1.05;   // cool, like a daylight card
          }
        }

        // --- overhead ring -------------------------------------------------
        // An annulus about 35 degrees off vertical: a defined circular
        // catchlight on every dome in the game — eyes, orb, boots, hands.
        const ring = Math.exp(-Math.pow((dy - 0.815) / 0.022, 2)) * 5.0;
        r += ring * 1.02; g += ring; b += ring * 0.96;

        // --- point sources -------------------------------------------------
        for (let i = 0; i < lights.length; i++) {
          const L = lights[i];
          const d = dx * L[0] + dy * L[1] + dz * L[2];
          if (d <= 0) continue;
          const ang = Math.acos(Math.min(1, d));
          if (ang > L[3] * 2.0) continue;
          // Flat core, fast falloff: the middle of the source is a disc at full
          // radiance and the edge is soft. A pure gaussian never actually
          // reaches its peak over any area, so its reflection never clips.
          const t = ang / L[3];
          const s = (t < 0.55 ? 1 : Math.exp(-(t - 0.55) * (t - 0.55) * 7.0)) * L[4];
          r += s * (1 + L[5]); g += s; b += s * (1 - L[5]);
        }

        const o = (y * size + x) * 4;
        if (hdr) {
          data[o]     = toHalf(r);
          data[o + 1] = toHalf(g);
          data[o + 2] = toHalf(b);
          data[o + 3] = 0x3c00;                       // 1.0
        } else {
          // No half-float: everything above 1.0 is lost, so the map is scaled
          // to keep the panels inside range and the hard sources are allowed to
          // clip. Clipping is the correct compromise — a clipped key still
          // reads as a highlight, whereas scaling the key to fit would drag the
          // whole room back to the grey wash this file exists to remove.
          const K = 0.055;
          data[o]     = Math.min(255, r * K * 255) | 0;
          data[o + 1] = Math.min(255, g * K * 255) | 0;
          data[o + 2] = Math.min(255, b * K * 255) | 0;
          data[o + 3] = 255;
        }
      }
    }
    faces.push(data);
  }
  return faces;
}
