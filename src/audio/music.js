// audio/music.js — the generative bed.
//
// Two layers, and they are deliberately different kinds of thing.
//
// The PAD is a permanent drone: three oscillators and an LFO built once and
// never stopped, whose frequencies glide between chord roots. That costs
// nothing per bar, allocates nothing ever, and glides between chords instead of
// re-striking them — which is what makes it sit *under* the game rather than
// punctuating it.
//
// The BELLS are sparse, chance-driven, and come out of the same voice pool as
// everything else. Sparse is not laziness: the star chime is the sound the
// player is actually listening for, and a busy melody in the same register
// would bury it. The bed stays low, wide and slow, and leaves the top of the
// mix to the game.
//
// Everything is in one fixed key (A major pentatonic) so that no generated note
// can ever clash with a star chime, which is also in that key. Tempo follows
// player speed loosely — enough to feel the run building, not enough to sound
// like a tape being sped up.

import { mtof, PENTA, KEY, envPluck } from './synth.js';

/** Scheduling horizon. Classic two-clock scheduler: look ahead, not behind. */
const LOOKAHEAD = 0.4;

/** I - vi - IV - V in A, as MIDI roots two octaves down. */
const CHORDS = [KEY - 24, KEY - 27, KEY - 31, KEY - 29];

export class Music {
  constructor(bus, pool, rng, q) {
    this.bus = bus;
    this.ac = bus.ac;
    this.pool = pool;
    this.rng = rng;
    this.q = q;

    this.running = false;
    this.nodes = 0;
    this.notes = 0;      // bells scheduled — read by the self-test
    this.chords = 0;
    this._next = 0;
    this._beat = 0;
    this._level = q.padLevel;

    const ac = bus.ac;

    // ---- the permanent drone ----
    this.padGain = ac.createGain();
    this.padGain.gain.value = 0;

    this.padFilt = ac.createBiquadFilter();
    this.padFilt.type = 'lowpass';
    this.padFilt.frequency.value = 800;
    this.padFilt.Q.value = 0.9;

    this.padPan = ac.createStereoPanner();
    this.padPan.pan.value = 0;

    this.padSend = ac.createGain();
    this.padSend.gain.value = q.padSend;

    this.padFilt.connect(this.padGain);
    this.padGain.connect(this.padPan);
    this.padPan.connect(bus.music);
    this.padPan.connect(this.padSend);
    this.padSend.connect(bus.verbIn);

    const root = mtof(CHORDS[0]);
    this._padGains = [];
    this.oscRoot = this._osc('triangle', root, 0.55);
    this.oscFifth = this._osc('triangle', root * 1.4983, 0.30);   // a fifth up
    this.oscSub = this._osc('sine', root * 0.5, 0.42);
    // A second root a few cents off gives the pad slow movement without any
    // scheduling at all — two oscillators beating against each other.
    this.oscDetune = this._osc('sine', root * 1.003, 0.26);

    // Slow filter breathing. One oscillator, one gain, connected once.
    this.lfo = ac.createOscillator();
    this.lfo.type = 'sine';
    this.lfo.frequency.value = 0.07;
    this.lfoDepth = ac.createGain();
    this.lfoDepth.gain.value = 260;
    this.lfo.connect(this.lfoDepth);
    this.lfoDepth.connect(this.padFilt.frequency);

    this.nodes += 6;
  }

  _osc(type, freq, level) {
    const ac = this.ac;
    const o = ac.createOscillator();
    o.type = type;
    o.frequency.value = freq;
    const g = ac.createGain();
    g.gain.value = level;
    o.connect(g);
    g.connect(this.padFilt);
    this._padGains.push(g);
    this.nodes += 2;
    return o;
  }

  /** Start the drone. Safe to call more than once. */
  start(t) {
    if (this.running) return;
    this.running = true;
    this.oscRoot.start(t);
    this.oscFifth.start(t);
    this.oscSub.start(t);
    this.oscDetune.start(t);
    this.lfo.start(t);
    // Fade in. A drone that snaps on is the most obvious "the audio just
    // started" tell there is.
    this.padGain.gain.cancelScheduledValues(t);
    this.padGain.gain.setValueAtTime(0, t);
    this.padGain.gain.setTargetAtTime(this._level, t, 1.4);
    this._next = t + 0.25;
    this._beat = 0;
    this._chord(t, 0, 0);
  }

  /** Restart the progression from the top — a new run gets a fresh phrase. */
  reset(t) {
    this._beat = 0;
    this._next = t + 0.15;
    if (this.running) this._chord(t, 0, 0);
  }

  setLevel(t, v) {
    this._level = v;
    if (!this.running) return;
    this.padGain.gain.cancelScheduledValues(t);
    this.padGain.gain.setTargetAtTime(v, t, 0.3);
  }

  /**
   * Schedule everything due before `now + LOOKAHEAD`.
   *
   * Called from renderUpdate and allocation-free unless a note is actually due,
   * which at these tempos is a handful of times a second at most.
   */
  update(now, speed01) {
    if (!this.running) return;
    const beat = 60 / (this.q.bpmMin + (this.q.bpmMax - this.q.bpmMin) * speed01);
    // If the clock ran away from us — a hidden tab, a long stall — resync
    // rather than frantically scheduling the notes we missed.
    if (this._next < now - 0.5) this._next = now + 0.05;
    let guard = 0;
    while (this._next < now + LOOKAHEAD && guard++ < 8) {
      this._step(this._next, beat, speed01);
      this._next += beat;
    }
  }

  _step(t, beat, speed01) {
    const b = this._beat % 16;
    if (b % 4 === 0) this._chord(t, (b / 4) | 0, speed01);

    // Sparse melodic bells. Denser as the run gets faster, but never busy.
    const density = this.q.bellDensity * (0.7 + speed01 * 0.6);
    if (this.rng.next() < density) {
      const oct = this.rng.next() < 0.35 ? 12 : 0;
      const deg = PENTA[(this.rng.next() * PENTA.length) | 0];
      // Kept below the star ladder so the pickup chime always sits on top.
      const f = mtof(KEY - 12 + oct + deg);
      const amp = this.q.bellAmp * (0.7 + this.rng.next() * 0.5);
      const pan = (this.rng.next() - 0.5) * 0.9;
      const i = this.pool.grab(t, t + 1.2);
      if (i >= 0) {
        this._bell(i, t, f, amp, 1.8, pan);
        this.notes++;
      }
    }
    this._beat++;
  }

  /** A softer, longer bell than the sfx one — celesta rather than chime. */
  _bell(i, t, f, amp, dur, pan) {
    const ac = this.ac;
    const p = this.pool;
    const car = ac.createOscillator();
    car.type = 'sine';
    car.frequency.value = f;
    const mod = ac.createOscillator();
    mod.type = 'sine';
    mod.frequency.value = f * 2.76;   // classic tubular-bell ratio
    const md = p.mod[i];
    mod.connect(md);
    md.connect(car.frequency);
    envPluck(md.gain, t, f * 0.9, 0.004, dur * 0.16);
    car.connect(p.filt[i]);
    p.filt[i].type = 'lowpass';
    p.filt[i].Q.value = 0.5;
    p.filt[i].frequency.cancelScheduledValues(t);
    p.filt[i].frequency.setValueAtTime(Math.min(12000, f * 7), t);
    envPluck(p.gain[i].gain, t, amp, 0.01, dur);
    p.pan[i].pan.setValueAtTime(pan, t);
    p.send[i].gain.setValueAtTime(this.q.bellSend, t);
    mod.start(t); mod.stop(t + dur + 0.03);
    car.start(t); car.stop(t + dur + 0.03);
    p.attach(i, car, mod);
  }

  _chord(t, idx, speed01) {
    const root = mtof(CHORDS[idx % CHORDS.length]);
    // Glide, do not jump. setTargetAtTime is the cheapest smooth move there is.
    this.oscRoot.frequency.setTargetAtTime(root, t, 0.35);
    this.oscFifth.frequency.setTargetAtTime(root * 1.4983, t, 0.4);
    this.oscSub.frequency.setTargetAtTime(root * 0.5, t, 0.5);
    this.oscDetune.frequency.setTargetAtTime(root * 1.003, t, 0.45);
    // Open the pad up a little as the run gets faster.
    this.padFilt.frequency.setTargetAtTime(700 + speed01 * 900, t, 0.6);
    this.chords++;
  }

  dispose() {
    if (this.running) {
      const t = this.ac.currentTime;
      try {
        this.oscRoot.stop(t); this.oscFifth.stop(t);
        this.oscSub.stop(t); this.oscDetune.stop(t); this.lfo.stop(t);
      } catch (e) { /* already stopped */ }
      this.running = false;
    }
    for (let i = 0; i < this._padGains.length; i++) this._padGains[i].disconnect();
    this._padGains.length = 0;
    this.oscRoot.disconnect(); this.oscFifth.disconnect();
    this.oscSub.disconnect(); this.oscDetune.disconnect();
    this.lfo.disconnect(); this.lfoDepth.disconnect();
    this.padFilt.disconnect(); this.padGain.disconnect();
    this.padPan.disconnect(); this.padSend.disconnect();
  }
}
