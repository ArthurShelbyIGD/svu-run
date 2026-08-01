// track/ — the endless track: floor, obstacles, collectibles, and the chunk
// generation grammar that assembles them.
//
// OWNERSHIP: this directory owns the ground and everything bolted to it that
// the player interacts with. Decorative props belong to world/.
//
// Everything is pooled. No mesh is created or destroyed during play; the smoke
// test asserts total mesh count stays flat over a long run.

import { EV } from '../core/ctx.js';
import { OB, TEMPLATES, validateTemplates, pickTemplate, pickTurnTemplate } from './chunks.js';
import { Path, DIRS } from './path.js';
import {
  buildTile, buildColumn, buildLow, buildHigh, buildFull, buildStar,
  buildCornerPad, buildJunctionWall, buildWallArrow, buildChevron,
} from './parts.js';

export { OB };

// Chunk length must be a whole number of tiles, because junctions sit on
// chunk boundaries and a floor tile that straddled a corner would be visibly
// wrong. 48 = 6 x 8.
const CHUNK_LEN = 48;          // metres per chunk
const COLUMN_SPACING = 3;      // one column pair every N tiles
const RECYCLE_BEHIND = 24;     // metres behind the player before recycling

// Turns do not start until the player has had time to learn the basics.
const FIRST_TURN_AT = 260;     // metres
const TURN_CHANCE = 0.42;      // probability a given chunk ends in a turn
const MIN_CHUNKS_BETWEEN_TURNS = 2;

const JUNCTION_POOL = 5;
const CHEVRONS_PER_JUNCTION = 5;   // arrows painted on the approach

// Obstacle dimensions as HALF-extents [hx, hy, hz] plus centre height cy.
// These numbers are the difficulty of the game — they decide what clears what.
const OB_SIZE = {
  [OB.LOW]:  { hx: 1.02, hy: 0.28, hz: 0.30, cy: 0.28 },  // top at 0.56 — jump it
  [OB.HIGH]: { hx: 1.02, hy: 0.55, hz: 0.30, cy: 1.72 },  // bottom at 1.17 — slide it
  [OB.FULL]: { hx: 1.02, hy: 1.15, hz: 0.34, cy: 1.15 },  // solid — go round it
};

const POOL = {
  [OB.LOW]: 28,
  [OB.HIGH]: 28,
  [OB.FULL]: 34,
};
const STAR_POOL = 190;

export default class Track {
  constructor(ctx) {
    this.ctx = ctx;
    this.tiles = [];
    this.headIndex = 0;

    /** Pools, keyed by obstacle kind. Each entry: {mesh, rec} */
    this.pools = {};
    /** Live obstacles, kept sorted by z ascending. */
    this.obstacles = [];
    /** Live stars, kept sorted by z ascending. */
    this.stars = [];
    this._starPool = [];

    this.generatedTo = 0;    // z up to which chunks exist
    this.lastTemplate = null;
    this.chunkCount = 0;

    this.path = new Path();
    this.junctions = [];     // {s, turn, dir, wx, wz} in view order
    this._junctionPool = []; // {pad, wall, active}
    this._chunksSinceTurn = 99;

    this._parkZ = -10000;    // where inactive pool members are hidden
    this._pRecycle = { chunk: null };
    this._w = [0, 0, 0];     // scratch for path->world, never reallocated
    this._w2 = [0, 0, 0];
  }

  init() {
    validateTemplates(TEMPLATES, this.ctx.config.tune.laneCount);
    this._buildFloor();
    this._buildColumns();
    this._buildObstaclePools();
    this._buildStarPool();
    this._buildJunctionPool();
    this.reset();
  }

  // ---- construction ----------------------------------------------------

  /**
   * The floor.
   *
   * A tile is ONE merged multi-material mesh, not a stack of boxes. Building
   * it that way is what makes a properly constructed floor affordable: the
   * inlay, the transverse courses, the medallion, the kerb and the rail all
   * live inside a single instance, so a detailed tile costs the same number of
   * scene meshes as the old flat slab did and only as many draw calls as it
   * has distinct materials.
   *
   * Two variants exist. `full` carries the border course; `bare` stops at the
   * paving, and is what gets enabled next to a junction, where a kerb would
   * run straight through the corner.
   */
  _buildFloor() {
    const T = this.ctx.config.tune;
    const mat = this.ctx.get('mat');
    const q = this.ctx.config.q;
    this.tileCount = Math.ceil(T.viewDistance / T.tileLength) + 4;

    this.tileProto = buildTile(this.ctx.scene, mat, q, T, true);
    this.tileBareProto = buildTile(this.ctx.scene, mat, q, T, false);
    this.tileProto.position.set(this._parkZ, this._parkZ, this._parkZ);
    this.tileBareProto.position.set(this._parkZ, this._parkZ, this._parkZ);

    for (let i = 0; i < this.tileCount; i++) {
      const full = i === 0 ? this.tileProto : this.tileProto.createInstance(`tile${i}`);
      const bare = i === 0 ? this.tileBareProto : this.tileBareProto.createInstance(`tileB${i}`);
      bare.setEnabled(false);
      this.tiles.push({ index: i, full, bare, z: 0 });
    }
    this.headIndex = this.tileCount - 1;
  }

  _buildColumns() {
    const mat = this.ctx.get('mat');
    const q = this.ctx.config.q;

    // Columns used to be one thin-instance field scrolled along z. That only
    // works on a straight track: once the path can turn, decorative geometry
    // has to follow the path like everything else, so columns are now owned by
    // the tile that carries them.
    this.columnProto = buildColumn(this.ctx.scene, mat, q);
    this.columnProto.position.set(this._parkZ, this._parkZ, this._parkZ);

    for (let i = 0; i < this.tiles.length; i++) {
      const t = this.tiles[i];
      if (i % COLUMN_SPACING !== 0) continue;
      t.colL = this.columnProto.createInstance(`colL${i}`);
      t.colR = this.columnProto.createInstance(`colR${i}`);
    }
  }

  _buildJunctionPool() {
    const T = this.ctx.config.tune;
    const mat = this.ctx.get('mat');
    const scene = this.ctx.scene;
    const w = T.laneWidth * T.laneCount;

    const q = this.ctx.config.q;

    // Corner pad: fills the square the two straight runs leave uncovered.
    // Deliberately oversized. A pad exactly the width of the corridor abuts
    // the two straight runs with zero overlap, and any rounding at all leaves
    // a hairline of background showing through at the corner. 1.6m of overlap
    // costs nothing and guarantees the corner is paved.
    const padProto = buildCornerPad(scene, mat, q, w);
    padProto.position.set(this._parkZ, this._parkZ, this._parkZ);
    this.padProto = padProto;

    // Backstop wall: what you hit if you fail to turn. It is decoration —
    // the death itself is decided in path space by play/ — but without it the
    // player has no way to see that the corridor ends.
    const wallProto = buildJunctionWall(scene, mat, q, w);
    wallProto.position.set(this._parkZ, this._parkZ, this._parkZ);
    this.wallProto = wallProto;

    // Direction chevrons.
    //
    // The first build of corners was mechanically correct and unplayable: from
    // the player's viewpoint the side corridor is edge-on and invisible, so a
    // corner read as "a wall appeared, you died" with no way to know which way
    // to go. These arrows are the fix, and they are gameplay, not decoration.
    this.chevronProto = buildChevron(scene, mat, q);
    this.chevronProto.position.set(this._parkZ, this._parkZ, this._parkZ);

    // One proto per turn direction. See buildWallArrow for why.
    this.arrowProtoR = buildWallArrow(scene, mat, q, 1);
    this.arrowProtoL = buildWallArrow(scene, mat, q, -1);
    this.arrowProtoR.position.set(this._parkZ, this._parkZ, this._parkZ);
    this.arrowProtoL.position.set(this._parkZ, this._parkZ, this._parkZ);

    for (let i = 0; i < JUNCTION_POOL; i++) {
      const chevrons = [];
      for (let c = 0; c < CHEVRONS_PER_JUNCTION; c++) {
        const m = (i === 0 && c === 0)
          ? this.chevronProto
          : this.chevronProto.createInstance(`chev${i}_${c}`);
        m.position.set(this._parkZ, this._parkZ, this._parkZ);
        chevrons.push(m);
      }
      // The wall arrow is the primary signal. Floor chevrons are foreshortened
      // to almost nothing by a low chase camera; the wall is seen head-on, so
      // that is where the readable instruction has to live.
      const arrowR = i === 0 ? this.arrowProtoR : this.arrowProtoR.createInstance(`arrowR${i}`);
      const arrowL = i === 0 ? this.arrowProtoL : this.arrowProtoL.createInstance(`arrowL${i}`);
      arrowR.position.set(this._parkZ, this._parkZ, this._parkZ);
      arrowL.position.set(this._parkZ, this._parkZ, this._parkZ);

      this._junctionPool.push({
        pad: i === 0 ? padProto : padProto.createInstance(`pad${i}`),
        wall: i === 0 ? wallProto : wallProto.createInstance(`wall${i}`),
        chevrons,
        arrowR,
        arrowL,
        active: false,
      });
    }
    for (const j of this._junctionPool) {
      j.pad.position.set(this._parkZ, this._parkZ, this._parkZ);
      j.wall.position.set(this._parkZ, this._parkZ, this._parkZ);
    }
  }

  _buildObstaclePools() {
    const mat = this.ctx.get('mat');
    const scene = this.ctx.scene;
    const q = this.ctx.config.q;
    // Each obstacle is a designed object merged into one multi-material mesh,
    // authored in metres above the running surface. The pool therefore places
    // it at path height 0, not at the collision box centre.
    const buildFor = {
      [OB.LOW]: buildLow,
      [OB.HIGH]: buildHigh,
      [OB.FULL]: buildFull,
    };

    for (const kind of [OB.LOW, OB.HIGH, OB.FULL]) {
      const s = OB_SIZE[kind];
      const proto = buildFor[kind](scene, mat, q, s);
      proto.position.set(this._parkZ, this._parkZ, this._parkZ);

      const list = [];
      for (let i = 0; i < POOL[kind]; i++) {
        const mesh = i === 0 ? proto : proto.createInstance(`ob${kind}_${i}`);
        mesh.position.set(this._parkZ, this._parkZ, this._parkZ);
        list.push({ kind, mesh, lane: 0, x: 0, z: 0, active: false });
      }
      this.pools[kind] = list;

      const world = this.ctx.tryGet('world');
      if (world) world.addCasterMesh(proto);
    }
  }

  _buildStarPool() {
    const mat = this.ctx.get('mat');
    const q = this.ctx.config.q;
    // A real faceted five-point star, matching the gold stars in the
    // reference. It used to be a squashed octahedron, which reads as a chip of
    // gemstone rather than a star. Kept small on purpose: at 0.30 the first
    // build rendered a half-metre ornament that hid the obstacles behind it.
    const proto = buildStar(this.ctx.scene, mat, q);
    proto.position.set(this._parkZ, this._parkZ, this._parkZ);
    this.starProto = proto;

    const n = q.name === 'low' ? Math.floor(STAR_POOL * 0.6) : STAR_POOL;
    for (let i = 0; i < n; i++) {
      const mesh = i === 0 ? proto : proto.createInstance(`star${i}`);
      mesh.position.set(this._parkZ, this._parkZ, this._parkZ);
      this._starPool.push({ mesh, x: 0, y: 0, z: 0, active: false, taken: false });
    }
  }

  // ---- generation ------------------------------------------------------

  reset() {
    for (const kind of [OB.LOW, OB.HIGH, OB.FULL]) {
      for (const e of this.pools[kind]) this._park(e);
    }
    for (const st of this._starPool) this._park(st);
    for (const j of this._junctionPool) {
      j.active = false;
      j.pad.position.set(this._parkZ, this._parkZ, this._parkZ);
      j.wall.position.set(this._parkZ, this._parkZ, this._parkZ);
      for (const c of j.chevrons) c.position.set(this._parkZ, this._parkZ, this._parkZ);
      j.arrowR.setEnabled(false);
      j.arrowL.setEnabled(false);
    }
    this.obstacles.length = 0;
    this.stars.length = 0;
    this.junctions.length = 0;
    this.lastTemplate = null;
    this.chunkCount = 0;
    this._chunksSinceTurn = 99;

    this.path.reset();
    // Give the player a clear run-up before anything appears.
    const runUp = Math.ceil((this.ctx.config.tune.startSpeed * 2.2) / CHUNK_LEN) * CHUNK_LEN;
    this.path.extend(runUp, 0);
    this.generatedTo = runUp;

    for (let i = 0; i < 4; i++) this._generateChunk();
    this.headIndex = -1;
    for (let i = 0; i < this.tiles.length; i++) this._placeTile(this.tiles[i], i);
    this.headIndex = this.tiles.length - 1;
    this._syncJunctions();
  }

  /**
   * Difficulty ramps with distance, then plateaus.
   *
   * The first 160m are deliberately flat at zero — long enough to learn that
   * the track exists, that it moves, and what the controls do, before anything
   * asks a question. The original ramp started biting immediately, which reads
   * as "this game is unfair" rather than "I am new at this".
   */
  difficultyAt(z) {
    return Math.min(1, Math.max(0, (z - 160) / 1500));
  }

  _generateChunk() {
    const T = this.ctx.config.tune;
    const rng = this.ctx.rng;
    const z0 = this.generatedTo;
    const diff = this.difficultyAt(z0);

    // Decide whether this chunk ends in a corner BEFORE choosing its contents,
    // because a turn chunk uses a different, deliberately sparser template set.
    let turn = 0;
    if (z0 > FIRST_TURN_AT && this._chunksSinceTurn >= MIN_CHUNKS_BETWEEN_TURNS
        && rng.chance(TURN_CHANCE)) {
      turn = rng.chance(0.5) ? -1 : 1;
    }

    const tpl = turn !== 0 ? pickTurnTemplate(rng, diff) : pickTemplate(rng, diff, this.lastTemplate);
    this.lastTemplate = tpl;
    this.chunkCount++;
    this._chunksSinceTurn = turn !== 0 ? 0 : this._chunksSinceTurn + 1;

    // Extend the path first: the items below need their segment to exist
    // before they can be converted to world space.
    this.path.extend(CHUNK_LEN, turn);
    if (turn !== 0) {
      const js = z0 + CHUNK_LEN;
      const seg = this.path.segmentAt(js - 0.01);
      const d = DIRS[seg.dir];
      this.path.toWorldExact(js - 0.01, 0, 0, this._w);
      this.junctions.push({
        s: js, turn, dir: seg.dir,
        wx: this._w[0] + d[0] * 0.01,
        wz: this._w[2] + d[1] * 0.01,
      });
    }

    for (const it of tpl.items) {
      this._spawnObstacle(it.kind, it.lane, z0 + it.t * CHUNK_LEN);
    }

    for (const run of tpl.stars || []) {
      const baseZ = z0 + run.t * CHUNK_LEN;
      for (let i = 0; i < run.n; i++) {
        const z = baseZ + i * run.gap;
        let y = 1.0;
        if (run.arc) {
          // trace the actual jump arc so the stars are collectable in flight
          const u = (i + 0.5) / run.n;
          y = 0.9 + Math.sin(u * Math.PI) * (T.jumpHeight * 0.78);
        }
        this._spawnStar(run.lane, y, z);
      }
    }

    this.generatedTo += CHUNK_LEN;
  }

  /** The next corner at or after path distance s, or null. */
  nextJunction(s) {
    for (let i = 0; i < this.junctions.length; i++) {
      if (this.junctions[i].s >= s) return this.junctions[i];
    }
    return null;
  }

  /** Place pooled corner pads and backstop walls at visible junctions. */
  _syncJunctions() {
    const T = this.ctx.config.tune;
    const play = this.ctx.tryGet('play');
    const here = play ? play.z : 0;
    const w = T.laneWidth * T.laneCount;

    for (const j of this._junctionPool) j.active = false;
    let slot = 0;
    for (let i = 0; i < this.junctions.length && slot < this._junctionPool.length; i++) {
      const jn = this.junctions[i];
      if (jn.s < here - 20 || jn.s > here + T.viewDistance) continue;
      const p = this._junctionPool[slot++];
      p.active = true;
      p.pad.position.set(jn.wx, 0, jn.wz);
      const d = DIRS[jn.dir];
      // wall sits just beyond the corner, square across the old direction
      p.wall.position.set(jn.wx + d[0] * (w * 0.5 + 0.3), 2.1, jn.wz + d[1] * (w * 0.5 + 0.3));
      p.wall.rotation.y = Math.atan2(d[0], d[1]);

      // Chevrons on the approach, pointing the way the corner goes.
      // World direction of the turn: +right for a right turn, -right for left.
      const ax = jn.turn > 0 ? d[1] : -d[1];
      const az = jn.turn > 0 ? -d[0] : d[0];
      const yaw = Math.atan2(-az, ax);

      // The wall arrow shares the WALL's yaw, not the turn's, so its face
      // always squares up to the player. The turn direction is baked into
      // which of the two protos gets enabled. Yawing one proto by 180 degrees
      // to point it the other way also swung its front face away from the
      // camera, which is why left-hand corners used to show a black arrow.
      const arrow = jn.turn > 0 ? p.arrowR : p.arrowL;
      const arrowOff = jn.turn > 0 ? p.arrowL : p.arrowR;
      arrowOff.setEnabled(false);
      arrow.setEnabled(true);
      arrow.rotation.y = p.wall.rotation.y;
      // Stand the arrow clearly IN FRONT of the wall. It was at +0.02 while
      // the wall spans +0.0 to +0.6 in the same axis, so the arrow was buried
      // inside the wall's own volume and never drew — the corner had no
      // direction signage at all despite the code being there.
      arrow.position.set(
        jn.wx + d[0] * (w * 0.5 - 0.22),
        2.05,
        jn.wz + d[1] * (w * 0.5 - 0.22),
      );

      for (let c = 0; c < p.chevrons.length; c++) {
        const s = jn.s - 3.5 - c * 4.2;    // spread back along the approach
        this.path.toWorldExact(s, 0, 0.07, this._w);
        p.chevrons[c].position.set(this._w[0], this._w[1], this._w[2]);
        p.chevrons[c].rotation.y = yaw;
      }
    }
    for (const p of this._junctionPool) {
      if (!p.active) {
        p.pad.position.set(this._parkZ, this._parkZ, this._parkZ);
        p.wall.position.set(this._parkZ, this._parkZ, this._parkZ);
        for (const c of p.chevrons) c.position.set(this._parkZ, this._parkZ, this._parkZ);
        p.arrowR.setEnabled(false);
        p.arrowL.setEnabled(false);
      }
    }
  }

  _laneX(lane) {
    const T = this.ctx.config.tune;
    return (lane - (T.laneCount - 1) / 2) * T.laneWidth;
  }

  _spawnObstacle(kind, lane, z) {
    const pool = this.pools[kind];
    for (let i = 0; i < pool.length; i++) {
      const e = pool[i];
      if (e.active) continue;
      e.active = true;
      e.lane = lane;
      e.x = this._laneX(lane);
      e.z = z;
      // Obstacle meshes are authored standing on the floor, so they are placed
      // at surface height rather than at the collision box centre.
      this.path.toWorldExact(z, e.x, 0, this._w);
      e.mesh.position.set(this._w[0], this._w[1], this._w[2]);
      e.mesh.rotation.y = this.path.yawExactAt(z);
      this.obstacles.push(e);
      return e;
    }
    return null; // pool exhausted — silently skip rather than allocate
  }

  _spawnStar(lane, y, z) {
    for (let i = 0; i < this._starPool.length; i++) {
      const s = this._starPool[i];
      if (s.active) continue;
      s.active = true;
      s.taken = false;
      s.x = this._laneX(lane);
      s.y = y;
      s.z = z;
      this.path.toWorldExact(z, s.x, y, this._w);
      s.mesh.position.set(this._w[0], this._w[1], this._w[2]);
      s.mesh.setEnabled(true);
      this.stars.push(s);
      return s;
    }
    return null;
  }

  _park(e) {
    e.active = false;
    e.mesh.position.set(this._parkZ, this._parkZ, this._parkZ);
  }

  /** Remove a star immediately — called by coll/ on pickup. */
  takeStar(s) {
    s.taken = true;
    this._park(s);
    const i = this.stars.indexOf(s);
    if (i >= 0) this.stars.splice(i, 1);
  }

  // ---- per-step --------------------------------------------------------

  fixedUpdate() {
    const T = this.ctx.config.tune;
    const play = this.ctx.get('play');

    // recycle floor tiles
    const behind = play.z - T.tileLength * 3;
    for (let i = 0; i < this.tiles.length; i++) {
      const tile = this.tiles[i];
      if (tile.z + T.tileLength < behind) {
        this.headIndex++;
        this._placeTile(tile, this.headIndex);
        this._pRecycle.chunk = tile;
        this.ctx.emit(EV.CHUNK_RECYCLE, this._pRecycle);
      }
    }

    // generate ahead
    while (this.generatedTo < play.z + T.viewDistance) this._generateChunk();

    // retire anything behind the player. Both lists are z-sorted, so this is
    // a cheap head-of-list check rather than a scan.
    const cut = play.z - RECYCLE_BEHIND;
    while (this.obstacles.length && this.obstacles[0].z < cut) {
      this._park(this.obstacles.shift());
    }
    while (this.stars.length && this.stars[0].z < cut) {
      this._park(this.stars.shift());
    }
    while (this.junctions.length && this.junctions[0].s < play.z - RECYCLE_BEHIND * 2) {
      this.junctions.shift();
    }
    // Segments the player can never reach again would otherwise accumulate
    // forever — slow to search and, over a long enough run, a genuine leak.
    this.path.prune(play.z - 200);

    this._syncJunctions();
  }

  renderUpdate(dtReal) {
    // Stars spin. One shared rotation value applied to active stars only.
    // A faceted star spun about Y alone goes edge-on twice a turn and briefly
    // disappears; a fixed tilt keeps a face towards the camera throughout and
    // makes each facet catch the light in turn.
    this._spin = (this._spin || 0) + dtReal * 1.9;
    for (let i = 0; i < this.stars.length; i++) {
      const r = this.stars[i].mesh.rotation;
      r.y = this._spin;
      r.x = -0.34;
    }
  }

  _placeTile(tile, index) {
    const T = this.ctx.config.tune;
    const trackWidth = T.laneWidth * T.laneCount;
    const s0 = index * T.tileLength;
    const mid = s0 + T.tileLength * 0.5;
    tile.z = s0;
    tile.index = index;

    // Sample at the tile's midpoint. Chunk length is a whole number of tiles
    // and junctions sit on chunk boundaries, so a midpoint sample is always
    // safely inside one segment and a tile never straddles a corner.
    // Exact, not blended: see the CORNER_BLEND note in path.js. Placing floor
    // tiles through the blend pulls them towards the inside of the bend and
    // tears visible holes in the track at every corner.
    const yaw = this.path.yawExactAt(mid);
    this.path.toWorldExact(mid, 0, 0, this._w);

    // The border course would cut straight through a corner, so tiles either
    // side of a junction swap to the variant without it. The backstop wall and
    // the corner pad read as the corner instead.
    const nearJunction = this._isNearJunction(s0, T.tileLength);
    tile.full.setEnabled(!nearJunction);
    tile.bare.setEnabled(nearJunction);
    const live = nearJunction ? tile.bare : tile.full;
    live.position.set(this._w[0], this._w[1], this._w[2]);
    live.rotation.y = yaw;

    // A column from either corridor can land squarely inside the corner
    // square, where it blocks the player's view of the exit entirely. The
    // corner is the one place in the game where seeing ahead matters most, so
    // columns are suppressed around junctions.
    if (tile.colL) {
      tile.colL.setEnabled(!nearJunction);
      tile.colR.setEnabled(!nearJunction);
      const colOff = trackWidth / 2 + 1.55;
      this.path.toWorldExact(mid, -colOff, 0, this._w);
      tile.colL.position.set(this._w[0], this._w[1], this._w[2]);
      this.path.toWorldExact(mid, colOff, 0, this._w);
      tile.colR.position.set(this._w[0], this._w[1], this._w[2]);
      tile.colL.rotation.y = yaw;
      tile.colR.rotation.y = yaw;
    }
  }

  _isNearJunction(s0, len) {
    for (let i = 0; i < this.junctions.length; i++) {
      const js = this.junctions[i].s;
      if (js >= s0 - len * 1.5 && js <= s0 + len * 2.5) return true;
    }
    return false;
  }

  /** Half-extents for an obstacle kind. Read by coll/. */
  sizeOf(kind) { return OB_SIZE[kind]; }

  dispose() {
    for (const t of this.tiles) {
      t.full.dispose(); t.bare.dispose();
      if (t.colL) { t.colL.dispose(); t.colR.dispose(); }
    }
    for (const j of this._junctionPool) {
      j.pad.dispose(); j.wall.dispose();
      for (const c of j.chevrons) c.dispose();
      j.arrowR.dispose(); j.arrowL.dispose();
    }
    if (this.chevronProto) this.chevronProto.dispose();
    this.tiles.length = 0;
    for (const kind of [OB.LOW, OB.HIGH, OB.FULL]) {
      for (const e of this.pools[kind]) e.mesh.dispose();
    }
    for (const s of this._starPool) s.mesh.dispose();
    if (this.columnProto) this.columnProto.dispose();
  }
}
