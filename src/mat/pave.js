// Procedural pavé — the signature surface of the whole project.
//
// The reference artwork is not a silver figure that happens to have stones on
// it; the stones ARE the artwork. Without this the character is a smooth toy,
// and no amount of geometry or lighting rescues it.
//
// SECOND PASS, after a critic called the first one "bubble wrap". Four things
// were wrong, and all four were the same mistake — modelling the stones as
// bright diffuse domes instead of as dark bodies with pinpoint fire:
//
//   1. Stone albedo was 0.80 white. A white dielectric dome lit from anywhere
//      is a lump of white. A diamond is nearly BLACK inside and gets its entire
//      read from what it reflects: a hard, tiny, clipped highlight sitting on
//      near-black. That value swing IS the material. Albedo is now 0.06.
//   2. The metal between the stones was the same value as the stones, so there
//      was no setting — just texture. There is now a raised BEAD at every point
//      where three stones meet (which is where a real pavé setter puts one),
//      at full champagne-gold albedo, sitting in a dark occluded valley. That
//      bright-bead / dark-valley pair is what stops it reading as foil.
//   3. Every stone was the same size in perfect rows, which reads as a pinecone
//      rather than as a set piece. Stones are now graded into three size
//      classes in soft CLUSTERS — a run of large stones, medium over the mass,
//      small filler — with a few deliberately empty settings.
//   4. Every stone's table was a smooth dome, so its highlight slid smoothly
//      and the whole field flashed as one unit. Each table now carries its own
//      small random TILT, so neighbouring stones catch different sources and
//      the field twinkles instead of sliding.
//
// Maps generated, all tileable and all at load time:
//
//   NORMAL   from a real heightfield (stone domes, bead web, valley), so the
//            beads genuinely sit proud of the stones' girdles.
//   ORM      occlusion / roughness / metallic. Stones are near-mirror
//            dielectrics, beads are polished metal, valleys are dark and dull.
//   FACET    a second, hard-edged crown-facet normal used as a clear-coat bump.
//            This is the glint: a flash that SNAPS as the view angle crosses a
//            facet edge, rather than a highlight that slides. Smooth highlights
//            read as plastic; snapping ones read as cut stone.
//   ALBEDO   near-black stones, bright warm beads, dark valleys.
//
// Hex packing rather than a square grid, because a square grid reads instantly
// as a grid and hex reads as "set by hand".

import { heightToNormal, hashi, vnoise, clamp255, clamp01, smoothstep } from './tex.js';

/**
 * Build tileable pavé maps.
 *
 * @param size   texture resolution (power of two)
 * @param cells  stones across the tile. More = finer stones.
 * @returns { normal, orm, facet, albedo }
 */
export function generatePaveMaps(size, cells) {
  const n = size * size;
  const orm = new Uint8Array(n * 4);
  const facet = new Uint8Array(n * 4);
  const albedo = new Uint8Array(n * 4);
  const height = new Float32Array(n);

  const cellW = size / cells;
  const cellH = (cellW * Math.sqrt(3)) / 2;
  const rows = Math.max(1, Math.round(size / cellH));
  const rowH = size / rows;

  // Deterministic hash — never Math.random, so the texture is byte-identical on
  // every load and screenshots stay comparable between builds.
  const hash = (x, y) => hashi(x, y, 12345);

  // Nearest-neighbour spacing on this lattice is one cellW, so 0.5 is stones
  // touching. Three classes, in clusters rather than at random: a jeweller
  // works in runs of a size, and scattering sizes per-stone just reads as
  // noise.
  const R_LARGE = cellW * 0.478;
  const R_MED = cellW * 0.404;
  const R_SMALL = cellW * 0.330;

  // Per-cell stone table: radius, tilt, seed, and whether it exists at all.
  // Precomputed rather than recomputed inside the pixel loop, which used to
  // evaluate the cluster noise nine times per pixel.
  const cols = Math.max(1, Math.round(size / cellW));
  const cellR = new Float32Array(cols * rows);
  const cellTx = new Float32Array(cols * rows);
  const cellTy = new Float32Array(cols * rows);
  const cellSeed = new Float32Array(cols * rows);
  for (let r = 0; r < rows; r++) {
    const offset = (r % 2) * 0.5;
    for (let c = 0; c < cols; c++) {
      const i = r * cols + c;
      const cx = ((c + offset + 0.5) * cellW) / size;
      const cy = ((r + 0.5) * rowH) / size;
      // Smooth cluster field, tileable, so size classes come in patches.
      const cl = vnoise(cx, cy, 3, 4409) * 0.72 + vnoise(cx, cy, 7, 991) * 0.28;
      const s = hash(c * 3 + 11, r * 7 - 5);
      cellR[i] = cl > 0.60 ? R_LARGE : cl > 0.36 ? R_MED : R_SMALL;
      // A few settings left empty on purpose. Perfect coverage is the tell of a
      // generated pattern; a real piece has metal showing where the form runs
      // out of room.
      if (s < 0.035) cellR[i] = 0;
      cellSeed[i] = hash(c - 19, r + 43);
      // Random table tilt, up to about 7 degrees. This is the twinkle: with
      // every table coplanar the whole field takes the same source at the same
      // moment and flashes as one unit.
      cellTx[i] = (hash(c + 501, r - 77) - 0.5) * 0.26;
      cellTy[i] = (hash(c - 313, r + 29) - 0.5) * 0.26;
    }
  }

  const BEAD_W = cellW * 0.148;    // bead radius
  const JUNCT = cellW * 0.185;     // how close three stones must be to bead

  for (let py = 0; py < size; py++) {
    const row0 = Math.floor(py / rowH);
    for (let px = 0; px < size; px++) {
      // Three nearest stones, ranked by EDGE distance (d - R) so a large stone
      // beside a small one owns the ground between them, as it would in a real
      // setting.
      let e1 = 1e9, e2 = 1e9, e3 = 1e9;
      let d1 = 0, r1 = 1, s1 = 0, tx1 = 0, ty1 = 0, dx1 = 0, dy1 = 0;

      for (let dr = -1; dr <= 1; dr++) {
        const r = row0 + dr;
        const rw = ((r % rows) + rows) % rows;
        const rowY = (r + 0.5) * rowH;
        const offset = (((r % 2) + 2) % 2) * 0.5;
        const col0 = Math.floor(px / cellW - offset);
        for (let dc = -1; dc <= 1; dc++) {
          const c = col0 + dc;
          const cw = ((c % cols) + cols) % cols;
          const idx = rw * cols + cw;
          const R = cellR[idx];
          if (R <= 0) continue;                       // empty setting
          const jx = (hash(cw, rw) - 0.5) * cellW * 0.13;
          const jy = (hash(cw + 77, rw - 31) - 0.5) * rowH * 0.13;
          let dx = px - ((c + offset + 0.5) * cellW + jx);
          let dy = py - (rowY + jy);
          if (dx > size * 0.5) dx -= size;            // wrap: the tile is seamless
          if (dx < -size * 0.5) dx += size;
          if (dy > size * 0.5) dy -= size;
          if (dy < -size * 0.5) dy += size;
          const d = Math.sqrt(dx * dx + dy * dy);
          const e = d - R;
          if (e < e1) {
            e3 = e2; e2 = e1; e1 = e;
            d1 = d; r1 = R; s1 = cellSeed[idx];
            tx1 = cellTx[idx]; ty1 = cellTy[idx];
            dx1 = dx; dy1 = dy;
          } else if (e < e2) { e3 = e2; e2 = e;
          } else if (e < e3) { e3 = e; }
        }
      }

      const i = py * size + px;
      const o = i * 4;
      const inStone = e1 < 0;

      // --- the bead web ---------------------------------------------------
      // A raised bead wherever three stones nearly meet — which is exactly
      // where a setter raises one from the metal to hold them. Falls off both
      // with distance from the triple point (e3 - e1) and with distance out of
      // the crevice (e1), so beads are small, round and land in the gaps.
      const junction = Math.exp(-Math.pow((e3 - e1) / JUNCT, 2));
      const bead = inStone ? 0
        : junction * Math.exp(-Math.pow(e1 / BEAD_W, 2));

      // --- height ----------------------------------------------------------
      let h;
      if (inStone) {
        const t = clamp01(d1 / r1);
        // Table flat to 58% of the radius, then a crown bevel down to the
        // girdle. A table-cut stone gives ONE crisp highlight; a hemisphere
        // gives a soft blob that slides.
        const TABLE = 0.58;
        const dome = t < TABLE ? 1 : 1 - Math.pow((t - TABLE) / (1 - TABLE), 1.35);
        // per-stone table tilt (see cellTx above)
        const tilt = (dx1 * tx1 + dy1 * ty1) / r1;
        h = 0.62 + dome * 0.38 + tilt * 0.10 * dome;
      } else {
        // Setting metal. Sits BELOW the stones' girdles, dropping further into
        // the deepest channels, with the beads rising back above them.
        const gap = clamp01(e1 / (cellW * 0.30));
        h = 0.44 - gap * 0.16 + bead * 0.34;
      }
      height[i] = h;

      // --- crown facets (the clear-coat glint) -------------------------------
      // Azimuth around the stone quantised into an odd number of wedges, offset
      // per stone so the pattern never lines up with the hex lattice, each
      // wedge tilted a fixed amount outward. Hard edges are the entire point.
      let fnx = 0, fny = 0;
      if (inStone) {
        const FACETS = 9;
        const az = Math.atan2(dy1, dx1);
        const wedge = Math.floor(((az / (Math.PI * 2)) + 0.5 + s1) * FACETS);
        const mid = ((wedge + 0.5) / FACETS - 0.5 - s1) * Math.PI * 2;
        const t = clamp01(d1 / r1);
        const tilt = t < 0.5 ? 0.05 : 0.44;
        fnx = Math.cos(mid) * tilt;
        fny = Math.sin(mid) * tilt;
      }
      const fnz = Math.sqrt(Math.max(0.0001, 1 - fnx * fnx - fny * fny));
      facet[o]     = clamp255((fnx * 0.5 + 0.5) * 255);
      facet[o + 1] = clamp255((fny * 0.5 + 0.5) * 255);
      facet[o + 2] = clamp255((fnz * 0.5 + 0.5) * 255);
      facet[o + 3] = 255;

      // --- ORM and albedo ----------------------------------------------------
      let occ, rough, metal, ar, ag, ab;
      if (inStone) {
        const t = clamp01(d1 / r1);
        // Near-mirror. The polish varies slightly per stone because no two
        // stones in a real setting take an identical polish, and a field with
        // one roughness flashes as a single unit.
        rough = 0.030 + t * t * 0.045 + (s1 - 0.5) * 0.020;
        occ = 0.97 - Math.pow(t, 4) * 0.22;
        // A diamond is not metal. Modelled as metal it is a tiny mirror, and a
        // field of tiny mirrors averages the room to grey. As a dielectric it
        // keeps a hard, bright, view-dependent highlight over a dark body —
        // which is what a set stone actually looks like.
        metal = 14;
        // NEAR-BLACK BODY. This is the change the whole second pass turns on.
        // 0.80 white here was the bubble wrap; the fire comes from the clear
        // coat and the facets, not from the diffuse term.
        const a = 0.175 + t * t * 0.085 + s1 * 0.035;
        ar = a * 0.94; ag = a * 0.97; ab = a * 1.10;    // faintly blue-white
      } else if (bead > 0.14) {
        // The bead itself: bright polished metal, the one thing on this surface
        // allowed to be at full albedo.
        rough = 0.085 + (1 - bead) * 0.10;
        occ = 0.55 + bead * 0.42;
        metal = 255;
        // Bright, but not 1.0. At full albedo the beads clipped to white over
        // a large fraction of the suit and the character bloomed into one
        // luminous cloud — the bead has to be the brightest thing on the
        // surface, not the brightest thing in the frame.
        const a = 0.70 + bead * 0.22;
        ar = a; ag = a * 0.905; ab = a * 0.74;          // champagne gold
      } else {
        // The dark valley between stones. Deliberately deep: this shadow is the
        // single strongest signal that these are individually SET stones rather
        // than an embossed pattern.
        const gap = clamp01(e1 / (cellW * 0.30));
        rough = 0.22 + gap * 0.16;
        occ = 0.34 + bead * 1.4 + gap * 0.10;
        metal = 255;
        const a = 0.30 + bead * 1.2 + gap * 0.10;
        ar = a; ag = a * 0.94; ab = a * 0.84;
      }

      orm[o]     = clamp255(clamp01(occ) * 255);
      orm[o + 1] = clamp255(clamp01(rough) * 255);
      orm[o + 2] = metal;
      orm[o + 3] = 255;

      albedo[o]     = clamp255(clamp01(ar) * 255);
      albedo[o + 1] = clamp255(clamp01(ag) * 255);
      albedo[o + 2] = clamp255(clamp01(ab) * 255);
      albedo[o + 3] = 255;
    }
  }

  // Normal strength scales with the stone size in pixels, not with the texture
  // size: the same lattice at 256 and at 512 must produce the same normals, or
  // the low preset renders a visibly different surface.
  const normal = heightToNormal(height, size, cellW * 0.95, null);
  return { normal, orm, facet, albedo };
}

/**
 * Brushed / hammered metal, for the pieces that are NOT set with stones —
 * the polished hands and boots, the gold trim.
 *
 * Perfectly smooth metal is the other half of why a build reads as plastic:
 * real polished metal still has microscopic structure, and without any the
 * specular is a single clean blob with nothing to catch the eye.
 *
 * `strength` is the depth of the streaks. It is a genuine dial: the character's
 * face wants nearly none (the critic's note was "pink pearlescent plastic with
 * vertical scratch streaks"), while a machined rail wants plenty.
 */
export function generateBrushedMaps(size, strength = 0.35) {
  const normal = new Uint8Array(size * size * 4);
  const orm = new Uint8Array(size * size * 4);

  const hash = (x, y) => {
    let h = (x * 1597334677 + y * 3812015801) | 0;
    h = (h ^ (h >> 15)) * 2246822519;
    return ((h ^ (h >> 13)) >>> 0) / 4294967296;
  };

  for (let py = 0; py < size; py++) {
    for (let px = 0; px < size; px++) {
      // Anisotropic streaks: high frequency across, low frequency along.
      const a = hash(px, py >> 3);
      const b = hash(px + 1, py >> 3);
      const c = hash(px >> 4, py);
      const streak = (a - b) * strength + (c - 0.5) * strength * 0.25;

      const nx = streak;
      const ny = (hash(px >> 2, py + 91) - 0.5) * strength * 0.18;
      const nz = Math.sqrt(Math.max(0.0001, 1 - nx * nx - ny * ny));

      const o = (py * size + px) * 4;
      normal[o]     = ((nx * 0.5 + 0.5) * 255) | 0;
      normal[o + 1] = ((ny * 0.5 + 0.5) * 255) | 0;
      normal[o + 2] = ((nz * 0.5 + 0.5) * 255) | 0;
      normal[o + 3] = 255;

      // Roughness follows the streaks. The floor is low — polished metal is
      // polished — but the variation is what breaks one big soft highlight into
      // a highlight with structure inside it.
      const rough = 0.035 + Math.abs(streak) * 0.42 + c * 0.03;
      orm[o]     = 245;
      orm[o + 1] = Math.max(0, Math.min(255, (rough * 255) | 0));
      orm[o + 2] = 255;
      orm[o + 3] = 255;
    }
  }
  return { normal, orm };
}

/**
 * A polished, near-featureless metal map: fine orange-peel only.
 *
 * The face and the mitten hands need this. They are large smooth forms read at
 * close range, and any directional streak on them stretches through the sphere
 * UVs into visible vertical scratches — which is exactly what made the face
 * read as "pink pearlescent plastic" rather than as polished gold.
 */
export function generatePolishMaps(size) {
  const normal = new Uint8Array(size * size * 4);
  const orm = new Uint8Array(size * size * 4);
  const height = new Float32Array(size * size);

  for (let py = 0; py < size; py++) {
    for (let px = 0; px < size; px++) {
      const u = (px + 0.5) / size, v = (py + 0.5) / size;
      // Two octaves of very low-amplitude noise: the gentle waviness of hand-
      // polished metal, isotropic so it cannot stretch into streaks.
      height[py * size + px] =
        vnoise(u, v, 6, 4001) * 0.65 + vnoise(u, v, 17, 733) * 0.35;
    }
  }
  heightToNormal(height, size, size * 0.0022, normal);

  for (let i = 0; i < size * size; i++) {
    const o = i * 4;
    orm[o] = 255;
    // Mirror polish with the faintest variation. A constant roughness gives one
    // perfect blob; a little variation gives the blob an inside.
    orm[o + 1] = clamp255((0.055 + (height[i] - 0.5) * 0.05) * 255);
    orm[o + 2] = 255;
    orm[o + 3] = 255;
  }
  return { normal, orm };
}
