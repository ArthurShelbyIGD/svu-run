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
    note: 'default chase view, mid-run — the shot the whole game is judged on',
  },
  {
    name: 'phone',
    viewport: 'phone',
    time: 6,
    note: 'portrait, the way most people will actually see it',
  },
  {
    name: 'char-front',
    viewport: 'desktop',
    time: 4,
    camera: [0, 1.15, 3.4, 0, 1.0, 0],
    note: 'character front three-quarter — the silhouette check',
  },
  {
    name: 'char-side',
    viewport: 'desktop',
    time: 4,
    camera: [3.2, 1.20, 0.6, 0, 1.0, 0],
    note: 'character profile — proportion and wing read',
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
    await page.screenshot({ path: file, type: 'png' });
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
