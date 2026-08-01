// The track surface.
//
// The floor is the largest thing on screen in every single frame, and it
// shipped as one flat value. Nothing else in the build costs as much per pixel
// of screen area, so nothing else pays back detail as well.
//
// Design: inlaid stone paving in the jewellery language of the reference —
// dark marble slabs, deep chamfered joints, a gold pinstripe set a little in
// from each slab edge, and a gold lozenge where four slabs meet. It is a floor
// you could imagine in the vault the character is running through, and it
// gives the eye four separate scales of structure (joint, chamfer, pinstripe,
// lozenge) where before there was one.
//
// SPEED READABILITY is a gameplay requirement, not decoration: a runner needs
// the ground to stream past. The joint grid is the strongest signal of forward
// motion in the whole game and it costs one texture.
//
// Everything is keyed off distance-to-slab-edge so the chamfer, the pinstripe
// and the inlay stay locked together and cannot drift apart.

import {
  hashi, vnoise, fbm, worley, veins,
  heightToNormal, clamp255, clamp01, mix, smoothstep,
} from './tex.js';

/**
 * @param size    texture resolution
 * @param slabs   slabs across the tile (2 -> four slabs across the track at
 *                uScale 2, i.e. about 1.8 m each)
 * @param inlay   0..1 — strength of the gold inlay. 0 gives plain paving.
 * @returns { albedo, normal, orm }
 */
export function generateTrackMaps(size, slabs = 2, inlay = 1) {
  const n = size * size;
  const albedo = new Uint8Array(n * 4);
  const orm = new Uint8Array(n * 4);
  const height = new Float32Array(n);
  const w = [0, 0, 0, 0];

  // All widths in slab units (a slab is 1.0 across).
  // These four numbers are the whole look and they were all too big on the
  // first pass: black canyon joints and a fat gold rectangle round every slab
  // read as a tiled bathroom floor rather than as inlay. A joint you can see
  // at 30 m is already twice as wide as it should be.
  const JOINT = 0.011;      // half-width of the recessed joint
  const CHAMFER = 0.030;    // where the bevel finishes
  const PIN_IN = 0.062;     // gold pinstripe inner edge
  const PIN_OUT = 0.076;    // gold pinstripe outer edge
  const LOZENGE = 0.055;    // corner inlay half-diagonal

  for (let py = 0; py < size; py++) {
    const v = (py + 0.5) / size;
    for (let px = 0; px < size; px++) {
      const u = (px + 0.5) / size;
      const i = py * size + px;

      const su = u * slabs, sv = v * slabs;
      const ru = Math.floor(su), rv = Math.floor(sv);
      const cu = su - ru, cv = sv - rv;

      // Signed distance to the nearest slab edge, wobbled very slightly so the
      // joints are cut stone rather than a printed grid.
      const wob = (fbm(u, v, 16, 3, 9001) - 0.5) * 0.006;
      const dU = Math.min(cu, 1 - cu) + wob;
      const dV = Math.min(cv, 1 - cv) + wob * 0.8;
      const edge = Math.min(dU, dV);

      // Distance to the nearest slab CORNER, as a diamond, for the lozenge.
      const qu = cu < 0.5 ? cu : 1 - cu;
      const qv = cv < 0.5 ? cv : 1 - cv;
      const corner = qu + qv;

      // --- masks --------------------------------------------------------------
      const joint = 1 - smoothstep(JOINT, CHAMFER, edge);
      const pin = inlay * smoothstep(PIN_IN - 0.005, PIN_IN + 0.003, edge)
                        * (1 - smoothstep(PIN_OUT - 0.003, PIN_OUT + 0.005, edge));
      const loz = inlay * (1 - smoothstep(LOZENGE - 0.008, LOZENGE, corner));
      const gold = clamp01(Math.max(pin, loz) * (1 - joint));

      // --- marble inside the slab ---------------------------------------------
      // Per-slab tone so no two slabs are the same block of stone. This is what
      // stops a paved floor looking stamped out.
      const slabTone = hashi(ru, rv, 733) * 0.09 - 0.045;
      const vein1 = veins(u, v, 5, 2, 1.25, 6.0, 401);
      const vein2 = veins(u, v, 2, 6, 0.90, 9.0, 1907) * 0.5;
      const veinAll = clamp01(vein1 + vein2) * (1 - joint);
      const mottle = fbm(u, v, 6, 4, 617);
      const speck = vnoise(u, v, size >> 2, 21);
      // Scattered brighter crystals — a dark stone with no sparkle at all goes
      // dead the moment the zone lighting dims.
      worley(u, v, 26, 3313, 0.95, w);
      const crystal = Math.max(0, 1 - w[0] / 0.16) * (hashi(Math.floor(u * 26), Math.floor(v * 26), 51) > 0.62 ? 1 : 0);

      // --- height ----------------------------------------------------------------
      let h = (mottle - 0.5) * 0.10 + (speck - 0.5) * 0.04 + veinAll * 0.05;
      h += crystal * 0.10;
      h -= joint * 0.62;                                    // the joint channel
      h += gold * 0.10;                                     // inlay sits proud
      height[i] = h;

      // --- albedo -------------------------------------------------------------------
      const o = i * 4;
      if (gold > 0.5) {
        // Gold inlay, with its own beaten variation so it is not a decal.
        const gl = 0.92 + (mottle - 0.5) * 0.18;
        albedo[o]     = clamp255(gl * 255);
        albedo[o + 1] = clamp255(gl * 0.80 * 255);
        albedo[o + 2] = clamp255(gl * 0.36 * 255);
      } else {
        // Dark blue-grey marble. Kept genuinely dark: this floor previously
        // shipped as a mirror and rendered near-white on real hardware against
        // a cream backdrop, and the character appeared to run through empty
        // space. The surface must own its value, not borrow the sky's.
        let lum = 0.42 + (mottle - 0.5) * 0.17 + slabTone + (speck - 0.5) * 0.05;
        lum = mix(lum, 0.68, veinAll * 0.38);
        lum += crystal * 0.28;
        lum *= 1 - joint * 0.40;
        const cool = 0.030 + veinAll * 0.01;
        albedo[o]     = clamp255((lum - cool) * 255);
        albedo[o + 1] = clamp255(lum * 255);
        albedo[o + 2] = clamp255((lum + cool * 1.6) * 255);
      }
      albedo[o + 3] = 255;

      // --- ORM ------------------------------------------------------------------------
      const occ = clamp01(1 - joint * 0.44 - (1 - mottle) * 0.05);
      let rough;
      let metal;
      if (gold > 0.5) {
        rough = 0.16 + (mottle - 0.5) * 0.12;
        metal = 255;
      } else {
        // Satin, with polish variation. The variation matters more than the
        // absolute value: a constant roughness over 180 m of floor is what
        // made it read as painted card.
        rough = 0.42 + (mottle - 0.5) * 0.16 + (speck - 0.5) * 0.08 + joint * 0.22;
        rough -= crystal * 0.28;
        rough -= veinAll * 0.06;
        metal = 8;
      }
      orm[o]     = clamp255(occ * 255);
      orm[o + 1] = clamp255(clamp01(rough) * 255);
      orm[o + 2] = metal;
      orm[o + 3] = 255;
    }
  }

  const normal = heightToNormal(height, size, size * 0.024, null);
  return { albedo, normal, orm };
}
