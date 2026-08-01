// audio/ — Web Audio synthesis and mixing.
//
// OWNERSHIP: this directory owns everything the game makes a noise with. It
// listens to the event bus and reads player state; it never writes gameplay
// state and never emits gameplay events.
//
// EVERYTHING IS SYNTHESISED. There are no audio files and there cannot be —
// the game ships as one self-contained HTML with no external assets. See
// synth.js for the toolkit, sfx.js for the sound designs, music.js for the bed.
//
// THREE THINGS DRIVE THE DESIGN:
//
// 1. Mobile browsers start an AudioContext suspended and only let it run after
//    a real user gesture. Nothing is ever scheduled while the context is not
//    running, because a suspended context's clock is frozen at zero and every
//    "play now" would pile up at t=0 and detonate together on resume.
//
// 2. Nothing allocates per frame. Source nodes are one-shot by specification so
//    a note has to create its oscillators, but every node downstream of them —
//    envelope, filter, panner, reverb send — is pooled and reused (voices.js),
//    and the music pad is a permanent drone that allocates nothing at all.
//
// 3. Sounds are rate-limited per kind against the *audio* clock. That keeps a
//    dogpile of events (or a test harness fast-forwarding a thousand simulation
//    steps into one frame) from turning into a thousand oscillators.

import { EV } from '../core/ctx.js';
import { Rng } from '../core/rng.js';
import { STATE } from '../play/index.js';
import { Bus } from './bus.js';
import { VoicePool } from './voices.js';
import { Sfx, LADDER_MAX } from './sfx.js';
import { Music } from './music.js';

/**
 * Per-preset budget. `low` is the binding constraint on the whole project, so
 * it gets a short mono reverb tail, a small polyphony cap and none of the
 * decorative extra layers. The tail is the expensive part: convolution cost is
 * linear in impulse length and it is the one audio thing that can actually cost
 * a mid-range phone a frame.
 */
const PRESETS = {
  low:    { voices: 8,  musicVoices: 3, irSeconds: 0.55, irChannels: 1, irDecay: 2.6, extras: false, deathGrains: 3, bellDensity: 0.16 },
  medium: { voices: 14, musicVoices: 4, irSeconds: 1.15, irChannels: 2, irDecay: 2.2, extras: true,  deathGrains: 5, bellDensity: 0.20 },
  high:   { voices: 20, musicVoices: 5, irSeconds: 1.90, irChannels: 2, irDecay: 2.0, extras: true,  deathGrains: 7, bellDensity: 0.22 },
};

/** Shared across presets — mix levels, not budgets. */
const COMMON = {
  master: 0.85,
  sfxLevel: 0.80,
  musicLevel: 0.26,
  verbLevel: 0.85,
  padLevel: 0.50,
  padSend: 0.45,
  bellAmp: 0.11,
  bellSend: 0.55,
  bpmMin: 62,
  bpmMax: 92,
};

// Sound ids, used only to index the rate-limit table.
const S_STAR = 0, S_JUMP = 1, S_LAND = 2, S_SLIDE = 3, S_LANE = 4,
  S_TURN = 5, S_IMPACT = 6, S_DEATH = 7, S_FOOT = 8, S_FLOURISH = 9,
  S_START = 10, S_COUNT = 11;

/** Minimum seconds between two sounds of the same kind. */
const MIN_GAP = new Float64Array([
  0.045, 0.09, 0.08, 0.15, 0.06, 0.25, 0.20, 0.60, 0.10, 0.30, 0.60,
]);

/** Seconds of game time without a star before the ladder falls back to zero. */
const COMBO_GAP = 3.2;

/** How far ahead of the audio clock sounds are scheduled. */
const LATENCY = 0.012;

export default class Audio {
  constructor(ctx) {
    this.ctx = ctx;
    this.name = 'audio';

    this.ac = null;
    this.bus = null;
    this.sfxPool = null;
    this.musicPool = null;
    this.sfx = null;
    this.music = null;

    this.enabled = false;
    this.ready = false;      // graph built
    this.unlocked = false;   // context has actually run at least once
    this.muted = false;

    // Own RNG stream, seeded from the run seed. Deliberately NOT ctx.rng:
    // drawing from the gameplay stream would make the world generation depend
    // on how many sounds have played, which would break both determinism and
    // the capture harness. Seeded rather than Math.random so a run still sounds
    // identical twice, per the project rule.
    this._rng = null;

    this._combo = 0;
    this._lastStar = -99;
    this._turns = 0;
    this._stepPhase = 0;
    this._foot = 0;
    this._last = new Float64Array(S_COUNT);
    this._offs = [];
    this._domOffs = [];
    this._suspendTimer = 0;
    this._play = null;
    this._q = null;
    this._silence = null;
  }

  init() {
    const cfg = this.ctx.config;
    // The screenshot harness runs thousands of simulation steps with no user
    // present. An audio context there is pure cost.
    if (cfg.captureMode) return;

    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;   // no Web Audio: the game is silent, never broken

    this._rng = new Rng((cfg.seed ^ 0x41554449) >>> 0);
    this._q = this._presetBlock(cfg.presetName);

    try {
      // Created eagerly, resumed lazily. Creating it up front means the whole
      // graph exists before the first gesture, so the first tap makes a sound
      // instead of building a reverb.
      this.ac = new AC();
      this._buildGraph();
    } catch (err) {
      this.ac = null;
      this.ready = false;
      return;
    }

    this.enabled = true;
    this._play = this.ctx.tryGet('play');
    this._bindEvents();
    this._bindUnlock();
    this._bindVisibility();

    // Desktop browsers often allow it straight away; mobile will not, and will
    // pick this up on the first touch instead.
    this._tryResume();
  }

  _presetBlock(name) {
    const p = PRESETS[name] || PRESETS.medium;
    // One allocation, at init. Copied because QUALITY_CHANGE mutates it and the
    // preset table itself must stay pristine.
    const q = {};
    for (const k in COMMON) q[k] = COMMON[k];
    for (const k in p) q[k] = p[k];
    return q;
  }

  _buildGraph() {
    const q = this._q;
    this.bus = new Bus(this.ac, this._rng, q);
    this.sfxPool = new VoicePool(this.ac, this.bus.sfx, this.bus.verbIn, q.voices);
    this.musicPool = new VoicePool(this.ac, this.bus.music, this.bus.verbIn, q.musicVoices);
    this.sfx = new Sfx(this.bus, this.sfxPool, this._rng, q);
    this.music = new Music(this.bus, this.musicPool, this._rng, q);
    this._silence = this.ac.createBuffer(1, 1, this.ac.sampleRate);
    this.ready = true;
  }

  /** Total nodes in the live graph. Structural check for the smoke test. */
  get nodeCount() {
    if (!this.ready) return 0;
    return this.bus.nodes + this.sfxPool.nodes + this.musicPool.nodes + this.music.nodes;
  }

  // ---- unlocking -------------------------------------------------------

  /**
   * iOS Safari, and increasingly every other mobile browser, will not let an
   * AudioContext run until a gesture. Three things matter here and all three
   * are load-bearing:
   *
   *   - resume() must be called *synchronously inside* the gesture handler. Any
   *     await before it and the gesture no longer counts.
   *   - iOS additionally wants a source node started inside that same gesture
   *     before it will route audio to the hardware. A one-sample silent buffer
   *     is the standard way to do it.
   *   - the listeners stay bound for the life of the game rather than firing
   *     once. iOS suspends the context on an incoming call, a lock, or a route
   *     change, and the next tap has to be able to pick it up again.
   */
  _bindUnlock() {
    const unlock = () => this._tryResume();
    const evs = ['pointerdown', 'touchend', 'touchstart', 'mousedown', 'keydown'];
    for (let i = 0; i < evs.length; i++) {
      const name = evs[i];
      window.addEventListener(name, unlock, { passive: true, capture: true });
      this._domOffs.push(() => window.removeEventListener(name, unlock, { capture: true }));
    }
    const onState = () => {
      if (this.ac && this.ac.state === 'running') this._afterResume();
    };
    this.ac.addEventListener('statechange', onState);
    this._domOffs.push(() => this.ac && this.ac.removeEventListener('statechange', onState));
  }

  _tryResume() {
    const ac = this.ac;
    if (!ac || this.muted) return;
    if (ac.state === 'running') { this._afterResume(); return; }
    try {
      // Must happen inside the gesture, before any promise.
      const s = ac.createBufferSource();
      s.buffer = this._silence;
      s.connect(ac.destination);
      s.start(0);
    } catch (err) { /* not fatal — resume alone works on most browsers */ }
    try {
      const p = ac.resume();
      if (p && p.then) p.then(() => this._afterResume(), () => {});
    } catch (err) { /* blocked; the next gesture will try again */ }
  }

  _afterResume() {
    if (!this.ready || this.muted) return;
    if (!this.ac || this.ac.state !== 'running') return;
    if (!this.unlocked) {
      this.unlocked = true;
      this.music.start(this.ac.currentTime + 0.05);
      this._play0(S_START, 0.06);
    }
  }

  // ---- tab visibility --------------------------------------------------

  _bindVisibility() {
    const onVis = () => this.setMuted(document.hidden);
    document.addEventListener('visibilitychange', onVis);
    this._domOffs.push(() => document.removeEventListener('visibilitychange', onVis));
    // Desktop alt-tab does not always fire visibilitychange on every browser.
    const onBlur = () => this.setMuted(true);
    const onFocus = () => { if (!document.hidden) this.setMuted(false); };
    window.addEventListener('blur', onBlur);
    window.addEventListener('focus', onFocus);
    this._domOffs.push(() => window.removeEventListener('blur', onBlur));
    this._domOffs.push(() => window.removeEventListener('focus', onFocus));
  }

  /**
   * Mute cleanly. A fade first, then suspend — suspending on the same tick
   * chops whatever was ringing mid-cycle, and a chopped reverb tail is a click.
   */
  setMuted(m) {
    if (!this.ready || this.muted === m) return;
    this.muted = m;
    const ac = this.ac;
    const now = ac.currentTime;
    if (m) {
      this.bus.fadeMaster(now, 0, 0.08);
      if (this._suspendTimer) clearTimeout(this._suspendTimer);
      this._suspendTimer = setTimeout(() => {
        this._suspendTimer = 0;
        if (!this.muted || !this.ac) return;
        this.sfxPool.panic(this.ac.currentTime);
        if (this.ac.state === 'running') this.ac.suspend().catch(() => {});
      }, 140);
    } else {
      if (this._suspendTimer) { clearTimeout(this._suspendTimer); this._suspendTimer = 0; }
      this.bus.fadeMaster(ac.currentTime, this.bus.masterLevel, 0.12);
      this._tryResume();
    }
  }

  // ---- event wiring ----------------------------------------------------

  _bindEvents() {
    const ctx = this.ctx;
    this._offs.push(ctx.on(EV.PICKUP_STAR, () => this._onStar()));
    this._offs.push(ctx.on(EV.PLAYER_JUMP, () => this._play0(S_JUMP)));
    this._offs.push(ctx.on(EV.PLAYER_LAND, (p) => this._onLand(p)));
    this._offs.push(ctx.on(EV.PLAYER_SLIDE, (p) => { if (p && p.active) this._play0(S_SLIDE); }));
    this._offs.push(ctx.on(EV.PLAYER_LANE, (p) => this._onLane(p)));
    this._offs.push(ctx.on(EV.PLAYER_TURN, (p) => this._onTurn(p)));
    this._offs.push(ctx.on(EV.OBSTACLE_HIT, () => this._play0(S_IMPACT)));
    this._offs.push(ctx.on(EV.PLAYER_DEATH, () => this._onDeath()));
    this._offs.push(ctx.on(EV.RUN_START, () => this._onRunStart()));
    this._offs.push(ctx.on(EV.QUALITY_CHANGE, (p) => this._onQuality(p)));
  }

  /**
   * Gate every sound through one place: no context, no clock, no noise.
   * Returns the scheduling time, or -1 when the sound must be dropped.
   */
  _slot(id, extraDelay) {
    if (!this.ready || this.muted) return -1;
    const ac = this.ac;
    if (ac.state !== 'running') return -1;
    const t = ac.currentTime + LATENCY + (extraDelay || 0);
    if (t - this._last[id] < MIN_GAP[id]) return -1;
    this._last[id] = t;
    return t;
  }

  /** Fire a parameterless sound. Split out so the gate is never duplicated. */
  _play0(id, delay) {
    const t = this._slot(id, delay);
    if (t < 0) return false;
    switch (id) {
      case S_JUMP: this.sfx.jump(t); break;
      case S_SLIDE: this.sfx.slide(t); break;
      case S_IMPACT: this.sfx.impact(t); break;
      case S_FLOURISH: this.sfx.flourish(t); break;
      case S_START: this.sfx.start(t); break;
      default: return false;
    }
    return true;
  }

  _onStar() {
    // The ladder. Rises with every star in a run, falls back to the bottom on
    // a miss or a gap — a rising run of chimes is the single most satisfying
    // audio trick in this genre and it is worth exactly one integer.
    const now = this.ctx.time;
    if (now - this._lastStar > COMBO_GAP) this._combo = 0;
    this._lastStar = now;
    const step = this._combo;
    if (this._combo < LADDER_MAX) this._combo++;
    const t = this._slot(S_STAR);
    if (t < 0) return;
    this.sfx.star(t, step);
  }

  _onLand(p) {
    const t = this._slot(S_LAND);
    if (t < 0) return;
    this.sfx.land(t, !!(p && p.hard));
  }

  _onLane(p) {
    const t = this._slot(S_LANE);
    if (t < 0) return;
    const dir = p && p.to > p.from ? 1 : -1;
    this.sfx.lane(t, dir);
  }

  _onTurn(p) {
    const t = this._slot(S_TURN);
    if (t < 0) return;
    this.sfx.turn(t, p && p.dir < 0 ? -1 : 1);
  }

  _onDeath() {
    this._combo = 0;
    const t = this._slot(S_DEATH);
    if (t < 0) return;
    this.sfx.death(t);
    // Pull the bed down so the shatter owns the moment, then let it back up
    // under the results screen.
    this.bus.duck(t, 0.22, 1.1, 0.7);
  }

  _onRunStart() {
    this._combo = 0;
    this._lastStar = -99;
    this._turns = 0;
    this._stepPhase = 0;
    if (!this.ready) return;
    const now = this.ac.currentTime;
    this.bus.duck(now, 1, 0, 0.2);
    this.sfxPool.panic(now);
    this.music.reset(now);
  }

  _onQuality(p) {
    if (!this.ready || !p) return;
    const next = PRESETS[p.preset];
    if (!next) return;
    // The reverb tail and the pools are not rebuilt — reallocating an impulse
    // response mid-run would cost more than it saves. What can be given back
    // cheaply is the decorative layers.
    this._q.extras = next.extras;
    this._q.deathGrains = next.deathGrains;
    this._q.bellDensity = next.bellDensity;
  }

  // ---- per-step work ---------------------------------------------------

  /**
   * Footsteps and the clean-corner flourish. Both are derived from player
   * state rather than from events, because neither has an event to listen to.
   * Allocation-free; the only work on a normal step is two float compares.
   */
  fixedUpdate(dt) {
    if (!this.ready || !this.unlocked || this.muted) return;
    const play = this._play;
    if (!play) return;

    // A corner is only "clean" once it has actually been crossed alive, which
    // is a counter in play/, not an event.
    if (play.turnsMade !== this._turns) {
      this._turns = play.turnsMade;
      if (play.alive) this._play0(S_FLOURISH);
    }

    if (play.alive && play.state === STATE.RUN) {
      const T = this.ctx.config.tune;
      const s01 = (play.speed - T.startSpeed) / (T.maxSpeed - T.startSpeed);
      const cadence = 2.7 + (s01 < 0 ? 0 : s01 > 1 ? 1 : s01) * 1.9;
      this._stepPhase += dt * cadence;
      if (this._stepPhase >= 1) {
        this._stepPhase -= 1;
        if (this._stepPhase > 1) this._stepPhase = 0;  // never spiral
        this._foot ^= 1;
        const t = this._slot(S_FOOT);
        if (t >= 0) this.sfx.foot(t, this._foot);
      }
    } else {
      this._stepPhase = 0.6;   // land already part-way, so the next step is soon
    }
  }

  /**
   * Music scheduling. A "tale of two clocks" scheduler: the game's frame rate
   * decides how often we look, the audio clock decides when notes actually
   * happen, so the bed never jitters with frame time.
   */
  renderUpdate() {
    if (!this.ready || !this.unlocked || this.muted) return;
    if (this.ac.state !== 'running') return;
    const play = this._play;
    let s01 = 0;
    if (play) {
      const T = this.ctx.config.tune;
      s01 = (play.speed - T.startSpeed) / (T.maxSpeed - T.startSpeed);
      if (s01 < 0) s01 = 0; else if (s01 > 1) s01 = 1;
    }
    this.music.update(this.ac.currentTime, s01);
  }

  // ---- verification ----------------------------------------------------

  /**
   * Build the real audio graph inside an OfflineAudioContext, let the caller
   * schedule whatever it likes on it, and render.
   *
   * This is the whole verification strategy in one method. You cannot listen to
   * a headless browser, so "does this make a sound" has to be answered
   * numerically — and it is only a real answer if the thing being measured is
   * the same graph the player hears. Same Bus, same VoicePool, same Sfx, same
   * Music, same preset block; only the context differs.
   */
  async renderOffline(seconds, schedule, qOverride) {
    const OAC = window.OfflineAudioContext || window.webkitOfflineAudioContext;
    if (!OAC) return null;
    const q = qOverride || this._q || this._presetBlock(this.ctx.config.presetName);
    const SR = 44100;
    const ac = new OAC(2, Math.ceil(SR * seconds), SR);
    const bus = new Bus(ac, new Rng(0x53565541), q);
    const pool = new VoicePool(ac, bus.sfx, bus.verbIn, q.voices);
    const mpool = new VoicePool(ac, bus.music, bus.verbIn, q.musicVoices);
    const sfx = new Sfx(bus, pool, new Rng(0x53565542), q);
    const music = new Music(bus, mpool, new Rng(0x53565543), q);
    schedule(sfx, music, bus, pool);
    const buf = await ac.startRendering();
    return { buf, sfx, music, bus, pool, sampleRate: SR };
  }

  /**
   * Render every sound in the game, one per window, and measure it.
   * Ordered quietest-first so that each sound's onset can be checked against
   * the previous one's decaying tail. This is what the smoke test calls.
   */
  async selfTest() {
    const OAC = window.OfflineAudioContext || window.webkitOfflineAudioContext;
    if (!OAC) return { ok: false, reason: 'no OfflineAudioContext' };
    const q = this._q || this._presetBlock(this.ctx.config.presetName);
    const SR = 44100;
    const WIN = 1.25;
    const PRE = 0.08;    // window of tail measured just before each onset
    const ON = 0.24;     // window in which the new sound must actually appear
    const names = ['foot', 'lane', 'slide', 'jump', 'start', 'land', 'turn',
      'star0', 'flourish', 'star6', 'landHard', 'impact', 'death'];

    const r = await this.renderOffline((names.length + 1) * WIN, (sfx) => {
      let t = 0.05;
      sfx.foot(t, 1);              t += WIN;
      sfx.lane(t, 1);              t += WIN;
      sfx.slide(t);                t += WIN;
      sfx.jump(t);                 t += WIN;
      sfx.start(t);                t += WIN;
      sfx.land(t, false);          t += WIN;
      sfx.turn(t, -1);             t += WIN;
      sfx.star(t, 0);              t += WIN;
      sfx.flourish(t);             t += WIN;
      sfx.star(t, 6);              t += WIN;
      sfx.land(t, true);           t += WIN;
      sfx.impact(t);               t += WIN;
      sfx.death(t);                t += WIN;
    });
    const buf = r.buf;
    const sfx = r.sfx;
    const L = buf.getChannelData(0);
    const R = buf.numberOfChannels > 1 ? buf.getChannelData(1) : L;
    const sounds = [];
    let finite = true;
    let peakAll = 0;
    let weakest = Infinity;
    for (let i = 0; i < names.length; i++) {
      const start = 0.05 + i * WIN;
      const a = Math.floor(start * SR);
      const b = Math.min(L.length, a + Math.floor(WIN * SR));
      let peak = 0, sum = 0, width = 0;
      for (let s = a; s < b; s++) {
        const l = L[s], r = R[s];
        if (!Number.isFinite(l) || !Number.isFinite(r)) finite = false;
        const m = Math.abs(l) > Math.abs(r) ? Math.abs(l) : Math.abs(r);
        if (m > peak) peak = m;
        sum += l * l;
        width += Math.abs(l - r);
      }
      // "Did something new happen here" — the onset has to stand clear of the
      // previous sound's tail. Measuring absolute level alone would let a
      // silent sound pass simply because the reverb from the last one was
      // still ringing.
      let pre = 0;
      for (let s = Math.max(0, a - Math.floor(PRE * SR)); s < a; s++) {
        const m = Math.abs(L[s]);
        if (m > pre) pre = m;
      }
      let onset = 0;
      for (let s = a; s < Math.min(b, a + Math.floor(ON * SR)); s++) {
        const m = Math.abs(L[s]) > Math.abs(R[s]) ? Math.abs(L[s]) : Math.abs(R[s]);
        if (m > onset) onset = m;
      }
      const rise = onset / (pre + 0.002);
      if (rise < weakest) weakest = rise;
      if (peak > peakAll) peakAll = peak;
      sounds.push({
        name: names[i],
        peak: +peak.toFixed(4),
        rms: +Math.sqrt(sum / (b - a)).toFixed(4),
        stereo: +(width / (b - a)).toFixed(4),
        rise: +rise.toFixed(2),
      });
    }

    // Second pass for the bed alone, so the pad is measured without sfx on top.
    const mr = await this.renderOffline(8, (s2, music2) => {
      music2.start(0);
      for (let k = 0; k < 85; k++) music2.update(k * 0.1, 0.5);
    });
    const music = mr.music;
    const M = mr.buf.getChannelData(0);
    let mpeak = 0, msum = 0;
    for (let s = Math.floor(SR * 2); s < M.length; s++) {
      const v = Math.abs(M[s]);
      if (!Number.isFinite(v)) finite = false;
      if (v > mpeak) mpeak = v;
      msum += M[s] * M[s];
    }

    const silent = sounds.filter((s) => s.peak < 0.01 || s.rise < 1.5).map((s) => s.name);
    return {
      ok: finite && silent.length === 0 && mpeak > 0.005 && peakAll <= 1.0,
      weakestRise: +weakest.toFixed(2),
      preset: q === this._q ? this.ctx.config.presetName : 'default',
      sampleRate: SR,
      finite,
      silent,
      peakAll: +peakAll.toFixed(4),
      sounds,
      voicesStarted: sfx.voices,
      music: {
        peak: +mpeak.toFixed(4),
        rms: +Math.sqrt(msum / M.length).toFixed(4),
        notes: music.notes,
        chords: music.chords,
      },
      graph: {
        bus: r.bus.nodes,
        voices: r.pool.nodes,
        live: this.nodeCount,
        state: this.ac ? this.ac.state : 'none',
      },
    };
  }

  /** Compact state readout for tooling. */
  debug() {
    return {
      enabled: this.enabled,
      ready: this.ready,
      unlocked: this.unlocked,
      muted: this.muted,
      state: this.ac ? this.ac.state : 'none',
      combo: this._combo,
      nodes: this.nodeCount,
      voices: this.sfx ? this.sfx.voices : 0,
      musicNotes: this.music ? this.music.notes : 0,
      active: this.sfxPool && this.ac ? this.sfxPool.active(this.ac.currentTime) : 0,
    };
  }

  dispose() {
    for (let i = 0; i < this._offs.length; i++) this._offs[i]();
    this._offs.length = 0;
    for (let i = 0; i < this._domOffs.length; i++) this._domOffs[i]();
    this._domOffs.length = 0;
    if (this._suspendTimer) { clearTimeout(this._suspendTimer); this._suspendTimer = 0; }
    if (this.music) this.music.dispose();
    if (this.sfxPool) this.sfxPool.dispose();
    if (this.musicPool) this.musicPool.dispose();
    if (this.bus) this.bus.dispose();
    if (this.ac && typeof this.ac.close === 'function' && this.ac.state !== 'closed') {
      this.ac.close().catch(() => {});
    }
    this.ac = null;
    this.ready = false;
    this.enabled = false;
  }
}
