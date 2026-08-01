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

import { launch, openGame, fastForward, ROOT } from './harness.mjs';
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
];

await mkdir(OUT, { recursive: true });
const browser = await launch();
const manifest = [];

try {
  for (const pose of POSES) {
    if (ONLY && pose.name !== ONLY) continue;

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
        for (let i = 0; i < 20000; i++) {
          const g = gap();
          if (g >= minA && g <= maxA) break;
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
    await page.evaluate((cam) => {
      const S = window.SVU;
      S.loop.setPaused(true);
      if (cam) {
        const play = S.ctx.get('play');
        play.camLocked = true;
        const c = S.scene.activeCamera;
        c.position.set(play.x + cam[0], cam[1], play.z + cam[2]);
        c.setTarget(new (c.position.constructor)(play.x + cam[3], cam[4], play.z + cam[5]));
      }
    }, pose.camera || null);

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
