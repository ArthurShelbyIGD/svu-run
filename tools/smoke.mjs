// Smoke test. Must pass before any sprint is called done.
//
// Checks, in order:
//   1. the build loads and boots without console errors
//   2. the simulation actually advances (the player moves forward)
//   3. input works — lane change, jump and slide all register
//   4. tile recycling keeps the mesh count bounded (no leak)
//   5. it boots on a phone viewport, and on the high preset
//
// All waits are frame-based or game-time-based, never wall-clock: this
// harness renders in software and is 10-20x slower than a real GPU, so
// wall-clock waits would be flaky by construction.
//
// Exit code 0 = pass, 1 = fail. Designed to be run unattended by agents.

import { launch, openGame, waitFrames, waitGameTime, readState } from './harness.mjs';

const checks = [];
function check(name, ok, detail = '') {
  checks.push({ name, ok, detail });
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);
}

const browser = await launch();
let failed = false;

try {
  // ---------------- gameplay logic, small viewport / low preset ----------
  console.log('\ngameplay  (640x400, q=low)');
  const { page, context, errors } = await openGame(browser, {
    viewport: 'phone', query: 'q=low&seed=1',
  });

  await waitGameTime(page, 1.5);
  const a = await readState(page);

  check('boots without console errors', errors.length === 0, errors.slice(0, 3).join(' | '));
  check('simulation advances', a.player && a.player.z > 5,
    a.player ? `z=${a.player.z.toFixed(1)}m` : 'no player');
  check('frames are being produced', a.frames > 3, `${a.frames} frames`);
  check('meshes are active', a.activeMeshes > 5,
    `${a.activeMeshes} active / ${a.totalMeshes} total`);

  // ---- lane change ----
  const laneBefore = a.player.lane;
  await page.keyboard.press('ArrowLeft');
  await waitGameTime(page, 0.4);
  const b = await readState(page);
  check('lane change responds', b.player.lane !== laneBefore,
    `lane ${laneBefore} -> ${b.player.lane}, x=${b.player.x.toFixed(2)}`);

  await page.keyboard.press('ArrowRight');
  await waitGameTime(page, 0.4);
  const b2 = await readState(page);
  check('lane change back responds', b2.player.lane === laneBefore,
    `lane -> ${b2.player.lane}`);

  // ---- jump ---- (sample mid-flight: after ~25% of the jump duration)
  await page.keyboard.press('Space');
  await waitGameTime(page, 0.15);
  const c = await readState(page);
  check('jump leaves the ground', c.player.y > 0.15, `y=${c.player.y.toFixed(2)}m`);
  check('jump enters AIR state', c.player.state === 1, `state=${c.player.state}`);

  await waitGameTime(page, 1.0);
  const c2 = await readState(page);
  check('jump lands again', c2.player.y === 0 && c2.player.state === 0,
    `y=${c2.player.y.toFixed(2)} state=${c2.player.state}`);

  // ---- slide ----
  await page.keyboard.press('ArrowDown');
  await waitGameTime(page, 0.15);
  const d = await readState(page);
  check('slide enters SLIDE state', d.player.state === 2, `state=${d.player.state}`);

  await waitGameTime(page, 1.0);
  const d2 = await readState(page);
  check('slide ends by itself', d2.player.state === 0, `state=${d2.player.state}`);

  // ---- leak / pooling ----
  const meshesBefore = a.totalMeshes;
  await waitGameTime(page, 12);
  const e = await readState(page);
  check('mesh count stays bounded (pooling works)',
    e.totalMeshes <= meshesBefore + 2, `${meshesBefore} -> ${e.totalMeshes}`);
  check('still running after 16s of game time', e.player.z > a.player.z + 100,
    `z=${e.player.z.toFixed(0)}m`);

  console.log(`  note: software-rendered timings, relative only — ` +
    `median ${e.medianFrameMs.toFixed(0)}ms, p95 ${e.p95FrameMs.toFixed(0)}ms`);
  await context.close();

  // ---------------- high preset boots at all ----------------------------
  console.log('\nhigh preset  (1600x900, q=high)');
  const h = await openGame(browser, { viewport: 'desktop', query: 'q=high&debug&seed=1' });
  await waitFrames(h.page, 3);
  const hs = await readState(h.page);
  check('high preset boots clean', h.errors.length === 0, h.errors.slice(0, 3).join(' | '));
  check('high preset renders', hs.frames >= 3 && hs.activeMeshes > 5,
    `${hs.frames} frames, ${hs.activeMeshes} meshes`);
  await h.context.close();

  // ---------------- touch input on a phone viewport ---------------------
  console.log('\ntouch  (390x844 @2x)');
  const m = await openGame(browser, { viewport: 'phone', query: 'q=low&seed=1' });
  await waitGameTime(m.page, 1.0);
  const before = await readState(m.page);

  // swipe left: down at x=300, up at x=150, well inside the swipe time budget
  await m.page.touchscreen.tap(300, 500);
  await m.page.evaluate(() => {
    const c = document.getElementById('c');
    const mk = (type, x, y) => {
      const t = new Touch({ identifier: 1, target: c, clientX: x, clientY: y });
      c.dispatchEvent(new TouchEvent(type, {
        bubbles: true, cancelable: true, touches: type === 'touchend' ? [] : [t],
        changedTouches: [t], targetTouches: type === 'touchend' ? [] : [t],
      }));
    };
    mk('touchstart', 300, 500);
    mk('touchend', 150, 505);
  });
  await waitGameTime(m.page, 0.4);
  const after = await readState(m.page);
  check('swipe changes lane', after.player.lane !== before.player.lane,
    `lane ${before.player.lane} -> ${after.player.lane}`);
  await m.context.close();

} catch (err) {
  console.error('\nharness error:', err.message);
  failed = true;
} finally {
  await browser.close();
}

const bad = checks.filter((c) => !c.ok);
console.log(`\n${checks.length - bad.length}/${checks.length} checks passed`);
if (bad.length || failed) {
  console.log('SMOKE TEST FAILED');
  process.exit(1);
}
console.log('SMOKE TEST PASSED');
