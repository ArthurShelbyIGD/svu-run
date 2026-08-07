// fx/ — particles and screen feel.
//
// OWNERSHIP: this directory owns every transient visual effect. It listens to
// events and never drives gameplay.
//
// Implementation note: this is a hand-rolled pooled system on thin instances
// rather than Babylon's ParticleSystem. Reasons, in order of importance:
//
//   1. One draw call for every particle in the game, regardless of type.
//   2. Zero allocation at runtime — the matrix buffer is created once at init
//      and rewritten in place, which matters more on mobile than the particle
//      count itself does.
//   3. The quality preset can shrink the pool without any other code changing.
//
// Particles are axis-aligned scaled solids written straight into a 4x4 matrix
// buffer. No rotation, because building a rotation matrix per particle per
// frame costs more than it buys at this size on screen.
//
// ---------------------------------------------------------------------------
// NEAR MISSES. This module DETECTS them and draws nothing for them. It
// publishes `nearMissSeq` (monotonic) and `nearMissSide` (-1 the hazard went
// past on the left, +1 on the right, 0 straight over or under); ui/ polls the
// sequence and draws the flash.
//
// That split is deliberate and it is a measured result, not a preference. A
// near-miss cue drawn as a wide soft screen wash is INVISIBLE against a black
// hall — 22vw at 0.22 alpha reads as nothing at all, where a 2px hairline plus
// a short glow reads immediately. A hairline is a DOM element, so it belongs
// to ui/; the detection belongs here because this module already walks the
// obstacle list every frame.
//
// The other half of the same lesson: NEVER OBSCURE THE TRACK. There are
// deliberately no particles on a near miss. The player is mid-commitment when
// one happens and anything sprayed in front of the camera at that moment costs
// them the obstacle after it.
//
// Detection runs in renderUpdate and touches only fields this module owns, so
// it cannot perturb the simulation. It uses NO ctx.rng: every angle it needs is
// derived from a counter, because a presentation-side draw from the simulation
// RNG would make the same seed produce different runs at different frame rates.

import { MeshBuilder } from '../core/bjs.js';
import { EV } from '../core/ctx.js';

const KIND = {
  SPARK: 0,   // star pickup — gold, rises and fades
  DUST: 1,    // landing — low, spreads outward
  SHARD: 2,   // death — fast, scatters
  STREAK: 3,  // speed — long thin, streams past the camera
};

const GRAVITY = -13.5;

/** Lateral clearance, in metres beyond the hit box, that counts as "close". */
const NEAR_LATERAL = 0.55;
/** Vertical clearance over or under an obstacle that counts as "close". */
const NEAR_VERTICAL = 0.30;
/** Minimum gap between reported near misses, so a cluster reads as one beat. */
const NEAR_COOLDOWN = 0.35;
/** Distance between milestone flourishes, in metres. Matches ui/'s toast. */
const MILESTONE_EVERY = 500;

export default class Fx {
  constructor(ctx) {
    this.ctx = ctx;
    this.proto = null;
    this.count = 0;
    this.alive = 0;

    // Structure-of-arrays. One typed array per attribute beats an array of
    // objects here: no pointer chasing, and no per-particle object to allocate.
    this.px = null; this.py = null; this.pz = null;
    this.vx = null; this.vy = null; this.vz = null;
    this.life = null; this.maxLife = null; this.size = null; this.kind = null;

    this._buf = null;
    this._offs = [];
    this._w = [0, 0, 0];
    this._streakTimer = 0;
    this._cursor = 0;

    // ---- near miss (published; ui/ polls these) ----
    /** Increments once per reported near miss. Never decreases within a run. */
    this.nearMissSeq = 0;
    /** Which side the hazard went past on: -1 left, +1 right, 0 over/under. */
    this.nearMissSide = 0;
    this._nmPrevZ = 0;
    this._nmCool = 0;

    // ---- milestones ----
    this._milestone = 0;
  }

  init() {
    const q = this.ctx.config.q;
    const scene = this.ctx.scene;
    this.count = q.maxParticles;

    this.px = new Float32Array(this.count);
    this.py = new Float32Array(this.count);
    this.pz = new Float32Array(this.count);
    this.vx = new Float32Array(this.count);
    this.vy = new Float32Array(this.count);
    this.vz = new Float32Array(this.count);
    this.life = new Float32Array(this.count);
    this.maxLife = new Float32Array(this.count);
    this.size = new Float32Array(this.count);
    this.kind = new Uint8Array(this.count);

    // An octahedron reads as a spark, a chip of metal, or a mote of dust
    // depending only on its scale and context — one prototype covers every
    // effect in the game.
    this.proto = MeshBuilder.CreatePolyhedron('fxP', { type: 1, size: 0.5 }, scene);
    this.proto.material = this.ctx.get('mat').get('signGold');
    this.proto.isPickable = false;
    this.proto.alwaysSelectAsActiveMesh = true;
    this.proto.doNotSyncBoundingInfo = true;
    this.proto.applyFog = false;

    this._buf = new Float32Array(this.count * 16);
    for (let i = 0; i < this.count; i++) this._writeMatrix(i, 0, -9999, 0, 0);
    this.proto.thinInstanceSetBuffer('matrix', this._buf, 16, false);

    this._offs.push(this.ctx.on(EV.PICKUP_STAR, (p) => this.burstStar(p)));
    this._offs.push(this.ctx.on(EV.PLAYER_LAND, (p) => this.burstLand(p)));
    this._offs.push(this.ctx.on(EV.PLAYER_DEATH, () => this.burstDeath()));
    this._offs.push(this.ctx.on(EV.PLAYER_TURN, () => this.burstTurn()));
    this._offs.push(this.ctx.on(EV.RUN_START, () => {
      this.clear();
      this._nmPrevZ = 0;
      this._nmCool = 0;
      this._milestone = 0;
    }));
  }

  clear() {
    for (let i = 0; i < this.count; i++) {
      this.life[i] = 0;
      this._writeMatrix(i, 0, -9999, 0, 0);
    }
    this.alive = 0;
    if (this.proto) this.proto.thinInstanceBufferUpdated('matrix');
  }

  /**
   * Claim a slot. Scans forward from a rolling cursor rather than from zero,
   * so spawning stays O(1) amortised instead of O(n) per particle during a
   * burst. Falls back to overwriting the oldest, so a burst always shows
   * rather than being silently dropped when the pool is full.
   */
  _spawn(x, y, z, vx, vy, vz, size, life, kind) {
    let idx = -1;
    for (let n = 0; n < this.count; n++) {
      const i = (this._cursor + n) % this.count;
      if (this.life[i] <= 0) { idx = i; this._cursor = (i + 1) % this.count; break; }
    }
    if (idx < 0) {
      let worst = Infinity;
      for (let i = 0; i < this.count; i++) {
        if (this.life[i] < worst) { worst = this.life[i]; idx = i; }
      }
    }
    this.px[idx] = x; this.py[idx] = y; this.pz[idx] = z;
    this.vx[idx] = vx; this.vy[idx] = vy; this.vz[idx] = vz;
    this.size[idx] = size;
    this.life[idx] = life;
    this.maxLife[idx] = life;
    this.kind[idx] = kind;
  }

  // ---- emitters --------------------------------------------------------

  /** Gold burst where a star was collected. */
  burstStar(p) {
    const track = this.ctx.tryGet('track');
    if (!track) return;
    track.path.toWorld(p.z, p.x, p.y, this._w);
    const rng = this.ctx.rng;
    const n = this.ctx.config.q.name === 'low' ? 5 : 9;
    for (let i = 0; i < n; i++) {
      const a = (i / n) * Math.PI * 2 + rng.range(-0.3, 0.3);
      const sp = rng.range(1.6, 3.4);
      this._spawn(
        this._w[0], this._w[1], this._w[2],
        Math.cos(a) * sp, rng.range(1.8, 4.2), Math.sin(a) * sp,
        rng.range(0.10, 0.19), rng.range(0.34, 0.58), KIND.SPARK,
      );
    }
  }

  /** Puff at the feet on landing. Harder landings throw more. */
  burstLand(p) {
    const play = this.ctx.get('play');
    const track = this.ctx.tryGet('track');
    if (!track) return;
    track.path.toWorld(play.z, play.x, 0.06, this._w);
    const rng = this.ctx.rng;
    const n = (p && p.hard) ? 8 : 4;
    for (let i = 0; i < n; i++) {
      const a = rng.range(0, Math.PI * 2);
      const sp = rng.range(1.0, 2.6);
      this._spawn(
        this._w[0], this._w[1], this._w[2],
        Math.cos(a) * sp, rng.range(0.4, 1.5), Math.sin(a) * sp,
        rng.range(0.07, 0.13), rng.range(0.22, 0.40), KIND.DUST,
      );
    }
  }

  /** Scatter on death. */
  burstDeath() {
    const play = this.ctx.get('play');
    const track = this.ctx.tryGet('track');
    if (!track) return;
    track.path.toWorld(play.z, play.x, 0.9, this._w);
    const rng = this.ctx.rng;
    const n = this.ctx.config.q.name === 'low' ? 10 : 18;
    for (let i = 0; i < n; i++) {
      const a = rng.range(0, Math.PI * 2);
      const sp = rng.range(2.0, 6.5);
      this._spawn(
        this._w[0], this._w[1], this._w[2],
        Math.cos(a) * sp, rng.range(1.5, 6.0), Math.sin(a) * sp - 2.0,
        rng.range(0.09, 0.22), rng.range(0.55, 1.0), KIND.SHARD,
      );
    }
  }

  /** A small flourish when a corner is taken cleanly. */
  burstTurn() {
    const play = this.ctx.get('play');
    const track = this.ctx.tryGet('track');
    if (!track) return;
    track.path.toWorld(play.z, play.x, 0.5, this._w);
    const rng = this.ctx.rng;
    for (let i = 0; i < 6; i++) {
      this._spawn(
        this._w[0], this._w[1], this._w[2],
        rng.range(-2.5, 2.5), rng.range(1.0, 3.0), rng.range(-2.5, 2.5),
        rng.range(0.08, 0.15), rng.range(0.3, 0.5), KIND.SPARK,
      );
    }
  }

  /**
   * A milestone flourish: a flat ring of sparks thrown outward at ankle
   * height. Deliberately LOW and WIDE rather than tall and central — the
   * player is still running and the metre of screen above the track is the
   * only place the next obstacle can appear.
   *
   * Angles come from a counter, not from ctx.rng. See the header.
   */
  burstMilestone() {
    const track = this.ctx.tryGet('track');
    const play = this.ctx.tryGet('play');
    if (!track || !play) return;
    if (this.ctx.config.q.name === 'low') return;  // pure garnish; low holds 60
    track.path.toWorld(play.z, play.x, 0.10, this._w);
    const n = 10;
    for (let i = 0; i < n; i++) {
      const a = (i / n) * Math.PI * 2 + this._milestone * 0.31;
      this._spawn(
        this._w[0], this._w[1], this._w[2],
        Math.cos(a) * 4.2, 0.9 + (i & 1) * 0.5, Math.sin(a) * 4.2,
        0.11, 0.52, KIND.SPARK,
      );
    }
  }

  /**
   * Report near misses. See the header for why nothing is drawn here.
   *
   * The test mirrors coll/'s hit test exactly — same `track.sizeOf`, same
   * `playerRadius` — and then asks how much room was left. Anything else
   * drifts out of agreement with what actually kills you, and a near-miss cue
   * that fires where there was no danger is worse than none.
   */
  _nearMiss(dt, play, track) {
    if (this._nmCool > 0) this._nmCool -= dt;
    const z1 = play.z;
    const z0 = this._nmPrevZ;
    this._nmPrevZ = z1;
    if (!play.alive || z1 <= z0 || this._nmCool > 0) return;
    if (typeof track.sizeOf !== 'function') return;

    const T = this.ctx.config.tune;
    const pr = T.playerRadius;
    const px = play.x;
    const py0 = play.y;
    const py1 = play.y + play.collisionHeight;
    const obs = track.obstacles;

    for (let i = 0; i < obs.length; i++) {
      const o = obs[i];
      if (o.z <= z0) continue;
      if (o.z > z1) break;                 // z-sorted; nothing further passed us
      const s = track.sizeOf(o.kind);
      const lat = Math.abs(px - o.x) - (pr + s.hx);
      let side = 2;                        // 2 == not a near miss
      if (lat >= 0) {
        if (lat < NEAR_LATERAL) side = o.x > px ? 1 : -1;
      } else {
        // Laterally overlapping, so it was cleared vertically. How narrowly?
        const oy0 = s.cy - s.hy;
        const oy1 = s.cy + s.hy;
        const v = py0 >= oy1 ? py0 - oy1 : oy0 - py1;
        if (v >= 0 && v < NEAR_VERTICAL) side = 0;
      }
      if (side === 2) continue;
      this.nearMissSide = side;
      this.nearMissSeq++;
      this._nmCool = NEAR_COOLDOWN;
      return;
    }
  }

  // ---- update ----------------------------------------------------------

  renderUpdate(dtReal) {
    const play = this.ctx.tryGet('play');
    const track = this.ctx.tryGet('track');
    if (!track || !this.proto) return;

    // Speed streaks: only once genuinely fast, and never on 'low', since they
    // are pure garnish and low is the preset that has to hold 60fps.
    if (play && play.alive && this.ctx.config.q.name !== 'low') {
      const T = this.ctx.config.tune;
      const t = (play.speed - T.startSpeed) / (T.maxSpeed - T.startSpeed);
      if (t > 0.35) {
        this._streakTimer -= dtReal;
        if (this._streakTimer <= 0) {
          this._streakTimer = 0.05 / t;
          const rng = this.ctx.rng;
          track.path.toWorld(
            play.z + rng.range(14, 26), rng.range(-5.5, 5.5), rng.range(0.6, 3.6), this._w,
          );
          this._spawn(
            this._w[0], this._w[1], this._w[2], 0, 0, 0,
            rng.range(0.05, 0.10), rng.range(0.22, 0.36), KIND.STREAK,
          );
        }
      }
    }

    const dt = Math.min(dtReal, 0.05); // a long frame must not fling particles

    if (play) {
      this._nearMiss(dt, play, track);
      if (play.alive) {
        const step = (play.z / MILESTONE_EVERY) | 0;
        if (step > this._milestone) {
          this._milestone = step;
          this.burstMilestone();
        }
      }
    }

    let alive = 0;

    for (let i = 0; i < this.count; i++) {
      if (this.life[i] <= 0) continue;

      this.life[i] -= dt;
      if (this.life[i] <= 0) {
        this._writeMatrix(i, 0, -9999, 0, 0);
        continue;
      }
      alive++;

      const k = this.kind[i];
      if (k !== KIND.STREAK) {
        this.vy[i] += GRAVITY * dt;
        this.px[i] += this.vx[i] * dt;
        this.py[i] += this.vy[i] * dt;
        this.pz[i] += this.vz[i] * dt;
        if (this.py[i] < 0.03) {
          this.py[i] = 0.03;
          this.vy[i] *= -0.32;         // a little bounce, then settle
          this.vx[i] *= 0.6;
          this.vz[i] *= 0.6;
        }
      }

      // Shrink to nothing rather than fading out: these are opaque metal
      // chips, and scaling away reads as "flew off" where alpha reads as
      // "ghost". It is also free, where alpha blending is not.
      const t = this.life[i] / this.maxLife[i];
      const scale = this.size[i] * (k === KIND.STREAK ? 1 : t * (2 - t));
      this._writeMatrix(
        i, this.px[i], this.py[i], this.pz[i], scale,
        k === KIND.STREAK ? 7.5 : 1,
      );
    }

    this.alive = alive;
    this.proto.thinInstanceBufferUpdated('matrix');
  }

  /** Write a scale+translate matrix directly. No Matrix maths, no allocation. */
  _writeMatrix(i, x, y, z, s, stretchZ = 1) {
    const b = this._buf;
    const o = i * 16;
    b[o] = s;      b[o + 1] = 0;  b[o + 2] = 0;             b[o + 3] = 0;
    b[o + 4] = 0;  b[o + 5] = s;  b[o + 6] = 0;             b[o + 7] = 0;
    b[o + 8] = 0;  b[o + 9] = 0;  b[o + 10] = s * stretchZ; b[o + 11] = 0;
    b[o + 12] = x; b[o + 13] = y; b[o + 14] = z;            b[o + 15] = 1;
  }

  dispose() {
    for (const off of this._offs) off();
    this._offs.length = 0;
    if (this.proto) this.proto.dispose();
  }
}

export { KIND };
