// Procedural pavé — the signature surface of the whole project.
//
// This is what was deferred as a "stretch goal" in the original plan, and that
// was the wrong call. The reference artwork is not a silver figure that happens
// to have stones on it; the stones ARE the artwork. Without this the character
// is a smooth toy, and no amount of geometry or lighting rescues it.
//
// What is generated here, all tileable and all at load time:
//
//   NORMAL MAP    hex-packed dome stones with raised metal beading between
//                 them. This is what catches the light in thousands of small
//                 highlights instead of one big one.
//   ORM MAP       Babylon packs occlusion in R, roughness in G, metallic in B.
//                 Stones are near-mirror, the setting metal is duller, and the
//                 gaps between them are darkened by occlusion — that contrast
//                 is what stops it reading as bumpy foil.
//
// Hex packing rather than a square grid because a square grid reads instantly
// as a grid; hex reads as "set by hand".

/**
 * Build tileable pavé maps.
 *
 * @param size   texture resolution (power of two)
 * @param cells  stones across the tile. More = finer stones.
 * @returns { normal: Uint8Array, orm: Uint8Array }
 */
export function generatePaveMaps(size, cells) {
  const normal = new Uint8Array(size * size * 4);
  const orm = new Uint8Array(size * size * 4);
  // Third map: a CROWN FACET normal, used as a clear-coat bump so each stone
  // gets a second, near-mirror specular lobe broken into hard-edged facets.
  // That is what produces the glint — a sharp flash that snaps on and off as
  // the viewing angle crosses a facet boundary, instead of a highlight that
  // slides smoothly across a dome. Smooth highlights read as plastic; snapping
  // ones read as cut stone.
  const facet = new Uint8Array(size * size * 4);
  // Fourth map: albedo. Added after a close-up showed the suit reading as
  // white foam rather than as set stones. The stones are modelled as bright
  // DIELECTRICS (see the metallic note below), so their diffuse term is the
  // material's albedo colour at nearly full strength — a field of white
  // diffuse domes, which is bubble wrap. A real diamond is transparent: it
  // has almost no body colour and gets its value from what it reflects. So
  // the stones are darkened here and the metal beading between them is left
  // at full colour, which is also what gives the setting its structure.
  const albedo = new Uint8Array(size * size * 4);

  const cellW = size / cells;
  const cellH = (cellW * Math.sqrt(3)) / 2;
  const rows = Math.max(1, Math.round(size / cellH));
  const rowH = size / rows;

  // Deterministic jitter — a fixed hash, not Math.random, so the texture is
  // byte-identical on every load and screenshots stay comparable.
  const hash = (x, y) => {
    let h = (x * 374761393 + y * 668265263) | 0;
    h = (h ^ (h >> 13)) * 1274126177;
    return ((h ^ (h >> 16)) >>> 0) / 4294967296;
  };

  const beadR = cellW * 0.10;

  for (let py = 0; py < size; py++) {
    for (let px = 0; px < size; px++) {
      // Find the nearest stone centre among the neighbouring hex cells.
      let best = 1e9, bdx = 0, bdy = 0, bestR = cellW * 0.455, bestSeed = 0;
      const row0 = Math.floor(py / rowH);

      for (let dr = -1; dr <= 1; dr++) {
        const r = row0 + dr;
        const rowY = (r + 0.5) * rowH;
        const offset = (((r % 2) + 2) % 2) * 0.5;   // hex stagger
        const col0 = Math.floor(px / cellW - offset);
        for (let dc = -1; dc <= 1; dc++) {
          const c = col0 + dc;
          const jx = (hash(c, r) - 0.5) * cellW * 0.10;
          const jy = (hash(c + 77, r - 31) - 0.5) * rowH * 0.10;
          const cxRaw = (c + offset + 0.5) * cellW + jx;
          const cy = rowY + jy;
          // wrap horizontally so the tile is seamless
          let dx = px - cxRaw;
          if (dx > size * 0.5) dx -= size;
          if (dx < -size * 0.5) dx += size;
          let dy = py - cy;
          if (dy > size * 0.5) dy -= size;
          if (dy < -size * 0.5) dy += size;
          const d2 = dx * dx + dy * dy;
          if (d2 < best) {
            best = d2; bdx = dx; bdy = dy;
            // Stones are graded, not identical. A jeweller sets larger stones
            // where there is room and fills with smaller ones; a field of
            // perfectly equal stones is the thing that made this read as a
            // machined mesh rather than as set gems.
            const g = hash(c * 3 + 11, r * 7 - 5);
            bestR = cellW * (g > 0.86 ? 0.470 : g > 0.55 ? 0.415 : 0.362);
            bestSeed = hash(c - 19, r + 43);
          }
        }
      }

      const d = Math.sqrt(best);
      const stoneR = bestR;
      let nx, ny, nz, rough, occl;

      // --- crown facets (clear-coat glint) ---
      // Azimuth around the stone, quantised into an odd number of wedges so
      // the pattern never lines up with the hex lattice, each wedge tilted a
      // fixed amount outward. Hard edges are the point.
      const FACETS = 9;
      let fnx = 0, fny = 0;
      if (d < stoneR) {
        const az = Math.atan2(bdy, bdx);
        const wedge = Math.floor(((az / (Math.PI * 2)) + 0.5 + bestSeed) * FACETS);
        const mid = ((wedge + 0.5) / FACETS - 0.5 - bestSeed) * Math.PI * 2;
        // Table on top, crown facets around the girdle.
        const tilt = d / stoneR < 0.5 ? 0.06 : 0.46;
        fnx = Math.cos(mid) * tilt;
        fny = Math.sin(mid) * tilt;
      }
      {
        const fnz = Math.sqrt(Math.max(0.0001, 1 - fnx * fnx - fny * fny));
        const fo = (py * size + px) * 4;
        facet[fo]     = Math.max(0, Math.min(255, ((fnx * 0.5 + 0.5) * 255) | 0));
        facet[fo + 1] = Math.max(0, Math.min(255, ((fny * 0.5 + 0.5) * 255) | 0));
        facet[fo + 2] = Math.max(0, Math.min(255, ((fnz * 0.5 + 0.5) * 255) | 0));
        facet[fo + 3] = 255;
      }

      if (d < stoneR) {
        // Dome of a cut stone. Slightly flattened on top, which is what a
        // real table-cut stone looks like and reads far better than a
        // hemisphere: it gives each stone one crisp highlight.
        const t = d / stoneR;
        const flat = 0.62;
        const s = t < flat ? (t / flat) * 0.35 : 0.35 + ((t - flat) / (1 - flat)) * 0.65;
        const slope = Math.sin(s * Math.PI * 0.5);
        const inv = d > 1e-5 ? 1 / d : 0;
        nx = bdx * inv * slope;
        ny = bdy * inv * slope;
        nz = Math.sqrt(Math.max(0.0001, 1 - nx * nx - ny * ny));
        // Not a perfect mirror. A true mirror finish reflects whatever is
        // behind the camera, which in a dark room is darkness — the first
        // build of this rendered the whole suit black. A little roughness
        // makes each stone gather light from a cone instead of a point.
        // Per-stone variation. Every stone in a real setting sits at a slightly
        // different angle and takes a slightly different polish, so no two
        // catch the light identically. Without this the field flashes as one
        // unit and reads as a printed pattern.
        rough = 0.085 + t * 0.075 + (bestSeed - 0.5) * 0.055;
        occl = (0.94 + (1 - t) * 0.06) * (0.92 + bestSeed * 0.08);
      } else {
        // The setting: metal beading between stones, plus the dark channel
        // where the stones nearly touch. The occlusion here is what gives the
        // surface depth; without it pavé reads as crinkled foil.
        const gap = (d - stoneR) / Math.max(1e-4, cellW * 0.5 - stoneR);
        const bead = Math.exp(-Math.pow((d - stoneR - beadR) / (beadR * 0.9), 2));
        const inv = d > 1e-5 ? 1 / d : 0;
        const slope = -0.55 * bead + 0.28 * (1 - bead);
        nx = bdx * inv * slope;
        ny = bdy * inv * slope;
        nz = Math.sqrt(Math.max(0.0001, 1 - Math.min(0.98, nx * nx + ny * ny)));
        rough = 0.20 + 0.20 * (1 - bead);
        // Occlusion floor deliberately high. Babylon's AO multiplies the
        // environment contribution, and the environment is doing nearly all
        // the lighting here, so aggressive AO does not read as depth — it
        // reads as the object being switched off.
        // Deep. The dark channel between stones is the single strongest
        // signal that these are individually SET stones rather than an
        // embossed pattern, and at the previous floor of 0.74 the suit read
        // as bubble wrap in every close-up.
        occl = 0.50 + 0.34 * bead + 0.10 * gap;
      }

      const o = (py * size + px) * 4;
      normal[o]     = Math.max(0, Math.min(255, ((nx * 0.5 + 0.5) * 255) | 0));
      normal[o + 1] = Math.max(0, Math.min(255, ((ny * 0.5 + 0.5) * 255) | 0));
      normal[o + 2] = Math.max(0, Math.min(255, ((nz * 0.5 + 0.5) * 255) | 0));
      normal[o + 3] = 255;

      orm[o]     = Math.max(0, Math.min(255, (occl * 255) | 0));   // occlusion
      orm[o + 1] = Math.max(0, Math.min(255, (rough * 255) | 0));  // roughness
      // Metallic varies ACROSS the surface, and this is the crux of the whole
      // material. A diamond is not metal — it is a bright dielectric. Modelled
      // as metal, a stone is a tiny mirror, and a field of tiny mirrors
      // reflects an average of the room, which is mid-grey at best and black
      // in a dark one. As a dielectric it stays bright and takes a sharp
      // highlight on top, which is what a set stone actually looks like.
      // The metal BETWEEN the stones stays fully metallic.
      orm[o + 2] = (d < stoneR) ? 22 : 255;
      orm[o + 3] = 255;

      if (d < stoneR) {
        // Darker in the middle of the table, edging brighter at the girdle
        // where a real stone catches its neighbours' light. Per-stone
        // variation again, because a uniform field reads as a printed pattern.
        const t = d / stoneR;
        // Soft, and not too dark. At 0.50 the stones read as black polka
        // dots at any distance and the suit looked spotted rather than set.
        const a = (0.66 + t * 0.13 + bestSeed * 0.06) * 255;
        albedo[o] = a | 0; albedo[o + 1] = a | 0; albedo[o + 2] = a | 0;
      } else {
        // The setting metal, darkened down into the channel between stones.
        const gap = (d - stoneR) / Math.max(1e-4, cellW * 0.5 - stoneR);
        const bead = Math.exp(-Math.pow((d - stoneR - beadR) / (beadR * 0.9), 2));
        const a = (0.58 + 0.42 * bead + 0.10 * gap) * 255;
        const c = a > 255 ? 255 : a | 0;
        albedo[o] = c; albedo[o + 1] = c; albedo[o + 2] = c;
      }
      albedo[o + 3] = 255;
    }
  }

  return { normal, orm, facet, albedo };
}

/**
 * Brushed / hammered metal, for the pieces that are NOT set with stones —
 * the polished chrome hands and boots, the gold trim.
 *
 * Perfectly smooth metal is the other half of why the current build reads as
 * plastic: real polished metal still has microscopic structure, and without
 * any the specular is a single clean blob with nothing to catch the eye.
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

      const rough = 0.06 + Math.abs(streak) * 0.55 + c * 0.04;
      orm[o]     = 245;
      orm[o + 1] = Math.max(0, Math.min(255, (rough * 255) | 0));
      orm[o + 2] = 255;
      orm[o + 3] = 255;
    }
  }
  return { normal, orm };
}
