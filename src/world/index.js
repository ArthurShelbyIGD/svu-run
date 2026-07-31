// world/ — lighting, shadows, and environment decoration.
//
// OWNERSHIP: this directory owns the lights, the shadow generator, and every
// decorative (non-collidable) prop. The track surface itself belongs to track/.

import {
  DirectionalLight, HemisphericLight, ShadowGenerator, Vector3, Color3,
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

  /** Register a node (and its descendants) as a shadow caster. */
  addCaster(node) {
    if (!this.shadowGen) return;
    const map = this.shadowGen.getShadowMap();
    if (!map) return;
    const meshes = node.getChildMeshes ? node.getChildMeshes() : [node];
    for (const m of meshes) map.renderList.push(m);
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
    if (this.shadowGen) this.shadowGen.dispose();
    if (this.key) this.key.dispose();
    if (this.ambient) this.ambient.dispose();
  }
}
