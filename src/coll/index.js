// coll/ — collision detection and response.
//
// OWNERSHIP: this directory decides what the player has hit. It reads player
// state and track contents; it never writes player state directly — it calls
// play.kill() or emits events and lets play/ own the consequence.
//
// No physics engine. A three-lane runner needs swept AABB tests against a
// handful of nearby boxes, which is a few dozen float comparisons per step.
// Anything heavier would be pure cost, in both frame time and download size.
//
// POWERUPS. Two of the three change what happens here, and both read their
// state from `play.pw` (see the contract at the top of play/powerups.js):
//
//   SHIELD  absorbs exactly one obstacle hit. On a hit, pw.absorb() is asked
//           first; if it says yes the player is not killed and 0.55s of
//           i-frames run, because without them the very next fixed step tests
//           the same box again — the player is still inside it — and the
//           second test kills them 16ms after the shield saved them. That is
//           the whole reason i-frames exist here; it is not a feel tweak.
//
//   MAGNET  pulls stars in. The flight is animated on the STAR'S OWN MESH,
//           which belongs to track/ — so it is done by writing mesh.position
//           only, never st.z. st.z is what track/ sorts and recycles its star
//           list by, and moving it would corrupt a list that is assumed
//           z-ascending. Flights are dropped the moment a star stops being
//           active, so a star recycled mid-flight is never dragged around.
//           A flying star is excluded from the ordinary grab test, or it would
//           be collected twice.

import { EV } from '../core/ctx.js';
import { MAGNET_RADIUS, MAGNET_FLIGHT, SHIELD_IFRAMES } from '../play/powerups.js';

/** How far ahead/behind of the player to bother testing, in metres. */
const TEST_WINDOW = 6;

/** Stand-in for the obstacle list during i-frames. Never mutated. */
const EMPTY = [];

/** Stars in flight to the player at once. Fixed pool, allocated in init. */
const MAX_FLIGHTS = 24;
/** Where a magnetised star is aimed: the player's chest, in metres. */
const MAGNET_TARGET_Y = 0.95;

export default class Collision {
  constructor(ctx) {
    this.ctx = ctx;
    this.enabled = true;
    this._prevZ = 0;
    // pooled payloads — see ARCHITECTURE.md §4.2
    this._pHit = { kind: 0, lane: 0, absorbed: false };
    this._pStar = { value: 0, x: 0, y: 0, z: 0 };

    /** Seconds of invulnerability left after the shield broke. */
    this._iFrames = 0;

    /** Magnet flights. Fixed-size pool of fixed-shape records. */
    this._flights = new Array(MAX_FLIGHTS);
    for (let i = 0; i < MAX_FLIGHTS; i++) {
      this._flights[i] = { st: null, t: 0, sx: 0, sy: 0, sz: 0 };
    }
    this._flightN = 0;
    /** Scratch for path->world. Never reallocated. */
    this._w = [0, 0, 0];
  }

  init() {
    // In capture mode the harness drives an unsteered player, which would die
    // on the first obstacle and make every gameplay screenshot a results
    // screen. Poses that want death enable collision explicitly.
    this.enabled = !this.ctx.config.captureMode;
    this.ctx.on(EV.RUN_START, () => {
      this._prevZ = 0;
      this._iFrames = 0;
      this._flightN = 0;
      this.enabled = !this.ctx.config.captureMode;
    });
    // A star half way to a dead player would hang in the air until track/
    // recycled it.
    this.ctx.on(EV.PLAYER_DEATH, () => { this._flightN = 0; });
  }

  fixedUpdate(dt) {
    if (!this.enabled) return;
    const play = this.ctx.get('play');
    if (!play.alive) return;
    if (this._iFrames > 0) this._iFrames -= dt;

    const track = this.ctx.get('track');
    const T = this.ctx.config.tune;

    // Sweep along z rather than testing a point.
    //
    // At top speed (34 m/s) one fixed step covers 0.57m, which is wider than
    // an obstacle is deep (0.6-0.68m box). Testing only the current position
    // would let the player tunnel straight through obstacles at high speed —
    // rare enough to look like a random bug, common enough to ruin the game.
    const z1 = play.z;
    const z0 = Math.min(this._prevZ, z1);
    this._prevZ = z1;

    const px = play.x;
    const pr = T.playerRadius;
    const py0 = play.y;
    const py1 = play.y + play.collisionHeight;

    // ---- obstacles ----
    const obs = this._iFrames > 0 ? EMPTY : track.obstacles;
    for (let i = 0; i < obs.length; i++) {
      const o = obs[i];
      if (o.z < z0 - TEST_WINDOW) continue;
      if (o.z > z1 + TEST_WINDOW) break;   // list is z-sorted, nothing further matters

      const s = track.sizeOf(o.kind);

      if (z0 - pr > o.z + s.hz) continue;          // already past it
      if (z1 + pr < o.z - s.hz) continue;          // not there yet
      if (Math.abs(px - o.x) > pr + s.hx) continue; // different lane
      const oy0 = s.cy - s.hy;
      const oy1 = s.cy + s.hy;
      if (py1 <= oy0 || py0 >= oy1) continue;       // jumped over / slid under

      // The shield gets asked BEFORE the event is emitted, so listeners see
      // `absorbed` and can play a chime rather than a crash.
      const absorbed = play.pw.absorb();
      this._pHit.kind = o.kind;
      this._pHit.lane = o.lane;
      this._pHit.absorbed = absorbed;
      this.ctx.emit(EV.OBSTACLE_HIT, this._pHit);
      if (absorbed) {
        this._iFrames = SHIELD_IFRAMES;
        break;
      }
      play.kill('obstacle');
      return;
    }

    // ---- stars ----
    // Deliberately generous. Missing a star you clearly ran through feels far
    // worse than collecting one you nearly missed.
    const grab = pr + 0.75;
    const grabY = 1.05;
    const stars = track.stars;
    for (let i = stars.length - 1; i >= 0; i--) {
      const st = stars[i];
      if (this._flightN > 0 && this._isFlying(st)) continue;
      if (st.z + grab < z0 || st.z - grab > z1) continue;
      if (Math.abs(px - st.x) > grab) continue;
      const cy = play.y + play.collisionHeight * 0.5;
      if (Math.abs(cy - st.y) > grabY) continue;

      this._take(track, st, T);
    }

    this._magnet(play, track, dt, T);
  }

  /** Score a star and remove it. track/ owns the mesh; takeStar parks it. */
  _take(track, st, T) {
    this._pStar.value = T.starValue;
    this._pStar.x = st.x; this._pStar.y = st.y; this._pStar.z = st.z;
    track.takeStar(st);
    this.ctx.emit(EV.PICKUP_STAR, this._pStar);
  }

  _isFlying(st) {
    for (let i = 0; i < this._flightN; i++) if (this._flights[i].st === st) return true;
    return false;
  }

  _dropFlight(i) {
    // Order does not matter, so swap the tail down rather than splicing.
    this._flightN--;
    const tmp = this._flights[i];
    this._flights[i] = this._flights[this._flightN];
    this._flights[this._flightN] = tmp;
    tmp.st = null;
  }

  /**
   * RUBY MAGNET. Enrol every star inside 9m, then fly the enrolled ones in
   * over 0.40s.
   *
   * Flights keep running after the magnet expires. A star frozen in mid-air
   * two metres from the player, or teleported back to where it started, both
   * read as a bug; letting the last few land does not.
   */
  _magnet(play, track, dt, T) {
    const pw = play.pw;

    if (pw.magnet) {
      const stars = track.stars;
      const r2 = MAGNET_RADIUS * MAGNET_RADIUS;
      for (let i = 0; i < stars.length && this._flightN < MAX_FLIGHTS; i++) {
        const st = stars[i];
        const dz = st.z - play.z;
        if (dz < -MAGNET_RADIUS) continue;
        if (dz > MAGNET_RADIUS) break;          // z-sorted
        const dx = st.x - play.x;
        if (dx * dx + dz * dz > r2) continue;
        if (this._isFlying(st)) continue;
        const f = this._flights[this._flightN++];
        f.st = st;
        f.t = 0;
        f.sx = st.mesh.position.x;
        f.sy = st.mesh.position.y;
        f.sz = st.mesh.position.z;
      }
    }

    if (this._flightN === 0) return;

    // One path->world conversion per step, not one per star.
    track.path.toWorld(play.z, play.x, play.y + MAGNET_TARGET_Y, this._w);
    const tx = this._w[0], ty = this._w[1], tz = this._w[2];

    for (let i = 0; i < this._flightN;) {
      const f = this._flights[i];
      const st = f.st;
      if (!st.active || st.taken) { this._dropFlight(i); continue; }
      f.t += dt;
      const u = f.t / MAGNET_FLIGHT;
      if (u >= 1) {
        this._take(track, st, T);
        this._dropFlight(i);
        continue;
      }
      // u^2 — slow release, fast arrival. A linear flight reads as a tow rope.
      const e = u * u;
      st.mesh.position.set(
        f.sx + (tx - f.sx) * e,
        f.sy + (ty - f.sy) * e,
        f.sz + (tz - f.sz) * e,
      );
      i++;
    }
  }

  dispose() {}
}
