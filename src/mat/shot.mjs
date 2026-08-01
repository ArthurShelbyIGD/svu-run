// A material-iteration screenshot loop.
//
// tools/capture.mjs is lead-owned and shoots ten poses with Playwright's
// default 30 s screenshot timeout. Working on materials means shooting the same
// two close-up poses twenty times in a row, and a full-screen close-up of a
// clear-coated pavé surface can exceed that budget in SwiftShader — the shot
// then fails with a timeout that says nothing about why.
//
// This is the same harness with three differences: only the poses being worked
// on, a generous timeout, and it PRINTS PER-FRAME RENDER TIME. That last one is
// the point. "The screenshot timed out" is not a diagnosis; "the first frame
// took 22 s and the next six took 180 ms each" says shader compilation, and
// "every frame takes 4 s" says the shader itself got too expensive.
//
//   node src/mat/shot.mjs                 char-face + hero
//   node src/mat/shot.mjs char-face
//   node src/mat/shot.mjs --preset low

import { launch, openGame, fastForward, ROOT } from '../../tools/harness.mjs';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';

const argv = process.argv.slice(2);
const arg = (n, d) => { const i = argv.indexOf(`--${n}`); return i >= 0 ? argv[i + 1] : d; };
const names = argv.filter((a) => !a.startsWith('--') && argv[argv.indexOf(a) - 1] !== '--preset');
const PRESET = arg('preset', 'high');
const OUT = join(ROOT, arg('out', 'shots'));

const POSES = [
  { name: 'char-face', viewport: 'desktop', time: 4, camera: [0, 1.18, 1.9, 0, 1.10, 0] },
  { name: 'hero', viewport: 'desktop', time: 6, framing: [26, 45] },
  { name: 'char-side', viewport: 'desktop', time: 4, camera: [3.0, 1.20, 0.4, 0, 1.0, 0] },
  { name: 'wide', viewport: 'desktop', time: 10, camera: [7.5, 5.2, -9.0, 0, 1.2, 12] },
];

await mkdir(OUT, { recursive: true });
const browser = await launch();
try {
  for (const pose of POSES) {
    if (names.length && !names.includes(pose.name)) continue;
    const { page, context, errors } = await openGame(browser, {
      viewport: pose.viewport, query: `q=${PRESET}&seed=1&capture`,
    });
    // Wait out the boot splash. It fades on a wall-clock timer, and because
    // this script reuses one warm browser the second pose can be posed and shot
    // before the splash has gone — which produced a "hero" frame that was the
    // title card over a white wash, and a histogram to match.
    await page.waitForFunction(
      () => { const b = document.getElementById('boot');
              return !b || b.classList.contains('gone'); },
      null, { timeout: 60000 });
    await page.waitForTimeout(700);
    await fastForward(page, pose.time);

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

    // Time each settling frame. Rendering is synchronous inside scene.render(),
    // so this measures the real cost including any shader compile.
    const times = await page.evaluate(() => new Promise((res) => {
      const out = [];
      let n = 0;
      const step = () => {
        const t0 = performance.now();
        window.SVU.scene.render();
        out.push(Math.round(performance.now() - t0));
        (++n < 6) ? requestAnimationFrame(step) : res(out);
      };
      requestAnimationFrame(step);
    }));

    await page.screenshot({ path: join(OUT, `${pose.name}.png`), type: 'png', timeout: 180000 });
    console.log(`  ${pose.name.padEnd(11)} frames ms: ${times.join(' ')}`);
    if (errors.length) console.log(`    ! ${errors.slice(0, 3).join(' | ')}`);
    await context.close();
  }
} finally {
  await browser.close();
}
