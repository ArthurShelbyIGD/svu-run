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
  shoulderX: 0.320, shoulderY: 0.880,
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

    // PRESENTATION SCALE. Everything in P is authored in metres against the
    // collision capsule (1.5 m tall, 0.42 m radius), and at that size the
    // character occupies about a fifth of a 2.4 m lane and read, in the hero
    // capture, as a pale blob a long way down a busy hall: the pavé dissolved,
    // the ears merged into the hood and the cape was three grey pixels.
    //
    // This scales the visual body only, about its own feet. It is deliberately
    // NOT a change to P: the collision capsule lives in play/ and belongs to
    // gameplay, and jump and slide clearances are tuned against it. The visual
    // was already 1.11x the capsule before this; 1.24x is the same kind of
    // licence, sized so the hood is a little under half a lane wide, which is
    // where the stones start to read again at chase distance.
    this.scale = 1.24;

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

    // Gold grains: one per Nth stone. An octahedron is 6 verts and 8 tris and
    // merges into a gold mesh the part already owns, so this is vertices only —
    // no extra draw call, no extra material, no texture. `low` gets a third of
    // them, which still reads as warmth in the gaps at phone size.
    this.beadEvery = low ? 3 : 1;

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
  /**
   * @param gold  optional Geo that ALREADY has a gold material and a mesh of
   *              its own. Passing it turns on the beading, and the grains merge
   *              into that mesh, so warm metal between the stones costs draw
   *              calls zero. The reference's pavé is silver stones in a GOLD
   *              bed — that warm/cool pairing is most of what separates
   *              "jewellery" from "grey object" at chase distance, and it was
   *              the single largest colour note missing from the back view.
   */
  _stones(geo, surf, opts, gold) {
    opts.pitch = opts.pitch === undefined ? this.pitch : opts.pitch;
    opts.facets = this.facets;
    opts.rng = this.rand;
    if (gold) opts.beadEvery = opts.beadEvery || this.beadEvery;
    const f = stoneField(surf, opts);
    geo.add(f);
    // Same transform as the stones, copied rather than re-stated: the grains
    // are generated in the stone field's own space and have to land in it.
    if (gold && f.bead) { gold.m.copyFrom(geo.m); gold.add(f.bead); }
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

    // The gold accumulator for the whole torso — grains plus the zip. Declared
    // here because the grains are emitted alongside the stones, below.
    const z = new Geo();

    // Front placket: the zip runs down the chest, so no stones there.
    const g = new Geo();
    g.at(0, P.bodyY, 0);
    this._stones(g, bodySurf, {
      v0: 0.02, v1: 0.985,
      omit: (x, y, zz) => Math.abs(x) < 0.050 && zz > P.bodyD * 0.55,
    }, z);
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
        // ...AND IT MUST NOT FLARE. The cowl bulged to 1.42x the hood radius
        // on its way down, which put its widest point at 0.34 — the same
        // radius as the pavé collar underneath it, 6 cm lower. Two stone-set
        // surfaces of equal radius stacked that close do not read as a head
        // over a collar; they read as one cone, which is what every rear
        // capture showed and what no amount of work on the collar itself could
        // fix. In the reference the hood is a BALL: its lower edge tucks back
        // in, and the collar flares out from under it. So the flare drops to
        // 1.16x and the drop from 8.5 cm to 5 cm, which uncovers about 19 cm of
        // collar — 11% of figure height, which is what the reference gives it.
        const s = (v - 0.70) / 0.30;
        const a = 0.80 * Math.PI;
        r = Math.sin(a) * R * (1 + 0.16 * Math.sin(Math.PI * Math.min(1, s * 1.30)));
        y = Math.cos(a) * R - s * 0.050;
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

    // The head's gold accumulator: aperture rim, ear rings, and the grains
    // between every stone on the hood and the ears. Declared before the stones
    // because the grains come out of the same loop.
    const p = new Geo();

    const st = new Geo();
    st.at(0, 0, 0);
    this._stones(st, hoodSurf, {
      v0: 0.015, v1: 0.99,
      omit: (x, y, z) => inFace(x, y, z, 0.030),
    }, p);
    for (const f of earSurf) {
      st.at(0, 0, 0);
      this._stones(st, f, {
        v0: 0.05, v1: 0.92, cx: f.cx, cy: f.cy, cz: f.cz,
        // no stones inside the ear cup
        omit: (x, y, z) => (z - f.cz) > 0.005
          && ((x - f.cx) * (x - f.cx) + (y - f.cy) * (y - f.cy)) < P.earR * P.earR * 0.42,
      }, p);
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
    // The rim is the CIRCLE WHERE THE TWO SPHERES MEET — the hood shell and the
    // face — solved rather than guessed. Two spheres of radii Rh and Rf whose
    // centres are d apart intersect in a circle at
    //     z = (Rh^2 + d^2 - Rf^2) / 2d,   radius = sqrt(Rh^2 - z^2)
    // which puts the gold exactly on the hood opening. The previous piping was
    // a ring at a guessed radius and it floated off the fabric in places and
    // sank into it in others.
    const pad = 0.012;
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

    // THE HOOD'S OWN LOWER EDGE, IN GOLD. The reference outlines the hood all
    // the way round, not just at the face opening, and from behind that wire is
    // the only thing between the hood and the collar. Without it two pavé
    // surfaces of nearly the same radius meet 6 cm apart and the head, the
    // collar and the top of the cape render as one continuous silver mass with
    // no edges in it — which is what "pale blob" means. Swept along the hood
    // surface itself at v = 0.985, so it sits ON the fabric everywhere rather
    // than on a guessed circle. It also closes the rear silhouette: the eye
    // gets a hard line where the head stops.
    const edge = [];
    const en = this.lowQ ? 20 : 34;
    const ep = [0, 0, 0];
    for (let i = 0; i <= en; i++) {
      hoodSurf(i / en, 0.930, ep);
      // outboard of the setting bed, and clear of the stone girdles
      edge.push([ep[0] * 1.055, ep[1] - 0.004, ep[2] * 1.055]);
    }
    p.at(0, 0, 0);
    p.add(pipe(edge, () => 0.0125, 6));

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
    //
    // Every feature is placed by SPHERICAL ANGLE on the face, not by a guessed
    // (x, y, z). The previous version put the eyes at z = faceZ + faceR * 0.76,
    // which is 3.7cm INSIDE a sphere of that radius at that x offset — so the
    // whole eye assembly was buried in the head and the face rendered as a
    // blank chrome egg. A critic reported exactly that. Angles cannot make this
    // mistake: k = 1 is on the surface by construction.
    const onFace = (az, el, k, out) => {
      const ce = Math.cos(el);
      out[0] = P.faceR * k * Math.sin(az) * ce;
      out[1] = P.faceR * k * Math.sin(el);
      out[2] = P.faceZ + P.faceR * 0.96 * k * Math.cos(az) * ce;
      return out;
    };
    const q = [0, 0, 0];
    const AZ = 0.415, EL = 0.02;

    const sclera = new Geo();
    const iris = new Geo();
    const dark = new Geo();
    const shine = new Geo();
    for (const s of [-1, 1]) {
      onFace(s * AZ, EL, 0.90, q);
      sclera.at(q[0], q[1], q[2], 0, s * -AZ, s * 0.12, 0.94, 1.22, 0.66);
      sclera.add(ellipsoid({ rx: P.eyeR, su: this.sd + 4, sv: this.sd }));

      // The iris FILLS the eye. A chibi eye is mostly iris with a sliver of
      // sclera at the corners; at 0.70 of the eye radius it read as a white
      // almond with a faint blue smudge in it.
      onFace(s * AZ, EL - 0.035, 0.990, q);
      iris.at(q[0], q[1], q[2], 0, s * -AZ, s * 0.12, 0.92, 1.04, 0.42);
      iris.add(ellipsoid({ rx: P.eyeR * 0.92, su: this.sd + 2, sv: this.sd }));

      onFace(s * AZ, EL - 0.045, 1.028, q);
      dark.at(q[0], q[1], q[2], 0, s * -AZ, 0, 1, 1.05, 0.36);
      dark.add(ellipsoid({ rx: P.eyeR * 0.52, su: this.sd, sv: this.sd }));

      // brow: a thin dark arc above the eye. Chibi faces live or die on brows.
      onFace(s * AZ, EL + 0.30, 1.015, q);
      dark.at(q[0], q[1], q[2], Math.PI / 2, s * -AZ, s * 0.26, 1, 1, 0.30);
      dark.add(arc(P.eyeR * 0.92, 0.012, -0.95, 0.95, this.sd + 4, 5));

      // catchlights: one big upper-outer, one small lower-inner. Two, at
      // different sizes, is the difference between "glossy" and "alive".
      onFace(s * (AZ + 0.075), EL + 0.115, 1.055, q);
      shine.at(q[0], q[1], q[2], 0, s * -AZ, 0, 1, 1, 0.5);
      shine.add(ellipsoid({ rx: P.eyeR * 0.31, su: this.sd, sv: this.sd }));
      if (!this.lowQ) {
        onFace(s * (AZ - 0.085), EL - 0.125, 1.055, q);
        shine.at(q[0], q[1], q[2], 0, s * -AZ, 0, 1, 1, 0.5);
        shine.add(ellipsoid({ rx: P.eyeR * 0.145, su: this.sd, sv: this.sd }));
      }
    }
    // mouth: a cut line with a lifted corner, not a black bean
    onFace(0, -0.44, 1.020, q);
    dark.at(q[0], q[1], q[2], Math.PI / 2 - 0.44, 0, 0, 1, 1, 0.28);
    dark.add(arc(0.072, 0.013, -0.78, 0.78, this.sd + 6, 5));
    sclera.toMesh('sclera', scene, mat.get('marbleLight'), head);
    iris.toMesh('iris', scene, mat.get('eyeIris'), head);
    dark.toMesh('eyes', scene, mat.get('eyeDark'), head);
    shine.toMesh('catchlight', scene, mat.get('catchlight'), head);

    // --- gold fringe: swept blades spilling from under the hood edge ---
    // The reference's single most characterful detail after the ears. Blades,
    // not a cap: each one is a flattened tapered tube swept across the brow, so
    // the fringe has points and gaps instead of being a helmet. Placed on the
    // face surface by the same angular helper as the eyes.
    const h = new Geo();
    const blades = this.lowQ ? 5 : 8;
    const a0 = [0, 0, 0], a1 = [0, 0, 0];
    for (let i = 0; i < blades; i++) {
      const t = blades === 1 ? 0.5 : i / (blades - 1);
      const az = (t - 0.48) * 1.55;
      // start high on the brow, sweep down and across
      const drop = 0.46 + 0.30 * Math.sin(Math.PI * t);
      onFace(az, 0.66, 1.045, a0);
      onFace(az + 0.30 * (t - 0.45), 0.66 - drop, 1.045, a1);
      const rings = [];
      const n = 4;
      for (let k = 0; k <= n; k++) {
        const fq = k / n;
        const e = 0.66 - drop * fq;
        onFace(az + 0.30 * (t - 0.45) * fq, e, 1.045 - 0.03 * fq * fq, q);
        rings.push([q[0], q[1], q[2], 0.028 * (1 - 0.88 * fq), 0.016 * (1 - 0.88 * fq)]);
      }
      h.at(0, 0, 0);
      h.add(tube(rings, this.sd, true, true, 1, 2));
    }
    void a0; void a1;
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
    this._stalkRest = [];
    let prev = stalkRoot;
    // Two segments on `low`: each one is its own transform node and its own
    // draw call, for a whip on a 4cm-wide wire that is a handful of pixels on a
    // phone. ARCHITECTURE §4.6.
    const segs = this.lowQ ? 2 : 4;
    const segLen = P.antennaLen / segs;
    for (let i = 0; i < segs; i++) {
      const node = new TransformNode(`stalkSeg${i}`, scene);
      node.parent = prev;
      node.position.y = i === 0 ? 0 : segLen;
      // A real BEND, increasing along the stem, so it arcs over the head like
      // the reference instead of standing up like an aerial.
      node.rotation.z = -0.10 - i * (this.lowQ ? 0.18 : 0.09);
      const g = new Geo();
      const r0 = 0.019 * (1 - i * 0.09), r1 = 0.019 * (1 - (i + 1) * 0.09);
      g.at(0, 0, 0);
      g.add(tube([[0, 0, 0, r0, r0], [0, segLen, 0, r1, r1]], 6, false, false, 1, 2));
      g.toMesh(`stalkBit${i}`, scene, mat.get('polGold'), node);
      this.parts.stalkSegs.push(node);
      this._stalkRest.push(node.rotation.z);
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
      // THE WRIST CUFF IS GOLD. docs/reference-rear.png puts a gold band where
      // each pavé sleeve meets the silver hand, and from behind it is one of
      // only three warm accents on the whole back of the piece — the others
      // being the yoke edge and the hem wire. In silver the sleeve ran straight
      // into the glove as one undifferentiated pale mass. The sleeve's grains
      // ride in the same mesh, so the whole forearm's gold is one draw call.
      const gc = new Geo();
      gc.at(0, -P.foreLen + 0.006, 0.006, Math.PI / 2);
      gc.add(torus(P.armR * 0.66, 0.028, this.sd + 6, 6, null, 0.85));

      const fs = new Geo();
      fs.at(0, 0, 0);
      this._stones(fs, foreSurf, { v0: 0.06, v1: 0.92, cy: -P.foreLen * 0.5 }, gc);
      fs.toMesh(`foreStones${s}`, scene, mat.get('whiteGold'), elbow);
      gc.toMesh(`cuff${s}`, scene, mat.get('polGold'), elbow);

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

    // The elbow cap rides here rather than on the elbow node. It is silver, the
    // glove is silver, and the wrist node never moves relative to the elbow, so
    // baking its offset in costs one matrix at build time and saves a draw call
    // per arm at runtime.
    g.at(0, P.foreLen + 0.014, -0.006, Math.PI / 2);
    g.add(torus(P.armR * 0.80, 0.026, this.sd + 6, 6, null, 0.85));

    // palm — a rounded slab, wider than deep
    g.at(0, -R * 0.66, 0.004, 0, 0, 0, 1.0, 1.08, 0.70);
    g.add(ellipsoid({ rx: R, e1: 0.72, e2: 0.66, su: this.sd + 6, sv: this.sd + 2 }));

    const fl = R * 0.72;
    for (let i = 0; i < 4; i++) {
      const t = i / 3;
      const fx = (t - 0.5) * R * 1.06;
      const len = fl * (0.80 + 0.30 * Math.sin(Math.PI * (0.25 + t * 0.6)));
      const splay = (t - 0.5) * 0.26;
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
          R * 0.265 * (1 - 0.20 * f),
          R * 0.265 * (1 - 0.20 * f),
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
      // THE BOOT TOP IS A PAVÉ BAND, not a silver cuff. The reference boot is
      // plain polished silver with one stone-set band around the opening, and
      // from directly behind that band is the only thing separating the boot
      // from the leg above it — in silver, leg and boot merged into a single
      // pale sausage. Built as a torus SURFACE so the stones sit on the band the
      // same way they sit on everything else, from one shared definition, and
      // MERGED INTO THE LEG's two meshes so it costs no extra draw call.
      const bR = P.legR * 0.87, bt = 0.030, bY = -P.legLen + 0.004;
      const bandSurf = (u, v, out) => {
        const a = u * TWO_PI;
        const c2 = (v - 0.5) * Math.PI * 1.06;      // outer arc of the tube only
        const rad = bR + bt * Math.cos(c2);
        out[0] = rad * Math.sin(a);
        out[1] = bY + bt * Math.sin(c2) * 0.88;
        out[2] = rad * Math.cos(a);
      };

      const lb = new Geo();
      lb.at(0, 0, 0, 0, 0, 0, 0.97, 1, 0.97);
      lb.add(surface(legSurf, this.sd + 8, this.sd + 2, 2, 1));
      lb.at(0, 0, 0, 0, 0, 0, 0.97, 0.97, 0.97);
      lb.add(surface(bandSurf, this.sd + 6, this.sd - 2, 3, 1));
      lb.toMesh(`legBed${s}`, scene, mat.get('darkChrome'), pivot);

      // The leg's gold: a wire either side of the pavé boot band, plus the
      // grains between the stones. One mesh, one draw call per leg. The boot
      // band is the lowest thing on the character that is not silver, and from
      // behind it is what stops the boot and the leg reading as one pale
      // sausage — the reference draws it with gold either side, not with a
      // stone band alone.
      const lg = new Geo();
      const ls = new Geo();
      ls.at(0, 0, 0);
      this._stones(ls, legSurf, { v0: 0.05, v1: 0.90, cy: -P.legLen * 0.5 }, lg);
      ls.at(0, 0, 0);
      this._stones(ls, bandSurf, { v0: 0.10, v1: 0.90, cy: bY, pitch: this.pitch * 0.80 }, lg);
      ls.toMesh(`legStones${s}`, scene, mat.get('whiteGold'), pivot);

      for (const e of [-1, 1]) {
        lg.at(0, bY + e * bt * 0.94, 0, Math.PI / 2, 0, 0, 1, 1, 0.94);
        lg.add(torus(bR + bt * 0.30, 0.0125, this.sd + 8, 5, null, 0.85));
      }
      lg.toMesh(`legGold${s}`, scene, mat.get('polGold'), pivot);

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

    // ODD flute counts only — see the note on _lobe() in cape.js. A crease on
    // the centre-back meridian would put a dark seam down the middle of the one
    // view the player looks at all game.
    // NINE FLUTES AND THREE HEM WAVES, on every preset — that ratio is the
    // shape, so it must not drift between presets; only the sampling does.
    // Measured off docs/reference-rear.png at the hem, where both are countable
    // at once: about nine ribs across the visible back, and three hem waves.
    // The build this replaces tied one hem wave to every rib, which is why the
    // hem came out as a paper crown. See _rest() in cape.js.
    // FIFTEEN FLUTES, FIVE HEM WAVES. Nine ribs was measured off the reference's
    // BACK ONLY and then applied to an arc that spans 143 degrees rather than
    // 180, so the model ended up coarser than the thing it was measured from.
    // Counting the reference again across the full visible skirt gives 14-18
    // ribs, and the ribs are narrow: each one is roughly a fifth as deep as it
    // is wide. Fifteen over this arc puts a rib every 8 cm at the hem, which is
    // fine enough to read as fluting rather than as panels.
    const flutes = 15;
    const scallops = 5;              // divides flutes, both odd — see _rest()
    const perFlute = low ? 4 : (high ? 6 : 5);
    const rows = low ? 7 : (high ? 14 : 12);

    // The yoke line. Everything below is measured off docs/reference-rear.png,
    // scaled by head radius, which is the only proportion both the reference
    // and this model agree on:
    //
    //   cape top      0.53 of figure height   -> y = 0.91, the shoulder line
    //   hem lobe tip  0.11 of figure height   -> y = 0.26, just above the boots
    //   hem half width  1.30 head radii       -> 0.53 m
    //
    // The version this replaces had a hem half-width of 0.95 m and a length of
    // 0.92 m — nearly twice as wide and 40% longer than the reference — which
    // is most of why it engulfed the character.
    const capeRoot = new TransformNode('capeRoot', this.ctx.scene);
    capeRoot.parent = body;
    capeRoot.position.set(0, P.shoulderY + 0.030, -0.030);
    this.parts.capeRoot = capeRoot;

    this.cape = new Cape({
      flutes, scallops, perFlute, rows,
      // LONGER, because widening it without lengthening it made a tutu. In the
      // reference the lowest point of the hem reaches the middle of the boots
      // — 0.11 of figure height — and the skirt is only 1.17x as wide as it is
      // long. At 0.650 with the new width this model was at 1.72 and the legs
      // stood clear underneath. 0.715 puts the hem trough at y = 0.195, over
      // the boot tops, and the ratio at 1.48: still stockier than the
      // reference, which this character is everywhere.
      len: 0.775,
      // Plan half-axes, collar -> hem. Elliptical, not circular: at the collar
      // a circle of this radius sits INSIDE the torso at the sides, and at the
      // hem a circle this wide would stand half a metre out behind in profile.
      // Two reference proportions fight each other here and the resolution is
      // worth recording. Against the HEAD, the reference skirt is 1.07x the
      // width of the hood-with-ears. Against ITSELF, it is 1.37x as wide as the
      // visible skirt is long. This model cannot satisfy both, because its head
      // is deliberately far larger than the reference's (3.7 head-radii tall
      // against 4.7), which squeezes the torso the skirt has to live in. Sized
      // for the head alone it came out 2.5x as wide as it was long and read as a
      // TUTU. These numbers split the difference and lean on flarePow to buy the
      // rest: 0.98 m across the hem, against a visible 0.56 m drop.
      //
      // FLATTER IN Z, WIDER IN X. Measured off a straight-on rear elevation:
      // the fluted panel the camera actually sees spanned 240 px against a
      // 350 px hood, so the cape read NARROWER than the head even though its
      // PLAN width was already 1.15x the hood. The width was all there — it had
      // just curled away from the lens. At rz1 = 0.412 against rx1 = 0.545 the
      // hem ellipse is nearly round, so the outer third of the skirt turns
      // edge-on and renders as two thin dark tabs rather than as cape. Pulling
      // the depth in and the width out turns the same columns toward the camera,
      // which is what lets the flutes and the hem scallop read across the whole
      // silhouette the way they do in the reference.
      rx0: 0.250, rx1: 0.615,
      rz0: 0.205, rz1: 0.372,
      // Azimuth covered. Stops short of +/-90 degrees so the arms hang OUTSIDE
      // the skirt and swing clear of it, which is what the reference shows.
      spread0: 2.04,
      spread1: 2.50,
      // >1 so the skirt leaves the yoke almost vertical and opens into a bell
      // low down, which is the profile in the reference. It was 1.58, which
      // held the skirt in a near-cylinder for two thirds of its drop and only
      // opened it in the last quarter — a funnel, not a bell. Tracing the
      // reference's outline, its half-width is already 60% of final at
      // mid-skirt, which is an exponent near 1.3.
      flarePow: 1.32,
      // Deep. The first pass at 0.052 rendered as a smooth white lampshade:
      // the flutes existed (the hem scallops proved it) but did not swing the
      // normals far enough to band a mirror surface.
      //
      // But it went too far the other way. What bands a mirror is the SLOPE of
      // the rib, which is depth over width, and at 0.085 across a 0.13 m rib
      // the sides were near vertical: the ribs stopped being pleats in a sheet
      // and became separate hanging tubes with gaps between them. The reference
      // rib stands proud by about a fifth of its own width. At nine flutes each
      // rib is 0.17 m around, so 0.062 is a little over a third — still much
      // bolder than the reference, because this is seen at 20 metres in a dark
      // hall rather than lit on a plinth, and legibility wins.
      // Fifteen ribs across a 1.2 m hem arc is one rib every 8 cm, so the
      // amplitude that gave a given SLOPE at nine ribs now gives one nearly
      // twice as steep. Slope is what matters on a mirror — it is what decides
      // how much of the environment each rib sweeps through — so the amplitude
      // comes down with the rib width. 0.034 over a 0.082 m rib is the
      // reference's "proud by about a fifth of its width", and still swings the
      // surface normal by about 50 degrees at each crease, which is enough to
      // take the reflection from the bright tent down to the dark floor and
      // back within every single rib. That sweep IS the vertical streak.
      fluteAmp: 0.034,
      // Hem wave, as a fraction of skirt length. The reference's is 0.125 of
      // the drop peak-to-trough; a touch more here for the same reason.
      hemCut: 0.135,
      // A FINE wire. It is now RHODIUM, not gold (see the material note below),
      // and at 7 mm x the 1.24 presentation scale it is a 1.7 cm bead running
      // the scallop. At 0.0105 in gold it was the brightest object in the whole
      // frame and the bloom pass turned it into a glowing cartoon outline.
      trimR: 0.0070,
      trimSu: low ? 4 : 5,
      rippleAmp: 0.022,
      // Heavy metal skirt, not a flag: a stiff spring with real damping, so it
      // swings once through a corner and settles rather than flapping.
      stiff: 88,
      damp: 0.872,
    });

    // MATERIAL: `polRhodium` — the same polished white gold as the boots, the
    // gloves and the cuffs, which is exactly what the reference shows.
    //
    // The route here is worth writing down, because the obvious conclusion was
    // wrong twice. `clothCape` is a fabric normal map with a sheen lobe at 0.42
    // albedo and rendered as exactly what it is: grey cloth. `polRhodium` went
    // in next and rendered as a FEATURELESS WHITE LAMPSHADE, so the cape moved
    // to `wingChrome` (polished chrome at 0.32 albedo), which banded beautifully
    // but sat several stops darker than the reference and vanished into a dark
    // track in the chase view.
    //
    // Both of those were misdiagnoses. The white lampshade was not the material
    // being too bright, it was the FLUTING BEING UNRESOLVED: at two and at four
    // columns per flute the pleats were too coarse and too shallow to swing the
    // normals, so every part of the sheet reflected the same blown-out sky. At
    // six columns and 0.085 depth the same material bands into bright pleats and
    // dark creases and reads as the reference's polished silver. The lesson is
    // the project's own: a mirror is readable exactly as far as its geometry
    // makes it readable, and no material tuning substitutes for that.
    //
    // ...AND THE SIX-COLUMN VERSION STILL RENDERED AS A CREAM BEDSHEET, which is
    // where this pass came in. The remaining half of the diagnosis:
    //
    //   * `_lobe` was flat-topped, so the middle half of every rib had a
    //     CONSTANT NORMAL and therefore a constant colour. Columns per flute
    //     cannot fix that — they only sample a flat top more finely. Fixed in
    //     cape.js: the crown is round now.
    //   * `polRhodium` is albedo 0.905. A mirror's value is albedo x whatever it
    //     reflects, our environment is a bright cream light tent, and 0.905 x
    //     cream is cream no matter what the geometry does. The reference skirt
    //     is DARK with white streaks on it, and its average value is somewhere
    //     near half. So the cape gets its own metal at roughly half albedo.
    //   * `polished()` turns the analytic lights DOWN (directIntensity 0.55) to
    //     stop small parts drowning in the portrait rig's highlight. The cape is
    //     the opposite case: those point lights on a near-vertical polished rib
    //     are precisely the long vertical specular streak the reference has, so
    //     this one keeps them at full and a bit over.
    //
    // Built through mat's PUBLIC factory rather than by adding a case to
    // src/mat/index.js, because src/mat/ is another agent's directory. It is
    // cached by name in the materials registry exactly like every built-in, so
    // it is disposed with them. If mat/ ever grows a `capeMirror` of its own,
    // this call becomes a no-op cache hit and should be replaced by a get().
    const capeMat = mat.polished(
      'capeMirror',
      { r: 0.545, g: 0.560, b: 0.605 },  // cool, and about half of rhodium
      0.060,                              // mirror
      3,                                  // micro-polish tiling
      1.25,                               // KEEP the portrait rig: it is the streak
    );

    this.cape.init(
      this.ctx.scene,
      capeMat,                   // outside: polished mirror rhodium
      // THE HEM IS NOT GOLD. docs/reference-rear.png finishes the scallop with a
      // fine RAISED WIRE OF THE SAME METAL — you can see it because it is a bead
      // catching a different part of the room, not because it is a different
      // colour. In gold it was the loudest thing on the character: the eye went
      // to the hem before the hood, and with bloom on it read as a cartoon
      // outline drawn round a bedsheet. Plain polished rhodium is a stop
      // brighter than `capeMirror`, which draws the scallop as a bright line
      // without turning it into jewellery in its own right.
      mat.get('polRhodium'),
      capeRoot, 3, 2,
      mat.get('darkChrome'),     // inside: the dark cavity
    );

    // The yoke: a pavé collar over the shoulders with a gold edge, which is
    // what the cape hangs from in the reference. It also hides the seam where
    // the skirt's pinned top row meets the torso.
    this._buildYoke(capeRoot, mat);
  }

  /**
   * Pavé yoke + gold edge. Sits on the cape root so it moves with the collar.
   *
   * Built from the SAME cone the skirt's collar row uses, pushed out slightly,
   * so the gold edge lands exactly on the skirt's top row instead of near it.
   */
  _buildYoke(capeRoot, mat) {
    const scene = this.ctx.scene;
    const SPREAD = 2.78;          // wider than the skirt collar — it covers the
                                  // shoulders, and from behind it is a bib
    // THE YOKE MUST SIT PROUD OF THE SKIRT. The first version's lower edge was
    // at radius 0.285 where the skirt is already 0.32 wide, so the whole thing
    // rendered INSIDE the skirt and was invisible from every angle. It now runs
    // from above the skirt's pinned row and stays outboard of it all the way
    // down, which is also what a real yoke does: the cape hangs UNDER it.
    //
    // IT ALSO HAS TO CLEAR THE HOOD. Version two was outboard of the skirt and
    // still did not read, for a different reason: its lower edge sat at radius
    // 0.355 and y = 0.715, and the hood's cowl ends at radius 0.340 and
    // y = 0.772. Two pavé surfaces of the same radius, 6 cm apart, with the same
    // stones on both — from behind that is one continuous pavé mass from the
    // crown of the head to the top of the cape, which is exactly what the
    // capture showed. A collar reads when it is WIDER than the head above it and
    // deep enough to be its own horizontal band, so it now finishes at 0.44
    // against the hood's 0.34 and drops 0.27 instead of 0.195. The bright gold
    // wire added around the hood's own lower edge (see _buildHead) draws the
    // dividing line the shadow alone was not making.
    const yokeSurf = (u, v, out) => {
      const th = (u - 0.5) * SPREAD;
      // drops lower at the centre back and at the shoulder points, like the
      // scalloped bib in the reference
      const dip = 0.70 + 0.30 * Math.cos(th * 2.1);
      // The collar STARTS AT THE HOOD'S LOWER EDGE and flares from there. It
      // used to start 8 cm up inside the hood at a radius the hood was already
      // wider than, so the only part of it that ever emerged was the last
      // centimetre and its gold rim — a gold brim on a stone ball. Beginning it
      // at y = -0.045 (world 0.865, just above the hood's 0.827 lower edge) and
      // at a radius that already clears the hood means every row of it is
      // visible, which is what makes it a collar rather than a hat band.
      // Width, measured off the reference rather than chosen: its collar's
      // lower edge is 0.70 of the hood's width and 0.65 of the cape's. At 0.99
      // across, this one was as wide as the hood and 0.80 of the cape, and the
      // silhouette went from "collar" to "sombrero". 0.81 across hits both
      // reference ratios and still clears the skirt underneath by 7 cm.
      const ax = 0.250 + 0.155 * v;
      const az = 0.215 + 0.130 * v;
      out[0] = ax * Math.sin(th);
      out[1] = -0.045 - 0.215 * v * dip;
      out[2] = -az * Math.cos(th);
    };

    const bed = new Geo();
    bed.at(0, 0, 0, 0, 0, 0, 0.985, 1, 0.985);
    bed.add(surface(yokeSurf, this.lowQ ? 14 : this.su, this.lowQ ? 4 : 6, 2, 1));
    bed.toMesh('yokeBed', scene, mat.get('darkChrome'), capeRoot);

    const g = new Geo();

    const st = new Geo();
    st.at(0, 0, 0);
    // uOpen: the yoke is an ARC, not a closed ring — without this the stone
    // field wraps u around and lays a row of stones across the open front.
    //
    // ONE PITCH, the character's. The collar used to run 14% finer than the rest
    // "because it is a small part", which is precisely the trade the whole pavé
    // rewrite exists to refuse: finer stones dissolve into texture first, and
    // the collar is the piece that has to separate two other pavé masses.
    this._stones(st, yokeSurf, {
      v0: 0.06, v1: 0.93, uOpen: true, uPad: 0.035,
    }, g);
    st.toMesh('yokeStones', scene, mat.get('whiteGold'), capeRoot);

    // gold edge, swept along the yoke's lower rim. Heavier than the hem wire on
    // purpose: this is the line that says "the cape hangs from here", and it is
    // the only hard horizontal on the back of the character.
    const rim = [];
    const rn = this.lowQ ? 20 : 30;
    const p = [0, 0, 0];
    for (let i = 0; i <= rn; i++) {
      yokeSurf(i / rn, 1.0, p);
      rim.push([p[0] * 1.02, p[1] - 0.004, p[2] * 1.02]);
    }
    g.at(0, 0, 0);
    g.add(pipe(rim, () => 0.0155, 6));
    g.toMesh('yokeEdge', scene, mat.get('polGold'), capeRoot);
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
        // At 0.30 the hands hung inside the skirt's silhouette and emerged
        // BELOW its hem, which read as the character having no arms and two
        // spare mittens. 0.42 cleared the old skirt by a couple of centimetres
        // and nothing else, so widening the cape put them back inside it and
        // the sleeves reappeared as two stone lumps in the cape's outline.
        // 0.55 rad plus the wider shoulder puts the mitten 11 cm clear of the
        // hem's radius at its own height — the gold cuff and the silver hand
        // sit against the background, which is how the reference reads them.
        this.parts.arms[0].rotation.z = -0.55 + swAlt * 0.10;
        this.parts.arms[1].rotation.z = 0.55 - swAlt * 0.10;
        // The elbow is the whole point of the two-segment arm: a runner's arm
        // is held bent, and a straight one reads as a stick.
        bendA = -0.95 - swAlt * 0.35;
        bendB = -0.95 - sw * 0.35;
        body.position.y = this._bob * this.scale;
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
        this.parts.arms[0].rotation.z = -0.58;
        this.parts.arms[1].rotation.z = 0.58;
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
        // scaled with the body, so the slide silhouette stays as low relative
        // to the character as it was before the presentation scale went in
        body.position.y = -0.32 * this.scale;
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
    const s = this.scale, sw2 = s / Math.sqrt(this._stretch);
    body.scaling.set(sw2, s * this._stretch, sw2);

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
      seg.rotation.z = this._stalkRest[i] + whip * (i + 1) * 0.6;
      seg.rotation.x = Math.sin(this._flutter * 0.7 + i) * 0.03 * (i + 1);
    }

    this.cape.upload();
  }

  dispose() {
    if (this.cape) this.cape.dispose();
    if (this.root) this.root.dispose(false, true);
  }
}
