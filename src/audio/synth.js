// audio/synth.js — the low-level synthesis toolkit.
//
// Every function here takes the audio context as its first argument and holds
// no state of its own. That is deliberate: the exact same code has to run
// against the live AudioContext and against an OfflineAudioContext, because
// offline rendering is the only way to *verify* synthesised audio in a
// headless test. See Audio.selfTest() in index.js.
//
// No audio files exist in this project and none ever will — the game ships as
// one self-contained HTML. Everything below builds sound out of oscillators,
// noise and filters.

/** MIDI note number -> frequency in Hz. */
export function mtof(m) {
  return 440 * Math.pow(2, (m - 69) / 12);
}

/** Major pentatonic, in semitones. The whole game is in one key. */
export const PENTA = [0, 2, 4, 7, 9];

/** Key of the piece: A. Bright enough for bells, warm enough for the pad. */
export const KEY = 69;

// Exponential ramps cannot reach zero, so silence is this instead. Low enough
// to be inaudible (-80 dB), high enough that the ramp stays well conditioned.
const ZERO = 0.0001;

/**
 * White noise, one channel, reused by every noise-based sound in the game.
 * Built once at init from the seeded RNG — never Math.random, so a run is
 * bit-identical between sessions.
 */
export function makeNoiseBuffer(ac, rng, seconds) {
  const len = Math.max(1, Math.floor(ac.sampleRate * seconds));
  const buf = ac.createBuffer(1, len, ac.sampleRate);
  const d = buf.getChannelData(0);
  for (let i = 0; i < len; i++) d[i] = rng.next() * 2 - 1;
  return buf;
}

/**
 * A synthetic impulse response for the reverb.
 *
 * Exponentially decaying noise is the standard trick and it is convincing, but
 * on its own it reads as a wash rather than a room. Two additions earn their
 * cost: a one-pole lowpass, which takes the fizz off the top and makes the tail
 * sound like air rather than static, and a handful of discrete early
 * reflections, which is what actually tells the ear "this is a hard, bright,
 * glassy space" instead of "this is a delay".
 *
 * `seconds` is preset-driven — the tail is the single most expensive thing in
 * the mix, so `low` gets a short mono one.
 */
export function makeImpulseResponse(ac, rng, seconds, channels, decay) {
  const sr = ac.sampleRate;
  const len = Math.max(1, Math.floor(sr * seconds));
  const buf = ac.createBuffer(channels, len, sr);
  const attackLen = sr * 0.005;
  for (let c = 0; c < channels; c++) {
    const d = buf.getChannelData(c);
    let lp = 0;
    for (let i = 0; i < len; i++) {
      const t = i / len;
      const atk = i < attackLen ? i / attackLen : 1;
      const env = atk * Math.pow(1 - t, decay);
      const n = rng.next() * 2 - 1;
      lp += (n - lp) * 0.55;
      d[i] = lp * env;
    }
    // Early reflections. Decorrelated per channel, which is where the width
    // of the space comes from.
    for (let k = 0; k < 6; k++) {
      const at = Math.floor((0.009 + k * 0.015 + rng.next() * 0.007) * sr);
      if (at < len) d[at] += (rng.next() * 2 - 1) * 0.45 * Math.pow(0.7, k);
    }
  }
  return buf;
}

/**
 * Transfer curve for the final soft clipper.
 *
 * A DynamicsCompressorNode is not a limiter. Its detector follows level, not
 * peaks, so a dense passage of bells — RMS around -16 dB, crests near 0 dB —
 * reads as quiet to it and sails past the threshold into the converter.
 * Measured, before this existed: a top-speed star run with the bed underneath
 * peaked at 1.009 and clipped four samples.
 *
 * A waveshaper is sample-accurate and cannot be fooled. This curve is exactly
 * linear below `knee`, so nothing in normal play is coloured by it at all, and
 * bends to an asymptote at 1.0 above it, so the loudest imaginable pile-up
 * saturates gently instead of clipping. A waveshaper's input domain is [-1,1],
 * so the bus halves the signal on the way in and the curve maps it back out.
 */
export function makeSoftClipCurve(n, knee) {
  const c = new Float32Array(n);
  const span = 1 - knee;
  for (let i = 0; i < n; i++) {
    const x = (i / (n - 1)) * 4 - 2;          // input domain, pre-scaled by 0.5
    const a = Math.abs(x);
    const y = a <= knee ? a : knee + span * Math.tanh((a - knee) / span);
    c[i] = x < 0 ? -y : y;
  }
  return c;
}

/**
 * Percussive envelope: near-instant attack, exponential decay to silence.
 * This is the shape of every struck object — bell, chime, glass, thud.
 */
export function envPluck(param, t0, peak, attack, decay) {
  param.cancelScheduledValues(t0);
  param.setValueAtTime(ZERO, t0);
  param.exponentialRampToValueAtTime(peak, t0 + attack);
  param.exponentialRampToValueAtTime(ZERO, t0 + attack + decay);
  param.setValueAtTime(0, t0 + attack + decay);
}

/** Swelled envelope: slow in, hold, slow out. Pads and risers. */
export function envSwell(param, t0, peak, attack, hold, release) {
  param.cancelScheduledValues(t0);
  param.setValueAtTime(ZERO, t0);
  param.exponentialRampToValueAtTime(peak, t0 + attack);
  param.setValueAtTime(peak, t0 + attack + hold);
  param.exponentialRampToValueAtTime(ZERO, t0 + attack + hold + release);
  param.setValueAtTime(0, t0 + attack + hold + release);
}

/** Exponential glide of a frequency-like parameter. */
export function sweep(param, t0, from, to, dur) {
  param.cancelScheduledValues(t0);
  param.setValueAtTime(Math.max(ZERO, from), t0);
  param.exponentialRampToValueAtTime(Math.max(ZERO, to), t0 + dur);
}

/** Constant value now, cancelling anything previously scheduled. */
export function hold(param, t0, v) {
  param.cancelScheduledValues(t0);
  param.setValueAtTime(v, t0);
}

export { ZERO };
