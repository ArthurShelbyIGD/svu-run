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
import { generateStoneMaps } from './stone.js';
import { generateGoldMaps } from './gold.js';
import { generateClothMaps } from './cloth.js';
import { generateTrackMaps } from './track.js';
import { toHalf } from './tex.js';

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
    /** Shared GPU textures, keyed by "<map>|<tile>". Disposed explicitly. */
    this.textures = new Map();
    this.env = null;
  }

  init() {
    const { scene, config } = this.ctx;

    this._buildSurfaceMaps();
    this.env = this._buildStudioEnv(config.q.envSize);
    scene.environmentTexture = this.env;
    // Tuned against the HDR environment below. The sources in that cubemap now
    // carry values well above 1.0, so the multiplier that used to be needed to
    // drag a clipped 8-bit environment up to something like jewellery lighting
    // would now blow every metal in the game out to white.
    scene.environmentIntensity = this._envHDR ? 1.0 : 1.55;

    // Warm cream backdrop, straight off the reference art.
    const c = PALETTE.cream;
    scene.clearColor.set(c.r, c.g, c.b, 1);

    this._defineBaseMaterials();
  }

  /**
   * Procedurally generate the studio lighting environment as a cube texture.
   *
   * This is the single most important function in the file. Every metal in the
   * game is a mirror; a mirror has no appearance of its own, only the
   * appearance of what it reflects. Material parameters are close to
   * irrelevant next to the structure and dynamic range of this cubemap.
   *
   * STRUCTURE. Four kinds of source, each doing a different job:
   *   softboxes   key / fill / rim. Broad shape and overall modelling.
   *   strip lights  eight tall narrow panels around the equator. These are
   *                 what draw the long vertical streaks down a curved polished
   *                 surface, and they are the single most recognisable signal
   *                 of "photographed jewellery". A dome with no vertical
   *                 structure gives a curved metal one soft blob and nothing
   *                 else, which is what made the first blockout read as
   *                 plastic.
   *   ring light    a hard bright annulus overhead. Puts a defined circular
   *                 catchlight on every dome — eyes, orb, boots.
   *   light tent    a scattered field of small sources over the full sphere,
   *                 so every pavé facet catches SOMETHING. See pave.js.
   *
   * DYNAMIC RANGE. Stored as RGBA16F where the GPU supports filtering it.
   * In 8 bits every source clips at 1.0, so a 20x key light and a 1.2x bounce
   * reflect as exactly the same white — the surface loses all sense of which
   * light is which, and bloom has nothing to key off. Half float costs 2 bytes
   * per channel (3 MB at the high preset, 200 KB at low) and is the difference
   * between highlights that glare and highlights that sit flat.
   */
  _buildStudioEnv(size) {
    const faces = [];
    const px = size * size * 4;
    const caps = this.ctx.scene.getEngine().getCaps();
    // Linear filtering of half-float textures is core in WebGL2, but the
    // capability is checked rather than assumed: a cubemap that cannot be
    // filtered would band horribly across every rough surface in the game.
    const hdr = !!(caps && caps.textureHalfFloatLinearFiltering);
    this._envHDR = hdr;
    // Without HDR storage everything has to fit under 1.0, so sources are
    // scaled down and the intensity multiplier makes up the difference.
    const K = hdr ? 1 : 0.19;

    // Softboxes in direction-space: [x, y, z, angular radius, intensity, warmth]
    const lights = [
      [ 0.45,  0.80,  0.40, 0.34,  7.0,  0.07],  // key, high front-left, warm
      [-0.70,  0.25,  0.30, 0.46,  2.6, -0.05],  // fill, low left, cool
      [ 0.10,  0.35, -0.95, 0.30,  4.4, -0.03],  // rim, behind, cool
      [-0.25,  0.94, -0.22, 0.16,  9.5,  0.02],  // small hot overhead
    ];

    // Vertical strip lights around the equator. Modelled as very tall, very
    // narrow softboxes: wide in elevation, tight in azimuth.
    const STRIPS = 8;
    const strips = [];
    for (let i = 0; i < STRIPS; i++) {
      const a = (i / STRIPS) * Math.PI * 2 + 0.35;
      strips.push([
        Math.cos(a), Math.sin(a),                 // azimuth direction
        i % 2 === 0 ? 2.6 : 1.3,                 // alternating intensity
        i % 3 === 0 ? 0.05 : -0.03,               // warmth
      ]);
    }

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
        0.048,
        y > -0.15 ? 7.5 : 3.4,                        // softer from below
        (i % 3 === 0) ? 0.05 : -0.02,
      ]);
    }
    for (const L of lights) {
      const n = Math.hypot(L[0], L[1], L[2]);
      L[0] /= n; L[1] /= n; L[2] /= n;
      L[4] *= K;
    }
    for (const S of strips) S[2] *= K;

    for (let f = 0; f < 6; f++) {
      const data = hdr ? new Uint16Array(px) : new Uint8Array(px);
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
          let r = 0.070 + up * 0.130;
          let g = 0.074 + up * 0.140;
          let b = 0.088 + up * 0.165;
          // warm floor bounce
          const down = Math.max(0, -dy);
          r += down * 0.105; g += down * 0.076; b += down * 0.048;
          // tight bright horizon band — this is what draws the long specular
          // streak across a curved polished surface and sells "jewellery"
          const horizon = Math.exp(-Math.abs(dy) * 16.0) * 0.26;
          r += horizon; g += horizon * 0.985; b += horizon * 0.95;

          // --- vertical strip lights ---
          // Bright over a wide band of elevation but only a few degrees of
          // azimuth. Cheap: the elevation term is one exponential and the
          // azimuth term is one dot product against a 2D direction.
          const hLen = Math.sqrt(dx * dx + dz * dz);
          if (hLen > 1e-4) {
            const ax = dx / hLen, az = dz / hLen;
            // Panels run from a little below the horizon to well above it.
            const elev = Math.exp(-Math.pow((dy - 0.18) / 0.62, 2));
            for (let i = 0; i < strips.length; i++) {
              const S = strips[i];
              const c = ax * S[0] + az * S[1];
              if (c < 0.972) continue;              // ~13 degrees wide
              const t = (c - 0.972) / 0.028;
              const s = t * t * (3 - 2 * t) * S[2] * elev * hLen;
              r += s * (1 + S[3]);
              g += s;
              b += s * (1 - S[3]);
            }
          }

          // --- overhead ring light ---
          // An annulus at about 35 degrees off vertical. Gives every dome in
          // the game a defined circular catchlight rather than a soft smear.
          const ring = Math.exp(-Math.pow((dy - 0.815) / 0.045, 2)) * 3.4 * K;
          r += ring * 1.02; g += ring; b += ring * 0.96;

          // --- softboxes ---
          for (let i = 0; i < lights.length; i++) {
            const L = lights[i];
            const d = dx * L[0] + dy * L[1] + dz * L[2];
            if (d <= 0) continue;
            const ang = Math.acos(Math.min(1, d));
            if (ang > L[3] * 1.9) continue;
            // Gaussian rather than a hard-edged disc. A hard disc reflected in
            // a smooth surface is a hard dot, and 56 of them turned the
            // character's polished face into a field of measles. A soft edge
            // gives the same sparkle on pavé and a continuous gradient on
            // anything smooth.
            const t = ang / L[3];
            const s = Math.exp(-t * t * 2.3) * L[4];
            r += s * (1 + L[5]);
            g += s;
            b += s * (1 - L[5]);
          }

          const o = (y * size + x) * 4;
          if (hdr) {
            data[o]     = toHalf(r);
            data[o + 1] = toHalf(g);
            data[o + 2] = toHalf(b);
            data[o + 3] = 0x3c00;                  // 1.0
          } else {
            data[o]     = Math.min(255, r * 255) | 0;
            data[o + 1] = Math.min(255, g * 255) | 0;
            data[o + 2] = Math.min(255, b * 255) | 0;
            data[o + 3] = 255;
          }
        }
      }
      faces.push(data);
    }

    const tex = new RawCubeTexture(
      this.ctx.scene,
      faces,
      size,
      Constants.TEXTUREFORMAT_RGBA,
      hdr ? Constants.TEXTURETYPE_HALF_FLOAT : Constants.TEXTURETYPE_UNSIGNED_BYTE,
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
    const q = this.ctx.config.q;
    const low = q.name === 'low';
    const size = low ? 256 : 512;
    // Stones deliberately COARSER than the first pass. At 18 cells tiled 2.6x
    // there were roughly 47 stones around the torso; the reference sets about
    // a dozen across the front, and at gameplay distance anything finer stops
    // being stones and becomes a knitted texture — which is exactly what the
    // character read as.
    const cells = low ? 8 : 11;

    // Keep the raw pixel data, not just the textures.
    //
    // Each material needs its own texture object because uScale/vScale live on
    // the texture, and Texture.clone() does NOT carry a RawTexture's pixel
    // data — cloning produced empty textures, which is why every pavé surface
    // rendered black while the smooth materials beside them lit correctly.
    // Textures ARE shared between materials that want the same map at the same
    // tiling, via this.textures — see _rawTex.
    this._size = size;
    this._paveSize = size;
    this._pave = generatePaveMaps(size, cells);
    this._brushSize = size >> 1;
    this._brush = generateBrushedMaps(this._brushSize);

    // Everything else. Generated once, at init, never per frame.
    this._maps = {
      stone: generateStoneMaps(size, 1),
      marble: generateStoneMaps(size, 0),
      gold: generateGoldMaps(size, low ? 7 : 10, 1),
      cloth: generateClothMaps(size, low ? 28 : 44),
      track: generateTrackMaps(size, 2, 1),
    };
  }

  /**
   * Fresh GPU texture from stored pixel data. Never clone a RawTexture.
   *
   * Shared by (key, tiling): four materials asking for hammered gold at the
   * same scale get one texture rather than four copies of the same megabyte.
   */
  _rawTex(key, data, size, gamma, tile) {
    const id = `${key}|${tile}|${gamma ? 'g' : 'l'}`;
    const hit = this.textures.get(id);
    if (hit) return hit;
    const t = RawTexture.CreateRGBATexture(
      data, size, size, this.ctx.scene, true, false,
      Texture.TRILINEAR_SAMPLINGMODE,
    );
    t.name = id;
    t.wrapU = Texture.WRAP_ADDRESSMODE;
    t.wrapV = Texture.WRAP_ADDRESSMODE;
    t.anisotropicFilteringLevel = this.ctx.config.q.anisotropy;
    t.gammaSpace = !!gamma;
    t.uScale = tile;
    t.vScale = tile;
    this.textures.set(id, t);
    return t;
  }

  /**
   * The general textured-surface builder. Everything that is not pavé or
   * brushed metal goes through here.
   *
   * `roughScale` and `metalScale` multiply the ORM map rather than replacing
   * it, which is what lets one generated map serve several materials: the same
   * marble finished four ways, the same hammered gold at four polishes.
   */
  surface(name, mapKey, col, opt) {
    if (this.cache.has(name)) return this.cache.get(name);
    const o = opt || {};
    const tile = o.tile === undefined ? 2 : o.tile;
    const maps = this._maps[mapKey];
    const m = new PBRMaterial(`s_${name}`, this.ctx.scene);
    m.albedoColor = new Color3(col.r, col.g, col.b);
    m.albedoTexture = this._rawTex(`${mapKey}_a`, maps.albedo, this._size, true, tile);
    m.bumpTexture = this._rawTex(`${mapKey}_n`, maps.normal, this._size, false, tile);
    m.bumpTexture.level = o.bump === undefined ? 1.0 : o.bump;
    m.invertNormalMapX = false;
    m.invertNormalMapY = true;      // see the note in pave() — one convention

    m.metallicTexture = this._rawTex(`${mapKey}_orm`, maps.orm, this._size, false, tile);
    m.useRoughnessFromMetallicTextureGreen = true;
    m.useMetallnessFromMetallicTextureBlue = true;
    m.useAmbientOcclusionFromMetallicTextureRed = true;
    // metallic/roughness SCALE the map. See the doc comment above.
    m.metallic = o.metalScale === undefined ? 1.0 : o.metalScale;
    m.roughness = o.roughScale === undefined ? 1.0 : o.roughScale;
    m.environmentIntensity = o.env === undefined ? 1.0 : o.env;
    m.usePhysicalLightFalloff = true;
    if (o.twoSided) m.backFaceCulling = false;
    if (o.build) o.build(m);
    m.freeze();
    this.cache.set(name, m);
    return m;
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
    m.albedoTexture = this._rawTex('pave_a', this._pave.albedo, this._paveSize, true, tile);
    m.metallic = 1.0;              // scaled per-pixel by the ORM blue channel
    m.roughness = 1.0;             // driven entirely by the ORM map
    // Set stones sit in a lit tent, not in the room's ambient. Lifting the
    // environment contribution for this material specifically is what keeps
    // the piece reading as jewellery when the zone around it is nearly black.
    m.environmentIntensity = 1.05;
    m.usePhysicalLightFalloff = true;

    m.bumpTexture = this._rawTex('pave_n', this._pave.normal, this._paveSize, false, tile);
    // Full-strength stone normals throw reflections so wide that most facets
    // sample the darkest part of the room. Softening keeps the sparkle while
    // holding the overall value up.
    m.bumpTexture.level = 0.88;
    m.invertNormalMapX = false;
    // NORMAL MAP Y CONVENTION, found by looking rather than by reasoning.
    // Every generator in mat/ writes ny = -dh/dpy with py measured DOWNWARD
    // through the pixel array. Rendered against Babylon's tangent frame that
    // comes out inverted: the pavé read as a golf ball — dimples where there
    // should be domes — and had done since the material shipped. No test can
    // see this; a single close-up makes it obvious. Flipped here for every
    // map in the directory rather than negating four generators.
    m.invertNormalMapY = true;

    m.metallicTexture = this._rawTex('pave_orm', this._pave.orm, this._paveSize, false, tile);
    m.useRoughnessFromMetallicTextureGreen = true;
    m.useMetallnessFromMetallicTextureBlue = true;
    m.useAmbientOcclusionFromMetallicTextureRed = true;

    // --- the glint ---------------------------------------------------------
    // A second, near-mirror specular lobe on top of the stone, driven by the
    // hard-edged crown facet map from pave.js. Because the coat is far
    // glossier than the stone underneath, its highlight is tiny, and because
    // the facet normals are piecewise constant it does not slide — it jumps
    // from facet to facet as the camera moves, which is exactly what a field
    // of cut stones does in life.
    //
    // Implemented with PBRMaterial's built-in clear-coat rather than a shader
    // override or a material plugin: it needs no new Babylon import (bjs.js is
    // lead-owned), it survives material.freeze(), and it is one extra branch
    // in a shader that is already compiled per-material.
    //
    // Gated on q.glint, which is false on the low preset.
    if (this.ctx.config.q.glint) {
      m.clearCoat.isEnabled = true;
      m.clearCoat.intensity = 0.30;
      m.clearCoat.roughness = 0.04;
      m.clearCoat.indexOfRefraction = 2.4;   // diamond
      m.clearCoat.bumpTexture = this._rawTex('pave_f', this._pave.facet, this._paveSize, false, tile);
      m.clearCoat.bumpTexture.level = 0.85;
      // Dispersion. A diamond's fire is coloured, and a thin-film term is the
      // cheapest believable stand-in for it: the flash shifts hue with angle
      // instead of being another white dot. Kept low — at any strength you can
      // actually notice as iridescence it stops looking like a diamond and
      // starts looking like an oil slick.
      // Iridescence is a second full BRDF branch on top of the clear coat.
      // Restricted to the top preset: it is the most expensive thing in the
      // material and the least load-bearing.
      m.iridescence.isEnabled = this.ctx.config.q.name === 'high';
      m.iridescence.intensity = 0.16;
      m.iridescence.indexOfRefraction = 1.5;
      m.iridescence.minimumThickness = 260;
      m.iridescence.maximumThickness = 520;
    }

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

    m.bumpTexture = this._rawTex('brush_n', this._brush.normal, this._brushSize, false, tile);
    m.bumpTexture.level = 0.55;
    m.invertNormalMapY = true;      // see the note in pave() — one convention

    m.metallicTexture = this._rawTex('brush_orm', this._brush.orm, this._brushSize, false, tile);
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
    this.pave('paveWhite', PALETTE.whiteGold, 1.9);
    this.pave('paveWhiteFine', PALETTE.whiteGold, 3.0);   // small parts
    this.pave('paveRuby', PALETTE.ruby, 2.3);

    // ---------------------------------------------------------------
    // MATERIAL NAME CONTRACT
    //
    // These names exist so that char/, world/ and track/ can be written
    // against them in parallel with mat/ improving what is behind them.
    // Placeholder implementations are fine; the NAMES are the interface and
    // must not change. Anything using a name that does not exist throws, which
    // is deliberate — a silent fallback would hide the wiring mistake.
    // ---------------------------------------------------------------
    // --- stone ---
    // One generated marble, finished four ways. The albedo map is luminance
    // only and is tinted here, so four stones cost one megabyte rather than
    // four. Tints run above 1.0 where the target is lighter than the map's
    // mid-grey; Babylon multiplies straight through and that is intended.
    this.surface('stoneCarved', 'stone', { r: 1.00, g: 0.94, b: 0.84 },
      { tile: 1.6, bump: 1.0, roughScale: 1.0 });
    this.surface('stonePolished', 'marble', { r: 1.14, g: 1.08, b: 0.98 },
      { tile: 1.6, bump: 0.5, roughScale: 0.62 });
    this.surface('marbleDark', 'marble', { r: 0.30, g: 0.30, b: 0.36 },
      { tile: 1.2, bump: 0.45, roughScale: 0.52 });
    this.surface('marbleLight', 'marble', { r: 1.42, g: 1.38, b: 1.30 },
      { tile: 1.2, bump: 0.45, roughScale: 0.48 });

    // --- gold ---
    // Hammered and leafed. goldTrim tiles far finer because it goes on small
    // parts, and hammer dishes that change physical size between the trim and
    // the panel it sits on is the fastest way to break the illusion.
    this.surface('goldLeaf', 'gold', PALETTE.yellowGold,
      { tile: 3.0, bump: 0.70, roughScale: 1.10 });
    this.surface('goldTrim', 'gold', PALETTE.yellowGold,
      { tile: 6.0, bump: 0.55, roughScale: 0.85 });

    // --- track ---
    this.surface('trackStone', 'track', { r: 1, g: 1, b: 1 },
      { tile: 2.5, bump: 0.85, roughScale: 1.0 });
    this.surface('trackInlay', 'gold', PALETTE.yellowGold,
      { tile: 4.0, bump: 0.5, roughScale: 0.75 });

    this.enamel('glassGem', PALETTE.ruby, 0.08);

    // --- cloth ---
    // Double-sided by definition, since a cape is a sheet. The sheen lobe is
    // the part that makes it cloth rather than a painted sheet of plastic: it
    // is a retroreflective term that lifts the grazing-angle edge, which is
    // where a cape is read from — the silhouette, in motion.
    this.surface('clothCape', 'cloth', { r: 0.42, g: 0.43, b: 0.50 }, {
      tile: 3.0, bump: 1.0, roughScale: 1.0, twoSided: true,
      build: (m) => {
        m.sheen.isEnabled = true;
        m.sheen.intensity = 0.85;
        m.sheen.color = new Color3(0.92, 0.90, 0.98);
        m.sheen.roughness = 0.35;
        // Without albedo scaling the sheen is added on top of a fully lit
        // base and the fabric goes milky. With it, energy is taken from the
        // diffuse term, which is what heavy cloth actually does.
        m.sheen.albedoScaling = true;
      },
    });

    // --- polished, unset metal: face, hands, boots, trim ---
    this.brushed('polRose', PALETTE.roseGold, 3, 0.95);
    this.brushed('polRhodium', PALETTE.rhodium, 3, 0.70);
    this.brushed('polGold', PALETTE.yellowGold, 3, 0.85);

    // --- the structural metals -------------------------------------------
    // These are the rails, the lane inlays, the columns, the obstacles, the
    // junction wall and the collectible stars — most of the non-floor pixels
    // in the game. They shipped as flat colours with a single roughness, which
    // gives a curved metal exactly one soft highlight and a straight one none
    // at all. Now they are planished: overlapping hammer dishes whose rims
    // break the reflection into dozens of separate glints that travel as the
    // camera moves. It is the same generated map at different tilings and
    // polishes, so the whole set costs one texture.
    //
    // TILING IS SIZE. Every one of these sits on a mesh with 0..1 UVs over a
    // wildly different physical extent — a 5.2 m column, an 8 m rail, a 0.4 m
    // star — so the tile number is the only thing keeping the hammer dishes
    // the same physical size across the set. At tile 2 a column's dishes came
    // out a metre across and it read as tree bark, not as metal.
    this.surface('roseGold',   'gold', PALETTE.roseGold,
      { tile: 5.0, bump: 0.40, roughScale: 1.0 });
    this.surface('yellowGold', 'gold', PALETTE.yellowGold,
      { tile: 4.0, bump: 0.45, roughScale: 0.95 });
    this.surface('whiteGold',  'gold', PALETTE.whiteGold,
      { tile: 4.0, bump: 0.40, roughScale: 0.85 });
    this.surface('rhodium',    'gold', PALETTE.rhodium,
      { tile: 4.0, bump: 0.32, roughScale: 0.60 });
    this.surface('darkChrome', 'gold', PALETTE.darkChrome,
      { tile: 6.0, bump: 0.45, roughScale: 0.95 });
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
    // own value instead of borrowing the sky's — and now the surface has real
    // structure: inlaid marble slabs, deep chamfered joints, a gold pinstripe
    // and a lozenge where four slabs meet. See track.js. The joint grid is
    // also the strongest sense-of-speed signal in the game, which is a
    // gameplay argument for it and not only a visual one.
    //
    // The albedo tint stays at 1.0: unlike the stone maps, track.js writes
    // real colour (dark blue-grey marble, warm gold inlay) because the two
    // materials in it have to be different hues, not different values.
    this.surface('trackFloor', 'track', { r: 1, g: 1, b: 1 },
      { tile: 2.5, bump: 0.85, roughScale: 1.0 });

    // Signage gold: double-sided, because arrows are viewed from whichever
    // side the corner happens to face.
    this.surface('signGold', 'gold', PALETTE.yellowGold,
      { tile: 3.0, bump: 0.45, roughScale: 1.1, twoSided: true });

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
    this.brushed('wingChrome', PALETTE.wingChrome, 2, 0.55);
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
    // Materials first, without forcing texture disposal: textures are SHARED
    // between materials now, so letting each material dispose its own would
    // double-free. They are owned by this.textures and released once, here.
    for (const m of this.cache.values()) m.dispose(false, false);
    this.cache.clear();
    for (const t of this.textures.values()) t.dispose();
    this.textures.clear();
    this._maps = null;
    this._pave = null;
    this._brush = null;
    if (this.env) this.env.dispose();
  }
}
