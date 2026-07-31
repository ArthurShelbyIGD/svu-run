// world/ — lighting, shadows, and environment decoration.
//
// OWNERSHIP: this directory owns the lights, the shadow generator, and every
// decorative (non-collidable) prop. The track surface itself belongs to track/.

import {
  DirectionalLight, HemisphericLight, ShadowGenerator, Vector3, Color3,
  DynamicTexture, Texture, Scene, Layer,
} from '../core/bjs.js';

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
    this.key.intensity = 2.1;
    this.key.diffuse = new Color3(1.0, 0.96, 0.90);
    this.key.specular = new Color3(1.0, 0.98, 0.94);

    this.ambient = new HemisphericLight('amb', new Vector3(0, 1, 0), scene);
    this.ambient.intensity = 0.35;
    this.ambient.diffuse = new Color3(0.86, 0.89, 0.98);
    this.ambient.groundColor = new Color3(0.58, 0.52, 0.46);

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
   * Sky and atmosphere.
   *
   * A flat clear colour gives no horizon and no depth: the track simply stopped
   * dead at the far clip plane against a uniform void. A vertical gradient plus
   * linear fog costs almost nothing and does three jobs at once — it gives the
   * scene a horizon, it hides the end of the generated track, and it stops
   * distant geometry from reading as hard-edged clutter.
   */
  _buildBackdrop() {
    const scene = this.ctx.scene;

    // Vertical gradient, painted once into a tall thin texture.
    const H = 256;
    const tex = new DynamicTexture('skyGrad', { width: 4, height: H }, scene, false);
    const c = tex.getContext();
    const grad = c.createLinearGradient(0, 0, 0, H);
    grad.addColorStop(0.00, '#aeb6c6');   // cool above
    grad.addColorStop(0.30, '#cdd0d4');
    grad.addColorStop(0.55, '#eae4da');
    grad.addColorStop(0.72, '#f7f1e6');   // bright band at the horizon
    grad.addColorStop(0.86, '#ece1cd');
    grad.addColorStop(1.00, '#d8c9ae');   // warm bounce below
    c.fillStyle = grad;
    c.fillRect(0, 0, 4, H);
    tex.update(false);
    tex.wrapU = Texture.CLAMP_ADDRESSMODE;
    tex.wrapV = Texture.CLAMP_ADDRESSMODE;
    this.skyTex = tex;

    // A background Layer, not a sky sphere.
    //
    // The sphere version was a mistake in two ways at once. Its radius (450m)
    // exceeded the camera's far plane (320m), so it was clipped into a visible
    // bubble with the clear colour showing through outside it; and at a usable
    // segment count a UV sphere shows banding along its seams. A background
    // layer is a single screen-space quad: it cannot be clipped, cannot band,
    // costs one textured fullscreen draw, and renders behind everything.
    //
    // It does not rotate with the camera, which for a chase-cam runner is
    // correct rather than a compromise — it reads as atmospheric haze, and the
    // alternative would visibly swing the sky sideways at every corner.
    const bg = new Layer('sky', null, scene, true);
    bg.texture = tex;
    this.skyLayer = bg;

    // Fog colour matches the horizon band so the track dissolves into
    // something that is actually there.
    scene.fogMode = Scene.FOGMODE_LINEAR;
    scene.fogColor = new Color3(0.960, 0.937, 0.895);
    scene.fogStart = 65;
    scene.fogEnd = 215;
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
    if (!this.key) return;
    const play = this.ctx.tryGet('play');
    if (!play) return;
    this.key.position.set(play.x - 14, 24, play.z - 8);
    if (this.shadowGen) {
      this.key.shadowMinZ = 6;
      this.key.shadowMaxZ = 60;
    }
  }

  dispose() {
    if (this.skyLayer) this.skyLayer.dispose();
    if (this.skyTex) this.skyTex.dispose();
    if (this.shadowGen) this.shadowGen.dispose();
    if (this.key) this.key.dispose();
    if (this.ambient) this.ambient.dispose();
  }
}
