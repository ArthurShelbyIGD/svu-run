// char/pave.js — pavé as GEOMETRY.
//
// WHY THIS FILE EXISTS
//
// The character shipped with pavé implemented as a tiled normal map. A critic
// looking at the rendered frames described the result as "a grey knitted sponge
// ball": at gameplay distance each mapped stone covered two to four pixels, and
// a two-pixel normal-map bump averages out to flat matte grey. Worse, the
// silhouette stayed a perfectly smooth arc — and a smooth outline on a
// stone-set surface is the single most obvious tell that the stones are fake.
//
// Real pavé does three things a normal map cannot:
//
//   1. It CRENELLATES THE SILHOUETTE. The outline of the reference piece is
//      beaded, not smooth. That read survives at any distance and at any
//      resolution, because it is geometry.
//   2. Each stone has a FLAT TABLE FACET at its own angle. A field of small
//      mirrors at randomised angles is what makes jewellery sparkle: as the
//      character moves, individual stones flare and go dark independently.
//      A shared normal map makes every stone flare at the same instant.
//   3. There are real GAPS between stones, and the dark setting metal shows
//      through them. That is where the contrast comes from.
//
// This module walks any parametric surface, lays stones out at a CONSTANT
// PHYSICAL PITCH regardless of which body part it is on (the previous build's
// stones visibly changed size between head, torso and boots), and emits them
// all as one merged part — so the entire hood is still a single draw call.
//
// Runs at init() only. See ARCHITECTURE §4.

const _p = [0, 0, 0];
const _pu = [0, 0, 0];
const _pv = [0, 0, 0];

/**
 * Position + orthonormal frame at (u, v) on a parametric surface.
 *
 * The normal is derived from the surface tangents and then oriented outward
 * against a reference centre. Deriving the sign from the tangents alone means
 * knowing each surface's parametrisation handedness, which is exactly the class
 * of mistake that shipped a hood rendered inside-out once already (see the
 * winding note at the top of geom.js).
 */
function frameAt(surf, u, v, cx, cy, cz, F) {
  const h = 8e-4;
  surf(u, v, _p);
  surf(u + h, v, _pu);
  const back = v > 1 - h;
  surf(u, back ? v - h : v + h, _pv);
  const s = back ? -1 : 1;

  const tux = _pu[0] - _p[0], tuy = _pu[1] - _p[1], tuz = _pu[2] - _p[2];
  const tvx = (_pv[0] - _p[0]) * s, tvy = (_pv[1] - _p[1]) * s, tvz = (_pv[2] - _p[2]) * s;

  let nx = tuy * tvz - tuz * tvy;
  let ny = tuz * tvx - tux * tvz;
  let nz = tux * tvy - tuy * tvx;
  let nl = Math.hypot(nx, ny, nz);
  if (nl < 1e-12) { nx = _p[0] - cx; ny = _p[1] - cy; nz = _p[2] - cz; nl = Math.hypot(nx, ny, nz) || 1; }
  nx /= nl; ny /= nl; nz /= nl;
  // orient outward
  if (nx * (_p[0] - cx) + ny * (_p[1] - cy) + nz * (_p[2] - cz) < 0) { nx = -nx; ny = -ny; nz = -nz; }

  // e1: the u tangent, projected off the normal
  const d = tux * nx + tuy * ny + tuz * nz;
  let ex = tux - nx * d, ey = tuy - ny * d, ez = tuz - nz * d;
  let el = Math.hypot(ex, ey, ez);
  if (el < 1e-12) { ex = 1 - nx * nx; ey = -nx * ny; ez = -nx * nz; el = Math.hypot(ex, ey, ez) || 1; }
  ex /= el; ey /= el; ez /= el;
  // e2 = n x e1, so that e1 x e2 = n
  const fx = ny * ez - nz * ey, fy = nz * ex - nx * ez, fz = nx * ey - ny * ex;

  F[0] = _p[0]; F[1] = _p[1]; F[2] = _p[2];
  F[3] = nx; F[4] = ny; F[5] = nz;
  F[6] = ex; F[7] = ey; F[8] = ez;
  F[9] = fx; F[10] = fy; F[11] = fz;
}

/** Arc length of the v = const ring, sampled. Drives stones-per-row. */
function ringLength(surf, v, samples, uOpen) {
  let len = 0;
  const a = [0, 0, 0], b = [0, 0, 0];
  surf(0, v, a);
  for (let i = 1; i <= samples; i++) {
    const u = i / samples;
    surf(uOpen ? u : (i === samples ? 1 : u), v, b);
    len += Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]);
    a[0] = b[0]; a[1] = b[1]; a[2] = b[2];
  }
  return len;
}

/** Arc length down a u = const meridian, sampled. Drives the row count. */
function meridianLength(surf, u, v0, v1, samples) {
  let len = 0;
  const a = [0, 0, 0], b = [0, 0, 0];
  surf(u, v0, a);
  for (let i = 1; i <= samples; i++) {
    surf(u, v0 + (v1 - v0) * (i / samples), b);
    len += Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]);
    a[0] = b[0]; a[1] = b[1]; a[2] = b[2];
  }
  return len;
}

/**
 * Lay a field of cut stones over a parametric surface.
 *
 * @param surf  (u, v, out[3]) => void — the SAME function used to build the
 *              base shell, so the stones sit exactly on it rather than
 *              floating off a nominal sphere.
 * @param o.pitch    centre-to-centre spacing IN METRES. One number for the
 *                   whole character: this is what makes the stones the same
 *                   physical size on the hood, the torso and the hands.
 * @param o.rng      ctx.rng — facet rotation and micro-jitter. Never Math.random.
 * @returns {{pos:number[], uv:number[], idx:number[], count:number}}
 */
export function stoneField(surf, o) {
  const pitch = o.pitch;
  const v0 = o.v0 === undefined ? 0 : o.v0;
  const v1 = o.v1 === undefined ? 1 : o.v1;
  const rng = o.rng;
  const F = o.facets || 6;
  const rad = o.rad === undefined ? pitch * 0.495 : o.rad;
  // How proud of the setting the stone sits. This number IS the crenellated
  // silhouette; too small and we are back to a smooth arc with a texture on it.
  const rise = o.rise === undefined ? pitch * 0.135 : o.rise;
  const table = o.table === undefined ? 0.76 : o.table;
  const uOpen = !!o.uOpen;
  const uPad = o.uPad === undefined ? 0 : o.uPad;
  const cx = o.cx || 0, cy = o.cy || 0, cz = o.cz || 0;
  const jitter = o.jitter === undefined ? 0.30 : o.jitter;
  const tilt = o.tilt === undefined ? 0.10 : o.tilt;
  // (x, y, z) => true to leave this cell bare. The hood uses it to open a face
  // aperture: the test is "inside the face sphere", so the opening is shaped by
  // the actual intersection of the two forms rather than by a guessed uv box.
  const omit = o.omit || null;

  const pos = [], uv = [], idx = [];
  const fr = new Float32Array(12);

  // Rows are spaced at the HEXAGONAL pitch (sqrt(3)/2), not the linear one.
  // At the linear spacing the rows stood off each other and the field rendered
  // as a stack of visible horizontal bands — a bracelet, not a pavé field.
  const mer = meridianLength(surf, 0.27, v0, v1, 26);
  const rows = Math.max(1, Math.round(mer / (pitch * 0.868)));
  let count = 0;

  for (let r = 0; r < rows; r++) {
    const v = v0 + (v1 - v0) * ((r + 0.5) / rows);
    const ring = ringLength(surf, v, 40, uOpen);
    let per = Math.round(ring / pitch);
    if (uOpen) { if (per < 1) per = 1; } else if (per < 3) per = 3;
    // Stagger alternate rows, then push the whole row by a random fraction.
    // Square-packed stones read as a grid — a waffle, which is precisely the
    // "knitted" complaint; a strict half-offset still leaves visible concentric
    // rings, because every row starts at the same seam.
    const stag = ((r & 1) ? 0.5 : 0) + rng() * 0.5;

    for (let j = 0; j < per; j++) {
      let u = uOpen
        ? uPad + (1 - 2 * uPad) * ((j + 0.5) / per)
        : ((j + stag) / per);
      u += (rng() - 0.5) * jitter / per;
      let vv = v + (rng() - 0.5) * jitter * (v1 - v0) / rows;
      if (vv < 0) vv = 0; else if (vv > 1) vv = 1;

      frameAt(surf, uOpen ? Math.min(1, Math.max(0, u)) : (u < 0 ? u + 1 : (u > 1 ? u - 1 : u)),
        vv, cx, cy, cz, fr);

      const px = fr[0], py = fr[1], pz = fr[2];
      if (omit && omit(px, py, pz)) continue;
      let nx = fr[3], ny = fr[4], nz = fr[5];
      const e1x = fr[6], e1y = fr[7], e1z = fr[8];
      const e2x = fr[9], e2y = fr[10], e2z = fr[11];

      // Tilt each stone's table a little off the surface normal. Set stones in
      // a real piece are never perfectly co-planar with the form, and this is
      // what makes them flare INDEPENDENTLY as the light moves — a uniform
      // field flashes all at once and reads as a printed texture.
      const ta = (rng() - 0.5) * tilt, tb = (rng() - 0.5) * tilt;
      let mx = nx + e1x * ta + e2x * tb;
      let my = ny + e1y * ta + e2y * tb;
      let mz = nz + e1z * ta + e2z * tb;
      const ml = Math.hypot(mx, my, mz) || 1;
      mx /= ml; my /= ml; mz /= ml;

      const rr = rad * (0.88 + 0.24 * rng());
      const rt = rr * table;
      const hi = rise * (0.82 + 0.36 * rng());
      const ph = rng() * Math.PI * 2;

      const base = pos.length / 3;
      // table centre
      pos.push(px + mx * hi, py + my * hi, pz + mz * hi);
      uv.push(0.5, 0.5);
      // table ring, then girdle ring
      for (let k = 0; k < F; k++) {
        const a = ph + (k / F) * Math.PI * 2;
        const ca = Math.cos(a), sa = Math.sin(a);
        // table sits on the tilted plane
        const dx = e1x * ca + e2x * sa, dy = e1y * ca + e2y * sa, dz = e1z * ca + e2z * sa;
        pos.push(px + mx * hi + dx * rt, py + my * hi + dy * rt, pz + mz * hi + dz * rt);
        uv.push(0.5 + ca * 0.3, 0.5 + sa * 0.3);
      }
      for (let k = 0; k < F; k++) {
        const a = ph + (k / F) * Math.PI * 2;
        const ca = Math.cos(a), sa = Math.sin(a);
        const dx = e1x * ca + e2x * sa, dy = e1y * ca + e2y * sa, dz = e1z * ca + e2z * sa;
        // girdle sunk slightly INTO the setting, so no gap opens at the base
        const gh = -rise * 0.55;
        pos.push(px + nx * gh + dx * rr, py + ny * gh + dy * rr, pz + nz * gh + dz * rr);
        uv.push(0.5 + ca * 0.5, 0.5 + sa * 0.5);
      }

      const T = base + 1, G = base + 1 + F;
      // table fan — winding per the rule in geom.js: outward = (p2-p0)x(p1-p0)
      for (let k = 0; k < F; k++) {
        const k2 = (k + 1) % F;
        idx.push(base, T + k2, T + k);
      }
      // crown facets
      for (let k = 0; k < F; k++) {
        const k2 = (k + 1) % F;
        idx.push(T + k, T + k2, G + k, T + k2, G + k2, G + k);
      }
      count++;
    }
  }

  return { pos, uv, idx, count };
}

/**
 * Beading: the tiny raised grains that hold each stone in a real pavé setting.
 *
 * Four per stone is how a jeweller does it and is far too expensive here. One
 * grain per stone gap, only on the rows that fall on the SILHOUETTE, buys most
 * of the read for a fraction of the cost — the grains that matter are the ones
 * breaking the outline.
 */
export function beadField(surf, o) {
  const pitch = o.pitch;
  const rng = o.rng;
  const rad = o.rad === undefined ? pitch * 0.14 : o.rad;
  const v0 = o.v0 === undefined ? 0 : o.v0;
  const v1 = o.v1 === undefined ? 1 : o.v1;
  const cx = o.cx || 0, cy = o.cy || 0, cz = o.cz || 0;

  const pos = [], uv = [], idx = [];
  const fr = new Float32Array(12);
  const mer = meridianLength(surf, 0.27, v0, v1, 20);
  const rows = Math.max(1, Math.round(mer / pitch));

  for (let r = 0; r <= rows; r++) {
    const v = v0 + (v1 - v0) * (r / rows);
    const ring = ringLength(surf, v, 32, false);
    const per = Math.max(3, Math.round(ring / pitch));
    for (let j = 0; j < per; j++) {
      const u = (j + ((r & 1) ? 0 : 0.5)) / per;
      frameAt(surf, u, v, cx, cy, cz, fr);
      const px = fr[0] + fr[3] * rad * 0.3;
      const py = fr[1] + fr[4] * rad * 0.3;
      const pz = fr[2] + fr[5] * rad * 0.3;
      const base = pos.length / 3;
      // octahedral bead: 6 verts, 8 tris, and it catches a hard highlight
      const ax = [fr[6], fr[7], fr[8]], bx = [fr[9], fr[10], fr[11]], nn = [fr[3], fr[4], fr[5]];
      const s = rad * (0.8 + 0.4 * rng());
      pos.push(px + nn[0] * s, py + nn[1] * s, pz + nn[2] * s);
      pos.push(px - nn[0] * s * 0.5, py - nn[1] * s * 0.5, pz - nn[2] * s * 0.5);
      pos.push(px + ax[0] * s, py + ax[1] * s, pz + ax[2] * s);
      pos.push(px + bx[0] * s, py + bx[1] * s, pz + bx[2] * s);
      pos.push(px - ax[0] * s, py - ax[1] * s, pz - ax[2] * s);
      pos.push(px - bx[0] * s, py - bx[1] * s, pz - bx[2] * s);
      for (let k = 0; k < 6; k++) uv.push(0.5, 0.5);
      const T = base, B = base + 1, E = base + 2;
      for (let k = 0; k < 4; k++) {
        const a = E + k, b = E + ((k + 1) % 4);
        idx.push(T, b, a);
        idx.push(B, a, b);
      }
    }
  }
  return { pos, uv, idx };
}
