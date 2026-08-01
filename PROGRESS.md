# SVU RUN — Progress & Handoff

**This file is the resume point.** A fresh session with no memory of any
previous conversation should be able to read `PLAN.md`, `ARCHITECTURE.md` and
this file, and carry straight on. Keep it current — it is what makes a build
spread across many token windows survivable.

---

## Current state

**Sprint 3 — CHARACTER REBUILT.** The runner now reads as the reference NFT:
hooded onesie with a framed face opening, warm rose-gold face with oversized
eyes and catchlights, bear ears with inner colour, a scalloped bat wing with
finger ribs, and a segmented ruby antenna that whips as it runs.

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
- `char/`: the character proper, built entirely from primitives plus one
  hand-authored wing mesh. Squash-and-stretch, arm follow-through, head
  counter-rotation against the lean, wing flutter that flares in the air, and a
  four-segment antenna where each segment lags the one before it.
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
- `world/`: jewel-box art direction — a vast dark interior with overhead gold
  light shafts and a gem glow. Five zone palettes (Vault, Ruby, Sapphire,
  Emerald, Gilt) crossfade with distance, so the world visibly evolves during a
  run and progress has a face beyond the score counter. Textures are baked once
  at init; fog, environment intensity and bloom all interpolate, so a zone
  change is a slow reveal rather than a cut.
- `world/sky.js`: the backdrop is an EQUIRECTANGULAR PANORAMA on a dome with
  `infiniteDistance`, not a screen-space Layer. The dome follows the camera's
  position but not its rotation, so it can never be clipped by the far plane
  and turning a corner swings the whole room around the player. Two domes
  crossfade zones. The panorama is painted in `zones.js` as a real interior:
  ribbed vault, blind triforium, glowing clerestory, entablature, great arcade,
  hall floor with gem pools, plus raked light shafts and haze.
- `world/props.js` + `world/geo.js`: procedural architecture flanking the
  track. Fluted column shafts with entasis, moulded plinths and bases, carved
  capitals with volutes, a transverse vault every 24m, a profiled cornice with
  a dentil course and a parapet, a low ruined outer aisle, distant pylons,
  hanging faceted lanterns, a 62m paved hall floor with gold inlay, and wayside
  plinths carrying star finials among fallen masonry. All of it is a handful of
  merged prototypes drawn as thin instances — about a dozen draw calls and
  ~50k triangles on the low preset — placed with `path.toWorldExact` and
  recycled behind the player like everything else.
- `audio/`: registered stub — module graph proven, no implementation.
- `tools/`: `smoke.mjs` (26 checks), `capture.mjs` (10 deterministic poses),
  `harness.mjs` (shared browser plumbing).

### Findings from the world sprint

**Seventh finding: three of the sky's defects were arithmetic, and all three
were invisible until a frame was rendered.**

1. Babylon's standard shader ADDS `emissiveColor` to the emissive texture and
   then multiplies by the diffuse texture. A panorama in the emissive slot with
   a white tint therefore renders as solid white. The image goes in the diffuse
   slot and the tint in `emissiveColor`.
2. On a sphere, v = 0.5 is the horizon. The first panorama put its bright
   horizon band at v = 0.78 — fifty degrees underground. Every scrap of value
   structure was painted where the floor covers it.
3. The chase camera pitches DOWN about fourteen degrees, so the only sky ever
   on screen runs from the horizon to roughly thirteen degrees above it. A
   clerestory painted higher than that is a clerestory nobody will ever see.

**Eighth finding: Babylon is left-handed, and hand-written index buffers are
where that bites.** The fluted column shaft was wound by the right-handed
cross-product rule, so every face was culled. The shaft is sized to swallow the
track's plain cylinder, so the symptom was not "a hole" — it was a bare pink
tube standing inside one column in three, which looks like a material bug and
is not one.

**Ninth finding: two modules agreeing about geometry is not the same as two
modules agreeing about when to hide it.** `track/` suppresses its columns
within 16m of a junction; `world/` suppressed a whole 24m bay within 13m of
one. The windows do not match, so twenty metres before every corner the track's
cylinder stood alone with no fluted shaft around it. Columns are now placed one
at a time against the same rule.

**Tenth finding: area without incident is what reads as "Minecraft".** The
cornice started as one 1.15 x 24m box. In the wide shot its underside was a
single unbroken white plane across a third of the frame. Splitting it into a
bed mould, corona, fillet, cyma and dentil course costs about 36 triangles and
completely changes what the surface is read as. The same applied to the hall
floor, which needed inlay and cross-bands before it stopped looking like a car
park.

### Key finding from Sprint 0

**The environment cubemap is the whole look.** The first blockout render had
polished metal reading as grey plastic. The cause was a bright, low-contrast
environment: a mirror-like surface can only look like metal if there is strong
contrast between bright sources and dark surroundings. Darkening the dome and
tightening the softboxes fixed it immediately and completely.

Consequence for later sprints: **spend effort on the environment before
spending it on materials.** Material parameters are close to irrelevant next to
what they are reflecting.

**Sixth finding: fixing the object does not fix the observer.**
After the corner discontinuity was fixed, the playtester still reported
"bouncing off the barrier". The character's motion was correct by then — the
camera's was not. It was being smoothed by lerping its WORLD position toward a
target world position, and a straight line between two points on a right-angled
path cuts across the inside of the bend, taking the camera through the barrier.

The camera is now smoothed in PATH space — distance along the path and lateral
offset are smoothed independently, then converted once. It is therefore always
exactly on the path and physically cannot cut a corner. There is a regression
check measuring the largest per-frame camera movement through corners.

Related: the sky sphere was a mistake twice over. Its radius (450m) exceeded
the camera far plane (320m) so it was clipped into a visible bubble with the
clear colour showing through outside it, and a UV sphere bands along its seams
at any usable segment count. It is now a background Layer — one screen-space
quad that cannot be clipped, cannot band, and costs a single draw.

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
| 14 | Sky is one painting per zone. The clerestory is the only band the chase camera can see, so the vault and the lower hall are mostly wasted paint | `world/` | polish |
| 15 | Architecture has one bay design. Variation comes from the wayside accents only; a second and third bay variant would kill the last of the repetition | `world/` | next |
| 16 | `world/` creates three of its own materials (sky dome, lantern gem, light shaft) because the `mat/` name contract has no entry for an unlit backdrop or an additive quad. Worth adding names for these | `mat/`, `world/` | raise |
| 17 | The track's plain rose-gold cylinders are still drawn, hidden inside the fluted shafts. Harmless overdraw, but `track/` should just stop drawing them | `track/` | raise |
| 12 | Gilt zone has the lowest track/background contrast of the five — watch it on a phone in daylight | `world/zones.js` | needs a device |
| 2 | Portrait framing puts the character quite large in frame; camera may need a per-aspect distance | `play/`, `core/config.js` | Sprint 2 |
| 3 | Fringe under the hood rim still reads weakly; face/hood separation could go further | `char/` | polish |
| 13 | No pavé surface treatment yet — the stretch goal from PLAN.md section 2 | `mat/` | optional |
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
| 2026-07-31 | 2 | Sprint 3: character rebuilt to resemble the NFT. Face/hood separation, eyes with catchlights, bat wing, antenna, better animation. |
| 2026-07-31 | 2 | Jewel-box world shipped with five progressive zones. Art direction chosen by comparing three built mockups rather than describing them. |
| 2026-07-31 | 1 | Camera moved to path-space smoothing (fixes "bouncing off the barrier"); sky sphere replaced with a background layer (fixes the clipped bubble). 36 checks. |
| 2026-07-31 | 1 | Added gradient sky + fog, and a pooled thin-instance particle system (pickup, landing, death, corner, speed streaks). 35 checks. |
| 2026-07-31 | 1 | Fixed corner discontinuity (3.4m sideways teleport in the outer lane), widened the turn reaction window, added late-turn grace. 32 checks. |
| 2026-07-31 | 1 | Fixed invisible track (mirror floor blowing out on real hardware), added lane dividers, softened the opening difficulty ramp and start speed after first human playtest. |
| 2026-08-01 | 1 | World sprint: panorama sky dome with real parallax, and a full procedural colonnade — fluted columns, vaults, cornices, lanterns, statues, hall floor. Five bugs found by looking at frames, none by tests. 36 checks. |
| 2026-07-31 | 1 | Sprint 1 complete: path-space model, 90 degree junction turns with signage, context-sensitive turn input. Smoke test 26 -> 31 checks. Three bugs found by screenshots that no test would have caught. |
