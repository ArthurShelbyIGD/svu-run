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
// All of that is a handful of prototype meshes — one per material per family
// (bay run, column, accent, floor) — drawn as thin instances. The entire
// visible world is about a dozen draw calls regardless of how far you can
// see, and around 50k triangles on the low preset.
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
import { box, cyl, gem, slab, flutedShaft, arch, star, mergeBucket } from './geo.js';

export const BAY_LEN = 24;
const COL_X = 4.95;              // matches the track's own column offset
const COL_Z = [-8, 0, 8];
const SPRING_Y = 5.26;           // top of the abacus: where arches spring
// Fog closes at 205m and the track only generates to 180m ahead, so anything
// past this is paying full vertex cost to be invisible.
const AHEAD = 184;               // metres of architecture kept ahead
const BEHIND = 28;
const BAY_SLOTS = Math.ceil((AHEAD + BEHIND) / BAY_LEN) + 2;
const ACCENT_SLOTS = 14;
const COL_STEP = 8;              // metres between columns, matching the track
const COL_SLOTS = Math.ceil((AHEAD + BEHIND) / COL_STEP) * 2 + 4;
// The track suppresses its own columns within 16m of a junction. Mine must
// use the SAME number or the two disagree and a bare cylinder shows through.
const COL_JUNCTION_SPAN = 16.5;
const ACCENT_X = 7.7;
const RUNNER_STEP = 8;           // metres per inlaid road panel
const RUNNER_SLOTS = Math.ceil((AHEAD + BEHIND) / RUNNER_STEP) + 3;

export default class Props {
  constructor(ctx) {
    this.ctx = ctx;
    this.meshes = [];
    this.bayBufs = [];
    this.colBufs = [];
    this.accentBufs = [];
    this.runnerBufs = [];
    this._nextRunnerS = 0;
    this._runnerSlot = 0;
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
    // Capture affordance only — see World.setZoneBias. Shifts the distance the
    // zone lookup reads so a shot can be posed inside zone 4 without running
    // 2500 metres to get there. Zero in play.
    this.zoneBias = 0;
  }

  init() {
    const scene = this.ctx.scene;
    const mat = this.ctx.get('mat');
    const q = this.ctx.config.q;
    // A private stream, forked from ctx.rng so the world is still seeded by
    // the run seed but its consumption cannot shift the track's generation.
    this._rng = this.ctx.rng.fork();
    this._rngSeed = this._rng.seed;

    this._buildContactMaterials(scene);
    this._buildRunner(scene, mat, q);
    this._buildBay(scene, mat, q);
    this._buildColumn(scene, mat, q);
    this._buildAccents(scene, mat, q);
    this._buildShafts(scene, q);
    this.reset();
  }

  // ---- prototypes ------------------------------------------------------

  /**
   * BAKED CONTACT OCCLUSION.
   *
   * A cast shadow says where the light is. Contact occlusion says where the
   * ground is — and it is the thing whose absence made everything in this
   * scene look like it was hovering a centimetre off the floor. Two
   * multiply-blended gradients do the whole job:
   *
   *   aoPatch  a radial pool, dropped under every column and every plinth
   *   aoStrip  a symmetric band, run along every wall/floor junction
   *
   * They cost two draw calls per family and, unlike the shadow map, they are
   * present on the `low` preset, where `q.shadows` is false and there is
   * otherwise no darkening anywhere in the frame at all.
   */
  _buildContactMaterials(scene) {
    const S = 128;

    const patch = new DynamicTexture('aoPatch', { width: S, height: S }, scene, true);
    {
      const c = patch.getContext();
      c.clearRect(0, 0, S, S);
      const g = c.createRadialGradient(S / 2, S / 2, 1, S / 2, S / 2, S / 2);
      // Not a linear ramp: real occlusion falls off fast near the object and
      // then lingers. A straight gradient reads as an airbrushed blob.
      g.addColorStop(0.00, 'rgba(0,0,0,0.86)');
      g.addColorStop(0.22, 'rgba(0,0,0,0.62)');
      g.addColorStop(0.50, 'rgba(0,0,0,0.24)');
      g.addColorStop(0.78, 'rgba(0,0,0,0.06)');
      g.addColorStop(1.00, 'rgba(0,0,0,0)');
      c.fillStyle = g;
      c.fillRect(0, 0, S, S);
      patch.update(false);
      patch.hasAlpha = true;
    }

    const strip = new DynamicTexture('aoStrip', { width: S, height: 4 }, scene, true);
    {
      const c = strip.getContext();
      c.clearRect(0, 0, S, 4);
      // Symmetric across u, so ONE texture grounds both sides of a wall foot
      // and the same mesh works mirrored on the far side of the corridor.
      const g = c.createLinearGradient(0, 0, S, 0);
      g.addColorStop(0.00, 'rgba(0,0,0,0)');
      g.addColorStop(0.34, 'rgba(0,0,0,0.30)');
      g.addColorStop(0.50, 'rgba(0,0,0,0.72)');
      g.addColorStop(0.66, 'rgba(0,0,0,0.30)');
      g.addColorStop(1.00, 'rgba(0,0,0,0)');
      c.fillStyle = g;
      c.fillRect(0, 0, S, 4);
      strip.update(false);
      strip.hasAlpha = true;
    }

    this.aoTextures = [patch, strip];
    this.aoMats = [patch, strip].map((tex, i) => {
      const m = new StandardMaterial(i === 0 ? 'aoPatchMat' : 'aoStripMat', scene);
      m.disableLighting = true;
      m.diffuseColor = new Color3(0, 0, 0);
      m.specularColor = new Color3(0, 0, 0);
      m.emissiveColor = new Color3(0, 0, 0);
      m.opacityTexture = tex;
      m.opacityTexture.getAlphaFromRGB = false;
      m.backFaceCulling = false;
      m.disableDepthWrite = true;
      // Fogged like everything else, so occlusion dissolves into the haze at
      // distance instead of staying a hard black smear at the vanishing point.
      m.fogEnabled = true;
      return m;
    });
  }

  /**
   * THE ONYX RUNNER — an inlaid panel laid down the middle of the road.
   *
   * WHY THIS EXISTS, AND WHY IT IS AWKWARD.
   * The critic's top two notes were "no column casts a shadow onto the road"
   * and "the road is one untextured grey covering 45% of the hero frame".
   * Both have the same cause and it is not in this directory: `trackFloor` is
   * a PBR METAL. A metal has no diffuse term, so essentially all of its light
   * arrives from the environment cubemap — and a shadow map cannot subtract
   * ambient light. The shadow generator was working perfectly; the surface it
   * was falling on was physically incapable of showing it.
   *
   * The one-line fix belongs to `mat/` (make `trackFloor` a dielectric, i.e.
   * `enamel` not `metal`) and I do not own that file. What I can do without
   * crossing the line is what a real interior would do anyway: lay a carpet.
   * This is a decorative inlay — dark polished onyx with gold seams — that
   * sits 1.6cm proud of the track deck, well under the track's own lane lines
   * and chevrons, strictly inside the play area, and is DIELECTRIC. It takes
   * a cast shadow, it gives the road a value and a pattern, and it does not
   * require anyone else's file to change.
   *
   * FLAGGED IN PROGRESS.md: when `mat/` makes the floor a dielectric, this
   * should be reconsidered — the honest version of this is a track material,
   * not a prop.
   */
  _buildRunner(scene, mat, q) {
    const low = q.name === 'low';
    const D = [];   // marbleDark  — the onyx field
    const G = [];   // goldTrim    — seams and chevrons
    const W = 6.4;  // covers all three lanes plus the player's radius
    const L = RUNNER_STEP;

    // The field. 2cm thick so it has an edge to catch light, not a decal.
    box(scene, D, W, 0.05, L, 0, 0.016, 0);

    // Seam lines. Transverse every 4m and a hairline down each margin. These
    // stream past at running speed and are most of what sells forward motion
    // once the lane dashes are no longer the only marks on the ground.
    for (const sz of [-0.5, 0.5]) {
      box(scene, G, W, 0.03, 0.075, 0, 0.045, sz * L * 0.5);
    }
    for (const sx of [-1, 1]) {
      box(scene, G, 0.07, 0.03, L, sx * (W * 0.5 - 0.16), 0.045, 0);
    }

    if (!low) {
      // A hex/lozenge inlay in the pale marble, at the seam crossings. Small,
      // and the point is not that anybody reads a hexagon — it is that the
      // 45% of frame the road occupies stops being one unbroken value.
      for (const sx of [-1, 0, 1]) {
        box(scene, G, 0.34, 0.028, 0.34, sx * 2.13, 0.044, -L * 0.5, 0.785);
        box(scene, D, 0.20, 0.032, 0.20, sx * 2.13, 0.048, -L * 0.5, 0.785);
      }
    }

    this.runnerStone = mergeBucket(scene, 'runnerStone', D, mat.get('marbleDark'));
    this.runnerGold = mergeBucket(scene, 'runnerGold', G, mat.get('goldTrim'));
    this.runnerBufs = [];
    for (const m of [this.runnerStone, this.runnerGold]) {
      if (m) this.runnerBufs.push(this._alloc(m, RUNNER_SLOTS));
    }
  }

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
      // The matching strip at 17.4m used to be gold too. Two bright rails
      // either side of the road, both aimed at the vanishing point, is two
      // lines of arrows telling the eye to leave the lane. The outer one is
      // dark stone now: same paving logic, none of the pull.
      box(scene, F, 0.30, 0.06, BAY_LEN, sx * 17.4, -0.05, 0);
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
        // The voussoirs and the ring both go in DARK. This arcade used to be
        // dark stone picked out with gold, which is a high-contrast pattern
        // repeated nine times per bay, sitting either side of the lane, at the
        // exact height an obstacle occupies. It was the loudest thing in the
        // frame after the near colonnade and it is the second furthest away.
        // Aerial perspective says the far layer gets LESS contrast, not more.
        for (const az of [-4, 4, 12]) {
          arch(scene, D, D, {
            axis: 'z', x, z: az,
            radius: 3.30, springY: 2.80,
            voussoirs: 9, thickness: 0.42, width: 1.05,
          });
        }
        box(scene, D, 1.55, 0.34, BAY_LEN, x, 4.28, 0);
        box(scene, D, 1.72, 0.09, BAY_LEN, x, 4.50, 0);   // was a gold fillet
      }
    }

    // --- DEPTH LAYERS -----------------------------------------------------
    //
    // THE PROBLEM. Everything above lives between x = 4.9 and x = 12.4, all of
    // it lit by the same key, all of it at the same contrast. A corridor with
    // two rows of columns in it is still a corridor: nothing in frame was
    // evidence that the room continues past the arcade, so the panorama had to
    // carry the entire idea of scale on its own — and a painted backdrop with
    // nothing in front of it always reads as paint.
    //
    // WHERE DISTANCE IS ALLOWED TO SHOW, which is the whole design constraint
    // and cost me a build to learn. The chase lens is 45 degrees vertical and
    // pitched about 8 degrees down, so the top of the frame is only ~14 degrees
    // above the horizon. The near cornice — 3.4m above eye level, 6.2m out —
    // hides everything below elevation atan(0.55 * tan(theta)) at screen angle
    // theta. Distant geometry therefore has exactly two ways onto the screen:
    //
    //   THROUGH the colonnade, under y = 4.9m, in the narrow band either side
    //     of the horizon, framed by the columns
    //   OVER the cornice, which requires height > 2.8 + 0.55x and is then
    //     capped by the frame ceiling at height < 2.8 + 0.25z
    //
    // The first version of this layer used 22-42m towers and every one of them
    // sailed off the top of the frame; the old 11.5m pylons at x = 24 failed
    // the other test and were occluded at every distance. Both cost vertices
    // to be invisible. Each band below carries a LOW piece for the first route
    // and a TALL piece for the second, sized against those two inequalities.
    //
    // WHY THEY ARE UNLIT. A silhouette must not have a light direction: the
    // moment a distant mass has a lit face and a dark face the eye reads it as
    // near. Flat fill plus fog is the whole of aerial perspective, it is the
    // cheapest opaque shader there is, and it can therefore run on `low` —
    // which until now had no world at all beyond the colonnade, because the
    // outer aisle above is gated behind `!low`.
    //
    // Sides are deliberately not mirrored. A hall that is symmetric about the
    // lane reads as a texture; one that is not reads as a place.
    const SIL = [];    // mid band
    const SILF = [];   // far band — its own bucket, and its own value

    // MID BAND, x = 19.5 — the aisle beyond the aisle.
    {
      const X = 19.5;
      // Low piece. The height is set by what is IN FRONT of it, not by taste:
      // the outer aisle's roof is a continuous 4.5m cap at x = 12.4, so from
      // an eye at 2.8m anything at 19.5m that does not reach 2.8 + 19.5 *
      // (4.5 - 2.8) / 12.4 = 5.5m is behind a wall. At 6.6m it clears by a
      // metre and reads as a second storey seen over the first — which is
      // the entire point of a mid ground.
      for (const sx of [-1, 1]) {
        box(scene, SIL, 1.60, 6.60, BAY_LEN, sx * X, 3.30, 0);
        for (const pz of COL_Z) {
          box(scene, SIL, 2.10, 8.40, 1.80, sx * X, 4.20, pz + sx * 2.0);
        }
      }
      // Tall piece: must clear 2.8 + 0.55 * 19.5 = 13.5m to break the cornice
      // skyline at all. Under 20m so it is still inside the frame ceiling from
      // about seventy metres, where it is a third hazed.
      const tall = [
        [-1, [[-8.0, 2.8, 16.8], [6.0, 3.4, 19.2]]],
        [1, [[-2.0, 3.2, 18.0], [10.0, 2.6, 15.6]]],
      ];
      for (const [sx, ts] of tall) {
        for (const [tz, tw, th] of ts) {
          box(scene, SIL, tw, th, tw, sx * X, th * 0.5, tz);
        }
      }
    }

    // FAR BAND, x = 33 — the far side of the hall.
    {
      const X = 33.0;
      // Same argument again, one storey up: clear the mid band's 6.6m wall at
      // 19.5m, which needs 2.8 + 33 * (6.6 - 2.8) / 19.5 = 9.2m. At 11.5m the
      // three roof lines stack — aisle, mid, far — each one higher on screen
      // and one step further into the haze. Three horizontals a fixed distance
      // apart is the oldest depth cue there is and it costs two boxes.
      for (const sx of [-1, 1]) {
        box(scene, SILF, 2.40, 11.50, BAY_LEN, sx * X, 5.75, 0);
      }
      // Tall piece: clears 2.8 + 0.55 * 33 = 21m. Capped at 30 so the tops are
      // still inside the frame from about a hundred metres out, which is where
      // the haze has them at three quarters and they read as weather.
      const tall = [
        [-1, [[-11.0, 5.0, 26.5], [5.0, 6.2, 30.0]]],
        [1, [[-4.0, 5.8, 28.5], [9.0, 4.6, 24.0]]],
      ];
      for (const [sx, ts] of tall) {
        for (const [tz, tw, th] of ts) {
          box(scene, SILF, tw, th, tw * 0.9, sx * X, th * 0.5, tz);
          // an attic step, so the skyline is not a row of flat-topped boxes
          box(scene, SILF, tw * 0.62, 2.60, tw * 0.56, sx * X, th + 1.3, tz);
        }
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

    // TWO materials, not one, and this is the whole reason the bands separate.
    // Both silhouette rows sit at roughly the same DISTANCE from the camera —
    // they differ by 13m laterally against 60-140m of depth — so fog alone
    // gives them almost identical values and the stack reads as one flat
    // terrace. Assigning the far band a value nearer the haze by hand puts the
    // aerial perspective back in. One extra draw call for the cue the whole
    // layer exists to deliver.
    this.silMat = this._silMaterial(scene, 'worldSil');
    this.silFarMat = this._silMaterial(scene, 'worldSilFar');
    this.baySil = mergeBucket(scene, 'baySil', SIL, this.silMat);
    this.baySilFar = mergeBucket(scene, 'baySilFar', SILF, this.silFarMat);
    for (const m of [this.baySil, this.baySilFar]) {
      if (m) m.receiveShadows = false;
    }

    // --- contact darkening where the walls meet the floor ---
    // Two bands per side, running the whole bay. This is what turns a set of
    // objects standing on a plane into a room: the eye reads the junction
    // between a vertical and a horizontal surface as dark, and when it is not
    // dark the vertical surface looks pasted on.
    const A = [];
    for (const sx of [-1, 1]) {
      slab(scene, A, 4.4, BAY_LEN, sx * COL_X, -0.062, 0);        // colonnade foot
      if (!low) slab(scene, A, 5.6, BAY_LEN, sx * 12.4, -0.058, 0); // outer aisle foot
    }
    this.bayAO = mergeBucket(scene, 'bayAO', A, this.aoMats[1]);
    if (this.bayAO) this.bayAO.receiveShadows = false;

    for (const m of [this.bayLight, this.bayDark, this.bayGold, this.bayGem,
      this.baySil, this.baySilFar, this.bayAO]) {
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
  /**
   * One flat, unlit, fogged fill for a silhouette band.
   *
   * `emissiveColor` rather than `diffuseColor`: with lighting disabled the
   * standard shader multiplies diffuse by nothing and adds emissive — the same
   * trap documented in sky.js. The colour itself is retinted per zone in
   * setHaze(), so a distant mass is always a fixed step darker than the air in
   * front of it and never a hole cut out of a ruby room in the shape of a
   * sapphire one.
   */
  _silMaterial(scene, name) {
    const m = new StandardMaterial(name, scene);
    m.disableLighting = true;
    m.diffuseColor = new Color3(0, 0, 0);
    m.specularColor = new Color3(0, 0, 0);
    m.emissiveColor = new Color3(0.06, 0.055, 0.075);
    return m;
  }

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

    // The pool of darkness the column stands in. Same matrix as the column, so
    // it simply joins colBufs and is written, cleared and recycled for free.
    const A = [];
    slab(scene, A, 3.9, 3.9, 0, -0.052, 0);
    this.colLight = mergeBucket(scene, 'colLight', L, mat.get('marbleLight'));
    this.colDark = mergeBucket(scene, 'colDark', D, mat.get('marbleDark'));
    this.colGold = mergeBucket(scene, 'colGold', G, mat.get('goldTrim'));
    this.colAO = mergeBucket(scene, 'colAO', A, this.aoMats[0]);
    if (this.colAO) this.colAO.receiveShadows = false;
    for (const m of [this.colLight, this.colDark, this.colGold, this.colAO]) {
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

    const A = [];
    slab(scene, A, 5.0, 5.0, 0, -0.050, 0);

    this.accentStone = mergeBucket(scene, 'accentStone', S, mat.get('stonePolished'));
    this.accentGold = mergeBucket(scene, 'accentGold', G, mat.get('goldLeaf'));
    this.accentAO = mergeBucket(scene, 'accentAO', A, this.aoMats[0]);
    if (this.accentAO) this.accentAO.receiveShadows = false;
    for (const m of [this.accentStone, this.accentGold, this.accentAO]) {
      if (m) this.accentBufs.push(this._alloc(m, ACCENT_SLOTS));
    }
    // The star is hidden on some plinths (a broken, empty pedestal), so the
    // gold buffer is written independently of the stone one.
    this.accentGoldBuf = this.accentBufs[1];
    this.accentAOBuf = this.accentBufs[2];
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
    // High only, and small. These are large additive quads: every one of them
    // is a full-screen blend when the camera gets close, and stacking a dozen
    // down a corridor is the single most fill-rate-hungry thing in the game.
    // At character-close camera distances it was enough to blow the capture
    // harness past a thirty second screenshot timeout in software rendering,
    // which is a fair warning about what it would cost a phone.
    if (q.name !== 'high') { this.shaftMesh = null; return; }
    const size = 128;
    const tex = new DynamicTexture('lightShaft', { width: size, height: size }, scene, true);
    const c = tex.getContext();
    c.clearRect(0, 0, size, size);

    // THE HARD LINE ACROSS THE TOP OF THE PORTRAIT FRAME WAS THIS TEXTURE.
    //
    // Reported for three rounds, blamed on the HUD twice and on the sky once,
    // and it was neither. Measured, not argued:
    //
    //   * with the sky domes disabled the step is STILL there and twice as
    //     strong (-44.5 row-mean, 100% of columns); with only the sky domes
    //     enabled it is completely absent. So: not the panorama, not the HUD.
    //   * disabling this one mesh removes it (-20.8 at 99% of columns -> -6.6
    //     at 47%, i.e. down into the ordinary texture of the frame).
    //   * and the arithmetic closes. Camera y=2.8, pitch 0.1138 rad, vertical
    //     fov 0.9996 rad; nearest shaft instance 17.43m ahead; the quad's
    //     BOTTOM edge is at world y=5.45. That edge lands at 8.647 degrees of
    //     elevation, which is device row 425.3 of 1688. Measured row: 426.
    //
    // Canvas row 0 maps to the plane's BOTTOM edge (DynamicTexture uploads
    // inverted), so the 0.42 stop was sitting exactly on the quad's lower
    // boundary: a screen-filling additive quad going from 42% opaque to
    // nothing in zero pixels. That is a straight bright-to-dark line across
    // the whole frame, and no amount of it being "only a light shaft" stops
    // the eye reading it as a seam in the picture.
    //
    // THE RULE, and it is general: a large additive billboard must reach zero
    // alpha at EVERY edge of its own quad. The horizontal edges were already
    // faded (see the destination-in pass below) — which is why this only ever
    // showed as a horizontal line. The vertical ones were not.
    //
    // The profile is otherwise deliberately unchanged: the beam is still
    // brightest low and fades upward, because that is the look zone 1 was
    // signed off with. All that is added is a foot — the bottom 16% of the
    // quad, about 1.2m of world height, ramps in from nothing. At the
    // distances a shaft is actually seen that is a couple of hundred pixels of
    // gradient, which is far too gradual to read as an edge.
    const v = c.createLinearGradient(0, 0, 0, size);
    v.addColorStop(0.00, 'rgba(255,244,220,0)');
    v.addColorStop(0.06, 'rgba(255,243,218,0.13)');
    v.addColorStop(0.16, 'rgba(255,242,215,0.42)');
    v.addColorStop(0.50, 'rgba(255,232,190,0.16)');
    v.addColorStop(1.00, 'rgba(255,225,175,0)');
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

    const plane = MeshBuilder.CreatePlane('lightShaft', { width: 9.0, height: 7.5 }, scene);
    plane.position.set(0, 9.2, 0);
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
    this._nextRunnerS = -BAY_LEN;
    this._runnerSlot = 0;
    for (const b of this.bayBufs) b.fill(0);
    for (const b of this.colBufs) b.fill(0);
    for (const b of this.accentBufs) b.fill(0);
    for (const b of this.runnerBufs) b.fill(0);
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

    // The runner is generated on the same 8m step as the columns, and stops
    // short of a junction: the corner pad, the chevrons and the backstop arrow
    // are the player's only warning that a turn is coming, and a decorative
    // carpet must never be laid over the top of the signage.
    while (this._nextRunnerS + RUNNER_STEP * 0.5 < limit) {
      const mid = this._nextRunnerS + RUNNER_STEP * 0.5;
      const o = ((this._runnerSlot++) % RUNNER_SLOTS) * 16;
      if (this._nearJunction(mid, 11, track)) {
        for (const b of this.runnerBufs) b.fill(0, o, o + 16);
      } else {
        path.toWorldExact(mid, 0, 0, this._w);
        Matrix.RotationYToRef(path.yawExactAt(mid), this._m);
        this._m.setTranslationFromFloats(this._w[0], this._w[1], this._w[2]);
        for (const b of this.runnerBufs) this._m.copyToArray(b, o);
      }
      this._nextRunnerS += RUNNER_STEP;
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
      if (this._baySlot % 4 === 0) this._m.copyToArray(this.shaftBuf, o);
      else this.shaftBuf.fill(0, o, o + 16);
    }
  }

  _placeAccent(slot, s, path, track) {
    const o = slot * 16;
    const stoneBuf = this.accentBufs[0];
    const goldBuf = this.accentBufs[1];
    const aoBuf = this.accentAOBuf;
    if (this._nearJunction(s, 16, track)) {
      stoneBuf.fill(0, o, o + 16);
      goldBuf.fill(0, o, o + 16);
      if (aoBuf) aoBuf.fill(0, o, o + 16);
      return;
    }
    // propDensity is a quality contract, not a suggestion: on the low preset
    // a little under half of the wayside dressing simply does not spawn.
    if (this._rng.next() > this.ctx.config.q.propDensity) {
      stoneBuf.fill(0, o, o + 16);
      goldBuf.fill(0, o, o + 16);
      if (aoBuf) aoBuf.fill(0, o, o + 16);
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
    if (aoBuf) this._m.copyToArray(aoBuf, o);
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

  /**
   * Zone tint for the depth layers. `r,g,b` is the blended FOG colour.
   *
   * A silhouette only works if it is darker than the air around it, so the
   * layers are painted a fraction of the fog they will dissolve into. The
   * small floor keeps the nearest band from crushing to pure black in the
   * darkest zone, where the fog colour is barely above zero and an unlit mass
   * would otherwise be indistinguishable from the void behind it.
   */
  setHaze(r, g, b) {
    if (this.silMat) {
      this.silMat.emissiveColor.set(
        r * 0.40 + 0.010, g * 0.40 + 0.009, b * 0.40 + 0.013,
      );
    }
    if (this.silFarMat) {
      this.silFarMat.emissiveColor.set(
        r * 0.76 + 0.012, g * 0.76 + 0.011, b * 0.76 + 0.016,
      );
    }
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

  /**
   * Every mesh that should cast a shadow.
   *
   * Deliberately not everything. Each entry is a full extra pass over all of
   * its thin instances — 184m of colonnade — and only the geometry near enough
   * to fall inside the 54m shadow frustum can contribute anything. Columns and
   * their plinths are the whole point (bars across the road); the arch ribs and
   * cornice in `bayLight` are the second most valuable, because they stripe the
   * corridor lengthways. The gold trim, the gems and the floor are omitted:
   * small, self-shadowing or flat on the ground.
   */
  casters() {
    return [this.colLight, this.colDark, this.bayLight, this.accentStone];
  }

  dispose() {
    // Only the materials this module made. bayLight/Dark/Gold borrow shared
    // materials from mat/, which owns and disposes them.
    for (const m of this.meshes) m.dispose();
    this.meshes.length = 0;
    if (this.gemMat) this.gemMat.dispose();
    if (this.silMat) this.silMat.dispose();
    if (this.silFarMat) this.silFarMat.dispose();
    if (this.shaftMat) this.shaftMat.dispose();
    if (this.shaftTex) this.shaftTex.dispose();
    if (this.aoMats) for (const m of this.aoMats) m.dispose();
    if (this.aoTextures) for (const t of this.aoTextures) t.dispose();
  }
}
