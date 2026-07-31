// audio/ — placeholder. Owned exclusively by the audio subsystem agent.
//
// Registered from Sprint 0 so the module graph, the event wiring and the
// lifecycle are all proven before any real work lands here. Implementing this
// is a later sprint; see ARCHITECTURE.md for the contract it must satisfy.

export default class Stub {
  constructor(ctx) { this.ctx = ctx; this.name = 'audio'; }
  init() {}
  dispose() {}
}
