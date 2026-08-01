// audio/voices.js — a fixed pool of reusable voice channels.
//
// WHY A POOL, when Web Audio makes you create a new OscillatorNode per note
// anyway. Source nodes are one-shot by specification and there is no way round
// that. Everything *downstream* of the source is not: the envelope gain, the
// tone filter, the panner and the reverb send are the expensive nodes to build
// and connect, and they are built exactly once here.
//
// So a note costs one or two oscillators (which Chrome collects by itself once
// they have finished and nothing references them) instead of five nodes plus
// five connections. That is the difference between a chime being free and a
// chime being a GC event, and on a mid-range phone during a star run it is the
// difference the player actually feels.
//
// The pool is also the polyphony cap. `low` gets a smaller one, which is the
// only honest way to bound audio cost on a weak device.

export class VoicePool {
  /**
   * @param {BaseAudioContext} ac
   * @param {AudioNode} out    dry destination (sfx or music sub-bus)
   * @param {AudioNode} verbIn reverb send destination
   * @param {number} size      polyphony
   */
  constructor(ac, out, verbIn, size) {
    this.ac = ac;
    this.n = size;
    this.nodes = 0;

    this.gain = new Array(size);
    this.filt = new Array(size);
    this.pan = new Array(size);
    this.send = new Array(size);
    this.mod = new Array(size);
    /** ac.currentTime at which each voice becomes reusable. */
    this.until = new Float64Array(size);

    for (let i = 0; i < size; i++) {
      const filt = ac.createBiquadFilter();
      filt.type = 'lowpass';
      filt.frequency.value = 20000;
      filt.Q.value = 0.7;

      const gain = ac.createGain();
      gain.gain.value = 0;

      const pan = ac.createStereoPanner();
      pan.pan.value = 0;

      const send = ac.createGain();
      send.gain.value = 0;

      // FM depth. Persistent, because it is the node a modulator oscillator
      // drives into the carrier's frequency param.
      const mod = ac.createGain();
      mod.gain.value = 0;

      filt.connect(gain);
      gain.connect(pan);
      pan.connect(out);
      pan.connect(send);
      send.connect(verbIn);

      this.filt[i] = filt;
      this.gain[i] = gain;
      this.pan[i] = pan;
      this.send[i] = send;
      this.mod[i] = mod;
      this.nodes += 5;
    }
    this._cursor = 0;
  }

  /**
   * Claim a voice that is free at `now` and hold it until `endsAt`.
   * Returns the voice index, or -1 when the pool is exhausted.
   *
   * Exhaustion drops the sound rather than stealing a voice. Stealing means
   * cutting a ringing bell off mid-decay, which is audible as a click; dropping
   * one chime out of a dozen simultaneous ones is not audible at all.
   */
  grab(now, endsAt) {
    for (let k = 0; k < this.n; k++) {
      const i = (this._cursor + k) % this.n;
      if (this.until[i] <= now) {
        this._cursor = (i + 1) % this.n;
        this.until[i] = endsAt;
        // Release last note's modulator so the finished carrier it was wired
        // into can be collected, and so the new note starts from a clean graph.
        this.mod[i].disconnect();
        this.mod[i].gain.cancelScheduledValues(now);
        this.gain[i].gain.cancelScheduledValues(now);
        this.filt[i].frequency.cancelScheduledValues(now);
        this.pan[i].pan.cancelScheduledValues(now);
        this.send[i].gain.cancelScheduledValues(now);
        return i;
      }
    }
    return -1;
  }

  /** How many voices are ringing at `now`. Used by the self-test. */
  active(now) {
    let n = 0;
    for (let i = 0; i < this.n; i++) if (this.until[i] > now) n++;
    return n;
  }

  /** Silence everything immediately — restart, or losing the tab. */
  panic(now) {
    for (let i = 0; i < this.n; i++) {
      this.gain[i].gain.cancelScheduledValues(now);
      this.gain[i].gain.setValueAtTime(0, now);
      this.until[i] = 0;
    }
  }

  dispose() {
    for (let i = 0; i < this.n; i++) {
      this.mod[i].disconnect();
      this.filt[i].disconnect();
      this.gain[i].disconnect();
      this.pan[i].disconnect();
      this.send[i].disconnect();
    }
    this.n = 0;
  }
}
