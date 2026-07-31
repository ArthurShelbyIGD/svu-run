# SVU RUN — Build Plan

A third-person endless runner in Babylon.js, shipping as a single self-contained HTML file
(`svu-run.html`), playable on laptop and mobile. Character and art direction derived from the
reference NFT:
a chibi figure rendered as fine jewellery — pavé diamonds, polished rose gold, rhodium chrome,
a dark chrome bat wing, a ruby pavé antenna, floating gold stars.

Everything is generated procedurally in code. No texture files, no model files, no audio files.

---

## 1. The art direction: "everything is jewellery"

The reference image's quality does not come from geometry detail. It comes from **materials and
lighting** — polished metal, faceted stones, and a high-key studio setup on a warm cream backdrop.
That is very good news, because materials and lighting are exactly what a real-time PBR engine
does well, and Babylon is strong here.

The decision that makes this whole project tractable: **the world is jewellery too.** Not a
jewelled character running through a normal temple — a jewel-box world. Gold columns, pavé
archways, ruby braziers, a polished rhodium floor. This is cohesive, it is striking, and
critically it means the entire game draws from one tiny material family:

| Material | Use |
|---|---|
| Pavé diamond (white stones, white-gold setting) | Hero material — character body, key architecture |
| Polished rose gold | Faces, skin, warm accents |
| Polished white gold / rhodium | Hands, boots, hardware, floor |
| Dark chrome / hematite | The wing, shadow accents |
| Ruby pavé | Antenna orb, hazards, danger signalling |
| Yellow gold | Collectible stars, trim |
| Soft enamel | Matte colour blocks, backdrop |

Seven materials for the entire game. Small material libraries are what make procedural
generation and mobile performance achievable at the same time.

**Lighting.** A procedurally generated studio environment: gradient dome, three bright softbox
panels, one warm bounce card, baked to a cubemap once at load. Used for image-based lighting on
everything. This single asset *is* the look — it is what makes metal read as metal.

**Post-processing.** ACES-style tonemap, bloom (non-negotiable — it is what turns gem highlights
into sparkle), warm cream colour grade, gentle vignette. On mobile: bloom at half resolution,
everything else on or cheap.

---

## 2. What actually has to be recognisable — and what doesn't

**Decision (owner, 31 Jul): the pavé diamonds are not a requirement.** The collection already
comes in many trait variations, so a variant that reads as "one of these, in a new colourway" is
completely legitimate. What must survive is the **chibi silhouette and character shape** — the
oversized head, the bear-eared hood, the mitten hands, the boot feet, the wing, the antenna,
the wide-eyed face. That is what people recognise. **Performance beats diamonds.**

This removes the single biggest technical risk from the project. The revised material approach:

- **Polished metal and enamel** is the base look — rose gold face, rhodium chrome hands and
  boots, dark chrome wing, gold stars. All cheap: one environment cubemap plus low roughness.
- **A pavé-style surface is a stretch goal, not a dependency.** A tileable procedural normal map
  plus a view-dependent glint layer, tried in Sprint 2 as a *time-boxed* experiment. If it looks
  good and costs nothing meaningful, it ships. If it costs frames on mobile, it is dropped
  without argument and nothing else in the project is affected.
- Glint/sparkle can also be sold much more cheaply through bloom, a subtle animated specular
  sweep, and particle sparkles from `fx/` — none of which touch the shader budget.

The quality bar for critics therefore becomes **silhouette, proportion, material readability and
lighting**, not stone-for-stone fidelity.

---

## 3. Gameplay

Temple Run structure rather than Subway Surfers: three lanes **plus** 90° junction turns. Turns
are harder and they are what make it read as Temple Run rather than a subway clone.

- **Controls.** Mobile: swipe left/right to change lane, swipe up to jump, swipe down to slide,
  swipe at a junction to turn. Laptop: arrow keys / WASD. Both paths first-class from day one.
- **Collectibles: the gold stars.** They are already in the artwork. Free, cohesive, and they
  hand us the coin design without inventing anything.
- **Power-ups, all drawn from the character.** The bat wing → a glide. The ruby antenna → a
  collectible magnet. A pavé shield. A score multiplier.
- **Pursuit.** Something chasing from behind, as Temple Run does — it is what creates the tension.
- **Track.** Chunk-based procedural generation: a library of chunk templates authored in code,
  assembled by a difficulty-weighted grammar, pooled and recycled. The world builds itself, which
  is exactly where a code-only approach wins.
- **Audio.** Web Audio synthesis. A jewellery theme points at bell, glass and celesta timbres —
  which happen to be among the easiest things to synthesise convincingly. Lucky break.

---

## 4. Technical constraints

- Babylon.js from CDN; everything else inlined into one `index.html` by an esbuild step.
- WebGL2. Thin instances for all repeated props.
- **No physics engine.** A runner needs swept-box checks against a lane grid, nothing more.
  Havok would be enormous overkill and enormous weight.
- Fixed timestep simulation, decoupled from render.
- Zero per-frame allocation. Everything pooled and pre-allocated in `init()`.
- Quality presets auto-selected by a short benchmark at load: Low / Medium / High.
- Target: locked 60fps on a mid-range phone. This constrains everything and is designed in from
  day one, never retrofitted.

---

## 5. Subsystems and directory ownership

Strict ownership — an agent never edits outside its directory. Cross-subsystem access is at
runtime via `ctx.get('fx')`, never by import, so subsystems stay decoupled.

| Directory | Owns |
|---|---|
| `core/` *(lead only)* | Bootstrap, game loop, module registry, event bus, seeded RNG, config |
| `mat/` | Material library, pavé shader, environment cubemap generation |
| `char/` | Character mesh generation, rig, procedural animation |
| `track/` | Chunk templates, generation grammar, pooling |
| `world/` | Environment props, decoration, set pieces |
| `play/` | Input, player state machine, camera |
| `coll/` | Collision, lane logic |
| `fx/` | Particles, sparkles, trails, impacts |
| `audio/` | Web Audio synthesis and mixing |
| `ui/` | HUD, menus, score, results screen |
| `tools/` *(lead only)* | Screenshot capture, performance profiler, smoke test |

**Hard rules, borrowed from the Claude-of-Duty architecture because they earned their place:**
no per-frame allocation; deterministic RNG via `ctx.rng`; dispose all GPU resources; the build
must pass and the capture tool must work before any sprint is called done.

---

## 6. Sprint plan

Every sprint ends the same way: a committed, playable build, a handoff note, and screenshots.
So a mid-sprint window cutoff is always recoverable — "continue" resumes from disk, not from
conversation.

| # | Sprint | Mode | Est. windows |
|---|---|---|---|
| 0 | Repo, screenshot + perf harness, architecture contract, grey-box runnable | Solo | <1 |
| 1 | Core loop: lanes, turns, jump, slide, collision, chunk generation — grey-box | Solo | 2–3 |
| 2 | Material library + studio lighting (pavé as a time-boxed stretch goal). First critic loop | Solo, then critics | 2 |
| 3 | Character: mesh, rig, run cycle, jump/slide/stumble/death — **silhouette is the bar** | Solo, then critics | 3–4 |
| 4 | Environment art direction pass — the jewel-box world | **Escalate to fan-out** | 3–4 |
| 5 | Full gauntlet: fx, audio, ui, set pieces, all parallel with critics | Full fan-out | 4–6 |
| 6 | Mobile performance pass, real-device testing, quality presets | Mixed | 2–3 |
| 7 | Polish gauntlet — loop until returns flatten | Full fan-out | open-ended |

**Honest estimate: 14–22 five-hour windows to a genuinely good result** (trimmed now that the
pavé shader is no longer a dependency). Sprints 0–3 are
deliberately solo because those systems are tightly coupled, and the Claude-of-Duty run found
that parallel agents on coupled systems actively make things worse. Fan-out starts at Sprint 4,
once the subsystems are isolated and there is a screenshot harness for critics to grade against.

---

## 7. The critic loop

The bar is the reference NFT image itself, which is the strongest kind of bar — concrete,
inspectable, and impossible to rationalise away. Critics grade on **silhouette, proportion,
material readability, lighting and charm** — explicitly *not* on stone-for-stone reproduction of
the pavé, which is out of scope by owner decision.

Each round: a builder agent works on one subsystem. A **separate critic agent with fresh
context** — never having seen the builder's reasoning — is shown a captured screenshot beside
the reference and asked which is better and why. When the reference wins, the critic names the
single largest gap and it goes back. Repeat.

Your eyes matter at every checkpoint. Critics plateau and start hallucinating improvements; a
human looking at the build is the correction for that.
