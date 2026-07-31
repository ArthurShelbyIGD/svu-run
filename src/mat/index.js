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
  PBRMaterial, RawCubeTexture, RawTexture, Color3, Constants, Engine, Texture,
} from '../core/bjs.js';
import { generatePaveMaps, generateBrushedMaps } from './pave.js';

/** Named palette. Keep this list short — a small palette is the art direction. */
export const PALETTE = {
  // Pushed warmer and more saturated than a literal rose gold. In a dark room
  // a subtle warm metal reads as "slightly off-white silver" and the face
  // stops separating from the hood, which is the difference between a
  // character and a chrome ball with eyes.
  roseGold:   { r: 0.985, g: 0.660, b: 0.455 },
  yellowGold: { r: 1.000, g: 0.790, b: 0.310 },
  whiteGold:  { r: 0.965, g: 0.955, b: 0.945 },
  rhodium:    { r: 0.905, g: 0.915, b: 0.930 },
  darkChrome: { r: 0.300, g: 0.310, b: 0.335 },
  wingChrome: { r: 0.470, g: 0.485, b: 0.530 },
  ruby:       { r: 0.760, g: 0.090, b: 0.180 },
  cream:      { r: 0.960, g: 0.940, b: 0.905 },
  eyeDark:    { r: 0.055, g: 0.062, b: 0.085 },
  eyeIris:    { r: 0.180, g: 0.290, b: 0.420 },
  earInner:   { r: 0.930, g: 0.660, b: 0.560 },
  shadowCool: { r: 0.520, g: 0.545, b: 0.610 },
  trackDark:  { r: 0.255, g: 0.270, b: 0.320 },
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

    this._buildSurfaceMaps();
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

    // A jeweller's light tent: a scattered field of small, very bright
    // sources. This is not decoration — a pavé surface is thousands of tiny
    // mirrors, and with only a few broad softboxes to reflect, most stones
    // reflect nothing and the whole surface reads as dark grey. Many small
    // sources means every stone catches something, which is what produces
    // sparkle. It is how jewellery is actually photographed.
    // Distributed over the FULL sphere, not just above. A pavé stone tilted
    // downward reflects whatever is below it, and with an upper-hemisphere-only
    // tent that is darkness — which rendered the suit black while the smooth
    // face beside it stayed bright. A real light tent surrounds the piece.
    const TENT = 56;
    for (let i = 0; i < TENT; i++) {
      const t = (i + 0.5) / TENT;
      const y = 1 - 2 * t;                            // full sphere
      const r = Math.sqrt(Math.max(0, 1 - y * y));
      const theta = i * 2.39996;                      // golden angle
      lights.push([
        r * Math.cos(theta),
        y * 0.92,
        r * Math.sin(theta),
        0.070,
        y > -0.15 ? 1.75 : 1.05,                      // softer from below
        (i % 3 === 0) ? 0.05 : -0.02,
      ]);
    }
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
          // Floor raised off pure black. Anything a stone reflects that is
          // exactly zero becomes a dead facet, and a pavé surface is mostly
          // facets pointing away from the key light.
          let r = 0.085 + up * 0.155;
          let g = 0.090 + up * 0.165;
          let b = 0.105 + up * 0.190;
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

  /**
   * Generate the shared surface detail textures.
   *
   * This is the single most important thing in this file. Everything before it
   * rendered as smooth flat-shaded metal, which is why the build read as a
   * prototype regardless of how the geometry or lighting were tuned: modern
   * rendering gets most of its character from surface detail, not from shape.
   */
  _buildSurfaceMaps() {
    const scene = this.ctx.scene;
    const q = this.ctx.config.q;
    const size = q.name === 'low' ? 256 : 512;
    const cells = q.name === 'low' ? 12 : 18;

    // Keep the raw pixel data, not just the textures.
    //
    // Each material needs its own texture object because uScale/vScale live on
    // the texture, and Texture.clone() does NOT carry a RawTexture's pixel
    // data — cloning produced empty textures, which is why every pavé surface
    // rendered black while the smooth materials beside them lit correctly.
    this._paveSize = size;
    this._pave = generatePaveMaps(size, cells);
    this._brushSize = size >> 1;
    this._brush = generateBrushedMaps(this._brushSize);
  }

  /** Fresh GPU texture from stored pixel data. Never clone a RawTexture. */
  _rawTex(name, data, size, gamma) {
    const t = RawTexture.CreateRGBATexture(
      data, size, size, this.ctx.scene, true, false,
      Texture.TRILINEAR_SAMPLINGMODE,
    );
    t.name = name;
    t.wrapU = Texture.WRAP_ADDRESSMODE;
    t.wrapV = Texture.WRAP_ADDRESSMODE;
    t.anisotropicFilteringLevel = this.ctx.config.q.anisotropy;
    t.gammaSpace = !!gamma;
    return t;
  }

  /**
   * Stone-set metal. The hero material of the project.
   *
   * `tile` controls stone density on that surface — a hand needs far more
   * repeats than a torso to keep the stones the same physical size, and stones
   * that change size between body parts is the fastest way to break the
   * illusion.
   */
  pave(name, col, tile = 4) {
    if (this.cache.has(name)) return this.cache.get(name);
    const m = new PBRMaterial(`p_${name}`, this.ctx.scene);
    m.albedoColor = new Color3(col.r, col.g, col.b);
    m.metallic = 1.0;              // scaled per-pixel by the ORM blue channel
    m.roughness = 1.0;             // driven entirely by the ORM map
    // Set stones sit in a lit tent, not in the room's ambient. Lifting the
    // environment contribution for this material specifically is what keeps
    // the piece reading as jewellery when the zone around it is nearly black.
    m.environmentIntensity = 2.4;
    m.usePhysicalLightFalloff = true;

    m.bumpTexture = this._rawTex(`${name}_n`, this._pave.normal, this._paveSize, false);
    m.bumpTexture.uScale = tile;
    m.bumpTexture.vScale = tile;
    // Full-strength stone normals throw reflections so wide that most facets
    // sample the darkest part of the room. Softening keeps the sparkle while
    // holding the overall value up.
    m.bumpTexture.level = 0.72;
    m.invertNormalMapX = false;
    m.invertNormalMapY = false;

    m.metallicTexture = this._rawTex(`${name}_orm`, this._pave.orm, this._paveSize, false);
    m.metallicTexture.uScale = tile;
    m.metallicTexture.vScale = tile;
    m.useRoughnessFromMetallicTextureGreen = true;
    m.useMetallnessFromMetallicTextureBlue = true;
    m.useAmbientOcclusionFromMetallicTextureRed = true;

    m.freeze();
    this.cache.set(name, m);
    return m;
  }

  /** Polished metal with real micro-structure. Chrome, gold trim, hardware. */
  brushed(name, col, tile = 3, roughScale = 1) {
    if (this.cache.has(name)) return this.cache.get(name);
    const m = new PBRMaterial(`b_${name}`, this.ctx.scene);
    m.albedoColor = new Color3(col.r, col.g, col.b);
    m.metallic = 1.0;
    m.roughness = roughScale;
    m.environmentIntensity = 1.0;

    m.bumpTexture = this._rawTex(`${name}_n`, this._brush.normal, this._brushSize, false);
    m.bumpTexture.uScale = tile;
    m.bumpTexture.vScale = tile;
    m.bumpTexture.level = 0.55;

    m.metallicTexture = this._rawTex(`${name}_orm`, this._brush.orm, this._brushSize, false);
    m.metallicTexture.uScale = tile;
    m.metallicTexture.vScale = tile;
    m.useRoughnessFromMetallicTextureGreen = true;
    m.useMetallnessFromMetallicTextureBlue = true;
    m.useAmbientOcclusionFromMetallicTextureRed = true;

    m.freeze();
    this.cache.set(name, m);
    return m;
  }

  _defineBaseMaterials() {
    // --- stone-set surfaces: the onesie, the hood, the ears ---
    // Tiling chosen so stones are the same physical size everywhere and are
    // individually readable at gameplay distance. Too fine and pavé stops
    // being stones and becomes noise.
    this.pave('paveWhite', PALETTE.whiteGold, 2.6);
    this.pave('paveWhiteFine', PALETTE.whiteGold, 4.5);   // small parts
    this.pave('paveRuby', PALETTE.ruby, 3.2);

    // ---------------------------------------------------------------
    // MATERIAL NAME CONTRACT
    //
    // These names exist so that char/, world/ and track/ can be written
    // against them in parallel with mat/ improving what is behind them.
    // Placeholder implementations are fine; the NAMES are the interface and
    // must not change. Anything using a name that does not exist throws, which
    // is deliberate — a silent fallback would hide the wiring mistake.
    // ---------------------------------------------------------------
    this.metal('stoneCarved', { r: 0.62, g: 0.58, b: 0.52 }, 0.72);
    this.metal('stonePolished', { r: 0.70, g: 0.66, b: 0.60 }, 0.34);
    this.enamel('marbleDark', { r: 0.16, g: 0.15, b: 0.18 }, 0.28);
    this.enamel('marbleLight', { r: 0.86, g: 0.84, b: 0.80 }, 0.24);
    this.metal('goldLeaf', PALETTE.yellowGold, 0.30);
    this.metal('goldTrim', PALETTE.yellowGold, 0.16);
    this.metal('trackInlay', PALETTE.yellowGold, 0.22);
    this.metal('trackStone', { r: 0.30, g: 0.31, b: 0.36 }, 0.46);
    this.enamel('glassGem', PALETTE.ruby, 0.08);
    // Cape cloth: double-sided by definition, since a cape is a sheet.
    this.metal('clothCape', { r: 0.34, g: 0.35, b: 0.40 }, 0.38);
    this.mutate('clothCape', (m) => { m.backFaceCulling = false; });

    // --- polished, unset metal: face, hands, boots, trim ---
    this.brushed('polRose', PALETTE.roseGold, 3, 0.14);
    this.brushed('polRhodium', PALETTE.rhodium, 3, 0.10);
    this.brushed('polGold', PALETTE.yellowGold, 3, 0.13);

    // metal(name, colour, roughness)
    this.metal('roseGold',   PALETTE.roseGold,   0.16);
    this.metal('yellowGold', PALETTE.yellowGold, 0.14);
    this.metal('whiteGold',  PALETTE.whiteGold,  0.13);
    this.metal('rhodium',    PALETTE.rhodium,    0.09);
    this.metal('darkChrome', PALETTE.darkChrome, 0.11);
    this.metal('ruby',       PALETTE.ruby,       0.10);

    // The track floor is NOT a mirror, and that is a deliberate correction.
    //
    // It shipped at roughness 0.09 — polished rhodium — which looked correct in
    // the software-rendered test harness and rendered almost pure white on real
    // hardware, because a mirror at a grazing angle reflects the bright horizon
    // of the studio environment. Against a cream backdrop the track simply
    // vanished and the character appeared to run through empty space.
    //
    // A satin finish keeps the jewellery language while giving the surface its
    // own value instead of borrowing the sky's.
    this.metal('trackFloor', PALETTE.trackDark, 0.42);

    // Signage gold: double-sided, because arrows are viewed from whichever
    // side the corner happens to face.
    this.metal('signGold', PALETTE.yellowGold, 0.24);
    this.mutate('signGold', (m) => { m.backFaceCulling = false; });

    // --- character ---
    // Eyes are the single biggest factor in whether the character is
    // recognisable, so they get their own materials rather than reusing
    // anything. Near-black and very glossy, with a separate emissive
    // catchlight, because a chibi eye without a highlight reads as dead.
    this.enamel('eyeDark', PALETTE.eyeDark, 0.06);
    this.enamel('eyeIris', PALETTE.eyeIris, 0.10);
    this.enamel('earInner', PALETTE.earInner, 0.42);
    this.glow('catchlight', { r: 1, g: 1, b: 1 }, 1.35);
    this.glow('rubyGlow', PALETTE.ruby, 0.55);

    // The wing membrane is a single-sided sheet, so it must render from both
    // faces or it disappears whenever the character turns.
    // Lighter than the structural dark chrome. The membrane is a thin sheet
    // catching light from one side; at darkChrome's value it rendered as a
    // black cut-out with no form at all.
    this.metal('wingChrome', PALETTE.wingChrome, 0.13);
    this.mutate('wingChrome', (m) => { m.backFaceCulling = false; });

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

  /**
   * Self-lit material. Used for eye catchlights and gem cores — things that
   * must stay bright regardless of where the character is standing, and which
   * the bloom pass then blooms into a highlight.
   */
  glow(name, col, intensity = 1.0) {
    if (this.cache.has(name)) return this.cache.get(name);
    const m = new PBRMaterial(`g_${name}`, this.ctx.scene);
    m.albedoColor = new Color3(col.r * 0.2, col.g * 0.2, col.b * 0.2);
    m.emissiveColor = new Color3(col.r * intensity, col.g * intensity, col.b * intensity);
    m.metallic = 0.0;
    m.roughness = 0.35;
    m.environmentIntensity = 0.4;
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
