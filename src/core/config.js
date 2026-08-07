// Global tunables and quality presets.
//
// Two kinds of thing live here:
//   TUNE   - gameplay/feel numbers that designers (and critic loops) adjust
//   QUALITY- render budgets, selected automatically by a load-time benchmark
//
// Subsystems read `ctx.config.q.*` for budgets. They must respect them: a
// preset is a contract, not a suggestion.

/**
 * Render aspect ratio, pushed in from main.js on boot and on every resize.
 * Module-scope rather than a field so `TUNE.camFovBase` can stay a plain
 * number from every reader's point of view.
 */
let _aspect = 16 / 9;
export function setViewAspect(a) { if (a > 0 && isFinite(a)) _aspect = a; }
export function getViewAspect() { return _aspect; }

// Reference vertical field of view, in radians, at the reference aspect.
const FOV_REF = 0.79;
const FOV_REF_ASPECT = 16 / 9;
// 0 = vertical-fixed (Babylon's default), 1 = horizontal-fixed.
//
// WHY THIS IS NOT JUST A CONSTANT.
// Babylon's FreeCamera defaults to FOVMODE_VERTICAL_FIXED, which holds the
// vertical angle and lets the horizontal one collapse with the aspect ratio. On
// a 390x844 phone that leaves a 27 degree horizontal field: the three lanes and
// both rails were being squeezed into a slot, which is what "portrait puts the
// character quite large in frame" actually was — the character was not large,
// the corridor was narrow. Horizontal-fixed overcorrects the other way and
// gives portrait a 96 degree vertical fisheye.
//
// Blending the two in TANGENT space (which is where field of view is linear in
// screen size) gives a "cover" lens: portrait gains corridor width and loses a
// little subject size, desktop gains subject size and loses a little periphery,
// and neither ever goes near a fisheye.
//
// TUNED BY LOOKING, twice. 0.45 was the first guess and it was too much: the
// desktop hero improved but the phone shot came back with the runner at about
// a seventh of frame height, stranded in an empty foreground — portrait had
// paid for desktop's gain. 0.20 keeps the phone within a few percent of where
// it was (which was already the better-framed of the two) and lets the narrower
// reference lens do the work on desktop, where the problem actually was.
const FOV_COVER = 0.20;

export const TUNE = {
  // --- track geometry ---
  laneWidth: 2.4,          // metres between lane centres
  laneCount: 3,
  tileLength: 8,           // metres per track tile
  chunkTiles: 6,           // tiles per generated chunk
  viewDistance: 180,       // metres of track kept alive ahead of the player

  // --- movement feel ---
  startSpeed: 11.5,        // metres/sec at run start
  maxSpeed: 34,
  speedRampTime: 220,      // seconds to reach maxSpeed
  laneChangeTime: 0.16,    // seconds to slide between lanes
  jumpHeight: 2.3,         // metres
  jumpTime: 0.62,          // seconds airborne at base speed
  slideTime: 0.7,          // seconds
  slideHeight: 0.75,       // collision height while sliding
  coyoteTime: 0.09,        // grace period to still jump after leaving ground
  // How early an input still counts. THREE numbers, because one was wrong.
  //
  // A flat 0.14s is about eight rendered frames on a fast phone and two on a
  // slow one, so the device that needs the most forgiveness was given the
  // least — which is most of what "slide and jump are very hit and miss" was.
  // play/ takes the LARGER of the fixed floor and `inputBufferFrames` frames of
  // the device's measured frame time, capped at `inputBufferMax`.
  //
  // At 60fps the floor wins and nothing changes (4 frames = 0.067s). At 15fps
  // the window roughly doubles to 0.27s. The cap exists because a window much
  // longer than that stops reading as forgiveness and starts reading as the
  // game doing things by itself.
  inputBuffer: 0.14,       // seconds — floor
  inputBufferFrames: 4,    // rendered frames — the scaling term
  inputBufferMax: 0.30,    // seconds — ceiling

  // --- junction turns ---
  // Within this distance of a corner, left/right means TURN, not lane change.
  // It scales with speed at runtime so the reaction time stays constant
  // rather than shrinking as the run gets faster.
  // 11m at start speed gave under a second to spot a corner, decide, and
  // swipe. The first playtester called corners harsh and was right.
  turnWindowBase: 19,      // metres at start speed (~1.65s to react)
  turnWindowPerSpeed: 0.85,// extra metres per m/s above start speed
  // A turn that lands a fraction late still counts. Without this, an input on
  // the exact frame you cross the corner is a death, which feels arbitrary
  // rather than difficult.
  turnGraceTime: 0.16,     // seconds past the junction that still register
  // Corners slow the player down. Not a difficulty concession — a corner taken
  // at full sprint gives no time to read the new corridor, and arriving into
  // an unseen obstacle at speed is the least fair death in the game.
  cornerSlowFactor: 0.66,  // fraction of normal speed through a corner
  cornerSlowStart: 24,     // metres before the junction where slowing begins
  cornerSlowEnd: 10,       // metres after the junction before speeding up
  cornerSlowInRate: 0.14,  // how fast the slowdown bites (per 1/60s)
  cornerSlowOutRate: 0.035,// how fast speed is regained — deliberately gentler

  // --- collision volumes ---
  playerRadius: 0.42,
  playerHeight: 1.5,

  // --- camera ---
  // Framing, not gameplay. The runner sat at roughly a fifth of frame height,
  // shot from dead astern and from high enough to be looking at the top of its
  // own head — so the two things that carry the IP, the face and the wing, were
  // both invisible and the silhouette read as a stack of spheres. Modern
  // runners sit the character nearer a quarter of the frame and lower the eye
  // line so the shape is seen side-on rather than from above.
  camDistance: 6.0,
  camHeight: 2.80,
  camLookAhead: 8.0,
  camLagPos: 0.12,         // smoothing factor, lower = tighter
  camLagRot: 0.16,
  /**
   * Vertical field of view in radians, aspect-compensated. See FOV_COVER.
   * A getter rather than a constant because the right vertical angle depends
   * on the shape of the frame, and play/ re-reads this every frame anyway.
   */
  get camFovBase() {
    const t = Math.tan(FOV_REF / 2) * Math.pow(FOV_REF_ASPECT / _aspect, FOV_COVER);
    return 2 * Math.atan(t);
  },
  camFovSpeedGain: 0.12,   // extra fov at max speed, sells velocity

  // --- scoring ---
  starValue: 10,
  distanceScorePerMetre: 1,

  // --- input ---
  swipeMinDistance: 26,    // px
  swipeMaxTime: 0.45,      // seconds
};

/**
 * Quality presets. `low` must hold 60fps on a mid-range phone; that is the
 * binding constraint on the whole project.
 */
export const QUALITY = {
  /**
   * Below 'low'. For the phones that 'low' was still too much for — the owner
   * plays on a Ulefone Armor X12 (Helio A22, four A53s, PowerVR GE8320, 3GB)
   * and reported the game as rough there with 'low' forced.
   *
   * WHAT THIS TIER TRADES, AND WHY THAT IS ALLOWED.
   * Half render scale is a 4x cut in every per-pixel cost in the frame, which
   * is where a GE8320 dies, and bloom is a full-screen downsample-blur-upsample
   * chain — the single most expensive thing left once shadows and AO are gone.
   * Both cost image quality and nothing else. The owner has said explicitly
   * that he wants responsive over crisp, so this tier takes him at his word.
   *
   * `name` IS THE DETAIL TIER, NOT THE KEY. Every subsystem outside core/
   * asks `config.q.name === 'low'` to decide whether to build the cheap
   * version of a prop, a mesh or an effect — there are about twenty such
   * tests in track/, world/, mat/, char/ and fx/, none of them mine to edit.
   * Reporting 'low' here makes every one of them take the cheap branch, which
   * is exactly what this tier wants. The identity of the preset lives in
   * `config.presetName`, which is what post/ and the HUD read.
   */
  potato: {
    name: 'low',
    scale: 0.5,
    shadows: false,
    shadowMapSize: 0,
    bloom: false,           // a full-screen pass; the biggest thing left
    bloomScale: 0,
    ssao: false,
    fxaa: false,            // measured at 44ms/frame on the phone viewport
    envSize: 32,
    maxParticles: 40,
    maxDecals: 0,
    propDensity: 0.3,
    glint: false,
    reflectionFloor: false,
    anisotropy: 1,
  },
  low: {
    name: 'low',
    scale: 0.75,            // render scale multiplier
    shadows: false,
    shadowMapSize: 0,
    bloom: true,
    bloomScale: 0.55,
    ssao: false,
    fxaa: true,
    envSize: 64,            // env cubemap face size
    maxParticles: 120,
    maxDecals: 0,
    propDensity: 0.55,      // fraction of decorative props spawned
    glint: false,
    reflectionFloor: false,
    anisotropy: 1,
  },
  medium: {
    name: 'medium',
    scale: 1.0,
    shadows: true,
    shadowMapSize: 1024,
    bloom: true,
    bloomScale: 0.62,
    // AO is worth more than a second MSAA sample or a bigger shadow map: it is
    // what stops every object floating. Medium buys it at half resolution.
    ssao: true,
    fxaa: true,
    envSize: 128,
    maxParticles: 400,
    maxDecals: 32,
    propDensity: 0.8,
    glint: true,
    reflectionFloor: false,
    anisotropy: 4,
  },
  high: {
    name: 'high',
    scale: 1.0,
    shadows: true,
    shadowMapSize: 2048,
    bloom: true,
    bloomScale: 0.67,
    ssao: true,
    fxaa: true,
    envSize: 256,
    maxParticles: 900,
    maxDecals: 96,
    propDensity: 1.0,
    glint: true,
    reflectionFloor: true,
    anisotropy: 8,
  },
};

/**
 * Set by guessPreset() and consumed by the next Config constructed, which is
 * how a Config knows whether its preset was GUESSED or FORCED.
 *
 * main.js does `opts.preset || guessPreset()`, so if the preset was forced
 * (`?q=low`, or the capture harness) guessPreset is never called and this stays
 * null. A forced preset is an instruction and the runtime governor leaves it
 * alone; a guessed one is an opening bid the governor is free to revise.
 */
let _guess = null;

/** Heuristic first guess, refined by the runtime governor in core/quality.js. */
export function guessPreset() {
  const ua = navigator.userAgent || '';
  const mobile = /Android|iPhone|iPad|iPod|Mobile/i.test(ua);
  const cores = navigator.hardwareConcurrency || 4;
  const mem = navigator.deviceMemory || 4;
  // NOT changed to guess 'potato' for weak hardware, on purpose. The reported
  // numbers do not separate a Helio A22 from a decent midrange well enough to
  // risk it (deviceMemory is rounded to a power of two and hardwareConcurrency
  // says 4 for both a 2016 budget phone and a 2013 flagship), and the governor
  // now measures the real thing within the first second. Guess conservatively,
  // measure quickly.
  _guess = mobile ? (cores >= 8 && mem >= 6 ? 'medium' : 'low')
    : (cores >= 8 ? 'high' : 'medium');
  return _guess;
}

export class Config {
  constructor(presetName) {
    this.tune = TUNE;
    this.presetName = presetName;
    this.q = QUALITY[presetName] || QUALITY.medium;
    /**
     * True when this preset came from guessPreset() rather than from `?q=`.
     * The runtime governor only steps down when this is true.
     */
    this.autoQuality = _guess !== null && presetName === _guess;
    _guess = null;
    /** Set true by tools/capture.mjs so runs are deterministic and posed. */
    this.captureMode = false;
    /** Forced seed for reproducible runs. */
    this.seed = 0x53565552; // "SVUR"
  }

  setPreset(name) {
    if (!QUALITY[name]) return false;
    this.presetName = name;
    this.q = QUALITY[name];
    return true;
  }
}
