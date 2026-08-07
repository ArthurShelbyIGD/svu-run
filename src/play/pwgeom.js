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

  /** Uniformly scale everything written so far. Build-time only. Normals are
   *  unchanged by a uniform scale, so they are left alone. */
  scale(k) {
    for (let i = 0; i < this.p.length; i++) this.p[i] *= k;
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
 * SWEPT WINGS — TWO separate blades with a gap between them, not one span.
 *
 * The first version was a single continuous strip from tip to tip, and the
 * close-up capture settled the argument in a second: it read as a crescent, a
 * banana, anything but wings. One shape cannot be two wings. Splitting it and
 * leaving 0.10m of dark bed down the middle costs nothing at distance (where
 * the read is the wide, flat, upswept aspect ratio, which is unchanged) and
 * buys the whole emblem at close range.
 *
 * Each blade is rooted near the centre and rakes up and out, thick at the root
 * and thin at the tip. Returns one [A,B] pair per blade.
 */
function wings(root, tip, steps) {
  const out = [];
  for (let side = -1; side <= 1; side += 2) {
    const A = [], B = [];
    for (let k = 0; k <= steps; k++) {
      const t = k / steps;
      const x = side * (root + (tip - root) * t);
      // Rake, not a chevron. The first split version rose at 38 degrees and
      // the close-up read it as a tick, not as a pair of wings; the blade
      // centreline now climbs about 30 degrees and the root is three times the
      // thickness of the tip, which is what makes it a wing rather than a bar.
      A.push([x, 0.075 + 0.095 * t]);                     // leading edge
      B.push([x, -0.130 + 0.220 * Math.pow(t, 1.60)]);    // trailing edge
    }
    out.push([A, B]);
  }
  return out;
}

export const EMBLEM = { HORSESHOE: 0, HEATER: 1, WINGS: 2 };

/**
 * Outside diameter of the hoop, in metres. ONE number sizes the whole pickup —
 * tube, bed and emblem are all derived from it below.
 *
 * 1.55m is 5.2x the 0.30m star, and inside a 2.4m lane it is a gate the runner
 * runs THROUGH rather than a token beside the line. See the measured pixel
 * table in buildHoop for why 1.30 was not enough. play/powerups.js reads this
 * to size its grab box, so the two can never drift apart.
 */
export const HOOP_OD = 1.55;

/**
 * A powerup pickup: gold hoop, dark bed, gold emblem.
 *
 * THE THREE-LAYER SANDWICH IS THE WHOLE POINT, and it is the fix for the one
 * thing that came out weak last build — "in portrait at 23m the ring reads but
 * the emblem does not". The failure was not emblem-against-background, it was
 * emblem-against-RING: a gold emblem inside a gold hoop merges with it into
 * one undifferentiated gold blob.
 *
 * So the bed goes in between. A dark, matte, non-metallic plate filling most
 * of the hoop's interior separates the two golds by VALUE, which is the one
 * channel that survives distance, bloom and a 390px-wide frame. The emblem is
 * then a bright figure alone in a dark field, and bloom — which erodes a dark
 * figure on a bright ground — fattens it instead.
 *
 * HOW BIG IT ACTUALLY IS, MEASURED rather than assumed — projected with
 * Vector3.Project onto the 390x844 phone frame, which is also the frame the
 * game RENDERS at there (q.scale 1.0), so these are real rendered pixels and
 * a 2x screenshot shows twice as many. Distances are ahead of the PLAYER; the
 * chase camera sits 6m further back again:
 *
 *      1.30m hoop, 23m ahead  ->  36 px wide,  emblem span ~20 px
 *      1.55m hoop, 23m ahead  ->  43 px wide,  emblem span ~26 px
 *      1.55m hoop, 12m ahead  ->  67 px wide,  emblem span ~40 px
 *
 * The hoop went from 1.30 to 1.55 on the strength of that table: it is still
 * comfortably inside a 2.4m lane, and at 1.55 it is a GATE the runner passes
 * through rather than a token it passes near — which is a stronger read than
 * any emblem, at any distance. The emblem is a confirmation at 12-15m, where
 * the player still has time to change lane at every speed the game reaches; at
 * 23m the distinguishing channel is the idle motion (see MOTION in
 * powerups.js), which costs no pixels at all.
 *
 * The three profiles are therefore chosen for ASPECT RATIO first and detail
 * second, because aspect survives to about 6px: the horseshoe is round with a
 * notch, the heater is tall and narrow, the wings are twice as wide as tall.
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
  const tubeR = HOOP_OD * 0.050;                  // 0.078 at OD 1.55
  const rInner = HOOP_OD * 0.5 - tubeR * 2;       // 0.62 — the hole in the hoop

  const tess = q.name === 'low' ? 16 : 24;
  const ring = CreateTorus('pwRing',
    { diameter: HOOP_OD - tubeR * 2, thickness: tubeR * 2, tessellation: tess }, scene);
  ring.material = mat.get('goldLeaf');
  ring.rotation.x = Math.PI / 2;   // torus is authored in XZ; stand it up in XY
  a.add(ring);

  // Bed: an annulus rather than a disc, with a 2cm hole at dead centre that
  // nobody will ever see, because a disc built as a triangle fan and a disc
  // built as an annulus shade identically and this reuses `strip`.
  // rBed against the hoop's rInner leaves a 7cm ring of open air, so the hoop
  // still reads as OPEN — you can see the track through it.
  const rBed = rInner - 0.075;
  const bedSides = q.name === 'low' ? 20 : 30;
  bed.strip(circle(0.02, bedSides), circle(rBed, bedSides), 0.034, true);

  // The emblem stands ~6cm proud of the bed, on the player's side. The
  // profiles below are authored against a 0.42 bed radius and then scaled to
  // whatever this hoop's bed actually is, so the whole pickup resizes from the
  // single HOOP_OD constant.
  // Every profile is authored to stay inside a 0.42 radius, so the whole
  // emblem clears the bed's rim at any hoop size. `parts` is one [A,B] pair
  // per solid piece — the wings are two, everything else is one.
  const em = rBed / 0.42;
  const steps = q.name === 'low' ? 8 : 14;
  let parts;
  if (emblem === EMBLEM.HORSESHOE) parts = [horseshoe(0.145, 0.285, -0.215, steps * 2)];
  else if (emblem === EMBLEM.HEATER) parts = [heater(0.235, 0.275, 0.050, -0.330, steps)];
  else parts = wings(0.050, 0.320, steps);

  const w2 = new Writer();
  for (let i = 0; i < parts.length; i++) w2.strip(parts[i][0], parts[i][1], 0.050);
  w2.scale(em);
  w2.shift(0, 0, -(0.017 + 0.050 * em * 0.5));
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
  // 0.072m of gold wire. At 0.060 the cage was legible but weedy against the
  // bloom coming off the character in the chase shot.
  const tube = 0.036;
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
