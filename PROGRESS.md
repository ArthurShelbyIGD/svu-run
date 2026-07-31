# SVU RUN — Progress & Handoff

**This file is the resume point.** A fresh session with no memory of any
previous conversation should be able to read `PLAN.md`, `ARCHITECTURE.md` and
this file, and carry straight on. Keep it current — it is what makes a build
spread across many token windows survivable.

---

## Current state

**Sprint 0 — COMPLETE.** Pipeline proven end to end.

Last verified: build passes, 16/16 smoke checks pass, 7 screenshot poses
capture cleanly.

### What exists

- Single-file build: `dist/svu-run.html`, ~2.4 MB, fully self-contained.
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
- `coll/`, `fx/`, `audio/`: registered stubs — module graph proven, no
  implementation yet.
- `tools/`: `smoke.mjs` (16 checks), `capture.mjs` (7 deterministic poses),
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

**Second finding: the profile capture pose earns its place.** The first
character blockout had a torso nearly as tall as the whole character, which was
invisible from the default chase camera and obvious the moment a side-on shot
existed. Any pose the critics cannot see, they cannot grade. Add poses before
adding polish.

---

## Known issues / deliberate debt

| # | Issue | Where | Planned |
|---|---|---|---|
| 1 | Backdrop is a flat blown-out cream; no sky or depth treatment | `main.js` clear colour | Sprint 4 |
| 2 | Track floor reads dark and muddy — it mirrors a dark env | `mat/`, `track/` | Sprint 2 |
| 3 | Wing reads as a detached floating slab | `char/` | Sprint 3 |
| 4 | Shadows not visibly landing; generator wired but unverified | `world/` | Sprint 1 |
| 5 | Env cubemap mips are not properly convolved, so rough materials are approximate. Fine while everything is polished | `mat/` | Sprint 2 if needed |
| 6 | No collision, no obstacles, no stars, no death — not yet a game | `coll/`, `track/` | Sprint 1 |
| 7 | No audio at all | `audio/` | Sprint 5 |
| 8 | Camera framing is a first guess, not tuned with a human in the loop | `core/config.js` | Sprint 1 |

---

## Next up — Sprint 1: the core loop

Goal: it becomes an actual game. Still grey-box; no art polish.

1. **Chunk grammar** in `track/` — replace the uniform tile strip with chunk
   templates assembled by a difficulty-weighted grammar.
2. **Obstacles** — low (jump), high (slide), full-lane (dodge). Placed by the
   grammar with guaranteed-solvable spacing derived from current speed.
3. **Collision** in `coll/` — swept AABB against the lane grid. No physics
   engine; a runner needs nothing more.
4. **Stars** — collectible gold stars, thin-instanced, with a magnet radius.
5. **Death and restart** — the run ends, results show, restart is instant.
6. **90° junction turns** — the thing that makes it Temple Run rather than
   Subway Surfers. Hardest item in the sprint; do it last.
7. **Camera tuning** with a human looking at it.

Sprint 1 stays solo — these systems are tightly coupled and the
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
