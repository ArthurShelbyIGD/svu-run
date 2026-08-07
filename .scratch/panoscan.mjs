// scratch: find hard horizontal steps in the baked sky panorama.
import { chromium } from 'playwright';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';

function findChromium() {
  const base = process.env.PLAYWRIGHT_BROWSERS_PATH || '/opt/pw-browsers';
  const dirs = readdirSync(base).filter((d) => d.startsWith('chromium-'))
    .sort((a, b) => parseInt(b.split('-')[1], 10) - parseInt(a.split('-')[1], 10));
  for (const d of dirs) {
    const p = join(base, d, 'chrome-linux', 'chrome');
    if (existsSync(p)) return p;
  }
}

const src = readFileSync('/root/wt-zones/src/world/zones.js', 'utf8').replace(/^export /gm, '');

const browser = await chromium.launch({ executablePath: findChromium() });
const page = await browser.newPage();
const rows = await page.evaluate(([src]) => {
  // eslint-disable-next-line no-new-func
  const mod = new Function(src + '\nreturn { ZONES, paintZone };')();
  const W = 1024, H = 512;
  const out = {};
  for (let zi = 0; zi < mod.ZONES.length; zi++) {
    const cv = document.createElement('canvas');
    cv.width = W; cv.height = H;
    const c = cv.getContext('2d');
    mod.paintZone(c, mod.ZONES[zi], W, H);
    const d = c.getImageData(0, 0, W, H).data;
    const mean = new Float64Array(H);
    for (let y = 0; y < H; y++) {
      let s = 0;
      for (let x = 0; x < W; x++) {
        const i = (y * W + x) * 4;
        s += 0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2];
      }
      mean[y] = s / W;
    }
    out[mod.ZONES[zi].name] = Array.from(mean);
  }
  return out;
}, [src]);
await browser.close();

for (const [name, mean] of Object.entries(rows)) {
  const jumps = [];
  for (let y = 1; y < mean.length; y++) {
    jumps.push([y, mean[y] - mean[y - 1]]);
  }
  jumps.sort((a, b) => Math.abs(b[1]) - Math.abs(a[1]));
  console.log(`\n== ${name}`);
  for (const [y, d] of jumps.slice(0, 10)) {
    console.log(`  y=${String(y).padStart(3)} v=${(y / mean.length).toFixed(3)}  d=${d.toFixed(2).padStart(7)}  mean ${mean[y - 1].toFixed(1)} -> ${mean[y].toFixed(1)}`);
  }
}
