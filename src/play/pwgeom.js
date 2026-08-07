// play/pwgeom.js — build-time mesh authoring for the powerup pickups and the
// shield cage. Runs ONCE, in init(). Allocates freely; nothing here is called
// per frame.
//
// WHY THIS FILE EXISTS AT ALL, given track/geom.js already has a Writer.
// Subsystems never import each other (ARCHITECTURE.md §2), and a mesh
// authoring helper is not a compile-time constant, so play/ carries its own
// minimal one rather than reaching into track/. It is deliberately small: one
// primitive, `strip`, plus a torus from Babylon.
//
// WINDING, AND THE TRAP IT KEEPS SETTING
// Babylon culls back faces, and this project has repeatedly shipped geometry
// that was technically present and visually absent because it was inside out
// or edge-on. `strip` therefore AUTO-CORRECTS its own winding: it shoelaces
// the outline it was handed and swaps the two rails if the sign is wrong. You
// cannot build a backwards emblem with it. (The convention it corrects TO:
// walking rail A forwards and rail B backwards must trace a CLOCKWISE outline
// in XY, which is what puts the front face's normal at -Z — the face the
// player, who approaches from -Z, actually sees.)
//
// ALL EMBLEMS ARE AUTHORED IN THE XY PLANE, front face towards -Z, centred on
// the origin. The pickup mesh is then yawed to the path like every other
// track-space object.

import { Mesh, VertexData, CreateTorus } from '../core/bjs.js';

const TAU = Math.PI * 2;

export class Writer {
  constructor() {
    this.p = [];
    this.n = [];
    this.uv = [];
    this.i = [];
  }

  get empty() { return this.i.length === 0; }

  /** One flat-shaded triangle. a, b, c are [x,y,z]. n = -cross(b-a, c-b). */
  tri(a, b, c) {
    const e1x = b[0] - a[0], e1y = b[1] - a[1], e1z = b[2] - a[2];
    const e2x = c[0] - b[0], e2y = c[1] - b[1], e2z = c[2] - b[2];
    let nx = -(e1y * e2z - e1z * e2y);
    let ny = -(e1z * e2x - e1x * e2z);
    let nz = -(e1x * e2y - e1y * e2x);
    const len = Math.hypot(nx, ny, nz);
    if (len < 1e-9) return this;            // degenerate — drop it silently
    nx /= len; ny /= len; nz /= len;

    const base = this.p.length / 3;
    for (const v of [a, b, c]) {
      this.p.push(v[0], v[1], v[2]);
      this.n.push(nx, ny, nz);
      this.uv.push(v[0] * 0.5 + 0.5, v[1] * 0.5 + 0.5);
    }
    this.i.push(base, base + 1, base + 2);
    return this;
  }

  quad(a, b, c, d) { return this.tri(a, b, c).tri(a, c, d); }

  /** Append another writer's geometry, re-basing its indices. */
  merge(o) {
    const base = this.p.length / 3;
    for (let i = 0; i < o.p.length; i++) { this.p.push(o.p[i]); this.n.push(o.n[i]); }
    for (let i = 0; i < o.uv.length; i++) this.uv.push(o.uv[i]);
    for (let i = 0; i < o.i.length; i++) this.i.push(base + o.i[i]);
    return this;
  }

  /** Translate everything written so far. Build-time only. */
  shift(dx, dy, dz) {
    for (let i = 0; i < this.p.length; i += 3) {
      this.p[i] += dx; this.p[i + 1] += dy; this.p[i + 2] += dz;
    }
    return this;
  }

  /**
   * A flat slab of thickness `t` filling the space between two 2D polylines.
   *
   * This one primitive builds every emblem in the game:
   *   horseshoe  A = inner arc + legs, B = outer arc + legs   (open)
   *   shield     A = right profile,    B = left profile        (open)
   *   wings      A = top profile,      B = bottom profile      (open)
   *   bed disc   A = inner circle,     B = outer circle        (closed)
   *
   * A and B must have the same length. Open strips get end caps.
   */
  strip(A, B, t, closed = false) {
    const n = A.length;
    if (n < 2 || B.length !== n) return this;
    const hz = t * 0.5;

    // Winding auto-correction. See the header.
    if (!closed) {
      let s = 0;
      const outline = [];
      for (let i = 0; i < n; i++) outline.push(A[i]);
      for (let i = n - 1; i >= 0; i--) outline.push(B[i]);
      for (let i = 0; i < outline.length; i++) {
        const p = outline[i], q = outline[(i + 1) % outline.length];
        s += p[0] * q[1] - q[0] * p[1];
      }
      if (s > 0) { const tmp = A; A = B; B = tmp; }
    }

    const fA = (i) => [A[i][0], A[i][1], -hz];
    const bA = (i) => [A[i][0], A[i][1], +hz];
    const fB = (i) => [B[i][0], B[i][1], -hz];
    const bB = (i) => [B[i][0], B[i][1], +hz];

    const last = closed ? n : n - 1;
    for (let i = 0; i < last; i++) {
      const j = (i + 1) % n;
      this.quad(fA(i), fB(i), fB(j), fA(j));    // front, -Z
      this.quad(bA(j), bB(j), bB(i), bA(i));    // back, +Z
      this.quad(fB(i), bB(i), bB(j), fB(j));    // B rail wall
      this.quad(bA(i), fA(i), fA(j), bA(j));    // A rail wall
    }
    if (!closed) {
      this.quad(fA(0), bA(0), bB(0), fB(0));
      this.quad(bA(n - 1), fA(n - 1), fB(n - 1), bB(n - 1));
    }
    return this;
  }

  toMesh(name, scene, material) {
    const m = new Mesh(name, scene);
    const vd = new VertexData();
    vd.positions = this.p;
    vd.normals = this.n;
    vd.uvs = this.uv;
    vd.indices = this.i;
    vd.applyToMesh(m);
    if (material) m.material = material;
    m.isPickable = false;
    return m;
  }
}

/** Writers grouped by material, merged into one multi-material mesh. */
export class Assembly {
  constructor(scene) {
    this.scene = scene;
    this.mats = [];
    this.writers = [];
    this.extra = [];   // pre-built meshes (torus) folded into the merge
  }

  w(material) {
    let idx = this.mats.indexOf(material);
    if (idx < 0) { idx = this.mats.length; this.mats.push(material); this.writers.push(new Writer()); }
    return this.writers[idx];
  }

  add(mesh) { this.extra.push(mesh); return this; }

  build(name) {
    const parts = [];
    for (let k = 0; k < this.writers.length; k++) {
      if (this.writers[k].empty) continue;
      parts.push(this.writers[k].toMesh(`${name}_p${k}`, this.scene, this.mats[k]));
    }
    for (const e of this.extra) parts.push(e);
    if (parts.length === 0) return null;
    let out;
    if (parts.length === 1) {
      out = parts[0];
      out.name = name;
    } else {
      out = Mesh.MergeMeshes(parts, true, true, undefined, false, true);
      out.name = name;
    }
    out.isPickable = false;
    return out;
  }
}

/* --------------------------------------------------------------- profiles */

function circle(r, sides, y0 = 0) {
  const out = [];
  for (let k = 0; k < sides; k++) {
    const a = (k / sides) * TAU;
    out.push([Math.cos(a) * r, Math.sin(a) * r + y0]);
  }
  return out;
}

/**
 * HORSESHOE — the magnet. An annular arc opening downwards with two straight
 * legs, which is the universal drawing of a magnet and the only one of the
 * three emblems with a notch in its silhouette.
 */
function horseshoe(rIn, rOut, legY, steps) {
  const A = [[rIn, legY]], B = [[rOut, legY]];
  for (let k = 0; k <= steps; k++) {
    const a = (k / steps) * Math.PI;         // 0 -> 180 degrees, CCW over the top
    A.push([Math.cos(a) * rIn, Math.sin(a) * rIn]);
    B.push([Math.cos(a) * rOut, Math.sin(a) * rOut]);
  }
  A.push([-rIn, legY]);
  B.push([-rOut, legY]);
  return [A, B];
}

/**
 * HEATER SHIELD — straight shoulders, straight sides for the top third, then
 * a cosine taper to a point. Tall and narrow: the opposite proportion to the
 * wings, which is what makes the pair separable at 23 metres.
 */
function heater(hw, top, shoulder, tip, steps) {
  const A = [[hw, top]], B = [[-hw, top]];
  A.push([hw, shoulder]); B.push([-hw, shoulder]);
  for (let k = 1; k <= steps; k++) {
    const u = k / steps;
    const y = shoulder + (tip - shoulder) * u;
    const w = hw * Math.cos(u * Math.PI * 0.5);
    A.push([w, y]); B.push([-w, y]);
  }
  return [A, B];
}

/**
 * SWEPT WINGS — one continuous span, thick at the hub and raked up to thin
 * tips. Twice as wide as it is tall; that ratio is the read.
 */
function wings(halfSpan, steps) {
  const A = [], B = [];
  for (let k = -steps; k <= steps; k++) {
    const u = k / steps;                       // -1 .. 1
    const s = Math.abs(u);
    const x = u * halfSpan;
    A.push([x, 0.085 + 0.105 * Math.pow(s, 1.5)]);        // top edge
    B.push([x, -0.105 + 0.225 * Math.pow(s, 2.2)]);       // bottom edge
  }
  return [A, B];
}

export const EMBLEM = { HORSESHOE: 0, HEATER: 1, WINGS: 2 };

/**
 * A powerup pickup: gold hoop, dark bed, gold emblem.
 *
 * THE THREE-LAYER SANDWICH IS THE WHOLE POINT, and it is the fix for the one
 * thing that came out weak last build — "in portrait at 23m the ring reads but
 * the emblem does not". The failure was not emblem-against-background, it was
 * emblem-against-RING: at 23m a 1.3m gold hoop is 44 CSS px across and a gold
 * emblem inside it merges with it into one undifferentiated gold blob.
 *
 * So the bed goes in between. A dark, matte, non-metallic plate filling most
 * of the hoop's interior separates the two golds by VALUE, which is the one
 * channel that survives distance, bloom and a 390px-wide frame. The emblem is
 * then a bright figure alone in a dark field, and bloom — which erodes a dark
 * figure on a bright ground — fattens it instead.
 *
 * NO EMISSIVE BEADS ON THE HOOP. At 23m they are 2px and add nothing; at 12m
 * they read as white stones bezel-set into metal, which is the colour
 * contract's exact phrase for "scenery, you cannot have it".
 */
export function buildHoop(scene, mat, q, emblem) {
  const a = new Assembly(scene);
  const gold = a.w(mat.get('goldLeaf'));
  // The bed uses an EXISTING material name, not a new one. mat/ is another
  // agent's directory and the name contract there is the interface;
  // `marbleDark` is a dark blue-grey dielectric marble — exactly the dark,
  // low-specular plate this needs — and it is already part of the vault's
  // stone vocabulary rather than being a fourth colour.
  const bed = a.w(mat.get('marbleDark'));

  // Babylon's torus `thickness` is the TUBE DIAMETER and `diameter` is the
  // centreline diameter, so the outside diameter is diameter + thickness.
  const OD = 1.30;                 // outside diameter — 4.3x the 0.30m star
  const tubeR = 0.070;
  const rInner = OD * 0.5 - tubeR * 2;   // 0.51 — the hole in the hoop

  const tess = q.name === 'low' ? 14 : 22;
  const ring = CreateTorus('pwRing',
    { diameter: OD - tubeR * 2, thickness: tubeR * 2, tessellation: tess }, scene);
  ring.material = mat.get('goldLeaf');
  ring.rotation.x = Math.PI / 2;   // torus is authored in XZ; stand it up in XY
  a.add(ring);

  // Bed: an annulus rather than a disc, with a 2cm hole at dead centre that
  // nobody will ever see, because a disc built as a triangle fan and a disc
  // built as an annulus shade identically and this reuses `strip`.
  // 0.42 against the hoop's 0.51 hole leaves a 9cm open annulus.
  const bedSides = q.name === 'low' ? 20 : 30;
  bed.strip(circle(0.02, bedSides), circle(0.42, bedSides), 0.030, true);

  // The emblem stands ~5cm proud of the bed, on the player's side. Every
  // profile is sized to stay inside the bed's 0.42 radius.
  const steps = q.name === 'low' ? 8 : 14;
  let prof;
  if (emblem === EMBLEM.HORSESHOE) prof = horseshoe(0.145, 0.285, -0.215, steps * 2);
  else if (emblem === EMBLEM.HEATER) prof = heater(0.235, 0.275, 0.050, -0.330, steps);
  else prof = wings(0.355, steps);

  const w2 = new Writer();
  w2.strip(prof[0], prof[1], 0.050);
  w2.shift(0, 0, -0.038);
  gold.merge(w2);

  const mesh = a.build('pwHoop');
  mesh.alwaysSelectAsActiveMesh = false;
  return mesh;
}

/**
 * The shield cage: three orthogonal great circles, an armillary.
 *
 * THE TRAP THIS AVOIDS, which cost a build last time: Babylon composes
 * mesh.rotation as Yaw * Pitch * Roll — roll FIRST — so a pitch is applied
 * about an axis the roll has already moved, and two rings meant to be
 * perpendicular ended up coplanar. From dead astern that is a single gold line
 * up the runner's back, and it grades perfectly well from a posed
 * three-quarter view, which is why it survived.
 *
 * Here each ring is rotated about EXACTLY ONE axis, so there is no composition
 * to get wrong: the torus is authored in XZ (axis +Y), and rotating it by 90
 * degrees about X or about Z lands it in XY (axis Z) or YZ (axis X). Three
 * planes, mutually perpendicular by construction, then merged into one rigid
 * mesh that spins about Y — so the two vertical rings stay 90 degrees apart
 * forever and at least one of them is always well open to the camera.
 */
export function buildCage(scene, mat, q, radius) {
  const tess = q.name === 'low' ? 14 : 22;
  const tube = 0.030;
  const m = mat.get('goldLeaf');
  const parts = [];
  for (let i = 0; i < 3; i++) {
    const r = CreateTorus(`cage${i}`, { diameter: radius * 2, thickness: tube * 2, tessellation: tess }, scene);
    r.material = m;
    if (i === 1) r.rotation.x = Math.PI / 2;
    if (i === 2) r.rotation.z = Math.PI / 2;
    parts.push(r);
  }
  const out = Mesh.MergeMeshes(parts, true, true, undefined, false, false);
  out.name = 'pwCage';
  out.material = m;
  out.isPickable = false;
  return out;
}
