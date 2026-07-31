# SVU RUN

A third-person endless runner built in Babylon.js, shipping as a single
self-contained HTML file that runs on laptop and mobile.

**Play:** [svu-run.html](https://sonicboomsoundboy.github.io/svu-run/svu-run.html)

Everything is generated procedurally in code — no texture files, no model
files, no audio files. The build output is one HTML file with Babylon
tree-shaken and inlined, so it works from a link, from a download, or opened
straight off disk with no network at all.

**Controls** — laptop: arrow keys or WASD. Mobile: swipe left/right to change
lane, up to jump, down to slide.

---

## Status

Sprint 0 complete: engine, materials, character blockout, track, and the
test/capture tooling. Not yet a game — no obstacles, collision or scoring.
See [`PROGRESS.md`](PROGRESS.md) for where it is and what is next.

## Documents

| File | What it is |
|---|---|
| [`PLAN.md`](PLAN.md) | The build plan — art direction, risks, sprint schedule |
| [`ARCHITECTURE.md`](ARCHITECTURE.md) | The contract: ownership, events, hard rules |
| [`PROGRESS.md`](PROGRESS.md) | Current state, known issues, next sprint, handoff |

## Development

```bash
npm install
npm run build     # -> docs/svu-run.html  (GitHub Pages serves this)
npm run smoke     # headless functional test
npm run shots     # deterministic screenshots -> shots/
npm run check     # build + smoke, the gate before committing
```

URL flags: `?debug` frame-time readout, `?q=low|medium|high` force a quality
preset, `?seed=N` reproducible run.

## Credit

Character design and art direction derived from an NFT owned by the author.
