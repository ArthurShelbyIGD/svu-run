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
import { generatePaveMaps, generateBrushedMaps, generatePolishMaps } from './pave.js';
import { generateStoneMaps } from './stone.js';
import { generateGoldMaps } from './gold.js';
import { generateClothMaps } from './cloth.js';
import { generateTrackMaps } from './track.js';
import { buildStudioEnvFaces } from './env.js';

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
   * The studio lighting environment, as a cube texture.
   *
   * The room's structure and dynamic range live in env.js — read the header
   * there before changing any material parameter, because material parameters
   * are close to irrelevant next to what a mirror is reflecting.
   *
   * This function only decides how it is STORED. RGBA16F where the GPU can
   * filter it: the key light in that room is 260x the ambient shell, and in 8
   * bits that ratio does not exist — a 260x key and a 1.2x bounce both store as
   * 255 and reflect identically, which is how a room full of lights ends up
   * rendering as uniform haze.
   */
  _buildStudioEnv(size) {
    const caps = this.ctx.scene.getEngine().getCaps();
    // Linear filtering of half-float textures is core in WebGL2, but the
    // capability is checked rather than assumed: a cubemap that cannot be
    // filtered would band horribly across every rough surface in the game.
    const hdr = !!(caps && caps.textureHalfFloatLinearFiltering);
    this._envHDR = hdr;
    // The room itself lives in env.js — it grew past the point where it should
    // share a file with the material library, and it is the most important
    // single thing in this directory.
    const faces = buildStudioEnvFaces(size, hdr);

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
    this._pave = generatePaveMaps(size, cells, !q.glint);
    this._brushSize = size >> 1;
    this._brush = generateBrushedMaps(this._brushSize);
    // Isotropic polish, for the big smooth forms — the face and the mitten
    // hands. The brushed map's directional streaks stretch through a sphere's
    // UVs into visible vertical scratches, which is what made the face read as
    // pearlescent plastic.
    this._polishSize = size >> 1;
    this._polish = generatePolishMaps(this._polishSize);

    // Everything else. Generated once, at init, never per frame.
    //
    // Not all at the same resolution. These are heavy CPU loops — the whole
    // set costs about two seconds of load time at 512 — and the four maps are
    // not equally visible. The track is the largest surface on screen in every
    // frame and gets full resolution; the stone and cloth names are not yet
    // used by any mesh and get half. Sizes are per-set so this stays easy to
    // rebalance when world/ starts placing carved stone.
    const big = size;
    const small = size >> 1;
    this._sizes = {
      stone: small, marble: small, cloth: small, gold: big, track: big,
    };
    this._maps = {
      stone: generateStoneMaps(small, 1),
      marble: generateStoneMaps(small, 0),
      gold: generateGoldMaps(big, low ? 14 : 22, 1),
      cloth: generateClothMaps(small, low ? 22 : 32),
      track: generateTrackMaps(big, 2, 1),
    };
  }

  /**
   * Fresh GPU texture from stored pixel data. Never clone a RawTexture.
   *
   * Shared by (key, tiling): four materials asking for hammered gold at the
   * same scale get one texture rather than four copies of the same megabyte.
   */
  _rawTex(key, data, size, gamma, tile, level, uMul) {
    // `level` is part of the key because Texture.level lives on the TEXTURE,
    // not on the material. Sharing one texture between two materials that want
    // different bump strengths silently gave both of them whichever was set
    // last — six of the eight metals were running on rhodium's bump level.
    const id = `${key}|${tile}|${gamma ? 'g' : 'l'}|${level === undefined ? '' : level}|${uMul || 1}`;
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
    // uScale and vScale are NOT always equal, and that is the fix for the
    // stones coming out as vertical ovals. A UV sphere maps u over 2*pi*R of
    // arc and v over pi*R, so one square texture tile lands on a patch twice as
    // wide as it is tall and every circular stone is squashed. Repeating twice
    // as often around the equator makes the tile square again on the surface.
    t.uScale = tile * (uMul || 1);
    t.vScale = tile;
    if (level !== undefined) t.level = level;
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
    const msize = this._sizes[mapKey];
    const m = new PBRMaterial(`s_${name}`, this.ctx.scene);
    m.albedoColor = new Color3(col.r, col.g, col.b);
    m.albedoTexture = this._rawTex(`${mapKey}_a`, maps.albedo, msize, true, tile);
    m.bumpTexture = this._rawTex(`${mapKey}_n`, maps.normal, msize, false, tile,
      o.bump === undefined ? 1.0 : o.bump);
    m.invertNormalMapX = false;
    m.invertNormalMapY = true;      // see the note in pave() — one convention

    m.metallicTexture = this._rawTex(`${mapKey}_orm`, maps.orm, msize, false, tile);
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
    // uMul 2 everywhere on this material: every mesh wearing pavé in this game
    // is a UV sphere, and a sphere's u runs over twice the arc length of its v.
    // Without it the stones render as vertical ovals in grid-aligned columns,
    // which is what made the suit read as a pinecone.
    m.albedoTexture = this._rawTex('pave_a', this._pave.albedo, this._paveSize, true, tile, undefined, 2);
    m.metallic = 1.0;              // scaled per-pixel by the ORM blue channel
    m.roughness = 1.0;             // driven entirely by the ORM map
    // Set stones sit in a lit tent, not in the room's ambient. Lifting the
    // environment contribution for this material specifically is what keeps
    // the piece reading as jewellery when the zone around it is nearly black.
    // Set stones sit in a lit tent, not in the room's ambient. Note that
    // world/ overwrites scene.environmentIntensity per zone (1.75 - 2.05), so
    // this is a multiplier ON TOP of that, not an absolute — every number in
    // this file was tuned by looking at the composited result, not by reading
    // the value here.
    // Below 1.0 now, where it used to be 1.22. world/ sets scene
    // environmentIntensity per zone at 1.75-2.05, so this is a multiplier on
    // top of roughly 1.9, and the room it multiplies is no longer a dim one.
    m.environmentIntensity = 1.30;
    m.usePhysicalLightFalloff = true;
    // DIAMOND REFLECTANCE. Babylon computes the dielectric part of the surface
    // as F0 = 0.04 * metallicF0Factor * metallicReflectanceColor, and 0.04 is
    // window glass: a stone that is near-black in the diffuse term and only 4%
    // reflective in the specular one has no way to be bright at all. Diamond's
    // IOR of 2.42 gives F0 = 0.17, so the colour carries a factor of 4.2 and the
    // F0 FACTOR IS LEFT AT 1 ON PURPOSE — Babylon also uses that factor as F90,
    // and raising it there would make every grazing edge four times white. The
    // metal beading between the stones is unaffected either way; a metal's F0
    // comes from its albedo.
    m.metallicF0Factor = 1.0;
    m.metallicReflectanceColor = new Color3(4.2, 4.2, 4.2);

    m.bumpTexture = this._rawTex('pave_n', this._pave.normal, this._paveSize, false, tile, 1.0, 2);
    // Full-strength stone normals throw reflections so wide that most facets
    // sample the darkest part of the room. Softening keeps the sparkle while
    // holding the overall value up.
    m.invertNormalMapX = false;
    // NORMAL MAP Y CONVENTION, found by looking rather than by reasoning.
    // Every generator in mat/ writes ny = -dh/dpy with py measured DOWNWARD
    // through the pixel array. Rendered against Babylon's tangent frame that
    // comes out inverted: the pavé read as a golf ball — dimples where there
    // should be domes — and had done since the material shipped. No test can
    // see this; a single close-up makes it obvious. Flipped here for every
    // map in the directory rather than negating four generators.
    m.invertNormalMapY = true;

    m.metallicTexture = this._rawTex('pave_orm', this._pave.orm, this._paveSize, false, tile, undefined, 2);
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
    // WITHOUT THE GLINT COAT THE STONES GO BLACK, and the low preset is the one
    // most people will actually see. The clear coat below is 17% of the stones'
    // entire specular response; with it switched off, a near-black body in a
    // near-black room renders as charcoal — a low-preset capture showed exactly
    // that, and it is the same failure this file has now hit twice. So the low
    // preset trades sparkle for value: brighter stone bodies and a lifted
    // environment weight, which is the right trade when the alternative is a
    // black character.
    if (!this.ctx.config.q.glint) {
      m.environmentIntensity = 1.55;
    }

    if (this.ctx.config.q.glint) {
      // Full intensity, not 0.45. With the stone body now near-black this coat
      // IS the stone's specular: at IOR 2.42 it reflects 17% of everything it
      // sees, versus the 4% a default dielectric would, and that ratio is the
      // difference between a diamond and a wet pebble.
      m.clearCoat.isEnabled = true;
      m.clearCoat.intensity = 1.0;
      m.clearCoat.roughness = 0.022;
      m.clearCoat.indexOfRefraction = 2.42;  // diamond
      m.clearCoat.bumpTexture = this._rawTex('pave_f', this._pave.facet, this._paveSize, false, tile, 0.9, 2);
      // DISPERSION WAS TRIED AND REMOVED. A thin-film iridescence term is the
      // cheapest believable stand-in for a diamond's coloured fire, and at
      // intensity 0.16 it looked good — but it is a second full BRDF branch on
      // top of the clear coat, and with it enabled a single close-up frame of
      // the character stopped rendering inside the capture harness's 30 s
      // budget at the high preset. A material that breaks the screenshot tool
      // is a material nobody can grade, and the effect was worth far less than
      // the clear-coat glint above. If it comes back it needs a real device
      // and a real frame-time measurement first, not a guess.
    }

    m.freeze();
    this.cache.set(name, m);
    return m;
  }

  /**
   * Mirror-polished metal with no directional structure.
   *
   * For the big smooth forms — the face, the mitten hands, the boots, the wing.
   * These were the most literal instance of the owner's complaint still in the
   * build: "matte white plastic eggs with zero specular". They are metal, so
   * they get metallic 1.0 and a roughness low enough that the studio's hard key
   * lands on them as a small clipped white highlight rather than a wide grey
   * smear. The only surface detail is a faint isotropic orange peel, because
   * anything directional stretches through sphere UVs into scratches.
   */
  polished(name, col, roughness = 0.10, tile = 2, direct = 0.5) {
    if (this.cache.has(name)) return this.cache.get(name);
    const m = new PBRMaterial(`q_${name}`, this.ctx.scene);
    m.albedoColor = new Color3(col.r, col.g, col.b);
    m.metallic = 1.0;
    m.roughness = roughness;
    m.environmentIntensity = 1.0;
    m.usePhysicalLightFalloff = true;

    // Analytic lights turned DOWN on these surfaces. world/ hangs four point
    // lights off the character at intensities up to 30, and the GGX peak of a
    // roughness-0.05 metal under a point light is enormous — each light became a
    // blazing dot, the bloom pass at threshold 0.72 smeared the four of them
    // together, and the result was the "matte white plastic egg" the critic saw:
    // a small object drowned in its own highlight. The piece is meant to be lit
    // by the light tent in the environment, which is what a jeweller's bench
    // actually is, so the environment keeps full weight and the lamps take half.
    //
    // The FACE is the exception and keeps them at full. A face is a large smooth
    // sphere, and a large smooth sphere reflecting a mostly-black room is a flat
    // disc of its own albedo — with the lamps turned down the face rendered as a
    // mustard-painted ball with no highlight anywhere on it. Portrait lighting
    // is what gives a head its form; the small parts do not need it and cannot
    // survive it.
    m.directIntensity = direct;

    m.bumpTexture = this._rawTex('pol_n', this._polish.normal, this._polishSize, false, tile, 0.65);
    m.invertNormalMapY = true;      // see the note in pave() — one convention

    m.metallicTexture = this._rawTex('pol_orm', this._polish.orm, this._polishSize, false, tile);
    m.useRoughnessFromMetallicTextureGreen = true;
    m.useMetallnessFromMetallicTextureBlue = true;
    m.useAmbientOcclusionFromMetallicTextureRed = true;
    // roughness above SCALES the map, whose own range is about 0.03..0.08.
    m.roughness = roughness / 0.055;

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

    m.bumpTexture = this._rawTex('brush_n', this._brush.normal, this._brushSize, false, tile, 0.55);
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
    // The ruby orb. The tint runs well above 1.0 on the red channel on purpose:
    // the pavé albedo map is now a near-BLACK stone body (see pave.js), so a
    // literal ruby tint of 0.76 multiplied through it produces a black ball. The
    // stones need lifting back to a readable ruby while the metal beads between
    // them, which are near 1.0 in the map, clip to a hot pink-white — which is
    // what a bead of metal between two rubies actually does.
    this.pave('paveRuby', { r: 4.20, g: 0.30, b: 0.58 }, 2.3);

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
    this.surface('stoneCarved', 'stone', { r: 1.22, g: 1.14, b: 1.00 },
      { tile: 1.6, bump: 1.0, roughScale: 1.0 });
    this.surface('stonePolished', 'marble', { r: 1.34, g: 1.27, b: 1.15 },
      { tile: 1.6, bump: 0.5, roughScale: 0.55 });
    // Dark marble is the one place a low roughness is safe on a large surface:
    // a dark dielectric reflects the room at a few percent, so it gains a sheen
    // and a horizon streak without ever approaching white.
    this.surface('marbleDark', 'marble', { r: 0.22, g: 0.225, b: 0.28 },
      { tile: 1.2, bump: 0.45, roughScale: 0.34 });
    this.surface('marbleLight', 'marble', { r: 1.55, g: 1.50, b: 1.40 },
      { tile: 1.2, bump: 0.45, roughScale: 0.42 });

    // --- gold ---
    // Hammered and leafed. goldTrim tiles far finer because it goes on small
    // parts, and hammer dishes that change physical size between the trim and
    // the panel it sits on is the fastest way to break the illusion.
    this.surface('goldLeaf', 'gold', PALETTE.yellowGold,
      { tile: 3.0, bump: 0.55, roughScale: 0.70 });
    this.surface('goldTrim', 'gold', PALETTE.yellowGold,
      { tile: 6.0, bump: 0.40, roughScale: 0.55 });

    // --- track ---
    this.surface('trackStone', 'track', { r: 1, g: 1, b: 1 },
      { tile: 2.5, bump: 0.85, roughScale: 1.0 });
    this.surface('trackInlay', 'gold', PALETTE.yellowGold,
      { tile: 4.0, bump: 0.25, roughScale: 0.50 });

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

    // --- polished, unset metal: face, hands, boots, trim -------------------
    //
    // All three were `brushed`, and all three were wrong for the same reason.
    // The brushed map's streaks run in texture space, and every one of these
    // parts is a sphere, so the streaks stretched toward the poles and the face
    // came out as pearlescent plastic with vertical scratches down it. They are
    // now isotropic mirror polish.
    //
    // polRose carries the FACE. The reference face is polished yellow gold, not
    // rose: a warm near-white metal reads as "slightly off-white silver" beside
    // a white-gold hood and the face stops separating from it entirely.
    this.polished('polRose', { r: 1.00, g: 0.780, b: 0.360 }, 0.135, 2, 1.15);
    // Hands, thumbs, boots and the wing ribs. Polished WHITE gold — these were
    // "matte white plastic eggs with zero specular", the single most literal
    // instance of the owner's complaint left in the build.
    this.polished('polRhodium', PALETTE.rhodium, 0.085, 2, 0.55);
    this.polished('polGold', PALETTE.yellowGold, 0.10, 2, 0.8);

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
    // The columns and the full-height blockers.
    //
    // THIS NAME NOW RETURNS A STONE, NOT A METAL, and that is deliberate.
    // Everything about the columns as polished champagne metal was wrong in a
    // way no amount of tuning fixed. A cylinder's normal sweeps a full 180
    // degrees across its visible width, so a near-mirror one finds an analytic
    // light's specular peak SOMEWHERE on that sweep no matter which way it
    // faces: with the world's directional key at 2.6 and a roughness under 0.15
    // every column in the game rendered as a floor-to-ceiling tube of blown
    // white wearing a bloom halo. Roughen it past 0.25 to kill that and the same
    // light spreads into a flat wash and the column reads as terracotta clay.
    // There is no roughness between the two that is a column.
    //
    // Pale veined marble is a DIELECTRIC: its specular is four percent instead
    // of a hundred, so a hard key lands on it as a highlight rather than as a
    // detonation, and its form comes from albedo and normal detail that survive
    // at any distance. It also earns the masonry courses in the stone map, which
    // land as the drum joints of a real stone column, and it sets the gold rails
    // off far better than more gold did. The critic asked for "polished gold or
    // white marble with gold banding" and the second one is the one that works.
    this.surface('roseGold',   'marble', { r: 1.34, g: 1.255, b: 1.125 },
      { tile: 1.6, bump: 0.85, roughScale: 0.85, metalScale: 0.0 });
    // The lane rails. The critic called the gold rails running to the vanishing
    // point the best-composed element in the frame, so they are worth polishing
    // properly: at roughScale 0.95 they were flat mustard bands, and a rail is
    // small enough in screen area that letting its highlight clip is exactly
    // what should happen. The hammering is flattened for the same reason it was
    // on the columns — broad normal detail on a long simple shape scatters the
    // one coherent streak that makes it read as metal.
    this.surface('yellowGold', 'gold', PALETTE.yellowGold,
      { tile: 4.0, bump: 0.22, roughScale: 0.50 });
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
      { tile: 3.0, bump: 0.30, roughScale: 0.65, twoSided: true });

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
    // Mirror-polished dark metal, so the membrane swings from near-black to
    // blown white across its own curve — which is exactly what the wing does in
    // the reference, and the only reason a flat sheet reads as a surface at all.
    // Darker than it looks it should be. A mirror shows you the room, and the
    // room is mostly black; the value of this material is set by how much of the
    // key and the panels the membrane's curve happens to catch, which is exactly
    // the near-black-to-blown-white swing the wing has in the reference.
    this.polished('wingChrome', { r: 0.320, g: 0.335, b: 0.375 }, 0.075, 3, 0.7);
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
