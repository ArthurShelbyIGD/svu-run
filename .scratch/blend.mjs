// scratch: is the zone crossfade actually continuous, and is the key
// direction still a unit vector all the way across it?
import { launch, openGame, fastForward } from '../tools/harness.mjs';

const browser = await launch();
const { page } = await openGame(browser, { viewport: 'desktop', query: 'q=high&seed=1&capture' });
await fastForward(page, 6);

const rows = await page.evaluate(() => {
  const S = window.SVU;
  const w = S.ctx.get('world');
  const play = S.ctx.get('play');
  const out = [];
  // walk 400m -> 800m of "read distance" in 10m steps: straight through the
  // Vault -> Ruby boundary at 620m and its 150m crossfade from 470m.
  for (let d = 400; d <= 820; d += 10) {
    w.setZoneBias(d - play.z);
    const k = w.key.direction;
    out.push({
      d,
      len: +Math.sqrt(k.x * k.x + k.y * k.y + k.z * k.z).toFixed(5),
      dir: [+k.x.toFixed(3), +k.y.toFixed(3), +k.z.toFixed(3)],
      I: +w.key.intensity.toFixed(3),
      kc: [+w.key.diffuse.r.toFixed(3), +w.key.diffuse.g.toFixed(3), +w.key.diffuse.b.toFixed(3)],
      amb: +w.ambient.intensity.toFixed(3),
      dark: w.shadowGen ? +w.shadowGen.darkness.toFixed(3) : null,
      fog: +S.scene.fogDensity.toFixed(5),
      env: +S.scene.environmentIntensity.toFixed(3),
    });
  }
  w.setZoneBias(0);
  return out;
});
await browser.close();

let worstLen = 1, worstJump = 0, worstJumpAt = 0, worstJumpWhat = '';
let worstAng = 0, worstAngAt = 0;
let prev = null;
for (const r of rows) {
  worstLen = Math.min(worstLen, r.len);
  if (prev) {
    let dot = r.dir[0] * prev.dir[0] + r.dir[1] * prev.dir[1] + r.dir[2] * prev.dir[2];
    dot = Math.max(-1, Math.min(1, dot));
    const ang = Math.acos(dot) * 180 / Math.PI;
    if (ang > worstAng) { worstAng = ang; worstAngAt = r.d; }
  }
  if (prev) {
    const checks = {
      dirx: [r.dir[0], prev.dir[0], 0.05], diry: [r.dir[1], prev.dir[1], 0.05],
      dirz: [r.dir[2], prev.dir[2], 0.05], I: [r.I, prev.I, 0.30],
      amb: [r.amb, prev.amb, 0.02], dark: [r.dark, prev.dark, 0.03],
      fog: [r.fog, prev.fog, 0.0008], env: [r.env, prev.env, 0.02],
    };
    for (const [name, [a, b, tol]] of Object.entries(checks)) {
      const rel = Math.abs(a - b) / tol;
      if (rel > worstJump) { worstJump = rel; worstJumpAt = r.d; worstJumpWhat = `${name} ${b} -> ${a}`; }
    }
  }
  prev = r;
}
console.log(rows.map((r) => `${String(r.d).padStart(4)}m len=${r.len} dir=[${r.dir}] I=${r.I} amb=${r.amb} dark=${r.dark} fog=${r.fog}`).join('\n'));
console.log(`\nshortest key direction over the whole sweep: ${worstLen}`);
console.log(`largest 10m step, as a fraction of its tolerance: ${worstJump.toFixed(2)} at ${worstJumpAt}m (${worstJumpWhat})`);
console.log(`largest 10m turn of the key: ${worstAng.toFixed(2)} degrees at ${worstAngAt}m`);
