// scratch: measure a captured PNG. Row means, full-width step detection,
// pixel samples, whole-frame stats.
//   node .scratch/imgscan.mjs <png> [--rows y0 y1] [--px x,y ...] [--band y0 y1]
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

const files = process.argv.slice(2).filter((a) => a.endsWith('.png'));
const flag = (n) => { const i = process.argv.indexOf(`--${n}`); return i >= 0 ? process.argv[i + 1] : null; };
const yLo = Number(flag('y0') || 0);
const yHi = Number(flag('y1') || 0);
const pxArg = flag('px');

const browser = await chromium.launch({ executablePath: findChromium() });
const page = await browser.newPage();

for (const f of files) {
  const b64 = readFileSync(f).toString('base64');
  const r = await page.evaluate(async ([b64, yLo, yHi, pxArg]) => {
    const img = new Image();
    img.src = 'data:image/png;base64,' + b64;
    await img.decode();
    const W = img.naturalWidth, H = img.naturalHeight;
    const cv = document.createElement('canvas');
    cv.width = W; cv.height = H;
    const c = cv.getContext('2d');
    c.drawImage(img, 0, 0);
    const d = c.getImageData(0, 0, W, H).data;
    const lum = (i) => 0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2];

    // whole-frame stats
    const all = new Float64Array(W * H);
    let sum = 0;
    for (let y = 0, k = 0; y < H; y++) {
      for (let x = 0; x < W; x++, k++) { const v = lum((y * W + x) * 4); all[k] = v; sum += v; }
    }
    const sorted = Array.from(all).sort((a, b) => a - b);
    const q = (p) => sorted[Math.floor(p * (sorted.length - 1))];

    // per-row mean, and step uniformity: fraction of columns whose
    // delta agrees in sign with the row-mean delta and exceeds 1.5 lum
    const rowMean = new Float64Array(H);
    for (let y = 0; y < H; y++) {
      let s = 0;
      for (let x = 0; x < W; x++) s += all[y * W + x];
      rowMean[y] = s / W;
    }
    const steps = [];
    const a = yLo || 1, b = yHi || H;
    for (let y = Math.max(1, a); y < Math.min(H, b); y++) {
      const dm = rowMean[y] - rowMean[y - 1];
      let agree = 0;
      for (let x = 0; x < W; x++) {
        const dv = all[y * W + x] - all[(y - 1) * W + x];
        if (Math.sign(dv) === Math.sign(dm) && Math.abs(dv) > 1.5) agree++;
      }
      steps.push([y, dm, agree / W]);
    }
    steps.sort((p, r2) => Math.abs(r2[1]) - Math.abs(p[1]));

    const px = [];
    if (pxArg) {
      for (const t of pxArg.split(' ')) {
        const [x, y] = t.split(',').map(Number);
        const i = (y * W + x) * 4;
        px.push([x, y, d[i], d[i + 1], d[i + 2]]);
      }
    }
    return { W, H, mean: sum / (W * H), p50: q(0.5), p05: q(0.05), p95: q(0.95),
      steps: steps.slice(0, 12), px };
  }, [b64, yLo, yHi, pxArg]);

  console.log(`\n== ${f}  ${r.W}x${r.H}`);
  console.log(`   mean ${r.mean.toFixed(2)}  p05 ${r.p05.toFixed(1)}  p50 ${r.p50.toFixed(1)}  p95 ${r.p95.toFixed(1)}`);
  for (const [y, dm, agree] of r.steps) {
    console.log(`   step y=${String(y).padStart(4)} (${(y / r.H * 100).toFixed(1)}%)  dmean ${dm.toFixed(2).padStart(7)}  full-width ${(agree * 100).toFixed(0)}%`);
  }
  for (const [x, y, R, G, B] of r.px) console.log(`   px ${x},${y} = rgb(${R},${G},${B})`);
}
await browser.close();
