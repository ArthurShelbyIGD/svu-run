// Screenshot capture. This is the flywheel of the whole project: it is what
// gives a critic agent eyes, and what lets two builds be compared honestly.
//
// Every shot is deterministic — fixed seed, fixed player position, fixed
// camera, simulation frozen before the grab — so a pixel difference between
// two runs means a real change, not noise.
//
// Usage:
//   node tools/capture.mjs                 all poses, default preset
//   node tools/capture.mjs --preset low    force a quality preset
//   node tools/capture.mjs --only hero     one pose
//   node tools/capture.mjs --out shots/b   write somewhere else
//   node tools/capture.mjs --only zone4    one pose
//   node tools/capture.mjs --match zone    every pose whose name contains it

import { launch, openGame, fastForward, ROOT } from './harness.mjs';
import { ZONES, ZONE_LENGTH } from '../src/world/zones.js';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const argv = process.argv.slice(2);
const arg = (name, def) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : def;
};

const OUT = join(ROOT, arg('out', 'shots'));
const PRESET = arg('preset', 'high');
const ONLY = arg('only', null);
const MATCH = arg('match', null);

/**
 * A pose is a named, reproducible camera + game state.
 *  viewport : which device frame
 *  time     : seconds of game time to advance before posing
 *  setup    : runs in the page; put the game in the state you want
 *  camera   : optional [posX,posY,posZ, targetX,targetY,targetZ] relative to
 *             the player — set this to lock the camera for a framed shot
 */
const POSES = [
  {
    name: 'hero',
    viewport: 'desktop',
    time: 6,
    framing: [26, 45],
    note: 'default chase view, mid-run — the shot the whole game is judged on',
  },
  {
    name: 'phone',
    viewport: 'phone',
    time: 6,
    framing: [26, 45],
    note: 'portrait, the way most people will actually see it',
  },
  {
    name: 'char-face',
    viewport: 'desktop',
    time: 4,
    camera: [0, 1.18, 1.9, 0, 1.10, 0],
    note: 'face close-up — compare directly with docs/reference.jpeg',
  },
  {
    name: 'char-front',
    viewport: 'desktop',
    time: 4,
    camera: [1.5, 1.15, 2.6, 0, 1.0, 0],
    note: 'front three-quarter — the silhouette check',
  },
  {
    name: 'char-side',
    viewport: 'desktop',
    time: 4,
    camera: [3.0, 1.20, 0.4, 0, 1.0, 0],
    note: 'profile — proportion and wing read',
  },
  {
    name: 'char-rear',
    viewport: 'desktop',
    time: 4,
    camera: [-1.1, 1.35, -2.4, 0, 1.05, 0],
    note: 'rear three-quarter — what players ACTUALLY see for 99% of a run',
  },
  {
    // Dead behind, tight. docs/reference-rear.png is a straight-on elevation, so
    // the three-quarter char-rear pose is not directly comparable with it — half
    // the grading arguments in this project have been made off a view that hides
    // one arm and foreshortens the cape. This is the A/B shot.
    name: 'char-back',
    viewport: 'desktop',
    time: 4,
    camera: [0, 1.30, -3.85, 0, 1.02, 0],
    note: 'straight-on rear elevation — the direct A/B against docs/reference-rear.png',
  },
  {
    // THE HANDS ARE 40 PIXELS IN EVERY OTHER POSE. That is exactly why four
    // fingers welded into one slab survived several review passes: at 40px a
    // correct hand and a rounded blob are the same picture. This frames ONE
    // hand at about a metre, from behind and slightly outboard, so the finger
    // GAPS are what the shot is about.
    //
    // THE NUMBERS ARE MEASURED, NOT GUESSED. A first attempt sat behind the
    // FIGURE at 1.45m and returned a picture of the skirt with two 90px blobs
    // at the edges — i.e. the very shot that let the defect through. These are
    // the world bounds of mesh `glove1` at t=4s, seed=1, the same instant this
    // pose freezes:
    //     x 0.498 .. 0.858   y 0.457 .. 0.838   z (play.z + 0.190) .. (+0.397)
    // so the hand centre is play + (0.678, 0.647, 0.293) and it is 36cm across.
    // Camera 0.95m back in z and 19 degrees up (the chase camera's own pitch),
    // pushed 0.18m outboard so the background behind the fingers is the dark
    // hall rather than the skirt — gaps only read against something.
    // If the arm-swing animation, the wrist cock or handR changes, RE-MEASURE:
    // dump scene.getMeshByName('glove1').getBoundingInfo().boundingBox after a
    // 4-second fastForward and re-derive these six numbers.
    name: 'char-hand',
    viewport: 'desktop',
    time: 4,
    camera: [0.88, 1.00, -0.62, 0.70, 0.675, 0.33],
    note: 'ONE hand, filling the frame — the only pose in which fingers are gradeable',
  },
  {
    // THE SHOULDER, WHICH IS WHERE THREE ROUNDS HAVE GONE. "Two smooth blobs",
    // then "two pavé lumps flanking the head", then a bib argued to be too
    // narrow when it was half again too wide — every one of those verdicts was
    // reached from a frame in which the whole shoulder was 60 px across. The
    // question this pose exists to answer is a junction, not a mass: does the
    // sleeve's top go UNDER the yoke's corner, or stand outboard and above it?
    //
    // MEASURED, NOT GUESSED, from the same instant it freezes (t = 4 s,
    // seed = 1, player-relative world coordinates):
    //     armPivot1  (0.282, 1.113, 0.122)
    //     wrist1     (0.579, 0.817, 0.223)
    //     yokeEdge    x .. 0.390,  y 1.048 .. 1.226
    //     upperStones x 0.110 .. 0.532,  y 0.847 .. 1.306
    // so the junction sits near (0.36, 1.15, 0.05) and the arm runs 0.70 m
    // down-and-out from it. Camera 1.30 m back, 0.24 m up and 0.22 m outboard,
    // which is the chase camera's own 19-degree pitch carried in close, so
    // what this shows is what a player would see if they could lean in.
    // If shoulderX, shoulderY or the yoke's ax/dip move, RE-MEASURE: dump
    // those four bounding boxes after a 4-second fastForward and re-derive.
    name: 'char-shoulder',
    viewport: 'desktop',
    time: 4,
    camera: [0.58, 1.39, -1.28, 0.36, 1.15, 0.05],
    note: 'the sleeve-into-yoke junction, close — is the shoulder UNDER the collar?',
  },
  {
    name: 'jump',
    viewport: 'desktop',
    time: 5,
    setup: () => {
      const p = window.SVU.ctx.get('play');
      p.pushIntent(3); // INTENT.JUMP
    },
    settle: 0.28,
    note: 'mid-air pose',
  },
  {
    name: 'slide',
    viewport: 'desktop',
    time: 5,
    setup: () => {
      const p = window.SVU.ctx.get('play');
      p.pushIntent(4); // INTENT.SLIDE
    },
    settle: 0.22,
    note: 'slide pose',
  },
  {
    name: 'obstacles',
    viewport: 'desktop',
    time: 30,
    framing: [16, 30],
    note: 'gameplay read — can you parse the obstacles in time?',
  },
  {
    name: 'phone-obstacles',
    viewport: 'phone',
    time: 30,
    framing: [16, 30],
    note: 'the same read, in portrait, where it actually matters',
  },
  // ---- the obstacle read, posed deterministically ----------------------
  //
  // WHY THESE EXIST. The `obstacles` / `phone-obstacles` poses seek until the
  // nearest obstacle is 16-30m ahead, which sounds like it frames obstacles
  // and does not: at 30s of game time the run is past FIRST_TURN_AT, and the
  // seek happily stops with the "nearest obstacle" round a corner behind the
  // backstop wall. Both shots came back as a picture of a wall. They are kept
  // because they are an honest sample of the real game, but they cannot be
  // used to judge whether an obstacle reads.
  //
  // The lineup poses below park everything the generator made and place one
  // of each kind, one per lane, at a fixed distance on a stretch of track
  // that is guaranteed straight (time is well under the 260m first-turn
  // distance, so play.x/play.z are still world axes and the camera maths in
  // this file is valid). That is the shot to squint at.
  {
    name: 'lineup',
    viewport: 'desktop',
    time: 14,
    setup: () => {
      const S = window.SVU;
      const track = S.ctx.get('track');
      const play = S.ctx.get('play');
      for (let i = track.obstacles.length - 1; i >= 0; i--) track._park(track.obstacles[i]);
      track.obstacles.length = 0;
      for (let i = track.stars.length - 1; i >= 0; i--) track._park(track.stars[i]);
      track.stars.length = 0;
      const z = play.z + 26;
      track._spawnObstacle(0, 0, z);   // OB.LOW  — jump
      track._spawnObstacle(1, 1, z);   // OB.HIGH — slide
      track._spawnObstacle(2, 2, z);   // OB.FULL — dodge
      for (let i = 0; i < 6; i++) track._spawnStar(1, 1.15, play.z + 10 + i * 2.4);
    },
    settle: 0.1,
    note: 'one of each obstacle, one per lane, 25m out — THE readability test',
  },
  {
    name: 'phone-lineup',
    viewport: 'phone',
    time: 14,
    setup: () => {
      const S = window.SVU;
      const track = S.ctx.get('track');
      const play = S.ctx.get('play');
      for (let i = track.obstacles.length - 1; i >= 0; i--) track._park(track.obstacles[i]);
      track.obstacles.length = 0;
      for (let i = track.stars.length - 1; i >= 0; i--) track._park(track.stars[i]);
      track.stars.length = 0;
      const z = play.z + 26;
      track._spawnObstacle(0, 0, z);
      track._spawnObstacle(1, 1, z);
      track._spawnObstacle(2, 2, z);
      for (let i = 0; i < 6; i++) track._spawnStar(1, 1.15, play.z + 10 + i * 2.4);
    },
    settle: 0.1,
    note: 'the same lineup in portrait — the read that decides fairness',
  },
  {
    name: 'props-near',
    viewport: 'desktop',
    time: 14,
    setup: () => {
      const S = window.SVU;
      const track = S.ctx.get('track');
      const play = S.ctx.get('play');
      for (let i = track.obstacles.length - 1; i >= 0; i--) track._park(track.obstacles[i]);
      track.obstacles.length = 0;
      for (let i = track.stars.length - 1; i >= 0; i--) track._park(track.stars[i]);
      track.stars.length = 0;
      const z = play.z + 12;
      track._spawnObstacle(0, 0, z);
      track._spawnObstacle(1, 1, z);
      track._spawnObstacle(2, 2, z);
      track._spawnStar(0, 1.4, play.z + 8.2);
      track._spawnStar(1, 1.4, play.z + 8.2);
      track._spawnStar(2, 1.4, play.z + 8.2);
    },
    settle: 0.1,
    camera: [0, 1.75, 5.4, 0, 1.15, 12],
    note: 'the props close up — craft check on obstacles and stars',
  },
  // ---- the powerups -----------------------------------------------------
  //
  // THE ONLY QUESTION THESE POSES ANSWER: at the distance a player must decide
  // to change lane, can you tell WHICH powerup it is? The hoop itself reads
  // easily — it is 1.30m of gold against a black hall. The emblem inside it is
  // the part that failed last build, because a gold emblem inside a gold hoop
  // has no value difference and value is the only channel that survives 23
  // metres, a 390px frame and a bloom pass. Hence the dark stone bed.
  //
  // All three at once, one per lane, because "visible" is not the test —
  // "distinguishable from the other two" is.
  {
    name: 'pw-lineup',
    viewport: 'desktop',
    time: 14,
    setup: () => {
      const S = window.SVU;
      const track = S.ctx.get('track');
      const play = S.ctx.get('play');
      const pw = play.pw;
      for (let i = track.obstacles.length - 1; i >= 0; i--) track._park(track.obstacles[i]);
      track.obstacles.length = 0;
      for (let i = track.stars.length - 1; i >= 0; i--) track._park(track.stars[i]);
      track.stars.length = 0;
      const s = play.z + 23;
      pw.poseHoop(0, s, -2.4);   // MAGNET, left lane
      pw.poseHoop(1, s, 0);      // SHIELD, centre
      pw.poseHoop(2, s, 2.4);    // GLIDE, right
      // One star at the same distance for scale: the hoop must not be
      // mistakable for the thing that is worth ten points.
      track._spawnStar(1, 1.15, play.z + 14);
    },
    settle: 0.1,
    note: 'all three powerup hoops at 23m — can you tell which is which?',
  },
  {
    name: 'phone-pw-lineup',
    viewport: 'phone',
    time: 14,
    setup: () => {
      const S = window.SVU;
      const track = S.ctx.get('track');
      const play = S.ctx.get('play');
      const pw = play.pw;
      for (let i = track.obstacles.length - 1; i >= 0; i--) track._park(track.obstacles[i]);
      track.obstacles.length = 0;
      for (let i = track.stars.length - 1; i >= 0; i--) track._park(track.stars[i]);
      track.stars.length = 0;
      const s = play.z + 23;
      pw.poseHoop(0, s, -2.4);
      pw.poseHoop(1, s, 0);
      pw.poseHoop(2, s, 2.4);
      track._spawnStar(1, 1.15, play.z + 14);
    },
    settle: 0.1,
    note: 'THE emblem test — three hoops at 23m in portrait, where they are 44px across',
  },
  {
    name: 'pw-near',
    viewport: 'desktop',
    time: 14,
    setup: () => {
      const S = window.SVU;
      const track = S.ctx.get('track');
      const play = S.ctx.get('play');
      const pw = play.pw;
      for (let i = track.obstacles.length - 1; i >= 0; i--) track._park(track.obstacles[i]);
      track.obstacles.length = 0;
      for (let i = track.stars.length - 1; i >= 0; i--) track._park(track.stars[i]);
      track.stars.length = 0;
      const s = play.z + 12;
      pw.poseHoop(0, s, -2.4);
      pw.poseHoop(1, s, 0);
      pw.poseHoop(2, s, 2.4);
    },
    settle: 0.1,
    camera: [0, 1.75, 5.4, 0, 1.30, 12],
    note: 'the hoops close up — craft check on the emblems and the bed',
  },
  {
    // FROM THE REAL CHASE CAMERA, deliberately. The previous cage was two
    // rings in the same plane — a single gold line up the runner's back from
    // dead astern — and it graded fine from a posed three-quarter view, which
    // is exactly how it shipped. No `camera` field here: this is what the
    // player sees.
    name: 'pw-shield',
    viewport: 'desktop',
    time: 14,
    framing: [26, 45],
    setup: () => {
      const S = window.SVU;
      S.ctx.get('play').pw.grant(1);
    },
    settle: 0.2,
    note: 'the shield cage on the runner, from the chase camera — the only view that counts',
  },
  {
    // Mid-flight, on purpose. The magnet's whole read is stars leaving their
    // lanes and converging on the runner; a frame taken before or after shows
    // either a normal track or an empty one. 0.26s into a 0.40s flight is
    // halfway there, because the flight eases in on u^2.
    name: 'pw-magnet',
    viewport: 'desktop',
    time: 14,
    setup: () => {
      const S = window.SVU;
      const track = S.ctx.get('track');
      const play = S.ctx.get('play');
      for (let i = track.obstacles.length - 1; i >= 0; i--) track._park(track.obstacles[i]);
      track.obstacles.length = 0;
      for (let i = track.stars.length - 1; i >= 0; i--) track._park(track.stars[i]);
      track.stars.length = 0;
      for (let i = 0; i < 5; i++) {
        track._spawnStar(0, 1.15, play.z + 2 + i * 1.6);
        track._spawnStar(2, 1.15, play.z + 2 + i * 1.6);
      }
      S.ctx.get('coll').enabled = true;
      play.pw.grant(0);
    },
    settle: 0.26,
    keepStars: true,
    note: 'the ruby magnet mid-pull — stars converging on the runner',
  },
  {
    name: 'phone-pw-shield',
    viewport: 'phone',
    time: 14,
    framing: [26, 45],
    setup: () => {
      const S = window.SVU;
      S.ctx.get('play').pw.grant(1);
    },
    settle: 0.2,
    note: 'the shield cage in portrait',
  },
  {
    name: 'gameover',
    viewport: 'phone',
    time: 8,
    setup: () => {
      const S = window.SVU;
      S.ctx.get('coll').enabled = true;
      const play = S.ctx.get('play');
      const track = S.ctx.get('track');
      const t = track.obstacles.find((o) => o.kind === 2 && o.z > play.z + 6);
      if (t) { play.lane = play.laneTarget = t.lane; play.laneT = 1; }
      else play.kill('capture');
    },
    settle: 2.5,
    note: 'results screen',
  },
  // ---- interface ------------------------------------------------------
  //
  // Capture mode deliberately skips the start screen (otherwise every pose is
  // a title card), so these poses put it back up by hand. ui/ turns its
  // opacity transitions off in capture mode, so what is grabbed is the settled
  // state rather than whatever fraction of a fade the software renderer
  // happened to reach.
  {
    name: 'start',
    viewport: 'phone',
    time: 5,
    framing: [26, 45],
    setup: () => { window.SVU.ctx.get('ui').showStart(); },
    settle: 0.1,
    note: 'the start screen in portrait — the first thing anyone sees',
  },
  {
    name: 'start-wide',
    viewport: 'desktop',
    time: 5,
    framing: [26, 45],
    setup: () => { window.SVU.ctx.get('ui').showStart(); },
    settle: 0.1,
    note: 'the start screen on a laptop',
  },
  {
    name: 'paused',
    viewport: 'phone',
    time: 12,
    framing: [26, 45],
    setup: () => { window.SVU.ctx.get('ui').setPaused(true); },
    settle: 0.1,
    note: 'the pause panel in portrait',
  },
  {
    // The near-miss hairline and the milestone toast both last about a fifth
    // of a second in play, which is long enough to matter and far too short to
    // grade. ui.preview() holds them up. It is a capture affordance only.
    name: 'feedback',
    viewport: 'phone',
    time: 6,
    framing: [26, 45],
    setup: () => { window.SVU.ctx.get('ui').preview(1, '500 METRES'); },
    settle: 0.1,
    note: 'near-miss hairline and the milestone toast, held open',
  },
  {
    name: 'gameover-wide',
    viewport: 'desktop',
    time: 8,
    setup: () => {
      const S = window.SVU;
      S.ctx.get('coll').enabled = true;
      const play = S.ctx.get('play');
      const track = S.ctx.get('track');
      const t = track.obstacles.find((o) => o.kind === 2 && o.z > play.z + 6);
      if (t) { play.lane = play.laneTarget = t.lane; play.laneT = 1; }
      else play.kill('capture');
    },
    settle: 2.5,
    note: 'the results screen on a laptop',
  },
  {
    name: 'corner',
    viewport: 'desktop',
    time: 20,
    approachJunction: 20,
    note: 'approaching a junction — does the corner read as a corner?',
  },
  {
    name: 'corner-wide',
    viewport: 'desktop',
    time: 20,
    approachJunction: 16,
    camera: [9, 8.5, -11, 0, 1.2, 10],
    note: 'corner geometry from outside — pad, wall and rail cutaway',
  },
  {
    name: 'phone-corner',
    viewport: 'phone',
    time: 20,
    approachJunction: 20,
    note: 'the corner read in portrait, where reaction time is tightest',
  },
  {
    name: 'wide',
    viewport: 'desktop',
    time: 10,
    camera: [7.5, 5.2, -9.0, 0, 1.2, 12],
    note: 'wide establishing shot — reads the track and the world silhouette',
  },
  ...zonePoses(),
];

/**
 * THE ZONE LINEUP — five shots of one stretch of track, one per zone.
 *
 * WHY THESE EXIST, AND WHY EVERY EARLIER ZONE VERDICT WAS UNSOUND. A zone is
 * chosen by distance; zones 2-5 begin at 620, 1240, 1860 and 2480 metres, and
 * fourteen seconds of game time is about two hundred. Every other pose in this
 * file therefore shoots ZONE 1, and two rounds of "the zones all feel the same"
 * were graded off frames physically incapable of showing four fifths of them.
 *
 * Simulating 2800m per pose costs minutes under software rendering and lands
 * the player at an arbitrary point in the turn grammar, so no two shots frame
 * the same thing. Instead each pose parks the generated obstacles, plants one
 * of each kind at a fixed 26m, and then offsets the distance the ZONE SYSTEM
 * reads (World.setZoneBias) to land exactly 310m into the wanted zone — the
 * middle, where the crossfade to the next zone is zero. Same seed, same
 * straight, same lineup, same camera. The zone is the only variable.
 *
 * WHY new Function AND NOT A CLOSURE. page.evaluate serialises a function with
 * toString(), which carries the source text and NOT the scope it came from, so
 * a closed-over `k` arrives in the page as a ReferenceError. The index has to
 * be baked into the source as a literal. This bites once per project.
 */
function zonePoses() {
  const out = [];
  for (let k = 0; k < ZONES.length; k++) {
    for (const vp of ['desktop', 'phone']) {
      const body = `
        const S = window.SVU;
        const track = S.ctx.get('track');
        const play = S.ctx.get('play');
        for (let i = track.obstacles.length - 1; i >= 0; i--) track._park(track.obstacles[i]);
        track.obstacles.length = 0;
        for (let i = track.stars.length - 1; i >= 0; i--) track._park(track.stars[i]);
        track.stars.length = 0;
        const z = play.z + 26;
        track._spawnObstacle(0, 0, z);   // OB.LOW  — jump
        track._spawnObstacle(1, 1, z);   // OB.HIGH — slide
        track._spawnObstacle(2, 2, z);   // OB.FULL — dodge
        for (let i = 0; i < 6; i++) track._spawnStar(1, 1.15, play.z + 10 + i * 2.4);
        // 310m into zone ${k}: the middle of the zone, blend to the next = 0.
        S.ctx.get('world').setZoneBias(${k} * ${ZONE_LENGTH} + 310 - play.z);
      `;
      out.push({
        name: `${vp === 'phone' ? 'phone-' : ''}zone${k + 1}`,
        __body: body,
        viewport: vp,
        time: 14,
        setup: new Function(body),
        settle: 0.1,
        note: `zone ${k + 1} ${ZONES[k].name} — same straight, same lineup at 26m, ${vp}`,
      });
    }
  }
  // THE HALFWAY SHOT. A hard cut at a zone boundary reads as a bug, so the
  // crossfade has to be gradeable and not just assertable. Vault runs 0-620m
  // and the blend into Ruby starts at 620-150 = 470m, so 545m is exactly half
  // way: the key light is mid-swing between raking left and raking right, the
  // ceiling is mid-way between Vault's round vault and Ruby's squat one, and
  // the air is half red. If this frame looks like a coherent room, the
  // transition is doing its job.
  for (const vp of ['desktop', 'phone']) {
    out.push({
      name: `${vp === 'phone' ? 'phone-' : ''}zone-blend`,
      viewport: vp,
      time: 14,
      setup: new Function(out[0].__body.replace(
        /setZoneBias\([^)]*\)/, 'setZoneBias(545 - play.z)',
      )),
      settle: 0.1,
      note: `the Vault -> Ruby crossfade at its midpoint, 545m, ${vp}`,
    });
  }
  for (const p of out) delete p.__body;
  return out;
}

await mkdir(OUT, { recursive: true });
const browser = await launch();
const manifest = [];

try {
  for (const pose of POSES) {
    if (ONLY && pose.name !== ONLY) continue;
    if (MATCH && !pose.name.includes(MATCH)) continue;

    const { page, context, errors } = await openGame(browser, {
      viewport: pose.viewport,
      query: `q=${PRESET}&seed=1&capture`,
    });

    await fastForward(page, pose.time);

    // Seek to a fixed distance before the next corner. Guessing a time landed
    // the "corner" shots 60m short of an actual junction, which made the
    // corner look unreadable when the real problem was that it was far away.
    if (pose.approachJunction) {
      await page.evaluate((want) => {
        const S = window.SVU;
        const play = S.ctx.get('play');
        for (let i = 0; i < 20000; i++) {
          if (play.junction && (play.junction.s - play.z) <= want) break;
          S.loop.advance(1 / 60, 0);
        }
        play._camInit = false;
        S.loop.advance(0, 3);
      }, pose.approachJunction);
    }

    // Capture mode disables collision, so an unsteered player will happily
    // come to rest inside a solid block — which produced a "hero" shot that was
    // 90% the inside of an obstacle. Seek to a position framed relative to the
    // nearest obstacle instead.
    if (pose.framing) {
      await page.evaluate(([minA, maxA]) => {
        const S = window.SVU;
        const play = S.ctx.get('play');
        const track = S.ctx.get('track');
        const gap = () => {
          let best = Infinity;
          for (const o of track.obstacles) {
            const d = o.z - play.z;
            if (d > 0 && d < best) best = d;
          }
          return best;
        };
        // Collectibles are NOT obstacles, so the gap seek above ignores them —
        // and capture mode disables collision, so the player happily comes to
        // rest inside a star. That parked a full-size gold star on top of the
        // character in the hero shot and cost a grading pass, because it read
        // as broken character geometry rather than a tooling artefact. Reject
        // any pose with an untaken collectible close enough to overlap.
        const starClear = () => {
          const list = track.stars || track.collectibles || track.pickups || [];
          for (const s of list) {
            if (s.taken || s.active === false) continue;
            const d = (s.z !== undefined ? s.z : s.s) - play.z;
            if (d > -2.5 && d < 3.5) return false;
          }
          return true;
        };
        for (let i = 0; i < 20000; i++) {
          const g = gap();
          if (g >= minA && g <= maxA && starClear()) break;
          S.loop.advance(1 / 60, 0);
        }
        play._camInit = false;
        S.loop.advance(0, 3);
      }, [pose.framing[0], pose.framing[1]]);
    }

    if (pose.setup) {
      await page.evaluate(pose.setup);
      await fastForward(page, pose.settle || 0.2);
    }

    // Freeze the simulation, then place the camera. Order matters: the camera
    // must be positioned after the last simulation step, or play/ overwrites it.
    await page.evaluate(([cam, keepStars]) => {
      const S = window.SVU;
      S.loop.setPaused(true);

      // Collectibles are not obstacles, so the framing seek above ignores them,
      // and capture mode disables collision — so the player parks INSIDE a
      // star. A full-size gold star then sits on the character and reads as
      // broken character geometry; it cost a grading pass and misled an agent
      // into rewriting geometry that was fine.
      //
      // This must happen AFTER setPaused. Disabling the meshes before the last
      // advance() does nothing: track's renderUpdate re-enables and repositions
      // every live star each frame, so the change is undone before the grab.
      //
      // A pose that is ABOUT the stars near the player — pw-magnet, which
      // exists to show them being pulled in — opts out with `keepStars`.
      if (!keepStars) {
        const play = S.ctx.get('play');
        const track = S.ctx.tryGet('track');
        for (const s of ((track && track.stars) || [])) {
          const d = s.z - play.z;
          if (d > -6.0 && d < 7.0 && s.mesh) s.mesh.setEnabled(false);
        }
      }

      if (cam) {
        const play = S.ctx.get('play');
        play.camLocked = true;
        const c = S.scene.activeCamera;
        c.position.set(play.x + cam[0], cam[1], play.z + cam[2]);
        c.setTarget(new (c.position.constructor)(play.x + cam[3], cam[4], play.z + cam[5]));
      }
    }, [pose.camera || null, !!pose.keepStars]);

    // Render a few frames so post-processing (bloom, TAA history) settles.
    await page.evaluate(() => new Promise((res) => {
      let n = 0;
      const step = () => { window.SVU.scene.render(); (++n < 6) ? requestAnimationFrame(step) : res(); };
      requestAnimationFrame(step);
    }));

    const file = join(OUT, `${pose.name}.png`);
    // 180s, not the 30s default. A 1600x900 screenshot forces a full render, and
    // the scene got heavy enough that software rendering exceeds the default
    // timeout — which surfaced as "capture is broken" rather than "capture is
    // slow", and left every reviewed frame silently stale.
    await page.screenshot({ path: file, type: 'png', timeout: 180000 });
    manifest.push({ name: pose.name, file: `${pose.name}.png`, viewport: pose.viewport, preset: PRESET, note: pose.note, errors });
    console.log(`  ${pose.name.padEnd(12)} ${pose.viewport.padEnd(8)} ${pose.note}`);
    if (errors.length) console.log(`    ! ${errors.slice(0, 2).join(' | ')}`);

    await context.close();
  }

  await writeFile(join(OUT, 'manifest.json'), JSON.stringify({ preset: PRESET, poses: manifest }, null, 2));
  console.log(`\n${manifest.length} shots -> ${OUT}`);
} finally {
  await browser.close();
}
