// The path — the spine the whole game hangs off.
//
// Before turns, "z" was both distance travelled AND world position, which is
// only true while the track is straight. Now the two are separated:
//
//   PATH SPACE   (s, lateral)  — s is metres travelled, lateral is metres from
//                                the centre line. All gameplay lives here:
//                                collision, generation, scoring, obstacles.
//   WORLD SPACE  (x, y, z)     — where things actually get drawn.
//
// The win is that nothing in the gameplay code had to learn about corners.
// Collision still compares two numbers on a line. Only rendering converts.
//
// Headings are restricted to the four cardinal directions, so the conversion
// is exact — no accumulated floating-point drift over a long run, and corners
// are always exactly square.

/** dirIndex -> unit vector in world XZ. Index 0 is +Z, turning clockwise. */
const DIRS = [
  [0, 1],   // 0: +Z
  [1, 0],   // 1: +X
  [0, -1],  // 2: -Z
  [-1, 0],  // 3: -X
];

export class Path {
  constructor() {
    /**
     * Segments, in order. Each is a straight run in one cardinal direction.
     *   s0   : path distance at which this segment starts
     *   len  : length in metres
     *   dir  : index into DIRS
     *   ox,oz: world position of the segment's centre line at s0
     *   turn : -1 left, 0 straight, +1 right — applied at the END of this
     *          segment, i.e. at s0 + len
     */
    this.segments = [];
    this._cursor = 0; // last segment index found, for locality of reference
  }

  reset() {
    this.segments.length = 0;
    this.segments.push({ s0: 0, len: 0, dir: 0, ox: 0, oz: 0, turn: 0 });
    this._cursor = 0;
  }

  get end() {
    const last = this.segments[this.segments.length - 1];
    return last.s0 + last.len;
  }

  /**
   * Grow the current segment by `len`, then apply `turn` at its end.
   * A turn of 0 simply extends the current straight run.
   */
  extend(len, turn = 0) {
    const last = this.segments[this.segments.length - 1];
    last.len += len;
    if (turn === 0) return last;

    last.turn = turn;
    const d = DIRS[last.dir];
    const junctionX = last.ox + d[0] * last.len;
    const junctionZ = last.oz + d[1] * last.len;
    const nextDir = (last.dir + (turn > 0 ? 1 : 3)) % 4;
    const seg = {
      s0: last.s0 + last.len,
      len: 0,
      dir: nextDir,
      ox: junctionX,
      oz: junctionZ,
      turn: 0,
    };
    this.segments.push(seg);
    return seg;
  }

  /** Index of the segment containing path distance `s`. */
  indexAt(s) {
    const segs = this.segments;
    let i = this._cursor;
    if (i >= segs.length) i = segs.length - 1;
    // Walk from the cached cursor. Callers query monotonically increasing s
    // almost always, so this is O(1) in practice.
    while (i > 0 && s < segs[i].s0) i--;
    while (i < segs.length - 1 && s >= segs[i + 1].s0) i++;
    this._cursor = i;
    return i;
  }

  segmentAt(s) {
    return this.segments[this.indexAt(s)];
  }

  /** Forward unit vector at path distance `s`, written into out2 = [x, z]. */
  forwardAt(s, out2) {
    const d = DIRS[this.segmentAt(s).dir];
    out2[0] = d[0]; out2[1] = d[1];
    return out2;
  }

  /** Yaw in radians such that a mesh's local +Z faces along the path. */
  yawAt(s) {
    const d = DIRS[this.segmentAt(s).dir];
    return Math.atan2(d[0], d[1]);
  }

  /**
   * Convert path space to world space.
   * `out3` is [x, y, z] and is written in place — no allocation.
   */
  toWorld(s, lateral, y, out3) {
    const seg = this.segmentAt(s);
    const d = DIRS[seg.dir];
    const f = s - seg.s0;
    // right-hand perpendicular: (dz, -dx)
    out3[0] = seg.ox + d[0] * f + d[1] * lateral;
    out3[1] = y;
    out3[2] = seg.oz + d[1] * f - d[0] * lateral;
    return out3;
  }

  /**
   * The next junction at or after `s`, or null if the path does not turn
   * again within the generated portion.
   * Returns { s, turn } where s is the path distance of the corner.
   */
  nextJunction(s) {
    const segs = this.segments;
    for (let i = this.indexAt(s); i < segs.length; i++) {
      const seg = segs[i];
      if (seg.turn === 0) continue;
      const js = seg.s0 + seg.len;
      if (js >= s) return { s: js, turn: seg.turn };
    }
    return null;
  }

  /** Every junction between s0 and s1, appended to `out` as {s, turn, dir}. */
  junctionsBetween(s0, s1, out) {
    out.length = 0;
    const segs = this.segments;
    for (let i = this.indexAt(s0); i < segs.length; i++) {
      const seg = segs[i];
      const js = seg.s0 + seg.len;
      if (js > s1) break;
      if (seg.turn !== 0 && js >= s0) out.push({ s: js, turn: seg.turn, dir: seg.dir });
    }
    return out;
  }

  /**
   * Drop segments the player can never return to. Without this the segment
   * array grows without bound over a long run — slow, and eventually a leak.
   */
  prune(beforeS) {
    const segs = this.segments;
    let keep = 0;
    while (keep < segs.length - 1 && segs[keep + 1].s0 < beforeS) keep++;
    if (keep > 0) {
      segs.splice(0, keep);
      this._cursor = 0;
    }
  }
}

export { DIRS };
