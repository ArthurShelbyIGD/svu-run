// track/ — the endless track: floor, obstacles, collectibles, and the chunk
// generation grammar that assembles them.
//
// OWNERSHIP: this directory owns the ground and everything bolted to it that
// the player interacts with. Decorative props belong to world/.
//
// Everything is pooled. No mesh is created or destroyed during play; the smoke
// test asserts total mesh count stays flat over a long run.

import { MeshBuilder, VertexData, Mesh, Vector3, Matrix } from '../core/bjs.js';
import { EV } from '../core/ctx.js';
import { OB, TEMPLATES, validateTemplates, pickTemplate, pickTurnTemplate } from './chunks.js';
import { Path, DIRS } from './path.js';

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

  _buildFloor() {
    const T = this.ctx.config.tune;
    const mat = this.ctx.get('mat');
    const trackWidth = T.laneWidth * T.laneCount;
    this.tileCount = Math.ceil(T.viewDistance / T.tileLength) + 4;

    this.floorProto = MeshBuilder.CreateBox('floor', {
      width: trackWidth, height: 0.35, depth: T.tileLength,
    }, this.ctx.scene);
    this.floorProto.material = mat.get('trackFloor');
    this.floorProto.isPickable = false;
    this.floorProto.receiveShadows = true;

    this.railProto = MeshBuilder.CreateBox('rail', {
      width: 0.30, height: 0.55, depth: T.tileLength,
    }, this.ctx.scene);
    this.railProto.material = mat.get('yellowGold');
    this.railProto.isPickable = false;

    // Lane dividers. Not decoration: in a three-lane runner the player needs
    // to see where the lanes are, and inlaid gold lines give the floor a
    // readable structure and a sense of speed as they stream past.
    this.laneLineProto = MeshBuilder.CreateBox('laneLine', {
      width: 0.10, height: 0.06, depth: T.tileLength * 0.62,
    }, this.ctx.scene);
    this.laneLineProto.material = mat.get('yellowGold');
    this.laneLineProto.isPickable = false;

    for (let i = 0; i < this.tileCount; i++) {
      const floor = i === 0 ? this.floorProto : this.floorProto.createInstance(`floor${i}`);
      const railL = i === 0 ? this.railProto : this.railProto.createInstance(`railL${i}`);
      const railR = this.railProto.createInstance(`railR${i}`);
      const lineL = i === 0 ? this.laneLineProto : this.laneLineProto.createInstance(`lineL${i}`);
      const lineR = this.laneLineProto.createInstance(`lineR${i}`);
      const tile = { index: i, floor, railL, railR, lineL, lineR, z: 0 };
      this.tiles.push(tile);
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
    this.columnProto = MeshBuilder.CreateCylinder('column', {
      diameterTop: 0.55, diameterBottom: 0.72, height: 5.2,
      tessellation: q.name === 'low' ? 8 : 16,
    }, this.ctx.scene);
    this.columnProto.material = mat.get('roseGold');
    this.columnProto.isPickable = false;
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

    // Corner pad: fills the square the two straight runs leave uncovered.
    // Deliberately oversized. A pad exactly the width of the corridor abuts
    // the two straight runs with zero overlap, and any rounding at all leaves
    // a hairline of background showing through at the corner. 1.6m of overlap
    // costs nothing and guarantees the corner is paved.
    const padProto = MeshBuilder.CreateBox('cornerPad', {
      width: w + 1.6, height: 0.34, depth: w + 1.6,
    }, scene);
    padProto.material = mat.get('trackFloor');
    padProto.receiveShadows = true;
    padProto.isPickable = false;
    padProto.position.set(this._parkZ, this._parkZ, this._parkZ);
    this.padProto = padProto;

    // Backstop wall: what you hit if you fail to turn. It is decoration —
    // the death itself is decided in path space by play/ — but without it the
    // player has no way to see that the corridor ends.
    const wallProto = MeshBuilder.CreateBox('junctionWall', {
      width: w + 2.2, height: 4.2, depth: 0.6,
    }, scene);
    wallProto.material = mat.get('darkChrome');
    wallProto.isPickable = false;
    wallProto.position.set(this._parkZ, this._parkZ, this._parkZ);
    this.wallProto = wallProto;

    // Direction chevrons.
    //
    // The first build of corners was mechanically correct and unplayable: from
    // the player's viewpoint the side corridor is edge-on and invisible, so a
    // corner read as "a wall appeared, you died" with no way to know which way
    // to go. These arrows are the fix, and they are gameplay, not decoration.
    this.chevronProto = this._makeArrowMesh('chevron');
    this.chevronProto.material = mat.get('signGold');
    this.chevronProto.isPickable = false;
    this.chevronProto.position.set(this._parkZ, this._parkZ, this._parkZ);

    this.wallArrowProto = this._makeWallArrowMesh('wallArrow');
    this.wallArrowProto.material = mat.get('signGold');
    this.wallArrowProto.isPickable = false;
    this.wallArrowProto.position.set(this._parkZ, this._parkZ, this._parkZ);

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
      const arrow = i === 0
        ? this.wallArrowProto
        : this.wallArrowProto.createInstance(`arrow${i}`);
      arrow.scaling.setAll(2.0);
      arrow.position.set(this._parkZ, this._parkZ, this._parkZ);

      this._junctionPool.push({
        pad: i === 0 ? padProto : padProto.createInstance(`pad${i}`),
        wall: i === 0 ? wallProto : wallProto.createInstance(`wall${i}`),
        chevrons,
        arrow,
        active: false,
      });
    }
    for (const j of this._junctionPool) {
      j.pad.position.set(this._parkZ, this._parkZ, this._parkZ);
      j.wall.position.set(this._parkZ, this._parkZ, this._parkZ);
    }
  }

  /**
   * Upright chevron standing in the XY plane, pointing along local +X.
   *
   * Authored standing up rather than laid flat and pitched into place: a
   * pitch rotation composed with a yaw was landing the arrow pointing at the
   * floor, and reasoning about Euler order to fix that is a worse use of time
   * than writing the five vertices in the orientation actually wanted.
   */
  _makeWallArrowMesh(name) {
    const m = new Mesh(name, this.ctx.scene);
    const vd = new VertexData();
    vd.positions = [
      0.85, 0, 0,
      -0.40, 0.62, 0,
      -0.40, -0.62, 0,
      -0.12, 0.30, 0,
      -0.12, -0.30, 0,
    ];
    vd.indices = [0, 1, 3, 0, 3, 4, 0, 4, 2];
    vd.normals = [0, 0, -1, 0, 0, -1, 0, 0, -1, 0, 0, -1, 0, 0, -1];
    vd.applyToMesh(m);
    return m;
  }

  /** A flat triangle lying in XZ, pointing along local +X. */
  _makeArrowMesh(name) {
    const m = new Mesh(name, this.ctx.scene);
    const vd = new VertexData();
    vd.positions = [
      0.85, 0, 0,
      -0.40, 0, 0.62,
      -0.40, 0, -0.62,
      -0.12, 0, 0.30,
      -0.12, 0, -0.30,
    ];
    // A solid triangle with a notch cut out of the tail reads as a chevron
    // rather than a road sign, which suits the jewellery language better.
    vd.indices = [0, 1, 3, 0, 3, 4, 0, 4, 2];
    vd.normals = [0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0];
    vd.applyToMesh(m);
    return m;
  }

  _buildObstaclePools() {
    const mat = this.ctx.get('mat');
    const scene = this.ctx.scene;
    const matFor = {
      [OB.LOW]: mat.get('yellowGold'),
      [OB.HIGH]: mat.get('darkChrome'),
      [OB.FULL]: mat.get('roseGold'),
    };

    for (const kind of [OB.LOW, OB.HIGH, OB.FULL]) {
      const s = OB_SIZE[kind];
      const proto = MeshBuilder.CreateBox(`ob${kind}`, {
        width: s.hx * 2, height: s.hy * 2, depth: s.hz * 2,
      }, scene);
      proto.material = matFor[kind];
      proto.isPickable = false;
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
    // A flattened octahedron reads as a star silhouette far more cheaply than
    // an actual star polygon, and reads correctly from every angle.
    // size 0.30 was the first guess and rendered as a half-metre gemstone that
    // blocked the view of the track. Collectibles must read as collectible
    // without competing with the obstacles behind them.
    const proto = MeshBuilder.CreatePolyhedron('star', {
      type: 1, size: 0.155,
    }, this.ctx.scene);
    proto.material = mat.get('yellowGold');
    proto.isPickable = false;
    proto.scaling.set(1, 1.25, 0.42);
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
      j.arrow.position.set(this._parkZ, this._parkZ, this._parkZ);
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
      p.pad.position.set(jn.wx, -0.175, jn.wz);
      const d = DIRS[jn.dir];
      // wall sits just beyond the corner, square across the old direction
      p.wall.position.set(jn.wx + d[0] * (w * 0.5 + 0.3), 2.1, jn.wz + d[1] * (w * 0.5 + 0.3));
      p.wall.rotation.y = Math.atan2(d[0], d[1]);

      // Chevrons on the approach, pointing the way the corner goes.
      // World direction of the turn: +right for a right turn, -right for left.
      const ax = jn.turn > 0 ? d[1] : -d[1];
      const az = jn.turn > 0 ? -d[0] : d[0];
      const yaw = Math.atan2(-az, ax);

      // The wall arrow only needs yaw — the mesh is already upright.
      p.arrow.rotation.y = yaw;
      // Stand the arrow clearly IN FRONT of the wall. It was at +0.02 while
      // the wall spans +0.0 to +0.6 in the same axis, so the arrow was buried
      // inside the wall's own volume and never drew — the corner had no
      // direction signage at all despite the code being there.
      p.arrow.position.set(
        jn.wx + d[0] * (w * 0.5 - 0.45),
        2.05,
        jn.wz + d[1] * (w * 0.5 - 0.45),
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
        p.arrow.position.set(this._parkZ, this._parkZ, this._parkZ);
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
      const s = OB_SIZE[kind];
      e.active = true;
      e.lane = lane;
      e.x = this._laneX(lane);
      e.z = z;
      this.path.toWorldExact(z, e.x, s.cy, this._w);
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
    this._spin = (this._spin || 0) + dtReal * 2.1;
    for (let i = 0; i < this.stars.length; i++) {
      this.stars[i].mesh.rotation.y = this._spin;
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
    this.path.toWorldExact(mid, 0, -0.175, this._w);
    tile.floor.position.set(this._w[0], this._w[1], this._w[2]);
    tile.floor.rotation.y = yaw;

    const laneOff = T.laneWidth * 0.5;
    this.path.toWorldExact(mid, -laneOff, 0.18, this._w);
    tile.lineL.position.set(this._w[0], this._w[1], this._w[2]);
    tile.lineL.rotation.y = yaw;
    this.path.toWorldExact(mid, laneOff, 0.18, this._w);
    tile.lineR.position.set(this._w[0], this._w[1], this._w[2]);
    tile.lineR.rotation.y = yaw;

    const railOff = trackWidth / 2 + 0.15;
    this.path.toWorldExact(mid, -railOff, 0.275, this._w);
    tile.railL.position.set(this._w[0], this._w[1], this._w[2]);
    tile.railL.rotation.y = yaw;
    this.path.toWorldExact(mid, railOff, 0.275, this._w);
    tile.railR.position.set(this._w[0], this._w[1], this._w[2]);
    tile.railR.rotation.y = yaw;

    // A column from either corridor can land squarely inside the corner
    // square, where it blocks the player's view of the exit entirely. The
    // corner is the one place in the game where seeing ahead matters most, so
    // columns are suppressed around junctions.
    const nearJunction = this._isNearJunction(s0, T.tileLength);
    if (tile.colL) {
      tile.colL.setEnabled(!nearJunction);
      tile.colR.setEnabled(!nearJunction);
      const colOff = trackWidth / 2 + 1.35;
      this.path.toWorldExact(mid, -colOff, 2.6, this._w);
      tile.colL.position.set(this._w[0], this._w[1], this._w[2]);
      this.path.toWorldExact(mid, colOff, 2.6, this._w);
      tile.colR.position.set(this._w[0], this._w[1], this._w[2]);
    }

    // Rails would visibly cut through a corner, so the tiles either side of a
    // junction go without them. The backstop wall reads as the corner.
    tile.railL.setEnabled(!nearJunction);
    tile.railR.setEnabled(!nearJunction);
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
      t.floor.dispose(); t.railL.dispose(); t.railR.dispose();
      t.lineL.dispose(); t.lineR.dispose();
      if (t.colL) { t.colL.dispose(); t.colR.dispose(); }
    }
    for (const j of this._junctionPool) {
      j.pad.dispose(); j.wall.dispose();
      for (const c of j.chevrons) c.dispose();
      j.arrow.dispose();
    }
    if (this.wallArrowProto) this.wallArrowProto.dispose();
    this.tiles.length = 0;
    for (const kind of [OB.LOW, OB.HIGH, OB.FULL]) {
      for (const e of this.pools[kind]) e.mesh.dispose();
    }
    for (const s of this._starPool) s.mesh.dispose();
    if (this.columnProto) this.columnProto.dispose();
  }
}
