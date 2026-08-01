// char/cape.js — a real simulated cape.
//
// The camera sits behind the character for essentially the whole game, so the
// cape is the single most visible thing in the product. A static wing bolted to
// the back is the difference between "a toy" and "a runner".
//
// HOW IT WORKS
// A grid of verlet particles with distance constraints, pinned along a collar
// arc at the shoulders. Simulated in the character's LOCAL space, which is the
// important decision here: it means the cape does not have to chase the
// character's world transform (which teleports through corners — see the path
// model in track/path.js), and it makes the whole thing deterministic.
//
// Motion the player should feel is injected as acceleration instead:
//
//   gravity   constant -Y
//   wind      -Z, scaled by running speed, with per-particle turbulence
//   inertia   MINUS the character's own acceleration, in local axes
//
// That last term is the one that earns its keep, and it is free. In the air the
// character accelerates downward at g, so the inertial term is +g and exactly
// cancels gravity: the cape goes weightless and flares straight out behind on
// every jump, with no special case anywhere. On landing the character
// decelerates hard, the term flips, and the cape slams down and settles. Corner
// swing falls out of the same mechanism from the yaw rate.
//
// Simulation runs in fixedUpdate (deterministic, and the capture harness fast-
// forwards through fixedUpdate only, so poses are correct). Vertex upload
// happens in renderUpdate. Nothing here allocates after init().

import { Mesh, VertexData } from '../core/bjs.js';

const GRAV = 14.0;          // heavier than real g: cloth at this scale reads limp otherwise
const DAMP = 0.972;
const MAXDT = 1 / 50;

export class Cape {
  /**
   * @param {number} cols  particles across the cape
   * @param {number} rows  particles down the cape
   */
  constructor(cols, rows, opts) {
    this.cols = cols;
    this.rows = rows;
    this.iters = opts.iters;
    this.len = opts.len;
    this.halfW0 = opts.halfW0;     // half width at the collar
    this.halfW1 = opts.halfW1;     // half width at the hem — flare
    this.scallops = opts.scallops;
    this.colsPerRib = opts.colsPerRib;
    this.hemCut = opts.hemCut;
    this.shoulderR = opts.shoulderR;
    this.shoulderSpread = opts.shoulderSpread;

    const n = cols * rows;
    this.n = n;
    this.px = new Float32Array(n); this.py = new Float32Array(n); this.pz = new Float32Array(n);
    this.ox = new Float32Array(n); this.oy = new Float32Array(n); this.oz = new Float32Array(n);
    this.rx = new Float32Array(n); this.ry = new Float32Array(n); this.rz = new Float32Array(n);
    this.pin = new Uint8Array(n);
    this.turb = new Float32Array(n);
    this.side = new Float32Array(n);   // -1 .. +1 across the width
    this.down = new Float32Array(n);   // 0 .. 1 down the length

    // constraints, flat arrays: [a, b] and rest length
    const ca = [], cb = [], cl = [];
    const link = (i, j) => {
      ca.push(i); cb.push(j); cl.push(0);
    };
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        const i = r * cols + c;
        if (c + 1 < cols) link(i, i + 1);                       // structural across
        if (r + 1 < rows) link(i, i + cols);                    // structural down
        if (c + 1 < cols && r + 1 < rows) link(i, i + cols + 1); // shear
        if (c > 0 && r + 1 < rows) link(i, i + cols - 1);        // shear
        if (c + 2 < cols) link(i, i + 2);                        // bend, keeps it from creasing
        if (r + 2 < rows) link(i, i + 2 * cols);
      }
    }
    this.ca = new Int32Array(ca);
    this.cb = new Int32Array(cb);
    this.cl = new Float32Array(cl);

    // mesh grid indices, built once
    const idx = [];
    for (let r = 0; r < rows - 1; r++) {
      for (let c = 0; c < cols - 1; c++) {
        const a = r * cols + c, b = a + 1, d = a + cols, e = d + 1;
        idx.push(a, d, b, b, d, e);
      }
    }
    this.indices = idx;
    this.positions = new Float32Array(n * 3);
    this.normals = new Float32Array(n * 3);
    this.uvs = new Float32Array(n * 2);

    // driver state
    this.t = 0;
    this._lastVX = 0; this._lastVY = 0; this._lastYaw = 0;
    this.accX = 0; this.accY = 0; this.accZ = 0;
    this.wind = 0;
    this.bob = 0;
    this._prevBob = 0;

    this.mesh = null;
    this.trim = null;
    this._trimPos = null;
    this._trimNrm = null;
    this._trimRings = 0;
  }

  /** Rest shape. The hem is scalloped, which is where the NFT's bat wing goes. */
  _rest(c, r, out) {
    const u = this.cols === 1 ? 0 : c / (this.cols - 1);
    const v = this.rows === 1 ? 0 : r / (this.rows - 1);

    // length profile: longest down the middle, cut back into scallop cusps
    const cusp = 0.5 - 0.5 * Math.cos(u * this.scallops * Math.PI * 2);
    const mid = 0.74 + 0.26 * Math.sin(Math.PI * u);
    const L = this.len * mid * (1 - this.hemCut * cusp);

    // collar: the top row wraps a shoulder arc, so it attaches like a garment
    const th = (u - 0.5) * this.shoulderSpread;
    const sx = Math.sin(th) * this.shoulderR;
    const sz = -Math.cos(th) * this.shoulderR * 0.62;

    const halfW = this.halfW0 + (this.halfW1 - this.halfW0) * v;
    const flare = (u - 0.5) * 2 * halfW;

    out[0] = sx + (flare - sx) * v;
    out[1] = -L * v;
    out[2] = sz - v * 0.10;
  }

  init(scene, matCape, matTrim, parent, uRep, vRep) {
    const tmp = [0, 0, 0];
    for (let r = 0; r < this.rows; r++) {
      for (let c = 0; c < this.cols; c++) {
        const i = r * this.cols + c;
        this._rest(c, r, tmp);
        this.rx[i] = tmp[0]; this.ry[i] = tmp[1]; this.rz[i] = tmp[2];
        this.px[i] = this.ox[i] = tmp[0];
        this.py[i] = this.oy[i] = tmp[1];
        this.pz[i] = this.oz[i] = tmp[2];
        this.pin[i] = r === 0 ? 1 : 0;
        this.turb[i] = (c * 0.62 + r * 0.34) % 6.28318;
        this.side[i] = this.cols > 1 ? (c / (this.cols - 1) - 0.5) * 2 : 0;
        this.down[i] = this.rows > 1 ? r / (this.rows - 1) : 0;
        const k = i * 2;
        this.uvs[k] = (c / (this.cols - 1)) * uRep;
        this.uvs[k + 1] = (r / (this.rows - 1)) * vRep;
      }
    }
    // rest lengths from the rest shape, not from the current state
    for (let k = 0; k < this.ca.length; k++) {
      const a = this.ca[k], b = this.cb[k];
      this.cl[k] = Math.hypot(this.rx[a] - this.rx[b], this.ry[a] - this.ry[b], this.rz[a] - this.rz[b]);
    }

    this._writePositions();
    this._computeNormals();

    const mesh = new Mesh('cape', scene);
    const vd = new VertexData();
    vd.positions = this.positions;
    vd.indices = this.indices;
    vd.normals = this.normals;
    vd.uvs = this.uvs;
    vd.applyToMesh(mesh, true);     // updatable
    mesh.material = matCape;
    mesh.parent = parent;
    mesh.isPickable = false;
    mesh.alwaysSelectAsActiveMesh = true;   // its bounds move; never cull it
    this.mesh = mesh;

    // --- silver ribs and hem trim ---
    // The cape material is dark chrome, which is correct for the reference but
    // reads as one flat black shape at gameplay distance — a hole cut in the
    // screen. Bone ribs down the scallop lines fix that: they catch the rim
    // light, they give the sheet structure, and they are where the NFT's bat
    // wing survives into a cape. Every strand is swept from the SIMULATED
    // particles, so the ribs flex with the cloth instead of floating over it.
    const strands = [];
    for (let c = 0; c < this.cols; c += this.colsPerRib) {
      const idx = new Int32Array(this.rows);
      const rad = new Float32Array(this.rows);
      for (let r = 0; r < this.rows; r++) {
        idx[r] = r * this.cols + c;
        rad[r] = 0.023 * (1 - 0.48 * (r / (this.rows - 1)));
      }
      strands.push({ idx, rad });
    }
    {
      const idx = new Int32Array(this.cols);
      const rad = new Float32Array(this.cols);
      const base = (this.rows - 1) * this.cols;
      for (let c = 0; c < this.cols; c++) { idx[c] = base + c; rad[c] = 0.013; }
      strands.push({ idx, rad });
    }
    this.strands = strands;
    this._buildStrandMesh(scene, matTrim, parent);

    return this;
  }

  /** Snap back to rest — used on death/restart so a new run starts clean. */
  reset() {
    for (let i = 0; i < this.n; i++) {
      this.px[i] = this.ox[i] = this.rx[i];
      this.py[i] = this.oy[i] = this.ry[i];
      this.pz[i] = this.oz[i] = this.rz[i];
    }
  }

  /**
   * One deterministic simulation step.
   * @param dt        fixed 1/60
   * @param speed     m/s along the track
   * @param aLocal    [ax, ay, az] the CHARACTER's acceleration in local axes
   * @param bobV      vertical velocity of the run cycle bob
   */
  step(dt, speed, ax, ay, az, bobV) {
    if (dt > MAXDT) dt = MAXDT;
    this.t += dt;

    // Wind grows with speed but saturates — a cape does not lie flat at 34m/s
    // and then keep going. The constants are tuned by LOOKING: at the start
    // speed the cape should trail at roughly 40 degrees off vertical, and at
    // top speed it should be streaming almost horizontally behind.
    const w = speed * 2.05;
    this.wind = w / (1 + w * 0.0095);

    const dt2 = dt * dt;
    const gx = -ax;
    // 0.8, not 1.0. At full strength the inertial term exactly cancels gravity
    // in freefall and the cape goes completely weightless — it flew clean over
    // the character's head on every jump. Leaving a fifth of the weight in
    // keeps the flare dramatic and keeps the cape behind the shoulders.
    const gy = -GRAV - ay * 0.80 - bobV * 26;
    const gz = -az;
    const tt = this.t;

    for (let i = 0; i < this.n; i++) {
      if (this.pin[i]) {
        this.px[i] = this.rx[i]; this.py[i] = this.ry[i]; this.pz[i] = this.rz[i];
        this.ox[i] = this.rx[i]; this.oy[i] = this.ry[i]; this.oz[i] = this.rz[i];
        continue;
      }
      // Turbulence. A cape driven only along -Z stays dead flat, which is what
      // the first pass looked like: a sheet of vinyl.
      //
      // The lateral term is multiplied by `side`, which runs -1 to +1 across
      // the width. That matters: an unsigned lateral force sums to a NET push
      // and the whole cape drifts off-axis, which read on screen as the cape
      // being blown sideways for no reason a player could see. Signed, it sums
      // to zero and produces a twist — the two halves fight, the sheet ripples,
      // and nothing drifts.
      const ph = tt * 5.2 + this.turb[i];
      const flutter = Math.sin(ph) * this.wind * 0.26 * this.side[i];
      // and a travelling wave running down the length, which is what the eye
      // actually recognises as cloth in the wind
      const wave = Math.sin(tt * 5.6 - this.down[i] * 6.0) * this.wind * 0.16;
      const gust = 0.86 + 0.14 * Math.sin(ph * 0.7);

      const vx = (this.px[i] - this.ox[i]) * DAMP;
      const vy = (this.py[i] - this.oy[i]) * DAMP;
      const vz = (this.pz[i] - this.oz[i]) * DAMP;
      this.ox[i] = this.px[i]; this.oy[i] = this.py[i]; this.oz[i] = this.pz[i];
      this.px[i] += vx + (gx + flutter) * dt2;
      this.py[i] += vy + (gy + this.wind * 0.30 + wave) * dt2;
      this.pz[i] += vz + (gz - this.wind * gust) * dt2;
    }

    const nC = this.ca.length;
    for (let it = 0; it < this.iters; it++) {
      for (let k = 0; k < nC; k++) {
        const a = this.ca[k], b = this.cb[k];
        const dx = this.px[b] - this.px[a];
        const dy = this.py[b] - this.py[a];
        const dz = this.pz[b] - this.pz[a];
        const d = Math.sqrt(dx * dx + dy * dy + dz * dz);
        if (d < 1e-6) continue;
        const diff = (d - this.cl[k]) / d * 0.5;
        const pa = this.pin[a], pb = this.pin[b];
        if (pa && pb) continue;
        const mx = dx * diff, my = dy * diff, mz = dz * diff;
        if (!pa) {
          this.px[a] += pb ? mx * 2 : mx;
          this.py[a] += pb ? my * 2 : my;
          this.pz[a] += pb ? mz * 2 : mz;
        }
        if (!pb) {
          this.px[b] -= pa ? mx * 2 : mx;
          this.py[b] -= pa ? my * 2 : my;
          this.pz[b] -= pa ? mz * 2 : mz;
        }
      }
      // body collision: two capsule-ish spheres, torso and hips, plus a hard
      // "stay behind" plane. Without this the cape saws through the character
      // on every stride, which is the classic tell of a fake cloth sim.
      for (let i = 0; i < this.n; i++) {
        if (this.pin[i]) continue;
        this._pushOut(i, 0, -0.16, 0.02, 0.34);
        this._pushOut(i, 0, -0.58, 0.00, 0.30);
        if (this.pz[i] > -0.02) this.pz[i] = -0.02;
      }
    }
  }

  _pushOut(i, cx, cy, cz, r) {
    const dx = this.px[i] - cx, dy = this.py[i] - cy, dz = this.pz[i] - cz;
    const d2 = dx * dx + dy * dy + dz * dz;
    if (d2 >= r * r || d2 < 1e-8) return;
    const d = Math.sqrt(d2), k = r / d;
    this.px[i] = cx + dx * k;
    this.py[i] = cy + dy * k;
    this.pz[i] = cz + dz * k;
  }

  _writePositions() {
    const p = this.positions;
    for (let i = 0; i < this.n; i++) {
      const k = i * 3;
      p[k] = this.px[i]; p[k + 1] = this.py[i]; p[k + 2] = this.pz[i];
    }
  }

  /** Grid normals by face accumulation. No allocation, no library call. */
  _computeNormals() {
    const n = this.normals, p = this.positions;
    n.fill(0);
    const idx = this.indices;
    for (let t = 0; t < idx.length; t += 3) {
      const a = idx[t] * 3, b = idx[t + 1] * 3, c = idx[t + 2] * 3;
      const e1x = p[b] - p[a], e1y = p[b + 1] - p[a + 1], e1z = p[b + 2] - p[a + 2];
      const e2x = p[c] - p[a], e2y = p[c + 1] - p[a + 1], e2z = p[c + 2] - p[a + 2];
      const nx = e1y * e2z - e1z * e2y;
      const ny = e1z * e2x - e1x * e2z;
      const nz = e1x * e2y - e1y * e2x;
      n[a] += nx; n[a + 1] += ny; n[a + 2] += nz;
      n[b] += nx; n[b + 1] += ny; n[b + 2] += nz;
      n[c] += nx; n[c + 1] += ny; n[c + 2] += nz;
    }
    for (let i = 0; i < n.length; i += 3) {
      const l = Math.sqrt(n[i] * n[i] + n[i + 1] * n[i + 1] + n[i + 2] * n[i + 2]);
      if (l > 1e-8) { n[i] /= l; n[i + 1] /= l; n[i + 2] /= l; }
    }
  }

  /**
   * Build one merged tube mesh covering every strand. Ribs and hem in a single
   * draw call, updatable, sized once at init.
   */
  _buildStrandMesh(scene, mat, parent) {
    const su = 6;
    this._strandSu = su;
    let vcount = 0, ring = su + 1;
    const idx = [];
    for (const st of this.strands) {
      const n = st.idx.length;
      st.base = vcount;
      for (let i = 0; i < n - 1; i++) {
        for (let j = 0; j < su; j++) {
          const a = vcount + i * ring + j, b = a + 1, c = a + ring, d = c + 1;
          idx.push(a, c, b, b, c, d);
        }
      }
      vcount += n * ring;
      // end caps, so a rib does not read as a hollow pipe at the tip
      const capA = vcount, capB = vcount + 1;
      vcount += 2;
      for (let j = 0; j < su; j++) {
        idx.push(capA, st.base + j + 1, st.base + j);
        const off = st.base + (n - 1) * ring;
        idx.push(capB, off + j, off + j + 1);
      }
      st.capA = capA; st.capB = capB;
    }
    this._strandPos = new Float32Array(vcount * 3);
    this._strandNrm = new Float32Array(vcount * 3);
    const uvs = new Float32Array(vcount * 2);
    for (const st of this.strands) {
      const n = st.idx.length;
      for (let i = 0; i < n; i++) {
        for (let j = 0; j <= su; j++) {
          const k = (st.base + i * ring + j) * 2;
          uvs[k] = j / su; uvs[k + 1] = (i / (n - 1)) * 4;
        }
      }
    }
    this._strandIdx = idx;
    this._updateStrands();

    const mesh = new Mesh('capeRibs', scene);
    const vd = new VertexData();
    vd.positions = this._strandPos;
    vd.indices = idx;
    vd.normals = this._strandNrm;
    vd.uvs = uvs;
    vd.applyToMesh(mesh, true);
    mesh.material = mat;
    mesh.parent = parent;
    mesh.isPickable = false;
    mesh.alwaysSelectAsActiveMesh = true;
    this.trim = mesh;
  }

  /**
   * Sweep every strand along the simulated particles.
   *
   * The frame comes from the cloth's own vertex normal rather than a
   * parallel-transport walk: the sheet already has a well-defined surface
   * normal each frame, it costs nothing extra, and it guarantees the ribs sit
   * flat on the cape instead of rolling as it twists.
   */
  _updateStrands() {
    const su = this._strandSu, ring = su + 1;
    const p = this._strandPos;
    const N = this.normals;
    for (let s = 0; s < this.strands.length; s++) {
      const st = this.strands[s];
      const ix = st.idx, rad = st.rad, n = ix.length;
      for (let i = 0; i < n; i++) {
        const pi = ix[i];
        const cx = this.px[pi], cy = this.py[pi], cz = this.pz[pi];
        const a = ix[i > 0 ? i - 1 : 0], b = ix[i < n - 1 ? i + 1 : n - 1];
        let tx = this.px[b] - this.px[a], ty = this.py[b] - this.py[a], tz = this.pz[b] - this.pz[a];
        const tl = Math.sqrt(tx * tx + ty * ty + tz * tz) || 1;
        tx /= tl; ty /= tl; tz /= tl;
        const k = pi * 3;
        let nx = N[k], ny = N[k + 1], nz = N[k + 2];
        // binormal = t x n, then re-orthogonalise n = b x t
        let bx = ty * nz - tz * ny, by = tz * nx - tx * nz, bz = tx * ny - ty * nx;
        const bl = Math.sqrt(bx * bx + by * by + bz * bz) || 1;
        bx /= bl; by /= bl; bz /= bl;
        nx = by * tz - bz * ty; ny = bz * tx - bx * tz; nz = bx * ty - by * tx;
        const r = rad[i];
        let w = (st.base + i * ring) * 3;
        for (let j = 0; j <= su; j++) {
          const ang = (j / su) * Math.PI * 2;
          const ca = Math.cos(ang) * r, sa = Math.sin(ang) * r;
          p[w++] = cx + nx * ca + bx * sa;
          p[w++] = cy + ny * ca + by * sa;
          p[w++] = cz + nz * ca + bz * sa;
        }
      }
      let w = st.capA * 3;
      const i0 = ix[0], i1 = ix[n - 1];
      p[w++] = this.px[i0]; p[w++] = this.py[i0]; p[w++] = this.pz[i0];
      p[w++] = this.px[i1]; p[w++] = this.py[i1]; p[w++] = this.pz[i1];
    }
    this._accumulateNormals(p, this._strandIdx, this._strandNrm);
  }

  _accumulateNormals(p, idx, n) {
    n.fill(0);
    for (let t = 0; t < idx.length; t += 3) {
      const a = idx[t] * 3, b = idx[t + 1] * 3, c = idx[t + 2] * 3;
      const e1x = p[b] - p[a], e1y = p[b + 1] - p[a + 1], e1z = p[b + 2] - p[a + 2];
      const e2x = p[c] - p[a], e2y = p[c + 1] - p[a + 1], e2z = p[c + 2] - p[a + 2];
      const cx = e1y * e2z - e1z * e2y, cy = e1z * e2x - e1x * e2z, cz = e1x * e2y - e1y * e2x;
      n[a] += cx; n[a + 1] += cy; n[a + 2] += cz;
      n[b] += cx; n[b + 1] += cy; n[b + 2] += cz;
      n[c] += cx; n[c + 1] += cy; n[c + 2] += cz;
    }
    for (let i = 0; i < n.length; i += 3) {
      const l = Math.sqrt(n[i] * n[i] + n[i + 1] * n[i + 1] + n[i + 2] * n[i + 2]);
      if (l > 1e-8) { n[i] /= l; n[i + 1] /= l; n[i + 2] /= l; }
    }
  }

  /** Presentation: push the simulated vertices to the GPU. */
  upload() {
    if (!this.mesh) return;
    this._writePositions();
    this._computeNormals();
    this.mesh.updateVerticesData('position', this.positions, false, false);
    this.mesh.updateVerticesData('normal', this.normals, false, false);
    if (this.trim) {
      this._updateStrands();
      this.trim.updateVerticesData('position', this._strandPos, false, false);
      this.trim.updateVerticesData('normal', this._strandNrm, false, false);
    }
  }

  dispose() {
    if (this.mesh) this.mesh.dispose();
    if (this.trim) this.trim.dispose();
  }
}
