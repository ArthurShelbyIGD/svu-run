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

import { MeshBuilder } from '../core/bjs.js';
import { EV } from '../core/ctx.js';

const KIND = {
  SPARK: 0,   // star pickup — gold, rises and fades
  DUST: 1,    // landing — low, spreads outward
  SHARD: 2,   // death — fast, scatters
  STREAK: 3,  // speed — long thin, streams past the camera
};

const GRAVITY = -13.5;

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
    this._offs.push(this.ctx.on(EV.RUN_START, () => this.clear()));
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

    let alive = 0;
    const dt = Math.min(dtReal, 0.05); // a long frame must not fling particles

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
