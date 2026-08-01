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
 *
 * SECOND MEASUREMENT PASS. The numbers above bought a punchier frame and then
 * two of them quietly took it back. Re-sampled with the obstacle-gap framing
 * the real capture uses — the first probe skipped that seek, posed the camera
 * inside an obstacle, and spent an hour measuring the inside of a grey box:
 *
 *   shipped grade      meanL 68.2   p5  10   p99 224   >250 0.026%   <40 43.5%
 *   vignette OFF only  meanL 132.8                              <40  5.3%
 *
 * The vignette at weight 3.2 / K 0.52 was halving the mean luminance of the
 * WHOLE FRAME. It is applied before the tonemapper, so it does not dim pixels,
 * it crushes them into the toe. The critic's "44.6% of the frame below
 * luminance 40 and the top quarter is dead black holding nothing" was almost
 * entirely this one number, not the backdrop and not the lighting.
 *
 * `vignetteK` is also backwards from how it reads: it scales the vignette
 * COORDINATE, so a LARGER K is a tighter, stronger vignette. Dropping K from
 * 0.52 to 0.34 while raising the weight from 3.2 to 4.6 keeps the corners
 * genuinely dark and stops the falloff eating the upper third of the frame.
 *
 * EXPOSURE 2.05 WAS DESTROYING THE MATERIAL. This is the important one. The
 * previous pass raised exposure to reach the ACES shoulder, which worked for
 * the corridor and was ruinous for the character: the pavé is a large area of
 * near-white albedo, so at 2.05 it sat on a flat clipped plateau with all of
 * its stone-by-stone structure gone. Measured on the face pose, 37.7% of that
 * frame was below luminance 40 while p95 was 239 — the whole image was either
 * black or blown, with nothing in between. Pulling exposure back to 1.80 gives
 * the pavé, the hood rim, the boot stones and the second eye catchlight back.
 *
 * SHARPEN IS THE SPARKLE LEVER, and it was set an order of magnitude too low.
 * The frame had essentially no pixels at 255 — a pavé surface under studio
 * light is defined by pixel-scale blowouts and there were none. Raising
 * `highlightsExposure` produces them, but it is a luminance-BAND operator: it
 * cannot tell a 2px specular from the character's whole white head, and at 58
 * it clipped 8% of the face pose to paper. Sharpen is a LOCAL contrast
 * operator, so it lifts a bright pixel only relative to its neighbours.
 * Measured on the face pose at exposure 1.6: edgeAmount 0.40 -> 1.0 moved
 * pixels above luminance 250 from 0.215% to 1.063% while the frame mean moved
 * 93.4 -> 93.6. That is the definition of the effect wanted here — sparkle
 * without exposure drift.
 *
 * ---------------------------------------------------------------------------
 * THIRD MEASUREMENT PASS — THE MERGE. Every one of the numbers above was
 * measured against a build in which mat/, world/ and the environment cubemap
 * were dimmer than they now are. All three then landed at once, each of them
 * brighter, and the grade on top of them stopped being a grade and became a
 * clipping machine.
 *
 * Sampled at FULL RESOLUTION (this matters: the first probe of this pass
 * sampled a 400px downscale, which box-averages 4x4 blocks and reported 1.29%
 * clipped where the real frame had 4.77% — averaging is the one thing you must
 * not do when measuring clipping). Hero pose, 1600x900, q=high, seed 1:
 *
 *   shipped merge   mean 73.6  p95 234  p99 255   1.26% of pixels at luma 255
 *                                                 4.77% with a channel at 254+
 *                                                 44.6% below luma 32
 *
 * A p99 of 255 means the top 1% of the frame is not "bright", it is GONE. The
 * clip map (every pixel with a channel >= 254 painted magenta) says where:
 * the character's entire pavé body was one solid magenta blob, the gold star
 * pickups were solid, the marble column faces were solid speckle, and the
 * polished floor's reflections were solid. Not a highlight anywhere — a
 * stencil.
 *
 * WHAT WAS ACTUALLY CLIPPING, in order of contribution. Each measured by
 * changing one thing on the live frame and re-sampling:
 *
 *   highlightsExposure 40 -> 0     1.26% -> 0.68% at 255,  4.77% -> 2.38% chan
 *   contrast    1.22 -> 1.00       1.26% -> 1.03%
 *   sharpenEdge 1.00 -> 0.75       0.53% -> 0.22%,         2.00% -> 1.18% chan
 *   bloom weight -> 0              1.26% -> 1.27%  (bloom was NOT the culprit)
 *   exposure    1.80 -> 1.30       1.26% -> 0.84%, and the mean fell 73.6 ->
 *                                  55.2 with 55% of the frame below luma 32
 *
 * That last line is the important one and it is why this pass is not simply
 * "turn the exposure down". Exposure is a global operator: pulling it far
 * enough to unclip the pavé takes the black floor with it and buys a frame
 * that is dark AND still clipped. The clipping was being manufactured AFTER
 * the tonemapper, by operators that have no roll-off at all:
 *
 * 1. Read imageProcessingFunctions.fx in order. The tonemapper runs, then
 *    `toGammaSpace`, then `saturate` — and only THEN contrast and colour
 *    curves. Everything those two add on top of a value that is already at
 *    0.95 has nowhere to go but 1.0.
 * 2. Babylon's `contrast` is a smoothstep, x*x*(3-2x). Its derivative is ZERO
 *    at both ends. At 1.22 it takes the 0.88..1.0 band — precisely the band a
 *    filmic shoulder exists to keep separated — and squeezes it flat. It is a
 *    highlight ERASER wearing a contrast label.
 * 3. `highlightsExposure` 40 is a flat 1.08x multiply on every pixel above
 *    ~0.83 luma with no curve on it whatsoever. Anything above 0.926 clips by
 *    construction. On a jewellery render that is the entire subject.
 * 4. Sharpen adds its edge term after all of that, so it manufactures clipped
 *    pixels out of bright ones that had just survived.
 *
 * THE FIX IS SHAPED LIKE A TONE CURVE, not like a dimmer. Pull the top down
 * (exposure 1.80 -> 1.62, highlights gain to zero, contrast to 1.10, sharpen
 * to 0.85) and push the MIDDLE back up to pay for it (midtonesExposure 0 ->
 * 24). The colour-curve bands make that separation exact: at luma >= 0.83 the
 * shader uses the highlights curve alone, so lifting midtones cannot re-clip
 * anything. Measured on the hero pose:
 *
 *   pose                mean  p95  p99   luma255  chan-clip   <32   hi sigma
 *   hero      before    73.6  234  255    1.26%     4.77%    44.6%    16.6
 *             after     65.9  205  247    0.42%     1.70%    46.9%    17.8
 *   char-rear before    75.8  238  255    1.58%     5.15%    43.5%    17.9
 *             after     68.2  208  251    0.54%     2.07%    45.1%    17.9
 *   phone     before    88.5  242  255    1.69%     7.14%    35.6%    15.7
 *             after     79.0  216  253    0.66%     2.76%    38.9%    15.8
 *   phone/low before    95.2  252  255    1.57%    11.75%    31.7%    15.9
 *             after     88.1  217  237    0.00%     0.58%    28.7%    11.5
 *
 * Clipping down 3-20x depending on the pose, the dark end within three points
 * of where it was (the mood is intact — this is not a lifted-blacks fix), the
 * mean down 7-9%, and the spread of luminance WITHIN the bright band holding
 * or rising: there is shape in the highlights where there was a plateau. The
 * worst frame in the set was the one most people will actually see — the phone
 * at 'low' had one pixel in eight with a clipped channel.
 *
 * BLOOM. Re-checked rather than assumed, because the threshold is a linear
 * value against a scene that got brighter underneath it. 1.90 -> 2.40 pulls
 * the marble, the rails and the character's own pavé back out of the
 * highlight pass while the emitters and the apse still bloom; looked at side
 * by side, the corridor keeps its glow and the character loses the halo that
 * was smearing its stones together.
 *
 * The honest part of that: bloom was NOT what was blowing the frame out. Two
 * clean measurements, each a separate page load so the pose is identical —
 * threshold 2.40 against 1.90 — came back with the same clipping to two
 * decimal places (0.39% at luma 255, 1.66% vs 1.65% channel clip) and a 2%
 * difference in frame mean. At the pre-regrade exposure the threshold looked
 * like the obvious suspect; measured, it is a crispness control, not a
 * headroom one. The regrade is what bought the headroom.
 *
 * MEASURING A/B IN ONE PAGE IS A TRAP, and it is worth writing down because
 * every future pass will be tempted by it. Posing the capture pauses the game
 * LOOP, but scene.render() still advances Babylon's own animation clock off
 * wall time, and under software rendering one render is most of a second — so
 * the spinning gold star, which is the largest bright object in the frame,
 * moves between variants. Rendering the SAME settings twice in a row measured
 * mean 66.7 then 63.2. Clipping percentages are robust to that (0.42 / 0.43)
 * because they are dominated by static geometry; means are not. Every
 * before/after pair above comes from two separate page loads, one variant each.
 *
 * HANDOFF TO THE LEAD — `npm run shots` cannot complete in this container, and
 * it is not the grade's doing. tools/capture.mjs takes its screenshot with
 * Playwright's default 30s action timeout; a 1600x900 frame at q=high costs
 * about 11 seconds to actually present through SwiftShader, and the measured
 * screenshot call sits at 29-31s — a coin flip against its own timeout. It
 * fails identically on the unmodified merge. Dropping the pipeline's MSAA from
 * 4 samples to 1 was tried and moved the screenshot from 29.4s to 31.2s, i.e.
 * nothing: the cost is the compositor waiting its turn behind a render loop
 * that never yields, not the sample count, so `samples` stays at 4. The fix is
 * one argument in tools/ — `timeout: 0` on the page.screenshot call — which is
 * lead-owned. Every frame in this pass was captured through a local probe that
 * passes that flag.
 */
const LOOKS = {
  high: {
    exposure: 1.62,
    contrast: 1.10,
    vignetteWeight: 4.6,
    vignetteK: 0.34,
    bloomThreshold: 2.40,
    bloomKernel: 40,
    bloomScale: 0.5,
    samples: 4,
    dither: true,
    sharpen: true,
    sharpenEdge: 0.85,
    ssao: { ratio: 0.5, blurRatio: 0.5, radius: 0.55, strength: 1.9, samples: 10, expensiveBlur: false, maxZ: 45 },
  },
  medium: {
    exposure: 1.62,
    contrast: 1.10,
    vignetteWeight: 4.4,
    vignetteK: 0.34,
    bloomThreshold: 2.35,
    bloomKernel: 32,
    bloomScale: 0.5,
    samples: 1,
    dither: true,
    sharpen: true,
    sharpenEdge: 0.80,
    ssao: { ratio: 0.5, blurRatio: 0.5, radius: 0.55, strength: 1.7, samples: 8, expensiveBlur: false, maxZ: 45 },
  },
  low: {
    // 'low' must hold 60fps on a mid-range phone, so it still gets no AO —
    // that is the expensive pass here, a depth-aware sample kernel plus a
    // bilateral blur.
    //
    // Sharpen is OFF at 'low' again, and this time the reason is a measurement
    // rather than an argument. The note that turned it on said Babylon's
    // sharpen is "a single full-screen quad with five texture taps, while FXAA
    // is roughly a dozen — about 40% of a pass 'low' has already bought". That
    // reasoning counts ALU and ignores bandwidth, and bandwidth is what a
    // full-screen pass actually costs. Timed on the phone viewport at 'low' by
    // rendering through requestAnimationFrame (which forces a real present —
    // measuring scene.render() alone just queues work and reports 4ms for a
    // frame that takes 450ms to appear):
    //
    //   all post on            447 ms/frame
    //   sharpen off            341 ms/frame     <- one pass, 24% of the frame
    //   sharpen + fxaa off     297 ms/frame     <- fxaa is 44ms, sharpen 106ms
    //
    // Sharpen is 2.4x the cost of FXAA here, not 0.4x. A quarter of the frame
    // budget for a local-contrast effect is not a trade 'low' can make;
    // ARCHITECTURE is explicit that performance beats diamonds. It also happens
    // to be the largest remaining source of clipped pixels after the regrade
    // (0.53% -> 0.22% of the frame at luma 255 on the hero pose), so 'low'
    // loses the sparkle and gets a cleaner image for it.
    //
    // 'low' is where the phones are, and a phone is often held in daylight, so
    // it still runs a little brighter and less contrasty than the desktop
    // grade to survive screen glare.
    exposure: 1.74,
    contrast: 1.08,
    vignetteWeight: 3.4,
    vignetteK: 0.34,
    bloomThreshold: 2.30,
    bloomKernel: 24,
    bloomScale: 0.4,
    samples: 1,
    dither: true,
    sharpen: false,
    sharpenEdge: 0.62,
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

  // Deep, cool, slightly violet shadows. The slider is squared, so -55 is only
  // a 0.85x multiplier — but stacked on top of a vignette that was already
  // crushing the frame into the tonemapper's toe it was the last push that
  // turned shadow into void. Measured: -55 -> -22 lifts the hero pose's p5 from
  // 24 to 29 and costs nothing anywhere else. The COOL is what earns its place
  // here, not the darkness; the darkness is the vignette's job and the
  // vignette was doing far too much of it.
  shadowsHue: 224, shadowsDensity: 58, shadowsSaturation: -6, shadowsExposure: -22,

  // Midtones carry the saturation, and lean a touch warm so skin/gold in the
  // middle of the range does not sit in the same neutral band as the track.
  midtonesHue: 34, midtonesDensity: 24, midtonesSaturation: 14, midtonesExposure: 24,

  // Warm lifted highlights — the "gold light" of the reference. Saturation is
  // pulled back slightly so specular hits still bleach towards white, which is
  // what sells a polished surface.
  //
  // MEASURED CEILING on this one. Pushing highlightsExposure to reach 255 is
  // tempting and wrong: this is a luminance-BAND operator (it lands on every
  // pixel above ~0.83 luma), so it cannot separate a 2px specular from the
  // character's entire white head. On the face pose, 58 clipped 8.1% of the
  // frame to paper and erased the pavé. 40 is where the corridor emitters and
  // the gold rails reach the top of the range and the character does not.
  // Pixel-scale sparkle comes from `sharpenEdge` instead, which is local.
  highlightsHue: 38, highlightsDensity: 46, highlightsSaturation: -10, highlightsExposure: 0,
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
      // MEASURED: the radius was an order of magnitude too big and the pass was
      // doing nothing. At 1.6m the front pose came out at mean luminance 95.4
      // against 96.1 with AO switched off entirely — a 0.7% difference, i.e. a
      // whole depth-aware sample kernel and a bilateral blur being spent on
      // noise. The reason is scale: 1.6m is most of the character's height and
      // more than the gap between the corridor's furniture, so almost every
      // sample landed in open space and reported "unoccluded".
      //
      // The creases that matter are small — the hood/head junction, the ear
      // roots, the arm sockets, the boot-to-floor contact. Those are 0.1..0.4m
      // features. At 0.55m the same pose measures 93.6, about 3.5x the effect,
      // and the difference image shows it landing on exactly those junctions
      // instead of smearing evenly across the corridor. This is the fix for
      // "the character reads as a pile of separate balls".
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
    //
    // THAT LAST SENTENCE TURNED OUT TO BE WRONG, and the correction is the
    // useful part. "The emissive light columns are far brighter than 1.6" was
    // an assumption; it was never sampled. Sweeping the threshold on the hero
    // pose and looking at the frames:
    //
    //   1.90   corridor emitters glow, character has a soft halo
    //   2.30   emitters already noticeably dimmer
    //   2.80   emitters completely flat — hard-edged slabs, no glow at all
    //   3.50   identical to 2.80. Nothing left in the scene is above 3.5.
    //
    // The emitters are not "far brighter" than the character's pavé. They sit
    // in the SAME narrow linear band, roughly 1.9..2.3. So there is no
    // threshold that blooms the corridor and spares the runner, and hunting for
    // one is wasted effort — at 5.0 the face pose is beautiful and the vault is
    // dead, at 1.6 the vault glows and the face is a blob.
    //
    // HANDOFF, because the fix is not post's: separating these needs a mask,
    // not a threshold. A Babylon GlowLayer driven by the emitters' emissive
    // channel in world/ would let bloom here be raised out of the character's
    // range entirely while the corridor keeps (and could considerably increase)
    // its glow. Until then 1.90 is the compromise, chosen by looking: it is the
    // brightest threshold at which the corridor still reads as lit.
    //
    // What IS post's, and what was taken: the KERNEL. 64 -> 40 tightens the
    // halo around the character without touching what qualifies as a highlight.
    // Measured on the face pose, kernel 64 -> 32 moved pixels above luminance
    // 250 from 1.8% to 2.4% — the same light energy concentrated into a smaller
    // radius, which reads as specular rather than as fog, and costs less.
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
    // SHARPEN — promoted from "barely visible texture cue" to a load-bearing
    // part of the material read. See the measurement note on LOOKS: at 0.40 it
    // did nothing measurable; at 1.00 it roughly quintuples the number of
    // pixels reaching 255 without moving the frame mean, because it is a local
    // operator and the thing being lifted is a stone facet against its own
    // shadow. FXAA runs after it, which is what keeps the halo from reading as
    // a ringing artefact on the corridor's long converging edges.
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
      if (this.pipeline.sharpen) {
        this.pipeline.sharpen.colorAmount = 1.0;
        this.pipeline.sharpen.edgeAmount = look.sharpenEdge;
      }
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
    if (o.toneMappingType !== undefined) ip.toneMappingType = o.toneMappingType;
    if (o.exposure !== undefined) ip.exposure = o.exposure;
    if (o.contrast !== undefined) ip.contrast = o.contrast;
    if (o.vignetteWeight !== undefined) ip.vignetteWeight = o.vignetteWeight;
    if (o.vignetteStretch !== undefined) ip.vignetteStretch = o.vignetteStretch;
    if (o.vignetteK !== undefined) { this._look = Object.assign({}, this._look, { vignetteK: o.vignetteK }); this._updateVignette(); }
    if (o.bloomThreshold !== undefined) this.pipeline.bloomThreshold = o.bloomThreshold;
    if (o.bloomKernel !== undefined) this.pipeline.bloomKernel = o.bloomKernel;
    if (o.bloomWeight !== undefined) this.pipeline.bloomWeight = o.bloomWeight;
    if (o.curvesEnabled !== undefined) ip.colorCurvesEnabled = o.curvesEnabled;
    if (o.sharpenEnabled !== undefined) this.pipeline.sharpenEnabled = o.sharpenEnabled;
    if (o.sharpenEdge !== undefined && this.pipeline.sharpen) this.pipeline.sharpen.edgeAmount = o.sharpenEdge;
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
