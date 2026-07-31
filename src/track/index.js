// track/ — the endless track: floor, obstacles, collectibles, and the chunk
// generation grammar that assembles them.
//
// OWNERSHIP: this directory owns the ground and everything bolted to it that
// the player interacts with. Decorative props belong to world/.
//
// Everything is pooled. No mesh is created or destroyed during play; the smoke
// test asserts total mesh count stays flat over a long run.

import { MeshBuilder, Vector3, Matrix } from '../core/bjs.js';
import { EV } from '../core/ctx.js';
import { OB, TEMPLATES, validateTemplates, pickTemplate } from './chunks.js';

export { OB };

const CHUNK_LEN = 48;          // metres per chunk
const COLUMN_SPACING = 3;      // one column pair every N tiles
const RECYCLE_BEHIND = 24;     // metres behind the player before recycling

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

    this._parkZ = -10000;    // where inactive pool members are hidden
    this._pRecycle = { chunk: null };
  }

  init() {
    validateTemplates(TEMPLATES, this.ctx.config.tune.laneCount);
    this._buildFloor();
    this._buildColumns();
    this._buildObstaclePools();
    this._buildStarPool();
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
    this.floorProto.material = mat.get('rhodium');
    this.floorProto.isPickable = false;
    this.floorProto.receiveShadows = true;

    this.railProto = MeshBuilder.CreateBox('rail', {
      width: 0.30, height: 0.55, depth: T.tileLength,
    }, this.ctx.scene);
    this.railProto.material = mat.get('yellowGold');
    this.railProto.isPickable = false;

    for (let i = 0; i < this.tileCount; i++) {
      const floor = i === 0 ? this.floorProto : this.floorProto.createInstance(`floor${i}`);
      const railL = i === 0 ? this.railProto : this.railProto.createInstance(`railL${i}`);
      const railR = this.railProto.createInstance(`railR${i}`);
      const tile = { index: i, floor, railL, railR, z: 0 };
      this.tiles.push(tile);
      this._placeTile(tile, i);
    }
    this.headIndex = this.tileCount - 1;
  }

  _buildColumns() {
    const T = this.ctx.config.tune;
    const mat = this.ctx.get('mat');
    const q = this.ctx.config.q;
    const trackWidth = T.laneWidth * T.laneCount;

    this.columnProto = MeshBuilder.CreateCylinder('column', {
      diameterTop: 0.55, diameterBottom: 0.72, height: 5.2,
      tessellation: q.name === 'low' ? 8 : 16,
    }, this.ctx.scene);
    this.columnProto.material = mat.get('roseGold');
    this.columnProto.isPickable = false;

    this.columnCount = Math.ceil(this.tileCount / COLUMN_SPACING) * 2;
    const buf = new Float32Array(this.columnCount * 16);
    const halfW = trackWidth / 2 + 1.35;
    for (let i = 0; i < this.columnCount; i++) {
      const pair = i >> 1;
      const side = (i & 1) ? 1 : -1;
      Matrix.Translation(side * halfW, 2.6, pair * COLUMN_SPACING * T.tileLength)
        .copyToArray(buf, i * 16);
    }
    this.columnProto.thinInstanceSetBuffer('matrix', buf, 16, false);
    this.columnSpanZ = (this.columnCount / 2) * COLUMN_SPACING * T.tileLength;
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
    for (const s of this._starPool) this._park(s);
    this.obstacles.length = 0;
    this.stars.length = 0;
    this.generatedTo = 0;
    this.lastTemplate = null;
    this.chunkCount = 0;

    // Give the player a clear run-up before anything appears.
    this.generatedTo = this.ctx.config.tune.startSpeed * 2.2;
    for (let i = 0; i < 4; i++) this._generateChunk();
  }

  /** Difficulty ramps with distance, then plateaus. */
  difficultyAt(z) {
    return Math.min(1, z / 1400);
  }

  _generateChunk() {
    const T = this.ctx.config.tune;
    const rng = this.ctx.rng;
    const z0 = this.generatedTo;
    const diff = this.difficultyAt(z0);

    const tpl = pickTemplate(rng, diff, this.lastTemplate);
    this.lastTemplate = tpl;
    this.chunkCount++;

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
      e.mesh.position.set(e.x, s.cy, z);
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
      s.mesh.position.set(s.x, y, z);
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
  }

  renderUpdate(dtReal) {
    // Stars spin. One shared rotation value applied to active stars only.
    this._spin = (this._spin || 0) + dtReal * 2.1;
    for (let i = 0; i < this.stars.length; i++) {
      this.stars[i].mesh.rotation.y = this._spin;
    }

    // Scroll the column field forward in one jump per span.
    if (this.columnProto) {
      const play = this.ctx.get('play');
      const span = this.columnSpanZ;
      const target = Math.floor(play.z / span) * span;
      if (this.columnProto.position.z !== target) this.columnProto.position.z = target;
    }
  }

  _placeTile(tile, index) {
    const T = this.ctx.config.tune;
    const z = index * T.tileLength;
    const trackWidth = T.laneWidth * T.laneCount;
    tile.z = z;
    tile.index = index;
    tile.floor.position.set(0, -0.175, z);
    tile.railL.position.set(-(trackWidth / 2 + 0.15), 0.275, z);
    tile.railR.position.set(trackWidth / 2 + 0.15, 0.275, z);
  }

  /** Half-extents for an obstacle kind. Read by coll/. */
  sizeOf(kind) { return OB_SIZE[kind]; }

  dispose() {
    for (const t of this.tiles) { t.floor.dispose(); t.railL.dispose(); t.railR.dispose(); }
    this.tiles.length = 0;
    for (const kind of [OB.LOW, OB.HIGH, OB.FULL]) {
      for (const e of this.pools[kind]) e.mesh.dispose();
    }
    for (const s of this._starPool) s.mesh.dispose();
    if (this.columnProto) this.columnProto.dispose();
  }
}
