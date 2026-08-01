// char/cape.js — the cape. A POLISHED SILVER FLARED SKIRT, not cloth.
//
// The camera sits behind the character for essentially the whole game, so this
// is the single most visible object in the product. It was previously a verlet
// CLOTH sim: a big crumpled sheet that engulfed the character. Comparing that
// against docs/reference-rear.png — the first rear view of the NFT anyone here
// has had — it was wrong in every dimension that matters.
//
// WHAT THE REFERENCE ACTUALLY SHOWS
//
//   * Hammered-and-polished precious metal, not fabric. It reads like the boots
//     and the hands: the same mirror silver.
//   * VERTICAL FLUTING. Ten-odd pleats running top to bottom, each a convex
//     lobe with a hard crease between. This is the load-bearing detail: a
//     mirror-finish sheet with no fluting is an unreadable white blob, and the
//     flutes are what break the reflection into alternating bright and dark
//     bands so the form reads at all.
//   * A SCALLOPED HEM whose waves are in phase with the flutes — each lobe
//     hangs low, each crease pulls up — with a fine gold wire trim following it.
//   * It hangs from a yoke at the shoulders, flares out and down, and stops
//     just above the boots. It does not wrap over the body and it is not a
//     billowing flag.
//
// HOW THIS IS BUILT, AND WHY IT IS NOT A CLOTH SIM
//
// A cloth sim cannot hold this silhouette. Distance constraints plus gravity
// collapse fluting within a second — that is what cloth is FOR. So the rest
// shape is modelled exactly (a partial elliptical cone, fluted, scalloped) and
// the simulation is demoted to a BEND applied on top of it:
//
//   * the skirt is a chain of ROWS; each row is a damped angular spring that
//     chases the row above it plus its share of an external drive. That is
//     rows-many scalars of dynamics — about a dozen — instead of hundreds of
//     particles with thousands of constraint solves.
//   * the drive is: a backward lift proportional to running speed, a lateral
//     swing from the character's lateral acceleration (so it swings out through
//     corners and lane changes), and a vertical term from jump/land/bob.
//   * because the chain accumulates down the rows, the swing travels visibly
//     down the skirt and the hem overshoots and settles. That is the life.
//   * at rest every angle is zero, so the rest silhouette is EXACTLY the
//     modelled fluted, scalloped cone. It cannot sag, crease or engulf anything.
//
// The row angles are integrated in fixedUpdate (deterministic; the capture
// harness fast-forwards through fixedUpdate only). The per-vertex transform
// happens once per rendered frame in upload(). Nothing here allocates after
// init() — ARCHITECTURE §4.

import { Mesh, VertexData } from '../core/bjs.js';

const MAXDT = 1 / 50;

export class Cape {
  /**
   * @param {object} opts
   *   flutes    vertical pleats across the cape. ODD, so a lobe crown — not a
   *             crease — lands on the centre-back meridian, which is dead
   *             centre of frame for the entire game.
   *   perFlute  columns per flute. 2 gives a triangular pleat, 3+ a rounded one.
   *   rows      rows down the skirt; also the length of the dynamics chain.
   */
  constructor(opts) {
    const flutes = opts.flutes;
    const cols = flutes * opts.perFlute + 1;
    const rows = opts.rows;
    this.flutes = flutes;
    this.cols = cols;
    this.rows = rows;

    this.len = opts.len;
    this.rx0 = opts.rx0; this.rx1 = opts.rx1;   // plan half-axes, collar -> hem
    this.rz0 = opts.rz0; this.rz1 = opts.rz1;
    this.spread0 = opts.spread0;                // azimuth covered, collar -> hem
    this.spread1 = opts.spread1;
    this.flarePow = opts.flarePow;
    this.fluteAmp = opts.fluteAmp;
    this.hemCut = opts.hemCut;
    this.rippleAmp = opts.rippleAmp;
    this.trimR = opts.trimR;
    this.trimSu = opts.trimSu;
    this.stiff = opts.stiff;
    this.damp = opts.damp;

    const n = cols * rows;
    this.n = n;

    // rest shape, rest normals, and the unit radial each vertex flares along
    this.qx = new Float32Array(n); this.qy = new Float32Array(n); this.qz = new Float32Array(n);
    this.mx = new Float32Array(n); this.my = new Float32Array(n); this.mz = new Float32Array(n);
    this.radX = new Float32Array(cols); this.radZ = new Float32Array(cols);

    // per-column and per-row ripple, evaluated once per frame each, not per
    // vertex: cols + rows sines instead of cols * rows of them
    this.colPh = new Float32Array(cols);
    this.colRip = new Float32Array(cols);
    this.rowRip = new Float32Array(rows);
    this.rowW = new Float32Array(rows);     // v^2, how far a row may move

    // the dynamics: two damped angular springs per row
    this.angX = new Float32Array(rows); this.velX = new Float32Array(rows);
    this.angZ = new Float32Array(rows); this.velZ = new Float32Array(rows);
    this.cX = new Float32Array(rows); this.sX = new Float32Array(rows);
    this.cZ = new Float32Array(rows); this.sZ = new Float32Array(rows);
    this.flare = 0;
    this._flareT = 0;

    this.t = 0;

    // grid indices. Winding note, geom.js: the outward normal of (i0, i1, i2)
    // is (p2 - p0) x (p1 - p0). With u running +x and v running -y, the order
    // (a, b, d) — across, then down — puts the normal at -z, which is BEHIND
    // the character, which is the side the camera is on.
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
    this.backNormals = null;
    this.uvs = new Float32Array(n * 2);

    this.mesh = null;
    this.under = null;
    this.trim = null;
  }

  /**
   * The flute profile. 0 on a crease line, 1 on a lobe crown.
   *
   * The exponent is what makes it read as metal fluting rather than a sine
   * wave: it widens the crowns and narrows the valleys, so each pleat is a
   * broad convex face meeting its neighbour at a hard line — which is where the
   * bright/dark banding comes from.
   */
  _lobe(u) {
    return Math.pow(Math.abs(Math.sin(Math.PI * this.flutes * u)), 0.48);
  }

  /**
   * Rest shape: a partial elliptical cone, fluted, with a scalloped hem.
   *
   * Elliptical rather than circular because the collar has to clear the torso
   * (which is wider in x than in z) and because a circular hem of this width
   * would stick half a metre straight out behind in profile.
   */
  _rest(u, v, out) {
    const lobe = this._lobe(u);
    const th = (u - 0.5) * (this.spread0 + (this.spread1 - this.spread0) * v);
    const f = Math.pow(v, this.flarePow);
    const ax = this.rx0 + (this.rx1 - this.rx0) * f;
    const az = this.rz0 + (this.rz1 - this.rz0) * f;
    // fluting is present at the yoke and deepens as the skirt widens
    const amp = this.fluteAmp * (0.32 + 0.68 * v) * lobe;
    // The scallop is an edge treatment, so it only bites in the bottom third.
    //
    // A RAISED COSINE, not (1 - lobe). Driving the hem off the lobe function
    // put a cusp with an infinite slope on every crease line and the hem came
    // out as a hard SAWTOOTH — a paper crown, not a scalloped edge. This is the
    // same period and phase (1 on a crease, 0 on a lobe crown) but smooth, and
    // it needs four columns per flute to sample without faceting.
    const scal = 0.5 + 0.5 * Math.cos(Math.PI * 2 * this.flutes * u);
    const hem = this.hemCut * this.len * scal * Math.max(0, (v - 0.62) / 0.38);
    // Corner sweep. The skirt is an ARC of a cone, so its two open ends meet the
    // hem at a hard right angle, and those two corners rendered as horizontal
    // SPIKES jutting out either side at hem height. Pulling the last flute's
    // length up and its radius in rounds the silhouette into the cape corner the
    // reference has instead.
    const e = Math.abs(u - 0.5) * 2;
    const edge = e * e * e * e;
    const k = 1 - 0.055 * edge;
    out[0] = (ax * k + amp) * Math.sin(th);
    out[1] = -this.len * v * (1 - 0.09 * edge) + hem;
    out[2] = -(az * k + amp) * Math.cos(th);
  }

  init(scene, matCape, matTrim, parent, uRep, vRep, matUnder) {
    const cols = this.cols, rows = this.rows;
    const tmp = [0, 0, 0];

    for (let c = 0; c < cols; c++) {
      const u = c / (cols - 1);
      const th = (u - 0.5) * this.spread1;
      this.radX[c] = Math.sin(th);
      this.radZ[c] = -Math.cos(th);
      this.colPh[c] = (c * 1.37) % 6.28318;
    }
    for (let r = 0; r < rows; r++) {
      const v = rows === 1 ? 0 : r / (rows - 1);
      this.rowW[r] = v * v;
    }

    for (let r = 0; r < rows; r++) {
      const v = rows === 1 ? 0 : r / (rows - 1);
      for (let c = 0; c < cols; c++) {
        const u = c / (cols - 1);
        const i = r * cols + c;
        this._rest(u, v, tmp);
        this.qx[i] = tmp[0]; this.qy[i] = tmp[1]; this.qz[i] = tmp[2];
        const k = i * 2;
        this.uvs[k] = u * uRep;
        this.uvs[k + 1] = v * vRep;
      }
    }

    // Rest normals, accumulated once. Every frame after this they are ROTATED
    // by the same per-row bend as the positions rather than recomputed: the
    // deformation is a rotation, so rotating the normals is not an
    // approximation, and it removes an O(triangles) pass from every frame.
    this._restNormals();
    this._transform();

    // TWO MESHES OVER ONE SIMULATION.
    // A skirt is a sheet, so it renders from both sides. Built as two meshes
    // with opposite winding rather than one double-sided material, because the
    // outside is mirror silver and the inside is a dark cavity — and that value
    // split is a large part of why a metal skirt reads as a metal skirt.
    const mesh = new Mesh('cape', scene);
    const vd = new VertexData();
    vd.positions = this.positions;
    vd.indices = this.indices;
    vd.normals = this.normals;
    vd.uvs = this.uvs;
    vd.applyToMesh(mesh, true);
    mesh.material = matCape;
    mesh.parent = parent;
    mesh.isPickable = false;
    mesh.alwaysSelectAsActiveMesh = true;
    this.mesh = mesh;

    const back = [];
    for (let t = 0; t < this.indices.length; t += 3) {
      back.push(this.indices[t], this.indices[t + 2], this.indices[t + 1]);
    }
    this.backNormals = new Float32Array(this.normals.length);
    const under = new Mesh('capeUnder', scene);
    const vd2 = new VertexData();
    vd2.positions = this.positions;
    vd2.indices = back;
    vd2.normals = this.backNormals;
    vd2.uvs = this.uvs;
    vd2.applyToMesh(under, true);
    under.material = matUnder || matCape;
    under.parent = parent;
    under.isPickable = false;
    under.alwaysSelectAsActiveMesh = true;
    this.under = under;

    this._buildTrim(scene, matTrim, parent);
    return this;
  }

  /** Snap back to rest — used on death/restart so a new run starts clean. */
  reset() {
    this.angX.fill(0); this.velX.fill(0);
    this.angZ.fill(0); this.velZ.fill(0);
    this.flare = 0; this._flareT = 0;
    this.t = 0;
  }

  /**
   * One deterministic simulation step. Costs `rows` iterations, not `n`.
   *
   * @param dt     fixed 1/60
   * @param speed  m/s along the track
   * @param ax,ay  the CHARACTER's acceleration in local axes
   * @param bobV   vertical velocity of the run cycle bob
   */
  step(dt, speed, ax, ay, az, bobV) {
    if (dt > MAXDT) dt = MAXDT;
    this.t += dt;

    // Backward lift, saturating with speed. A heavy metal skirt does not stream
    // out horizontally at 34 m/s the way cloth would — it lifts, and stops.
    const w = speed * 0.058;
    let driveX = w / (1 + w * 0.90);
    // falling floats it up, landing slams it down, the run cycle taps it
    driveX += -ay * 0.0055 - bobV * 0.020;
    // Lateral swing. Negative because the skirt LAGS the body: accelerate right
    // and the hem is left behind on the left.
    //
    // The gain looks large next to the lift gain and has to be. The chain takes
    // about half a second to reach a steady angle, and a lane change is over in
    // a third of one, so the hem only ever sees the leading edge of the
    // response: at 0.0125 a full lane change moved the hem by 1.5 degrees, which
    // is invisible. Measured, not guessed — see the swingHem trace.
    let driveZ = -ax * 0.050;

    if (driveX > 0.62) driveX = 0.62; else if (driveX < -0.34) driveX = -0.34;
    if (driveZ > 0.50) driveZ = 0.50; else if (driveZ < -0.50) driveZ = -0.50;

    // The chain. Each row chases the row above plus its share of the drive, so
    // the total bend at the hem is `drive` and the swing travels down the skirt
    // over a few frames instead of teleporting.
    const rows = this.rows;
    const share = 1 / (rows - 1);
    const K = this.stiff * dt;
    const D = this.damp;
    const sxDrive = driveX * share, szDrive = driveZ * share;
    for (let r = 1; r < rows; r++) {
      let v = this.velX[r] + (this.angX[r - 1] + sxDrive - this.angX[r]) * K;
      v *= D;
      this.velX[r] = v;
      this.angX[r] += v * dt;

      let v2 = this.velZ[r] + (this.angZ[r - 1] + szDrive - this.angZ[r]) * K;
      v2 *= D;
      this.velZ[r] = v2;
      this.angZ[r] += v2 * dt;
    }

    // Centrifugal flare: at speed the whole skirt opens a little.
    const wantFlare = (speed * 0.0022) + Math.abs(driveZ) * 0.10;
    this._flareT += (wantFlare - this._flareT) * 0.06;
    this.flare = this._flareT;

    // Per-row and per-column shimmer phases. cols + rows sines, once.
    const t = this.t;
    for (let c = 0; c < this.cols; c++) this.colRip[c] = Math.sin(t * 6.1 + this.colPh[c]);
    for (let r = 0; r < rows; r++) this.rowRip[r] = Math.sin(t * 4.3 - r * 0.72);

    for (let r = 0; r < rows; r++) {
      this.cX[r] = Math.cos(this.angX[r]); this.sX[r] = Math.sin(this.angX[r]);
      this.cZ[r] = Math.cos(this.angZ[r]); this.sZ[r] = Math.sin(this.angZ[r]);
    }
  }

  /**
   * Rest -> world for every vertex: a small radial offset, then a rotation
   * about Z (lateral swing) and about X (lift), both per-row.
   */
  _transform() {
    const cols = this.cols, rows = this.rows;
    const P = this.positions, N = this.normals;
    const amp = this.rippleAmp, flare = this.flare;
    for (let r = 0; r < rows; r++) {
      const cx = this.cX[r], sx = this.sX[r];
      const cz = this.cZ[r], sz = this.sZ[r];
      const w = this.rowW[r];
      const rip = this.rowRip[r] * 0.42 * amp * w;
      const colK = 0.58 * amp * w;
      const fl = flare * w;
      const base = r * cols;
      for (let c = 0; c < cols; c++) {
        const i = base + c;
        const off = rip + this.colRip[c] * colK + fl;
        const ex = this.qx[i] + this.radX[c] * off;
        const ey = this.qy[i];
        const ez = this.qz[i] + this.radZ[c] * off;

        // Rz then Rx
        const x1 = ex * cz - ey * sz;
        const y1 = ex * sz + ey * cz;
        const k = i * 3;
        P[k] = x1;
        P[k + 1] = y1 * cx - ez * sx;
        P[k + 2] = y1 * sx + ez * cx;

        const nx = this.mx[i], ny = this.my[i], nz = this.mz[i];
        const n1 = nx * cz - ny * sz;
        const n2 = nx * sz + ny * cz;
        N[k] = n1;
        N[k + 1] = n2 * cx - nz * sx;
        N[k + 2] = n2 * sx + nz * cx;
      }
    }
  }

  /** Face-accumulated normals over the rest shape. Runs once, at init. */
  _restNormals() {
    const n = this.n;
    const mx = this.mx, my = this.my, mz = this.mz;
    mx.fill(0); my.fill(0); mz.fill(0);
    const idx = this.indices;
    for (let t = 0; t < idx.length; t += 3) {
      const a = idx[t], b = idx[t + 1], c = idx[t + 2];
      const e1x = this.qx[b] - this.qx[a], e1y = this.qy[b] - this.qy[a], e1z = this.qz[b] - this.qz[a];
      const e2x = this.qx[c] - this.qx[a], e2y = this.qy[c] - this.qy[a], e2z = this.qz[c] - this.qz[a];
      const fx = e2y * e1z - e2z * e1y;
      const fy = e2z * e1x - e2x * e1z;
      const fz = e2x * e1y - e2y * e1x;
      mx[a] += fx; my[a] += fy; mz[a] += fz;
      mx[b] += fx; my[b] += fy; mz[b] += fz;
      mx[c] += fx; my[c] += fy; mz[c] += fz;
    }
    for (let i = 0; i < n; i++) {
      const l = Math.sqrt(mx[i] * mx[i] + my[i] * my[i] + mz[i] * mz[i]);
      if (l > 1e-8) { mx[i] /= l; my[i] /= l; mz[i] /= l; }
    }
  }

  // ---- the gold hem trim ------------------------------------------------
  //
  // One tube swept along the bottom row of the skirt, so it follows the
  // scallop exactly and moves with it. The reference's trim is a fine wire, not
  // a band, so it stays thin — but it is the thing that draws the scalloped
  // edge as a LINE, and a scallop you cannot see the outline of is just a
  // ragged hem.

  _buildTrim(scene, mat, parent) {
    const su = this.trimSu, ring = su + 1, cols = this.cols;
    this._trimSu = su;
    const idx = [];
    for (let i = 0; i < cols - 1; i++) {
      for (let j = 0; j < su; j++) {
        const a = i * ring + j, b = a + 1, c = a + ring, d = c + 1;
        idx.push(a, c, b, b, c, d);
      }
    }
    const vcount = cols * ring;
    this._trimPos = new Float32Array(vcount * 3);
    this._trimNrm = new Float32Array(vcount * 3);
    const uvs = new Float32Array(vcount * 2);
    for (let i = 0; i < cols; i++) {
      for (let j = 0; j <= su; j++) {
        const k = (i * ring + j) * 2;
        uvs[k] = j / su;
        uvs[k + 1] = (i / (cols - 1)) * 6;
      }
    }
    this._trimIdx = idx;
    this._updateTrim();

    const mesh = new Mesh('capeHem', scene);
    const vd = new VertexData();
    vd.positions = this._trimPos;
    vd.indices = idx;
    vd.normals = this._trimNrm;
    vd.uvs = uvs;
    vd.applyToMesh(mesh, true);
    mesh.material = mat;
    mesh.parent = parent;
    mesh.isPickable = false;
    mesh.alwaysSelectAsActiveMesh = true;
    this.trim = mesh;
  }

  /**
   * Sweep the hem tube. The frame is taken from the skirt's own surface normal
   * rather than a parallel-transport walk, which guarantees the wire sits flat
   * on the edge instead of rolling as the skirt swings.
   */
  _updateTrim() {
    const su = this._trimSu, ring = su + 1;
    const cols = this.cols;
    const p = this._trimPos;
    const P = this.positions, N = this.normals;
    const base = (this.rows - 1) * cols;
    const r = this.trimR;
    for (let i = 0; i < cols; i++) {
      const pi = base + i;
      const k = pi * 3;
      const cx = P[k], cy = P[k + 1], cz = P[k + 2];
      const a = (base + (i > 0 ? i - 1 : 0)) * 3;
      const b = (base + (i < cols - 1 ? i + 1 : cols - 1)) * 3;
      let tx = P[b] - P[a], ty = P[b + 1] - P[a + 1], tz = P[b + 2] - P[a + 2];
      const tl = Math.sqrt(tx * tx + ty * ty + tz * tz) || 1;
      tx /= tl; ty /= tl; tz /= tl;
      let nx = N[k], ny = N[k + 1], nz = N[k + 2];
      let bx = ty * nz - tz * ny, by = tz * nx - tx * nz, bz = tx * ny - ty * nx;
      const bl = Math.sqrt(bx * bx + by * by + bz * bz) || 1;
      bx /= bl; by /= bl; bz /= bl;
      nx = by * tz - bz * ty; ny = bz * tx - bx * tz; nz = bx * ty - by * tx;
      let w = i * ring * 3;
      for (let j = 0; j <= su; j++) {
        const ang = (j / su) * Math.PI * 2;
        const ca = Math.cos(ang) * r, sa = Math.sin(ang) * r;
        p[w++] = cx + nx * ca + bx * sa;
        p[w++] = cy + ny * ca + by * sa;
        p[w++] = cz + nz * ca + bz * sa;
      }
    }
    this._accumulateNormals(p, this._trimIdx, this._trimNrm);
  }

  _accumulateNormals(p, idx, n) {
    n.fill(0);
    for (let t = 0; t < idx.length; t += 3) {
      const a = idx[t] * 3, b = idx[t + 1] * 3, c = idx[t + 2] * 3;
      const e1x = p[b] - p[a], e1y = p[b + 1] - p[a + 1], e1z = p[b + 2] - p[a + 2];
      const e2x = p[c] - p[a], e2y = p[c + 1] - p[a + 1], e2z = p[c + 2] - p[a + 2];
      // Same convention as geom.js: the front-face normal is (p2-p0) x (p1-p0).
      const cx = e2y * e1z - e2z * e1y, cy = e2z * e1x - e2x * e1z, cz = e2x * e1y - e2y * e1x;
      n[a] += cx; n[a + 1] += cy; n[a + 2] += cz;
      n[b] += cx; n[b + 1] += cy; n[b + 2] += cz;
      n[c] += cx; n[c + 1] += cy; n[c + 2] += cz;
    }
    for (let i = 0; i < n.length; i += 3) {
      const l = Math.sqrt(n[i] * n[i] + n[i + 1] * n[i + 1] + n[i + 2] * n[i + 2]);
      if (l > 1e-8) { n[i] /= l; n[i + 1] /= l; n[i + 2] /= l; }
    }
  }

  /** Presentation: transform the rest shape and push it to the GPU. */
  upload() {
    if (!this.mesh) return;
    this._transform();
    this.mesh.updateVerticesData('position', this.positions, false, false);
    this.mesh.updateVerticesData('normal', this.normals, false, false);
    if (this.under) {
      const n = this.normals, b = this.backNormals;
      for (let i = 0; i < n.length; i++) b[i] = -n[i];
      this.under.updateVerticesData('position', this.positions, false, false);
      this.under.updateVerticesData('normal', b, false, false);
    }
    if (this.trim) {
      this._updateTrim();
      this.trim.updateVerticesData('position', this._trimPos, false, false);
      this.trim.updateVerticesData('normal', this._trimNrm, false, false);
    }
  }

  dispose() {
    if (this.mesh) this.mesh.dispose();
    if (this.under) this.under.dispose();
    if (this.trim) this.trim.dispose();
  }
}
