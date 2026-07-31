// Throwaway art-direction mockups. Injects three alternative world treatments
// into the live build and screenshots each, so they can be compared like for
// like instead of described in prose.
//
// Not shipped: none of this touches src/. It patches the running scene.

import { launch, openGame, fastForward, ROOT } from './harness.mjs';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';

const OUT = join(ROOT, 'shots', 'worlds');
await mkdir(OUT, { recursive: true });

const LOOKS = {
  // ---------- A: real outdoor sky ----------
  sky: (S) => {
    const B = S.BJS;
    const sc = S.scene;
    const world = S.ctx.get('world');
    if (world.skyLayer) world.skyLayer.dispose();

    const H = 512;
    const t = new B.DynamicTexture('skyA', { width: 512, height: H }, sc, true);
    const c = t.getContext();
    const g = c.createLinearGradient(0, 0, 0, H);
    g.addColorStop(0.00, '#1d4f96');
    g.addColorStop(0.28, '#3f7fc4');
    g.addColorStop(0.52, '#84b3dd');
    g.addColorStop(0.70, '#cfe0ea');
    g.addColorStop(0.80, '#f6e4c4');
    g.addColorStop(1.00, '#d9b98c');
    c.fillStyle = g; c.fillRect(0, 0, 512, H);
    // soft cloud banding
    c.globalAlpha = 0.35;
    for (let i = 0; i < 26; i++) {
      const y = 40 + Math.abs(Math.sin(i * 2.7)) * 260;
      const h = 6 + (i % 5) * 7;
      const x = (i * 97) % 512;
      const w = 80 + (i % 7) * 60;
      const cg = c.createLinearGradient(x, y, x + w, y);
      cg.addColorStop(0, 'rgba(255,255,255,0)');
      cg.addColorStop(0.5, 'rgba(255,255,255,0.9)');
      cg.addColorStop(1, 'rgba(255,255,255,0)');
      c.fillStyle = cg; c.fillRect(x, y, w, h);
    }
    // sun glow
    c.globalAlpha = 1;
    const sun = c.createRadialGradient(340, 330, 4, 340, 330, 150);
    sun.addColorStop(0, 'rgba(255,246,214,0.95)');
    sun.addColorStop(1, 'rgba(255,240,200,0)');
    c.fillStyle = sun; c.fillRect(190, 180, 300, 300);
    t.update(false);

    const L = new B.Layer('skyA', null, sc, true);
    L.texture = t;
    world.skyLayer = L;
    sc.fogColor = new B.Color3(0.83, 0.86, 0.90);
    sc.fogStart = 90; sc.fogEnd = 300;
    sc.environmentIntensity = 1.35;
  },

  // ---------- B: jewel-box interior ----------
  jewel: (S) => {
    const B = S.BJS;
    const sc = S.scene;
    const world = S.ctx.get('world');
    if (world.skyLayer) world.skyLayer.dispose();

    const H = 512;
    const t = new B.DynamicTexture('skyB', { width: 512, height: H }, sc, true);
    const c = t.getContext();
    const g = c.createLinearGradient(0, 0, 0, H);
    g.addColorStop(0.00, '#07070c');
    g.addColorStop(0.34, '#0e0d15');
    g.addColorStop(0.62, '#1d1720');
    g.addColorStop(0.82, '#3a2a26');
    g.addColorStop(1.00, '#0a0a0e');
    c.fillStyle = g; c.fillRect(0, 0, 512, H);
    // warm light shafts from above
    for (let i = 0; i < 7; i++) {
      const x = 40 + i * 72;
      const sg = c.createLinearGradient(x, 0, x + 26, 380);
      sg.addColorStop(0, 'rgba(255,214,150,0.30)');
      sg.addColorStop(1, 'rgba(255,214,150,0)');
      c.fillStyle = sg;
      c.beginPath(); c.moveTo(x, 0); c.lineTo(x + 30, 0);
      c.lineTo(x + 78, 380); c.lineTo(x + 20, 380); c.closePath(); c.fill();
    }
    // ruby glow low on the horizon
    const glow = c.createRadialGradient(256, 400, 6, 256, 400, 230);
    glow.addColorStop(0, 'rgba(190,40,60,0.42)');
    glow.addColorStop(1, 'rgba(190,40,60,0)');
    c.fillStyle = glow; c.fillRect(0, 200, 512, 312);
    t.update(false);

    const L = new B.Layer('skyB', null, sc, true);
    L.texture = t;
    world.skyLayer = L;
    sc.fogColor = new B.Color3(0.07, 0.06, 0.09);
    sc.fogStart = 55; sc.fogEnd = 190;
    sc.environmentIntensity = 1.9;
    if (S.pipeline) { S.pipeline.bloomWeight = 0.85; S.pipeline.bloomThreshold = 0.55; }
  },

  // ---------- C: stylised abstract ----------
  stylised: (S) => {
    const B = S.BJS;
    const sc = S.scene;
    const world = S.ctx.get('world');
    if (world.skyLayer) world.skyLayer.dispose();

    const H = 512;
    const t = new B.DynamicTexture('skyC', { width: 512, height: H }, sc, true);
    const c = t.getContext();
    const bands = [
      ['#2b2250', 0.00], ['#5b3a72', 0.26], ['#a8557e', 0.44],
      ['#e0846f', 0.60], ['#f6b96f', 0.72], ['#fbe0a6', 0.84], ['#f2cf95', 1.00],
    ];
    const g = c.createLinearGradient(0, 0, 0, H);
    for (const [col, stop] of bands) g.addColorStop(stop, col);
    c.fillStyle = g; c.fillRect(0, 0, 512, H);
    // hard graphic bands, the Alto's-style signature
    c.globalAlpha = 0.16;
    c.fillStyle = '#ffffff';
    for (let i = 0; i < 5; i++) c.fillRect(0, 300 + i * 26, 512, 8);
    c.globalAlpha = 1;
    // low sun disc
    c.fillStyle = 'rgba(255,240,200,0.92)';
    c.beginPath(); c.arc(300, 372, 46, 0, Math.PI * 2); c.fill();
    t.update(false);

    const L = new B.Layer('skyC', null, sc, true);
    L.texture = t;
    world.skyLayer = L;
    sc.fogColor = new B.Color3(0.92, 0.74, 0.56);
    sc.fogStart = 70; sc.fogEnd = 230;
    sc.environmentIntensity = 1.5;
  },
};

const browser = await launch();
for (const [name, fn] of Object.entries(LOOKS)) {
  const { page } = await openGame(browser, { viewport: 'desktop', query: 'q=high&seed=1&capture' });
  await page.evaluate(() => {
    // expose the Babylon namespace the bundle already carries
    /* BJS exposed by main.js */
  });
  // Wait for the boot splash to actually leave the DOM. Without this the first
  // capture in a run is taken through a white fading overlay.
  await page.waitForFunction(() => !document.getElementById('boot'), null, { timeout: 30000 });
  await fastForward(page, 12);
  await page.evaluate(`(${fn.toString()})(window.SVU)`);
  await page.evaluate(() => { window.SVU.loop.advance(0, 4); });
  await page.screenshot({ path: join(OUT, `${name}.png`) });
  console.log('captured', name);
  await page.context().close();
}
await browser.close();
