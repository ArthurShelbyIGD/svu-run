// Fixed-timestep simulation decoupled from rendering.
//
// Gameplay updates at a constant 60Hz regardless of display refresh rate, so
// physics and feel are identical on a 60Hz phone and a 144Hz laptop. Rendering
// happens once per animation frame with an interpolation alpha available for
// smoothing visual positions between simulation steps.

import { QualityGovernor } from './quality.js';

const STEP = 1 / 60;
const MAX_STEPS_PER_FRAME = 5; // spiral-of-death guard

export class Loop {
  constructor(ctx) {
    this.ctx = ctx;
    this.accumulator = 0;
    this.lastMs = 0;
    this.running = false;
    this.paused = false;
    /** Interpolation factor in [0,1) between the last two sim steps. */
    this.alpha = 0;

    // rolling frame-time stats, used by the auto-quality benchmark and by
    // tools/perf.mjs. Pre-allocated ring buffer, never grows.
    this.frameMs = new Float32Array(120);
    this._frameIdx = 0;
    this.frameCount = 0;
    /**
     * Smoothed frame time in SECONDS. An EMA rather than a median because it
     * is read from the simulation every step and `medianFrameMs()` sorts a
     * copy of the ring — fine once per benchmark, not fine at 60Hz.
     * play/ scales the input buffer off this. Seeded at 60fps.
     */
    this.avgFrameSec = 1 / 60;
    /** How many times the step budget was blown. Diagnostic only. */
    this.backlogDrops = 0;

    /**
     * Steps quality DOWN on a struggling device. Driven from tick() off real
     * frames rather than from a wall-clock timer, so its first verdict lands
     * within the first half-second instead of at 2.5s. See core/quality.js.
     */
    this.quality = new QualityGovernor(ctx);

    this._fixed = [];  // modules with fixedUpdate(dt)
    this._render = []; // modules with renderUpdate(dtReal, alpha)
  }

  /** Cache the module lists once, so the hot path never iterates a Map. */
  bind() {
    this._fixed.length = 0;
    this._render.length = 0;
    for (const mod of this.ctx.modules.values()) {
      if (typeof mod.fixedUpdate === 'function') this._fixed.push(mod);
      if (typeof mod.renderUpdate === 'function') this._render.push(mod);
    }
  }

  start() {
    if (this.running) return;
    this.running = true;
    this.lastMs = performance.now();
    this.accumulator = 0;
  }

  stop() {
    this.running = false;
  }

  setPaused(p) {
    if (this.paused === p) return;
    this.paused = p;
    if (!p) {
      // avoid a huge catch-up burst after unpausing
      this.lastMs = performance.now();
      this.accumulator = 0;
    }
  }

  /** Called once per animation frame by the engine's render loop. */
  tick() {
    if (!this.running) return;

    const now = performance.now();
    let deltaMs = now - this.lastMs;
    this.lastMs = now;

    // clamp: a backgrounded tab can hand us multi-second deltas
    if (deltaMs > 250) deltaMs = 250;

    this.frameMs[this._frameIdx] = deltaMs;
    this._frameIdx = (this._frameIdx + 1) % this.frameMs.length;
    this.frameCount++;
    this.avgFrameSec += (deltaMs / 1000 - this.avgFrameSec) * 0.1;
    this.quality.frame(deltaMs);

    if (!this.paused) {
      this.accumulator += deltaMs / 1000;

      let steps = 0;
      while (this.accumulator >= STEP && steps < MAX_STEPS_PER_FRAME) {
        this.ctx.time += STEP;
        for (let i = 0; i < this._fixed.length; i++) {
          this._fixed[i].fixedUpdate(STEP);
        }
        this.accumulator -= STEP;
        steps++;
      }

      // If we blew the step budget, drop the backlog rather than compounding.
      //
      // This is the spiral guard and it is load-bearing on a slow device. A
      // 66ms frame owes four fixed steps; if a frame ever costs more than five
      // steps' worth of simulation, running the arrears would make the next
      // frame later still, which makes the arrears bigger. Dropping the
      // backlog trades a small, invisible slip in simulated time for a loop
      // that cannot run away. The counter is here so a real-device profile can
      // say whether it is happening at all rather than guessing.
      if (steps === MAX_STEPS_PER_FRAME) {
        this.accumulator = 0;
        this.backlogDrops++;
      }

      this.alpha = this.accumulator / STEP;
    }

    const dtReal = deltaMs / 1000;
    for (let i = 0; i < this._render.length; i++) {
      this._render[i].renderUpdate(dtReal, this.alpha);
    }
  }

  /**
   * Advance the simulation by `seconds` of game time WITHOUT rendering, then
   * run `renderSteps` presentation updates to settle camera smoothing and
   * animation.
   *
   * This exists for the capture/test harness. Software rendering in CI is
   * 10-20x slower than a real GPU, so waiting in real time for the game to
   * reach a given moment is impractically slow; stepping the simulation
   * directly is both instant and perfectly deterministic.
   */
  advance(seconds, renderSteps = 8) {
    const steps = Math.round(seconds / STEP);
    for (let s = 0; s < steps; s++) {
      this.ctx.time += STEP;
      for (let i = 0; i < this._fixed.length; i++) {
        this._fixed[i].fixedUpdate(STEP);
      }
    }
    for (let r = 0; r < renderSteps; r++) {
      for (let i = 0; i < this._render.length; i++) {
        this._render[i].renderUpdate(STEP, 0);
      }
    }
    this.accumulator = 0;
    this.lastMs = performance.now();
    return this.ctx.time;
  }

  /** Median frame time in ms over the ring buffer. Used by the benchmark. */
  medianFrameMs() {
    const n = Math.min(this.frameCount, this.frameMs.length);
    if (n === 0) return 0;
    const tmp = Array.prototype.slice.call(this.frameMs, 0, n);
    tmp.sort((a, b) => a - b);
    return tmp[Math.floor(n / 2)];
  }

  /** 95th-percentile frame time in ms — the number that actually matters. */
  p95FrameMs() {
    const n = Math.min(this.frameCount, this.frameMs.length);
    if (n === 0) return 0;
    const tmp = Array.prototype.slice.call(this.frameMs, 0, n);
    tmp.sort((a, b) => a - b);
    return tmp[Math.min(n - 1, Math.floor(n * 0.95))];
  }
}

export { STEP };
