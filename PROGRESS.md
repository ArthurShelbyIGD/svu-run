# SVU RUN — Progress & Handoff

**This file is the resume point.** A fresh session with no memory of any
previous conversation should be able to read `PLAN.md`, `ARCHITECTURE.md` and
this file, and carry straight on. Keep it current — it is what makes a build
spread across many token windows survivable.

---

## Current state

**Sprint 1 — COMPLETE.** It is a Temple Run-shaped game: obstacles, collision,
collectibles, death, restart, and 90 degree junction turns.

Last verified: build passes, 31/31 smoke checks pass, screenshot poses capture
cleanly.

### What exists

- Single-file build: `docs/svu-run.html` (Pages serves /docs), ~2.4 MB, fully self-contained.
  Babylon is tree-shaken and inlined — no CDN, works opened straight off disk.
- Core: fixed-timestep loop, module registry, event bus, seeded RNG, three
  quality presets with a load-time downgrade benchmark.
- `mat/`: procedurally generated studio environment cubemap + eight base
  materials (six polished metals, two enamels).
- `play/`: keyboard and touch input normalised to four intents, lane/jump/slide
  state machine with input buffering and coyote time, smoothed chase camera
  with speed-based FOV.
- `char/`: proportion blockout of the character — oversized head, bear-eared
  hood, mitten hands, boot feet, wing, ruby antenna. Procedural run/jump/slide
  animation driven by a phase value.
- `track/`: pooled, recycling tile strip with rails and thin-instanced columns.
- `world/`: key + ambient light, shadow generator, player-following shadow
  frustum.
- `ui/`: DOM HUD with score and star counter.
- `track/path.js`: the path model. Path space (distance travelled, lateral
  offset) is now separate from world space (x, y, z). All gameplay — collision,
  generation, scoring — stayed in path space and needed no changes for corners;
  only rendering converts. Headings are restricted to the four cardinal
  directions so the conversion is exact and corners are always square.
- Junctions: generated on chunk boundaries, signposted by a backstop wall, a
  large arrow on that wall, and floor chevrons on the approach. Near a corner a
  left/right input means TURN, not lane change. Wrong way or no turn ends the
  run.
- `track/chunks.js`: 14 hand-authored chunk templates spanning difficulty 0 to
  0.9, assembled by a difficulty-weighted grammar that never repeats a template
  twice running. `validateTemplates()` proves every template survivable at boot
  and throws on an unwinnable one, so a bad pattern cannot ship.
- `track/`: pooled obstacles (hurdle / overhead beam / full block) and
  collectible stars, generated ahead of the player and recycled behind.
- `coll/`: swept AABB collision. Swept rather than point-tested because at top
  speed one 1/60 step covers more ground than an obstacle is deep — a point
  test would let the player tunnel straight through at high speed.
- `ui/`: results screen with score, distance, stars and session best; restart
  by button, tap, or space, with a 400ms guard so the input that killed you
  cannot instantly restart the run.
- `fx/`: pooled particle system on thin instances — one draw call for every
  particle in the game, zero runtime allocation, pool size driven by the
  quality preset. Emits on star pickup, landing, death and clean corners, plus
  speed streaks above 'low'.
- `world/`: gradient sky dome and linear fog, so the track dissolves into the
  distance instead of ending at the clip plane.
- `audio/`: registered stub — module graph proven, no implementation.
- `tools/`: `smoke.mjs` (26 checks), `capture.mjs` (10 deterministic poses),
  `harness.mjs` (shared browser plumbing).

### Key finding from Sprint 0

**The environment cubemap is the whole look.** The first blockout render had
polished metal reading as grey plastic. The cause was a bright, low-contrast
environment: a mirror-like surface can only look like metal if there is strong
contrast between bright sources and dark surroundings. Darkening the dome and
tightening the softboxes fixed it immediately and completely.

Consequence for later sprints: **spend effort on the environment before
spending it on materials.** Material parameters are close to irrelevant next to
what they are reflecting.

**Fifth finding: a continuous centre line does not mean a continuous path.**
The second playtest reported "bouncing around the corner". It was real, and it
was geometric, not a camera artefact: the centre line of the path is continuous
across a junction, but positions OFF it are not, because the two segments'
lateral axes are perpendicular. A player holding a 2.4m lane offset teleported
3.4m sideways the instant they crossed a corner.

No state-based test could see this — every coordinate involved was finite,
correct and on the path. The fix blends the two segment frames across a 3.6m
window either side of the junction, which makes both position and heading
continuous and incidentally rounds the corner. Gameplay is untouched: this is
purely the path-to-world conversion, and collision never leaves path space.
There is now a regression check that sweeps the outer lane across every corner
and measures the largest single-step jump in world space.

**Fourth finding, and the most important one so far: the capture harness lies
about reflective materials.**
The track floor shipped as polished rhodium (roughness 0.09). Every captured
screenshot showed a plausible dark surface. On real hardware it reflected the
bright studio horizon at a grazing angle and rendered almost pure white against
a cream backdrop — the track was invisible and the player appeared to run
through empty space. Nobody would have found this without opening the build on
a real GPU.

`ARCHITECTURE.md` section 7 previously claimed captures were visually faithful.
That claim is now corrected: captures are reliable for geometry, silhouette,
layout and gross colour, and *suspect* for anything dominated by reflection.
The track floor is now a satin finish with its own value rather than borrowing
the sky's, plus inlaid gold lane dividers — which also give the three lanes a
readable structure and a strong sense of speed.

**Third finding: three of the corner bugs were invisible to tests.**
The turn logic passed every functional check while being unplayable, because
the tests could only see state, not the screen. Screenshots caught: corners
with no visual indication of which way to go; floor arrows foreshortened to
nothing by a low chase camera; and captures framed from 140m behind the player
because fast-forwarding the simulation left the smoothed camera stranded. The
lesson is not "write more tests" — it is that a functional test and a rendered
frame catch disjoint classes of defect, and a runner needs both.

**Second finding: the profile capture pose earns its place.** The first
character blockout had a torso nearly as tall as the whole character, which was
invisible from the default chase camera and obvious the moment a side-on shot
existed. Any pose the critics cannot see, they cannot grade. Add poses before
adding polish.

---

## Known issues / deliberate debt

| # | Issue | Where | Planned |
|---|---|---|---|
| 1 | Sky gradient is subtle at eye level; the scene still lacks a strong sense of place | `world/` | Sprint 4 |
| 2 | Portrait framing puts the character quite large in frame; camera may need a per-aspect distance | `play/`, `core/config.js` | Sprint 2 |
| 3 | Wing reads as a detached floating slab | `char/` | Sprint 3 |
| 4 | Shadows not visibly landing; generator wired but unverified | `world/` | Sprint 1 |
| 5 | Env cubemap mips are not properly convolved, so rough materials are approximate. Fine while everything is polished | `mat/` | Sprint 2 if needed |
| 6 | Wall arrow is small and low-contrast against the dark chrome wall | `track/`, `mat/` | Sprint 2 |
| 11 | Turn frequency (42% of chunks) is still an untuned guess | `track/` | needs a human playing |
| 9 | No powerups (wing glide, ruby magnet, shield) | `play/`, `fx/` | Sprint 2 |
| 10 | No pursuer behind the player — no tension from behind | `world/`, `ai` | Sprint 4 |
| 7 | No audio at all — the largest remaining gap in how the game feels | `audio/` | next |
| 8 | Camera framing is a first guess, not tuned with a human in the loop | `core/config.js` | Sprint 1 |

---

## Next up

**Sprint 2 — materials, lighting, powerups, first critic loop.**

Before that, three things that need a human rather than a test:

1. **Camera tuning** — never looked at by a person while playing.
2. **Difficulty ramp** — `difficultyAt` is a guess, never played to failure.
3. **Turn frequency and turn window** — currently 42% of chunks and an
   11m-plus-speed window. Both are guesses.

**Sprint 2 proper:** material library and studio lighting proper, powerups, and
the first critic loop against the reference art.

Sprints 0-3 stay solo — these systems are tightly coupled and the
Claude-of-Duty run found parallel agents actively damage coupled systems.
Fan-out starts at Sprint 4.

---

## Working rules for whoever picks this up

- `npm run check` before every commit. It is the gate.
- Commit at every meaningful checkpoint, not at the end of a session. The
  container is ephemeral; the repo is the only thing that survives.
- Update this file in the same commit as the work it describes.
- One agent, one directory. See `ARCHITECTURE.md` §1.
- If a token window ends mid-sprint, the next session resumes from here. Leave
  it in a state where that is actually true.

---

## Session log

| Date | Window | Work |
|---|---|---|
| 2026-07-31 | 1 | Sprint 0: repo, scaffold, core engine, materials, blockout character, track, harness, docs. Build + smoke + capture all green. |
| 2026-07-31 | 1 | Sprint 1 (partial): chunk grammar with solvability validator, three obstacle types, swept collision, collectible stars, death + results + restart. Smoke test 16 -> 26 checks. Turns still outstanding. |
| 2026-07-31 | 1 | Added gradient sky + fog, and a pooled thin-instance particle system (pickup, landing, death, corner, speed streaks). 35 checks. |
| 2026-07-31 | 1 | Fixed corner discontinuity (3.4m sideways teleport in the outer lane), widened the turn reaction window, added late-turn grace. 32 checks. |
| 2026-07-31 | 1 | Fixed invisible track (mirror floor blowing out on real hardware), added lane dividers, softened the opening difficulty ramp and start speed after first human playtest. |
| 2026-07-31 | 1 | Sprint 1 complete: path-space model, 90 degree junction turns with signage, context-sensitive turn input. Smoke test 26 -> 31 checks. Three bugs found by screenshots that no test would have caught. |
