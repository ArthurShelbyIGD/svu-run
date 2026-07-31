// Deterministic seeded RNG. Every gameplay-affecting random number in the game
// MUST come from here (via ctx.rng) so runs are reproducible for testing and
// so screenshot captures are identical between builds.
//
// Algorithm: mulberry32. Fast, tiny, good enough distribution for a runner.

export class Rng {
  constructor(seed = 0x9e3779b9) {
    this.seed = seed >>> 0;
    this._s = this.seed;
  }

  /** Reset the stream back to its original seed. */
  reset(seed) {
    if (seed !== undefined) this.seed = seed >>> 0;
    this._s = this.seed;
    return this;
  }

  /** Float in [0, 1). */
  next() {
    this._s = (this._s + 0x6d2b79f5) >>> 0;
    let t = this._s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  /** Float in [min, max). */
  range(min, max) {
    return min + this.next() * (max - min);
  }

  /** Integer in [min, max] inclusive. */
  int(min, max) {
    return Math.floor(min + this.next() * (max - min + 1));
  }

  /** True with probability p. */
  chance(p) {
    return this.next() < p;
  }

  /** Uniform pick from an array. Does not allocate. */
  pick(arr) {
    return arr[Math.floor(this.next() * arr.length)];
  }

  /**
   * Weighted pick. `weights[i]` corresponds to `arr[i]`.
   * Caller supplies the pre-summed total to avoid a per-call reduce.
   */
  pickWeighted(arr, weights, total) {
    let r = this.next() * total;
    for (let i = 0; i < arr.length; i++) {
      r -= weights[i];
      if (r <= 0) return arr[i];
    }
    return arr[arr.length - 1];
  }

  /** Fork an independent stream, deterministically derived from this one. */
  fork() {
    return new Rng(Math.floor(this.next() * 0xffffffff));
  }
}
