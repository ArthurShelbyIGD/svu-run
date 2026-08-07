// What the room actually LOOKS LIKE, as numbers, without rendering anything.
//
// A capture takes 40-180 s and tells you what the cape looks like. This takes
// 200 ms and tells you what the cape is looking AT, which is the thing env.js
// controls. Use it to reject an idea before spending three minutes proving it,
// and then still capture, because the renderer has a vote.
//
// Three readouts:
//
//   --hist      radiance histogram over the whole sphere, solid-angle weighted,
//               plus total flux. Total flux is the number to hold roughly
//               constant when restructuring the room: it is what a ROUGH
//               surface integrates, so it is the first-order predictor of
//               whether the hall gets brighter. Redistributing that same flux
//               between "large and hard-edged" and "small and everywhere" is
//               what changes a mirror without changing the corridor.
//
//   --az EL     the azimuth profile at one elevation, in 5-degree buckets.
//               THE CAPE IS A ROW OF VERTICAL CYLINDERS, so a horizontal scan
//               of the room at roughly eye level IS the cape's histogram. If
//               this row is smooth, the cape is satin no matter what the
//               material says. Azimuth here is env.js's own convention:
//               0 = +x, 90 = +z (down the corridor, ahead), 180 = -x,
//               270 = -z (behind the runner — THE HALF THE CAPE REFLECTS).
//
//   --cape      the cape's own sample: the mirror directions a bell-shaped
//               skirt sends to a camera 3.85 m behind it, and the p95/p50 of
//               the radiance it finds there. This is an upper bound on what the
//               render can produce, and it is free.
//
//   node src/mat/envstat.mjs --hist --cape --az 0 --az -12

import { buildStudioEnvFaces } from './env.js';

const argv = process.argv.slice(2);
const SIZE = 256;

// Decode half-float back to a Number. env.js stores RGBA16F; there is no point
// measuring the 8-bit fallback, since every preset that matters uses the float.
function fromHalf(h) {
  const s = (h & 0x8000) ? -1 : 1;
  let e = (h >> 10) & 0x1f;
  let m = h & 0x3ff;
  if (e === 0) return s * m * 5.9604644775390625e-8;
  if (e === 31) return m ? NaN : s * Infinity;
  return s * Math.pow(2, e - 15) * (1 + m / 1024);
}

const faces = buildStudioEnvFaces(SIZE, true);

/** Direction of texel (f, x, y), and its solid angle. */
function dirOf(f, x, y) {
  const u = (2 * (x + 0.5)) / SIZE - 1;
  const v = 1 - (2 * (y + 0.5)) / SIZE;
  let dx, dy, dz;
  switch (f) {
    case 0: dx = 1; dy = v; dz = -u; break;
    case 1: dx = -1; dy = v; dz = u; break;
    case 2: dx = u; dy = 1; dz = -v; break;
    case 3: dx = u; dy = -1; dz = v; break;
    case 4: dx = u; dy = v; dz = 1; break;
    default: dx = -u; dy = v; dz = -1;
  }
  const inv = 1 / Math.hypot(dx, dy, dz);
  // dA on the cube face is (2/SIZE)^2; project to the sphere with 1/r^3.
  const dOmega = (2 / SIZE) * (2 / SIZE) * inv * inv * inv;
  return [dx * inv, dy * inv, dz * inv, dOmega];
}

function lumAt(f, x, y) {
  const o = (y * SIZE + x) * 4;
  const d = faces[f];
  return 0.2126 * fromHalf(d[o]) + 0.7152 * fromHalf(d[o + 1]) + 0.0722 * fromHalf(d[o + 2]);
}

if (argv.includes('--hist')) {
  const bins = [0, 0.02, 0.05, 0.1, 0.3, 1, 3, 10, 30, 100, 1e9];
  const acc = new Array(bins.length - 1).fill(0);
  const flux = new Array(bins.length - 1).fill(0);
  let total = 0, omega = 0, peak = 0;
  for (let f = 0; f < 6; f++) {
    for (let y = 0; y < SIZE; y++) {
      for (let x = 0; x < SIZE; x++) {
        const L = lumAt(f, x, y);
        const dO = dirOf(f, x, y)[3];
        total += L * dO; omega += dO;
        if (L > peak) peak = L;
        for (let b = 0; b < acc.length; b++) {
          if (L >= bins[b] && L < bins[b + 1]) { acc[b] += dO; flux[b] += L * dO; break; }
        }
      }
    }
  }
  console.log(`sphere  omega ${omega.toFixed(3)} sr (4pi = 12.566)`);
  console.log(`FLUX    ${total.toFixed(3)}   mean radiance ${(total / omega).toFixed(4)}   peak ${peak.toFixed(1)}`);
  for (let b = 0; b < acc.length; b++) {
    const hi = bins[b + 1] > 1e8 ? 'inf' : bins[b + 1];
    console.log(`  L ${String(bins[b]).padStart(5)}..${String(hi).padEnd(5)}` +
      `  omega ${acc[b].toFixed(4).padStart(9)} (${(100 * acc[b] / omega).toFixed(2).padStart(6)}%)` +
      `  flux ${flux[b].toFixed(3).padStart(8)} (${(100 * flux[b] / total).toFixed(1).padStart(5)}%)`);
  }
}

// Sample the sphere at a given elevation by direct lookup rather than by
// scanning texels, so the buckets are even in azimuth.
function sampleDir(dx, dy, dz) {
  const ax = Math.abs(dx), ay = Math.abs(dy), az = Math.abs(dz);
  let f, u, v, ma;
  if (ax >= ay && ax >= az) {
    ma = ax; f = dx > 0 ? 0 : 1;
    u = dx > 0 ? -dz / ma : dz / ma; v = dy / ma;
  } else if (ay >= az) {
    ma = ay; f = dy > 0 ? 2 : 3;
    u = dx / ma; v = dy > 0 ? -dz / ma : dz / ma;
  } else {
    ma = az; f = dz > 0 ? 4 : 5;
    u = dz > 0 ? dx / ma : -dx / ma; v = dy / ma;
  }
  const x = Math.min(SIZE - 1, Math.max(0, Math.floor(((u + 1) * SIZE) / 2)));
  const y = Math.min(SIZE - 1, Math.max(0, Math.floor(((1 - v) * SIZE) / 2)));
  return lumAt(f, x, y);
}

for (let i = 0; i < argv.length; i++) {
  if (argv[i] !== '--az') continue;
  const el = (parseFloat(argv[i + 1]) * Math.PI) / 180;
  const cy = Math.sin(el), cr = Math.cos(el);
  const out = [];
  for (let a = 0; a < 72; a++) {
    const th = ((a + 0.5) / 72) * Math.PI * 2;
    out.push(sampleDir(cr * Math.cos(th), cy, cr * Math.sin(th)));
  }
  console.log(`azimuth profile at elevation ${argv[i + 1]} deg  (0=+x 90=+z 180=-x 270=-z)`);
  for (let r = 0; r < 4; r++) {
    const seg = out.slice(r * 18, r * 18 + 18);
    console.log(`  ${String(r * 90).padStart(3)}..${r * 90 + 90}  ` +
      seg.map((L) => (L >= 100 ? '###' : L >= 10 ? String(Math.round(L)).padStart(3)
        : L >= 1 ? L.toFixed(1) : L >= 0.1 ? '.' + Math.round(L * 10) : ' . ')).join(' '));
  }
}

if (argv.includes('--cape')) {
  // A fluted bell seen from 3.85 m behind and 0.28 m above its centre. Each
  // sample is a point on the bell; its normal sweeps in azimuth across the
  // flutes and tilts outward down the flare. Mirror-reflect the view direction
  // about that normal and look up what is there. Not the render — the render
  // adds four analytic lamps, a clear coat and a tone map — but it is the part
  // of the render env.js is responsible for, isolated.
  const vals = [];
  const capeDirs = [];
  for (let iu = 0; iu < 220; iu++) {
    // azimuth around the bell: +-78 degrees off straight-back is what a
    // straight-on elevation actually shows before the sides turn edge-on.
    const phi = ((iu / 219) * 2 - 1) * 1.36;
    for (let iv = 0; iv < 40; iv++) {
      const t = iv / 39;                      // 0 at the yoke, 1 at the hem
      const flare = 0.20 + 0.55 * t;          // normal tilts outward down the bell
      // surface point, in a frame where the runner faces +z and the cape's
      // outward direction is -z
      const nr = Math.hypot(1, flare);
      let nx = Math.sin(phi) / nr, ny = flare / nr, nz = -Math.cos(phi) / nr;
      const px = Math.sin(phi) * (0.16 + 0.30 * t);
      const py = 0.95 - 0.45 * t;
      const pz = -0.10 - 0.16 * t;
      // view direction, surface -> camera
      let vx = 0 - px, vy = 1.30 - py, vz = -3.85 - pz;
      const vl = Math.hypot(vx, vy, vz); vx /= vl; vy /= vl; vz /= vl;
      const d = nx * vx + ny * vy + nz * vz;
      if (d <= 0.03) continue;                // back-facing at this camera
      const rx = 2 * d * nx - vx, ry = 2 * d * ny - vy, rz = 2 * d * nz - vz;
      vals.push(sampleDir(rx, ry, rz));
      const rl = Math.hypot(rx, ry, rz);
      let az = (Math.atan2(rz / rl, rx / rl) * 180) / Math.PI;
      if (az < 0) az += 360;
      capeDirs.push([az, (Math.asin(ry / rl) * 180) / Math.PI]);
    }
  }
  // WHERE the cape looks, as a 2-D histogram, because that is what decides
  // where a card has to go. Azimuth in env.js's convention, elevation in
  // degrees. Anything outside the cells this prints is invisible to the cape.
  const grid = new Map();
  for (const [ax, ay] of capeDirs) {
    const k = `${Math.floor(ax / 15) * 15},${Math.floor(ay / 10) * 10}`;
    grid.set(k, (grid.get(k) || 0) + 1);
  }
  const top = [...grid.entries()].sort((a, b) => b[1] - a[1]).slice(0, 16);
  console.log('cape mirror directions (az deg, el deg) -> % of cape samples');
  for (const [k, n] of top) {
    console.log(`  az ${k.split(',')[0].padStart(4)}..  el ${k.split(',')[1].padStart(4)}..` +
      `  ${((100 * n) / capeDirs.length).toFixed(1).padStart(5)}%`);
  }

  vals.sort((a, b) => a - b);
  const q = (p) => vals[Math.min(vals.length - 1, Math.floor(vals.length * p))];
  console.log(`cape mirror sample  n ${vals.length}`);
  console.log(`  p05 ${q(0.05).toFixed(3)}  p25 ${q(0.25).toFixed(3)}  p50 ${q(0.5).toFixed(3)}` +
    `  p75 ${q(0.75).toFixed(3)}  p95 ${q(0.95).toFixed(3)}  max ${vals[vals.length - 1].toFixed(1)}`);
  console.log(`  P95/P50 ${(q(0.95) / Math.max(q(0.5), 1e-6)).toFixed(2)}`);
}
