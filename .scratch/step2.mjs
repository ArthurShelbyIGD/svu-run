// scratch: which mesh owns the hard horizontal step?
import { launch, openGame, fastForward, ROOT } from '../tools/harness.mjs';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';

const OUT = join(ROOT, 'shots', 'step');
await mkdir(OUT, { recursive: true });

const browser = await launch();
const { page } = await openGame(browser, { viewport: 'phone', query: 'q=high&seed=1&capture' });
await fastForward(page, 6);

const info = await page.evaluate(() => {
  const S = window.SVU;
  S.loop.setPaused(true);
  const play = S.ctx.get('play');
  const props = S.ctx.get('world').props;
  // where are the shaft instances, relative to the player?
  const buf = props.shaftBuf;
  const zs = [];
  if (buf) {
    for (let i = 0; i < buf.length; i += 16) {
      if (buf[i] === 0 && buf[i + 5] === 0) continue;
      zs.push(+(buf[i + 14] - play.z).toFixed(2));
    }
  }
  zs.sort((a, b) => a - b);
  return { playZ: play.z, shaftDz: zs, shaftMesh: !!props.shaftMesh };
});
console.log(JSON.stringify(info));

const render = () => page.evaluate(() => new Promise((res) => {
  let n = 0;
  const step = () => { window.SVU.scene.render(); (++n < 6) ? requestAnimationFrame(step) : res(); };
  requestAnimationFrame(step);
}));

const variants = {
  fixed: () => {},
};

for (const [name, fn] of Object.entries(variants)) {
  await page.evaluate(() => {
    for (const m of window.SVU.scene.meshes) m.setEnabled(true);
    for (const m of window.SVU.scene.meshes) if (m.name === 'skyB') m.setEnabled(false);
  });
  await page.evaluate(fn);
  await render();
  await page.screenshot({ path: join(OUT, `${name}.png`), timeout: 180000 });
  console.log('  ->', name);
}
await browser.close();
