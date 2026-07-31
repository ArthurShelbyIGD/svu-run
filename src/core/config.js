// Global tunables and quality presets.
//
// Two kinds of thing live here:
//   TUNE   - gameplay/feel numbers that designers (and critic loops) adjust
//   QUALITY- render budgets, selected automatically by a load-time benchmark
//
// Subsystems read `ctx.config.q.*` for budgets. They must respect them: a
// preset is a contract, not a suggestion.

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
  inputBuffer: 0.14,       // how early an input still counts

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

  // --- collision volumes ---
  playerRadius: 0.42,
  playerHeight: 1.5,

  // --- camera ---
  camDistance: 6.4,
  camHeight: 3.05,
  camLookAhead: 8.0,
  camLagPos: 0.12,         // smoothing factor, lower = tighter
  camLagRot: 0.16,
  camFovBase: 0.95,        // radians
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
  low: {
    name: 'low',
    scale: 0.75,            // render scale multiplier
    shadows: false,
    shadowMapSize: 0,
    bloom: true,
    bloomScale: 0.35,
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
    bloomScale: 0.5,
    ssao: false,
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
    bloomScale: 0.6,
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

/** Heuristic first guess, refined by the runtime benchmark in main.js. */
export function guessPreset() {
  const ua = navigator.userAgent || '';
  const mobile = /Android|iPhone|iPad|iPod|Mobile/i.test(ua);
  const cores = navigator.hardwareConcurrency || 4;
  const mem = navigator.deviceMemory || 4;
  if (mobile) return cores >= 8 && mem >= 6 ? 'medium' : 'low';
  return cores >= 8 ? 'high' : 'medium';
}

export class Config {
  constructor(presetName) {
    this.tune = TUNE;
    this.presetName = presetName;
    this.q = QUALITY[presetName] || QUALITY.medium;
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
