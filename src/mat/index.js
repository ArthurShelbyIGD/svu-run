// mat/ — the material library and the studio environment.
//
// OWNERSHIP: this directory owns every material and texture in the game.
// No other subsystem constructs a material; they ask for one by name.
//
// The art direction is "everything is fine jewellery": polished metals and
// enamel, lit almost entirely by a procedurally generated studio environment.
// That environment cubemap is the single most important thing in this file —
// it is what makes metal read as metal.

import {
  PBRMaterial, RawCubeTexture, Color3, Constants, Engine,
} from '../core/bjs.js';

/** Named palette. Keep this list short — a small palette is the art direction. */
export const PALETTE = {
  roseGold:   { r: 0.955, g: 0.735, b: 0.575 },
  yellowGold: { r: 1.000, g: 0.790, b: 0.310 },
  whiteGold:  { r: 0.945, g: 0.930, b: 0.905 },
  rhodium:    { r: 0.905, g: 0.915, b: 0.930 },
  darkChrome: { r: 0.340, g: 0.350, b: 0.375 },
  ruby:       { r: 0.760, g: 0.090, b: 0.180 },
  cream:      { r: 0.960, g: 0.940, b: 0.905 },
  shadowCool: { r: 0.520, g: 0.545, b: 0.610 },
};

export default class Materials {
  constructor(ctx) {
    this.ctx = ctx;
    /** @type {Map<string, PBRMaterial>} */
    this.cache = new Map();
    this.env = null;
  }

  init() {
    const { scene, config } = this.ctx;

    this.env = this._buildStudioEnv(config.q.envSize);
    scene.environmentTexture = this.env;
    scene.environmentIntensity = 1.55;

    // Warm cream backdrop, straight off the reference art.
    const c = PALETTE.cream;
    scene.clearColor.set(c.r, c.g, c.b, 1);

    this._defineBaseMaterials();
  }

  /**
   * Procedurally generate the studio lighting environment as a cube texture.
   *
   * Layout: a soft vertical gradient dome (cool above, warm bounce below),
   * plus three bright rectangular softboxes — key, fill and rim — which are
   * what produce the long specular streaks on polished metal.
   *
   * 8-bit RGBA is used deliberately: it is universally supported, and the
   * effective dynamic range comes from scene.environmentIntensity instead.
   * (Sprint 2 may revisit this with a properly convolved half-float env.)
   */
  _buildStudioEnv(size) {
    const faces = [];
    const px = size * size * 4;

    // Softboxes described in direction-space: [dir x,y,z, angular radius, intensity, warmth]
    const lights = [
      [ 0.45,  0.80,  0.40, 0.30, 1.35,  0.06],  // key, high front-left, warm
      [-0.70,  0.25,  0.30, 0.40, 0.62, -0.04],  // fill, low left, cool
      [ 0.10,  0.35, -0.95, 0.26, 1.05, -0.02],  // rim, behind, cool
      [-0.25,  0.94, -0.22, 0.18, 1.50,  0.02],  // small hot overhead, top glint
    ];
    for (const L of lights) {
      const n = Math.hypot(L[0], L[1], L[2]);
      L[0] /= n; L[1] /= n; L[2] /= n;
    }

    for (let f = 0; f < 6; f++) {
      const data = new Uint8Array(px);
      for (let y = 0; y < size; y++) {
        for (let x = 0; x < size; x++) {
          // pixel -> direction on the unit cube
          const u = (2 * (x + 0.5)) / size - 1;
          const v = 1 - (2 * (y + 0.5)) / size;
          let dx, dy, dz;
          switch (f) {
            case 0: dx =  1; dy =  v; dz = -u; break; // +X
            case 1: dx = -1; dy =  v; dz =  u; break; // -X
            case 2: dx =  u; dy =  1; dz = -v; break; // +Y
            case 3: dx =  u; dy = -1; dz =  v; break; // -Y
            case 4: dx =  u; dy =  v; dz =  1; break; // +Z
            default: dx = -u; dy = v; dz = -1;        // -Z
          }
          const inv = 1 / Math.hypot(dx, dy, dz);
          dx *= inv; dy *= inv; dz *= inv;

          // --- gradient dome ---
          // Deliberately DARK. Polished metal is a mirror: it looks like metal
          // only when there is high contrast between bright sources and dark
          // surroundings. A bright, even environment makes chrome look like
          // grey plastic — which is exactly what the first blockout showed.
          const up = dy * 0.5 + 0.5;             // 0 down, 1 up
          let r = 0.030 + up * 0.115;
          let g = 0.034 + up * 0.125;
          let b = 0.046 + up * 0.150;
          // warm floor bounce
          const down = Math.max(0, -dy);
          r += down * 0.105; g += down * 0.076; b += down * 0.048;
          // tight bright horizon band — this is what draws the long specular
          // streak across a curved polished surface and sells "jewellery"
          const horizon = Math.exp(-Math.abs(dy) * 16.0) * 0.42;
          r += horizon; g += horizon * 0.985; b += horizon * 0.95;

          // --- softboxes ---
          for (let i = 0; i < lights.length; i++) {
            const L = lights[i];
            const d = dx * L[0] + dy * L[1] + dz * L[2];
            if (d <= 0) continue;
            const ang = Math.acos(Math.min(1, d));
            if (ang > L[3]) continue;
            // smooth square-ish falloff so the box has a defined edge
            const t = 1 - ang / L[3];
            const s = t * t * (3 - 2 * t) * L[4];
            r += s * (1 + L[5]);
            g += s;
            b += s * (1 - L[5]);
          }

          const o = (y * size + x) * 4;
          data[o]     = Math.min(255, r * 255) | 0;
          data[o + 1] = Math.min(255, g * 255) | 0;
          data[o + 2] = Math.min(255, b * 255) | 0;
          data[o + 3] = 255;
        }
      }
      faces.push(data);
    }

    const tex = new RawCubeTexture(
      this.ctx.scene,
      faces,
      size,
      Constants.TEXTUREFORMAT_RGBA,
      Constants.TEXTURETYPE_UNSIGNED_BYTE,
      true,   // generateMipMaps
      false,  // invertY
      Constants.TEXTURE_TRILINEAR_SAMPLINGMODE,
    );
    tex.name = 'studioEnv';
    tex.gammaSpace = false;
    return tex;
  }

  _defineBaseMaterials() {
    // metal(name, colour, roughness)
    this.metal('roseGold',   PALETTE.roseGold,   0.16);
    this.metal('yellowGold', PALETTE.yellowGold, 0.14);
    this.metal('whiteGold',  PALETTE.whiteGold,  0.13);
    this.metal('rhodium',    PALETTE.rhodium,    0.09);
    this.metal('darkChrome', PALETTE.darkChrome, 0.11);
    this.metal('ruby',       PALETTE.ruby,       0.10);

    // Signage gold: double-sided, because arrows are viewed from whichever
    // side the corner happens to face.
    this.metal('signGold', PALETTE.yellowGold, 0.24);
    this.mutate('signGold', (m) => { m.backFaceCulling = false; });

    // enamel(name, colour, roughness)
    this.enamel('cream',  PALETTE.cream,      0.55);
    this.enamel('shadow', PALETTE.shadowCool, 0.62);
  }

  /** Polished metal. Full metallic, low roughness, driven by the env. */
  metal(name, col, roughness = 0.15) {
    if (this.cache.has(name)) return this.cache.get(name);
    const m = new PBRMaterial(`m_${name}`, this.ctx.scene);
    m.albedoColor = new Color3(col.r, col.g, col.b);
    m.metallic = 1.0;
    m.roughness = roughness;
    m.environmentIntensity = 1.0;
    m.usePhysicalLightFalloff = true;
    m.freeze();
    this.cache.set(name, m);
    return m;
  }

  /** Soft enamel. Dielectric, matte-ish, for colour blocking. */
  enamel(name, col, roughness = 0.55) {
    if (this.cache.has(name)) return this.cache.get(name);
    const m = new PBRMaterial(`e_${name}`, this.ctx.scene);
    m.albedoColor = new Color3(col.r, col.g, col.b);
    m.metallic = 0.0;
    m.roughness = roughness;
    m.environmentIntensity = 1.0;
    m.freeze();
    this.cache.set(name, m);
    return m;
  }

  /** Look up an already-defined material. */
  get(name) {
    const m = this.cache.get(name);
    if (!m) throw new Error(`mat: no material "${name}"`);
    return m;
  }

  /**
   * Unfreeze, mutate, refreeze. Materials are frozen for performance, so any
   * runtime change must go through here.
   */
  mutate(name, fn) {
    const m = this.get(name);
    m.unfreeze();
    fn(m);
    m.freeze();
    return m;
  }

  dispose() {
    for (const m of this.cache.values()) m.dispose();
    this.cache.clear();
    if (this.env) this.env.dispose();
  }
}
