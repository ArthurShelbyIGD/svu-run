// track/ — the endless track: tile pooling, recycling, and (later) the chunk
// generation grammar.
//
// OWNERSHIP: this directory owns the ground the player runs on and the
// structural geometry bolted to it. Decorative props belong to world/;
// obstacles will move here in Sprint 1 when the chunk grammar lands.
//
// Sprint 0 scope: a recycled scrolling floor with side rails and columns,
// enough to prove pooling, zero per-frame allocation, and the visual pipeline.

import { MeshBuilder, Vector3, Matrix } from '../core/bjs.js';
import { EV } from '../core/ctx.js';

const COLUMN_SPACING = 3; // one column pair every N tiles

export default class Track {
  constructor(ctx) {
    this.ctx = ctx;
    this.tiles = [];
    this.floorProto = null;
    this.railProto = null;
    this.columnProto = null;
    /** Index of the tile furthest along the track. */
    this.headIndex = 0;
    this._colMatrices = null;
    this._colBuffer = null;
    this._tmpMatrix = Matrix.Identity();
    this._pRecycle = { chunk: null };
  }

  init() {
    const T = this.ctx.config.tune;
    const mat = this.ctx.get('mat');
    const trackWidth = T.laneWidth * T.laneCount;

    // How many tiles must exist to cover the view distance, plus slack behind.
    this.tileCount = Math.ceil(T.viewDistance / T.tileLength) + 4;

    // --- floor ---
    this.floorProto = MeshBuilder.CreateBox('floor', {
      width: trackWidth,
      height: 0.35,
      depth: T.tileLength,
    }, this.ctx.scene);
    this.floorProto.material = mat.get('rhodium');
    this.floorProto.isPickable = false;
    this.floorProto.receiveShadows = true;
    this.floorProto.alwaysSelectAsActiveMesh = false;

    // --- side rails ---
    this.railProto = MeshBuilder.CreateBox('rail', {
      width: 0.30,
      height: 0.55,
      depth: T.tileLength,
    }, this.ctx.scene);
    this.railProto.material = mat.get('yellowGold');
    this.railProto.isPickable = false;

    // Build the pool. Each tile is a floor + two rails, positioned as a set.
    for (let i = 0; i < this.tileCount; i++) {
      const floor = i === 0 ? this.floorProto : this.floorProto.createInstance(`floor${i}`);
      const railL = i === 0 ? this.railProto : this.railProto.createInstance(`railL${i}`);
      const railR = this.railProto.createInstance(`railR${i}`);
      const tile = {
        index: i,
        floor, railL, railR,
        z: 0,
      };
      this.tiles.push(tile);
      this._placeTile(tile, i);
    }
    this.headIndex = this.tileCount - 1;

    this._buildColumns(trackWidth);
  }

  /** Decorative columns, drawn as thin instances — one draw call for all of them. */
  _buildColumns(trackWidth) {
    const T = this.ctx.config.tune;
    const mat = this.ctx.get('mat');
    const q = this.ctx.config.q;

    this.columnProto = MeshBuilder.CreateCylinder('column', {
      diameterTop: 0.55,
      diameterBottom: 0.72,
      height: 5.2,
      tessellation: q.name === 'low' ? 8 : 16,
    }, this.ctx.scene);
    this.columnProto.material = mat.get('roseGold');
    this.columnProto.isPickable = false;

    this.columnCount = Math.ceil(this.tileCount / COLUMN_SPACING) * 2;
    this._colBuffer = new Float32Array(this.columnCount * 16);
    this._colMatrices = [];

    const halfW = trackWidth / 2 + 1.35;
    for (let i = 0; i < this.columnCount; i++) {
      const pair = i >> 1;
      const side = (i & 1) ? 1 : -1;
      const z = pair * COLUMN_SPACING * T.tileLength;
      const m = Matrix.Translation(side * halfW, 2.6, z);
      this._colMatrices.push(m);
      m.copyToArray(this._colBuffer, i * 16);
    }
    this.columnProto.thinInstanceSetBuffer('matrix', this._colBuffer, 16, false);
    this.columnSpanZ = (this.columnCount / 2) * COLUMN_SPACING * T.tileLength;
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

  fixedUpdate() {
    const T = this.ctx.config.tune;
    const play = this.ctx.get('play');
    const behind = play.z - T.tileLength * 3;

    // Recycle any tile that has fallen behind the player to the front.
    // Pooled: no allocation, no mesh creation, no GC.
    for (let i = 0; i < this.tiles.length; i++) {
      const tile = this.tiles[i];
      if (tile.z + T.tileLength < behind) {
        this.headIndex++;
        this._placeTile(tile, this.headIndex);
        this._pRecycle.chunk = tile;
        this.ctx.emit(EV.CHUNK_RECYCLE, this._pRecycle);
      }
    }

    // Scroll the whole column field forward in one jump when the player passes
    // its span, rather than moving instances individually.
    if (this.columnProto) {
      const span = this.columnSpanZ;
      const target = Math.floor(play.z / span) * span;
      if (this.columnProto.position.z !== target) {
        this.columnProto.position.z = target;
      }
    }
  }

  dispose() {
    for (const t of this.tiles) {
      t.floor.dispose(); t.railL.dispose(); t.railR.dispose();
    }
    this.tiles.length = 0;
    if (this.columnProto) this.columnProto.dispose();
  }
}
