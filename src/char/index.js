// char/ — the player character: procedural mesh, hierarchy, animation.
//
// OWNERSHIP: this directory owns everything about how the runner looks and
// moves. It reads player state from play/ but never writes to it.
//
// THE CAMERA IS BEHIND THE CHARACTER FOR THE ENTIRE GAME.
// Everything here is ordered by that fact. The face is seen on the results
// screen and nowhere else. What players look at for an hour is the back of a
// hooded onesie with a cape on it.
//
// THE DECISION THAT DEFINES THIS FILE
//
// Pavé used to be a tiled normal map. A critic looking only at rendered frames
// called the result "a grey knitted sponge ball with a black bin-bag stuck to
// it". Both halves of that were correct and both were geometric problems
// wearing material costumes:
//
//   * A normal-mapped stone two pixels across averages to flat matte grey, and
//     leaves the silhouette a perfectly smooth arc. Real pavé crenellates the
//     outline. So the stones are now REAL GEOMETRY — see pave.js — laid at a
//     constant physical pitch over every part, sitting proud of a dark setting
//     bed that shows through the gaps.
//   * The cape was dark chrome against a dark world, so it rendered as a hole
//     cut in the screen. It is now polished silver with ribs, which is what the
//     reference wing actually is.
//
// Parts are MERGED per material (geom.js), so the whole character is about a
// dozen draw calls despite carrying ~600 individually cut stones.

import { TransformNode } from '../core/bjs.js';
import { STATE } from '../play/index.js';
import { Geo, ellipsoid, surface, tube, torus, arc, pipe, gem } from './geom.js';
import { stoneField } from './pave.js';
import { Cape } from './cape.js';

// Proportions in metres. These numbers ARE the character.
//
// Head-to-body was 1 : 0.79 and the reference is close to 1 : 1. From directly
// behind — the view that is on screen all game — the head was so much wider
// than the torso that it eclipsed the entire body and the character read as a
// ball with boots. The torso is longer and the head sits higher for that
// reason, while the head stays over half the standing height because oversized
// head is the recognisable part of the collection.
const P = {
  standH: 1.66,
  headR: 0.408,
  headY: 1.205,
  faceR: 0.328,
  faceZ: 0.158,          // how far the face centre sits forward of the head
  earR: 0.168,
  earSpread: 0.318,
  earY: 0.80,            // fraction of headR above centre
  bodyW: 0.318, bodyH: 0.352, bodyD: 0.262,
  bodyY: 0.640,
  upperLen: 0.205, foreLen: 0.195, armR: 0.088,
  handR: 0.104,
  shoulderX: 0.298, shoulderY: 0.880,
  legR: 0.104, legLen: 0.205,
  bootR: 0.142,
  hipX: 0.147, hipY: 0.452,
  antennaLen: 0.40, orbR: 0.104,
  eyeR: 0.082, eyeX: 0.130, eyeY: 0.005,
};

const TWO_PI = Math.PI * 2;

/** Signed power. Squares off a circular cross-section toward a rounded box. */
function sgp(v, e) {
  return (v < 0 ? -1 : 1) * Math.pow(Math.abs(v), e);
}

export default class Character {
  constructor(ctx) {
    this.ctx = ctx;
    this.root = null;
    this.parts = {};
    this.phase = 0;
    this._lean = 0;
    this._stretch = 1;
    this._flutter = 0;
    this._w = [0, 0, 0];

    // cape driver state — all pre-allocated, see ARCHITECTURE §4
    this._lastX = 0;
    this._lastVX = 0;
    this._lastVY = 0;
    this._lastYaw = 0;
    this._lastZ = 0;
    this._bob = 0;
    this._lastBob = 0;
    this._aX = 0;
    this._aY = 0;
    this._bobV = 0;
    this._warm = false;
    this.stoneCount = 0;
  }

  init() {
    const scene = this.ctx.scene;
    const q = this.ctx.config.q;
    const low = q.name === 'low';
    const high = q.name === 'high';

    this.su = low ? 18 : (high ? 30 : 24);
    this.sv = low ? 11 : (high ? 18 : 14);
    this.sd = low ? 7 : (high ? 12 : 9);     // detail parts: cuffs, fingers
    this.lowQ = low;

    // ONE pitch for the whole character. Stones that change size between the
    // head, the torso and the boots is the fastest way to break the illusion,
    // and the previous build's did.
    //
    // 0.072m on a 0.85m-wide hood puts roughly 12 stones across the visible
    // crown, which is what the reference shows. The old normal map ran at more
    // than 70, which is why it dissolved into fabric texture.
    this.pitch = low ? 0.086 : (high ? 0.066 : 0.076);
    this.facets = low ? 5 : 6;

    // A private deterministic stream. Stone rotations and micro-jitter are
    // procedural geometry, not gameplay, but they still must be identical
    // between runs or the capture harness is worthless — hence a fork of
    // ctx.rng rather than Math.random. ARCHITECTURE §4.3.
    const fork = this.ctx.rng.fork();
    this.rand = () => fork.next();

    this.root = new TransformNode('charRoot', scene);
    const body = new TransformNode('charBody', scene);
    body.parent = this.root;
    this.parts.body = body;

    this._buildTorso(body);
    this._buildHead(body);
    this._buildArms(body);
    this._buildLegs(body);
    this._buildCape(body, low, high);

    const world = this.ctx.tryGet('world');
    if (world) {
      world.addCaster(this.root);
      // The character carries its own light tent. Without it, pavé in a dark
      // zone renders as grey lumps regardless of how the material is tuned.
      world.attachPortraitRig(this.root);
    }
  }

  /**
   * Emit one stone field, accumulating the total for the perf budget.
   *
   * NOTE: this deliberately does NOT set the Geo transform. It used to reset it
   * to the identity, which silently teleported the entire torso's stone field
   * down to the character's feet — the torso rendered as a bare dark chrome egg
   * with a pile of loose diamonds around the boots. Invisible from the rear
   * pose, obvious in one profile frame. Callers set the transform.
   */
  _stones(geo, surf, opts) {
    opts.pitch = opts.pitch === undefined ? this.pitch : opts.pitch;
    opts.facets = this.facets;
    opts.rng = this.rand;
    const f = stoneField(surf, opts);
    geo.add(f);
    this.stoneCount += f.count;
    return f;
  }

  // ---- the onesie ------------------------------------------------------

  /**
   * Torso, shoulders, hips and the garment details that sell it as clothing.
   *
   * The body is one parametric surface rather than a scaled sphere, and the
   * SAME function is handed to the stone field, so every stone sits exactly on
   * the fabric instead of on a nominal sphere near it.
   */
  _buildTorso(body) {
    const mat = this.ctx.get('mat');

    // v = 0 at the neck opening, 1 at the hem. Deliberately not a full sphere:
    // the top is cut off because the hood's cowl covers it, and the bottom is
    // flat-ish because the onesie ends in a hem band.
    const bodySurf = (u, v, out) => {
      const a = (0.10 + 0.86 * v) * Math.PI;
      const s = Math.sin(a), c = Math.cos(a);
      // squarer than a sphere -> a shoulder line and a hip line
      const prof = Math.pow(Math.max(0, s), 0.60);
      // waist pinch, hip flare
      const t = Math.min(1, Math.max(0, (v - 0.10) / 0.72));
      const waist = 1 - 0.105 * Math.sin(Math.PI * t) + 0.055 * t * t;
      // soft vertical fabric creases
      const crease = 0.016 * Math.cos(u * TWO_PI * 6) * Math.min(1, v * 2.4);
      const k = prof * waist + crease;
      const ph = u * TWO_PI;
      out[0] = P.bodyW * k * sgp(Math.sin(ph), 0.86);
      out[1] = P.bodyH * c;
      out[2] = P.bodyD * k * sgp(Math.cos(ph), 0.86);
    };
    this._bodySurf = bodySurf;

    // --- the setting: a dark bed that the stones sit proud of ---
    // Slightly shrunk so the stones genuinely overhang it. The gaps between
    // stones are where the contrast comes from; if the bed sits flush with the
    // girdles there are no gaps and it goes back to reading as one grey mass.
    const bed = new Geo();
    bed.at(0, P.bodyY, 0, 0, 0, 0, 0.982, 0.99, 0.982);
    bed.add(surface(bodySurf, this.su, this.sv, 2, 1));
    bed.toMesh('onesieBed', this.ctx.scene, mat.get('darkChrome'), body);

    // Front placket: the zip runs down the chest, so no stones there.
    const g = new Geo();
    g.at(0, P.bodyY, 0);
    this._stones(g, bodySurf, {
      v0: 0.02, v1: 0.985,
      omit: (x, y, z) => Math.abs(x) < 0.050 && z > P.bodyD * 0.55,
    });
    g.toMesh('onesieStones', this.ctx.scene, mat.get('whiteGold'), body);

    // --- metal garment furniture ---
    const t = new Geo();
    // shoulder caps: small masses where the sleeves meet the body
    for (const s of [-1, 1]) {
      t.at(s * P.shoulderX * 0.90, P.shoulderY - 0.010, 0, 0, 0, s * -0.30);
      t.add(ellipsoid({ rx: 0.104, ry: 0.092, rz: 0.100, e1: 0.85, su: this.sd + 4, sv: this.sd }));
    }
    // hem band at the bottom of the onesie
    t.at(0, P.bodyY - P.bodyH * 0.965, 0, Math.PI / 2, 0, 0, 1.0, 1.0, 0.90);
    t.add(torus(P.bodyW * 0.845, 0.030, this.su, this.sd, null, 0.75));
    t.toMesh('onesieTrim', this.ctx.scene, mat.get('polRhodium'), body);

    // --- gold: the zip with real teeth, and its pull ---
    //
    // The gold used to be a ribbon tied over the crown of the hood, which read
    // as gift wrap around a ball. In the reference the gold is the hood OPENING
    // and a front placket zip, and nothing else. It has been moved to both.
    const z = new Geo();
    const zTop = P.shoulderY - 0.015, zBot = P.bodyY - P.bodyH * 0.90;
    const rings = [];
    const zn = 10;
    const zAt = (f) => {
      const v = 0.055 + 0.86 * f;
      const p = [0, 0, 0];
      this._bodySurf(0, v, p);
      return [0, P.bodyY + p[1], p[2] * 1.005];
    };
    for (let i = 0; i <= zn; i++) {
      const p = zAt(i / zn);
      rings.push([0, p[1], p[2], 0.014, 0.011]);
    }
    z.at(0, 0, 0);
    z.add(tube(rings, 6, true, true, 1, 6));
    // teeth — individually modelled, alternating sides. At gameplay distance
    // this is a dotted gold line down the chest, which is exactly what the
    // reference shows and what a smooth tube does not give you.
    const teeth = this.lowQ ? 12 : 20;
    for (let i = 0; i < teeth; i++) {
      const p = zAt(0.03 + 0.94 * (i / (teeth - 1)));
      const side = (i & 1) ? 1 : -1;
      z.at(side * 0.017, p[1], p[2], 0, 0, 0, 0.7, 0.5, 0.7);
      z.add(gem(0.020, 4, 0.9));
    }
    // zip pull
    const pull = zAt(0.99);
    z.at(0, pull[1] - 0.010, pull[2] + 0.020, 0.5);
    z.add(gem(0.034, 6, 0.9));
    z.toMesh('zip', this.ctx.scene, mat.get('polGold'), body);
    void zTop; void zBot;
  }

  // ---- the hood --------------------------------------------------------

  _buildHead(body) {
    const mat = this.ctx.get('mat');
    const scene = this.ctx.scene;

    const head = new TransformNode('head', scene);
    head.parent = body;
    head.position.y = P.headY;
    this.parts.head = head;

    // ONE hood surface, used for the setting bed, the stones and the aperture
    // rim. v = 0 at the crown, 1 at the bottom edge of the cowl.
    //
    // The previous version built the dome from a superellipsoid and the cowl
    // from a lathe whose profile ran the wrong way, so the "cowl over the
    // shoulders" was in fact a second cap sitting on top of the crown. That is
    // the sort of thing you only find by rebuilding from one definition.
    const R = P.headR;
    const hoodSurf = (u, v, out) => {
      let r, y;
      if (v <= 0.70) {
        const a = (v / 0.70) * 0.80 * Math.PI;
        r = Math.sin(a) * R;
        y = Math.cos(a) * R * 1.00;
      } else {
        // A SHORT cowl. The first version ran 20cm down the back and covered
        // the shoulders, the chest and half the torso, so from directly behind
        // the character was a ball with boots and no body at all. The hood has
        // to stop at the shoulder line or the whole proportion argument is
        // moot — you cannot fix a head-to-body ratio you cannot see.
        const s = (v - 0.70) / 0.30;
        const a = 0.80 * Math.PI;
        r = Math.sin(a) * R * (1 + 0.42 * Math.sin(Math.PI * Math.min(1, s * 1.15)));
        y = Math.cos(a) * R - s * 0.085;
      }
      // Eight gores. A hood is sewn from panels, and panels are what break up
      // the specular ring a smooth ball reflects. Even count so a ridge — not a
      // trough — lands on the back meridian, which is dead centre of frame for
      // the whole game.
      const gore = Math.cos(u * TWO_PI * 8);
      const k = 1 + 0.032 * Math.sign(gore) * Math.pow(Math.abs(gore), 0.6) * Math.min(1, v * 3);
      const ph = u * TWO_PI;
      out[0] = r * k * Math.sin(ph);
      out[1] = y - 0.018;
      out[2] = r * k * 1.02 * Math.cos(ph) - 0.020;
    };
    this._hoodSurf = hoodSurf;

    // The face aperture is defined as "inside the face sphere", so the opening
    // is shaped by the real intersection of the two forms.
    const fcz = P.faceZ, fr = P.faceR;
    const inFace = (x, y, z, pad) => {
      const dz = z - fcz;
      return (x * x + y * y + dz * dz) < (fr + pad) * (fr + pad);
    };

    const bed = new Geo();
    bed.at(0, 0, 0, 0, 0, 0, 0.985, 0.985, 0.985);
    bed.add(surface(hoodSurf, this.su, this.sv, 2, 1));
    // ears: the setting bed, flattened ovals growing out of the hood
    const earSurf = [];
    for (const s of [-1, 1]) {
      const ex = s * P.earSpread, ey = R * P.earY, ez = -0.048;
      const tiltZ = s * -0.20;
      const cs = Math.cos(tiltZ), sn = Math.sin(tiltZ);
      const f = (u, v, out) => {
        const a = v * Math.PI;
        const rr = Math.sin(a) * P.earR;
        const yy = Math.cos(a) * P.earR * 1.06;
        const ph = u * TWO_PI;
        const lx = rr * Math.sin(ph), ly = yy, lz = rr * 0.70 * Math.cos(ph);
        out[0] = ex + lx * cs - ly * sn;
        out[1] = ey + lx * sn + ly * cs;
        out[2] = ez + lz;
      };
      f.cx = ex; f.cy = ey; f.cz = ez;
      earSurf.push(f);
      bed.at(0, 0, 0);
      bed.add(surface(f, this.sd + 8, this.sd + 4, 2, 1));
    }
    bed.toMesh('hoodBed', scene, mat.get('darkChrome'), head);

    const st = new Geo();
    st.at(0, 0, 0);
    this._stones(st, hoodSurf, {
      v0: 0.015, v1: 0.99,
      omit: (x, y, z) => inFace(x, y, z, 0.030),
    });
    for (const f of earSurf) {
      st.at(0, 0, 0);
      this._stones(st, f, {
        v0: 0.05, v1: 0.92, cx: f.cx, cy: f.cy, cz: f.cz,
        // no stones inside the ear cup
        omit: (x, y, z) => (z - f.cz) > 0.005
          && ((x - f.cx) * (x - f.cx) + (y - f.cy) * (y - f.cy)) < P.earR * P.earR * 0.42,
      });
    }
    st.toMesh('hoodStones', scene, mat.get('whiteGold'), head);

    // --- ear cups: an inset opening in darker polished metal ---
    const ic = new Geo();
    for (const s of [-1, 1]) {
      ic.at(s * P.earSpread, R * P.earY, -0.048 + P.earR * 0.44, 0, 0, s * -0.20,
        1, 1, 0.55);
      ic.add(ellipsoid({
        rx: P.earR * 0.60, ry: P.earR * 0.64, su: this.sd + 6, sv: this.sd,
      }));
    }
    ic.toMesh('earInner', scene, mat.get('earInner'), head);

    // --- gold: the hood aperture rim, and a raised gold ring inside each ear
    const p = new Geo();
    // The rim is the CIRCLE WHERE THE TWO SPHERES MEET — the hood shell and the
    // face — solved rather than guessed. Two spheres of radii Rh and Rf whose
    // centres are d apart intersect in a circle at
    //     z = (Rh^2 + d^2 - Rf^2) / 2d,   radius = sqrt(Rh^2 - z^2)
    // which puts the gold exactly on the hood opening. The previous piping was
    // a ring at a guessed radius and it floated off the fabric in places and
    // sank into it in others.
    const pad = 0.026;
    const Rh = R * 1.012;
    const Rf = fr + pad;
    const zc = (Rh * Rh + fcz * fcz - Rf * Rf) / (2 * fcz);
    const rc = Math.sqrt(Math.max(0.0001, Rh * Rh - zc * zc));
    const rimPts = [];
    const rn = this.lowQ ? 22 : 34;
    for (let i = 0; i <= rn; i++) {
      const a = (i / rn) * TWO_PI;
      // slight downward pull at the chin, like a real hood opening
      const droop = 0.030 * Math.max(0, -Math.cos(a));
      rimPts.push([rc * Math.sin(a), rc * Math.cos(a) - 0.018 - droop, zc - 0.020 + droop * 0.6]);
    }
    p.at(0, 0, 0);
    // thicker over the brow, thinner at the chin — a hood opening is a rolled
    // edge, not a wire hoop
    p.add(pipe(rimPts, (t) => {
      const a = t * TWO_PI;
      return 0.020 + 0.013 * Math.max(0, Math.cos(a));
    }, 6));
    for (const s of [-1, 1]) {
      p.at(s * P.earSpread, R * P.earY, -0.048 + P.earR * 0.50, Math.PI / 2, 0, s * -0.20);
      p.add(torus(P.earR * 0.66, 0.016, this.sd + 8, 6, null, 0.9));
    }
    p.toMesh('hoodPiping', scene, mat.get('polGold'), head);

    this._buildFace(head, mat, scene);
    this._buildAntenna(head, mat, scene);
  }

  /**
   * The face. Cheap, but no longer a chrome egg with two slits cut in it.
   *
   * It is seen on the results screen and in the front poses only, so it gets
   * primitives — but a chibi face needs sclera, iris, pupil and a hard
   * catchlight or it reads as dead, and it needs a nose and a mouth or it reads
   * as a mask. That is five extra merged parts, not a modelling project.
   */
  _buildFace(head, mat, scene) {
    const f = new Geo();
    f.at(0, 0, P.faceZ);
    f.add(ellipsoid({
      rx: P.faceR * 0.98, ry: P.faceR * 1.00, rz: P.faceR * 0.96, e1: 0.95,
      su: this.su, sv: this.sv,
      warp: (u) => {
        const d = Math.abs(u - 0.5);
        return 1 - 0.24 * Math.exp(-(d * d) / 0.055);
      },
    }));
    // nose: a small raised bump, which is what stops the profile reading as an
    // egg. Tiny. It only has to exist.
    f.at(0, -0.048, P.faceZ + P.faceR * 0.93, 0, 0, 0, 1, 0.9, 0.8);
    f.add(ellipsoid({ rx: 0.036, su: this.sd, sv: this.sd }));
    // upper lip / chin break: a shallow ridge under the mouth line
    f.at(0, -0.145, P.faceZ + P.faceR * 0.84, Math.PI / 2, 0, 0, 1, 1, 0.35);
    f.add(torus(0.062, 0.016, this.sd + 6, 6, (u) => 0.4 + 0.9 * Math.sin(Math.PI * u), 0.7));
    f.toMesh('face', scene, mat.get('polRose'), head);

    // --- eyes: sclera, iris, pupil, two catchlights ---
    const sclera = new Geo();
    const iris = new Geo();
    const dark = new Geo();
    const shine = new Geo();
    for (const s of [-1, 1]) {
      sclera.at(s * P.eyeX, P.eyeY, P.faceZ + P.faceR * 0.76, 0, 0, s * 0.10, 0.94, 1.20, 0.60);
      sclera.add(ellipsoid({ rx: P.eyeR, su: this.sd + 4, sv: this.sd }));
      iris.at(s * P.eyeX, P.eyeY - 0.014, P.faceZ + P.faceR * 0.83, 0, 0, 0, 1, 1.02, 0.42);
      iris.add(ellipsoid({ rx: P.eyeR * 0.68, su: this.sd + 2, sv: this.sd }));
      dark.at(s * P.eyeX, P.eyeY - 0.018, P.faceZ + P.faceR * 0.87, 0, 0, 0, 1, 1, 0.34);
      dark.add(ellipsoid({ rx: P.eyeR * 0.33, su: this.sd, sv: this.sd }));
      // brow: a thin dark arc above the eye. Chibi faces live or die on brows.
      dark.at(s * P.eyeX, P.eyeY + P.eyeR * 1.28, P.faceZ + P.faceR * 0.80,
        Math.PI / 2, 0, s * 0.22, 1, 1, 0.35);
      dark.add(arc(P.eyeR * 0.86, 0.011, -0.9, 0.9, this.sd + 4, 5));
      // catchlights: one big upper-left, one small lower-right. Two, at
      // different sizes, is the difference between "glossy" and "alive".
      shine.at(s * P.eyeX - 0.026, P.eyeY + 0.034, P.faceZ + P.faceR * 0.90, 0, 0, 0, 1, 1, 0.5);
      shine.add(ellipsoid({ rx: P.eyeR * 0.30, su: this.sd, sv: this.sd }));
      shine.at(s * P.eyeX + 0.028, P.eyeY - 0.036, P.faceZ + P.faceR * 0.88, 0, 0, 0, 1, 1, 0.5);
      shine.add(ellipsoid({ rx: P.eyeR * 0.14, su: this.sd, sv: this.sd }));
    }
    // mouth: a cut line with a lower lip, not a black bean
    dark.at(0, -0.128, P.faceZ + P.faceR * 0.86, Math.PI / 2, 0, 0, 1, 1, 0.30);
    dark.add(arc(0.070, 0.012, -0.72, 0.72, this.sd + 6, 5));
    sclera.toMesh('sclera', scene, mat.get('marbleLight'), head);
    iris.toMesh('iris', scene, mat.get('eyeIris'), head);
    dark.toMesh('eyes', scene, mat.get('eyeDark'), head);
    shine.toMesh('catchlight', scene, mat.get('catchlight'), head);

    // --- gold fringe: swept blades spilling from under the hood edge ---
    // The reference's single most characterful detail after the ears. Blades,
    // not a cap: each one is a flattened tapered tube swept across the brow, so
    // the fringe has points and gaps instead of being a helmet.
    const h = new Geo();
    const blades = this.lowQ ? 5 : 8;
    for (let i = 0; i < blades; i++) {
      const t = blades === 1 ? 0.5 : i / (blades - 1);
      const a = (t - 0.5) * 2.05;                 // across the forehead
      const sweep = 0.55 + 0.45 * Math.sin(Math.PI * t);
      const len = 0.135 * (0.72 + 0.5 * Math.sin(Math.PI * (0.15 + t * 0.8)));
      const rings = [];
      const n = 4;
      for (let k = 0; k <= n; k++) {
        const fq = k / n;
        rings.push([
          Math.sin(a) * P.faceR * 0.93 + fq * len * 0.85 * sweep,
          P.faceR * 0.58 - fq * len * 1.25,
          P.faceZ + Math.cos(a) * P.faceR * 0.88 + fq * len * 0.10,
          0.030 * (1 - 0.85 * fq),
          0.018 * (1 - 0.85 * fq),
        ]);
      }
      h.at(0, 0, 0);
      h.add(tube(rings, this.sd, true, true, 1, 2));
    }
    h.toMesh('fringe', scene, mat.get('polGold'), head);
  }

  _buildAntenna(head, mat, scene) {
    // Curved, not a straight pin: a short chain of segments so it can bend and
    // whip as the character runs. The wire tapers, which is the difference
    // between a jewellery stem and a cocktail stick.
    const stalkRoot = new TransformNode('stalkRoot', scene);
    stalkRoot.parent = head;
    stalkRoot.position.set(0.045, P.headR * 0.86, -0.10);
    this.parts.stalk = stalkRoot;

    // gold cap where the stem enters the hood — the stem used to sprout
    // straight out of the pavé like a pin stuck in a ball
    const cap = new Geo();
    cap.at(0.045, P.headR * 0.86, -0.10, 0.30, 0, -0.16, 1, 0.7, 1);
    cap.add(ellipsoid({ rx: 0.052, ry: 0.040, rz: 0.052, e1: 0.7, su: this.sd + 4, sv: this.sd }));
    cap.toMesh('stalkCap', scene, mat.get('polGold'), head);

    this.parts.stalkSegs = [];
    let prev = stalkRoot;
    const segs = 4;
    const segLen = P.antennaLen / segs;
    for (let i = 0; i < segs; i++) {
      const node = new TransformNode(`stalkSeg${i}`, scene);
      node.parent = prev;
      node.position.y = i === 0 ? 0 : segLen;
      // A real BEND, increasing along the stem, so it arcs over the head like
      // the reference instead of standing up like an aerial.
      node.rotation.z = -0.10 - i * 0.09;
      const g = new Geo();
      const r0 = 0.019 * (1 - i * 0.09), r1 = 0.019 * (1 - (i + 1) * 0.09);
      g.at(0, 0, 0);
      g.add(tube([[0, 0, 0, r0, r0], [0, segLen, 0, r1, r1]], 6, false, false, 1, 2));
      g.toMesh(`stalkBit${i}`, scene, mat.get('polGold'), node);
      this.parts.stalkSegs.push(node);
      prev = node;
    }

    // --- the ruby: pavé-set, on its own coarser stone map ---
    const orbSurf = (u, v, out) => {
      const a = v * Math.PI;
      const r = Math.sin(a) * P.orbR;
      const ph = u * TWO_PI;
      out[0] = r * Math.sin(ph);
      out[1] = segLen + Math.cos(a) * P.orbR;
      out[2] = r * Math.cos(ph);
    };
    const ob = new Geo();
    ob.at(0, 0, 0);
    ob.add(surface(orbSurf, this.su, this.sv, 2, 1));
    ob.toMesh('orb', scene, mat.get('glassGem'), prev);

    const os = new Geo();
    os.at(0, 0, 0);
    this._stones(os, orbSurf, {
      pitch: P.orbR * 0.30, v0: 0.03, v1: 0.97,
      cy: segLen, jitter: 0.10, tilt: 0.14,
    });
    os.toMesh('orbStones', scene, mat.get('ruby'), prev);

    // gold bezel collar where the stem enters the ruby
    const bz = new Geo();
    bz.at(0, segLen - P.orbR * 0.82, 0, Math.PI / 2, 0, 0, 1, 1, 0.8);
    bz.add(torus(P.orbR * 0.50, 0.022, this.sd + 8, 6, null, 0.9));
    bz.toMesh('orbBezel', scene, mat.get('polGold'), prev);
  }

  // ---- arms and gloves -------------------------------------------------

  /**
   * Two segments and an elbow.
   *
   * From behind and in front the old single-stub arms read, in a critic's
   * words, as "chrome grape-clusters with rake-tine fingers hanging at the
   * hem" — because there was no upper arm, no elbow and no forearm, just a
   * short cone with a hand on it. An arm needs three masses to read as an arm.
   */
  _buildArms(body) {
    const mat = this.ctx.get('mat');
    const scene = this.ctx.scene;
    this.parts.arms = [];
    this.parts.elbows = [];
    for (const s of [-1, 1]) {
      const pivot = new TransformNode(`armPivot${s}`, scene);
      pivot.parent = body;
      pivot.position.set(s * P.shoulderX, P.shoulderY, 0);

      const upperSurf = (u, v, out) => {
        const y = -P.upperLen * v;
        const r = P.armR * (1.06 - 0.20 * v);
        const ph = u * TWO_PI;
        out[0] = r * Math.sin(ph);
        out[1] = y;
        out[2] = r * 0.94 * Math.cos(ph) + Math.sin(v * Math.PI) * 0.012;
      };
      const ub = new Geo();
      ub.at(0, 0, 0, 0, 0, 0, 0.97, 1, 0.97);
      ub.add(surface(upperSurf, this.sd + 8, this.sd + 2, 2, 1));
      ub.toMesh(`upperBed${s}`, scene, mat.get('darkChrome'), pivot);
      const us = new Geo();
      us.at(0, 0, 0);
      this._stones(us, upperSurf, { v0: 0.10, v1: 0.94, cy: -P.upperLen * 0.5 });
      us.toMesh(`upperStones${s}`, scene, mat.get('whiteGold'), pivot);

      // elbow joint
      const elbow = new TransformNode(`elbow${s}`, scene);
      elbow.parent = pivot;
      elbow.position.set(0, -P.upperLen, 0);

      const foreSurf = (u, v, out) => {
        const y = -P.foreLen * v;
        const r = P.armR * (0.94 - 0.24 * v);
        const ph = u * TWO_PI;
        out[0] = r * Math.sin(ph);
        out[1] = y;
        out[2] = r * 0.94 * Math.cos(ph);
      };
      const fb = new Geo();
      fb.at(0, 0, 0, 0, 0, 0, 0.97, 1, 0.97);
      fb.add(surface(foreSurf, this.sd + 8, this.sd + 2, 2, 1));
      fb.toMesh(`foreBed${s}`, scene, mat.get('darkChrome'), elbow);
      const fs = new Geo();
      fs.at(0, 0, 0);
      this._stones(fs, foreSurf, { v0: 0.06, v1: 0.92, cy: -P.foreLen * 0.5 });
      fs.toMesh(`foreStones${s}`, scene, mat.get('whiteGold'), elbow);

      // elbow cap + wrist cuff, in silver so the joint reads
      const c = new Geo();
      c.at(0, 0.004, 0.004, Math.PI / 2);
      c.add(torus(P.armR * 0.80, 0.026, this.sd + 6, 6, null, 0.85));
      c.at(0, -P.foreLen + 0.006, 0.006, Math.PI / 2);
      c.add(torus(P.armR * 0.66, 0.026, this.sd + 6, 6, null, 0.85));
      c.toMesh(`cuff${s}`, scene, mat.get('polRhodium'), elbow);

      // --- glove ---
      const wrist = new TransformNode(`wrist${s}`, scene);
      wrist.parent = elbow;
      wrist.position.set(0, -P.foreLen - 0.010, 0.010);
      this._buildGlove(wrist, s, mat, scene);

      this.parts.arms.push(pivot);
      this.parts.elbows.push(elbow);
    }
  }

  /**
   * A silver glove with fingers.
   *
   * The owner asked for this specifically: "the hands have fingers wearing
   * silver gloves". Anatomy is not the point — silhouette is. Four fingers plus
   * a separated thumb, each a tapered tube with a curl, splayed so gaps of
   * background show between them. One merged mesh: one draw call per hand.
   */
  _buildGlove(wrist, s, mat, scene) {
    const g = new Geo();
    const R = P.handR;

    // palm — a rounded slab, wider than deep
    g.at(0, -R * 0.66, 0.004, 0, 0, 0, 1.0, 1.08, 0.70);
    g.add(ellipsoid({ rx: R, e1: 0.72, e2: 0.66, su: this.sd + 6, sv: this.sd + 2 }));

    const fl = R * 0.95;
    for (let i = 0; i < 4; i++) {
      const t = i / 3;
      const fx = (t - 0.5) * R * 1.20;
      const len = fl * (0.80 + 0.30 * Math.sin(Math.PI * (0.25 + t * 0.6)));
      const splay = (t - 0.5) * 0.42;
      const curl = 0.46;
      const rings = [];
      const n = 5;
      for (let k = 0; k <= n; k++) {
        const f = k / n;
        const ang = curl * f * f;
        rings.push([
          0,
          -len * f,
          Math.sin(ang) * len * 0.55,
          R * 0.225 * (1 - 0.26 * f),
          R * 0.225 * (1 - 0.26 * f),
        ]);
      }
      g.at(fx * s, -R * 1.36, 0.012, 0, 0, splay * s);
      g.add(tube(rings, this.sd, true, true, 1, 3));
      if (!this.lowQ) {
        g.at(fx * s, -R * 1.34, 0.014, Math.PI / 2, 0, splay * s);
        g.add(torus(R * 0.21, 0.013, this.sd, 5, null, 0.8));
      }
    }

    // thumb — shorter, thicker, swung out and forward
    const trings = [];
    const tn = 4, tl = R * 0.76;
    for (let k = 0; k <= tn; k++) {
      const f = k / tn;
      trings.push([0, -tl * f, Math.sin(0.5 * f * f) * tl * 0.5,
        R * 0.27 * (1 - 0.24 * f), R * 0.27 * (1 - 0.24 * f)]);
    }
    g.at(s * R * 0.76, -R * 0.88, 0.030, -0.30, 0, s * 1.05);
    g.add(tube(trings, this.sd, true, true, 1, 3));

    g.toMesh(`glove${s}`, scene, mat.get('polRhodium'), wrist);
  }

  // ---- legs and boots --------------------------------------------------

  _buildLegs(body) {
    const mat = this.ctx.get('mat');
    const scene = this.ctx.scene;
    this.parts.legs = [];
    for (const s of [-1, 1]) {
      const pivot = new TransformNode(`legPivot${s}`, scene);
      pivot.parent = body;
      pivot.position.set(s * P.hipX, P.hipY, 0);

      const legSurf = (u, v, out) => {
        const r = P.legR * (1.14 - 0.30 * v);
        const ph = u * TWO_PI;
        out[0] = r * Math.sin(ph);
        out[1] = -P.legLen * v;
        out[2] = r * Math.cos(ph);
      };
      const lb = new Geo();
      lb.at(0, 0, 0, 0, 0, 0, 0.97, 1, 0.97);
      lb.add(surface(legSurf, this.sd + 8, this.sd + 2, 2, 1));
      lb.toMesh(`legBed${s}`, scene, mat.get('darkChrome'), pivot);
      const ls = new Geo();
      ls.at(0, 0, 0);
      this._stones(ls, legSurf, { v0: 0.05, v1: 0.90, cy: -P.legLen * 0.5 });
      ls.toMesh(`legStones${s}`, scene, mat.get('whiteGold'), pivot);

      // --- boot ---
      // A shaped last with a toe box, an instep and a heel. From behind you see
      // heels, so the heel gets a form.
      const b = new Geo();
      b.at(0, -P.legLen - P.bootR * 0.40, 0.048, 0, 0, 0, 0.96, 0.74, 1.30);
      b.add(ellipsoid({ rx: P.bootR, e1: 0.72, e2: 0.70, su: this.sd + 8, sv: this.sd + 3 }));
      b.at(0, -P.legLen - P.bootR * 0.46, 0.048 + P.bootR * 0.92, 0, 0, 0, 0.80, 0.62, 0.72);
      b.add(ellipsoid({ rx: P.bootR, e1: 0.8, su: this.sd + 4, sv: this.sd }));
      b.at(0, -P.legLen - P.bootR * 0.82, 0.048 - P.bootR * 0.78, 0, 0, 0, 0.74, 0.46, 0.56);
      b.add(ellipsoid({ rx: P.bootR, e1: 0.6, e2: 0.6, su: this.sd + 4, sv: this.sd }));
      // ankle cuff, where the pavé leg meets the silver boot
      b.at(0, -P.legLen + 0.006, 0, Math.PI / 2);
      b.add(torus(P.legR * 0.86, 0.028, this.sd + 6, 6, null, 0.85));
      // sole welt
      b.at(0, -P.legLen - P.bootR * 0.82, 0.055, Math.PI / 2, 0, 0, 1.0, 1.0, 1.42);
      b.add(torus(P.bootR * 0.80, 0.023, this.sd + 8, 6, null, 0.7));
      b.toMesh(`boot${s}`, scene, mat.get('polRhodium'), pivot);

      this.parts.legs.push(pivot);
    }
  }

  // ---- the cape --------------------------------------------------------

  _buildCape(body, low, high) {
    const mat = this.ctx.get('mat');
    const scallops = low ? 3 : 4;
    const colsPerRib = low ? 2 : 4;
    const cols = scallops * colsPerRib + 1;
    const rows = low ? 10 : (high ? 18 : 15);

    const capeRoot = new TransformNode('capeRoot', this.ctx.scene);
    capeRoot.parent = body;
    capeRoot.position.set(0, P.shoulderY + 0.070, -0.050);
    this.parts.capeRoot = capeRoot;

    this.cape = new Cape(cols, rows, {
      iters: low ? 2 : 4,
      len: 1.14,
      halfW0: 0.17,
      halfW1: 0.95,
      scallops,
      colsPerRib,
      hemCut: 0.30,
      shoulderR: 0.205,
      shoulderSpread: 2.30,
    });
    // POLISHED SILVER, not black.
    //
    // The membrane shipped in `clothCape` — a 0.34-albedo metal — against a
    // dark world, and rendered as a solid black sheet with blown white streaks.
    // A critic called it a garbage bag and they were right. The reference wing
    // is silver: a bright top surface, ribs, and a dark cavity underneath. That
    // contrast comes free from a polished double-sided sheet, because the two
    // faces reflect opposite halves of the room.
    this.cape.init(
      this.ctx.scene,
      mat.get('clothCape'),      // top surface: satin silver, mid value
      mat.get('polRhodium'),     // ribs
      capeRoot, 3, 3,
      mat.get('darkChrome'),     // underside: the dark cavity
    );

    // Clasp: a gold collar plate over the cape's pinned edge, so the cape looks
    // fastened rather than growing out of the character's back.
    const c = new Geo();
    c.at(0, 0.01, -0.02, Math.PI / 2, 0, 0, 1, 1, 0.7);
    c.add(arc(0.235, 0.026, -1.28, 1.28, this.su, 6, (u) => 0.7 + 0.6 * Math.sin(Math.PI * u)));
    c.at(0, 0.012, 0.10, 0.4);
    c.add(gem(0.05, 6, 0.85));
    c.toMesh('capeClasp', this.ctx.scene, mat.get('polGold'), capeRoot);
  }

  // ---- simulation ------------------------------------------------------

  /**
   * The cape simulates here rather than in renderUpdate for two reasons: it is
   * deterministic at a fixed 60Hz, and the capture harness fast-forwards
   * through fixedUpdate ONLY. A cape driven from renderUpdate would be frozen
   * at its rest pose in every screenshot.
   */
  fixedUpdate(dt) {
    const play = this.ctx.get('play');
    const T = this.ctx.config.tune;
    const track = this.ctx.tryGet('track');

    // restart detection: distance only ever increases within a run
    if (play.z < this._lastZ - 1) {
      this.cape.reset();
      this._lastX = play.x; this._lastVX = 0; this._lastVY = 0;
      this._lastYaw = track ? track.path.yawAt(play.z) : 0;
    }
    this._lastZ = play.z;

    const strideHz = 1.15 + (play.speed / T.maxSpeed) * 1.45;
    if (play.state === STATE.RUN) this.phase += dt * strideHz * TWO_PI;

    // --- character acceleration in LOCAL axes ---
    const vx = (play.x - this._lastX) / dt;
    this._lastX = play.x;
    let ax = (vx - this._lastVX) / dt;
    this._lastVX = vx;
    let ay = (play.vy - this._lastVY) / dt;
    this._lastVY = play.vy;

    // corner swing: turning at speed throws the cape to the outside
    if (track) {
      const yaw = track.path.yawAt(play.z);
      let dy = yaw - this._lastYaw;
      while (dy > Math.PI) dy -= TWO_PI;
      while (dy < -Math.PI) dy += TWO_PI;
      this._lastYaw = yaw;
      ax += (dy / dt) * play.speed * 0.55;
    }

    if (ax > 45) ax = 45; else if (ax < -45) ax = -45;
    if (ay > 45) ay = 45; else if (ay < -45) ay = -45;
    this._aX += (ax - this._aX) * 0.35;
    this._aY += (ay - this._aY) * 0.35;

    this._bob = play.state === STATE.RUN ? Math.abs(Math.sin(this.phase)) * 0.055 : 0;
    this._bobV = (this._bob - this._lastBob) / dt;
    this._lastBob = this._bob;

    const speed = play.state === STATE.DEAD ? 0 : play.speed;
    this.cape.step(dt, speed, this._aX, this._aY, 0, this._bobV);

    if (!this._warm) {
      this._warm = true;
      for (let i = 0; i < 60; i++) this.cape.step(dt, speed, 0, 0, 0, 0);
    }
  }

  // ---- animation -------------------------------------------------------

  renderUpdate(dtReal) {
    const play = this.ctx.get('play');
    const body = this.parts.body;
    const track = this.ctx.tryGet('track');

    if (track) {
      track.path.toWorld(play.z, play.x, play.y, this._w);
      this.root.position.set(this._w[0], this._w[1], this._w[2]);
      this.root.rotation.y = track.path.yawAt(play.z);
    } else {
      this.root.position.set(play.x, play.y, play.z);
    }

    const sw = Math.sin(this.phase);
    const swAlt = Math.sin(this.phase + Math.PI);

    let wantStretch = 1;
    let bendA = 0, bendB = 0;

    switch (play.state) {
      case STATE.RUN: {
        this.parts.legs[0].rotation.x = sw * 0.92;
        this.parts.legs[1].rotation.x = swAlt * 0.92;
        this.parts.arms[0].rotation.x = swAlt * 0.62;
        this.parts.arms[1].rotation.x = sw * 0.62;
        // splayed further than a real runner. From the side and from behind
        // the arms sat inside the torso silhouette and simply did not exist.
        this.parts.arms[0].rotation.z = -0.30 + swAlt * 0.10;
        this.parts.arms[1].rotation.z = 0.30 - swAlt * 0.10;
        // The elbow is the whole point of the two-segment arm: a runner's arm
        // is held bent, and a straight one reads as a stick.
        bendA = -0.95 - swAlt * 0.35;
        bendB = -0.95 - sw * 0.35;
        body.position.y = this._bob;
        body.rotation.x = 0.11;
        wantStretch = 1 + Math.abs(sw) * 0.03;
        break;
      }
      case STATE.AIR: {
        const rise = play.vy > 0;
        this.parts.legs[0].rotation.x = rise ? -0.62 : 0.40;
        this.parts.legs[1].rotation.x = rise ? -0.28 : 0.66;
        this.parts.arms[0].rotation.x = rise ? -1.35 : -0.50;
        this.parts.arms[1].rotation.x = rise ? -1.35 : -0.50;
        this.parts.arms[0].rotation.z = -0.46;
        this.parts.arms[1].rotation.z = 0.46;
        bendA = bendB = rise ? -0.55 : -1.10;
        body.position.y = 0;
        body.rotation.x = rise ? -0.16 : 0.22;
        wantStretch = rise ? 1.10 : 0.94;
        break;
      }
      case STATE.SLIDE: {
        this.parts.legs[0].rotation.x = 1.32;
        this.parts.legs[1].rotation.x = 1.10;
        this.parts.arms[0].rotation.x = -1.0;
        this.parts.arms[1].rotation.x = -0.8;
        this.parts.arms[0].rotation.z = -0.5;
        this.parts.arms[1].rotation.z = 0.5;
        bendA = bendB = -1.30;
        body.position.y = -0.32;
        body.rotation.x = 1.02;
        wantStretch = 0.86;
        break;
      }
      default: {
        bendA = bendB = -0.6;
        body.rotation.x = 0.1;
        break;
      }
    }
    this.parts.elbows[0].rotation.x = bendA;
    this.parts.elbows[1].rotation.x = bendB;

    // Squash and stretch, eased so landings pop rather than snap.
    this._stretch += (wantStretch - this._stretch) * Math.min(1, dtReal * 14);
    body.scaling.set(1 / Math.sqrt(this._stretch), this._stretch, 1 / Math.sqrt(this._stretch));

    // Lean into lane changes.
    const wantLean = play.laneT < 1 ? (play.laneTarget - play.lane) * -0.34 : 0;
    this._lean += (wantLean - this._lean) * Math.min(1, dtReal * 12);
    body.rotation.z = this._lean;

    this.parts.head.rotation.z = -this._lean * 0.45;
    this.parts.head.rotation.x = -body.rotation.x * 0.55 + Math.sin(this.phase * 2) * 0.02;

    // Antenna whip: each segment lags the one before it.
    this._flutter += dtReal * (2.2 + play.speed * 0.10);
    const whip = Math.sin(this.phase * 0.8) * 0.06 - this._lean * 0.35;
    for (let i = 0; i < this.parts.stalkSegs.length; i++) {
      const seg = this.parts.stalkSegs[i];
      seg.rotation.z = -0.10 - i * 0.09 + whip * (i + 1) * 0.6;
      seg.rotation.x = Math.sin(this._flutter * 0.7 + i) * 0.03 * (i + 1);
    }

    this.cape.upload();
  }

  dispose() {
    if (this.cape) this.cape.dispose();
    if (this.root) this.root.dispose(false, true);
  }
}
