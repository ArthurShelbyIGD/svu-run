// Shared procedural texture primitives.
//
// Everything in mat/ that generates a surface builds on these. Three rules
// hold throughout:
//
//   TILEABLE      every function wraps on the unit domain. A seam on the track
//                 floor repeats every 4 metres and is impossible to unsee.
//   DETERMINISTIC integer hashes only — never ctx.rng, never Math.random.
//                 Textures must be byte-identical on every load or the
//                 screenshot harness stops being a regression test.
//   INIT ONLY     these are heavy CPU loops. They run once, in init(), never
//                 per frame. ARCHITECTURE §4.
//
// Convention for normal maps, matched to pave.js so every surface in the game
// agrees: X right, Y up in UV space, Z out. Given a heightfield h,
//   nx = -dh/dx,  ny = -dh/dy   (y measured DOWNWARD in the pixel array)
// which is what Babylon expects with invertNormalMapY = false.

/** Integer hash -> [0,1). Fixed constants; do not tune. */
export function hashi(x, y, seed = 0) {
  let h = (Math.imul(x | 0, 374761393) + Math.imul(y | 0, 668265263) + Math.imul(seed | 0, 1442695041)) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  h = Math.imul(h ^ (h >>> 16), 1911520717);
  return ((h ^ (h >>> 15)) >>> 0) / 4294967296;
}

const smoothstep5 = (t) => t * t * t * (t * (t * 6 - 15) + 10);

/**
 * Tileable value noise. `period` is the number of lattice cells across the
 * whole [0,1) domain, so any integer period tiles exactly.
 */
export function vnoise(x, y, period, seed) {
  const fx = x * period, fy = y * period;
  const ix = Math.floor(fx), iy = Math.floor(fy);
  const tx = smoothstep5(fx - ix), ty = smoothstep5(fy - iy);
  const x0 = ((ix % period) + period) % period;
  const y0 = ((iy % period) + period) % period;
  const x1 = (x0 + 1) % period, y1 = (y0 + 1) % period;
  const a = hashi(x0, y0, seed), b = hashi(x1, y0, seed);
  const c = hashi(x0, y1, seed), d = hashi(x1, y1, seed);
  const t = a + (b - a) * tx;
  return t + (c + (d - c) * tx - t) * ty;
}

/** Tileable fractal noise. Returns [0,1). */
export function fbm(x, y, period, octaves, seed, gain = 0.5) {
  let amp = 1, sum = 0, norm = 0, p = period;
  for (let i = 0; i < octaves; i++) {
    sum += amp * vnoise(x, y, p, seed + i * 1013);
    norm += amp;
    amp *= gain;
    p *= 2;
  }
  return sum / norm;
}

/** Ridged fractal noise — sharper crests, good for veins and chisel marks. */
export function ridged(x, y, period, octaves, seed) {
  let amp = 1, sum = 0, norm = 0, p = period;
  for (let i = 0; i < octaves; i++) {
    const n = 1 - Math.abs(vnoise(x, y, p, seed + i * 787) * 2 - 1);
    sum += amp * n * n;
    norm += amp;
    amp *= 0.45;
    p *= 2;
  }
  return sum / norm;
}

/**
 * Tileable Worley / cellular noise on a jittered grid.
 * Writes [f1, f2, dx, dy] into `out` (a length-4 array) to keep the inner
 * loops allocation free. Distances are in cell units, so f1 < 0.5 always.
 */
export function worley(x, y, cells, seed, jitter, out) {
  const fx = x * cells, fy = y * cells;
  const ix = Math.floor(fx), iy = Math.floor(fy);
  let f1 = 1e9, f2 = 1e9, bx = 0, by = 0;
  for (let dy = -1; dy <= 1; dy++) {
    for (let dx = -1; dx <= 1; dx++) {
      const cx = ix + dx, cy = iy + dy;
      const wx = ((cx % cells) + cells) % cells;
      const wy = ((cy % cells) + cells) % cells;
      const px = cx + 0.5 + (hashi(wx, wy, seed) - 0.5) * jitter;
      const py = cy + 0.5 + (hashi(wx, wy, seed + 5501) - 0.5) * jitter;
      const ox = px - fx, oy = py - fy;
      const d = Math.sqrt(ox * ox + oy * oy);
      if (d < f1) { f2 = f1; f1 = d; bx = ox; by = oy; }
      else if (d < f2) { f2 = d; }
    }
  }
  out[0] = f1; out[1] = f2; out[2] = bx; out[3] = by;
  return f1;
}

/**
 * Marble veining. Integer-frequency sine banding through a domain warp, which
 * is what gives stone its layered, folded look rather than random blotching.
 * Returns [0,1] where 1 is the centre of a vein.
 */
export function veins(x, y, freqX, freqY, warpAmt, sharp, seed) {
  const w = fbm(x, y, 3, 4, seed) - 0.5;
  const w2 = fbm(x, y, 7, 3, seed + 311) - 0.5;
  const p = freqX * x + freqY * y + (w * warpAmt + w2 * warpAmt * 0.35);
  const s = Math.abs(Math.sin(Math.PI * p));
  return Math.pow(1 - s, sharp);
}

/**
 * Heightfield -> tangent-space normal map bytes, wrapping at the edges.
 * Central differences: cheaper than Sobel and, at these resolutions, visually
 * identical once the texture is minified by the GPU.
 */
export function heightToNormal(h, size, strength, out) {
  const dst = out || new Uint8Array(size * size * 4);
  for (let y = 0; y < size; y++) {
    const yUp = ((y - 1) + size) % size, yDn = (y + 1) % size;
    for (let x = 0; x < size; x++) {
      const xL = ((x - 1) + size) % size, xR = (x + 1) % size;
      const dx = (h[y * size + xR] - h[y * size + xL]) * strength;
      const dy = (h[yDn * size + x] - h[yUp * size + x]) * strength;
      const nx = -dx, ny = -dy;
      const inv = 1 / Math.sqrt(nx * nx + ny * ny + 1);
      const o = (y * size + x) * 4;
      dst[o]     = clamp255((nx * inv * 0.5 + 0.5) * 255);
      dst[o + 1] = clamp255((ny * inv * 0.5 + 0.5) * 255);
      dst[o + 2] = clamp255((inv * 0.5 + 0.5) * 255);
      dst[o + 3] = 255;
    }
  }
  return dst;
}

export function clamp255(v) {
  return v < 0 ? 0 : v > 255 ? 255 : v | 0;
}

export const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);

export function mix(a, b, t) { return a + (b - a) * t; }

export function smoothstep(e0, e1, x) {
  const t = clamp01((x - e0) / (e1 - e0 || 1e-6));
  return t * t * (3 - 2 * t);
}

/**
 * Float -> half float bits. The studio environment is stored as RGBA16F so a
 * light source can be brighter than white; in 8 bits every source clips at
 * 1.0, every highlight is the same value, and metal loses its sparkle.
 */
export function toHalf(v) {
  if (!(v > 0)) return 0;
  if (v > 65504) v = 65504;
  if (v < 6.103515625e-5) return Math.round(v / 5.9604644775390625e-8) & 0x3ff;
  const e = Math.floor(Math.log2(v));
  const m = Math.round((v / Math.pow(2, e) - 1) * 1024);
  let ee = e + 15, mm = m;
  if (mm === 1024) { mm = 0; ee += 1; }
  if (ee > 30) return 0x7bff;
  if (ee < 1) return 0;
  return (ee << 10) | mm;
}
