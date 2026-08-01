// audio/sfx.js — the sound designs.
//
// The art direction is fine jewellery, which is a gift: bell, glass, chime and
// celesta timbres are the easiest convincing things to synthesise, because
// they are all the same shape — a hard strike, an inharmonic spectrum, an
// exponential decay. Two-operator FM at a non-integer ratio gives that for the
// price of two oscillators, and everything metallic in this game is built from
// it. Air, grit and impact come from filtered noise off one shared buffer.
//
// Every method takes an absolute audio-context time `t` so sounds can be
// scheduled slightly ahead of the clock instead of "now, if the main thread
// gets round to it". Scheduling ahead is the difference between a chime that
// lands on the pickup and one that lands whenever the frame did.
//
// Levels are relative to the sfx sub-bus and were set against each other by
// what each sound is *for*: the star chime and the death shatter are events the
// player must not miss, footsteps and lane swishes are texture and sit well
// under them.

import { mtof, PENTA, KEY, envPluck, sweep, hold } from './synth.js';

/** Highest rung of the star ladder. Above this it is shrill, not exciting. */
export const LADDER_MAX = 12;

/**
 * Fraction of a note's length for which its voice is held before it can be
 * reused.
 *
 * An exponential decay from full level to -80 dB over `dur` is already 48 dB
 * down at 0.6 of the way through — inaudible under anything else in the mix.
 * Holding the voice for the full ring is therefore paying two thirds of the
 * polyphony budget for silence, and on `low` (eight voices, a bell that rings
 * for a second) that is the difference between a star run chiming on every
 * pickup and a star run dropping half of them. The reclaim is clean because
 * the old note's sources are stopped on the way out — see VoicePool._cut.
 */
const TAIL = 0.62;

export class Sfx {
  constructor(bus, pool, rng, q) {
    this.bus = bus;
    this.ac = bus.ac;
    this.pool = pool;
    this.rng = rng;
    this.q = q;
    /** Incremented on every voice actually started. Read by the self-test. */
    this.voices = 0;
    // Rolling estimate of how many chimes are currently overlapping, used to
    // keep a star run from ballooning. See star().
    this._density = 0;
    this._lastStar = -99;
  }

  // ---- primitives ------------------------------------------------------

  /**
   * Two-operator FM bell. The whole jewellery box comes out of this one.
   * `ratio` non-integer = inharmonic = metal.
   *
   * `index` is the FM modulation index proper — peak deviation divided by the
   * MODULATOR's frequency, not the carrier's. That distinction is the whole
   * ball game and it is easy to get wrong: expressing depth as a multiple of
   * the carrier meant that at ratio 3, an apparently generous depth of 2.6 was
   * really an index of 0.86, where the second-order sidebands are still
   * vanishing and the bell has essentially no upper partials. Measured, the
   * chimes were coming out duller at the strike than in the tail. Carson says
   * the bandwidth here is about 2(index+1) times the modulator frequency, so
   * an index near 2 is what actually buys metal.
   *
   * Returns the voice index, or -1 if the pool is full.
   */
  bell(t, freq, amp, dur, ratio, index, send, pan) {
    const p = this.pool;
    const i = p.grab(t, t + dur * TAIL + 0.02);
    if (i < 0) return -1;
    const ac = this.ac;

    const car = ac.createOscillator();
    car.type = 'sine';
    car.frequency.value = freq;

    const mod = ac.createOscillator();
    mod.type = 'sine';
    mod.frequency.value = freq * ratio;

    // Keep the sidebands under Nyquist.
    //
    // Carson's rule puts the outermost significant sideband at about
    // (index + 1) x the modulator frequency. On the top rungs of the star
    // ladder the modulator is already near 8 kHz, so a generous index throws
    // partials past 22 kHz, where they do not disappear — they fold back down
    // the spectrum as inharmonic grit. Clamping the index by frequency means
    // low bells stay bright and high bells stay clean, which is what real
    // struck metal does anyway.
    const modF = freq * ratio;
    const maxIndex = ac.sampleRate * 0.42 / modF - 1;
    const idx = index < maxIndex ? index : (maxIndex > 0.15 ? maxIndex : 0.15);

    const md = p.mod[i];
    mod.connect(md);
    md.connect(car.frequency);
    // The modulator decays far faster than the carrier. This is the whole
    // trick: the sidebands it throws off exist only during the strike, so the
    // note starts as bright metal and settles into a pure ringing tone, which
    // is exactly what a struck bell does. Measured before this was tightened,
    // the chime's tail was brighter than its attack — the one thing a bell
    // never is.
    envPluck(md.gain, t, modF * idx, 0.002, dur * 0.17);

    car.connect(p.filt[i]);
    p.filt[i].type = 'lowpass';
    p.filt[i].Q.value = 0.5;
    hold(p.filt[i].frequency, t, Math.min(19000, freq * 10 + 3000));
    envPluck(p.gain[i].gain, t, amp, 0.004, dur);
    hold(p.pan[i].pan, t, pan);
    hold(p.send[i].gain, t, send);

    mod.start(t);
    mod.stop(t + dur + 0.03);
    car.start(t);
    car.stop(t + dur + 0.03);
    p.attach(i, car, mod);
    this.voices++;
    return i;
  }

  /** Filtered noise burst: air, grit, glass dust, scrape. */
  noise(t, dur, amp, type, f0, f1, qf, send, pan, attack) {
    const p = this.pool;
    const i = p.grab(t, t + dur * TAIL + 0.02);
    if (i < 0) return -1;
    const ac = this.ac;

    const src = ac.createBufferSource();
    src.buffer = this.bus.noise;
    src.loop = true;
    // A different read offset every hit, so repeated sounds never phase-lock
    // into an audible loop.
    const off = this.rng.next() * (this.bus.noise.duration - 0.05);

    src.connect(p.filt[i]);
    p.filt[i].type = type;
    p.filt[i].Q.value = qf;
    sweep(p.filt[i].frequency, t, f0, f1, dur);
    envPluck(p.gain[i].gain, t, amp, attack, dur);
    hold(p.pan[i].pan, t, pan);
    hold(p.send[i].gain, t, send);

    src.start(t, off);
    src.stop(t + dur + 0.03);
    p.attach(i, src, null);
    this.voices++;
    return i;
  }

  /** Plain swept oscillator: bodies, thumps, risers. */
  tone(t, type, f0, f1, dur, amp, cutoff, send, pan, attack) {
    const p = this.pool;
    const i = p.grab(t, t + dur * TAIL + 0.02);
    if (i < 0) return -1;
    const ac = this.ac;

    const osc = ac.createOscillator();
    osc.type = type;
    sweep(osc.frequency, t, f0, f1, dur);

    osc.connect(p.filt[i]);
    p.filt[i].type = 'lowpass';
    p.filt[i].Q.value = 0.8;
    hold(p.filt[i].frequency, t, cutoff);
    envPluck(p.gain[i].gain, t, amp, attack, dur);
    hold(p.pan[i].pan, t, pan);
    hold(p.send[i].gain, t, send);

    osc.start(t);
    osc.stop(t + dur + 0.03);
    p.attach(i, osc, null);
    this.voices++;
    return i;
  }

  /**
   * Move a live voice's pan across its own duration.
   *
   * The finiteness guard is not paranoia. AudioParam methods throw on a
   * non-finite value, and these are driven from handlers on the event bus — so
   * one malformed payload would not make a wrong noise, it would take out
   * whatever was mid-emit. Audio is never worth breaking a frame for.
   */
  panSweep(i, t, from, to, dur) {
    if (i < 0 || !Number.isFinite(from) || !Number.isFinite(to)) return;
    const p = this.pool.pan[i].pan;
    p.cancelScheduledValues(t);
    p.setValueAtTime(from, t);
    p.linearRampToValueAtTime(to, t + dur);
  }

  // ---- the sounds ------------------------------------------------------

  /**
   * Star pickup. The rung of the ladder is passed in — pitching a pickup up
   * through a run and dropping it on a miss is the single most satisfying
   * trick in the genre, and it costs one integer.
   */
  star(t, step) {
    const s = step < LADDER_MAX ? step : LADDER_MAX;
    const midi = 72 + ((s / 5) | 0) * 12 + PENTA[s % 5];
    const f = mtof(midi);
    const pan = (this.rng.next() - 0.5) * 0.35;
    // Higher rungs ring shorter, which is both what a smaller bell does and
    // what keeps a long star run from eating the whole voice pool: at top speed
    // stars arrive about every 60ms, so the chime has to get out of its own way.
    const dur = 0.80 - s * 0.022;

    // Level-normalise against how fast stars are arriving.
    //
    // At top speed a run delivers a pickup every 60ms, so eight chimes overlap
    // and their sum is roughly sqrt(8) times one of them — which is how the mix
    // reached 1.009 and clipped the converter. Backing each chime off by the
    // rate keeps the RUN at a constant loudness while a single lonely pickup
    // stays full-blooded, which is what a mix engineer would do by hand. The
    // exponent is below a half deliberately: a dense run should still be a
    // little louder, just not four times louder.
    this._density = this._density * Math.exp(-(t - this._lastStar) / 0.45) + 1;
    this._lastStar = t;
    const amp = 0.46 / Math.pow(this._density, 0.35);

    this.bell(t, f, amp, dur, 3.03, 2.20, 0.34, pan);
    if (this.q.extras) {
      // A quiet octave above, struck a hair late — the glassy top that says
      // "cut stone" rather than "sine wave".
      this.bell(t + 0.006, f * 2.005, amp * 0.28, dur * 0.55, 2.01, 1.20, 0.45, pan * -1);
    }
    // High rungs get a tick of dust on the strike so the ladder keeps growing
    // in excitement after it stops growing in pitch.
    if (this.q.extras && s >= LADDER_MAX - 2) {
      this.noise(t, 0.09, amp * 0.22, 'highpass', 5200, 8200, 0.7, 0.4, pan, 0.001);
    }
  }

  jump(t) {
    this.tone(t, 'triangle', 190, 440, 0.15, 0.20, 2400, 0.14, 0, 0.005);
    this.noise(t, 0.14, 0.11, 'bandpass', 700, 2600, 1.4, 0.18, 0, 0.006);
  }

  /** Harder landings hit harder: lower, louder, longer, and they ring metal. */
  land(t, hard) {
    if (hard) {
      this.tone(t, 'sine', 210, 46, 0.30, 0.50, 900, 0.10, 0, 0.002);
      this.noise(t, 0.20, 0.22, 'lowpass', 1600, 240, 0.8, 0.16, 0, 0.001);
      this.bell(t + 0.01, mtof(KEY + 19), 0.13, 0.45, 4.1, 1.6, 0.34, 0.12);
    } else {
      this.tone(t, 'sine', 155, 62, 0.16, 0.26, 700, 0.07, 0, 0.003);
      this.noise(t, 0.10, 0.11, 'lowpass', 1200, 320, 0.8, 0.10, 0, 0.002);
    }
  }

  /** Slide: a long glassy scrape that falls away. */
  slide(t) {
    this.noise(t, 0.42, 0.28, 'bandpass', 3400, 620, 2.6, 0.22, 0, 0.012);
    this.tone(t, 'sawtooth', 220, 90, 0.24, 0.13, 700, 0.08, 0, 0.01);
  }

  /** Lane change: a soft metallic swish that crosses the stereo field. */
  lane(t, dir) {
    const i = this.noise(t, 0.20, 0.30, 'bandpass', 1500, 4600, 2.2, 0.20, 0, 0.008);
    this.panSweep(i, t, -0.55 * dir, 0.55 * dir, 0.20);
    if (this.q.extras) {
      const j = this.bell(t + 0.01, mtof(KEY + 26), 0.075, 0.28, 5.4, 1.2, 0.3, -0.3 * dir);
      this.panSweep(j, t, -0.4 * dir, 0.4 * dir, 0.28);
    }
  }

  /** Corner committed: a rising sweep that leans into the turn. */
  turn(t, dir) {
    const i = this.tone(t, 'sawtooth', 120, 620, 0.42, 0.20, 2600, 0.22, 0, 0.04);
    this.panSweep(i, t, 0, 0.7 * dir, 0.42);
    const j = this.noise(t, 0.40, 0.16, 'bandpass', 500, 5200, 1.6, 0.26, 0, 0.05);
    this.panSweep(j, t, -0.2 * dir, 0.8 * dir, 0.40);
  }

  /** Corner completed cleanly: a three-note celesta flourish. */
  flourish(t) {
    const base = KEY + 12;
    this.bell(t, mtof(base + PENTA[0]), 0.24, 0.55, 3.01, 1.8, 0.4, -0.18);
    this.bell(t + 0.085, mtof(base + PENTA[2]), 0.22, 0.6, 3.01, 1.8, 0.42, 0.05);
    this.bell(t + 0.17, mtof(base + 12 + PENTA[0]), 0.26, 0.9, 3.01, 1.9, 0.5, 0.2);
  }

  /** Obstacle contact. Short, blunt, and immediately followed by the shatter. */
  impact(t) {
    this.tone(t, 'sine', 240, 62, 0.18, 0.46, 800, 0.08, 0, 0.001);
    this.noise(t, 0.12, 0.34, 'lowpass', 2200, 500, 0.9, 0.12, 0, 0.001);
  }

  /**
   * Death: glass shattering. A cluster of very short inharmonic bells at
   * scattered high frequencies, thrown across the stereo field, over a dropping
   * body — which is what a broken thing sounds like, and what makes the reverb
   * tail worth having.
   */
  death(t) {
    this.tone(t, 'sine', 130, 32, 0.55, 0.46, 600, 0.14, 0, 0.002);
    this.noise(t, 0.30, 0.30, 'highpass', 3000, 900, 0.8, 0.40, 0, 0.001);
    const n = this.q.deathGrains;
    for (let k = 0; k < n; k++) {
      const at = t + k * 0.026 + this.rng.next() * 0.02;
      // Kept below 3.6 kHz with a modest ratio so the grains stay inside the
      // band rather than aliasing; the noise burst above carries the very top.
      const f = 1200 + this.rng.next() * 2400;
      const amp = 0.26 * (1 - k / (n + 2));
      this.bell(at, f, amp, 0.20 + this.rng.next() * 0.3, 1.6 + this.rng.next() * 1.6,
        1.5, 0.5, (this.rng.next() - 0.5) * 1.5);
    }
    // The shard that keeps ringing after the rest have stopped.
    this.bell(t + 0.10, mtof(KEY + 15), 0.16, 1.7, 3.4, 1.3, 0.62, 0.1);
  }

  /** Footfall. Texture, not an event — it must sit under everything. */
  foot(t, which) {
    const f = which ? 2000 : 1700;
    this.noise(t, 0.055, 0.055, 'lowpass', f, f * 0.35, 0.9, 0.05, which ? 0.12 : -0.12, 0.002);
    this.tone(t, 'sine', 105, 62, 0.06, 0.035, 400, 0.02, 0, 0.002);
  }

  /** Run start: a quiet two-note "ready". */
  start(t) {
    this.bell(t, mtof(KEY + 12), 0.16, 0.7, 3.01, 1.6, 0.4, -0.15);
    this.bell(t + 0.11, mtof(KEY + 19), 0.18, 1.0, 3.01, 1.7, 0.45, 0.15);
  }
}
