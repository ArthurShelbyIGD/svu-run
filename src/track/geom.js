// track/geom.js — build-time mesh authoring.
//
// Everything in here runs ONCE, in init(). It allocates freely, because the
// output is a handful of shared prototype meshes that are then hardware
// instanced for the rest of the session. Nothing here is called per frame.
//
// WHY THIS EXISTS
// The track used to be MeshBuilder boxes with flat colours, which is exactly
// what "Minecraft looking blocks" means. Detail in a mobile runner cannot come
// from textures (bandwidth) or from many draw calls (CPU), so it comes from
// geometry that is authored once, merged into one multi-material mesh per
// object, and instanced. A merged obstacle costs the same number of draw calls
// as the old single box did, and one scene mesh instead of eight.
//
// WINDING CONVENTION
// Babylon's VertexData.ComputeNormals produces  n = -cross(v1-v0, v2-v1).
// Every helper here follows the same rule and writes flat normals directly, so
// a face's visible side always matches the normal it is shaded with. Faces are
// emitted with two tangent axes t,u chosen so that  t x u = -N.

import { Mesh, VertexData } from '../core/bjs.js';

const TAU = Math.PI * 2;

export class Writer {
  constructor() {
    this.p = [];
    this.n = [];
    this.uv = [];
    this.i = [];
  }

  get empty() { return this.i.length === 0; }

  /** One flat-shaded triangle. a, b, c are [x,y,z]. */
  tri(a, b, c) {
    const e1x = b[0] - a[0], e1y = b[1] - a[1], e1z = b[2] - a[2];
    const e2x = c[0] - b[0], e2y = c[1] - b[1], e2z = c[2] - b[2];
    let nx = -(e1y * e2z - e1z * e2y);
    let ny = -(e1z * e2x - e1x * e2z);
    let nz = -(e1x * e2y - e1y * e2x);
    const len = Math.hypot(nx, ny, nz) || 1;
    nx /= len; ny /= len; nz /= len;

    const base = this.p.length / 3;
    const ax = Math.abs(nx), ay = Math.abs(ny), az = Math.abs(nz);
    for (const v of [a, b, c]) {
      this.p.push(v[0], v[1], v[2]);
      this.n.push(nx, ny, nz);
      // Cheap planar UVs. None of the track materials are textured today, but
      // merging demands every source share the same attribute set.
      if (ay >= ax && ay >= az) this.uv.push(v[0] * 0.25, v[2] * 0.25);
      else if (ax >= az) this.uv.push(v[2] * 0.25, v[1] * 0.25);
      else this.uv.push(v[0] * 0.25, v[1] * 0.25);
    }
    this.i.push(base, base + 1, base + 2);
    return this;
  }

  /** Planar quad. a,b,c,d must wind so that -cross(b-a, c-b) faces outward. */
  quad(a, b, c, d) {
    this.tri(a, b, c);
    this.tri(a, c, d);
    return this;
  }

  /** Convex fan around ring[0]. */
  fan(ring, reverse) {
    for (let k = 1; k < ring.length - 1; k++) {
      if (reverse) this.tri(ring[0], ring[k + 1], ring[k]);
      else this.tri(ring[0], ring[k], ring[k + 1]);
    }
    return this;
  }

  /** Connect two equal-length rings with a quad strip. Lower ring first. */
  skirt(lower, upper, closed = true) {
    const n = lower.length;
    const last = closed ? n : n - 1;
    for (let k = 0; k < last; k++) {
      const k2 = (k + 1) % n;
      this.quad(lower[k], lower[k2], upper[k2], upper[k]);
    }
    return this;
  }

  /**
   * Axis-aligned box with all twelve edges chamfered.
   *
   * The chamfer is the entire point: a hard 90 degree edge under a soft studio
   * environment renders as a flat value change and reads as a plain block. A
   * 4-6cm chamfer catches a bright specular line along every edge, which is
   * what makes cut metal look cut.
   */
  bevelBox(cx, cy, cz, hx, hy, hz, b = 0.05) {
    const bb = Math.min(b, hx * 0.49, hy * 0.49, hz * 0.49);
    const rings = [
      rectRing(cx, cy - hy, cz, hx - bb, hz - bb),
      rectRing(cx, cy - hy + bb, cz, hx, hz),
      rectRing(cx, cy + hy - bb, cz, hx, hz),
      rectRing(cx, cy + hy, cz, hx - bb, hz - bb),
    ];
    this.fan(rings[0], true);
    for (let r = 0; r < 3; r++) this.skirt(rings[r], rings[r + 1]);
    this.fan(rings[3], false);
    return this;
  }

  /** Plain box, no chamfer. For thin inlays where a chamfer would vanish. */
  box(cx, cy, cz, hx, hy, hz) {
    const lo = rectRing(cx, cy - hy, cz, hx, hz);
    const hi = rectRing(cx, cy + hy, cz, hx, hz);
    this.fan(lo, true);
    this.skirt(lo, hi);
    this.fan(hi, false);
    return this;
  }

  /**
   * Vertical prism / cylinder / cone, optionally chamfered at both ends.
   * `sides` drives the facet count — low values are deliberate here, a
   * ten-sided column reads as cut stone where a smooth one reads as plastic.
   */
  prism(cx, cy, cz, rBot, rTop, h, sides = 10, phase = 0, bevel = 0) {
    const y0 = cy - h * 0.5, y1 = cy + h * 0.5;
    const bb = Math.min(bevel, h * 0.24, rBot * 0.4, rTop * 0.4);
    const rings = [];
    if (bb > 0) {
      rings.push(circleRing(cx, y0, cz, rBot - bb, sides, phase));
      rings.push(circleRing(cx, y0 + bb, cz, rBot, sides, phase));
      rings.push(circleRing(cx, y1 - bb, cz, rTop, sides, phase));
      rings.push(circleRing(cx, y1, cz, rTop - bb, sides, phase));
    } else {
      rings.push(circleRing(cx, y0, cz, rBot, sides, phase));
      rings.push(circleRing(cx, y1, cz, rTop, sides, phase));
    }
    this.fan(rings[0], true);
    for (let r = 0; r < rings.length - 1; r++) this.skirt(rings[r], rings[r + 1]);
    this.fan(rings[rings.length - 1], false);
    return this;
  }

  /** Flat ring / torus-ish band lying in XZ. Cheap collar for columns. */
  collar(cx, cy, cz, rInner, rOuter, h, sides = 12) {
    const y0 = cy - h * 0.5, y1 = cy + h * 0.5;
    const li = circleRing(cx, y0, cz, rInner, sides, 0);
    const lo = circleRing(cx, y0, cz, rOuter, sides, 0);
    const ui = circleRing(cx, y1, cz, rInner, sides, 0);
    const uo = circleRing(cx, y1, cz, rOuter, sides, 0);
    this.skirt(li, lo);          // underside
    this.skirt(lo, uo);          // outer wall
    this.skirt(uo, ui);          // top
    this.skirt(ui, li);          // inner wall
    return this;
  }

  /**
   * Faceted puffy star, the shape of the gold stars in the reference NFT:
   * a flat rim polygon with a raised ridge running from the centre out to each
   * point, front and back. Every facet is flat, so it throws a different
   * highlight as it turns — which is the whole read of a cut gold ornament.
   *
   * axis 'z' stands the star up facing -Z; axis 'y' lays it flat facing +Y.
   */
  star(cx, cy, cz, rOuter, rInner, points, depth, axis = 'z', rot = 0) {
    const n = points * 2;
    const rim = [];
    for (let k = 0; k < n; k++) {
      const a = rot + (k / n) * TAU;
      const r = (k % 2 === 0) ? rOuter : rInner;
      const px = Math.cos(a) * r, py = Math.sin(a) * r;
      rim.push(axis === 'y' ? [cx + px, cy, cz + py] : [cx + px, cy + py, cz]);
    }
    const front = axis === 'y' ? [cx, cy + depth, cz] : [cx, cy, cz - depth];
    const back = axis === 'y' ? [cx, cy - depth, cz] : [cx, cy, cz + depth];
    for (let k = 0; k < n; k++) {
      const k2 = (k + 1) % n;
      this.tri(front, rim[k], rim[k2]);
      this.tri(back, rim[k2], rim[k]);
    }
    return this;
  }

  /** Octahedral gem. Faceted by construction, eight triangles. */
  gem(cx, cy, cz, r, ry = r, rz = r) {
    const t = [cx, cy + ry, cz], b = [cx, cy - ry, cz];
    const e = [
      [cx + r, cy, cz], [cx, cy, cz + rz], [cx - r, cy, cz], [cx, cy, cz - rz],
    ];
    for (let k = 0; k < 4; k++) {
      const k2 = (k + 1) % 4;
      this.tri(t, e[k], e[k2]);
      this.tri(b, e[k2], e[k]);
    }
    return this;
  }

  /**
   * Chevron / arrow plate with real thickness, lying in a chosen plane.
   *
   * The old wall arrow was a single-sided triangle fan whose normals pointed
   * away from the player, so it shaded pure black — the corner's only readable
   * instruction rendered as a hole. A solid plate cannot have that failure:
   * both faces exist and are lit.
   *
   * plane 'xy' stands it up pointing along +X; plane 'xz' lays it flat.
   */
  arrow(cx, cy, cz, len, halfW, thick, plane = 'xz') {
    // Outline in 2D (along, across), anticlockwise, tip first. A negative
    // `len` mirrors the arrow; the outline is then reversed so the winding —
    // and therefore every normal — survives the mirror.
    const s = Math.sign(len) || 1;
    const l = Math.abs(len);
    const o = [
      [s * l, 0], [s * -l * 0.47, halfW], [s * -l * 0.14, halfW * 0.48],
      [s * -l * 0.14, -halfW * 0.48], [s * -l * 0.47, -halfW],
    ];
    if (s < 0) o.reverse();
    const to = (a, s, side) => (plane === 'xy'
      ? [cx + a, cy + s, cz + side]
      : [cx + a, cy + side, cz + s]);
    const faceN = plane === 'xy' ? -thick : thick;   // toward the viewer
    const faceF = -faceN;
    const near = o.map((v) => to(v[0], v[1], faceN));
    const far = o.map((v) => to(v[0], v[1], faceF));
    this.fan(near, false);
    this.fan(far, true);
    this.skirt(far, near);
    return this;
  }

  /**
   * Hanging banner with a scalloped lower edge, thin but solid.
   * Hangs downward from y = cy, spanning w wide and h tall.
   */
  banner(cx, cy, cz, w, h, thick, scallops = 3) {
    const hw = w * 0.5;
    const steps = scallops * 6;
    const top = [];
    const bot = [];
    for (let k = 0; k <= steps; k++) {
      const u = k / steps;
      const x = cx - hw + w * u;
      // Scalloped hem: each scallop dips to its deepest point at its centre.
      const s = Math.abs(Math.sin(u * Math.PI * scallops));
      const y = cy - h + (1 - s) * h * 0.16;
      top.push([x, cy, cz]);
      bot.push([x, y, cz]);
    }
    const off = (arr, dz) => arr.map((v) => [v[0], v[1], v[2] + dz]);
    const tN = off(top, -thick), bN = off(bot, -thick);
    const tF = off(top, thick), bF = off(bot, thick);
    for (let k = 0; k < steps; k++) {
      this.quad(bN[k], bN[k + 1], tN[k + 1], tN[k]);       // front (-Z)
      this.quad(bF[k + 1], bF[k], tF[k], tF[k + 1]);       // back  (+Z)
      this.quad(bF[k], bF[k + 1], bN[k + 1], bN[k]);       // hem rim
    }
    // side rims
    this.quad(tF[0], bF[0], bN[0], tN[0]);
    this.quad(tN[steps], bN[steps], bF[steps], tF[steps]);
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

function rectRing(cx, cy, cz, hx, hz) {
  return [
    [cx - hx, cy, cz - hz],
    [cx + hx, cy, cz - hz],
    [cx + hx, cy, cz + hz],
    [cx - hx, cy, cz + hz],
  ];
}

function circleRing(cx, cy, cz, r, sides, phase) {
  const out = [];
  for (let k = 0; k < sides; k++) {
    const a = phase + (k / sides) * TAU;
    out.push([cx + Math.cos(a) * r, cy, cz + Math.sin(a) * r]);
  }
  return out;
}

/**
 * A group of Writers, one per material, merged into a single multi-material
 * mesh.
 *
 * This is the trick that buys geometric density for free. An obstacle built
 * from eight parented meshes costs eight scene meshes and eight per-frame
 * culling tests per obstacle; merged, it costs one instance and exactly the
 * same number of draw calls as the parts had distinct materials.
 */
export class Assembly {
  constructor(scene) {
    this.scene = scene;
    this.mats = [];
    this.writers = [];
  }

  /** Writer for this material, created on demand. */
  w(material) {
    let idx = this.mats.indexOf(material);
    if (idx < 0) { idx = this.mats.length; this.mats.push(material); this.writers.push(new Writer()); }
    return this.writers[idx];
  }

  build(name) {
    const parts = [];
    for (let k = 0; k < this.writers.length; k++) {
      if (this.writers[k].empty) continue;
      parts.push(this.writers[k].toMesh(`${name}_p${k}`, this.scene, this.mats[k]));
    }
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
    out.alwaysSelectAsActiveMesh = false;
    return out;
  }
}
