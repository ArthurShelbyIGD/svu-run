// char/ — the player character: procedural mesh, joint hierarchy, animation.
//
// OWNERSHIP: this directory owns everything about how the runner looks and
// moves. It reads player state from play/ but never writes to it.
//
// Sprint 0 scope: a proportion blockout. The silhouette is the quality bar for
// this project, so it is worth establishing the proportions on day one even
// while the surfaces are still primitives — big head, bear-eared hood, mitten
// hands, boot feet, wing, antenna.
//
// No skeleton yet. Limbs are parented TransformNodes driven by a phase value,
// which is enough for a convincing run cycle and costs nothing.

import { MeshBuilder, TransformNode, Vector3 } from '../core/bjs.js';
import { STATE } from '../play/index.js';

// Proportions, in metres. These numbers ARE the character — change them
// carefully, they are what makes it read as the reference art.
// All values are HALF-extents for boxes, radii for spheres/capsules.
// Character stands ~1.6m. The head is deliberately ~55% of total height and
// the torso is small and stubby — that ratio is what makes it read as chibi
// rather than as a short adult. Getting this wrong is the single most visible
// mistake available in this file.
const P = {
  headR: 0.42,        // head radius — huge on purpose
  headY: 1.15,
  earR: 0.155,
  earSpread: 0.31,
  bodyW: 0.31, bodyH: 0.21, bodyD: 0.25,  // torso half-extents: small!
  bodyY: 0.62,
  armR: 0.085, armLen: 0.28,
  handR: 0.125,
  shoulderX: 0.30, shoulderY: 0.76,
  legR: 0.10, legLen: 0.20,
  bootR: 0.145,
  hipX: 0.145, hipY: 0.44,
  wingLen: 0.60,
  antennaLen: 0.34, orbR: 0.10,
};

export default class Character {
  constructor(ctx) {
    this.ctx = ctx;
    this.root = null;
    this.parts = {};
    this.phase = 0;
    this._lean = 0;
    this._squash = 1;
    this._w = [0, 0, 0];
  }

  init() {
    const scene = this.ctx.scene;
    const mat = this.ctx.get('mat');
    const q = this.ctx.config.q;
    const seg = q.name === 'low' ? 8 : 16;

    this.root = new TransformNode('charRoot', scene);
    const body = new TransformNode('charBody', scene);
    body.parent = this.root;
    this.parts.body = body;

    const sphere = (name, r, parent, material, scaleY = 1) => {
      const m = MeshBuilder.CreateSphere(name, { diameter: r * 2, segments: seg }, scene);
      m.material = material;
      m.parent = parent;
      m.isPickable = false;
      if (scaleY !== 1) m.scaling.y = scaleY;
      return m;
    };

    // --- torso: the hooded onesie ---
    const torso = MeshBuilder.CreateBox('torso', {
      width: P.bodyW * 2, height: P.bodyH * 2, depth: P.bodyD * 2,
    }, scene);
    torso.material = mat.get('whiteGold');
    torso.parent = body;
    torso.position.y = P.bodyY;
    torso.isPickable = false;
    this.parts.torso = torso;

    // --- head + hood ---
    const head = new TransformNode('head', scene);
    head.parent = body;
    head.position.y = P.headY;
    this.parts.head = head;

    this.parts.hood = sphere('hood', P.headR, head, mat.get('whiteGold'));
    // the face sits slightly proud of the hood, in warm metal
    const face = sphere('face', P.headR * 0.82, head, mat.get('roseGold'));
    face.position.z = P.headR * 0.30;
    this.parts.face = face;

    // bear ears
    for (const s of [-1, 1]) {
      const ear = sphere(`ear${s}`, P.earR, head, mat.get('whiteGold'));
      ear.position.set(s * P.earSpread, P.headR * 0.78, -0.04);
    }

    // --- antenna with ruby orb ---
    const stalk = MeshBuilder.CreateCylinder('stalk', {
      diameter: 0.035, height: P.antennaLen, tessellation: 6,
    }, scene);
    stalk.material = mat.get('whiteGold');
    stalk.parent = head;
    stalk.position.set(0.05, P.headR + P.antennaLen * 0.42, -0.12);
    stalk.rotation.z = -0.22;
    stalk.isPickable = false;
    const orb = sphere('orb', P.orbR, head, mat.get('ruby'));
    orb.position.set(0.13, P.headR + P.antennaLen * 0.90, -0.15);
    this.parts.orb = orb;

    // --- arms ---
    this.parts.arms = [];
    for (const s of [-1, 1]) {
      const pivot = new TransformNode(`armPivot${s}`, scene);
      pivot.parent = body;
      pivot.position.set(s * P.shoulderX, P.shoulderY, 0);

      const upper = MeshBuilder.CreateCapsule(`arm${s}`, {
        radius: P.armR, height: P.armLen, tessellation: seg / 2,
      }, scene);
      upper.material = mat.get('whiteGold');
      upper.parent = pivot;
      upper.position.y = -P.armLen * 0.5;
      upper.isPickable = false;

      const hand = sphere(`hand${s}`, P.handR, pivot, mat.get('rhodium'));
      hand.position.y = -P.armLen - P.handR * 0.4;

      this.parts.arms.push(pivot);
    }

    // --- legs ---
    this.parts.legs = [];
    for (const s of [-1, 1]) {
      const pivot = new TransformNode(`legPivot${s}`, scene);
      pivot.parent = body;
      pivot.position.set(s * P.hipX, P.hipY, 0);

      const upper = MeshBuilder.CreateCapsule(`leg${s}`, {
        radius: P.legR, height: P.legLen, tessellation: seg / 2,
      }, scene);
      upper.material = mat.get('whiteGold');
      upper.parent = pivot;
      upper.position.y = -P.legLen * 0.5;
      upper.isPickable = false;

      const boot = sphere(`boot${s}`, P.bootR, pivot, mat.get('rhodium'), 0.8);
      boot.position.set(0, -P.legLen - P.bootR * 0.5, 0.04);

      this.parts.legs.push(pivot);
    }

    // --- wing ---
    const wing = MeshBuilder.CreateBox('wing', {
      width: P.wingLen, height: 0.44, depth: 0.05,
    }, scene);
    wing.material = mat.get('darkChrome');
    wing.parent = body;
    wing.position.set(-P.bodyW - P.wingLen * 0.30, P.bodyY + 0.10, -P.bodyD * 0.75);
    wing.rotation.z = 0.34;
    wing.rotation.y = -0.45;
    wing.isPickable = false;
    this.parts.wing = wing;

    // shadow casting, if the preset allows it
    const world = this.ctx.tryGet('world');
    if (world) world.addCaster(this.root);
  }

  renderUpdate(dtReal) {
    const play = this.ctx.get('play');
    const T = this.ctx.config.tune;
    const body = this.parts.body;

    // The simulation works in path space; the character has to be drawn in
    // world space, and has to face along the path so corners look like turns
    // rather than the world sliding sideways underneath a fixed pose.
    const track = this.ctx.tryGet('track');
    if (track) {
      track.path.toWorld(play.z, play.x, play.y, this._w);
      this.root.position.set(this._w[0], this._w[1], this._w[2]);
      this.root.rotation.y = track.path.yawAt(play.z);
    } else {
      this.root.position.set(play.x, play.y, play.z);
    }

    // Stride frequency scales with speed so the feet don't skate.
    const strideHz = 1.05 + (play.speed / T.maxSpeed) * 1.35;
    if (play.state === STATE.RUN) {
      this.phase += dtReal * strideHz * Math.PI * 2;
    }
    const sw = Math.sin(this.phase);
    const swAlt = Math.sin(this.phase + Math.PI);

    switch (play.state) {
      case STATE.RUN: {
        this.parts.legs[0].rotation.x = sw * 0.85;
        this.parts.legs[1].rotation.x = swAlt * 0.85;
        this.parts.arms[0].rotation.x = swAlt * 0.62;
        this.parts.arms[1].rotation.x = sw * 0.62;
        // vertical bob at twice stride frequency — the classic run bounce
        body.position.y = Math.abs(Math.sin(this.phase)) * 0.055;
        body.rotation.x = 0.10;
        this._squash = 1;
        break;
      }
      case STATE.AIR: {
        const rise = play.vy > 0;
        this.parts.legs[0].rotation.x = rise ? -0.55 : 0.35;
        this.parts.legs[1].rotation.x = rise ? -0.25 : 0.60;
        this.parts.arms[0].rotation.x = rise ? -1.30 : -0.45;
        this.parts.arms[1].rotation.x = rise ? -1.30 : -0.45;
        body.position.y = 0;
        body.rotation.x = rise ? -0.14 : 0.20;
        break;
      }
      case STATE.SLIDE: {
        this.parts.legs[0].rotation.x = 1.25;
        this.parts.legs[1].rotation.x = 1.05;
        this.parts.arms[0].rotation.x = -0.9;
        this.parts.arms[1].rotation.x = -0.7;
        body.position.y = -0.30;
        body.rotation.x = 0.95;
        break;
      }
      default: {
        body.rotation.x = 0.1;
        break;
      }
    }

    // Lean into lane changes. Reads as weight and costs one lerp.
    const wantLean = (play.x - this.root.position.x) * 0 +
      (play.laneT < 1 ? (play.laneTarget - play.lane) * -0.30 : 0);
    this._lean += (wantLean - this._lean) * Math.min(1, dtReal * 12);
    body.rotation.z = this._lean;

    // Wing trails the motion slightly — cheap secondary animation.
    this.parts.wing.rotation.y = Math.sin(this.phase * 0.5) * 0.12 - this._lean * 0.8;

    // Antenna orb wobble.
    this.parts.orb.position.x = 0.13 + Math.sin(this.phase * 0.75) * 0.030;
  }

  dispose() {
    if (this.root) this.root.dispose(false, true);
  }
}
