// Diagnostic: capture a strip of frames through a single corner.
//
// Written because two rounds of reasoning about corners produced two fixes and
// the corner still felt wrong. Looking at the actual frames has found every
// corner defect so far; reasoning about the maths has found none of them.

import { launch, openGame, fastForward, ROOT } from './harness.mjs';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';

const OUT = join(ROOT, 'shots', 'corner-strip');
await mkdir(OUT, { recursive: true });

// Distances relative to the junction. Positive = before it.
const MARKS = [26, 18, 12, 7, 3, 0, -4, -9, -16];

const browser = await launch();
const { page } = await openGame(browser, { viewport: 'desktop', query: 'q=high&seed=1&capture' });
await fastForward(page, 20);

// Roll forward to just before the first junction.
await page.evaluate(() => {
  const S = window.SVU, play = S.ctx.get('play');
  for (let i = 0; i < 20000; i++) {
    if (play.junction && (play.junction.s - play.z) <= 30) break;
    S.loop.advance(1 / 60, 0);
  }
  play._camInit = false;
  S.loop.advance(0, 3);
});

for (const mark of MARKS) {
  const info = await page.evaluate((m) => {
    const S = window.SVU, play = S.ctx.get('play'), track = S.ctx.get('track');
    for (let i = 0; i < 20000; i++) {
      const j = play.junction;
      const d = j ? j.s - play.z : Infinity;
      if (d <= m) break;
      S.loop.advance(1 / 60, 1);
    }
    S.loop.advance(0, 2);
    const cam = S.scene.activeCamera;
    return {
      d: play.junction ? +(play.junction.s - play.z).toFixed(1) : null,
      speed: +play.speed.toFixed(1),
      factor: +play._cornerFactor.toFixed(2),
      lane: play.lane, lat: +play.x.toFixed(2),
      camLat: +play._camLat.toFixed(2),
      cam: [+cam.position.x.toFixed(1), +cam.position.z.toFixed(1)],
      alive: play.alive,
    };
  }, mark);
  const tag = mark >= 0 ? `pre${String(mark).padStart(2, '0')}` : `post${String(-mark).padStart(2, '0')}`;
  await page.screenshot({ path: join(OUT, `${tag}.png`) });
  console.log(tag.padEnd(7), JSON.stringify(info));
}
await browser.close();
