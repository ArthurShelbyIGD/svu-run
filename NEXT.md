# SVU RUN — where this is, and what to do next

Last updated 7 Aug 2026, during round 14.

Read `ARCHITECTURE.md` first for how the thing is built. This file is the
handover note: what is done, what is known, what is still wrong, and the traps
that have already cost this project days.

---

## Status

`main` gates at **82 checks**. The game has: a five-zone jewelled corridor with
per-zone light, air and architecture; a pavé-diamond character with separated
fingers, boots and a fluted cape; three powerups with a HUD; a start screen,
pause, results screen and in-run HUD; synthesised audio; and an input path that
responds within one rendered frame of a swipe.

---

## The one lesson, and the six times it bit

**Reasoning about rendering gives wrong answers. Looking at rendered frames
gives right answers. Measuring pixels beats both.**

Every serious defect here was invisible to a green test suite and obvious in a
screenshot. A specific sub-species has now appeared **six times**:

> **Geometry that is technically present and visually absent.**

1. **The cape read as a hole in the screen** — dark chrome against a dark world.
2. **The boots were "missing" for a whole pass** while built, placed and
   visible. Measured five times too dark to see: `polRhodium` is a true mirror
   and a mirror in a black hall is black.
3. **The elbow had a hole in it.** `surface()` emits an OPEN pipe; `foreSurf`'s
   mouth pointed straight at a camera sitting 19° above and rendered as a hard
   black ellipse that had been read as "an elbow pad" for several rounds.
4. **The wrist cuff was threaded THROUGH the wrist.** `torus()` builds its
   centreline in XZ — axis already Y — and the code added another quarter turn.
   Measured bbox 177 × 179 × 25 mm. It had been dismissed as "too small".
5. **The shield cage had two rings in the same plane.** Babylon composes
   Yaw·Pitch·Roll — roll first — so a pitch is applied about the axis the roll
   already moved. From dead astern: one gold line up the runner's back. It
   graded fine from a posed three-quarter view.
6. **The onesie hem band was side-on AND 12 cm off the body** — the same
   wrong-axis torus bug, plus a radius sampled at the waist rather than at the
   band's own height. Hidden by the skirt, which is why it survived.

**The tell for most of these is a bounding box with one extent an order of
magnitude smaller than the other two.** Check that before rebuilding anything.

### The corollary that saves the most time

**Measure before you blame.** Three hypotheses died in minutes to pixel samples:

- "The fingers are unlit" — they were not. Luminance across the glove ran
  150–226 of 255, among the brightest things in frame. They were
  **interpenetrating**: a −19.1 mm gap, welded into one slab.
- "Normal averaging is smoothing them together" — impossible. `Geo.add` gives
  every part its own vertex range and only offsets indices.
- "The yoke is too narrow" — it was already **47% wider** than the reference.
  The defect was the shoulders, too wide and too high.

The third was a hypothesis the lead handed down as fact. An agent overturned it
by rescaling the reference and the capture to a common figure height and
measuring landmarks in pixels. Do that.

---

## Rules discovered the hard way

- **A large additive billboard must reach zero alpha at every edge of its own
  quad.** `DynamicTexture` uploads inverted, so canvas row 0 is the plane's
  BOTTOM edge. A screen-filling light shaft went from 42% opaque to zero in zero
  pixels and drew a hard line across the portrait frame. It defeated two agents
  who each proved it was *not* the HUD before a third bisected it and confirmed
  the row by arithmetic (predicted 425.3, measured 426).
- **A small mirror-metal detail in this world is a BLACK detail**, because a
  mirror shows you the room and the room is black. Small parts want pale
  champagne or pavé, not `polRhodium`.
- **Never `Texture.clone()` a RawTexture** — it does not carry pixel data. That
  is why every pavé surface once rendered black.
- **The floor must own its own value.** It shipped as a dark near-mirror and
  rendered as wet black patent on real hardware, hiding all its construction.
  It is now a diffuse dielectric — pale cut stone — so obstacles have a light
  ground to silhouette against.
- **Run `npm run check` UNPIPED and check the exit status.** Piping into grep
  masks it; this project shipped red twice that way.

---

## The colour contract

The track speaks three colours and only three:

| | |
|---|---|
| **GOLD**, free-standing in a lane | collect it — stars and powerup hoops |
| **RED**, always a line or a cord | hazard, this is the edge |
| **WHITE DIAMOND**, bezel-set into metal | scenery, you cannot have it |

This exists because the owner played the build and could not tell whether the
red gems on the portcullis were collectible. They never were — but they sat at
y=1.345 with the slide gap's underside at 1.17, i.e. **head height on the one
move where the player is committed and cannot correct**. A player who trusts the
colour steers into the hazard.

White is not a compromise: the character is pavé-set white diamond, so a
diamond-set vault is more on-brief than a ruby-set one, and it leaves red free
to mean exactly one thing. Overhead column finials keep their ruby — five metres
up is unambiguous.

**Powerups obey it by SHAPE and SIZE, not a fourth colour**: a 1.55 m open gold
hoop against the star's 0.30 m solid, with a dark bed behind each gold emblem
for value separation. Do not put emissive white beads on them — at 12 m they
read as white stones bezel-set into metal, which is the contract's exact phrase
for scenery.

---

## Input and the low end

The target device is the owner's own phone: **Ulefone Armor X12 — MediaTek
Helio A22, PowerVR GE8320, 3 GB, Android 13.** He uses a rugged phone because he
breaks flagships at work, so this is the floor the game must clear, not an
unlucky sample. He has explicitly chosen **responsive over crisp**.

The big win was not frame rate. **A swipe was only recognised on `touchend`**,
so minimum input latency was the whole duration of the gesture — 150–250 ms —
before the game was even told. Now recognised on `touchmove` at the 26 px
threshold: measured **one rendered frame** from touch to lane change, where the
old code produced nothing until the finger lifted. Also: the gesture re-arms
without a lift, the intent buffer is a 3-deep ring that skips unservable
entries, and the forgiveness window scales with measured frame time.

There is a `potato` tier below `low` and a governor that reaches it in ~1 s
instead of 5.5 s. **`post.js` `setPreset` never actually switched bloom or
FXAA**, so every previous "low preset" performance conclusion was wrong.

**Still open, and it is a lead call:** `main.js` builds
`new Engine(canvas, true, {...}, false)` — `adaptToDeviceRatio` FALSE — so the
backbuffer is sized from CSS pixels and ignores devicePixelRatio. A 390 CSS-px
viewport gives 292 px at `low` and 195 px at `potato`; on a DPR-2/3 panel that
is ~0.37 of native, upscaled ~2.7×. **That is the real cause of "not crisp."**
The HUD is DOM/CSS and already sharp, so the softness is purely the 3D — and
raising it costs frame rate, the opposite of what he asked for.
**Recommendation: leave it. Do not change without asking him.**

---

## Tooling: what it can and cannot tell you

Captures render through **SwiftShader**. They are faithful for geometry,
silhouette, layout and gross colour. **Frame timings are meaningless.** And per
`ARCHITECTURE.md` §7, mirrors are the one thing the harness actively lies about
— any verdict on the cape or on polished metal is provisional until real
hardware.

Traps in the capture tooling, all found by being burned:

- **Grade the character with `char-back`**, the straight-on rear elevation, not
  the three-quarter `char-rear`. The latter hides one arm and foreshortens the
  cape, and half the wrong conclusions here came from it.
- **Every pose shoots zone 1 unless you set a zone bias.** Zones are chosen by
  distance and 14 s of game time is ~200 m, while zones 2–5 begin at 620, 1240,
  1860 and 2480 m. Two rounds of "the zones all feel the same" were graded off
  screenshots physically incapable of showing four fifths of the game.
- **The `obstacles` poses can photograph a wall** — their seek stops with the
  "nearest obstacle" round a corner behind the backstop. Use `lineup`.
- **Collectibles are not obstacles**, and capture mode disables collision, so
  the player parks inside a star. Hide overlapping stars AFTER `setPaused` —
  doing it before the last `advance()` achieves nothing, because track's
  renderUpdate re-enables them every frame.
- **A capture can come back as the loading splash and still exit 0.** The shell
  removes `#boot` on wall-clock timers which long synchronous evaluates starve.
  The dangerous case is a HALF-FADED splash: a milky wash over a real frame that
  grades as "the lighting is wrong". A suspicious frame is ~20 KB, not 1.6 MB.
- **`pw-lineup` photographs three FROZEN hoops** — idle motion only touches
  `hoops[_liveKind]`, and `poseHoop()` calls `_retire()`, setting it to −1.
- **Motion CAN be seen in stills**, via a matched pose pair at two ABSOLUTE bob
  phases (`pw-bob-a` / `pw-bob-b`). The first attempt offset by half a period,
  which inverts the sine and gives exactly zero travel — it looked like it
  worked and proved nothing.

---

## Working practice that survived contact

- **One agent per directory**, runtime access via `ctx.get(name)`, never imports
  between subsystems.
- **Brief agents with the ANSWER, not the question**, when a previous round
  already found it. Rounds 11–13 rebuilt a lost day's work in a fraction of the
  original time because the findings were handed over rather than rediscovered.
- **Keep a before/after pair in `shots/base/`.** It is the only way to tell
  improvement from motion.
- **This box has 2 cores, so a workflow runs at most 2 agents.** A third is
  silently queued and may never start.

### Container recovery — this has happened twice

The container is reclaimed without warning and rolls the **whole filesystem**
back. Backing up inside it is not a backup: the first reclaim destroyed ~30
commits *and* the bundles meant to protect them.

**The only durable store is a file delivered to the user.** Procedure:

```
git fetch --all && git reset --hard origin/main
# stage the bundle back from the user's machine, then:
git fetch <bundle> 'refs/heads/*:refs/heads/recovered-*'
git reset --hard recovered-main
npm run build && npm run check
```

Deliver a bundle at the end of every round, and write it to the user's disk as
well as into the conversation.

---

## Still wrong / not done

- **The cape is satin where the reference is mirror** (p95/p50 1.50 vs 2.28).
  The gap is the ENVIRONMENT: the reference is a light tent, our hall has
  nothing large or bright for a mirror to find. Round 14 is on it — check its
  result. Provisional until real hardware.
- **Arm proportion** — hands sit slightly high against the reference's
  mid-skirt.
- **Best score does not survive a reload** — module variable, deliberate, since
  storage APIs are unavailable in the shipping environment.
- **`env(safe-area-inset-*)` has never been seen to resolve non-zero** — the
  harness has no notch.
- **The 0.34 s full-screen gold spend flash** is an extra full-screen composite
  per frame and has never run on the target phone.
- **Nobody has measured frame rate on real hardware.** The owner is the only
  instrument.
- Two cross-subsystem reaches, neither broken but both worth a look:
  `coll/index.js` imports three constants from `play/powerups.js`; the magnet
  animates `st.mesh.position` on track's pooled star meshes (never `st.z`,
  which track sorts by).

---

## The standing constraint

GitHub pushes from the cloud sandbox are refused by a git proxy
(`not in this session's authorized repository set`) — a known, unresolved
platform bug, not a repo or token problem. Reads work. Until it is fixed,
handover is by git bundle.
