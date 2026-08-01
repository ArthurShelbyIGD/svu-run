// world/props.js — the architecture that flanks the track.
//
// THE PROBLEM THIS SOLVES, in the owner's words: "Temple Run has lots of
// details, we have Minecraft looking blocks." The world was a pair of tapered
// cylinders repeated forever. This file replaces that read with a real
// colonnade: fluted shafts on moulded plinths, carved capitals, transverse
// arches vaulting the track, a dentilled cornice, a parapet, an outer arcade
// receding into the haze, hanging lanterns, and wayside plinths with star
// finials and fallen masonry.
//
// HOW IT STAYS CHEAP.
// All of that is FOUR prototype meshes — one per material — each holding a
// complete 24m bay of architecture, drawn as thin instances. A bay is ~5k
// triangles and the whole visible world is about a dozen bays, so the entire
// colonnade is 4-6 draw calls regardless of how far you can see.
//
// HOW IT FOLLOWS CORNERS.
// Every instance is placed with track.path.toWorldExact / yawExactAt, the same
// unblended conversion the floor tiles use. Static geometry must never use the
// blended conversion — see the CORNER_BLEND note in track/path.js.
//
// The track's own columns still exist and are owned by track/. Rather than
// fight that, the bay's shafts are sized to swallow them: minimum shaft radius
// is 0.37m everywhere against the track cylinder's 0.36m -> 0.275m taper, so
// the plain cylinder sits entirely inside the fluted one and never shows.

import {
  MeshBuilder, Mesh, Matrix, Vector3, Quaternion, StandardMaterial,
  DynamicTexture, Texture, Color3, Constants,
} from '../core/bjs.js';
import { box, cyl, gem, flutedShaft, arch, star, mergeBucket } from './geo.js';

export const BAY_LEN = 24;
const COL_X = 4.95;              // matches the track's own column offset
const COL_Z = [-8, 0, 8];
const SPRING_Y = 5.26;           // top of the abacus: where arches spring
const AHEAD = 210;               // metres of architecture kept ahead
const BEHIND = 34;
const BAY_SLOTS = Math.ceil((AHEAD + BEHIND) / BAY_LEN) + 2;
const ACCENT_SLOTS = 14;
const COL_STEP = 8;              // metres between columns, matching the track
const COL_SLOTS = Math.ceil((AHEAD + BEHIND) / COL_STEP) * 2 + 4;
// The track suppresses its own columns within 16m of a junction. Mine must
// use the SAME number or the two disagree and a bare cylinder shows through.
const COL_JUNCTION_SPAN = 16.5;
const ACCENT_X = 7.7;

export default class Props {
  constructor(ctx) {
    this.ctx = ctx;
    this.meshes = [];
    this.bayBufs = [];
    this.colBufs = [];
    this.accentBufs = [];
    this._nextColS = 0;
    this._colSlot = 0;
    this._m = new Matrix();
    this._q = new Quaternion();
    this._s = new Vector3(1, 1, 1);
    this._p = new Vector3();
    this._w = [0, 0, 0];
    this._nextBayS = 0;
    this._nextAccentS = 0;
    this._baySlot = 0;
    this._accentSlot = 0;
    this._rng = null;
  }

  init() {
    const scene = this.ctx.scene;
    const mat = this.ctx.get('mat');
    const q = this.ctx.config.q;
    // A private stream, forked from ctx.rng so the world is still seeded by
    // the run seed but its consumption cannot shift the track's generation.
    this._rng = this.ctx.rng.fork();
    this._rngSeed = this._rng.seed;

    this._buildBay(scene, mat, q);
    this._buildColumn(scene, mat, q);
    this._buildAccents(scene, mat, q);
    this._buildShafts(scene, q);
    this.reset();
  }

  // ---- prototypes ------------------------------------------------------

  _buildBay(scene, mat, q) {
    const low = q.name === 'low';
    const tess = low ? 8 : 16;
    const L = [];   // marbleLight  — shafts, capitals, voussoirs
    const D = [];   // marbleDark   — plinths and parapet, the darkest accents
    const G = [];   // goldTrim     — rings, abaci, keystones, dentils, chains
    const M = [];   // emissive     — lantern gems
    const F = [];   // marbleDark   — the hall floor, placed on its own rules

    // --- the floor of the hall ---
    // Without this the colonnade stands on nothing: the wide shot showed the
    // whole arcade floating over a black void, because the only floor in the
    // game is the 7.2m track itself. It sits below the track surface so the
    // two never fight, and it is a separate prototype because unlike the rest
    // of a bay it must NOT be suppressed at junctions — a hole in the ground
    // at every corner would be far worse than architecture in the way.
    box(scene, F, 62, 0.26, BAY_LEN, 0, -0.21, 0);
    for (const sx of [-1, 1]) {
      box(scene, F, 0.5, 0.34, BAY_LEN, sx * 30.6, -0.10, 0);   // outer kerb
      box(scene, F, 0.36, 0.12, BAY_LEN, sx * 4.30, -0.02, 0);  // track verge
      // Inlaid strips running with the path. A bare slab this size reads as a
      // car park; two lines of gold turn it into a floor that was designed,
      // and they stream past at speed, which the eye reads as velocity.
      box(scene, G, 0.16, 0.06, BAY_LEN, sx * 8.60, -0.05, 0);
      box(scene, G, 0.10, 0.06, BAY_LEN, sx * 17.4, -0.05, 0);
      // ...and cross-bands, so the slab reads as paving rather than as one
      // enormous matt panel. This is the same complaint as the cornice: area
      // without incident is what makes a surface look untextured.
      for (const cz of COL_Z) {
        box(scene, F, 22.0, 0.05, 0.34, sx * 15.6, -0.06, cz);
      }
    }

    // Columns are NOT part of the bay — see _buildColumn. Nothing spans the
    // corridor except the single vault below: an earlier pass put a full arch
    // on every column and the result was a ribcage that sealed the corridor
    // completely; a slimmer tie rod instead read as a horizontal bar at eye
    // level, which in a runner looks like an obstacle.

    // --- the one transverse arch that vaults the track, at the bay centre ---
    arch(scene, L, G, {
      axis: 'x', x: 0, z: 0,
      radius: COL_X, springY: SPRING_Y,
      voussoirs: low ? 9 : 13, thickness: 0.62, width: 1.20,
    });

    // --- cornice, dentils and parapet running the length of the bay ---
    //
    // Profiled, not slabbed. The first version was a single 1.15m-wide box
    // 24m long, and in the wide shot its underside was one enormous unbroken
    // white plane filling a third of the frame — the exact "Minecraft block"
    // read this whole file exists to kill. A corona over a dentil course over
    // a bed mould breaks that plane into four lit steps for 36 extra
    // triangles.
    const half = BAY_LEN * 0.5;
    for (const sx of [-1, 1]) {
      const x = sx * 5.90;
      box(scene, L, 0.62, 0.20, BAY_LEN, sx * 5.62, 5.06, 0);   // bed mould
      box(scene, L, 0.86, 0.34, BAY_LEN, x, 5.42, 0);            // corona
      box(scene, G, 1.02, 0.08, BAY_LEN, x, 5.63, 0);            // fillet
      box(scene, L, 0.70, 0.26, BAY_LEN, sx * 6.02, 5.80, 0);    // cyma
      box(scene, D, 0.30, 0.50, BAY_LEN, sx * 6.16, 6.18, 0);    // parapet
      const step = low ? 1.7 : 1.0;
      for (let z = -half + step * 0.5; z < half; z += step) {
        box(scene, G, 0.17, 0.22, 0.17, sx * 5.98, 5.22, z);
      }
    }

    // --- outer aisle: a LOW ruined arcade beyond the colonnade ---
    // Deliberately capped below the cornice line, and in DARK marble. An
    // earlier pass had it 8m tall in pale marble: it filled exactly the band
    // of sky the clerestory windows live in, so the panorama was built, lit
    // and then hidden behind a wall of white blocks. Low and dark, it reads
    // as depth at ground level instead of competing with the colonnade.
    if (!low) {
      for (const sx of [-1, 1]) {
        const x = sx * 12.4;
        for (const cz of COL_Z) {
          box(scene, D, 1.30, 4.10, 1.30, x, 2.05, cz);
        }
        for (const az of [-4, 4, 12]) {
          arch(scene, D, G, {
            axis: 'z', x, z: az,
            radius: 3.30, springY: 2.80,
            voussoirs: 9, thickness: 0.42, width: 1.05,
          });
        }
        box(scene, D, 1.55, 0.34, BAY_LEN, x, 4.28, 0);
        box(scene, G, 1.68, 0.07, BAY_LEN, x, 4.49, 0);
      }

      // --- distant pylons ---
      // Real geometry far enough out that it only shows through fog. It gives
      // the panorama something to parallax against, which is what stops a
      // painted backdrop reading as painted — and being narrow and widely
      // spaced, it interrupts the sky instead of replacing it.
      for (const sx of [-1, 1]) {
        box(scene, L, 1.40, 11.5, 1.40, sx * 24.0, 5.75, 0);
        box(scene, G, 1.80, 0.28, 1.80, sx * 24.0, 11.64, 0);
        box(scene, D, 1.95, 0.44, 1.95, sx * 24.0, 0.22, 0);
      }
    }

    // --- hanging lanterns ---
    // A lantern under the centre arch and one off each cornice. These are the
    // only local light events in the world; without them the corridor has a
    // single global key and reads flat.
    cyl(scene, G, 0.07, 0.07, 1.30, 0, 9.50, 0, 6);
    cyl(scene, G, 0.46, 0.16, 0.28, 0, 8.72, 0, tess);
    gem(scene, M, 0.42, 0, 8.22, 0, 1);
    for (const sx of [-1, 1]) {
      for (const cz of [-8, 8]) {
        cyl(scene, G, 0.05, 0.05, 0.62, sx * 6.0, 5.00, cz, 6);
        cyl(scene, G, 0.30, 0.11, 0.20, sx * 6.0, 4.60, cz, tess);
        gem(scene, M, 0.26, sx * 6.0, 4.28, cz, 1);
      }
    }

    this.bayLight = mergeBucket(scene, 'bayLight', L, mat.get('marbleLight'));
    this.bayDark = mergeBucket(scene, 'bayDark', D, mat.get('marbleDark'));
    // Everything structural is dielectric marble, never a metallic "stone":
    // a metallic surface in a dark room reflects a dark room and renders as a
    // black slab, which is how the first pass lost its whole outer aisle.
    this.bayGold = mergeBucket(scene, 'bayGold', G, mat.get('goldTrim'));

    // Lit, NOT unlit. A fully emissive faceted gem renders every facet the
    // same colour, so it reads on screen as a flat gold hexagon rather than a
    // stone. Keeping a diffuse and a specular term lets the facets separate,
    // and the emissive floor keeps it glowing in a black corridor.
    this.gemMat = new StandardMaterial('worldGem', scene);
    this.gemMat.diffuseColor = new Color3(0.35, 0.28, 0.14);
    this.gemMat.specularColor = new Color3(1, 0.94, 0.82);
    this.gemMat.specularPower = 24;
    this.gemMat.emissiveColor = new Color3(1, 0.8, 0.4);
    this.bayGem = mergeBucket(scene, 'bayGem', M, this.gemMat);

    for (const m of [this.bayLight, this.bayDark, this.bayGold, this.bayGem]) {
      if (m) this.bayBufs.push(this._alloc(m, BAY_SLOTS));
    }

    // Dielectric, not metallic. A rough metal floor was tried here and read
    // fine in capture — which is exactly the trap ARCHITECTURE section 7
    // documents: the last mirror-ish floor this project shipped looked correct
    // in every screenshot and rendered near-white on real hardware. A surface
    // this large does not get to depend on what it is reflecting.
    this.bayFloor = mergeBucket(scene, 'bayFloor', F, mat.get('marbleDark'));
    this.floorBuf = this._alloc(this.bayFloor, BAY_SLOTS);
  }

  /**
   * One column, placed individually rather than baked into the bay.
   *
   * WHY IT IS NOT PART OF THE BAY. The bay is 24m long and gets suppressed
   * wholesale near a junction so the arcade never hides the corner exit. The
   * track suppresses ITS columns on a different, tighter rule — so at every
   * corner there was a band where my bay was gone but the track's plain
   * cylinder was not, and a bare pink tube stood in the middle of an otherwise
   * carved colonnade. That is visible in exactly one place, twenty metres
   * before every corner, and no test can see it.
   *
   * Placing columns one at a time lets them use the same junction rule the
   * track uses, so the fluted shaft is present wherever the cylinder it hides
   * is present. Three extra draw calls; the defect goes away completely.
   */
  _buildColumn(scene, mat, q) {
    const low = q.name === 'low';
    const tess = low ? 8 : 16;
    const L = [], D = [], G = [];

    box(scene, D, 1.42, 0.42, 1.42, 0, 0.21, 0);
    box(scene, G, 1.30, 0.08, 1.30, 0, 0.46, 0);
    cyl(scene, L, 1.06, 1.26, 0.28, 0, 0.64, 0, tess);
    flutedShaft(scene, L, {
      rBottom: 0.52, rTop: 0.44, height: 3.68,
      flutes: low ? 8 : 14, depth: 0.15,
      radial: low ? 16 : 30, rings: 3,
      x: 0, y: 0.78, z: 0,
    });
    cyl(scene, G, 0.98, 0.98, 0.12, 0, 4.52, 0, tess);
    cyl(scene, L, 1.26, 0.92, 0.36, 0, 4.76, 0, tess);
    box(scene, G, 1.36, 0.32, 1.36, 0, 5.10, 0);
    if (!low) {
      for (const [ox, oz] of [[-0.58, -0.58], [0.58, -0.58], [-0.58, 0.58], [0.58, 0.58]]) {
        box(scene, G, 0.30, 0.18, 0.30, ox, 4.80, oz, 0.785);
      }
    }

    this.colLight = mergeBucket(scene, 'colLight', L, mat.get('marbleLight'));
    this.colDark = mergeBucket(scene, 'colDark', D, mat.get('marbleDark'));
    this.colGold = mergeBucket(scene, 'colGold', G, mat.get('goldTrim'));
    for (const m of [this.colLight, this.colDark, this.colGold]) {
      if (m) this.colBufs.push(this._alloc(m, COL_SLOTS));
    }
  }

  _buildAccents(scene, mat, q) {
    const low = q.name === 'low';
    const S = [];  // stonePolished — plinth and fallen masonry
    const G = [];  // goldLeaf      — star finial and its stand

    // stepped plinth
    box(scene, S, 2.00, 0.36, 2.00, 0, 0.18, 0);
    box(scene, S, 1.58, 0.46, 1.58, 0, 0.59, 0);
    box(scene, S, 1.22, 0.30, 1.22, 0, 0.97, 0);
    box(scene, S, 0.94, 0.18, 0.94, 0, 1.21, 0);
    // broken masonry tumbled around the foot — the detail that says "old"
    box(scene, S, 0.78, 0.52, 0.66, 1.42, 0.24, -0.86, 0.42, 0, 0.16);
    box(scene, S, 0.62, 0.44, 0.58, -1.32, 0.20, 0.94, -0.65, 0.12, 0);
    box(scene, S, 0.90, 0.34, 0.52, 1.05, 0.16, 1.32, 1.10, 0, -0.09);
    if (!low) {
      box(scene, S, 0.44, 0.40, 0.46, -1.60, 0.19, -1.10, 0.25, 0.2, 0.1);
      cyl(scene, S, 0.46, 0.52, 0.72, -1.85, 0.36, 0.10, 8);
    }

    cyl(scene, G, 0.16, 0.24, 0.70, 0, 1.63, 0, 8);
    star(scene, G, { outer: 0.82, inner: 0.36, thick: 0.17, x: 0, y: 2.55, z: 0, ry: 0 });

    this.accentStone = mergeBucket(scene, 'accentStone', S, mat.get('stonePolished'));
    this.accentGold = mergeBucket(scene, 'accentGold', G, mat.get('goldLeaf'));
    for (const m of [this.accentStone, this.accentGold]) {
      if (m) this.accentBufs.push(this._alloc(m, ACCENT_SLOTS));
    }
    // The star is hidden on some plinths (a broken, empty pedestal), so the
    // gold buffer is written independently of the stone one.
    this.accentGoldBuf = this.accentBufs[1];
  }

  /**
   * Shafts of light crossing the corridor.
   *
   * One additive quad per bay, in the plane across the track, so the chase
   * camera always sees it face-on. This is the cheapest possible stand-in for
   * volumetric light and it does more for the "vast interior" read than any
   * amount of extra masonry.
   */
  _buildShafts(scene, q) {
    if (q.name === 'low') { this.shaftMesh = null; return; }
    const size = 128;
    const tex = new DynamicTexture('lightShaft', { width: size, height: size }, scene, true);
    const c = tex.getContext();
    c.clearRect(0, 0, size, size);
    const v = c.createLinearGradient(0, 0, 0, size);
    v.addColorStop(0, 'rgba(255,242,215,0.42)');
    v.addColorStop(0.5, 'rgba(255,232,190,0.16)');
    v.addColorStop(1, 'rgba(255,225,175,0)');
    c.fillStyle = v;
    c.fillRect(0, 0, size, size);
    // soften the vertical edges so the quad has no visible boundary
    c.globalCompositeOperation = 'destination-in';
    const hgr = c.createLinearGradient(0, 0, size, 0);
    hgr.addColorStop(0, 'rgba(0,0,0,0)');
    hgr.addColorStop(0.35, 'rgba(0,0,0,1)');
    hgr.addColorStop(0.65, 'rgba(0,0,0,1)');
    hgr.addColorStop(1, 'rgba(0,0,0,0)');
    c.fillStyle = hgr;
    c.fillRect(0, 0, size, size);
    c.globalCompositeOperation = 'source-over';
    tex.update(false);
    tex.hasAlpha = true;
    this.shaftTex = tex;

    const m = new StandardMaterial('lightShaftMat', scene);
    m.disableLighting = true;
    m.diffuseColor = new Color3(0, 0, 0);
    m.specularColor = new Color3(0, 0, 0);
    // Same trick as the sky dome: pattern in the diffuse slot, tint in
    // emissiveColor, because the standard shader adds emissive and multiplies
    // diffuse. See the note in sky.js.
    m.diffuseTexture = tex;
    m.emissiveColor = new Color3(1, 0.86, 0.62);
    m.opacityTexture = tex;
    m.opacityTexture.getAlphaFromRGB = false;
    m.alphaMode = Constants.ALPHA_ADD;
    m.backFaceCulling = false;
    m.disableDepthWrite = true;
    this.shaftMat = m;

    const plane = MeshBuilder.CreatePlane('lightShaft', { width: 9.5, height: 13 }, scene);
    plane.position.set(0, 6.6, 0);
    plane.bakeCurrentTransformIntoVertices();
    plane.material = m;
    plane.isPickable = false;
    // Fogged, deliberately. Unfogged additive quads stacked down a straight
    // corridor sum to a flat cream whiteout at the vanishing point, which is
    // exactly what the first build did.
    this.shaftMesh = plane;
    this.shaftBuf = this._alloc(plane, BAY_SLOTS);
  }

  _alloc(mesh, count) {
    const buf = new Float32Array(count * 16);
    mesh.thinInstanceSetBuffer('matrix', buf, 16, false);
    mesh.alwaysSelectAsActiveMesh = true;
    mesh.doNotSyncBoundingInfo = true;
    mesh.isPickable = false;
    this.meshes.push(mesh);
    return buf;
  }

  // ---- placement -------------------------------------------------------

  reset() {
    this._rng.reset(this._rngSeed);
    this._baySlot = 0;
    this._accentSlot = 0;
    this._nextBayS = -BAY_LEN;
    this._nextColS = -BAY_LEN + 4;
    this._colSlot = 0;
    this._nextAccentS = 40;
    for (const b of this.bayBufs) b.fill(0);
    for (const b of this.colBufs) b.fill(0);
    for (const b of this.accentBufs) b.fill(0);
    if (this.floorBuf) this.floorBuf.fill(0);
    if (this.shaftBuf) this.shaftBuf.fill(0);
    this._flush();
  }

  /**
   * Extend the architecture ahead of the player. Called from fixedUpdate, so:
   * no allocation, and the slot ring recycles rather than creating anything.
   */
  update(playZ, track) {
    const path = track.path;
    // Never place beyond the generated path — extrapolating past the last
    // segment would put a whole bay on the wrong side of a corner.
    const limit = Math.min(playZ + AHEAD, path.end - BAY_LEN);
    let dirty = false;

    while (this._nextBayS + BAY_LEN * 0.5 < limit) {
      const mid = this._nextBayS + BAY_LEN * 0.5;
      this._placeBay(this._baySlot % BAY_SLOTS, mid, path, track);
      this._baySlot++;
      this._nextBayS += BAY_LEN;
      dirty = true;
    }

    while (this._nextColS < limit) {
      this._placeColumnPair(this._nextColS, path, track);
      this._nextColS += COL_STEP;
      dirty = true;
    }

    while (this._nextAccentS < limit) {
      this._placeAccent(this._accentSlot % ACCENT_SLOTS, this._nextAccentS, path, track);
      this._accentSlot++;
      this._nextAccentS += this._rng.range(26, 62);
      dirty = true;
    }

    if (dirty) this._flush();
  }

  _placeColumnPair(s, path, track) {
    const hidden = this._nearJunction(s, COL_JUNCTION_SPAN, track);
    const yaw = hidden ? 0 : path.yawExactAt(s);
    for (let side = 0; side < 2; side++) {
      const slot = (this._colSlot++) % COL_SLOTS;
      const o = slot * 16;
      if (hidden) {
        for (const b of this.colBufs) b.fill(0, o, o + 16);
        continue;
      }
      path.toWorldExact(s, side === 0 ? -COL_X : COL_X, 0, this._w);
      Matrix.RotationYToRef(yaw, this._m);
      this._m.setTranslationFromFloats(this._w[0], this._w[1], this._w[2]);
      for (const b of this.colBufs) this._m.copyToArray(b, o);
    }
  }

  _nearJunction(s, span, track) {
    const js = track.junctions;
    for (let i = 0; i < js.length; i++) {
      if (Math.abs(js[i].s - s) < span) return true;
    }
    return false;
  }

  _placeBay(slot, mid, path, track) {
    // An arcade standing in the corner square hides the exit, which is the one
    // place in the game where seeing ahead decides whether you live. Bays over
    // a junction are simply left empty; the backstop wall reads as the corner.
    const hidden = this._nearJunction(mid, 13, track);
    const o = slot * 16;
    const yaw = path.yawExactAt(mid);
    path.toWorldExact(mid, 0, 0, this._w);

    // The floor first, and always — including over junctions, where the two
    // perpendicular corridors' floors overlap. Coplanar overlapping slabs
    // z-fight, so each slab is nudged a few millimetres by its heading and by
    // its parity along the run. Both are far below anything the eye can
    // resolve and both guarantee a unique winner in every overlap.
    const dir = path.segmentAt(mid).dir;
    const lift = -0.21 + dir * 0.006 + (this._baySlot & 1) * 0.003;
    Matrix.RotationYToRef(yaw, this._m);
    this._m.setTranslationFromFloats(this._w[0], lift, this._w[2]);
    this._m.copyToArray(this.floorBuf, o);

    if (hidden) {
      for (const b of this.bayBufs) b.fill(0, o, o + 16);
      if (this.shaftBuf) this.shaftBuf.fill(0, o, o + 16);
      return;
    }
    this._m.setTranslationFromFloats(this._w[0], this._w[1], this._w[2]);
    for (const b of this.bayBufs) this._m.copyToArray(b, o);
    if (this.shaftBuf) {
      // Every third bay gets a shaft. Every bay is a fog machine; every third
      // is a cathedral.
      if (this._baySlot % 3 === 0) this._m.copyToArray(this.shaftBuf, o);
      else this.shaftBuf.fill(0, o, o + 16);
    }
  }

  _placeAccent(slot, s, path, track) {
    const o = slot * 16;
    const stoneBuf = this.accentBufs[0];
    const goldBuf = this.accentBufs[1];
    if (this._nearJunction(s, 16, track)) {
      stoneBuf.fill(0, o, o + 16);
      goldBuf.fill(0, o, o + 16);
      return;
    }
    const side = this._rng.chance(0.5) ? -1 : 1;
    const lat = side * (ACCENT_X + this._rng.range(-0.4, 0.9));
    const yaw = path.yawExactAt(s) + this._rng.range(-0.35, 0.35);
    const sc = this._rng.range(0.85, 1.35);
    path.toWorldExact(s, lat, 0, this._w);
    this._s.set(sc, sc, sc);
    Quaternion.RotationYawPitchRollToRef(yaw, 0, 0, this._q);
    this._p.set(this._w[0], this._w[1], this._w[2]);
    Matrix.ComposeToRef(this._s, this._q, this._p, this._m);
    this._m.copyToArray(stoneBuf, o);
    // Two plinths in three still carry their star; the rest are empty and
    // broken, which is what keeps the set dressing from looking stamped out.
    if (this._rng.chance(0.62)) {
      const fy = this._rng.range(-0.6, 0.6);
      Quaternion.RotationYawPitchRollToRef(yaw + fy, 0, 0, this._q);
      Matrix.ComposeToRef(this._s, this._q, this._p, this._m);
      this._m.copyToArray(goldBuf, o);
    } else {
      goldBuf.fill(0, o, o + 16);
    }
  }

  _flush() {
    for (const m of this.meshes) m.thinInstanceBufferUpdated('matrix');
  }

  /** Zone tint for the emissive bits. Called from renderUpdate. */
  setGlow(r, g, b) {
    if (this.gemMat) this.gemMat.emissiveColor.set(r, g, b);
    if (this.shaftMat) {
      this.shaftMat.emissiveColor.set(
        0.55 + r * 0.45, 0.50 + g * 0.45, 0.42 + b * 0.45,
      );
    }
  }

  /** Every mesh that should cast a shadow. */
  casters() {
    return [this.colLight, this.bayLight, this.bayDark, this.accentStone];
  }

  dispose() {
    // Only the materials this module made. bayLight/Dark/Gold borrow shared
    // materials from mat/, which owns and disposes them.
    for (const m of this.meshes) m.dispose();
    this.meshes.length = 0;
    if (this.gemMat) this.gemMat.dispose();
    if (this.shaftMat) this.shaftMat.dispose();
    if (this.shaftTex) this.shaftTex.dispose();
  }
}
