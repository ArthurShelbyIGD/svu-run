// char/geom.js — a tiny build-time geometry kit.
//
// WHY THIS EXISTS
// Babylon's MeshBuilder gives you spheres, boxes and capsules. A character
// assembled from those reads as exactly what it is: primitives. The owner's
// verdict on the previous build — "Minecraft looking blocks", "a flat matt grey
// thing" — was a verdict on primitives, not on materials.
//
// This module does two things primitives cannot:
//
//   1. PARAMETRIC SURFACES WITH WARPS. Every surface here takes a `warp(u,v)`
//      callback that scales the radius per-vertex. That single hook is what
//      turns a sphere into a hood with fabric folds, or a tube into a sleeve
//      that creases at the elbow. Geometric density, cheaply.
//
//   2. MERGING. Parts are accumulated into one `Geo` and emitted as a single
//      mesh, so a glove with four fingers and a thumb costs ONE draw call, not
//      six. That is what makes it affordable to add detail at all.
//
// Everything in here runs at init() only. Allocation is free here and forbidden
// afterwards — see ARCHITECTURE §4.

import { Matrix, Vector3, VertexData, Mesh } from '../core/bjs.js';

// WINDING, and why it is written down here.
//
// Babylon culls back faces and `VertexData.ComputeNormals` derives normals from
// the same triangle order, so getting the order wrong does NOT produce an
// obviously broken mesh. It produces a mesh that renders its FAR interior
// surface with an inward normal pointing at the camera — which looks like a
// plausible, if oddly smooth, convex object, and which lets anything inside it
// show straight through. The character shipped a whole build like that: the
// hood looked like a chrome ball and the rose-gold face was visible through the
// back of the head.
//
// The rule that fixes it, derived once and applied everywhere below:
//
//     for a triangle (i0, i1, i2), the outward normal is
//        (p2 - p0) x (p1 - p0)
//
// So a quad on a (u, v) grid winds (a, c, b), (b, c, d) when v runs along the
// UP direction, and (a, b, c), (b, d, c) when v runs DOWN. `ellipsoid` and
// `lathe` go top-to-bottom; `tube` goes bottom-to-top. That single difference is
// why they do not share a winding.


const _v = new Vector3();
const _n = new Vector3();

/** Signed power — the superellipsoid primitive. e=1 is a sphere, e→0 a box. */
function sp(v, e) {
  if (e === 1) return v;
  return (v < 0 ? -1 : 1) * Math.pow(Math.abs(v), e);
}

/**
 * Accumulates transformed vertex data from many parts into one mesh.
 */
export class Geo {
  constructor() {
    this.pos = [];
    this.uv = [];
    this.idx = [];
    this.m = Matrix.Identity();
  }

  /** Set the transform applied to everything added next. */
  at(tx = 0, ty = 0, tz = 0, rx = 0, ry = 0, rz = 0, sx = 1, sy = 1, sz = 1) {
    const s = Matrix.Scaling(sx, sy, sz);
    const r = Matrix.RotationYawPitchRoll(ry, rx, rz);
    const t = Matrix.Translation(tx, ty, tz);
    this.m.copyFrom(s.multiply(r).multiply(t));
    return this;
  }

  /** Mirror the current transform across X — for the second of a pair. */
  mirrorX() {
    this.m.copyFrom(Matrix.Scaling(-1, 1, 1).multiply(this.m));
    return this;
  }

  /** Append one part's vertex data, transformed by the current matrix. */
  add(part) {
    const base = this.pos.length / 3;
    const p = part.pos;
    for (let i = 0; i < p.length; i += 3) {
      Vector3.TransformCoordinatesFromFloatsToRef(p[i], p[i + 1], p[i + 2], this.m, _v);
      this.pos.push(_v.x, _v.y, _v.z);
    }
    for (let i = 0; i < part.uv.length; i++) this.uv.push(part.uv[i]);
    // A mirrored transform flips handedness, so the winding must flip too or
    // the whole part renders inside-out. This bit me on the first pair of
    // gloves: the left hand was a black hole.
    const flip = this.m.determinant() < 0;
    const ix = part.idx;
    for (let i = 0; i < ix.length; i += 3) {
      if (flip) this.idx.push(base + ix[i], base + ix[i + 2], base + ix[i + 1]);
      else this.idx.push(base + ix[i], base + ix[i + 1], base + ix[i + 2]);
    }
    return this;
  }

  get vertexCount() { return this.pos.length / 3; }

  /** Emit as a single mesh with smooth normals computed across each part. */
  toMesh(name, scene, material, parent) {
    const mesh = new Mesh(name, scene);
    const vd = new VertexData();
    const nrm = new Float32Array(this.pos.length);
    VertexData.ComputeNormals(this.pos, this.idx, nrm);
    vd.positions = this.pos;
    vd.indices = this.idx;
    vd.normals = nrm;
    vd.uvs = this.uv;
    vd.applyToMesh(mesh);
    mesh.material = material;
    if (parent) mesh.parent = parent;
    mesh.isPickable = false;
    mesh.alwaysSelectAsActiveMesh = true;
    return mesh;
  }
}

/**
 * Superellipsoid patch. The workhorse.
 *
 *   e1 / e2  1 = sphere, 0.5 = rounded box, 0.25 = nearly a box
 *   v0 / v1  latitude range, 0 = top pole, 1 = bottom pole (for partial shells)
 *   warp     (u, v) => radial multiplier. Fabric folds live here.
 *   yWarp    (v) => additive Y offset, for droop and taper
 */
export function ellipsoid(o) {
  const rx = o.rx, ry = o.ry === undefined ? rx : o.ry, rz = o.rz === undefined ? rx : o.rz;
  const e1 = o.e1 === undefined ? 1 : o.e1;
  const e2 = o.e2 === undefined ? 1 : o.e2;
  const su = o.su || 20, sv = o.sv || 14;
  const v0 = o.v0 === undefined ? 0 : o.v0;
  const v1 = o.v1 === undefined ? 1 : o.v1;
  const warp = o.warp || null;
  const yWarp = o.yWarp || null;
  const uRep = o.uRep === undefined ? 2 : o.uRep;
  const vRep = o.vRep === undefined ? 1 : o.vRep;

  const pos = [], uv = [], idx = [];
  for (let i = 0; i <= sv; i++) {
    const tv = v0 + (v1 - v0) * (i / sv);
    const th = (0.5 - tv) * Math.PI;
    const ct = sp(Math.cos(th), e1), st = sp(Math.sin(th), e1);
    for (let j = 0; j <= su; j++) {
      const tu = j / su;
      const ph = tu * Math.PI * 2;
      const k = warp ? warp(tu, tv) : 1;
      pos.push(
        rx * ct * sp(Math.sin(ph), e2) * k,
        ry * st + (yWarp ? yWarp(tv, tu) : 0),
        rz * ct * sp(Math.cos(ph), e2) * k,
      );
      uv.push(tu * uRep, tv * vRep);
    }
  }
  for (let i = 0; i < sv; i++) {
    for (let j = 0; j < su; j++) {
      const a = i * (su + 1) + j, b = a + 1, c = a + su + 1, d = c + 1;
      idx.push(a, b, c, b, d, c);
    }
  }
  return { pos, uv, idx };
}

/**
 * A generalised tube through a list of rings. Limbs, fingers, piping, the zip.
 *
 *   rings: [ [cx, cy, cz, rx, rz] , ... ]  ordered along the tube
 *   Caps are flat fans; with enough rings a rounded end is better made by
 *   letting the last few radii fall away.
 */
export function tube(rings, su = 10, capA = true, capB = true, uRep = 1, vRep = 1) {
  const pos = [], uv = [], idx = [];
  const n = rings.length;
  for (let i = 0; i < n; i++) {
    const r = rings[i];
    for (let j = 0; j <= su; j++) {
      const tu = j / su, ph = tu * Math.PI * 2;
      pos.push(r[0] + r[3] * Math.sin(ph), r[1], r[2] + r[4] * Math.cos(ph));
      uv.push(tu * uRep, (i / (n - 1)) * vRep);
    }
  }
  for (let i = 0; i < n - 1; i++) {
    for (let j = 0; j < su; j++) {
      const a = i * (su + 1) + j, b = a + 1, c = a + su + 1, d = c + 1;
      idx.push(a, c, b, b, c, d);
    }
  }
  if (capA) {
    const ci = pos.length / 3;
    pos.push(rings[0][0], rings[0][1], rings[0][2]);
    uv.push(0.5, 0);
    for (let j = 0; j < su; j++) idx.push(ci, j + 1, j);
  }
  if (capB) {
    const last = rings[n - 1];
    const ci = pos.length / 3;
    pos.push(last[0], last[1], last[2]);
    uv.push(0.5, 1);
    const off = (n - 1) * (su + 1);
    for (let j = 0; j < su; j++) idx.push(ci, off + j, off + j + 1);
  }
  return { pos, uv, idx };
}

/** Torus in the XZ plane. Collars, cuffs, rims, piping rings. */
export function torus(R, r, su = 24, sv = 10, warp = null, squashY = 1) {
  const pos = [], uv = [], idx = [];
  for (let i = 0; i <= su; i++) {
    const tu = i / su, a = tu * Math.PI * 2;
    const ca = Math.cos(a), sa = Math.sin(a);
    for (let j = 0; j <= sv; j++) {
      const tv = j / sv, b = tv * Math.PI * 2;
      const rr = r * (warp ? warp(tu, tv) : 1);
      const rad = R + rr * Math.cos(b);
      pos.push(rad * sa, rr * Math.sin(b) * squashY, rad * ca);
      uv.push(tu * 4, tv);
    }
  }
  for (let i = 0; i < su; i++) {
    for (let j = 0; j < sv; j++) {
      const a = i * (sv + 1) + j, b = a + 1, c = a + sv + 1, d = c + 1;
      idx.push(a, b, c, b, d, c);
    }
  }
  return { pos, uv, idx };
}

/**
 * A partial torus arc — seams, piping runs and the hood brim, which is an arc
 * rather than a full ring because a hood opens at the front.
 */
export function arc(R, r, a0, a1, su = 20, sv = 8, taper = null) {
  const pos = [], uv = [], idx = [];
  for (let i = 0; i <= su; i++) {
    const tu = i / su, a = a0 + (a1 - a0) * tu;
    const ca = Math.cos(a), sa = Math.sin(a);
    const rr = r * (taper ? taper(tu) : 1);
    for (let j = 0; j <= sv; j++) {
      const tv = j / sv, b = tv * Math.PI * 2;
      const rad = R + rr * Math.cos(b);
      pos.push(rad * sa, rr * Math.sin(b), rad * ca);
      uv.push(tu * 4, tv);
    }
  }
  for (let i = 0; i < su; i++) {
    for (let j = 0; j < sv; j++) {
      const a = i * (sv + 1) + j, b = a + 1, c = a + sv + 1, d = c + 1;
      idx.push(a, b, c, b, d, c);
    }
  }
  return { pos, uv, idx };
}

/**
 * Surface of revolution from a profile, with the same warp hook as `ellipsoid`.
 *
 *   profile  [[radius, y], ...] from top to bottom
 *   warp     (u, v) => radial multiplier
 *
 * This exists because a hood is not a sphere. It is a dome that flares into a
 * cowl over the shoulders, and that flare is what stops the back of the head
 * reading as a ball.
 */
export function lathe(profile, su, warp, uRep = 3, vRep = 1, capTop = false) {
  const pos = [], uv = [], idx = [];
  const n = profile.length;
  for (let i = 0; i < n; i++) {
    const tv = i / (n - 1);
    const [r, y] = profile[i];
    for (let j = 0; j <= su; j++) {
      const tu = j / su, ph = tu * Math.PI * 2;
      const k = warp ? warp(tu, tv) : 1;
      pos.push(r * Math.sin(ph) * k, y, r * Math.cos(ph) * k);
      uv.push(tu * uRep, tv * vRep);
    }
  }
  for (let i = 0; i < n - 1; i++) {
    for (let j = 0; j < su; j++) {
      const a = i * (su + 1) + j, b = a + 1, c = a + su + 1, d = c + 1;
      idx.push(a, b, c, b, d, c);
    }
  }
  if (capTop) {
    const ci = pos.length / 3;
    pos.push(0, profile[0][1], 0);
    uv.push(0.5, 0);
    for (let j = 0; j < su; j++) idx.push(ci, j, j + 1);
  }
  return { pos, uv, idx };
}

/**
 * Sweep a circle along an arbitrary 3D polyline. Piping, seams, welts, wires.
 *
 * Rotating a flat `arc` into place works for rings but not for a seam that
 * climbs over a curved surface, and guessing at Euler orders to get one there
 * is how you spend an hour on a detail worth five minutes. This takes the path
 * directly.
 *
 *   pts    [[x,y,z], ...]
 *   radAt  (t) => radius, t in 0..1 along the path
 */
export function pipe(pts, radAt, su = 7) {
  const pos = [], uv = [], idx = [];
  const n = pts.length;
  let ux = 0, uy = 1, uz = 0;   // carried up-reference: parallel transport, cheaply
  for (let i = 0; i < n; i++) {
    const a = pts[Math.max(0, i - 1)], b = pts[Math.min(n - 1, i + 1)], c = pts[i];
    let tx = b[0] - a[0], ty = b[1] - a[1], tz = b[2] - a[2];
    const tl = Math.hypot(tx, ty, tz) || 1;
    tx /= tl; ty /= tl; tz /= tl;
    // remove the tangent component from the carried up-vector
    const d = ux * tx + uy * ty + uz * tz;
    let nx = ux - tx * d, ny = uy - ty * d, nz = uz - tz * d;
    let nl = Math.hypot(nx, ny, nz);
    if (nl < 1e-4) { nx = 1 - tx * tx; ny = -tx * ty; nz = -tx * tz; nl = Math.hypot(nx, ny, nz) || 1; }
    nx /= nl; ny /= nl; nz /= nl;
    ux = nx; uy = ny; uz = nz;
    const bx = ty * nz - tz * ny, by = tz * nx - tx * nz, bz = tx * ny - ty * nx;
    const t = i / (n - 1);
    const r = radAt(t);
    for (let j = 0; j <= su; j++) {
      const ang = (j / su) * Math.PI * 2;
      const ca = Math.cos(ang) * r, sa = Math.sin(ang) * r;
      pos.push(c[0] + nx * ca + bx * sa, c[1] + ny * ca + by * sa, c[2] + nz * ca + bz * sa);
      uv.push(j / su, t * 4);
    }
  }
  for (let i = 0; i < n - 1; i++) {
    for (let j = 0; j < su; j++) {
      const a = i * (su + 1) + j, b = a + 1, c = a + su + 1, d = c + 1;
      idx.push(a, c, b, b, c, d);
    }
  }
  // caps
  for (const [ci, rev] of [[0, false], [n - 1, true]]) {
    const centre = pos.length / 3;
    pos.push(pts[ci][0], pts[ci][1], pts[ci][2]);
    uv.push(0.5, 0.5);
    const off = ci * (su + 1);
    for (let j = 0; j < su; j++) {
      if (rev) idx.push(centre, off + j + 1, off + j);
      else idx.push(centre, off + j, off + j + 1);
    }
  }
  return { pos, uv, idx };
}

/** Faceted gem — stars, toggles, the zip pull. Cheap sparkle. */
export function gem(r, facets = 8, h = 0.6) {
  const pos = [0, r * h, 0], uv = [0.5, 0], idx = [];
  for (let j = 0; j < facets; j++) {
    const a = (j / facets) * Math.PI * 2;
    pos.push(r * Math.sin(a), 0, r * Math.cos(a));
    uv.push(j / facets, 0.5);
  }
  pos.push(0, -r * h * 1.4, 0);
  uv.push(0.5, 1);
  const bi = facets + 1;
  for (let j = 0; j < facets; j++) {
    const a = 1 + j, b = 1 + ((j + 1) % facets);
    idx.push(0, b, a, bi, a, b);
  }
  return { pos, uv, idx };
}

export { sp };
