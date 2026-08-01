// audio/bus.js — the master bus.
//
//   voices ──► sfx ────┐
//     │                ├──► master ──► limiter ──► destination
//   music ─────────────┤
//     │                │
//     └─► verbIn ──► convolver ──► verbOut ──┘
//
// One limiter across the whole mix, not per sound. A runner fires a chime, a
// footstep, a swish and a pad note inside the same 100ms often enough that
// without a limiter the sum clips on the loud moments and the game sounds
// cheap. A single DynamicsCompressor with a fast attack and a high ratio is
// effectively free and makes the mix survive a dogpile.
//
// Constructed against any BaseAudioContext, so the offline self-test builds
// exactly the same graph the player hears.

import { makeImpulseResponse, makeNoiseBuffer } from './synth.js';

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
    this.limiter.threshold.value = -7;
    this.limiter.knee.value = 6;
    this.limiter.ratio.value = 14;
    this.limiter.attack.value = 0.003;
    this.limiter.release.value = 0.18;

    this.master.connect(this.limiter);
    this.limiter.connect(ac.destination);

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

    this.nodes = 7;
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
    this.sfx.disconnect();
    this.music.disconnect();
    this.verbIn.disconnect();
    this.verb.disconnect();
    this.verbOut.disconnect();
    this.verb.buffer = null;
    this.noise = null;
  }
}
