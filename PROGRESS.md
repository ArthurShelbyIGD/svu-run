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

**Eighth finding: the post pipeline was measured a second time, and three of
the "measured" numbers from the first pass were measuring the wrong frame.**

The first grading probe posed the hero shot by fast-forwarding to a fixed time
and never ran the obstacle-gap seek that `tools/capture.mjs` runs. In capture
mode collision is disabled, so the player coasts into a solid block: every
histogram in the first pass was taken from **inside a grey obstacle**. Re-run
with the seek, three things changed sign.

1. **The vignette was the darkness.** Not the backdrop, not the lighting rig,
   not the fog. Hero pose mean luminance 68.2 as shipped, 132.8 with only the
   vignette switched off. It is applied *before* the tonemapper, so it does not
   dim pixels, it crushes them into the ACES toe. The critic's "44.6% of the
   frame below luminance 40, top quarter dead black holding nothing" was almost
   entirely this one control. Also: `vignetteK` scales the vignette
   *coordinate*, so a LARGER K is a TIGHTER vignette — the opposite of how it
   reads. 3.2/K0.52 -> 4.6/K0.34 keeps the corners dark and stops the falloff
   eating the top third. Pixels below luminance 40: 43.5% -> 18.6%.

2. **Exposure 2.05 was erasing the pavé.** The first pass raised exposure to
   reach the ACES shoulder. That was right for the corridor and ruinous for the
   character, whose surface is a large area of near-white albedo: it sat on a
   flat clipped plateau. The face pose measured 37.7% of the frame below
   luminance 40 *and* p95 at 239 — every pixel either black or blown. Exposure
   1.80 gives back the stone-by-stone structure, the hood rim, the boot stones
   and the second eye catchlight.

3. **Sharpen, not exposure, is the sparkle lever.** The frame had essentially
   no pixels at 255, and a pavé surface under studio light is *defined* by
   pixel-scale blowouts. `highlightsExposure` produces them but is a luminance-
   BAND operator — it cannot tell a 2px specular from the character's entire
   white head, and at 58 it clipped 8.1% of the face pose to paper. Sharpen is
   LOCAL: 0.40 -> 1.00 moved pixels above luminance 250 from 0.215% to 1.063%
   while the frame mean moved 93.4 -> 93.6. It is now on at `low` too, because
   it is roughly 40% of the FXAA pass `low` already runs.

**AO was switched on and doing nothing.** `ssao.radius` was 1.6 *metres* —
most of the character's height. Measured on the front pose: mean luminance 95.4
with AO on against 96.1 with it off, a 0.7% difference, because nearly every
sample landed in open space. The creases that matter (hood/head junction, ear
roots, arm sockets, boot contact) are 0.1..0.4m features. At 0.55m the effect is
~3.5x and the difference image shows it landing on those junctions. This is the
fix for "the character reads as a pile of separate balls".

**No bloom threshold can separate the corridor from the character.** The
previous note claimed the emissive columns were "far brighter than 1.6". That
was assumed, never sampled, and it is false. Swept and looked at: at 1.90 the
emitters glow, at 2.30 they are visibly dimmer, at 2.80 they are completely
flat, and 3.50 is pixel-identical to 2.80 — nothing in the scene is above 3.5.
The emitters and the pavé sit in the same narrow linear band. Separating them
needs a mask, not a threshold: **a `GlowLayer` on the emitters in `world/`**
would let the bloom threshold here rise out of the character's range entirely.
Until then 1.90 is the compromise. What post could take was the KERNEL: 64 ->
40 concentrates the same light into a smaller radius, which reads as specular
rather than as fog (face pose pixels over luminance 250, 1.8% -> 2.4%).

**The lens did not fit the frame it was in.** Babylon's `FreeCamera` defaults
to `FOVMODE_VERTICAL_FIXED`, which holds the vertical angle and lets the
horizontal one collapse with the aspect ratio — a 27 degree horizontal field on
a 390x844 phone. `camFovBase` is now an aspect-compensated getter in
`core/config.js`: a tangent-space blend between vertical-fixed and
horizontal-fixed, so portrait gains corridor width and desktop gains subject
size without either going near a fisheye. The blend was tuned by looking, twice
— 0.45 improved desktop and shrank the phone framing to a seventh of frame
height, 0.20 is where both hold.

**Seventh finding: the post pipeline was three separate measurement failures,
and one of them belongs to somebody else.**

The grade was rebuilt by sampling rendered pixels rather than by reasoning
about them. Three things the numbers said that the code assumed otherwise:

1. **ACES was not the villain.** The suspicion was that ACES was crushing
   authored colour. Sampling the hero frame at 1600x900 says otherwise: no post
   at all gives mean luminance 113.9 and mean saturation 0.175; ACES alone
   gives 88.6 / 0.221. ACES slightly *raises* saturation here. What it does is
   darken by 22%, because the scene's range barely reaches 1.0, so the curve's
   toe does all the work and its shoulder does none. The fix was to raise
   exposure until highlights reach the shoulder, not to remove the tonemapper.

2. **`contrast` was a darkening operator.** Babylon's contrast is a smoothstep
   pivoted at 0.5 in gamma space. The frame's mean was 0.32, so nearly every
   pixel sat below the pivot and contrast 1.12 pushed the whole image *down*.

3. **The bloom threshold is a LINEAR value, and the character was above it.**
   At the shipped 0.72 the runner's own white pavé qualified as a highlight, so
   every close-up came back as a glowing blob that had eaten its own surface
   detail — 7.2% of the char-face frame was clipped white. Threshold 1.60 drops
   the character out of the highlight pass while the emissive light columns,
   which are far brighter, still bloom. Selective bloom can afford to be strong
   in a way that indiscriminate bloom never can.

**The one that is not post's to fix: the sky Layer is double-gamma'd.**
`world/zones.js` authors the zone gradients as sRGB hex (`#3a2a24` and
similar) into a `DynamicTexture`. A `Layer` blits those bytes straight into the
HDR buffer, where they are treated as LINEAR, and then the image-processing
pass applies `toGammaSpace` to everything. Measured: with all image processing
off, the sky reads back at its authored value (68,53,47). With it on, that same
texel renders around (140,120,112). A dark brown backdrop is arriving on screen
as a mid tan.

That is the milky wash across the top third of every frame, and it is why the
"vast dark interior" art direction has never actually been on screen. The fix
is in `world/`: author the gradient in linear (raise each stop to the power
2.2 before drawing) or flag the texture so Babylon converts it. Post can grade
around it but cannot undo it — a single-channel curve cannot separate the
backdrop from everything else that legitimately lives in the same tonal band.

**Vignette was silently aspect-dependent.** Babylon derives the vignette
ellipse from `vignetteCameraFov` — which defaults to 0.5 radians, is unrelated
to the actual camera, and is combined with the render aspect. The same
`vignetteWeight` therefore framed a 16:9 desktop frame heavily and a 390x844
portrait frame barely at all: measured corner brightness 0.5% against 5.5%.
Portrait is how most people will play. `core/post.js` now pins
`vignetteStretch` to 1 and solves `tan(fov/2) = K / sqrt(aspect)` on every
resize, so one weight means one thing on every device.

**Grain and chromatic aberration were both evaluated and both rejected**, on
crops rather than on principle. Grain has a very narrow useful band: invisible
at intensity 2.4, obvious sensor noise at 12. Chromatic aberration put visible
magenta/green fringes on the light columns at 2.6 and was imperceptible below
1.0. Each cost a full-screen pass and a shader compile for nothing. Cutting
both also fixed the capture harness, which had started timing out under
SwiftShader: shader compilation, not frame time, is what the 30s screenshot
timeout was actually spending itself on.

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
| 14 | **Sky Layer is double-gamma'd** — zone gradients authored in sRGB are blitted as linear then gamma-encoded again, so the dark vault backdrop renders as a mid tan wash. See seventh finding. Largest single remaining defect in the final image | `world/zones.js` | next |
| 1 | Zones change the backdrop but the world still has no landmarks or parallax depth layers | `world/` | Sprint 4 |
| 12 | Gilt zone has the lowest track/background contrast of the five — watch it on a phone in daylight | `world/zones.js` | needs a device |
| 2 | ~~Portrait framing puts the character quite large in frame~~ — MISDIAGNOSED. The character was not large; the corridor was narrow, because Babylon's vertical-fixed fov left portrait with a 27 degree horizontal field. `camFovBase` is now an aspect-compensated getter. Remaining: `play/` has no lateral camera offset, so every shot is dead-astern and the face and wing are never seen in play | `play/` | Sprint 4 |
| 3 | Fringe under the hood rim still reads weakly; face/hood separation could go further | `char/` | polish |
| 13 | No pavé surface treatment yet — the stretch goal from PLAN.md section 2 | `mat/` | optional |
| 4 | Shadows not visibly landing; generator wired but unverified | `world/` | Sprint 1 |
| 16 | **Corridor emitters and the character occupy the same linear brightness band (1.9..2.3), so no bloom threshold can glow one without haloing the other.** Needs a `GlowLayer` driven by the emitters' emissive channel; then `core/post.js` can raise its threshold out of the character's range | `world/` | next |
| 17 | The wing is a zero-thickness sheet and catches one softbox as a single blown white disc in `char-rear.png`. Post cannot fix a specular that large — it is geometry | `char/` | polish |
| 15 | ~~AO is on but subtle~~ — RESOLVED as a bug, not a limitation: the radius was 1.6m, most of the character's height, so the pass measured as inert (0.7% frame difference against AO off). Now 0.55m. It will still pay off more once `world/` has clutter and `track/` has surface relief | `world/`, `track/` | with detail work |
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
| 2026-08-01 | 2 | Post re-measured with the correct pose (the first probe had been sampling the inside of an obstacle). Vignette was halving frame luminance; exposure 2.05 was erasing the pavé; sharpen 0.40 -> 1.00 is the sparkle lever and is now on at `low`; SSAO radius 1.6m -> 0.55m turned an inert pass into contact occlusion; bloom kernel 64 -> 40; aspect-compensated lens in `core/config.js`. Below luminance 40 on the hero pose: 43.5% -> 18.6%. 36 checks pass. |
| 2026-08-01 | 1 | Post pipeline rebuilt in `core/post.js`: SSAO2 (high + medium), measured exposure/contrast, split-tone colour curves, bloom threshold 0.72 -> 1.60, aspect-stable vignette, dithering. Grain, chromatic aberration and depth of field evaluated and rejected. Found and documented the sky-layer double-gamma defect for `world/`. 36 checks pass, all 15 poses capture. |
| 2026-07-31 | 2 | Sprint 3: character rebuilt to resemble the NFT. Face/hood separation, eyes with catchlights, bat wing, antenna, better animation. |
| 2026-07-31 | 2 | Jewel-box world shipped with five progressive zones. Art direction chosen by comparing three built mockups rather than describing them. |
| 2026-07-31 | 1 | Camera moved to path-space smoothing (fixes "bouncing off the barrier"); sky sphere replaced with a background layer (fixes the clipped bubble). 36 checks. |
| 2026-07-31 | 1 | Added gradient sky + fog, and a pooled thin-instance particle system (pickup, landing, death, corner, speed streaks). 35 checks. |
| 2026-07-31 | 1 | Fixed corner discontinuity (3.4m sideways teleport in the outer lane), widened the turn reaction window, added late-turn grace. 32 checks. |
| 2026-07-31 | 1 | Fixed invisible track (mirror floor blowing out on real hardware), added lane dividers, softened the opening difficulty ramp and start speed after first human playtest. |
| 2026-08-01 | 1 | World sprint: panorama sky dome with real parallax, and a full procedural colonnade — fluted columns, vaults, cornices, lanterns, statues, hall floor. Five bugs found by looking at frames, none by tests. 36 checks. |
| 2026-07-31 | 1 | Sprint 1 complete: path-space model, 90 degree junction turns with signage, context-sensitive turn input. Smoke test 26 -> 31 checks. Three bugs found by screenshots that no test would have caught. |
