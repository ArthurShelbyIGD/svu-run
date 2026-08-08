import { chromium } from 'playwright';
import { readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
function findChromium() {
  const base = process.env.PLAYWRIGHT_BROWSERS_PATH || '/opt/pw-browsers';
  for (const d of readdirSync(base).filter(x => x.startsWith('chromium-')).sort((a,b)=>parseInt(b.split('-')[1])-parseInt(a.split('-')[1]))) {
    const p = join(base, d, 'chrome-linux', 'chrome');
    if (existsSync(p)) return p;
  }
}
const b = await chromium.launch({ args: ['--use-gl=angle','--use-angle=swiftshader','--enable-unsafe-swiftshader','--hide-scrollbars'], executablePath: findChromium() });
const ctx = await b.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
const page = await ctx.newPage();
const errs = [];
page.on('pageerror', e => errs.push(e.message));
page.on('console', m => { if (m.type()==='error') errs.push(m.text()); });
await page.goto(pathToFileURL('/root/racer/docs/index.html').href, { waitUntil: 'load', timeout: 60000 });
await page.waitForFunction(() => window.RACER, null, { timeout: 30000 });
await page.waitForTimeout(4000);
const s = await page.evaluate(() => {
  const i = window.RACER.renderer.info.render;
  return { calls: i.calls, tris: i.triangles, speed: Math.round(window.RACER.st.speed), dist: Math.round(window.RACER.st.dist) };
});
console.log(JSON.stringify(s));
console.log('errors:', errs.length ? errs.slice(0,3) : 'none');
await page.screenshot({ path: '/root/racer/shot.png', timeout: 120000 });
await b.close();
