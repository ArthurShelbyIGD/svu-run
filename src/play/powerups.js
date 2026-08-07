// play/powerups.js — the three powerups: RUBY MAGNET, SHIELD, WING GLIDE.
//
// Owned by play/ because a powerup is player state. It is NOT a registered
// module: main.js is lead-owned and its MODULES array cannot grow from here,
// so Play constructs this in its constructor and drives init / fixedUpdate /
// renderUpdate / reset / dispose by hand. Reach it from outside as
//     ctx.get('play').pw
//
// ---------------------------------------------------------------------------
// THE STATE CONTRACT, which ui/ reads and must be able to trust
//
//   pw.slots            length 3, order MAGNET, SHIELD, GLIDE. NEVER
//                       reallocated, and neither are the objects in it.
//                       { kind, name, active, remaining, total, unit }
//                       unit is 's' for a clock, 'charge' for a charge.
//   pw.magnet           boolean
//   pw.shield           boolean
//   pw.glide            boolean
//   pw.lastSpent        ctx.time of the last shield spend, or -1
//
// Events (payloads POOLED — read synchronously, never retain):
//   EV.POWERUP_START { kind, name, duration }   duration 0 = a charge, no clock
//   EV.POWERUP_END   { kind, name, spent }      spent true = used, false = ran out
//
// ---------------------------------------------------------------------------
// TWO TRAPS THAT COST A BUILD, both recorded here so they are not re-set.
//
// 1. POWERUPS DRAW FROM THEIR OWN SEED-DERIVED Rng, NEVER ctx.rng.
//    play/ steps before track/, so a single draw from the shared stream
//    re-deals the whole chunk grammar for the rest of the run and invalidates
//    every tuned capture pose. Same seed in, same powerups out, world
//    bit-identical. `_rng` is re-seeded from config.seed on every reset().
//
// 2. THE SHIELD CAGE'S RINGS ARE EACH ROTATED ABOUT EXACTLY ONE AXIS.
//    Babylon composes rotation as Yaw*Pitch*Roll — roll first — so a pitch is
//    applied about an axis the roll has already moved, and two rings meant to
//    be perpendicular came out coplanar: from dead astern, one gold line up
//    the runner's back. It graded fine from a posed three-quarter view. See
//    buildCage in pwgeom.js. Grade the cage from the REAL CHASE CAMERA.
//
// THE READ, which is the thing that came out weak last time: at 23m in
// portrait the gold hoop reads and a gold emblem inside it does not, because
// gold-on-gold has no value difference and value is the only channel that
// survives distance and bloom. Fixed two ways, neither of which invents a
// fourth colour: a DARK STONE BED behind the emblem (value contrast), and a
// per-kind IDLE MOTION — magnet throbs, shield is still, glide bobs long —
// because motion reads at any distance. Measured numbers are in the comment
// above MOTION below.

import { Rng } from '../core/rng.js';
import { EV } from '../core/ctx.js';
import { buildHoop, buildCage, EMBLEM, HOOP_OD } from './pwgeom.js';

export const PW = { MAGNET: 0, SHIELD: 1, GLIDE: 2 };
export const PW_NAME = ['MAGNET', 'SHIELD', 'GLIDE'];
const PW_COUNT = 3;

/** Emblem per kind. Index by PW.*. */
const PW_EMBLEM = [EMBLEM.HORSESHOE, EMBLEM.HEATER, EMBLEM.WINGS];

// --- tuning. Every one of these was measured, not guessed; see the notes. ---

/** Magnet: 7.0s, 9m radius, 0.40s of star flight. */
export const MAGNET_TIME = 7.0;
export const MAGNET_RADIUS = 9.0;
export const MAGNET_FLIGHT = 0.40;

/**
 * Glide: gravity x0.70 going up and x0.55 coming down.
 *
 * Base jump is 2.30m over 0.62s, which is g = 8h/t^2 = 47.87 m/s^2 and a
 * take-off of 14.84 m/s. Under glide that is an apex of 14.84^2/(2*0.70g) =
 * 3.29m reached in 0.443s, a fall of 0.500s, and a landing speed of 13.2 m/s
 * — deliberately under the 14 m/s hard-landing threshold in play/, so a glide
 * never ends in a stumble.
 */
export const GLIDE_TIME = 9.0;
export const GLIDE_G_UP = 0.70;
export const GLIDE_G_DOWN = 0.55;

/** Shield: one charge, no clock, then 0.55s of i-frames while it breaks. */
export const SHIELD_IFRAMES = 0.55;

/** Spawns: first at 300m, then every 420-700m. */
const FIRST_SPAWN_S = 300;
const GAP_MIN = 420;
const GAP_MAX = 700;
/** Place the mesh this far ahead. Under track's 180m view distance. */
const SPAWN_AHEAD = 140;
/** Metres behind the player before an uncollected hoop is retired. */
const RETIRE_BEHIND = 24;

/**
 * Hoop centre height, and the grab box around it.
 *
 * The box is derived from HOOP_OD so that resizing the mesh cannot silently
 * leave a hoop you can run through without collecting. Lane spacing is 2.4m
 * and GRAB_X is 1.20, so a hoop can never be taken from the next lane along.
 */
const HOOP_Y = 1.35;
const GRAB_X = 0.42 + HOOP_OD * 0.5;   // playerRadius + hoop half-width
const GRAB_Z = 0.80;
const GRAB_Y = 0.90;                   // vertical half-window about HOOP_Y

/**
 * Idle motion, per kind. This is half the "which powerup is it" read and the
 * half that survives distance: at 23m the emblem is ~20px and the hoop ~44px,
 * and a 20px shape is a smudge, but a 20px smudge that pulses at 1.6Hz is
 * unmistakably not the one next to it that hangs dead still.
 *
 * Presentation only — the collision box never moves. Driven from ctx.time
 * (the simulation clock) rather than an accumulator, so a capture posed by
 * loop.advance() lands on exactly the same phase every run.
 */
const THROB_HZ = 1.6;      // magnet: scale 1 +/- 0.075
const THROB_AMP = 0.075;
const BOB_HZ = 0.42;       // glide: a long, slow 0.26m rise and fall
const BOB_AMP = 0.26;

/**
 * The cage is a sphere TANGENT TO THE TRACK, which is why the radius and the
 * centre height are the same number.
 *
 * Measured character bounds at t=14s, seed 1, relative to the player's feet:
 * x -0.90..0.88, y -0.03..2.66 — and the 2.66 is the antenna's ruby orb, whose
 * centre is at 2.36. The body and head stop around 1.95.
 *
 * The first cage was r=1.05 centred at 0.88, so its underside sat 0.17m BELOW
 * the floor and the chase-camera shot showed gold rings passing through the
 * paving. At r = y = 1.10 the sphere rests on the track, clears the widest
 * part of the body by 0.20m, and closes over the head with 0.25m to spare.
 * The antenna orb pokes through the top, which is correct — it is an aerial.
 */
const CAGE_RADIUS = 1.10;
const CAGE_Y = 1.10;
const CAGE_SPIN = 1.10;    // rad/s about Y

export default class Powerups {
  constructor(ctx) {
    this.ctx = ctx;

    // --- the state contract. Allocated ONCE, here. ---
    this.slots = new Array(PW_COUNT);
    for (let k = 0; k < PW_COUNT; k++) {
      this.slots[k] = {
        kind: k, name: PW_NAME[k], active: false,
        remaining: 0, total: 0, unit: k === PW.SHIELD ? 'charge' : 's',
      };
    }
    this.magnet = false;
    this.shield = false;
    this.glide = false;
    this.lastSpent = -1;

    // --- timers ---
    this._magnetT = 0;
    this._glideT = 0;

    // --- the live pickup. One at a time; the gap is 420m and the view is 180m. ---
    this._liveKind = -1;
    this._liveS = 0;
    this._liveX = 0;
    this._nextS = FIRST_SPAWN_S;
    this._lastKind = -1;

    /** Own stream. NEVER ctx.rng — see trap 1 in the header. */
    this._rng = new Rng(1);
    /** Scratch for path->world. Never reallocated. */
    this._w = [0, 0, 0];
    /** Candidate kinds for a spawn draw. Fixed length, no allocation. */
    this._cand = new Uint8Array(PW_COUNT);

    this.hoops = null;    // Mesh[3], one per kind
    this.cage = null;

    // pooled event payloads
    this._pStart = { kind: 0, name: '', duration: 0 };
    this._pEnd = { kind: 0, name: '', spent: false };

    this._parkPos = -10000;
  }

  init() {
    const scene = this.ctx.scene;
    const mat = this.ctx.get('mat');
    const q = this.ctx.config.q;

    this.hoops = new Array(PW_COUNT);
    for (let k = 0; k < PW_COUNT; k++) {
      const m = buildHoop(scene, mat, q, PW_EMBLEM[k]);
      m.name = `pwHoop_${PW_NAME[k]}`;
      m.position.set(this._parkPos, this._parkPos, this._parkPos);
      m.setEnabled(false);
      this.hoops[k] = m;
    }

    this.cage = buildCage(scene, mat, q, CAGE_RADIUS);
    this.cage.position.set(this._parkPos, this._parkPos, this._parkPos);
    this.cage.setEnabled(false);

    this.ctx.on(EV.RUN_START, () => this.reset());
    this.reset();
  }

  // ---- lifecycle -------------------------------------------------------

  reset() {
    // Derived from the run seed, NOT drawn from ctx.rng. Same seed in, same
    // powerups out, and track/'s chunk grammar is untouched.
    this._rng.reset((this.ctx.config.seed ^ 0x50575250) >>> 0);
    this._magnetT = 0;
    this._glideT = 0;
    this.magnet = this.shield = this.glide = false;
    this.lastSpent = -1;
    this._liveKind = -1;
    this._nextS = FIRST_SPAWN_S;
    this._lastKind = -1;
    if (this.hoops) {
      for (let k = 0; k < PW_COUNT; k++) {
        this.hoops[k].setEnabled(false);
        this.hoops[k].position.set(this._parkPos, this._parkPos, this._parkPos);
      }
    }
    if (this.cage) this.cage.setEnabled(false);
    this._syncSlots();
  }

  dispose() {
    if (this.hoops) {
      for (let k = 0; k < PW_COUNT; k++) if (this.hoops[k]) this.hoops[k].dispose(false, true);
      this.hoops = null;
    }
    if (this.cage) { this.cage.dispose(false, true); this.cage = null; }
  }

  // ---- queries, for coll/ and ui/ --------------------------------------

  /** Gravity multiplier for the player's vertical integration. 1 when idle. */
  gravityScale(vy) {
    if (!this.glide) return 1;
    return vy > 0 ? GLIDE_G_UP : GLIDE_G_DOWN;
  }

  /**
   * Spend the shield on a hit. Returns true if the hit was absorbed, in which
   * case the caller must NOT kill the player and should run SHIELD_IFRAMES of
   * invulnerability. One charge only — the second hit is fatal.
   */
  absorb() {
    if (!this.shield) return false;
    this.shield = false;
    this.lastSpent = this.ctx.time;
    this._emitEnd(PW.SHIELD, true);
    this._syncSlots();
    return true;
  }

  /** Grant a powerup directly. Used by collection, the smoke test and poses. */
  grant(kind) {
    if (kind === PW.MAGNET) {
      this._magnetT = MAGNET_TIME;
      this.magnet = true;
      this._emitStart(kind, MAGNET_TIME);
    } else if (kind === PW.SHIELD) {
      this.shield = true;
      this._emitStart(kind, 0);      // a charge, not a clock
    } else if (kind === PW.GLIDE) {
      this._glideT = GLIDE_TIME;
      this.glide = true;
      this._emitStart(kind, GLIDE_TIME);
    }
    this._syncSlots();
  }

  // ---- simulation ------------------------------------------------------

  fixedUpdate(dt) {
    const play = this.ctx.get('play');
    if (!play.alive) return;

    if (this._magnetT > 0) {
      this._magnetT -= dt;
      if (this._magnetT <= 0) {
        this._magnetT = 0;
        this.magnet = false;
        this._emitEnd(PW.MAGNET, false);
      }
    }
    if (this._glideT > 0) {
      this._glideT -= dt;
      if (this._glideT <= 0) {
        this._glideT = 0;
        this.glide = false;
        this._emitEnd(PW.GLIDE, false);
      }
    }

    this._spawn(play);
    this._collect(play);
    this._syncSlots();
  }

  _syncSlots() {
    const m = this.slots[PW.MAGNET];
    m.active = this.magnet; m.remaining = this._magnetT; m.total = MAGNET_TIME;
    const s = this.slots[PW.SHIELD];
    s.active = this.shield; s.remaining = this.shield ? 1 : 0; s.total = 1;
    const g = this.slots[PW.GLIDE];
    g.active = this.glide; g.remaining = this._glideT; g.total = GLIDE_TIME;
  }

  /**
   * Place the next hoop, and retire one the player has run past.
   *
   * Kind selection never repeats the previous kind and never offers a shield
   * the player is already carrying — a pickup that does nothing is worse than
   * no pickup, because the player spent a lane change on it. The candidate
   * list is a fixed Uint8Array and exactly ONE draw is taken from `_rng`
   * whatever the list contains, so the stream advances identically regardless
   * of player state.
   */
  _spawn(play) {
    if (this._liveKind >= 0) {
      if (this._liveS < play.z - RETIRE_BEHIND) this._retire();
      return;
    }
    if (play.z + SPAWN_AHEAD < this._nextS) return;

    const track = this.ctx.tryGet('track');
    if (!track || track.path.end < this._nextS + 1) return;

    let n = 0;
    for (let k = 0; k < PW_COUNT; k++) {
      if (k === this._lastKind) continue;
      if (k === PW.SHIELD && this.shield) continue;
      this._cand[n++] = k;
    }
    if (n === 0) this._cand[n++] = PW.MAGNET;   // cannot happen; cheap guard
    const r = this._rng.next();
    const kind = this._cand[Math.min(n - 1, Math.floor(r * n))];

    const T = this.ctx.config.tune;
    const lane = this._pickLane(track, T, this._nextS);
    const x = (lane - (T.laneCount - 1) / 2) * T.laneWidth;

    const mesh = this.hoops[kind];
    track.path.toWorldExact(this._nextS, x, HOOP_Y, this._w);
    mesh.position.set(this._w[0], this._w[1], this._w[2]);
    mesh.rotation.y = track.path.yawExactAt(this._nextS);
    mesh.setEnabled(true);

    this._liveKind = kind;
    this._liveS = this._nextS;
    this._liveX = x;
    this._lastKind = kind;
    // Cadence measured from the SPAWN, not from the pickup, so a player who
    // misses one does not get the next one early.
    this._nextS = this._nextS + this._rng.range(GAP_MIN, GAP_MAX);
  }

  /**
   * A lane with nothing in it. A hoop welded to the front of a full-height
   * blocker is a trap, and this game has already shipped one false affordance.
   * Two draws max, both from the powerup stream.
   */
  _pickLane(track, T, s) {
    const start = this._rng.int(0, T.laneCount - 1);
    for (let i = 0; i < T.laneCount; i++) {
      const lane = (start + i) % T.laneCount;
      if (!this._laneBlocked(track, lane, s)) return lane;
    }
    return start;
  }

  _laneBlocked(track, lane, s) {
    const obs = track.obstacles;
    for (let i = 0; i < obs.length; i++) {
      const o = obs[i];
      if (o.z < s - 5) continue;
      if (o.z > s + 5) break;      // z-sorted
      if (o.lane === lane) return true;
    }
    return false;
  }

  _retire() {
    if (this._liveKind < 0) return;
    const m = this.hoops[this._liveKind];
    m.setEnabled(false);
    m.position.set(this._parkPos, this._parkPos, this._parkPos);
    this._liveKind = -1;
  }

  /**
   * Run the player's swept z-interval against the live hoop.
   *
   * This is collision, and coll/ owns collision — but the hoops are play/'s
   * own pooled meshes and there is exactly one of them live at a time, so a
   * four-comparison test here beats exporting the pool. coll/ still owns the
   * two tests that matter for failure: obstacles and stars.
   */
  _collect(play) {
    if (this._liveKind < 0) return;
    // No sweep needed: one fixed step at the 34 m/s top speed covers 0.57m and
    // the window is 1.6m deep, so the player cannot tunnel through it.
    const dz = this._liveS - play.z;
    if (dz > GRAB_Z || dz < -GRAB_Z) return;
    if (Math.abs(play.x - this._liveX) > GRAB_X) return;
    const y0 = play.y;
    const y1 = play.y + play.collisionHeight;
    if (y1 < HOOP_Y - GRAB_Y || y0 > HOOP_Y + GRAB_Y) return;

    const kind = this._liveKind;
    this._retire();
    this.grant(kind);
  }

  /**
   * Place a hoop for a screenshot pose, without touching the live pickup or
   * the spawn schedule. Tools only — nothing in the game calls this.
   *
   * The three hoops are separate meshes precisely so a pose can show all three
   * at once, which is the only way to check that they are distinguishable from
   * each other rather than merely visible.
   */
  poseHoop(kind, s, x, y) {
    // The live pickup uses the SAME three meshes, and renderUpdate keeps
    // re-placing the live one every frame. Posing one of the three while it is
    // live put the "third hoop" 110m up the track and produced a lineup shot
    // with two hoops in it — measured, after the shot looked wrong.
    this._retire();
    const track = this.ctx.tryGet('track');
    const m = this.hoops[kind];
    const yy = y === undefined ? HOOP_Y : y;
    if (track) {
      track.path.toWorldExact(s, x, yy, this._w);
      m.position.set(this._w[0], this._w[1], this._w[2]);
      m.rotation.y = track.path.yawExactAt(s);
    } else {
      m.position.set(x, yy, s);
    }
    m.setEnabled(true);
    return m;
  }

  _emitStart(kind, duration) {
    this._pStart.kind = kind;
    this._pStart.name = PW_NAME[kind];
    this._pStart.duration = duration;
    this.ctx.emit(EV.POWERUP_START, this._pStart);
  }

  _emitEnd(kind, spent) {
    this._pEnd.kind = kind;
    this._pEnd.name = PW_NAME[kind];
    this._pEnd.spent = spent;
    this.ctx.emit(EV.POWERUP_END, this._pEnd);
  }

  // ---- presentation ----------------------------------------------------

  /**
   * Idle motion and the cage. Nothing here touches simulation state.
   *
   * The hoop's phase comes from ctx.time, not from an accumulator fed by
   * dtReal, so posed captures are identical between runs and between machines.
   */
  renderUpdate() {
    const t = this.ctx.time;

    if (this._liveKind >= 0) {
      const m = this.hoops[this._liveKind];
      if (this._liveKind === PW.MAGNET) {
        const k = 1 + Math.sin(t * THROB_HZ * Math.PI * 2) * THROB_AMP;
        m.scaling.set(k, k, k);
      } else if (this._liveKind === PW.GLIDE) {
        const dy = Math.sin(t * BOB_HZ * Math.PI * 2) * BOB_AMP;
        const track = this.ctx.tryGet('track');
        if (track) {
          track.path.toWorldExact(this._liveS, this._liveX, HOOP_Y + dy, this._w);
          m.position.set(this._w[0], this._w[1], this._w[2]);
        }
      }
      // SHIELD is deliberately dead still. In a set of three, one that does
      // not move is as distinctive as one that does.
    }

    if (this.shield) {
      const play = this.ctx.get('play');
      const track = this.ctx.tryGet('track');
      if (track) {
        track.path.toWorld(play.z, play.x, play.y + CAGE_Y, this._w);
        this.cage.position.set(this._w[0], this._w[1], this._w[2]);
      } else {
        this.cage.position.set(play.x, play.y + CAGE_Y, play.z);
      }
      this.cage.rotation.y = t * CAGE_SPIN;
      if (!this.cage.isEnabled()) this.cage.setEnabled(true);
    } else if (this.cage.isEnabled()) {
      this.cage.setEnabled(false);
      this.cage.position.set(this._parkPos, this._parkPos, this._parkPos);
    }
  }
}
