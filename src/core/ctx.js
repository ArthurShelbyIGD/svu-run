// The runtime context: module registry + event bus.
//
// Subsystems NEVER import each other. They reach each other at runtime through
// `ctx.get('fx')`. This keeps the dependency graph flat, lets any subsystem be
// rewritten in isolation, and means a missing subsystem degrades gracefully
// instead of breaking the build.
//
// The event bus is allocation-free on emit: no spread, no array copy, no
// closure creation in the hot path.

export class Ctx {
  constructor() {
    /** @type {Map<string, object>} */
    this.modules = new Map();
    /** @type {Map<string, Function[]>} */
    this._listeners = new Map();
    /** Populated by main.js during boot. */
    this.engine = null;
    this.scene = null;
    this.canvas = null;
    this.config = null;
    this.rng = null;
    /** Seconds since the run started. Advanced by the loop. */
    this.time = 0;
    /** Fixed simulation step in seconds. */
    this.dt = 1 / 60;
  }

  // ---- module registry -------------------------------------------------

  register(name, mod) {
    if (this.modules.has(name)) {
      throw new Error(`ctx: module "${name}" already registered`);
    }
    this.modules.set(name, mod);
    return mod;
  }

  /** Get a module. Throws if absent — catches wiring mistakes loudly. */
  get(name) {
    const m = this.modules.get(name);
    if (!m) throw new Error(`ctx: no module "${name}"`);
    return m;
  }

  /** Get a module, or null. Use when a subsystem is genuinely optional. */
  tryGet(name) {
    return this.modules.get(name) || null;
  }

  has(name) {
    return this.modules.has(name);
  }

  // ---- event bus -------------------------------------------------------

  /**
   * Subscribe. Returns an unsubscribe function.
   * Handlers receive a single payload object which is REUSED by the emitter —
   * read what you need synchronously, never retain a reference to it.
   */
  on(event, fn) {
    let list = this._listeners.get(event);
    if (!list) {
      list = [];
      this._listeners.set(event, list);
    }
    list.push(fn);
    return () => this.off(event, fn);
  }

  off(event, fn) {
    const list = this._listeners.get(event);
    if (!list) return;
    const i = list.indexOf(fn);
    if (i >= 0) list.splice(i, 1);
  }

  /** Emit. Allocation-free. Payload objects should be pooled by the emitter. */
  emit(event, payload) {
    const list = this._listeners.get(event);
    if (!list) return;
    for (let i = 0; i < list.length; i++) {
      list[i](payload);
    }
  }

  // ---- lifecycle -------------------------------------------------------

  /** Call `method` on every registered module that implements it, in order. */
  forEachModule(method, a, b) {
    for (const mod of this.modules.values()) {
      if (typeof mod[method] === 'function') mod[method](a, b);
    }
  }

  dispose() {
    for (const mod of this.modules.values()) {
      if (typeof mod.dispose === 'function') mod.dispose();
    }
    this.modules.clear();
    this._listeners.clear();
  }
}

/**
 * Canonical event vocabulary. Subsystems emit and listen using these names
 * only — adding a new cross-subsystem event means adding it here first, so
 * the vocabulary stays discoverable and typo-proof.
 */
export const EV = {
  // run lifecycle
  RUN_START: 'run:start',
  RUN_END: 'run:end',
  RUN_PAUSE: 'run:pause',
  RUN_RESUME: 'run:resume',

  // player
  PLAYER_LANE: 'player:lane',       // { from, to }
  PLAYER_JUMP: 'player:jump',       // {}
  PLAYER_LAND: 'player:land',       // { hard }
  PLAYER_SLIDE: 'player:slide',     // { active }
  PLAYER_TURN: 'player:turn',       // { dir: -1 | 1 }
  PLAYER_STUMBLE: 'player:stumble', // { severity }
  PLAYER_DEATH: 'player:death',     // { cause }
  PLAYER_FOOTSTEP: 'player:footstep', // { foot }

  // pickups & powerups
  PICKUP_STAR: 'pickup:star',       // { pos, value }
  POWERUP_START: 'powerup:start',   // { kind, duration }
  POWERUP_END: 'powerup:end',       // { kind }

  // world
  CHUNK_SPAWN: 'chunk:spawn',       // { chunk }
  CHUNK_RECYCLE: 'chunk:recycle',   // { chunk }
  OBSTACLE_HIT: 'obstacle:hit',     // { kind, pos }

  // presentation
  SCORE_CHANGE: 'score:change',     // { score, delta }
  QUALITY_CHANGE: 'quality:change', // { preset }
  RESIZE: 'resize',                 // { width, height }
};
