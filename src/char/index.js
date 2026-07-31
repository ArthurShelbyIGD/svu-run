// char/ — the player character: procedural mesh, hierarchy, animation.
//
// OWNERSHIP: this directory owns everything about how the runner looks and
// moves. It reads player state from play/ but never writes to it.
//
// The character is built entirely from primitives and two hand-authored
// meshes. No model files, in keeping with the rest of the project.
//
// WHAT MAKES IT RECOGNISABLE, in order:
//   1. Proportion — the head is over half the standing height. Get this wrong
//      and nothing else rescues it.
//   2. The eyes. Huge, near-black, glossy, with a bright catchlight. A chibi
//      eye without a highlight reads as dead, and dead eyes are the single
//      fastest way to lose the likeness.
//   3. The hood: bear ears, and a rim that FRAMES the face rather than a head
//      with a hat balanced on it.
//   4. The rear silhouette — wing, ears, antenna. During play the camera is
//      behind the character almost all of the time, so the back is what
//      players actually see. The face is for the results screen.

import { MeshBuilder, CreateTorus, TransformNode, VertexData, Mesh } from '../core/bjs.js';
import { STATE } from '../play/index.js';

// Proportions in metres. These numbers ARE the character.
const P = {
  standH: 1.62,
  headR: 0.425,
  headY: 1.10,
  faceR: 0.352,
  faceZ: 0.135,          // how far the face protrudes through the hood
  hoodRimR: 0.402,
  earR: 0.152,
  earSpread: 0.300,
  earY: 0.80,            // fraction of headR above centre
  bodyW: 0.300, bodyH: 0.215, bodyD: 0.245,
  bodyY: 0.615,
  armR: 0.082, armLen: 0.275,
  handR: 0.122,
  shoulderX: 0.292, shoulderY: 0.745,
  legR: 0.098, legLen: 0.195,
  bootR: 0.142,
  hipX: 0.142, hipY: 0.435,
  wingScale: 0.92,
  antennaLen: 0.34, orbR: 0.098,
  eyeR: 0.079, eyeX: 0.132, eyeY: 0.020,
};

export default class Character {
  constructor(ctx) {
    this.ctx = ctx;
    this.root = null;
    this.parts = {};
    this.phase = 0;
    this._lean = 0;
    this._stretch = 1;
    this._wingT = 0;
    this._w = [0, 0, 0];
  }

  init() {
    const scene = this.ctx.scene;
    const q = this.ctx.config.q;
    this.seg = q.name === 'low' ? 10 : 20;

    this.root = new TransformNode('charRoot', scene);
    const body = new TransformNode('charBody', scene);
    body.parent = this.root;
    this.parts.body = body;

    this._buildTorso(body);
    this._buildHead(body);
    this._buildArms(body);
    this._buildLegs(body);
    this._buildWing(body);

    const world = this.ctx.tryGet('world');
    if (world) {
      world.addCaster(this.root);
      // The character carries its own light tent. Without it, pavé in a dark
      // zone renders as grey lumps regardless of how the material is tuned.
      world.attachPortraitRig(this.root);
    }
  }

  // ---- construction helpers -------------------------------------------

  _sphere(name, r, parent, mat, sx = 1, sy = 1, sz = 1) {
    const m = MeshBuilder.CreateSphere(name, { diameter: r * 2, segments: this.seg }, this.ctx.scene);
    m.material = mat;
    m.parent = parent;
    m.isPickable = false;
    if (sx !== 1 || sy !== 1 || sz !== 1) m.scaling.set(sx, sy, sz);
    return m;
  }

  _buildTorso(body) {
    const mat = this.ctx.get('mat');
    // A rounded box would be ideal; a sphere squashed on all three axes reads
    // the same at this size and costs one primitive instead of a CSG.
    const torso = this._sphere('torso', P.bodyW, body, mat.get('paveWhite'),
      1, P.bodyH / P.bodyW, P.bodyD / P.bodyW);
    torso.position.y = P.bodyY;
    this.parts.torso = torso;

    // Zip line down the front, straight off the reference onesie.
    const zip = MeshBuilder.CreateBox('zip', {
      width: 0.028, height: P.bodyH * 1.7, depth: 0.02,
    }, this.ctx.scene);
    zip.material = mat.get('polGold');
    zip.parent = body;
    zip.position.set(0, P.bodyY, P.bodyD * 0.96);
    zip.isPickable = false;
  }

  _buildHead(body) {
    const mat = this.ctx.get('mat');
    const scene = this.ctx.scene;

    const head = new TransformNode('head', scene);
    head.parent = body;
    head.position.y = P.headY;
    this.parts.head = head;

    // Hood shell, pushed slightly back so the face can sit proud of it.
    const hood = this._sphere('hood', P.headR, head, mat.get('paveWhite'), 1, 0.99, 1.02);
    hood.position.z = -0.02;
    this.parts.hood = hood;

    // Face, in warm metal, protruding through the front of the hood.
    const face = this._sphere('face', P.faceR, head, mat.get('polRose'), 1, 1.02, 0.98);
    face.position.z = P.faceZ;
    this.parts.face = face;

    // The rim is what turns "a head with a hat on" into "a hood". It is the
    // cheapest single part here and does more work than any other.
    // Radius matters: the first attempt sat INSIDE the face sphere's
    // silhouette and was completely invisible. It has to ride on the hood
    // surface, outside the face, or it does nothing at all.
    const rim = CreateTorus('hoodRim', {
      diameter: P.hoodRimR * 2, thickness: 0.098, tessellation: this.seg,
    }, scene);
    rim.material = mat.get('paveWhiteFine');
    rim.parent = head;
    rim.rotation.x = Math.PI / 2;
    rim.position.z = 0.095;
    rim.scaling.set(1.02, 1.02, 0.78);
    rim.isPickable = false;
    this.parts.rim = rim;

    // Fringe peeking out under the rim. Must sit PROUD of the face sphere or
    // it is swallowed by it — the first version was entirely interior.
    const fringe = this._sphere('fringe', P.faceR * 0.74, head, mat.get('polRose'), 1.02, 0.42, 0.40);
    fringe.position.set(0, P.faceR * 0.60, P.faceZ + 0.11);

    // --- bear ears ---
    for (const s of [-1, 1]) {
      const ear = this._sphere(`ear${s}`, P.earR, head, mat.get('paveWhiteFine'), 1, 1, 0.72);
      ear.position.set(s * P.earSpread, P.headR * P.earY, -0.035);
      const inner = this._sphere(`earIn${s}`, P.earR * 0.56, head, mat.get('earInner'), 1, 1, 0.5);
      inner.position.set(s * P.earSpread, P.headR * P.earY, 0.055);
    }

    // --- eyes ---
    // Oversized, slightly toed-in, with a large catchlight and a smaller
    // secondary one. This is the likeness.
    this.parts.eyes = [];
    for (const s of [-1, 1]) {
      const eye = this._sphere(`eye${s}`, P.eyeR, head, mat.get('eyeDark'), 0.92, 1.22, 0.62);
      eye.position.set(s * P.eyeX, P.eyeY, P.faceZ + P.faceR * 0.80);
      this.parts.eyes.push(eye);

      const iris = this._sphere(`iris${s}`, P.eyeR * 0.52, head, mat.get('eyeIris'), 1, 1.1, 0.4);
      iris.position.set(s * P.eyeX, P.eyeY - 0.012, P.faceZ + P.faceR * 0.86);

      const hi = this._sphere(`hi${s}`, P.eyeR * 0.30, head, mat.get('catchlight'), 1, 1, 0.6);
      hi.position.set(s * P.eyeX + 0.026, P.eyeY + 0.036, P.faceZ + P.faceR * 0.90);

      const hi2 = this._sphere(`hi2${s}`, P.eyeR * 0.15, head, mat.get('catchlight'), 1, 1, 0.6);
      hi2.position.set(s * P.eyeX - 0.028, P.eyeY - 0.030, P.faceZ + P.faceR * 0.88);
    }

    // --- mouth ---
    const mouth = this._sphere('mouth', 0.052, head, mat.get('eyeDark'), 1.5, 0.55, 0.5);
    mouth.position.set(0, -0.135, P.faceZ + P.faceR * 0.84);

    // --- antenna ---
    // Curved, not a straight pin: built from a short chain of segments so it
    // can bend, and so it whips a little as the character runs.
    const stalkRoot = new TransformNode('stalkRoot', scene);
    stalkRoot.parent = head;
    stalkRoot.position.set(0.045, P.headR * 0.86, -0.10);
    this.parts.stalk = stalkRoot;

    this.parts.stalkSegs = [];
    let prev = stalkRoot;
    const segs = 4;
    for (let i = 0; i < segs; i++) {
      const node = new TransformNode(`stalkSeg${i}`, scene);
      node.parent = prev;
      node.position.y = i === 0 ? 0 : P.antennaLen / segs;
      node.rotation.z = -0.14;
      const bit = MeshBuilder.CreateCylinder(`stalkBit${i}`, {
        diameter: 0.030, height: P.antennaLen / segs, tessellation: 6,
      }, scene);
      bit.material = mat.get('polGold');
      bit.parent = node;
      bit.position.y = P.antennaLen / (segs * 2);
      bit.isPickable = false;
      this.parts.stalkSegs.push(node);
      prev = node;
    }

    const orb = this._sphere('orb', P.orbR, prev, mat.get('paveRuby'));
    orb.position.y = P.antennaLen / segs;
    this.parts.orb = orb;
    const orbCore = this._sphere('orbCore', P.orbR * 0.52, prev, mat.get('rubyGlow'));
    orbCore.position.y = P.antennaLen / segs;
  }

  _buildArms(body) {
    const mat = this.ctx.get('mat');
    const scene = this.ctx.scene;
    this.parts.arms = [];
    for (const s of [-1, 1]) {
      const pivot = new TransformNode(`armPivot${s}`, scene);
      pivot.parent = body;
      pivot.position.set(s * P.shoulderX, P.shoulderY, 0);

      const upper = MeshBuilder.CreateCapsule(`arm${s}`, {
        radius: P.armR, height: P.armLen, tessellation: Math.max(6, this.seg / 2),
      }, scene);
      upper.material = mat.get('paveWhiteFine');
      upper.parent = pivot;
      upper.position.y = -P.armLen * 0.5;
      upper.isPickable = false;

      // Mitten, not a hand: one rounded mass with a thumb nub.
      const hand = this._sphere(`hand${s}`, P.handR, pivot, mat.get('polRhodium'), 1, 1.12, 0.86);
      hand.position.y = -P.armLen - P.handR * 0.35;
      const thumb = this._sphere(`thumb${s}`, P.handR * 0.42, pivot, mat.get('polRhodium'), 1, 1.1, 0.9);
      thumb.position.set(s * P.handR * 0.7, -P.armLen - P.handR * 0.1, 0.02);

      this.parts.arms.push(pivot);
    }
  }

  _buildLegs(body) {
    const mat = this.ctx.get('mat');
    const scene = this.ctx.scene;
    this.parts.legs = [];
    for (const s of [-1, 1]) {
      const pivot = new TransformNode(`legPivot${s}`, scene);
      pivot.parent = body;
      pivot.position.set(s * P.hipX, P.hipY, 0);

      const upper = MeshBuilder.CreateCapsule(`leg${s}`, {
        radius: P.legR, height: P.legLen, tessellation: Math.max(6, this.seg / 2),
      }, scene);
      upper.material = mat.get('paveWhiteFine');
      upper.parent = pivot;
      upper.position.y = -P.legLen * 0.5;
      upper.isPickable = false;

      // Boot: a rounded mass pushed forward so the silhouette has a toe.
      const boot = this._sphere(`boot${s}`, P.bootR, pivot, mat.get('polRhodium'), 0.95, 0.80, 1.25);
      boot.position.set(0, -P.legLen - P.bootR * 0.42, 0.045);

      this.parts.legs.push(pivot);
    }
  }

  /**
   * The bat wing.
   *
   * Hand-authored rather than a primitive because the scalloped trailing edge
   * IS the wing — a rectangle in dark chrome reads as a slab bolted to the
   * character's back, which is exactly what the first blockout looked like.
   * Built as a triangle fan from an interior point out to a traced outline.
   */
  _buildWing(body) {
    const mat = this.ctx.get('mat');
    const scene = this.ctx.scene;

    // Outline in the XY plane, root at origin, wing extending along -X.
    const outline = [
      [0.00, 0.12], [-0.30, 0.30], [-0.62, 0.34], [-0.90, 0.26],  // leading edge to tip
      [-0.70, 0.04], [-0.82, -0.12],                              // scallop 1
      [-0.58, -0.16], [-0.64, -0.36],                             // scallop 2
      [-0.38, -0.30], [-0.36, -0.50],                             // scallop 3
      [-0.14, -0.32], [0.00, -0.14],                              // scallop 4 to root
    ];
    const cx = -0.36, cy = -0.02;

    const positions = [cx, cy, 0];
    const normals = [0, 0, -1];
    for (const [x, y] of outline) {
      positions.push(x, y, 0);
      normals.push(0, 0, -1);
    }
    const indices = [];
    for (let i = 0; i < outline.length; i++) {
      const a = 1 + i;
      const b = 1 + ((i + 1) % outline.length);
      indices.push(0, a, b);
    }

    const wing = new Mesh('wing', scene);
    const vd = new VertexData();
    vd.positions = positions;
    vd.indices = indices;
    vd.normals = normals;
    vd.applyToMesh(wing);
    wing.material = mat.get('wingChrome');   // double-sided: a sheet needs it
    wing.parent = body;
    wing.isPickable = false;
    wing.scaling.setAll(P.wingScale);
    wing.position.set(-P.bodyW * 0.85, P.bodyY + 0.16, -P.bodyD * 0.55);
    wing.rotation.set(0.10, -0.55, 0.22);
    this.parts.wing = wing;

    // Bone ribs along the finger lines give the membrane structure.
    for (let i = 0; i < 4; i++) {
      const tip = outline[3 + i * 2];
      const rib = MeshBuilder.CreateCylinder(`rib${i}`, {
        diameter: 0.034, height: Math.hypot(tip[0], tip[1]) * 0.98, tessellation: 5,
      }, scene);
      rib.material = mat.get('polRhodium');
      rib.parent = wing;
      // On the VISIBLE side of the membrane. Behind it they may as well not
      // exist, and the wing loses the finger structure that makes it a wing.
      rib.position.set(tip[0] * 0.5, tip[1] * 0.5, 0.016);
      rib.rotation.z = Math.atan2(tip[1], tip[0]) - Math.PI / 2;
      rib.isPickable = false;
    }
  }

  // ---- animation -------------------------------------------------------

  renderUpdate(dtReal) {
    const play = this.ctx.get('play');
    const T = this.ctx.config.tune;
    const body = this.parts.body;
    const track = this.ctx.tryGet('track');

    if (track) {
      track.path.toWorld(play.z, play.x, play.y, this._w);
      this.root.position.set(this._w[0], this._w[1], this._w[2]);
      this.root.rotation.y = track.path.yawAt(play.z);
    } else {
      this.root.position.set(play.x, play.y, play.z);
    }

    const strideHz = 1.15 + (play.speed / T.maxSpeed) * 1.45;
    if (play.state === STATE.RUN) this.phase += dtReal * strideHz * Math.PI * 2;
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
        body.position.y = Math.abs(sw) * 0.055;
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

    // Wing flutter, faster with speed, plus a flare when airborne.
    this._wingT += dtReal * (2.2 + play.speed * 0.10);
    const flare = play.state === STATE.AIR ? 0.55 : 0;
    this.parts.wing.rotation.y = -0.55 - flare + Math.sin(this._wingT) * 0.16;
    this.parts.wing.rotation.z = 0.22 + Math.sin(this._wingT * 1.3) * 0.10 - this._lean * 0.5;

    // Antenna whip: each segment lags the one before it.
    const whip = Math.sin(this.phase * 0.8) * 0.06 - this._lean * 0.35;
    for (let i = 0; i < this.parts.stalkSegs.length; i++) {
      const seg = this.parts.stalkSegs[i];
      seg.rotation.z = -0.14 + whip * (i + 1) * 0.6;
      seg.rotation.x = Math.sin(this._wingT * 0.7 + i) * 0.03 * (i + 1);
    }
  }

  dispose() {
    if (this.root) this.root.dispose(false, true);
  }
}
