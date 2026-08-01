// Hammered and leafed gold.
//
// Flat gold is the tell of a prototype. A perfectly smooth metal has exactly
// one specular highlight, so a gold rail lit by a studio environment is a
// single soft blob and a hundred metres of it is a hundred metres of the same
// blob. Real goldsmith's work is planished: overlapping hammer dishes, each
// with its own crisp edge, so the surface breaks the light into dozens of
// separate glints that travel as the camera moves.
//
// Two structures, both tileable:
//   HAMMER DISHES  shallow concave paraboloids on a jittered cell grid. The
//                  ridges WHERE THEY MEET are the part that reads — that is
//                  where the light snaps from one dish to the next.
//   LEAF SHEETS    gold leaf is laid in overlapping squares. The seams are a
//                  faint raised lip with a duller finish and a slightly deeper
//                  colour where two layers overlap.

import {
  hashi, vnoise, fbm, worley, heightToNormal, clamp255, clamp01, mix, smoothstep,
} from './tex.js';

/**
 * @param size    texture resolution
 * @param cells   hammer dishes across the tile
 * @param leaf    0..1 — strength of the gold-leaf sheet seams
 * @returns { albedo, normal, orm }
 */
export function generateGoldMaps(size, cells = 9, leaf = 1) {
  const n = size * size;
  const albedo = new Uint8Array(n * 4);
  const orm = new Uint8Array(n * 4);
  const height = new Float32Array(n);
  const w = [0, 0, 0, 0];
  const wl = [0, 0, 0, 0];

  const LEAF = 4;          // leaf sheets across the tile

  for (let py = 0; py < size; py++) {
    const v = (py + 0.5) / size;
    for (let px = 0; px < size; px++) {
      const u = (px + 0.5) / size;
      const i = py * size + px;

      // --- hammer dishes ---------------------------------------------------
      worley(u, v, cells, 8101, 0.85, w);
      const cx = Math.floor(u * cells), cy = Math.floor(v * cells);
      const depth = 0.55 + hashi(cx, cy, 991) * 0.75;      // varied blow force
      const t = clamp01(w[0] / 0.52);
      // Concave paraboloid: deepest at the strike, rising to a sharp rim where
      // it meets the neighbouring blow.
      const dish = -depth * (1 - t * t);
      // Rim: the tiny burr thrown up where two dishes meet.
      const rim = Math.exp(-Math.pow((w[1] - w[0]) / 0.10, 2)) * 0.22;

      // --- leaf sheets ------------------------------------------------------
      worley(u, v, LEAF, 4409, 0.55, wl);
      const seam = leaf * Math.exp(-Math.pow((wl[1] - wl[0]) / 0.085, 2));
      const overlap = leaf * smoothstep(0.10, 0.02, wl[1] - wl[0]);

      // --- micro grain ------------------------------------------------------
      const grain = vnoise(u, v, size >> 1, 77) - 0.5;
      const swirl = fbm(u, v, 24, 3, 313) - 0.5;

      height[i] = dish + rim + seam * 0.30 + grain * 0.055 + swirl * 0.10;

      // --- albedo ------------------------------------------------------------
      // Gold leaf is not one colour, but the variation has to stay SMALL.
      // The first pass swung luminance over 0.90..1.04 and pushed the dishes
      // red, and the columns came out looking like terracotta tree bark: on a
      // metal, albedo variation reads as dirt, not as form. Metal gets its
      // form from the reflection, so nearly all the variation belongs in the
      // normal and roughness maps, not here.
      const lum = 0.96 + t * 0.05 + swirl * 0.035 - overlap * 0.04;
      const warm = (1 - t) * 0.018 + overlap * 0.014;
      const o = i * 4;
      albedo[o]     = clamp255((lum + warm) * 255);
      albedo[o + 1] = clamp255(lum * 255);
      albedo[o + 2] = clamp255((lum - warm * 1.4) * 255);
      albedo[o + 3] = 255;

      // --- ORM ----------------------------------------------------------------
      const occ = clamp01(0.90 + (1 - t) * 0.10 - seam * 0.12);
      // Crests polished bright, dish floors slightly duller, seams dullest.
      // Range kept tight and LOW: above about 0.3 a metal stops reflecting the
      // studio and starts looking like fired clay, which is exactly what
      // happened to the columns on the first pass.
      let rough = 0.075 + (1 - t) * 0.075 + seam * 0.11 + Math.abs(grain) * 0.05;
      rough -= rim * 0.08;
      orm[o]     = clamp255(occ * 255);
      orm[o + 1] = clamp255(clamp01(rough) * 255);
      orm[o + 2] = 255;                                    // solid metal
      orm[o + 3] = 255;
    }
  }

  const normal = heightToNormal(height, size, size * 0.030, null);
  return { albedo, normal, orm };
}
