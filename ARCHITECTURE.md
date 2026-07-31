# SVU RUN — Architecture

This is the contract every agent works against. Read it before touching code.
If a change would violate something here, the right move is to raise it, not to
work around it.

---

## 1. Directory ownership

An agent owns **one** directory and **never edits files outside it**. This is
the single most important rule in the project. It is what makes parallel work
safe later, and what makes any subsystem rewritable in isolation.

| Directory | Owns | Must not touch |
|---|---|---|
| `src/core/` | Bootstrap, loop, registry, event bus, RNG, config, Babylon imports | — *lead only* |
| `src/mat/` | Every material and texture; the studio environment | Meshes, gameplay |
| `src/char/` | Player character mesh, hierarchy, animation | Player state, materials |
| `src/track/` | Track surface, tiles, chunk generation, obstacle placement | Player state, decoration |
| `src/world/` | Lights, shadows, decorative props, set pieces | Track surface, materials |
| `src/play/` | Input, player state machine, camera | Character visuals, collision shapes |
| `src/coll/` | Collision detection and response | Player state fields (reads only) |
| `src/fx/` | Particles, trails, impacts, screen effects | Anything else |
| `src/audio/` | Web Audio synthesis and mixing | Anything else |
| `src/ui/` | HUD, menus, results — all DOM | The canvas, the scene |
| `tools/` | Capture, perf, smoke test | — *lead only* |
| `build.mjs`, `shell/` | Build and page shell | — *lead only* |

`src/main.js` is lead-owned. Adding a subsystem means adding one line to the
`MODULES` array there — ask the lead, do not edit it yourself.

---

## 2. How subsystems talk

**Never import another subsystem.** Reach it at runtime:

```js
const fx = this.ctx.get('fx');        // throws if missing — catches wiring bugs
const fx = this.ctx.tryGet('fx');     // null if missing — for optional deps
```

The one permitted exception is importing *constants* (`STATE`, `INTENT`) from
another subsystem's module, because those are compile-time values, not state.

**Events** go through the bus, using names from the `EV` table in
`src/core/ctx.js`. Adding a cross-subsystem event means adding it to `EV`
first, so the vocabulary stays discoverable.

```js
this.ctx.on(EV.PLAYER_JUMP, (p) => { ... });   // returns an unsubscribe fn
this.ctx.emit(EV.PLAYER_LAND, this._pLand);    // payload is POOLED — see below
```

---

## 3. Module lifecycle

A subsystem is a class with any of these methods. All are optional.

```js
export default class Thing {
  constructor(ctx) {}          // wire references only — no GPU work here
  init() {}                    // create meshes, materials, listeners
  fixedUpdate(dt) {}           // simulation. dt is ALWAYS 1/60. Deterministic.
  renderUpdate(dtReal, alpha) {} // presentation only. Never mutate game state.
  dispose() {}                 // release everything
}
```

The split between `fixedUpdate` and `renderUpdate` is not cosmetic:

- `fixedUpdate` is the **simulation**. It runs at a fixed 60Hz regardless of
  display refresh rate, may run several times per frame, and must be
  deterministic — same inputs, same seed, same result, always.
- `renderUpdate` is **presentation**. Camera smoothing, animation, HUD. It runs
  once per rendered frame with the real frame delta. It must never change
  anything the simulation reads, or determinism dies.

---

## 4. Hard rules

These are not style preferences. Breaking them causes real, measurable defects.

1. **Allocate nothing per frame.** No `new`, no object literals, no array
   methods that allocate (`map`, `filter`, `slice`, spread) inside
   `fixedUpdate` or `renderUpdate`. Pre-allocate in `init()` and reuse. GC
   pauses are the most common cause of frame-time spikes on mobile.
2. **Pool event payloads.** Keep one payload object per event type on the
   emitter and mutate it. Listeners must read what they need synchronously and
   never retain the reference.
3. **All randomness comes from `ctx.rng`.** Never call `Math.random()`. Runs
   must be reproducible or the capture harness is worthless.
4. **Pool meshes; never create or destroy during play.** Recycle. The smoke
   test asserts that total mesh count stays flat over time.
5. **Dispose everything you create** in `dispose()` — geometries, materials,
   textures, render targets, DOM nodes, event listeners.
6. **Respect the quality preset.** `ctx.config.q` is a contract. If `q.shadows`
   is false, create no shadow map. If `q.maxParticles` is 120, never exceed it.
7. **Babylon is imported only through `src/core/bjs.js`.** Deep import paths
   are how tree-shaking stays effective; getting them right once beats getting
   them wrong in eleven places.
8. **`npm run check` must pass** (build + smoke test) before any sprint is
   called done. No exceptions.

---

## 5. Shared types

**Player state** (`src/play/index.js`) — `STATE.RUN | AIR | SLIDE | STUMBLE | DEAD`.
Read it, never write it from outside `play/`.

**Lane space.** Lanes are integers `0 .. laneCount-1`. World X for a lane is
`(lane - (laneCount-1)/2) * laneWidth`. Nothing should hardcode lane positions.

**Track space.** `z` is metres travelled and only ever increases. The world
scrolls by recycling geometry backwards, not by moving the player back to
origin, so `z` is safe to use as an absolute distance for scoring and
difficulty curves.

**Surface tags** (for future audio, decals and impacts):
`gold | chrome | gem | enamel | stone | fabric`.

---

## 6. Quality presets

Three presets in `src/core/config.js`: `low`, `medium`, `high`. `low` is the
binding constraint on the entire project — **it must hold 60fps on a
mid-range phone**. A load-time benchmark steps quality *down* if early frames
are slow; it never steps up, because oscillating between presets is worse than
sitting one notch low.

Force a preset with `?q=low` in the URL. Add `?debug` for the frame-time
readout, `?seed=N` for a specific run.

---

## 7. Tooling

```
npm run build     bundle -> dist/svu-run.html   (self-contained, no CDN)
npm run smoke     headless functional test, exit 1 on failure
npm run shots     deterministic screenshots -> shots/
npm run check     build + smoke, the gate before committing
```

**Read this before trusting anything the harness produces.** Headless Chromium
here renders through SwiftShader, in software.

- **Frame timings are not real.** They are a relative signal between builds
  only. Real performance verdicts come from a real device.
- **Nor is visual output fully faithful** — a claim this document previously
  made and which turned out to be wrong. Image-based lighting is where it
  breaks: the track floor shipped as polished metal (roughness 0.09) and looked
  like a correct dark surface in every captured screenshot, while on real
  hardware it reflected the bright studio horizon and rendered almost pure
  white, making the track invisible against the cream backdrop. The player
  appeared to be running through empty space.

  Treat captures as reliable for geometry, silhouette, layout, composition and
  gross colour. Treat them as *suspect* for anything whose appearance is
  dominated by reflection: mirror-finish metal, glass, water, strong IBL.
  Those need checking on a real GPU before they are called done.

Waits in the tooling are frame-based or game-time-based, never wall-clock,
because software rendering is 10–20x slower than a GPU and wall-clock waits
would be flaky by construction. `loop.advance(seconds)` steps the simulation
without rendering — that is how captures are posed instantly and identically
every time.

---

## 8. The quality bar

The reference is the NFT artwork (`docs/reference.jpeg`). Critic agents grade
on **silhouette, proportion, material readability, lighting and charm**.

Explicitly **out of scope**, by owner decision: reproducing the pavé diamond
surface stone-for-stone. The collection comes in many trait variations, so a
new colourway is legitimate. What must be recognisable is the character shape —
oversized head, bear-eared hood, mitten hands, boot feet, wing, antenna.
**Performance beats diamonds.**
