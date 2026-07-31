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

  const stoneR = cellW * 0.455;   // leaves a little metal between stones
  const beadR = cellW * 0.10;

  for (let py = 0; py < size; py++) {
    for (let px = 0; px < size; px++) {
      // Find the nearest stone centre among the neighbouring hex cells.
      let best = 1e9, bdx = 0, bdy = 0;
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
          if (d2 < best) { best = d2; bdx = dx; bdy = dy; }
        }
      }

      const d = Math.sqrt(best);
      let nx, ny, nz, rough, occl;

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
        rough = 0.085 + t * 0.075;
        occl = 0.94 + (1 - t) * 0.06;
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
        occl = 0.74 + 0.18 * bead + 0.06 * gap;
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
    }
  }

  return { normal, orm };
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
