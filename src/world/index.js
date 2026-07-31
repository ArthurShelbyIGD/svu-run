// world/ — lighting, shadows, and environment decoration.
//
// OWNERSHIP: this directory owns the lights, the shadow generator, and every
// decorative (non-collidable) prop. The track surface itself belongs to track/.

import {
  DirectionalLight, HemisphericLight, PointLight, ShadowGenerator,
  Vector3, Color3, Color4, DynamicTexture, Texture, Scene, Layer,
} from '../core/bjs.js';
import { ZONES, zoneAt, paintZone } from './zones.js';

export default class World {
  constructor(ctx) {
    this.ctx = ctx;
    this.key = null;
    this.ambient = null;
    this.shadowGen = null;
  }

  init() {
    const scene = this.ctx.scene;
    const q = this.ctx.config.q;

    this._buildBackdrop();

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
   * Sky and atmosphere.
   *
   * A flat clear colour gives no horizon and no depth: the track simply stopped
   * dead at the far clip plane against a uniform void. A vertical gradient plus
   * linear fog costs almost nothing and does three jobs at once — it gives the
   * scene a horizon, it hides the end of the generated track, and it stops
   * distant geometry from reading as hard-edged clutter.
   */
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
   * Sky and atmosphere.
   *
   * A background Layer, not a sky sphere. The sphere version was wrong twice
   * over: its radius exceeded the camera far plane so it was clipped into a
   * visible bubble, and a UV sphere bands along its seams at any usable
   * segment count. A background layer is one screen-space quad — it cannot be
   * clipped, cannot band, and costs a single draw.
   *
   * Two layers, not one, so zones can crossfade into each other. The top layer
   * carries the incoming zone and its alpha is the blend.
   */
  _buildBackdrop() {
    const scene = this.ctx.scene;
    const W = 512;
    const H = 512;

    // Bake every zone once. Painting a 512x512 gradient is a few milliseconds;
    // doing it per frame would not be.
    this.zoneTextures = ZONES.map((zone, i) => {
      const tex = new DynamicTexture(`zone${i}`, { width: W, height: H }, scene, true);
      paintZone(tex.getContext(), zone, W, H);
      tex.update(false);
      tex.wrapU = Texture.CLAMP_ADDRESSMODE;
      tex.wrapV = Texture.CLAMP_ADDRESSMODE;
      return tex;
    });

    this.layerA = new Layer('zoneA', null, scene, true);
    this.layerA.texture = this.zoneTextures[0];
    this.layerB = new Layer('zoneB', null, scene, true);
    this.layerB.texture = this.zoneTextures[1 % ZONES.length];
    this.layerB.color = new Color4(1, 1, 1, 0);

    this._zoneIndex = -1;
    this._fog = new Color3();
    scene.fogMode = Scene.FOGMODE_LINEAR;
    scene.fogColor = this._fog;
    scene.fogStart = 55;
    scene.fogEnd = 195;

    this._applyZone(0);
  }

  /** Set everything a zone controls, blending into the next by `t`. */
  _applyZone(distance) {
    const { index, next, blend } = zoneAt(distance);
    const a = ZONES[index];
    const b = ZONES[next];
    const scene = this.ctx.scene;

    if (index !== this._zoneIndex) {
      this._zoneIndex = index;
      this.layerA.texture = this.zoneTextures[index];
      this.layerB.texture = this.zoneTextures[next];
      this.zoneName = a.name;
    }
    this.layerB.color.a = blend;

    // Fog, environment intensity and bloom all interpolate, so a zone change
    // is a slow reveal rather than a cut.
    this._fog.r = a.fog[0] + (b.fog[0] - a.fog[0]) * blend;
    this._fog.g = a.fog[1] + (b.fog[1] - a.fog[1]) * blend;
    this._fog.b = a.fog[2] + (b.fog[2] - a.fog[2]) * blend;
    scene.fogColor = this._fog;
    scene.clearColor.set(this._fog.r, this._fog.g, this._fog.b, 1);

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

  /** The shadow-casting light follows the player so the map stays tight. */
  renderUpdate() {
    const play = this.ctx.tryGet('play');
    if (!play) return;
    if (this.layerA) this._applyZone(play.z);
    if (!this.key) return;
    this.key.position.set(play.x - 14, 24, play.z - 8);
    if (this.shadowGen) {
      this.key.shadowMinZ = 6;
      this.key.shadowMaxZ = 60;
    }
  }

  dispose() {
    if (this.portraitLights) for (const L of this.portraitLights) L.dispose();
    if (this.layerA) this.layerA.dispose();
    if (this.layerB) this.layerB.dispose();
    if (this.zoneTextures) for (const t of this.zoneTextures) t.dispose();
    if (this.shadowGen) this.shadowGen.dispose();
    if (this.key) this.key.dispose();
    if (this.ambient) this.ambient.dispose();
  }
}
