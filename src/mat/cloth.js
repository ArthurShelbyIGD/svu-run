// Woven cloth with metallic thread — the cape.
//
// The placeholder was a metal with roughness 0.38, i.e. a plastic sheet, and
// on a simulated cape that is the worst possible material: cloth sells its
// weight through how light falls off across a fold, and a smooth dielectric
// sheet has no falloff character at all.
//
// Three things make cloth read as cloth:
//   WEAVE        an actual over/under twill at thread scale. It is what your
//                eye uses to judge how heavy a fabric is.
//   FIBRE ROUGH  high roughness with per-thread variation, so no two threads
//                catch the same highlight.
//   SHEEN        the retroreflective rim at grazing angles. Applied on the
//                material (PBRMaterial.sheen), not in the texture, because it
//                is a BRDF lobe rather than a surface feature. Without it the
//                silhouette edge of a cape stays dark and dead.
//
// Metallic thread every seventh warp gives the brocade glint that ties the
// cape to the jewellery language instead of leaving it a grey rag.

import {
  hashi, vnoise, fbm, heightToNormal, clamp255, clamp01, mix, smoothstep,
} from './tex.js';

/**
 * @param size    texture resolution
 * @param threads threads across the tile (both directions)
 * @returns { albedo, normal, orm }
 */
export function generateClothMaps(size, threads = 44) {
  const n = size * size;
  const albedo = new Uint8Array(n * 4);
  const orm = new Uint8Array(n * 4);
  const height = new Float32Array(n);

  const METALLIC_EVERY = 7;

  for (let py = 0; py < size; py++) {
    const v = (py + 0.5) / size;
    for (let px = 0; px < size; px++) {
      const u = (px + 0.5) / size;
      const i = py * size + px;

      const tu = u * threads, tv = v * threads;
      const iu = Math.floor(tu), iv = Math.floor(tv);
      const fu = tu - iu, fv = tv - iv;

      // 2/2 twill: the diagonal step is what distinguishes a heavy woven
      // fabric from a plain-weave sheet, and it costs one modulo.
      const step = ((iu - iv) % 4 + 4) % 4;
      const warpOnTop = step < 2;

      // Thread cross-sections. Rounded, with a per-thread thickness so the
      // weave is hand-loomed rather than printed.
      const thickU = 0.80 + hashi(iu, 0, 61) * 0.30;
      const thickV = 0.80 + hashi(iv, 0, 97) * 0.30;
      const crossU = Math.cos((fu - 0.5) * Math.PI) * thickU;
      const crossV = Math.cos((fv - 0.5) * Math.PI) * thickV;

      // Along-thread undulation: a thread dips where it passes under.
      const underU = warpOnTop ? 1 : 0.45;
      const underV = warpOnTop ? 0.45 : 1;

      // Fibre twist: fine grooves running along each thread.
      const twistU = Math.sin((fv * 3.0 + iu * 0.7) * Math.PI * 2) * 0.09;
      const twistV = Math.sin((fu * 3.0 + iv * 0.7) * Math.PI * 2) * 0.09;

      const hU = crossU * underU + twistU * crossU;
      const hV = crossV * underV + twistV * crossV;
      const h = Math.max(hU, hV);

      // Slubs and drape wrinkles at a much larger scale, so the fabric is not
      // a perfectly flat plane of thread.
      const slub = (fbm(u, v, 6, 4, 5501) - 0.5) * 0.55;
      height[i] = h + slub;

      const isMetal = warpOnTop
        ? (((iu % METALLIC_EVERY) + METALLIC_EVERY) % METALLIC_EVERY) === 3
        : (((iv % METALLIC_EVERY) + METALLIC_EVERY) % METALLIC_EVERY) === 3;
      // A metallic warp still passes UNDER at every other crossing, so the
      // glint is dashed, not a continuous stripe. That dashing is the whole
      // reason brocade sparkles.
      const metalHere = isMetal && h > 0.35;

      // --- albedo -------------------------------------------------------------
      const shade = 0.52 + h * 0.42 + slub * 0.30;
      const fuzz = (vnoise(u, v, size >> 1, 131) - 0.5) * 0.10;
      const o = i * 4;
      if (metalHere) {
        // Gold thread: warm, and much brighter than the ground weave.
        albedo[o]     = clamp255((0.98 + fuzz) * 255);
        albedo[o + 1] = clamp255((0.80 + fuzz) * 255);
        albedo[o + 2] = clamp255((0.40 + fuzz) * 255);
      } else {
        const l = clamp01(shade + fuzz);
        albedo[o]     = clamp255(l * 253);
        albedo[o + 1] = clamp255(l * 250);
        albedo[o + 2] = clamp255(l * 255);
      }
      albedo[o + 3] = 255;

      // --- ORM ------------------------------------------------------------------
      // Occlusion sits in the crossings, which is what gives a weave depth.
      const occ = clamp01(0.55 + smoothstep(-0.1, 0.9, h) * 0.45);
      const rough = metalHere
        ? 0.22 + Math.abs(fuzz) * 0.6
        : 0.62 + (1 - clamp01(h)) * 0.22 + fuzz * 0.4;
      orm[o]     = clamp255(occ * 255);
      orm[o + 1] = clamp255(clamp01(rough) * 255);
      orm[o + 2] = metalHere ? 255 : 4;
      orm[o + 3] = 255;
    }
  }

  const normal = heightToNormal(height, size, size * 0.014, null);
  return { albedo, normal, orm };
}
