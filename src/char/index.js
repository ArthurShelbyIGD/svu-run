// char/ — the player character: procedural mesh, hierarchy, animation.
//
// OWNERSHIP: this directory owns everything about how the runner looks and
// moves. It reads player state from play/ but never writes to it.
//
// THE CAMERA IS BEHIND THE CHARACTER FOR THE ENTIRE GAME.
// Everything here is ordered by that fact. The face is seen on the results
// screen and nowhere else; it is deliberately cheap. What players actually
// look at for an hour is the back of a hooded onesie with a cape on it.
//
// Priorities, in the order the budget is spent:
//   1. THE CAPE. Simulated cloth — see cape.js. It is the largest moving thing
//      in frame and the only part that reacts to how you are playing.
//   2. The onesie as real garment geometry: a hood with folds and a seam over
//      the crown, ears that grow out of the hood rather than sitting on it, a
//      collar, cuffs, a zip, shoulder caps. Built with warped parametric
//      surfaces (geom.js), not primitives.
//   3. Gloves with separate fingers. Silhouette, not anatomy.
//   4. Chibi proportion — the head is over half the standing height. Get that
//      wrong and no amount of detail rescues it.
//
// Parts are MERGED per material (geom.js), so the whole character is about a
// dozen draw calls despite having roughly twenty times the detail of the
// primitive blockout it replaces.

import { TransformNode } from '../core/bjs.js';
import { STATE } from '../play/index.js';
import { Geo, ellipsoid, lathe, tube, torus, arc, pipe, gem } from './geom.js';
import { Cape } from './cape.js';

// Proportions in metres. These numbers ARE the character.
const P = {
  standH: 1.62,
  headR: 0.425,
  headY: 1.10,
  faceR: 0.352,
  faceZ: 0.140,          // how far the face protrudes through the hood
  hoodRimR: 0.400,
  earR: 0.170,
  earSpread: 0.312,
  earY: 0.80,            // fraction of headR above centre
  bodyW: 0.300, bodyH: 0.222, bodyD: 0.250,
  bodyY: 0.615,
  armR: 0.086, armLen: 0.290,
  handR: 0.108,
  shoulderX: 0.288, shoulderY: 0.752,
  legR: 0.102, legLen: 0.200,
  bootR: 0.140,
  hipX: 0.145, hipY: 0.438,
  antennaLen: 0.36, orbR: 0.098,
  eyeR: 0.079, eyeX: 0.132, eyeY: 0.020,
};

const TWO_PI = Math.PI * 2;

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
  }

  init() {
    const scene = this.ctx.scene;
    const q = this.ctx.config.q;
    const low = q.name === 'low';
    const high = q.name === 'high';

    // Tessellation budget. `low` must hold 60fps on a mid-range phone, so it
    // gets roughly half the vertices — the same shapes, coarser.
    // su is a MULTIPLE OF THE GORE COUNT (8), deliberately. At 28 samples for
    // 8 gores the surface is sampled 3.5 times per fold, which beats against
    // the fold frequency and averages the whole thing back into a smooth ball —
    // the folds were in the mesh and invisible on screen.
    this.su = low ? 16 : (high ? 32 : 24);
    this.sv = low ? 10 : (high ? 18 : 14);
    this.sd = low ? 7 : (high ? 12 : 9);     // detail parts: cuffs, fingers
    this.lowQ = low;

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

  // ---- the onesie ------------------------------------------------------

  /**
   * Torso, shoulders, hips and the garment details that sell it as clothing.
   *
   * The previous version was one sphere scaled on three axes. A sphere has no
   * shoulders, so the arms read as balls stuck to a ball. A superellipsoid with
   * a waist warp has a shoulder line and a hip line, which is the whole
   * difference between "a character in a onesie" and "a snowman".
   */
  _buildTorso(body) {
    const mat = this.ctx.get('mat');
    const su = this.su, sv = this.sv;

    const g = new Geo();

    // Main body. e1/e2 below 1 square it off toward a rounded box; the warp
    // pulls in a waist and flares the hips, and adds soft vertical fabric
    // creases that catch the light.
    g.at(0, P.bodyY, 0);
    g.add(ellipsoid({
      rx: P.bodyW, ry: P.bodyH * 1.32, rz: P.bodyD, e1: 0.86, e2: 0.74,
      su, sv,
      warp: (u, v) => {
        const waist = 1 - 0.085 * Math.sin(Math.PI * Math.min(1, Math.max(0, (v - 0.18) / 0.62)));
        const crease = 0.014 * Math.cos(u * TWO_PI * 6) * Math.min(1, v * 2.2);
        return waist + crease;
      },
      uRep: 3, vRep: 1.4,
    }));

    // Shoulder caps: small pavé masses where the sleeves meet the body. They
    // close the gap that made the arms look detached.
    for (const s of [-1, 1]) {
      g.at(s * P.shoulderX * 0.86, P.shoulderY - 0.012, 0, 0, 0, s * -0.34);
      g.add(ellipsoid({ rx: 0.108, ry: 0.098, rz: 0.104, e1: 0.85, su: this.sd + 4, sv: this.sd }));
    }

    // The nape: hood fabric bunching where the hood meets the back. Pure rear
    // silhouette detail, invisible from the front, and one of the strongest
    // reads in the chase camera.
    g.at(0, P.shoulderY + 0.052, -P.bodyD * 0.52, -0.26);
    g.add(ellipsoid({
      rx: 0.238, ry: 0.108, rz: 0.132, e1: 0.8, e2: 0.7, su: su, sv: this.sd,
      warp: (u) => 1 + 0.05 * Math.cos(u * TWO_PI * 5),
    }));

    // Back yoke seam — a raised piping line across the shoulder blades.
    g.at(0, P.shoulderY - 0.055, -P.bodyD * 0.60, Math.PI / 2, 0, 0);
    g.add(arc(0.215, 0.017, -1.15, 1.15, this.sd + 6, 6));

    // Hip hem: the onesie ends in a thicker band above the legs.
    g.at(0, P.bodyY - P.bodyH * 1.16, 0, Math.PI / 2);
    g.add(torus(P.bodyW * 0.80, 0.034, su, this.sd, null, 0.7));

    g.toMesh('onesie', this.ctx.scene, mat.get('paveWhite'), body);

    // --- metal garment furniture, merged into one rhodium mesh ---
    const t = new Geo();
    // collar ring at the neck
    t.at(0, P.shoulderY + 0.088, -0.005, Math.PI / 2);
    t.add(torus(0.176, 0.030, su, this.sd, (u) => 1 + 0.35 * Math.max(0, Math.cos(u * TWO_PI)), 0.8));
    t.toMesh('onesieTrim', this.ctx.scene, mat.get('polRhodium'), body);

    // --- gold: the zip, and its pull ---
    const z = new Geo();
    const zTop = P.shoulderY + 0.02, zBot = P.bodyY - P.bodyH * 1.05;
    const rings = [];
    const zn = 8;
    for (let i = 0; i <= zn; i++) {
      const f = i / zn;
      const y = zTop + (zBot - zTop) * f;
      // follow the curve of the chest so the zip lies ON the body
      const dz = P.bodyD * (0.97 - 0.16 * f * f);
      rings.push([0, y, dz, 0.017, 0.013]);
    }
    z.at(0, 0, 0);
    z.add(tube(rings, 6, true, true, 1, 6));
    // zip pull: a small faceted gem, exactly the jewellery detail the
    // reference is full of
    z.at(0, zBot + 0.012, P.bodyD * 0.86, 0.5);
    z.add(gem(0.036, 6, 0.9));
    z.toMesh('zip', this.ctx.scene, mat.get('polGold'), body);
  }

  // ---- the hood --------------------------------------------------------

  _buildHead(body) {
    const mat = this.ctx.get('mat');
    const scene = this.ctx.scene;
    const su = this.su, sv = this.sv;

    const head = new TransformNode('head', scene);
    head.parent = body;
    head.position.y = P.headY;
    this.parts.head = head;

    // --- hood shell (pavé) ---
    //
    // Not a sphere. A dome that flares into a COWL over the shoulders, because
    // that is what a hood is and because a sphere in this material is a mirror:
    // it reflects the studio horizon as a clean bright ring at ~80% of its
    // silhouette radius, and on the back of the head — the one part of the
    // character a player looks at all game — that artefact was the single
    // strongest feature. See ARCHITECTURE §7.
    //
    // The warp is shared between the shell, the cowl and the gold piping so
    // every one of them follows the same fabric. A ring at a fixed radius on a
    // gored surface floats off it in places and sinks into it in others, which
    // read on screen as a wire hoop hovering beside the head.
    const hoodWarp = (u, v) => {
      const gather = Math.min(1, Math.max(0, (v - 0.12) / 0.88));
      // GORES. A hood is sewn from panels, and panels are what break up a
      // mirror. The first pass used a shallow sine and the specular hotspot
      // swallowed it whole. Seven gores with a sharpened profile give seven
      // distinct ridges, each catching light at its own angle.
      // EIGHT gores, not seven. With an odd count the back meridian u = 0.5
      // lands in a trough, which cancelled the raised back seam exactly and
      // left the centre of the head a smooth mirror — the one place it must
      // not be. Even count, ridge on the seam.
      const gore = Math.cos(u * TWO_PI * 8);
      const folds = 0.070 * Math.sign(gore) * Math.pow(Math.abs(gore), 0.55) * (0.40 + 0.60 * gather);
      // A raised ridge along the BACK meridian, u = 0.5 — dead centre of frame
      // for the whole game, and what turns a ball into a garment.
      const d = Math.abs(u - 0.5);
      const seam = 0.060 * Math.exp(-(d * d) / 0.0022);
      return 1 + folds + seam + 0.055 * gather * gather;
    };
    this._hoodWarp = hoodWarp;
    // A point ON the hood surface, warp and all. Seams computed from this ride
    // the fabric; seams computed from a plain sphere float off it.
    const hoodPt = (u, v, out) => {
      const th = (0.5 - v) * Math.PI;
      const ct = Math.sign(Math.cos(th)) * Math.pow(Math.abs(Math.cos(th)), 0.93);
      const st = Math.sign(Math.sin(th)) * Math.pow(Math.abs(Math.sin(th)), 0.93);
      const ph = u * TWO_PI;
      const k = hoodWarp(u, v) * out;
      const sx = Math.sign(Math.sin(ph)) * Math.pow(Math.abs(Math.sin(ph)), 0.95);
      const cz = Math.sign(Math.cos(ph)) * Math.pow(Math.abs(Math.cos(ph)), 0.95);
      return [
        P.headR * ct * sx * k,
        P.headR * 0.995 * st + 0.035 * Math.cos(v * Math.PI) - 0.02,
        P.headR * 1.025 * ct * cz * k - 0.022,
      ];
    };
    this._hoodPt = hoodPt;

    const g = new Geo();
    g.at(0, 0, -0.022);
    g.add(ellipsoid({
      rx: P.headR, ry: P.headR * 0.995, rz: P.headR * 1.025,
      e1: 0.93, e2: 0.95, su, sv,
      v0: 0, v1: 0.74,
      warp: hoodWarp,
      // the crown sits a little higher than a sphere, which is the profile of
      // fabric draped over a head rather than a ball
      yWarp: (v) => 0.035 * Math.cos(v * Math.PI) - 0.02,
      uRep: 3, vRep: 1.2,
    }));

    // The cowl: from the dome's lower edge, flaring OUT and down onto the
    // shoulders, then tucking back under. This is the silhouette break.
    const cowl = [];
    const cn = Math.max(6, Math.round(sv * 0.7));
    for (let i = 0; i <= cn; i++) {
      const t = i / cn;
      const a = (0.74 + 0.26 * t) * Math.PI;              // continue the sphere's latitude
      const base = Math.sin(a) * P.headR;
      // flare: widest a third of the way down the cowl, then drawn back in
      const f = 1 + 0.30 * Math.sin(Math.PI * Math.min(1, t * 1.35));
      const y = -Math.cos(a) * P.headR * 0.995 - 0.02 - t * 0.075;
      cowl.push([base * f * 1.02, y]);
    }
    g.at(0, 0, -0.022);
    g.add(lathe(cowl, su, (u, v) => hoodWarp(u, 0.74 + 0.26 * v), 3, 0.8));
    // --- bear ears, built as part of the hood ---
    // Each ear is a flattened pavé mass with a piped rim around its outer
    // edge — the same detail the reference has, and what makes them read as
    // sewn hood panels rather than balls balanced on top.
    //
    // The first attempt put a horizontal seam RING at the base of each ear.
    // From the chase camera those two rings read unmistakably as a pair of
    // spectacles. Deleted. Rear-view detail has to be checked from the rear.
    for (const s of [-1, 1]) {
      const ex = s * P.earSpread, ey = P.headR * P.earY, ez = -0.052;
      g.at(ex, ey, ez, 0, 0, s * -0.20);
      g.add(ellipsoid({
        rx: P.earR, ry: P.earR * 1.06, rz: P.earR * 0.74, e1: 0.9,
        su: this.sd + 6, sv: this.sd + 2,
        warp: (u, v) => 1 + 0.03 * Math.cos(u * TWO_PI * 5) * v,
      }));
      // piped rim around the top two-thirds of the ear
      g.at(ex, ey, ez - 0.010, Math.PI / 2, 0, s * -0.20);
      g.add(arc(P.earR * 0.99, 0.019, 0.85, TWO_PI - 0.85, this.sd + 8, 6));
    }
    g.toMesh('hood', scene, mat.get('paveWhite'), head);

    // --- hood brim: the rim that frames the face ---
    // Radius matters. The first attempt at this sat INSIDE the face sphere's
    // silhouette and was completely invisible; it has to ride proud of the
    // face or it does nothing at all. Thicker at the top than at the chin,
    // like an actual hood opening.
    //
    // It is an ARC, not a ring. The first version was a full torus, and its
    // outer radius was larger than the hood's, so it poked straight through the
    // BACK of the head and rendered as a bright band across the one part of the
    // character players actually look at. Found by looking at a true rear
    // frame; invisible in the front and profile poses.
    const b = new Geo();
    const brimPts = [];
    const bn = Math.max(12, su);
    for (let i = 0; i <= bn; i++) {
      // Sweeps the FRONT only, and its ends are drawn in and forward. The
      // first version ran too far round and its outer radius exceeded the
      // hood's, so the two tips punched out through the sides of the head and
      // read as a bar laid across it.
      const a = -1.62 + (3.24 * i) / bn;
      const pull = 1 - 0.13 * Math.pow(Math.abs(a) / 1.62, 2);
      brimPts.push([
        Math.sin(a) * P.hoodRimR * 0.98 * pull,
        -Math.cos(a) * P.hoodRimR * 0.95 * pull + 0.010,
        0.105 + (1 - Math.cos(a)) * 0.055,
      ]);
    }
    b.at(0, 0, 0);
    b.add(pipe(brimPts, (t) => 0.030 + 0.036 * Math.sin(Math.PI * t), this.sd + 2));
    b.toMesh('hoodBrim', scene, mat.get('paveWhiteFine'), head);

    const inner = new Geo();
    for (const s of [-1, 1]) {
      inner.at(s * P.earSpread, P.headR * P.earY, 0.048, 0, 0, s * -0.20);
      inner.add(ellipsoid({
        rx: P.earR * 0.58, ry: P.earR * 0.62, rz: P.earR * 0.34,
        su: this.sd + 4, sv: this.sd,
      }));
    }
    inner.toMesh('earInner', scene, mat.get('earInner'), head);

    // --- face (cheap, on purpose) ---
    // The BACK of the face is pulled in hard. That is not an aesthetic choice.
    // The face is warm rose gold and the hood is white pavé, and at full radius
    // the face's silhouette grazed through the hood's gore troughs and rendered
    // as a bright rose RING across the back of the head — on the one part of
    // the character that is on screen for the entire game. It was invisible in
    // the front, profile and three-quarter poses and obvious the moment a true
    // rear frame existed. Hiding one mesh at a time in a rendered frame found
    // it in one pass; no amount of staring at the numbers had.
    const f = new Geo();
    f.at(0, 0, P.faceZ + 0.028);
    f.add(ellipsoid({
      rx: P.faceR * 0.97, ry: P.faceR * 0.99, rz: P.faceR * 0.96, e1: 0.95, su, sv,
      warp: (u) => {
        const d = Math.abs(u - 0.5);
        return 1 - 0.26 * Math.exp(-(d * d) / 0.052);
      },
    }));
    // fringe peeking out under the brim — must sit PROUD of the face sphere or
    // it is swallowed by it
    f.at(0, P.faceR * 0.60, P.faceZ + 0.10, -0.12, 0, 0, 1.02, 0.42, 0.44);
    f.add(ellipsoid({
      rx: P.faceR * 0.76, su: this.sd + 6, sv: this.sd,
      warp: (u) => 1 + 0.06 * Math.cos(u * TWO_PI * 7),
    }));
    f.toMesh('face', scene, mat.get('polRose'), head);

    // eyes: one merged mesh per material instead of nine little spheres
    const dark = new Geo();
    const iris = new Geo();
    const shine = new Geo();
    for (const s of [-1, 1]) {
      dark.at(s * P.eyeX, P.eyeY, P.faceZ + P.faceR * 0.80, 0, 0, 0, 0.92, 1.22, 0.62);
      dark.add(ellipsoid({ rx: P.eyeR, su: this.sd + 4, sv: this.sd }));
      iris.at(s * P.eyeX, P.eyeY - 0.012, P.faceZ + P.faceR * 0.86, 0, 0, 0, 1, 1.1, 0.4);
      iris.add(ellipsoid({ rx: P.eyeR * 0.52, su: this.sd + 2, sv: this.sd }));
      shine.at(s * P.eyeX + 0.026, P.eyeY + 0.036, P.faceZ + P.faceR * 0.90, 0, 0, 0, 1, 1, 0.6);
      shine.add(ellipsoid({ rx: P.eyeR * 0.30, su: this.sd, sv: this.sd }));
    }
    // mouth rides with the dark group
    dark.at(0, -0.135, P.faceZ + P.faceR * 0.84, 0, 0, 0, 1.5, 0.55, 0.5);
    dark.add(ellipsoid({ rx: 0.052, su: this.sd, sv: this.sd }));
    dark.toMesh('eyes', scene, mat.get('eyeDark'), head);
    iris.toMesh('iris', scene, mat.get('eyeIris'), head);
    shine.toMesh('catchlight', scene, mat.get('catchlight'), head);

    // --- gold piping over the crown ---
    // The rear silhouette was white pavé, silver and black, and nothing else.
    // The reference is full of yellow gold. A single piped seam running over
    // the crown and down the back of the hood puts a warm line down the middle
    // of the frame, and gives the eye something to read the head's FORM by —
    // a sphere with a line over it is not a sphere any more.
    // a = 0 is the front of the crown, pi/2 the top, pi the back of the nape
    const p = new Geo();
    const seamPts = [];
    const sn = Math.max(14, this.sv);
    const seamR = P.headR * 1.055;
    for (let i = 0; i <= sn; i++) {
      const a = 0.62 + (2.20 * i) / sn;
      seamPts.push([0, Math.sin(a) * seamR * 0.99 - 0.02, -Math.cos(a) * seamR - 0.022]);
    }
    p.at(0, 0, 0);
    p.add(pipe(seamPts, (t) => 0.016 + 0.010 * Math.sin(Math.PI * t), 7));

    // PANEL SEAMS. Four gold lines running from the crown down the gore ridges.
    //
    // The gores themselves are in the mesh and measurably deep, and at gameplay
    // distance they still read as nothing: a 3cm corrugation on a 42cm sphere
    // loses to the pavé normal map and a bright key light. Soft form does not
    // survive this material. Hard geometry does, and a raised gold line survives
    // anything — it is also exactly how the reference piece is built, where
    // every panel meets at a setting rather than a shading gradient.
    const panelN = Math.max(10, Math.round(sv * 0.8));
    for (const pu of (this.lowQ ? [0.25, 0.75] : [0.125, 0.375, 0.625, 0.875])) {
      const pts = [];
      for (let i = 0; i <= panelN; i++) {
        const v = 0.055 + (0.665 * i) / panelN;
        pts.push(this._hoodPt(pu, v, 1.022));
      }
      p.at(0, 0, 0);
      p.add(pipe(pts, (t) => 0.013 + 0.007 * Math.sin(Math.PI * t), 6));
    }
    // Drawstring casing: a gold ring around the hood, low down.
    //
    // It is here for a reason the reference does not show. A large smooth
    // sphere in a mirror-finish material reflects the studio horizon as a clean
    // bright RING at about 80% of its silhouette radius — see ARCHITECTURE §7
    // on reflective materials. That ring was the strongest feature on the back
    // of the head and it was an artefact. Vertical gores broke it up one way;
    // this breaks it the other, and puts more gold in the rear silhouette.
    const ringPts = [];
    const rn = Math.max(24, su);
    const rv = 0.695;
    for (let i = 0; i <= rn; i++) ringPts.push(this._hoodPt(i / rn, rv, 1.030));
    p.at(0, 0, 0);
    p.add(pipe(ringPts, () => 0.017, 6));
    // toggle at the nape
    p.at(0, this._hoodPt(0.5, rv, 1.0)[1] - 0.012, -P.headR * 1.06, 0.35);
    p.add(gem(0.040, 6, 0.9));
    p.toMesh('hoodPiping', scene, mat.get('polGold'), head);

    this._buildAntenna(head, mat, scene);
  }

  _buildAntenna(head, mat, scene) {
    // Curved, not a straight pin: a short chain of segments so it can bend and
    // whip as the character runs. The wire tapers, which is the difference
    // between a jewellery stem and a cocktail stick.
    const stalkRoot = new TransformNode('stalkRoot', scene);
    stalkRoot.parent = head;
    stalkRoot.position.set(0.045, P.headR * 0.86, -0.10);
    this.parts.stalk = stalkRoot;

    this.parts.stalkSegs = [];
    let prev = stalkRoot;
    const segs = 4;
    const segLen = P.antennaLen / segs;
    for (let i = 0; i < segs; i++) {
      const node = new TransformNode(`stalkSeg${i}`, scene);
      node.parent = prev;
      node.position.y = i === 0 ? 0 : segLen;
      node.rotation.z = -0.14;
      const g = new Geo();
      const r0 = 0.019 * (1 - i * 0.10), r1 = 0.019 * (1 - (i + 1) * 0.10);
      g.at(0, 0, 0);
      g.add(tube([[0, 0, 0, r0, r0], [0, segLen, 0, r1, r1]], 6, false, false, 1, 2));
      g.toMesh(`stalkBit${i}`, scene, mat.get('polGold'), node);
      this.parts.stalkSegs.push(node);
      prev = node;
    }

    const o = new Geo();
    o.at(0, segLen, 0);
    o.add(ellipsoid({ rx: P.orbR, su: this.su, sv: this.sv, uRep: 3 }));
    o.toMesh('orb', scene, mat.get('paveRuby'), prev);
    const oc = new Geo();
    oc.at(0, segLen, 0);
    oc.add(ellipsoid({ rx: P.orbR * 0.52, su: this.sd + 4, sv: this.sd }));
    oc.toMesh('orbCore', scene, mat.get('rubyGlow'), prev);
  }

  // ---- arms and gloves -------------------------------------------------

  _buildArms(body) {
    const mat = this.ctx.get('mat');
    const scene = this.ctx.scene;
    this.parts.arms = [];
    for (const s of [-1, 1]) {
      const pivot = new TransformNode(`armPivot${s}`, scene);
      pivot.parent = body;
      pivot.position.set(s * P.shoulderX, P.shoulderY, 0);

      // --- sleeve: a tapered tube with an elbow, not a capsule ---
      const g = new Geo();
      const rings = [];
      const n = 7;
      for (let i = 0; i <= n; i++) {
        const f = i / n;
        const y = -P.armLen * f;
        // slight forward bend at the elbow so the arm has an inside and an
        // outside instead of being a rod
        const z = Math.sin(f * Math.PI) * 0.018;
        const r = P.armR * (1.05 - 0.30 * f + 0.06 * Math.sin(f * Math.PI * 2));
        rings.push([0, y, z, r, r * 0.95]);
      }
      g.at(0, 0, 0);
      g.add(tube(rings, this.sd + 5, true, false, 2, 3));
      g.toMesh(`sleeve${s}`, scene, mat.get('paveWhiteFine'), pivot);

      // --- cuff: pavé band at the wrist, where sleeve meets glove ---
      const c = new Geo();
      c.at(0, -P.armLen + 0.012, 0.012, Math.PI / 2);
      c.add(torus(P.armR * 0.80, 0.028, this.sd + 6, 6, null, 0.85));
      c.toMesh(`cuff${s}`, scene, mat.get('paveWhite'), pivot);

      // --- glove ---
      const wrist = new TransformNode(`wrist${s}`, scene);
      wrist.parent = pivot;
      wrist.position.set(0, -P.armLen - 0.012, 0.012);
      this._buildGlove(wrist, s, mat, scene);

      this.parts.arms.push(pivot);
    }
  }

  /**
   * A silver glove with fingers.
   *
   * The owner asked for this specifically: "the hands have fingers wearing
   * silver gloves". Mitten spheres are what the previous build had and they
   * are the reason the hands read as afterthoughts.
   *
   * Anatomy is not the point — silhouette is. Four fingers plus a thumb, each
   * a two-segment tapered tube with a curl, splayed slightly so gaps of
   * background show between them. Those gaps are what the eye reads as
   * "fingers" at gameplay distance. The whole hand is one merged mesh: one
   * draw call for five digits and a palm.
   */
  _buildGlove(wrist, s, mat, scene) {
    const g = new Geo();
    const R = P.handR;

    // palm — a rounded slab, wider than deep, angled to the forearm
    g.at(0, -R * 0.62, 0.004, 0, 0, 0, 1.0, 1.06, 0.72);
    g.add(ellipsoid({ rx: R, e1: 0.72, e2: 0.66, su: this.sd + 6, sv: this.sd + 2 }));

    // fingers
    const fl = R * 0.92;
    for (let i = 0; i < 4; i++) {
      const t = i / 3;
      const fx = (t - 0.5) * R * 1.24;
      // outer fingers are shorter and splay further, exactly as a real hand
      const len = fl * (0.80 + 0.30 * Math.sin(Math.PI * (0.25 + t * 0.6)));
      const splay = (t - 0.5) * 0.46;
      const curl = 0.42;
      const rings = [];
      const n = 5;
      for (let k = 0; k <= n; k++) {
        const f = k / n;
        const ang = curl * f * f;
        rings.push([
          0,
          -len * f,
          Math.sin(ang) * len * 0.55,
          R * 0.215 * (1 - 0.28 * f),
          R * 0.215 * (1 - 0.28 * f),
        ]);
      }
      g.at(fx * s, -R * 1.32, 0.012, 0, 0, splay * s);
      g.add(tube(rings, this.sd, true, true, 1, 3));
      // knuckle bead — catches a highlight and separates the finger from the
      // palm, which is what stops four tubes reading as a fork. Dropped on
      // `low`: at that budget it is 200 vertices per hand for a detail two
      // pixels across on a phone.
      if (!this.lowQ) {
        g.at(fx * s, -R * 1.30, 0.014, Math.PI / 2, 0, splay * s);
        g.add(torus(R * 0.20, 0.013, this.sd, 5, null, 0.8));
      }
    }

    // thumb — shorter, thicker, swung out and forward
    const trings = [];
    const tn = 4, tl = R * 0.72;
    for (let k = 0; k <= tn; k++) {
      const f = k / tn;
      trings.push([0, -tl * f, Math.sin(0.5 * f * f) * tl * 0.5,
        R * 0.26 * (1 - 0.25 * f), R * 0.26 * (1 - 0.25 * f)]);
    }
    g.at(s * R * 0.74, -R * 0.86, 0.030, -0.30, 0, s * 1.05);
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

      const g = new Geo();
      const rings = [];
      const n = 6;
      for (let i = 0; i <= n; i++) {
        const f = i / n;
        const r = P.legR * (1.12 - 0.34 * f);
        rings.push([0, -P.legLen * f, 0, r, r]);
      }
      g.at(0, 0, 0);
      g.add(tube(rings, this.sd + 5, true, false, 2, 3));
      // ankle cuff
      g.at(0, -P.legLen + 0.008, 0, Math.PI / 2);
      g.add(torus(P.legR * 0.80, 0.026, this.sd + 6, 6, null, 0.85));
      g.toMesh(`leg${s}`, scene, mat.get('paveWhiteFine'), pivot);

      // --- boot ---
      // A shaped last with a toe box, an instep and a heel, instead of a
      // squashed ball. From behind you see heels, so the heel gets a form.
      const b = new Geo();
      b.at(0, -P.legLen - P.bootR * 0.44, 0.048, 0, 0, 0, 0.96, 0.74, 1.30);
      b.add(ellipsoid({ rx: P.bootR, e1: 0.72, e2: 0.70, su: this.sd + 8, sv: this.sd + 3 }));
      // toe cap
      b.at(0, -P.legLen - P.bootR * 0.50, 0.048 + P.bootR * 0.92, 0, 0, 0, 0.80, 0.62, 0.72);
      b.add(ellipsoid({ rx: P.bootR, e1: 0.8, su: this.sd + 4, sv: this.sd }));
      // heel block
      b.at(0, -P.legLen - P.bootR * 0.86, 0.048 - P.bootR * 0.78, 0, 0, 0, 0.74, 0.46, 0.56);
      b.add(ellipsoid({ rx: P.bootR, e1: 0.6, e2: 0.6, su: this.sd + 4, sv: this.sd }));
      // sole welt: a raised rim right around the base, the detail that makes a
      // boot look made rather than moulded
      b.at(0, -P.legLen - P.bootR * 0.86, 0.055, Math.PI / 2, 0, 0, 1.0, 1.0, 1.42);
      b.add(torus(P.bootR * 0.80, 0.023, this.sd + 8, 6, null, 0.7));
      b.toMesh(`boot${s}`, scene, mat.get('polRhodium'), pivot);

      this.parts.legs.push(pivot);
    }
  }

  // ---- the cape --------------------------------------------------------

  _buildCape(body, low, high) {
    const mat = this.ctx.get('mat');
    // cols is locked to the scallop count: with cols = scallops*2 + 1 the hem
    // points and the rib columns land on the same particles, so the silver ribs
    // run exactly down the long points of the wing.
    const scallops = low ? 3 : 4;
    const colsPerRib = low ? 2 : 4;
    const cols = scallops * colsPerRib + 1;
    const rows = low ? 10 : (high ? 18 : 15);

    const capeRoot = new TransformNode('capeRoot', this.ctx.scene);
    capeRoot.parent = body;
    capeRoot.position.set(0, P.shoulderY + 0.075, -0.045);
    this.parts.capeRoot = capeRoot;

    this.cape = new Cape(cols, rows, {
      iters: low ? 2 : 4,
      len: 1.16,
      halfW0: 0.17,
      halfW1: 1.02,
      scallops,
      colsPerRib,
      hemCut: 0.26,
      shoulderR: 0.205,
      shoulderSpread: 2.30,
    });
    // The ribs are PAVÉ, not polished metal, and that was a decision made by
    // looking. Polished rhodium in this world is a mirror: in a dark zone it
    // renders almost black and the ribs vanished into the cape they were
    // supposed to be breaking up. Pavé has micro-normals pointing everywhere,
    // so it catches light from any direction and reads bright and jewelled at
    // any angle — which is the whole point of putting them there.
    this.cape.init(this.ctx.scene, mat.get('clothCape'), mat.get('paveWhiteFine'), capeRoot, 3, 3);

    // Clasp: a gold collar plate over the cape's pinned edge, so the cape
    // looks fastened rather than growing out of the character's back.
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
   * at its rest pose in every screenshot — which is exactly the class of defect
   * this project keeps finding by looking at frames.
   *
   * The stride phase moved here for the same reason.
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

    // The launch frame of a jump is a single-step velocity step change, which
    // differentiates to an enormous number. Clamp rather than special-case.
    if (ax > 45) ax = 45; else if (ax < -45) ax = -45;
    if (ay > 45) ay = 45; else if (ay < -45) ay = -45;
    this._aX += (ax - this._aX) * 0.35;
    this._aY += (ay - this._aY) * 0.35;

    // the run-cycle bob is applied to the body node in renderUpdate; the cape
    // hangs off that node, so it needs to know about it
    this._bob = play.state === STATE.RUN ? Math.abs(Math.sin(this.phase)) * 0.055 : 0;
    this._bobV = (this._bob - this._lastBob) / dt;
    this._lastBob = this._bob;

    const speed = play.state === STATE.DEAD ? 0 : play.speed;
    this.cape.step(dt, speed, this._aX, this._aY, 0, this._bobV);

    // On the very first frames the cape falls from its flat rest pose, which
    // looks like a dropped towel. Settle it before anyone sees it.
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

    switch (play.state) {
      case STATE.RUN: {
        this.parts.legs[0].rotation.x = sw * 0.92;
        this.parts.legs[1].rotation.x = swAlt * 0.92;
        this.parts.arms[0].rotation.x = swAlt * 0.68;
        this.parts.arms[1].rotation.x = sw * 0.68;
        // arms swing slightly outward as they come forward — stops them
        // reading as pendulums bolted to a box
        this.parts.arms[0].rotation.z = -0.16 + swAlt * 0.10;
        this.parts.arms[1].rotation.z = 0.16 - swAlt * 0.10;
        body.position.y = this._bob;
        body.rotation.x = 0.11;
        wantStretch = 1 + Math.abs(sw) * 0.03;
        break;
      }
      case STATE.AIR: {
        const rise = play.vy > 0;
        this.parts.legs[0].rotation.x = rise ? -0.62 : 0.40;
        this.parts.legs[1].rotation.x = rise ? -0.28 : 0.66;
        this.parts.arms[0].rotation.x = rise ? -1.45 : -0.50;
        this.parts.arms[1].rotation.x = rise ? -1.45 : -0.50;
        this.parts.arms[0].rotation.z = -0.42;
        this.parts.arms[1].rotation.z = 0.42;
        body.position.y = 0;
        body.rotation.x = rise ? -0.16 : 0.22;
        // stretch going up, squash coming down — the oldest trick there is
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
        body.position.y = -0.32;
        body.rotation.x = 1.02;
        wantStretch = 0.86;
        break;
      }
      default: {
        body.rotation.x = 0.1;
        break;
      }
    }

    // Squash and stretch, eased so landings pop rather than snap.
    this._stretch += (wantStretch - this._stretch) * Math.min(1, dtReal * 14);
    body.scaling.set(1 / Math.sqrt(this._stretch), this._stretch, 1 / Math.sqrt(this._stretch));

    // Lean into lane changes.
    const wantLean = play.laneT < 1 ? (play.laneTarget - play.lane) * -0.34 : 0;
    this._lean += (wantLean - this._lean) * Math.min(1, dtReal * 12);
    body.rotation.z = this._lean;

    // Head counter-rotates slightly against the lean, so it looks like the
    // character is holding its line rather than being tipped over.
    this.parts.head.rotation.z = -this._lean * 0.45;
    this.parts.head.rotation.x = -body.rotation.x * 0.55 + Math.sin(this.phase * 2) * 0.02;

    // Antenna whip: each segment lags the one before it.
    this._flutter += dtReal * (2.2 + play.speed * 0.10);
    const whip = Math.sin(this.phase * 0.8) * 0.06 - this._lean * 0.35;
    for (let i = 0; i < this.parts.stalkSegs.length; i++) {
      const seg = this.parts.stalkSegs[i];
      seg.rotation.z = -0.14 + whip * (i + 1) * 0.6;
      seg.rotation.x = Math.sin(this._flutter * 0.7 + i) * 0.03 * (i + 1);
    }

    this.cape.upload();
  }

  dispose() {
    if (this.cape) this.cape.dispose();
    if (this.root) this.root.dispose(false, true);
  }
}
