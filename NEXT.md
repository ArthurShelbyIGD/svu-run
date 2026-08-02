# Where this is, and what to do next

Paused 2 Aug 2026 at Anthony's request — he's on his main game for a few days
and will pick this up later in the week. Everything is merged, gated and
pushed. `main` is green at 55/55 and what is live is what is in the repo.

Read `ARCHITECTURE.md` first for how the thing is built. This file is only
about what to do on the next working day.

---

## The open defect, in Anthony's words

> "Looks like we lost the hands with fingers along the way at some point, they
> seem to be like the boots, some kind of shape with rounded edges. The same
> goes for the shoulders."

He is right, and this is the FOURTH instance of one recurring failure. Take the
pattern seriously before touching geometry, because three previous passes have
been spent rebuilding parts that were already correct:

**A detail in this world reads only if something in the room lights it.**

The hall is black. There is no large bright surface. So:

- The cape rendered as a hole in the screen — diagnosed as material, was
  geometry (flat-topped flutes, constant normals).
- The boots "were missing" for a whole pass — they were built, placed and
  visible, and measured five times too dark to see. `polRhodium` is a true
  mirror, and a mirror in a black hall is black.
- `src/char/index.js` already records the general rule, in `_buildGlove`:
  *"a small mirror-metal detail in this world is a BLACK detail, because a
  mirror shows you the room and the room is black. Small parts want the pale
  champagne or the pavé, not polRhodium. polRhodium only works on masses big
  enough to catch the portrait rig — the gloves and the boots."*

That last clause is the bug. The gloves were exempted as "big enough" and they
are not. Anthony's eye says they read as rounded blobs, and his eye is the
acceptance test.

### So, concretely

**Hands.** The fingers exist — `_buildGlove` builds four fingers with five
rings each, knuckle tori, and a swung thumb. Do NOT rebuild them. The question
is why they merge into one mass at chase distance. Check, in this order:

1. Value separation. Sample the pixels: if adjacent fingers differ by only a
   few percent, no amount of geometry will separate them. They need a darker
   valley between them — either a dark seam in the setting, or a material with
   a diffuse component that can actually shade.
2. Normal averaging. The character is merged per material (`geom.js`) and
   `ComputeNormals` averages across the merge. This is exactly what turned the
   stone crowns into a field of pearls until the crown facets were flat-shaded
   as detached quads. If the finger tubes are being smoothed into the palm,
   split them.
3. Finger radius `R * 0.265` with a 4-finger span of `R * 1.06` leaves almost
   no gap. Widen the gap before widening the fingers.

**Shoulders.** `shoulder caps: small masses where the sleeves meet the body`,
around line 552. These are the rounded blobs he means. The reference has no
shoulder hardware at all — the pavé sleeve simply meets the pavé yoke. Consider
deleting the caps rather than restyling them, and check the reference before
assuming they need to exist.

**Grade against `docs/reference-rear.png` using the `char-back` pose**, not
`char-rear`. `char-back` is the straight-on elevation and is the only
directly comparable view; the three-quarter pose hides one arm and foreshortens
the cape, and half the grading arguments in this project were made off it.

---

## The other open item

**The cape is satin, not mirror.** Measured p95/p50 = 1.50 against the
reference's 2.28. The honest conclusion, recorded in `src/char/index.js`: the
remaining gap is the ENVIRONMENT, not the material. The reference is a light
tent — a big white card against black. Our hall has nothing bright and nothing
large for a mirror to find. That is `src/mat/`'s cubemap, not the character's
geometry.

Caveat before anyone spends a day on it: `ARCHITECTURE.md` §7 says mirrors are
the one thing this harness lies about. Verify on a real GPU first.

---

## Not started

- **Interface.** `src/ui/index.js` is still the 154-line day-one placeholder —
  a bare number in the corner. Everything else now looks like a jewellery
  advert; the interface looks like a debug overlay. Needs a real start screen
  (the first thing anyone Anthony sends the link to will see), a game-over
  screen with distance / stars / best, an in-run HUD legible in sunlight on a
  phone, and small pickup / near-miss feedback in `src/fx/`. Mobile portrait is
  the primary target; respect safe areas. This has been queued twice and never
  run — do it first.
- **Powerups.** Wing glide, ruby magnet, shield. All unimplemented.
- **Measured mobile performance pass** on a real device. The harness renders
  through SwiftShader and its frame timings mean nothing.
- **Zone-specific prop variation.** Five zones exist; the props are the same in
  all of them.

## Unverified

**Nobody has heard the audio.** It is merged and structurally verified — every
effect produces real signal with sensible envelopes, the generative bed
produces notes and chords, 36 voices start, nothing throws — but whether it
sounds good is unknown. Anthony is the first person who will hear it. Ask him.

---

## Operational notes for whoever picks this up

- **This box has 2 cores, so a workflow runs at most 2 agents at once.** A
  third is silently queued and may never start. Round 6 launched three; the
  interface agent never ran. Launch two.
- **The container gets reclaimed.** It happened at least three times. Agents
  must commit and push after every meaningful change; GitHub is the source of
  truth, not the working copy. Snapshot worktrees to `/root/backup/` on a
  timer as well, since agents do not always push promptly.
- **A workflow can be killed silently** — a context compaction aborted round 5
  mid-flight and it went unnoticed for 15 minutes. The run's JSON at
  `.claude/.../workflows/<runId>.json` only appears once the run TERMINATES;
  if it exists, read its `status`.
- **Run `npm run check` UNPIPED and check the exit status.** Piping it into
  grep masks the status and this project has shipped red twice that way.
- **Look at the frames.** Every serious defect here was invisible to a green
  test suite and obvious in a screenshot.
