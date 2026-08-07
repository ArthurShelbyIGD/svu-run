// The runtime quality governor: steps the preset DOWN on a device that cannot
// hold the frame rate, and never back up.
//
// WHY THIS EXISTS SEPARATELY FROM main.js's autoQuality.
//
// The original benchmark fired on a wall-clock timer 2500ms after boot and
// then waited another 3000ms before it was allowed to look again — so on a
// weak phone the entire first impression, the part where a player decides
// whether the game is any good, ran at a setting the device had already been
// measured as unable to hold. It also stopped at 'low', which was the floor.
//
// This one is driven from Loop.tick off REAL PRESENTED FRAMES. It ignores a
// short warm-up (first frames include shader compiles and texture uploads and
// are not representative), then decides on the first small batch of frames
// after that — under half a second on a fast device, a couple of frames later
// on a slow one, which is exactly when you want the verdict.
//
// ONE-DIRECTIONAL, DELIBERATELY. It never steps back up. Oscillating between
// presets looks far worse than sitting one notch low, and a device that was
// slow in the first second is not going to become a different device.

import { QUALITY } from './config.js';
import { EV } from './ctx.js';

/** Cheapest last. 'potato' is below 'low' — see QUALITY in config.js. */
export const PRESET_ORDER = ['high', 'medium', 'low', 'potato'];

// Frames discarded before measuring. Shader compilation, the first texture
// uploads and the browser's own first-paint work all land here.
const WARMUP_FRAMES = 5;
// A verdict needs either this many frames...
const BATCH_FRAMES = 8;
// ...or this much wall time with at least MIN_FRAMES of evidence, whichever
// comes first. On a 15fps phone that is three frames at ~200ms apart, so the
// first step-down happens around 600-700ms in rather than at 2.5s.
const BATCH_MS = 500;
const MIN_FRAMES = 3;
// Median frame time above which the preset comes down. 20ms is 50fps: below
// that the game is not holding 60 and the owner has said plainly that he wants
// responsive over crisp.
const SLOW_MS = 20;
// Stop watching after this many verdicts. Cheap insurance against a governor
// that keeps sampling forever; by this point it has either stepped to the
// floor or established that the device is fine.
const MAX_BATCHES = 8;

export class QualityGovernor {
  constructor(ctx) {
    this.ctx = ctx;
    this.enabled = null;        // resolved on the first frame
    this.batches = 0;
    this.steps = 0;             // how many times quality has been dropped
    this.lastMedianMs = 0;
    this._warm = 0;
    this._n = 0;
    this._elapsed = 0;
    // Fixed scratch. Sorted in place at decision time; never allocates.
    this._s = new Float32Array(BATCH_FRAMES);
    this._pQ = { preset: '' };   // pooled event payload
  }

  /**
   * Whether to run at all. Off for captures (they must be preset-pinned and
   * deterministic) and off when the player or a tool forced a preset with
   * `?q=` — a forced preset is an instruction, not a suggestion.
   */
  _resolve() {
    const c = this.ctx.config;
    this.enabled = !!c && !c.captureMode && c.autoQuality === true;
    return this.enabled;
  }

  /** One presented frame, in ms. Called from Loop.tick. Hot path. */
  frame(ms) {
    if (this.enabled === null && !this._resolve()) return;
    if (!this.enabled) return;
    if (this._warm < WARMUP_FRAMES) { this._warm++; return; }

    if (this._n < BATCH_FRAMES) this._s[this._n++] = ms;
    this._elapsed += ms;

    if (this._n >= BATCH_FRAMES || (this._elapsed >= BATCH_MS && this._n >= MIN_FRAMES)) {
      this._decide();
    }
  }

  _decide() {
    const n = this._n;
    const s = this._s;
    // Insertion sort, n <= 8, in place, no allocation.
    for (let i = 1; i < n; i++) {
      const v = s[i];
      let j = i - 1;
      while (j >= 0 && s[j] > v) { s[j + 1] = s[j]; j--; }
      s[j + 1] = v;
    }
    const median = s[n >> 1];
    this._n = 0;
    this._elapsed = 0;
    this.lastMedianMs = median;
    this.batches++;
    if (this.batches >= MAX_BATCHES) this.enabled = false;
    if (median <= SLOW_MS) return;
    this.stepDown();
  }

  /** Drop one rung, if there is one. Returns the new preset name or null. */
  stepDown() {
    const cfg = this.ctx.config;
    const i = PRESET_ORDER.indexOf(cfg.presetName);
    if (i < 0 || i >= PRESET_ORDER.length - 1) {
      this.enabled = false;   // already on the floor; stop measuring
      return null;
    }
    const next = PRESET_ORDER[i + 1];
    this.apply(next);
    this.steps++;
    return next;
  }

  /**
   * Switch presets live. Everything a running scene can change without being
   * rebuilt: render scale, the post chain, and the budgets other subsystems
   * read on their own next opportunity.
   */
  apply(name) {
    const ctx = this.ctx;
    if (!ctx.config.setPreset(name)) return false;
    const q = QUALITY[name];
    if (ctx.engine) ctx.engine.setHardwareScalingLevel(1 / q.scale);
    if (ctx.post) ctx.post.setPreset(name);
    if (ctx.pipeline && q.bloom) ctx.pipeline.bloomWeight = q.bloomScale;
    // THE PAYLOAD CARRIES THE DETAIL TIER, NOT THE PRESET KEY.
    // Every subsystem outside core/ switches on `config.q.name` to decide how
    // much detail to build, and 'potato' deliberately reports itself as the
    // 'low' tier so all of that logic keeps working (see QUALITY.potato).
    // Sending the tier here keeps the event consistent with what a listener
    // would read off the config itself.
    this._pQ.preset = q.name;
    ctx.emit(EV.QUALITY_CHANGE, this._pQ);
    return true;
  }
}
