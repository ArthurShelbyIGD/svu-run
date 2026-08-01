// world/geo.js — procedural geometry helpers.
//
// Everything here runs ONCE, at init, to build prototype meshes that are then
// drawn as thin instances. Nothing in this file is allowed to run per frame.
//
// The point of the file is density. A cylinder with a flat colour reads as a
// prototype no matter how it is lit; a shaft with real flutes, a moulded base
// and a carved capital reads as architecture. The cost of that difference is
// a few hundred triangles in a mesh that is drawn once and instanced.

import { MeshBuilder, Mesh, VertexData } from '../core/bjs.js';

const TAU = Math.PI * 2;

/** Box helper: create, position, park in a bucket for later merging. */
export function box(scene, bucket, w, h, d, x, y, z, ry = 0, rx = 0, rz = 0) {
  const m = MeshBuilder.CreateBox('_b', { width: w, height: h, depth: d }, scene);
  m.position.set(x, y, z);
  m.rotation.set(rx, ry, rz);
  bucket.push(m);
  return m;
}

/** Cylinder helper. dT/dB are diameters, so mouldings can flare. */
export function cyl(scene, bucket, dT, dB, h, x, y, z, tess) {
  const m = MeshBuilder.CreateCylinder('_c', {
    diameterTop: dT, diameterBottom: dB, height: h, tessellation: tess,
  }, scene);
  m.position.set(x, y, z);
  bucket.push(m);
  return m;
}

/** Faceted gem. Flat-shaded so every facet catches the light differently. */
export function gem(scene, bucket, radius, x, y, z, subdiv = 1) {
  const m = MeshBuilder.CreateIcoSphere('_g', {
    radius, subdivisions: subdiv, flat: true,
  }, scene);
  m.position.set(x, y, z);
  bucket.push(m);
  return m;
}

/**
 * A fluted column shaft.
 *
 * The radius is modulated by angle — r = R * (1 - depth * (1+cos(n*theta))/2)
 * — which cuts n rounded grooves running the height of the shaft. This is the
 * single highest-value piece of geometry in the world: it is what stops a
 * column reading as "a cylinder" at any distance where the silhouette is
 * legible, and it costs about 250 triangles.
 */
export function flutedShaft(scene, bucket, o) {
  const rB = o.rBottom, rT = o.rTop, H = o.height;
  const flutes = o.flutes, depth = o.depth;
  const radial = o.radial, rings = o.rings || 3;

  const n = (radial + 1) * (rings + 1);
  const pos = new Float32Array(n * 3);
  const nor = new Float32Array(n * 3);
  const uv = new Float32Array(n * 2);
  const idx = new Uint32Array(radial * rings * 6);

  let p = 0, u = 0;
  for (let j = 0; j <= rings; j++) {
    const t = j / rings;
    // Entasis: a real column swells slightly below the middle. Straight-taper
    // columns look mechanical; this is a tenth of a metre of curvature that
    // the eye reads as "carved" rather than "extruded".
    const swell = 1 + 0.035 * Math.sin(Math.PI * t) * (1 - t * 0.4);
    const R = (rB + (rT - rB) * t) * swell;
    const y = H * t;
    for (let i = 0; i <= radial; i++) {
      const th = (i / radial) * TAU;
      const g = 0.5 + 0.5 * Math.cos(flutes * th);
      const r = R * (1 - depth * g);
      pos[p++] = Math.sin(th) * r;
      pos[p++] = y;
      pos[p++] = Math.cos(th) * r;
      uv[u++] = (i / radial) * 4;
      uv[u++] = t * H * 0.5;
    }
  }

  let k = 0;
  for (let j = 0; j < rings; j++) {
    for (let i = 0; i < radial; i++) {
      const a = j * (radial + 1) + i;
      const b = a + radial + 1;
      // Babylon is LEFT-handed, so the winding that looks right on paper is
      // backwards on screen: the first version of this shaft had its faces
      // culled, and the track's own plain cylinder — which the fluted shaft is
      // sized to swallow — showed through the hole. Every third column in the
      // arcade rendered as a bare pink tube.
      idx[k++] = a; idx[k++] = b; idx[k++] = a + 1;
      idx[k++] = a + 1; idx[k++] = b; idx[k++] = b + 1;
    }
  }

  VertexData.ComputeNormals(pos, idx, nor);
  const vd = new VertexData();
  vd.positions = pos; vd.normals = nor; vd.uvs = uv; vd.indices = idx;
  const mesh = new Mesh('_shaft', scene);
  vd.applyToMesh(mesh);
  mesh.position.set(o.x || 0, o.y || 0, o.z || 0);
  bucket.push(mesh);
  return mesh;
}

/**
 * A semicircular arch built from voussoirs, in the plane given by `axis`.
 *   axis 'x' — the arch spans across X (over the track)
 *   axis 'z' — the arch spans along Z (an arcade running with the path)
 * Returns nothing; pushes stone blocks into `bucket` and the keystone into
 * `keyBucket` so it can carry a different material.
 */
export function arch(scene, bucket, keyBucket, o) {
  const R = o.radius;
  const ys = o.springY;
  const nV = o.voussoirs;
  const th = o.thickness;
  const wd = o.width;
  const Rc = R + th * 0.5;
  const dA = Math.PI / nV;
  const arcLen = Rc * dA * 1.06;
  const mid = (nV - 1) / 2;

  for (let i = 0; i < nV; i++) {
    const a = (i + 0.5) * dA;
    const cx = Rc * Math.cos(a);
    const cy = ys + Rc * Math.sin(a);
    const isKey = Math.abs(i - mid) < 0.51;
    const tgt = isKey ? keyBucket : bucket;
    const t = isKey ? th * 1.22 : th;
    const l = isKey ? arcLen * 1.12 : arcLen;
    const w = isKey ? wd * 1.1 : wd;
    if (o.axis === 'z') {
      // spans along Z: radial direction lies in the ZY plane
      const m = MeshBuilder.CreateBox('_v', { width: w, height: l, depth: t }, scene);
      m.position.set(o.x, cy, o.z + cx);
      m.rotation.x = -a + Math.PI / 2;
      tgt.push(m);
    } else {
      const m = MeshBuilder.CreateBox('_v', { width: t, height: l, depth: w }, scene);
      m.position.set(o.x + cx, cy, o.z);
      m.rotation.z = a - Math.PI / 2;
      tgt.push(m);
    }
  }
}

/**
 * A five-point star, faceted — the motif that floats around the character in
 * the reference artwork, reused here as a finial on wayside plinths.
 */
export function star(scene, bucket, o) {
  const R = o.outer, r = o.inner, t = o.thick;
  const pts = 5;
  const pos = [];
  const idx = [];
  // 0 = front hub, 1 = back hub
  pos.push(0, 0, t, 0, 0, -t);
  for (let i = 0; i < pts; i++) {
    const aT = (i / pts) * TAU + Math.PI / 2;
    const aI = ((i + 0.5) / pts) * TAU + Math.PI / 2;
    pos.push(Math.cos(aT) * R, Math.sin(aT) * R, 0);
    pos.push(Math.cos(aI) * r, Math.sin(aI) * r, 0);
  }
  for (let i = 0; i < pts; i++) {
    const tip = 2 + i * 2;
    const inn = tip + 1;
    const nextTip = 2 + ((i + 1) % pts) * 2;
    // Reversed for Babylon's left-handed winding — same trap as flutedShaft.
    idx.push(0, inn, tip);
    idx.push(0, nextTip, inn);
    idx.push(1, tip, inn);
    idx.push(1, inn, nextTip);
  }
  const nor = new Float32Array(pos.length);
  const P = new Float32Array(pos);
  const I = new Uint32Array(idx);
  VertexData.ComputeNormals(P, I, nor);
  const vd = new VertexData();
  vd.positions = P; vd.normals = nor; vd.indices = I;
  vd.uvs = new Float32Array((pos.length / 3) * 2);
  const m = new Mesh('_star', scene);
  vd.applyToMesh(m);
  m.position.set(o.x, o.y, o.z);
  m.rotation.y = o.ry || 0;
  bucket.push(m);
  return m;
}

/**
 * Merge a bucket of parts into one mesh with one material.
 *
 * One merged mesh per material, drawn as thin instances, is what keeps an
 * entire colonnade at three draw calls. Returns null for an empty bucket so
 * callers can skip a material entirely at low quality.
 */
export function mergeBucket(scene, name, bucket, material) {
  if (!bucket.length) return null;
  const m = Mesh.MergeMeshes(bucket, true, true, undefined, false, false);
  bucket.length = 0;
  if (!m) return null;
  m.name = name;
  m.material = material;
  m.isPickable = false;
  m.receiveShadows = true;
  return m;
}
