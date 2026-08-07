// scratch: region statistics and crops from captured PNGs.
//   node .scratch/region.mjs stats <png...>
//   node .scratch/region.mjs crop <png> x y w h scale out.png
import { chromium } from 'playwright';
import { readFileSync, writeFileSync, readdirSync, existsSync } from 'node:fs';
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

// Named boxes on the 1600x900 desktop zone shots. The camera is identical in
// all five, so the same box samples the same thing in every zone.
const BOXES = {
  head: [745, 470, 105, 100],       // the character's head — pave, must stay white
  frame: [0, 0, 1600, 900],
  lineup: [680, 320, 260, 110],     // the three obstacles at 26m
  road: [700, 700, 200, 120],       // bare track surface in front of the player
  colL: [270, 300, 90, 250],        // the nearest left column shaft
};

const mode = process.argv[2];
const browser = await chromium.launch({ executablePath: findChromium() });
const page = await browser.newPage();

async function load(f) {
  const b64 = readFileSync(f).toString('base64');
  return page.evaluate(async ([b64]) => {
    const img = new Image();
    img.src = 'data:image/png;base64,' + b64;
    await img.decode();
    const cv = document.createElement('canvas');
    cv.width = img.naturalWidth; cv.height = img.naturalHeight;
    cv.getContext('2d').drawImage(img, 0, 0);
    window.__cv = cv;
    return [cv.width, cv.height];
  }, [b64]);
}

if (mode === 'stats') {
  for (const f of process.argv.slice(3)) {
    const [W, H] = await load(f);
    const r = await page.evaluate(([BOXES, W, H]) => {
      const c = window.__cv.getContext('2d');
      const out = {};
      for (const [name, box] of Object.entries(BOXES)) {
        const [x, y, w, h] = box;
        if (x + w > W || y + h > H) continue;
        const d = c.getImageData(x, y, w, h).data;
        let R = 0, G = 0, B = 0, L = 0;
        const ls = [];
        for (let i = 0; i < d.length; i += 4) {
          R += d[i]; G += d[i + 1]; B += d[i + 2];
          const l = 0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2];
          L += l; ls.push(l);
        }
        const n = d.length / 4;
        ls.sort((a, b) => a - b);
        R /= n; G /= n; B /= n;
        const mx = Math.max(R, G, B), mn = Math.min(R, G, B);
        out[name] = {
          rgb: [Math.round(R), Math.round(G), Math.round(B)],
          lum: +(L / n).toFixed(1),
          p50: +ls[n >> 1].toFixed(1),
          p95: +ls[Math.floor(n * 0.95)].toFixed(1),
          sat: +(mx > 0 ? (mx - mn) / mx : 0).toFixed(3),
        };
      }
      return out;
    }, [BOXES, W, H]);
    console.log(`\n== ${f}`);
    for (const [k, v] of Object.entries(r)) {
      console.log(`   ${k.padEnd(7)} rgb(${v.rgb.join(',')})  lum ${String(v.lum).padStart(6)}  p50 ${String(v.p50).padStart(6)}  p95 ${String(v.p95).padStart(6)}  sat ${v.sat}`);
    }
  }
} else if (mode === 'crop') {
  const [f, x, y, w, h, scale, out] = process.argv.slice(3);
  await load(f);
  const b64 = await page.evaluate(([x, y, w, h, s]) => {
    const o = document.createElement('canvas');
    o.width = w * s; o.height = h * s;
    const c = o.getContext('2d');
    c.imageSmoothingEnabled = false;
    c.drawImage(window.__cv, x, y, w, h, 0, 0, w * s, h * s);
    return o.toDataURL('image/png').split(',')[1];
  }, [+x, +y, +w, +h, +scale]);
  writeFileSync(out, Buffer.from(b64, 'base64'));
  console.log('wrote', out);
}
await browser.close();
