// scratch: isolate the hard horizontal step at ~17% of the portrait frame.
// One page load, several screenshots with one thing switched off each time.
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
  const c = S.scene.activeCamera;
  return {
    fov: c.fov, fovMode: c.fovMode, minZ: c.minZ, maxZ: c.maxZ,
    pos: [c.position.x, c.position.y, c.position.z],
    target: c.getTarget ? [c.getTarget().x, c.getTarget().y, c.getTarget().z] : null,
    rot: c.rotation ? [c.rotation.x, c.rotation.y, c.rotation.z] : null,
    w: S.engine.getRenderWidth(), h: S.engine.getRenderHeight(),
    scaling: S.engine.getHardwareScalingLevel(),
    meshes: S.scene.meshes.map((m) => m.name).slice(0, 80),
  };
});
console.log(JSON.stringify(info, null, 1));

const render = () => page.evaluate(() => new Promise((res) => {
  let n = 0;
  const step = () => { window.SVU.scene.render(); (++n < 6) ? requestAnimationFrame(step) : res(); };
  requestAnimationFrame(step);
}));

const variants = {
  base: () => {},
  nosky: () => {
    for (const m of window.SVU.scene.meshes) if (m.name.startsWith('sky')) m.setEnabled(false);
  },
  skyonly: () => {
    for (const m of window.SVU.scene.meshes) {
      if (!m.name.startsWith('sky')) m.setEnabled(false);
    }
  },
};

for (const [name, fn] of Object.entries(variants)) {
  // reload state cheaply: re-enable everything, then apply
  await page.evaluate(() => {
    for (const m of window.SVU.scene.meshes) m.setEnabled(true);
    const p = window.SVU.ctx.pipeline;
    if (p) { p.bloomEnabled = true; p.imageProcessingEnabled = true; }
    window.SVU.scene.fogMode = 2;
  });
  await page.evaluate(fn);
  await render();
  await page.screenshot({ path: join(OUT, `${name}.png`), timeout: 180000 });
  console.log('  ->', name);
}
await browser.close();
