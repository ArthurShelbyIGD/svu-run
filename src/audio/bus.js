// audio/bus.js — the master bus.
//
//   voices ──► sfx ────┐
//     │                ├──► master ──► limiter ──► clipper ──► destination
//   music ─────────────┤
//     │                │
//     └─► verbIn ──► convolver ──► verbOut ──┘
//
// Two stages of protection across the whole mix, not per sound. A runner fires
// a chime, a footstep, a swish and a pad note inside the same 100ms often
// enough that without them the sum clips on exactly the best moments.
//
// The compressor rides sustained density: it is level-following, so it pulls
// down a busy passage as a whole. The waveshaper is the actual ceiling: it is
// sample-accurate, transparent below its knee, and mathematically incapable of
// letting anything past 1.0. Compressors alone do not do that, which is a
// mistake worth not making twice — see makeSoftClipCurve.
//
// Constructed against any BaseAudioContext, so the offline self-test builds
// exactly the same graph the player hears.

import { makeImpulseResponse, makeNoiseBuffer, makeSoftClipCurve } from './synth.js';

export class Bus {
  /**
   * @param {BaseAudioContext} ac
   * @param {{next:()=>number}} rng  seeded — never Math.random
   * @param {object} p  preset block from index.js
   */
  constructor(ac, rng, p) {
    this.ac = ac;
    this.nodes = 0;

    this.master = ac.createGain();
    this.master.gain.value = p.master;

    this.limiter = ac.createDynamicsCompressor();
    this.limiter.threshold.value = -9;
    this.limiter.knee.value = 8;
    this.limiter.ratio.value = 9;
    this.limiter.attack.value = 0.004;
    this.limiter.release.value = 0.22;

    // Halve on the way in because a WaveShaper's input domain is [-1,1]; the
    // curve is built over [-2,2] and maps straight back out at unity.
    this.preClip = ac.createGain();
    this.preClip.gain.value = 0.5;
    this.clipper = ac.createWaveShaper();
    this.clipper.curve = makeSoftClipCurve(2048, 0.72);
    this.clipper.oversample = '2x';

    this.master.connect(this.limiter);
    this.limiter.connect(this.preClip);
    this.preClip.connect(this.clipper);
    this.clipper.connect(ac.destination);

    this.sfx = ac.createGain();
    this.sfx.gain.value = p.sfxLevel;
    this.sfx.connect(this.master);

    this.music = ac.createGain();
    this.music.gain.value = p.musicLevel;
    this.music.connect(this.master);

    this.verbIn = ac.createGain();
    this.verbIn.gain.value = 1;
    this.verb = ac.createConvolver();
    this.verb.normalize = true;
    this.verb.buffer = makeImpulseResponse(ac, rng, p.irSeconds, p.irChannels, p.irDecay);
    this.verbOut = ac.createGain();
    this.verbOut.gain.value = p.verbLevel;
    this.verbIn.connect(this.verb);
    this.verb.connect(this.verbOut);
    this.verbOut.connect(this.master);

    // Shared noise source material. One buffer, read from a different offset
    // every hit, so noise sounds never phase-lock into an obvious loop.
    this.noise = makeNoiseBuffer(ac, rng, 1.5);

    this.nodes = 9;
    this._musicLevel = p.musicLevel;
    this._masterLevel = p.master;
  }

  /** Music level this bus returns to after a duck. */
  get musicLevel() { return this._musicLevel; }
  get masterLevel() { return this._masterLevel; }

  /**
   * Pull the music down under a sound effect, then let it back up.
   * Used for death: the shatter has to own the moment.
   */
  duck(now, amount, holdSec, releaseSec) {
    const g = this.music.gain;
    g.cancelScheduledValues(now);
    g.setTargetAtTime(this._musicLevel * amount, now, 0.02);
    g.setTargetAtTime(this._musicLevel, now + holdSec, releaseSec);
  }

  /** Fade the whole mix. Used when the tab is hidden. */
  fadeMaster(now, to, seconds) {
    const g = this.master.gain;
    g.cancelScheduledValues(now);
    g.setTargetAtTime(to, now, Math.max(0.005, seconds / 3));
  }

  setMusicLevel(v) {
    this._musicLevel = v;
    this.music.gain.cancelScheduledValues(this.ac.currentTime);
    this.music.gain.setValueAtTime(v, this.ac.currentTime);
  }

  dispose() {
    this.master.disconnect();
    this.limiter.disconnect();
    this.preClip.disconnect();
    this.clipper.disconnect();
    this.clipper.curve = null;
    this.sfx.disconnect();
    this.music.disconnect();
    this.verbIn.disconnect();
    this.verb.disconnect();
    this.verbOut.disconnect();
    this.verb.buffer = null;
    this.noise = null;
  }
}
