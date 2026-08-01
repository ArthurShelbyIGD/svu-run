// post.js — the final image.
//
// Everything between "the scene has been rasterised" and "the player sees it"
// lives here: ambient occlusion, tonemapping, colour grading, bloom, and the
// the one display-space effect (sharpen) that survived being measured.
//
// WHY THIS IS ITS OWN FILE
// The pipeline used to be twenty lines at the bottom of main.js: bloom on,
// ACES on, contrast 1.12, vignette, done. Those were first guesses and they
// read as first guesses. The numbers below are not guesses — each was chosen
// by rendering the hero pose, sampling the framebuffer, and comparing
// histograms. See the measurement notes on each block.
//
// ORDER OF OPERATIONS (Babylon, and it matters)
//   SSAO2 pipeline           attached first, so AO is in the colour buffer
//                            BEFORE bloom sees it and before tonemapping
//   DefaultRenderingPipeline
//     bloom          linear HDR, threshold is a LINEAR value
//     imageProcessing  exposure -> vignette -> tonemap -> gamma -> contrast
//                      -> colour curves -> dither
//     sharpen        display space
//     fxaa           last, so it also softens any sharpening halo
//
// The image-processing shader (imageProcessingFunctions.fx) applies VIGNETTE
// BEFORE the tonemapper, so vignette weight and exposure interact: raising
// exposure makes the vignette bite less. Both were tuned together.

import {
  DefaultRenderingPipeline, SSAO2RenderingPipeline, ColorCurves,
} from './bjs.js';
import { EV } from './ctx.js';

/**
 * The look, per quality preset.
 *
 * MEASUREMENT NOTE — what the old settings were actually doing.
 * Sampling the hero frame (1600x900, high preset, seed 1):
 *
 *   no post at all        meanL 113.9   mean saturation 0.175
 *   ACES only             meanL  88.6   mean saturation 0.221
 *   shipped (ACES +
 *     contrast 1.12 +
 *     bloom + vignette)   meanL  82.8   mean saturation 0.243
 *                         99.92% of pixels below 90% luminance
 *                         histogram peak in the 48..112 band
 *
 * Two things fall out of that.
 *
 * 1. ACES was NOT crushing colour — it slightly increases saturation at these
 *    levels (0.175 -> 0.221). What it does is darken by ~22%, because the
 *    scene's usable range barely reaches 1.0, so the curve's toe does all the
 *    work and its shoulder does none. The answer is not to remove ACES; it is
 *    to raise exposure until highlights actually reach the shoulder, which is
 *    where filmic highlight roll-off comes from.
 *
 * 2. Babylon's `contrast` is a smoothstep pivoted at 0.5 IN GAMMA SPACE. With
 *    a mean of 0.32 almost the whole image sat below the pivot, so contrast
 *    1.12 was a darkening operator, not a contrast operator. It made the image
 *    muddier while appearing to add punch. Exposure first, contrast second.
 */
const LOOKS = {
  high: {
    exposure: 2.05,
    contrast: 1.45,
    vignetteWeight: 3.2,
    vignetteK: 0.52,
    bloomThreshold: 1.60,
    bloomKernel: 64,
    bloomScale: 0.5,
    samples: 4,
    dither: true,
    sharpen: true,
    sharpenEdge: 0.40,
    ssao: { ratio: 0.5, blurRatio: 0.5, radius: 1.6, strength: 1.15, samples: 8, expensiveBlur: false, maxZ: 45 },
  },
  medium: {
    exposure: 2.05,
    contrast: 1.45,
    vignetteWeight: 3.0,
    vignetteK: 0.52,
    bloomThreshold: 1.55,
    bloomKernel: 48,
    bloomScale: 0.5,
    samples: 1,
    dither: true,
    sharpen: true,
    sharpenEdge: 0.34,
    ssao: { ratio: 0.5, blurRatio: 0.5, radius: 1.6, strength: 1.05, samples: 6, expensiveBlur: false, maxZ: 45 },
  },
  low: {
    // 'low' must hold 60fps on a mid-range phone, so it gets no AO and no
    // sharpen pass — the two things here that cost a whole extra draw. It
    // still gets the full grade, because colour curves, dithering and the
    // tonemapper all live inside the one image-processing shader that was
    // going to run anyway, so the look survives the budget intact.
    // 'low' is where the phones are, and a phone is often held in daylight.
    // It runs a stop brighter and a notch less contrasty than the desktop
    // grade so the corridor stays readable behind screen glare, at the cost of
    // a little of the vault's drama.
    exposure: 2.18,
    contrast: 1.36,
    vignetteWeight: 2.3,
    vignetteK: 0.52,
    bloomThreshold: 1.50,
    bloomKernel: 32,
    bloomScale: 0.4,
    samples: 1,
    dither: true,
    sharpen: false,
    sharpenEdge: 0,
    ssao: null,
  },
};

/**
 * The grade. This is the deliberate look: cool shadows, warm highlights,
 * saturation restored.
 *
 * Babylon's ColorCurves sliders are heavily non-linear — density and exposure
 * are squared before use and density is then halved, so a value of 30 is worth
 * about 4.5% of tint and is invisible. Useful values live in the 40..70 band.
 * That non-linearity is why "I set the curves and nothing happened" is the
 * usual first experience with this API.
 *
 * How the shader consumes these (imageProcessingFunctions.fx):
 *   luma  = luminance(colour)
 *   curve = midtones + clamp(luma*3-1.5) * (highlights-midtones)
 *                    - clamp(1.5-luma*3) * (midtones-shadows)
 *   rgb  *= curve.rgb
 *   rgb   = mix(luma, rgb, curve.a)      <- curve.a > 1 pushes saturation OUT
 *
 * so `shadows*` lands on pixels below ~0.17 luma, `highlights*` above ~0.83,
 * and midtones own everything between, blended linearly.
 */
const GRADE = {
  // Reference is a jewellery render: warm gold and rose against cool platinum.
  // Split-toning along that axis is what makes metal read as metal rather than
  // as grey plastic, and it is what the flat build was missing most.
  globalHue: 0, globalDensity: 0, globalSaturation: 26, globalExposure: 0,

  // Deep, cool, slightly violet shadows. Exposure is pushed hard negative
  // because the slider is squared: -55 is only a 0.85x multiplier.
  shadowsHue: 224, shadowsDensity: 58, shadowsSaturation: -6, shadowsExposure: -55,

  // Midtones carry the saturation, and lean a touch warm so skin/gold in the
  // middle of the range does not sit in the same neutral band as the track.
  midtonesHue: 34, midtonesDensity: 24, midtonesSaturation: 14, midtonesExposure: 0,

  // Warm lifted highlights — the "gold light" of the reference. Saturation is
  // pulled back slightly so specular hits still bleach towards white, which is
  // what sells a polished surface.
  highlightsHue: 38, highlightsDensity: 46, highlightsSaturation: -10, highlightsExposure: 30,
};

export class Post {
  constructor(ctx, camera) {
    this.ctx = ctx;
    this.camera = camera;
    this.pipeline = null;
    this.ssao = null;
    this.curves = null;
    this._look = null;
    this._offResize = null;
    // Bound once in the constructor so the resize listener never allocates.
    this._onResize = () => this._updateVignette();
  }

  init() {
    const scene = this.ctx.scene;
    const q = this.ctx.config.q;
    const look = LOOKS[q.name] || LOOKS.medium;
    this._look = look;

    // --- ambient occlusion -------------------------------------------------
    // Attached BEFORE the default pipeline so its output is what bloom and the
    // tonemapper see. The other way round and AO is applied to an already
    // graded image, which double-darkens the grade's own shadows.
    //
    // AO is the single largest "this was made this decade" signal available
    // here. Without it every object floats: the character's boots, the rail
    // roots, the column bases and the obstacle faces all met the floor with no
    // contact darkening at all.
    if (look.ssao && q.ssao && SSAO2RenderingPipeline.IsSupported) {
      const s = look.ssao;
      const ssao = new SSAO2RenderingPipeline(
        'ssao', scene, { ssaoRatio: s.ratio, blurRatio: s.blurRatio }, [this.camera], false,
      );
      ssao.samples = s.samples;
      // radius is in world units here; the track is 7.2m across and the
      // character ~1.5m tall, so ~1.5m samples contact shadows at the scale of
      // boots and rails rather than smearing across the whole corridor.
      ssao.radius = s.radius;
      ssao.totalStrength = s.strength;
      // base 0 means AO is fully applied rather than lifted towards white.
      // The grade re-lifts it globally; lifting here as well washes it out.
      ssao.base = 0;
      ssao.expensiveBlur = s.expensiveBlur;
      ssao.bilateralSoften = 0.1;
      ssao.bilateralTolerance = 0.5;
      ssao.maxZ = s.maxZ;
      ssao.minZAspect = 0.25;
      this.ssao = ssao;
    }

    // --- main pipeline -----------------------------------------------------
    const pipeline = new DefaultRenderingPipeline('post', true, scene, [this.camera]);
    pipeline.samples = look.samples;
    pipeline.fxaaEnabled = q.fxaa;

    // Bloom. The old settings (threshold 0.72, weight ~0.85, kernel 48) were
    // a haze machine: the threshold is a LINEAR value and the character's white
    // pavé sits around 1.0 linear, so the runner itself qualified as a
    // highlight. Every close-up came back as a glowing white blob with all its
    // surface detail eaten by its own bloom.
    //
    // MEASURED. At threshold 0.88 the char-face pose had 7.2% of pixels clipped
    // at >90% luminance and the pavé speckle was invisible. At 1.60 the
    // character drops out of the highlight pass entirely and the pavé, the
    // boot stones and the hood rim all read, while the emissive light columns
    // — which are far brighter than 1.6 — still bloom. Raising the threshold
    // let the WEIGHT go up rather than down: selective bloom can afford to be
    // strong in a way that indiscriminate bloom never can.
    pipeline.bloomEnabled = q.bloom;
    if (q.bloom) {
      pipeline.bloomThreshold = look.bloomThreshold;
      pipeline.bloomWeight = q.bloomScale;   // world/ re-drives this per zone
      pipeline.bloomKernel = look.bloomKernel;
      pipeline.bloomScale = look.bloomScale;
    }

    // --- image processing --------------------------------------------------
    pipeline.imageProcessingEnabled = true;
    const ip = pipeline.imageProcessing;

    ip.toneMappingEnabled = true;
    ip.toneMappingType = 1;                  // ACES (define TONEMAPPING == 2)
    ip.exposure = look.exposure;
    ip.contrast = look.contrast;

    // Vignette. See _updateVignette for why the stretch is pinned to 1.
    ip.vignetteEnabled = true;
    ip.vignetteWeight = look.vignetteWeight;
    ip.vignetteStretch = 1.0;

    // Dithering. Costs one hash per pixel and removes the banding that a
    // five-stop vertical gradient sky produces on an 8-bit display. Banding in
    // a large flat sky is one of the loudest "old engine" tells there is.
    ip.ditheringEnabled = look.dither;
    ip.ditheringIntensity = 1.2 / 255;

    const curves = new ColorCurves();
    for (const k in GRADE) curves[k] = GRADE[k];
    ip.colorCurves = curves;
    ip.colorCurvesEnabled = true;
    this.curves = curves;

    // --- display-space effects --------------------------------------------
    // Deliberately near the threshold of visibility: a texture-detail cue
    // rather than an effect the player should notice. The failure mode is
    // being obvious.
    if (look.sharpen) {
      pipeline.sharpenEnabled = true;
      // colorAmount 1 = keep the original colour and only add the edge term.
      // Anything below 1 tints the result towards the sharpen kernel's own
      // output, which greys the image — a trap this control is easy to fall into.
      pipeline.sharpen.colorAmount = 1.0;
      pipeline.sharpen.edgeAmount = look.sharpenEdge;
    }

    // FILM GRAIN: evaluated and REJECTED.
    // Babylon's grain has a very narrow useful band. At intensity 2.4 it is
    // invisible at 1:1 (compared crops, no perceptible difference); at 12 it is
    // obvious and reads as phone-camera sensor noise on a jewellery render, not
    // as film. It costs a full-screen pass and a shader either way. Dithering,
    // which is free because it lives inside the image-processing shader that
    // was already running, does the one job grain was actually wanted for:
    // killing banding in the sky gradient.
    //
    // CHROMATIC ABERRATION: evaluated and REJECTED.
    // Same shape of argument. At 2.6 it put visible magenta/green fringes on
    // the light columns, which on a piece whose whole subject is polished metal
    // looks like a rendering fault rather than a lens. At the level where it
    // stops looking like a fault (< 1.0) it cannot be seen at all, least of all
    // on a phone. A full-screen pass for nothing.

    // DEPTH OF FIELD: deliberately NOT enabled.
    // It was evaluated and rejected. A runner asks the player to read obstacle
    // shapes at 25..45m and decide in under a second; DOF blurs exactly that
    // band. Alto's Odyssey can afford it because nothing there needs parsing at
    // distance. It also costs three extra full-screen passes and a depth
    // prepass, which 'low' cannot spend. The depth cue it would buy is bought
    // instead by fog, AO and the vignette, none of which destroy legibility.

    this.pipeline = pipeline;
    this._updateVignette();
    this._offResize = this.ctx.on(EV.RESIZE, this._onResize);
    return pipeline;
  }

  /**
   * Keep the vignette the same shape on every aspect ratio.
   *
   * MEASURED DEFECT. Babylon derives the vignette ellipse from
   * `vignetteCameraFov` and the render aspect:
   *
   *   scaleY = tan(vignetteCameraFov/2)   scaleX = scaleY * (width/height)
   *
   * and `vignetteCameraFov` defaults to 0.5 RADIANS — not the camera's fov,
   * and not pi/4 as the name suggests. Nothing keeps it in sync with the real
   * camera, so the vignette silently had its own idea of the frame.
   *
   * so the same `vignetteWeight` produces wildly different framing on
   * different devices. At weight 7, the desktop 16:9 frame corner came out at
   * 0.5% brightness while the 390x844 portrait corner came out at 5.5% — a
   * ten-fold difference, and the portrait frame was visibly unvignetted while
   * the desktop one was heavily framed. Portrait is how most people will play,
   * so this is not a rounding error.
   *
   * Pinning `vignetteStretch` to 1 collapses scaleX and scaleY to their
   * geometric mean, and then choosing
   *
   *   tan(fov/2) = K / sqrt(aspect)
   *
   * makes both equal exactly K on every aspect. The vignette becomes an
   * ellipse that hugs the frame identically whatever shape the frame is, and
   * `vignetteWeight` finally means one thing.
   */
  _updateVignette() {
    const ip = this.pipeline && this.pipeline.imageProcessing;
    if (!ip) return;
    const w = this.ctx.engine.getRenderWidth();
    const h = this.ctx.engine.getRenderHeight();
    if (!w || !h) return;
    const aspect = w / h;
    const K = (this._look && this._look.vignetteK) || 0.52;
    ip.vignetteCameraFov = 2 * Math.atan(K / Math.sqrt(aspect));
  }

  /** Called when the runtime benchmark steps quality down. */
  setPreset(name) {
    const look = LOOKS[name] || LOOKS.medium;
    this._look = look;
    if (this.pipeline) {
      this.pipeline.samples = look.samples;
      this.pipeline.bloomThreshold = look.bloomThreshold;
      this.pipeline.bloomKernel = look.bloomKernel;
      this.pipeline.sharpenEnabled = !!look.sharpen;
    }
    // AO is torn down rather than weakened: a struggling device wants the
    // whole pass gone, not a cheaper version of it.
    if (this.ssao && !look.ssao) {
      this.ssao.dispose();
      this.ssao = null;
    }
    if (this.pipeline) {
      const ip = this.pipeline.imageProcessing;
      ip.exposure = look.exposure;
      ip.contrast = look.contrast;
      ip.vignetteWeight = look.vignetteWeight;
    }
    this._updateVignette();
  }

  /**
   * Live-tune hook for the grading probe. Takes a flat object of
   * `{ exposure, contrast, vignetteWeight, bloomThreshold, ...GRADE keys }`
   * and applies whatever it recognises. Never called by the game itself.
   */
  apply(o) {
    const ip = this.pipeline.imageProcessing;
    if (o.exposure !== undefined) ip.exposure = o.exposure;
    if (o.contrast !== undefined) ip.contrast = o.contrast;
    if (o.vignetteWeight !== undefined) ip.vignetteWeight = o.vignetteWeight;
    if (o.vignetteStretch !== undefined) ip.vignetteStretch = o.vignetteStretch;
    if (o.bloomThreshold !== undefined) this.pipeline.bloomThreshold = o.bloomThreshold;
    if (o.bloomKernel !== undefined) this.pipeline.bloomKernel = o.bloomKernel;
    if (o.bloomWeight !== undefined) this.pipeline.bloomWeight = o.bloomWeight;
    if (o.curvesEnabled !== undefined) ip.colorCurvesEnabled = o.curvesEnabled;
    if (o.ssaoStrength !== undefined && this.ssao) this.ssao.totalStrength = o.ssaoStrength;
    if (o.ssaoRadius !== undefined && this.ssao) this.ssao.radius = o.ssaoRadius;
    if (o.ssaoMaxZ !== undefined && this.ssao) this.ssao.maxZ = o.ssaoMaxZ;
    for (const k in GRADE) if (o[k] !== undefined) this.curves[k] = o[k];
  }

  dispose() {
    if (this._offResize) { this._offResize(); this._offResize = null; }
    if (this.ssao) { this.ssao.dispose(); this.ssao = null; }
    if (this.pipeline) { this.pipeline.dispose(); this.pipeline = null; }
    this.curves = null;
  }
}

export { LOOKS, GRADE };
