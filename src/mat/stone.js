// Carved and polished stone.
//
// The placeholder for these four names was a flat albedo colour with a fixed
// roughness — the "flat matt grey thing" verdict, exactly. Real stone reads
// through three signals, and all three have to be there or none of them work:
//
//   VEINING       large-scale colour structure. Without it stone is concrete.
//   TOOL MARKS    directional chisel facets in patches, not everywhere. A
//                 uniformly rough surface reads as noise; carved stone has
//                 flats that catch light and hollows that do not.
//   EDGE WEAR     the high points are polished smooth by handling and the
//                 hollows stay matte. Roughness variation is what makes a
//                 surface look touched rather than extruded.
//
// One albedo is generated and tinted per material via albedoColor, because
// four independent 512² albedo maps is 4 MB of VRAM to say the same thing
// four times.

import {
  hashi, vnoise, fbm, ridged, worley, veins,
  heightToNormal, clamp255, clamp01, mix, smoothstep,
} from './tex.js';

/**
 * @param size   texture resolution
 * @param carved 0..1 — how much chisel and pitting on top of the marble
 * @returns { albedo, normal, orm }
 */
export function generateStoneMaps(size, carved = 1) {
  const n = size * size;
  const albedo = new Uint8Array(n * 4);
  const orm = new Uint8Array(n * 4);
  const height = new Float32Array(n);
  const w = [0, 0, 0, 0];

  // Block courses: a 2x1 masonry grid with recessed joints. This is the single
  // cheapest way to stop a stone texture reading as an infinite mush — it gives
  // the eye a scale reference and an edge to catch light on.
  const COURSES = 2;

  for (let py = 0; py < size; py++) {
    const v = (py + 0.5) / size;
    for (let px = 0; px < size; px++) {
      const u = (px + 0.5) / size;
      const i = py * size + px;

      // --- masonry joints -------------------------------------------------
      // Rows offset by half a block so courses stagger like real ashlar.
      const row = Math.floor(v * COURSES);
      const shift = (row % 2) * 0.5;
      const bu = (u * COURSES + shift) % 1;
      const bv = v * COURSES - row;
      // Joint lines wobble slightly so they are cut stone, not a CAD grid.
      const wob = (fbm(u, v, 12, 3, 4001) - 0.5) * 0.018;
      const eU = Math.min(bu, 1 - bu) + wob;
      const eV = Math.min(bv, 1 - bv) + wob * 0.7;
      const edge = Math.min(eU, eV);
      const joint = 1 - smoothstep(0.012, 0.055, edge);   // 1 inside the joint

      // --- marble ---------------------------------------------------------
      const vein1 = veins(u, v, 4, 1, 1.35, 5.0, 71);
      const vein2 = veins(u, v, 1, 5, 0.95, 8.0, 913) * 0.55;
      const veinAll = clamp01(vein1 + vein2);
      const mottle = fbm(u, v, 5, 4, 233);
      const grit = vnoise(u, v, size >> 2, 55);

      // --- tool marks -------------------------------------------------------
      // Two integer-frequency directional waves, so they tile exactly, masked
      // into patches. Real chisel work is directional over a face and changes
      // direction on the next face.
      //
      // Skipped entirely for the polished variant: it is the most expensive
      // part of this generator and the marble finish does not use it.
      let chisel = 0, pit = 0;
      if (carved > 0.5) {
        const patch = smoothstep(0.42, 0.72, fbm(u, v, 4, 3, 617));
        const patch2 = smoothstep(0.45, 0.80, fbm(u, v, 4, 3, 1201));
        chisel =
          Math.abs(Math.sin(Math.PI * (11 * u + 4 * v + (fbm(u, v, 9, 2, 88) - 0.5) * 0.8))) * patch +
          Math.abs(Math.sin(Math.PI * (3 * u - 13 * v + (fbm(u, v, 9, 2, 91) - 0.5) * 0.8))) * patch2;

        // --- pitting --------------------------------------------------------
        worley(u, v, 14, 2207, 0.9, w);
        const pitMask = hashi(Math.floor(u * 14), Math.floor(v * 14), 3301);
        pit = pitMask > 0.72 ? Math.max(0, 1 - w[0] / 0.30) : 0;
      }

      // --- height -----------------------------------------------------------
      let h = mottle * 0.35 + ridged(u, v, 6, 4, 145) * 0.22;
      h += carved * (chisel * 0.16 - pit * pit * 0.55);
      h += veinAll * 0.05;              // veins sit very slightly proud
      h += (grit - 0.5) * 0.05;
      h -= joint * 1.35;                // joints cut deep
      height[i] = h;

      // --- albedo -----------------------------------------------------------
      // Luminance only. Tinted per material by albedoColor so four stones cost
      // one texture.
      let lum = 0.62 + (mottle - 0.5) * 0.24 + (grit - 0.5) * 0.055;
      lum = mix(lum, 0.97, veinAll * 0.80);                 // bright veins
      lum *= 1 - carved * pit * 0.35;                       // pits are darker
      lum *= 1 - joint * 0.55;                              // joints in shadow
      lum *= 0.93 + smoothstep(0.2, 1.4, chisel) * 0.12;    // catch on facets
      const cool = (fbm(u, v, 3, 3, 1777) - 0.5) * 0.05;    // faint hue drift
      const o = i * 4;
      albedo[o]     = clamp255((lum + cool * 0.6) * 255);
      albedo[o + 1] = clamp255(lum * 255);
      albedo[o + 2] = clamp255((lum - cool) * 255);
      albedo[o + 3] = 255;

      // --- ORM ---------------------------------------------------------------
      // Occlusion: joints and pits only. Broad AO on a surface lit mostly by
      // the environment reads as the object being switched off (see pave.js).
      const occ = clamp01(1 - joint * 0.55 - pit * 0.30 - (1 - mottle) * 0.06);
      // Roughness: hollows matte, crests worn smooth. This is the wear signal.
      let rough = 0.52 - smoothstep(0.15, 0.62, h) * 0.26 + carved * pit * 0.30;
      rough += (grit - 0.5) * 0.10 + joint * 0.22;
      // Polished stone: same structure, tighter range, so the two materials are
      // recognisably the same rock finished two different ways.
      if (carved < 0.5) rough = 0.30 + (rough - 0.45) * 0.40;
      orm[o]     = clamp255(occ * 255);
      orm[o + 1] = clamp255(clamp01(rough) * 255);
      orm[o + 2] = 6;                                       // stone is dielectric
      orm[o + 3] = 255;
    }
  }

  const normal = heightToNormal(height, size, size * (carved > 0.5 ? 0.055 : 0.030), null);
  return { albedo, normal, orm };
}
