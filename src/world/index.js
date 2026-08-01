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

export default class World {
  constructor(ctx) {
    this.ctx = ctx;
    this.key = null;
    this.ambient = null;
    this.shadowGen = null;
    this.sky = new Sky(ctx);
    this.props = new Props(ctx);
    this._fog = new Color3();
    this._zoneIndex = -1;
    this._offs = [];
  }

  init() {
    const scene = this.ctx.scene;
    const q = this.ctx.config.q;

    this.sky.init();

    scene.fogMode = Scene.FOGMODE_LINEAR;
    scene.fogColor = this._fog;
    scene.fogStart = 48;
    scene.fogEnd = 205;

    // The environment cubemap does most of the lighting work. These two lights
    // exist mainly to produce a directional shadow and a little extra shaping.
    this.key = new DirectionalLight('key', new Vector3(-0.45, -0.82, 0.36), scene);
    // A dark interior wants a tighter, warmer key and much less fill: the
    // environment cubemap is doing the heavy lifting, and a strong ambient
    // would wash the room back out to the flat grey we just escaped.
    this.key.intensity = 2.6;
    this.key.diffuse = new Color3(1.0, 0.93, 0.83);
    this.key.specular = new Color3(1.0, 0.97, 0.90);

    this.ambient = new HemisphericLight('amb', new Vector3(0, 1, 0), scene);
    this.ambient.intensity = 0.16;
    this.ambient.diffuse = new Color3(0.72, 0.78, 0.95);
    this.ambient.groundColor = new Color3(0.30, 0.25, 0.20);

    if (q.shadows && q.shadowMapSize > 0) {
      this.shadowGen = new ShadowGenerator(q.shadowMapSize, this.key);
      this.shadowGen.useExponentialShadowMap = true;
      this.shadowGen.usePercentageCloserFiltering = false;
      this.shadowGen.darkness = 0.42;
      this.shadowGen.bias = 0.0016;
      this.shadowGen.normalBias = 0.012;
    }

    this.props.init();

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

  /** Set everything a zone controls, blending into the next by `t`. */
  _applyZone(distance) {
    const { index, next, blend } = zoneAt(distance);
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
    scene.fogColor = this._fog;
    scene.clearColor.set(this._fog.r, this._fog.g, this._fog.b, 1);

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

  /** The shadow-casting light follows the player so the map stays tight. */
  renderUpdate() {
    const play = this.ctx.tryGet('play');
    if (!play) return;
    this._applyZone(play.z);
    if (!this.key) return;
    this.key.position.set(play.x - 14, 24, play.z - 8);
    if (this.shadowGen) {
      this.key.shadowMinZ = 6;
      this.key.shadowMaxZ = 60;
    }
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
