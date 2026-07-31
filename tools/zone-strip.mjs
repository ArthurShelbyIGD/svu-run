// One framed shot per zone, so the whole progression can be reviewed at once.
import { launch, openGame, fastForward, ROOT } from './harness.mjs';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';

const OUT = join(ROOT, 'shots', 'zones');
await mkdir(OUT, { recursive: true });
const MARKS = [180, 800, 1420, 2040, 2660];

const browser = await launch();
const { page } = await openGame(browser, { viewport: 'desktop', query: 'q=high&seed=1&capture' });
await page.waitForFunction(() => !document.getElementById('boot'), null, { timeout: 30000 });
await fastForward(page, 4);

for (const m of MARKS) {
  const info = await page.evaluate((target) => {
    const S = window.SVU, play = S.ctx.get('play');
    for (let i = 0; i < 60000 && play.z < target; i++) S.loop.advance(1 / 60, 0);
    // settle away from a corner so the shot is a clean straight
    for (let i = 0; i < 4000; i++) {
      const d = play.junction ? play.junction.s - play.z : 999;
      if (d > 60) break;
      S.loop.advance(1 / 60, 0);
    }
    play._camInit = false;
    S.loop.advance(0, 6);
    return { z: Math.round(play.z), zone: S.ctx.get('world').zoneName };
  }, m);
  await page.screenshot({ path: join(OUT, `${String(info.z).padStart(4, '0')}-${info.zone}.png`) });
  console.log(`${String(info.z).padStart(5)}m  ${info.zone}`);
}
await browser.close();
