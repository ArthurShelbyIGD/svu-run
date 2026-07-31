// world/ — lighting, shadows, and environment decoration.
//
// OWNERSHIP: this directory owns the lights, the shadow generator, and every
// decorative (non-collidable) prop. The track surface itself belongs to track/.

import {
  DirectionalLight, HemisphericLight, ShadowGenerator, Vector3, Color3, Color4,
  MeshBuilder, StandardMaterial, DynamicTexture, Texture, Scene,
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
    const ctx2d = tex.getContext();
    const grad = ctx2d.createLinearGradient(0, 0, 0, H);
    grad.addColorStop(0.00, '#c9cdd8');   // cool above
    grad.addColorStop(0.42, '#e8e4dd');
    grad.addColorStop(0.62, '#f6f1e8');   // bright band at the horizon
    grad.addColorStop(0.78, '#efe6d6');
    grad.addColorStop(1.00, '#ded2bd');   // warm bounce below
    ctx2d.fillStyle = grad;
    ctx2d.fillRect(0, 0, 4, H);
    tex.update(false);
    tex.wrapU = Texture.CLAMP_ADDRESSMODE;
    tex.wrapV = Texture.CLAMP_ADDRESSMODE;
    this.skyTex = tex;

    const mat = new StandardMaterial('skyMat', scene);
    mat.emissiveTexture = tex;
    mat.diffuseColor = Color3.Black();
    mat.specularColor = Color3.Black();
    mat.disableLighting = true;
    mat.backFaceCulling = false;
    mat.freeze();
    this.skyMat = mat;

    const sky = MeshBuilder.CreateSphere('sky', { diameter: 900, segments: 12 }, scene);
    sky.material = mat;
    sky.isPickable = false;
    sky.infiniteDistance = true;   // rides with the camera, never reachable
    sky.applyFog = false;
    sky.renderingGroupId = 0;
    this.sky = sky;

    // Fog colour is sampled from the horizon band so the track dissolves into
    // the sky rather than fading towards a colour that is not there.
    scene.fogMode = Scene.FOGMODE_LINEAR;
    scene.fogColor = new Color3(0.955, 0.937, 0.902);
    scene.fogStart = 70;
    scene.fogEnd = 235;
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
    if (this.sky) this.sky.dispose();
    if (this.skyMat) this.skyMat.dispose();
    if (this.skyTex) this.skyTex.dispose();
    if (this.shadowGen) this.shadowGen.dispose();
    if (this.key) this.key.dispose();
    if (this.ambient) this.ambient.dispose();
  }
}
