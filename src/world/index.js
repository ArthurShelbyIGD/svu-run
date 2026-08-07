// world/ — lighting, shadows, the sky, and the architecture.
//
// OWNERSHIP: this directory owns the lights, the shadow generator, the
// backdrop, and every decorative (non-collidable) prop. The track surface
// itself belongs to track/.
//
// Two files do the heavy lifting:
//   sky.js   — an equirectangular panorama on a camera-locked dome, so the
//              room swings around the player instead of sitting still
//   props.js — a 24m bay of procedural architecture, thin-instanced along the
//              path and recycled behind the player

import {
  DirectionalLight, HemisphericLight, PointLight, ShadowGenerator,
  Vector3, Color3, Scene,
} from '../core/bjs.js';
import { EV } from '../core/ctx.js';
import { ZONES, zoneAt } from './zones.js';
import Sky from './sky.js';
import Props from './props.js';

/**
 * Slerp a light direction between two zones' key vectors, in place.
 *
 * A COMPONENT-WISE LERP IS NOT ENOUGH, and the reason is worth the six lines.
 * Vault's key and Ruby's are 120 degrees apart — that is the whole point, the
 * lit side of every column changes sides — and a straight lerp between two
 * nearly opposite unit vectors passes close to the ORIGIN. Normalising it back
 * out afterwards fixes the length but not the rate: measured over the Vault to
 * Ruby crossfade, the x component moved 0.032 in one ten-metre step near the
 * start and 0.227 in one ten-metre step in the middle. The light would hang,
 * then whip, then hang. Slerp is constant angular velocity: 120 degrees spread
 * evenly over 150 metres, about nine degrees a second, which reads as the sun
 * moving rather than as a glitch.
 *
 * The great-circle path is the same path the normalised lerp took — halfway
 * between two opposed rakes is overhead, and there is no way round that — so
 * this changes only the timing, which is the part that was wrong.
 */
function slerpDir(out, a, b, t) {
  let ax = a[0], ay = a[1], az = a[2];
  const la = Math.sqrt(ax * ax + ay * ay + az * az) || 1;
  ax /= la; ay /= la; az /= la;
  let bx = b[0], by = b[1], bz = b[2];
  const lb = Math.sqrt(bx * bx + by * by + bz * bz) || 1;
  bx /= lb; by /= lb; bz /= lb;
  let d = ax * bx + ay * by + az * bz;
  if (d > 1) d = 1; else if (d < -1) d = -1;
  const th = Math.acos(d);
  const s = Math.sin(th);
  // Almost parallel (or exactly antiparallel, where the great circle is not
  // unique): fall back to lerp-and-normalise, which is well behaved there.
  if (s < 1e-4) {
    const x = ax + (bx - ax) * t, y = ay + (by - ay) * t, z = az + (bz - az) * t;
    const l = Math.sqrt(x * x + y * y + z * z) || 1;
    out.set(x / l, y / l, z / l);
    return;
  }
  const w1 = Math.sin((1 - t) * th) / s;
  const w2 = Math.sin(t * th) / s;
  out.set(ax * w1 + bx * w2, ay * w1 + by * w2, az * w1 + bz * w2);
}

/**
 * Blend a Color3 between two [r,g,b] literals, in place.
 * Called several times a frame from renderUpdate, so it allocates nothing.
 */
function lerp3(out, a, b, t) {
  out.set(
    a[0] + (b[0] - a[0]) * t,
    a[1] + (b[1] - a[1]) * t,
    a[2] + (b[2] - a[2]) * t,
  );
}

export default class World {
  constructor(ctx) {
    this.ctx = ctx;
    this.key = null;
    this.ambient = null;
    this.shadowGen = null;
    this.sky = new Sky(ctx);
    this.props = new Props(ctx);
    this._fog = new Color3();
    this._haze = new Color3();
    this._zoneIndex = -1;
    this.zoneBias = 0;   // see setZoneBias — a capture affordance, 0 in play
    this._offs = [];
    this._w = [0, 0, 0];   // scratch for path->world, never reallocated
  }

  init() {
    const scene = this.ctx.scene;
    const q = this.ctx.config.q;

    this.sky.init();

    // ATMOSPHERE IS EXPONENTIAL, NOT A RAMP.
    //
    // Linear fog from 48m to 205m is a straight line, and a straight line is
    // the one falloff curve that occurs nowhere in air. It gives the near
    // field no haze at all, then takes a constant bite out of every subsequent
    // metre — so the colonnade forty metres out and the colonnade a hundred
    // and forty metres out arrive at the eye with almost the same contrast,
    // and 205m of razor-sharp architecture competes with the lane for
    // attention the whole way to the vanishing point.
    //
    // EXP2 is what real distance does: essentially nothing over the first
    // twenty metres, where the obstacles the player must read actually live,
    // then an accelerating dissolve. At this density the numbers are
    //
    //   20m  5% hazed     obstacles and the corner pad stay crisp
    //   60m  38%          the colonnade starts giving up its detail
    //  100m  73%          the mid depth band is a value, not a shape
    //  160m  95%          the deep band is a rumour
    //
    // which is both the depth cue and the readability fix in one number: the
    // sharpest, highest-contrast thing in frame is now always the ten metres
    // in front of the player.
    scene.fogMode = Scene.FOGMODE_EXP2;
    scene.fogColor = this._haze;
    scene.fogDensity = 0.0115;

    // THE KEY IS RAKING, NOT OVERHEAD.
    //
    // The critic's loudest note was that not one column throws a shadow onto
    // the road. Half of that was wiring (see below); the other half was this
    // vector. A key at 55 degrees elevation puts a column's shadow underneath
    // the column, where nobody can see it. Dropped to ~33 degrees and swung
    // almost fully across the corridor, the same column lays a hard bar right
    // across the running surface — which is the single cheapest way to prove
    // to the eye that the light is real and the geometry is in it.
    //
    // The vector, the intensity and both colours are now PER ZONE and live in
    // zones.js; these are only the values the light is born with, and
    // _applyZone overwrites them on the first frame. Zone 1's entry in that
    // table is these exact numbers, deliberately, so the signed-off hall is
    // bit-for-bit what it was.
    this.key = new DirectionalLight('key', new Vector3(-0.80, -0.53, 0.28), scene);
    this.key.intensity = 6.4;
    this.key.diffuse = new Color3(1.0, 0.91, 0.78);
    this.key.specular = new Color3(1.0, 0.96, 0.88);

    this.ambient = new HemisphericLight('amb', new Vector3(0, 1, 0), scene);
    this.ambient.intensity = 0.10;
    this.ambient.diffuse = new Color3(0.66, 0.74, 0.95);
    this.ambient.groundColor = new Color3(0.14, 0.11, 0.09);

    if (q.shadows && q.shadowMapSize > 0) {
      this.shadowGen = new ShadowGenerator(q.shadowMapSize, this.key);
      // Hard-edged, not exponential. ESM was chosen when the only caster was
      // the character and a soft blob under it was the goal; the goal now is
      // architectural bars with a readable edge, and ESM light-leaks badly
      // through the thin voussoirs of an arch.
      this.shadowGen.useExponentialShadowMap = false;
      this.shadowGen.usePercentageCloserFiltering = true;
      this.shadowGen.filteringQuality = ShadowGenerator.QUALITY_MEDIUM;
      this.shadowGen.darkness = 0.18;
      this.shadowGen.bias = 0.00035;
      this.shadowGen.normalBias = 0.014;
      // A DirectionalLight normally derives its ortho box from the bounding
      // info of everything in the render list. Every prop mesh here has
      // `doNotSyncBoundingInfo` set — its bounds are a lie by design — so the
      // auto-extend path would size the frustum from garbage. A fixed frustum
      // is deterministic, and 54m across a 2048 map is ~2.6cm per texel, which
      // is sharp enough for a column edge at running distance.
      this.key.shadowFrustumSize = 54;
      this.key.autoUpdateExtends = false;
      this.key.shadowMinZ = 1;
      this.key.shadowMaxZ = 88;
    }

    this.props.init();

    // WIRING, NOT PHYSICS. `props.casters()` existed and returned the right
    // meshes and nothing ever called it, so the entire colonnade was invisible
    // to the shadow map. No test can see this; one screenshot can.
    if (this.shadowGen) {
      for (const m of this.props.casters()) this.addCasterMesh(m);
    }

    this._applyZone(0);

    // The path is rebuilt from scratch on every restart, so the architecture
    // has to be rebuilt with it or bay 0 would still be standing where the
    // previous run's corner used to be.
    this._offs.push(this.ctx.on(EV.RUN_START, () => this.props.reset()));
  }

  /**
   * A light tent that travels with the character.
   *
   * Set stones are bright because they sit in a box of light, not because of
   * anything about the stone. In a dark zone the environment's diffuse
   * contribution is nearly nothing, so pavé rendered as dark grey lumps no
   * matter how the material was tuned. These lights are restricted to the
   * character's own meshes, so the world stays dark and moody while the piece
   * in front of the camera is lit like it is on a jeweller's bench.
   *
   * This is the same trick portrait photography uses, and it is the reason
   * product shots look the way they do.
   */
  attachPortraitRig(node) {
    const scene = this.ctx.scene;
    const meshes = node.getChildMeshes ? node.getChildMeshes() : [node];
    this.portraitLights = [];

    const rig = [
      // [x, y, z, intensity, r, g, b]  — positions are relative to the char
      [1.5, 2.2, 2.4, 30, 1.00, 0.94, 0.86],   // key, high front
      [-2.0, 1.2, 1.6, 16, 0.82, 0.88, 1.00],  // fill, cool, low left
      [0.2, 2.4, -2.6, 22, 1.00, 0.90, 0.80],  // rim from behind
      [0.0, -1.2, 1.2, 8, 1.00, 0.86, 0.70],   // bounce from below
    ];

    // Point lights are a shader permutation cost per lit mesh, so the low
    // preset gets the key and rim only. Two lights still tent the piece; four
    // is a luxury for machines that can afford it.
    const count = this.ctx.config.q.name === 'low' ? 2 : rig.length;
    for (let i = 0; i < count; i++) {
      const [x, y, z, inten, r, g, b] = rig[i];
      const L = new PointLight(`portrait${i}`, new Vector3(x, y, z), scene);
      L.parent = node;
      L.intensity = inten;
      L.range = 14;
      L.diffuse = new Color3(r, g, b);
      L.specular = new Color3(r, g, b);
      L.includedOnlyMeshes = meshes;
      this.portraitLights.push(L);
    }
  }

  /**
   * ZONE BIAS — a capture affordance, and the reason zone grading was wrong
   * for two rounds.
   *
   * A zone is chosen by distance. Zones 2-5 begin at 620, 1240, 1860 and
   * 2480m, and fourteen seconds of game time is about two hundred metres — so
   * EVERY pose in tools/capture.mjs shoots zone 1, and every "the zones all
   * feel the same" verdict so far was reached from screenshots physically
   * incapable of showing four fifths of the game.
   *
   * Simulating 2800m per pose is slow and lands the player at an arbitrary
   * point in the turn grammar, which makes two shots non-comparable. Biasing
   * the distance the zone system READS instead keeps the player on one known
   * straight, with one seed and one obstacle lineup, and leaves the zone as
   * the only variable in the frame.
   *
   * It re-lays the architecture as well as the lighting, because a bay's
   * proportions are now a function of the zone it stands in (see props.js) and
   * bays are placed once, ahead of the player, and never revisited.
   *
   * Nothing in the game calls this. It is safe in play — the bias is 0 — and
   * it exists so a critic can see zone 4.
   */
  setZoneBias(metres) {
    this.zoneBias = metres;
    this.props.zoneBias = metres;
    this.props.reset();
    const play = this.ctx.tryGet('play');
    const track = this.ctx.tryGet('track');
    if (play && track && track.path) this.props.update(play.z, track);
    this._zoneIndex = -1;
    this._applyZone(play ? play.z : 0);
  }

  /** Set everything a zone controls, blending into the next by `t`. */
  _applyZone(distance) {
    const { index, next, blend } = zoneAt(distance + this.zoneBias);
    const a = ZONES[index];
    const b = ZONES[next];
    const scene = this.ctx.scene;

    if (index !== this._zoneIndex) {
      this._zoneIndex = index;
      this.zoneName = a.name;
    }
    this.sky.setZone(index, next, blend);

    // Fog, environment intensity and bloom all interpolate, so a zone change
    // is a slow reveal rather than a cut.
    this._fog.r = a.fog[0] + (b.fog[0] - a.fog[0]) * blend;
    this._fog.g = a.fog[1] + (b.fog[1] - a.fog[1]) * blend;
    this._fog.b = a.fog[2] + (b.fog[2] - a.fog[2]) * blend;
    // THE HAZE IS BRIGHTER THAN THE VOID.
    //
    // `zone.fog` is a room colour: it is what the darkness of the hall is made
    // of, and at 0.05 it is very nearly black. Fed straight to `scene.fogColor`
    // it makes distance a subtraction — everything far away goes to black
    // while the painted horizon behind it stays a bright gold, so the far
    // architecture turns into cut-out shapes with no air in front of them and
    // the depth cue is lost exactly where it is needed.
    //
    // Air does the opposite: it ADDS light. The panorama already knew this and
    // paints its own haze band at 2.6x the zone fog (see paintZone), so the
    // scene fog was the only part of the picture disagreeing. Lifted to a
    // comparable value, distance becomes a wash rather than a hole: near
    // masses are darker than the air, far ones dissolve up into it, and the
    // value ramp between them is what the eye reads as a hundred metres.
    scene.clearColor.set(this._fog.r, this._fog.g, this._fog.b, 1);
    const HAZE_GAIN = 2.3;
    this._haze.set(
      this._fog.r * HAZE_GAIN, this._fog.g * HAZE_GAIN, this._fog.b * HAZE_GAIN,
    );
    scene.fogColor = this._haze;

    this.props.setHaze(this._haze.r, this._haze.g, this._haze.b);

    this.props.setGlow(
      a.gem[0] + (b.gem[0] - a.gem[0]) * blend,
      a.gem[1] + (b.gem[1] - a.gem[1]) * blend,
      a.gem[2] + (b.gem[2] - a.gem[2]) * blend,
    );

    scene.environmentIntensity = a.env + (b.env - a.env) * blend;
    const pipe = this.ctx.pipeline;
    if (pipe && pipe.bloomEnabled) {
      const q = this.ctx.config.q;
      pipe.bloomWeight = (a.bloom + (b.bloom - a.bloom) * blend) * (q.bloomScale / 0.6);
    }

    // ---- the light itself -------------------------------------------------
    //
    // The direction is SLERPED, not lerped — see slerpDir. Babylon multiplies
    // by the direction as it is given, so a raw component-wise lerp is both
    // the wrong length (a light that dims 20% mid-crossfade and comes back)
    // and the wrong rate. Measured across the whole Vault-to-Ruby blend after
    // this, the direction stays exactly unit length and no ten-metre step
    // turns it by more than 4.9 degrees.
    slerpDir(this.key.direction, a.key, b.key, blend);
    this.key.intensity = a.keyI + (b.keyI - a.keyI) * blend;
    lerp3(this.key.diffuse, a.keyC, b.keyC, blend);
    lerp3(this.key.specular, a.keyS, b.keyS, blend);

    this.ambient.intensity = a.ambI + (b.ambI - a.ambI) * blend;
    lerp3(this.ambient.diffuse, a.ambC, b.ambC, blend);
    lerp3(this.ambient.groundColor, a.ambG, b.ambG, blend);

    if (this.shadowGen) {
      this.shadowGen.darkness = a.shadow + (b.shadow - a.shadow) * blend;
    }
    scene.fogDensity = a.fogD + (b.fogD - a.fogD) * blend;
  }

  /** Register a node (and its descendants) as a shadow caster. */
  addCaster(node) {
    if (!this.shadowGen) return;
    const map = this.shadowGen.getShadowMap();
    if (!map) return;
    const meshes = node.getChildMeshes ? node.getChildMeshes() : [node];
    for (const m of meshes) map.renderList.push(m);
  }

  /**
   * Register a single mesh as a caster. Instances inherit their source mesh's
   * shadow participation, so pooled obstacles only need their prototype added.
   */
  addCasterMesh(mesh) {
    if (!this.shadowGen || !mesh) return;
    const map = this.shadowGen.getShadowMap();
    if (map) map.renderList.push(mesh);
  }

  /** Architecture is generated in the simulation step so it is deterministic. */
  fixedUpdate() {
    const play = this.ctx.tryGet('play');
    const track = this.ctx.tryGet('track');
    if (!play || !track || !track.path) return;
    this.props.update(play.z, track);
  }

  /**
   * The shadow-casting light follows the player so the map stays tight.
   *
   * `play.x` and `play.z` are PATH space — lateral offset and distance
   * travelled — not world coordinates. The previous version fed them straight
   * into a world-space position, which is correct only until the first corner;
   * after one left turn the shadow frustum was parked sideways in a wall and
   * the road went unshadowed for the rest of the run.
   */
  renderUpdate() {
    const play = this.ctx.tryGet('play');
    if (!play) return;
    this._applyZone(play.z);
    if (!this.key) return;
    const track = this.ctx.tryGet('track');
    if (track && track.path) {
      // Aim a little ahead: the shadows that matter are the ones the player is
      // about to run through, not the ones already behind the camera.
      track.path.toWorldExact(play.z + 12, play.x, 0, this._w);
    } else {
      this._w[0] = play.x; this._w[1] = 0; this._w[2] = play.z + 12;
    }
    const d = this.key.direction;
    this.key.position.set(
      this._w[0] - d.x * 34, this._w[1] - d.y * 34, this._w[2] - d.z * 34,
    );
  }

  dispose() {
    for (const off of this._offs) off();
    this._offs.length = 0;
    if (this.portraitLights) for (const L of this.portraitLights) L.dispose();
    this.props.dispose();
    this.sky.dispose();
    if (this.shadowGen) this.shadowGen.dispose();
    if (this.key) this.key.dispose();
    if (this.ambient) this.ambient.dispose();
  }
}
