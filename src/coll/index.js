// coll/ — collision detection and response.
//
// OWNERSHIP: this directory decides what the player has hit. It reads player
// state and track contents; it never writes player state directly — it calls
// play.kill() or emits events and lets play/ own the consequence.
//
// No physics engine. A three-lane runner needs swept AABB tests against a
// handful of nearby boxes, which is a few dozen float comparisons per step.
// Anything heavier would be pure cost, in both frame time and download size.

import { EV } from '../core/ctx.js';

/** How far ahead/behind of the player to bother testing, in metres. */
const TEST_WINDOW = 6;

export default class Collision {
  constructor(ctx) {
    this.ctx = ctx;
    this.enabled = true;
    this._prevZ = 0;
    // pooled payloads — see ARCHITECTURE.md §4.2
    this._pHit = { kind: 0, lane: 0 };
    this._pStar = { value: 0, x: 0, y: 0, z: 0 };
  }

  init() {
    // In capture mode the harness drives an unsteered player, which would die
    // on the first obstacle and make every gameplay screenshot a results
    // screen. Poses that want death enable collision explicitly.
    this.enabled = !this.ctx.config.captureMode;
    this.ctx.on(EV.RUN_START, () => {
      this._prevZ = 0;
      this.enabled = !this.ctx.config.captureMode;
    });
  }

  fixedUpdate() {
    if (!this.enabled) return;
    const play = this.ctx.get('play');
    if (!play.alive) return;

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
    const obs = track.obstacles;
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

      this._pHit.kind = o.kind;
      this._pHit.lane = o.lane;
      this.ctx.emit(EV.OBSTACLE_HIT, this._pHit);
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
      if (st.z + grab < z0 || st.z - grab > z1) continue;
      if (Math.abs(px - st.x) > grab) continue;
      const cy = play.y + play.collisionHeight * 0.5;
      if (Math.abs(cy - st.y) > grabY) continue;

      this._pStar.value = T.starValue;
      this._pStar.x = st.x; this._pStar.y = st.y; this._pStar.z = st.z;
      track.takeStar(st);
      this.ctx.emit(EV.PICKUP_STAR, this._pStar);
    }
  }

  dispose() {}
}
