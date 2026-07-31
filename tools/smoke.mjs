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

import { launch, openGame, waitFrames, waitGameTime, fastForward, readState } from './harness.mjs';

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

  // These checks exercise input and the state machine, not hazards. Obstacles
  // now exist and will happily kill the test player mid-check, so collision is
  // switched off here and proven separately below.
  await page.evaluate(() => { window.SVU.ctx.get('coll').enabled = false; });

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

  // ---------------- Sprint 1: obstacles, stars, collision, restart ------
  console.log('\ngameplay systems');
  const g = await openGame(browser, { viewport: 'phone', query: 'q=low&seed=7' });
  // Collision off from the very first step. Without this the test player dies
  // on the first chunk (correctly — nobody is steering it) and every
  // subsequent measurement is taken on a corpse that stopped at 50m.
  await g.page.evaluate(() => { window.SVU.ctx.get('coll').enabled = false; });
  await fastForward(g.page, 4);

  const gen = await g.page.evaluate(() => {
    const t = window.SVU.ctx.get('track');
    return { obstacles: t.obstacles.length, stars: t.stars.length, chunks: t.chunkCount };
  });
  check('chunks generate obstacles', gen.obstacles > 0, `${gen.obstacles} live`);
  check('chunks generate stars', gen.stars > 0, `${gen.stars} live`);
  check('chunk grammar advanced', gen.chunks >= 4, `${gen.chunks} chunks`);

  // Solvability: scan a long generated run and assert no simultaneous group
  // blocks every lane. validateTemplates() proves each template in isolation;
  // this proves the assembled output too.
  // Collision is off for this scan — the point is to inspect what the grammar
  // produces over a long run, and a live player would die in the first chunk.
  const solv = await g.page.evaluate(() => {
    const S = window.SVU;
    const track = S.ctx.get('track');
    S.ctx.get('coll').enabled = false;
    const OB_FULL = 2;
    const groups = new Map();
    const play = S.ctx.get('play');
    let scanned = 0;
    // Corners kill independently of collision (that check lives in play/, not
    // coll/), so the scanner has to actually drive the turns or it stops dead
    // at the first junction and silently scans 380m instead of several km.
    for (let pass = 0; pass < 3600; pass++) {
      for (const o of track.obstacles) {
        const key = Math.round(o.z / 1.5);
        if (!groups.has(key)) groups.set(key, new Set());
        if (o.kind === OB_FULL) groups.get(key).add(o.lane);
        scanned++;
      }
      if (play.inTurnZone && play.junction) {
        play.pushIntent(play.junction.turn < 0 ? 1 : 2);
      }
      S.loop.advance(1 / 20, 0);
      if (!play.alive) break;
    }
    let worst = 0;
    for (const s of groups.values()) worst = Math.max(worst, s.size);
    return { worst, scanned, groups: groups.size, z: play.z, alive: play.alive };
  });
  check('no generated group blocks all lanes', solv.worst < 3 && solv.z > 2000,
    `worst group blocks ${solv.worst}/3 lanes over ${Math.round(solv.z)}m, ${solv.groups} groups`);

  // Star collection: park the player in a star's lane and run through it.
  const starRes = await g.page.evaluate(() => {
    const S = window.SVU;
    S.ctx.restart();
    const play = S.ctx.get('play');
    const track = S.ctx.get('track');
    const coll = S.ctx.get('coll');
    coll.enabled = true;

    // Find a ground-level star, skipping past obstacles so only the star
    // outcome is under test.
    let target = null;
    for (let tries = 0; tries < 4000 && !target; tries++) {
      target = track.stars.find((s) => s.z > play.z + 14 && s.y < 1.4) || null;
      if (target) break;
      if (play.inTurnZone && play.junction) play.pushIntent(play.junction.turn < 0 ? 1 : 2);
      S.loop.advance(1 / 30, 0);
      if (!play.alive) return { ok: false, reason: 'search run died at ' + play.z.toFixed(0) };
    }
    if (!target) return { ok: false, reason: 'no reachable star found' };

    play.lane = play.laneTarget = Math.round(target.x / S.config.tune.laneWidth + 1);
    play.laneT = 1;
    let collected = 0;
    const off = S.ctx.on('pickup:star', () => collected++);
    const guard = target.z + 6;
    let steps = 0;
    while (play.z < guard && play.alive && steps < 8000) {
      // keep obstacles from ending the run: this test is about stars only
      track.obstacles.length = 0;
      if (play.inTurnZone && play.junction) play.pushIntent(play.junction.turn < 0 ? 1 : 2);
      S.loop.advance(1 / 60, 0);
      steps++;
    }
    off();
    return { ok: collected > 0, collected, alive: play.alive };
  });
  check('stars can be collected', starRes.ok,
    starRes.reason || `${starRes.collected} collected`);

  // Collision: aim the player at a full-height block and confirm it kills.
  const hitRes = await g.page.evaluate(() => {
    const S = window.SVU;
    S.ctx.restart();
    const play = S.ctx.get('play');
    const track = S.ctx.get('track');
    const coll = S.ctx.get('coll');
    const OB_FULL = 2;

    // Search forward for a block, with collision off so the search survives.
    coll.enabled = false;
    // Corner death is decided in play/, not coll/, so disabling collision is
    // not enough to keep a search loop alive — it must steer the turns too.
    let target = null;
    for (let tries = 0; tries < 4000 && !target; tries++) {
      target = track.obstacles.find((o) => o.kind === OB_FULL && o.z > play.z + 14) || null;
      if (target) break;
      if (play.inTurnZone && play.junction) play.pushIntent(play.junction.turn < 0 ? 1 : 2);
      S.loop.advance(1 / 30, 0);
      if (!play.alive) return { ok: false, reason: 'search run died at ' + play.z.toFixed(0) };
    }
    if (!target) return { ok: false, reason: 'no block found ahead' };

    play.lane = play.laneTarget = target.lane;
    play.laneT = 1;
    // Isolate the target. Otherwise the player dies on some earlier obstacle
    // and the check passes without ever testing what it claims to test.
    track.obstacles = track.obstacles.filter((o) => o === target);
    coll.enabled = true;
    coll._prevZ = play.z;
    const guard = target.z + 8;
    let steps = 0;
    while (play.z < guard && play.alive && steps < 8000) {
      if (play.inTurnZone && play.junction) play.pushIntent(play.junction.turn < 0 ? 1 : 2);
      S.loop.advance(1 / 60, 0);
      steps++;
    }
    // Died at the block, not somewhere else entirely.
    const atBlock = !play.alive && Math.abs(play.z - target.z) < 3;
    return { ok: atBlock, z: play.z, targetZ: target.z, alive: play.alive };
  });
  check('full-height block kills the player', hitRes.ok,
    hitRes.reason || `died at z=${(hitRes.z || 0).toFixed(1)}, block at ${(hitRes.targetZ || 0).toFixed(1)}`);

  // A hurdle must be clearable by jumping — otherwise the game is unplayable
  // regardless of how well collision "works".
  const clearRes = await g.page.evaluate(() => {
    const S = window.SVU;
    S.ctx.restart();
    const play = S.ctx.get('play');
    const track = S.ctx.get('track');
    const coll = S.ctx.get('coll');
    const OB_LOW = 0;

    coll.enabled = false;
    let target = null;
    for (let tries = 0; tries < 4000 && !target; tries++) {
      target = track.obstacles.find((o) => o.kind === OB_LOW && o.z > play.z + 20) || null;
      if (target) break;
      if (play.inTurnZone && play.junction) play.pushIntent(play.junction.turn < 0 ? 1 : 2);
      S.loop.advance(1 / 30, 0);
      if (!play.alive) return { ok: false, reason: 'search run died at ' + play.z.toFixed(0) };
    }
    if (!target) return { ok: false, reason: 'no hurdle found ahead' };

    play.lane = play.laneTarget = target.lane;
    play.laneT = 1;
    // remove everything except the hurdle so only it is under test
    track.obstacles = track.obstacles.filter((o) => o === target);
    coll.enabled = true;
    coll._prevZ = play.z;

    let jumped = false;
    let steps = 0;
    while (play.z < target.z + 6 && play.alive && steps < 8000) {
      if (play.inTurnZone && play.junction) {
        play.pushIntent(play.junction.turn < 0 ? 1 : 2);
      } else if (!jumped && target.z - play.z < play.speed * 0.30) {
        // jump when the take-off point arrives
        play.pushIntent(3);
        jumped = true;
      }
      S.loop.advance(1 / 60, 0);
      steps++;
    }
    return { ok: play.alive && jumped, alive: play.alive, jumped };
  });
  check('hurdles are clearable by jumping', clearRes.ok,
    clearRes.reason || `jumped=${clearRes.jumped} survived=${clearRes.alive}`);

  // Restart must return everything to a clean start.
  const restarted = await g.page.evaluate(async () => {
    const S = window.SVU;
    S.ctx.restart();
    await new Promise((r) => setTimeout(r, 60));
    const play = S.ctx.get('play');
    const track = S.ctx.get('track');
    return { alive: play.alive, z: play.z, time: S.ctx.time, chunks: track.chunkCount };
  });
  check('restart revives the player', restarted.alive === true);
  check('restart resets distance and clock',
    restarted.z < 1 && restarted.time < 1,
    `z=${restarted.z.toFixed(2)} t=${restarted.time.toFixed(2)}`);

  // High-speed tunnelling: at max speed a step covers more ground than an
  // obstacle is deep, so the sweep must catch it. This is the check that
  // proves the swept test rather than a point test.
  const tunnel = await g.page.evaluate(() => {
    const S = window.SVU;
    const play = S.ctx.get('play');
    const track = S.ctx.get('track');
    const OB_FULL = 2;
    S.ctx.restart();
    S.ctx.get('coll').enabled = false;
    let target = null;
    for (let tries = 0; tries < 4000 && !target; tries++) {
      target = track.obstacles.find((o) => o.kind === OB_FULL && o.z > play.z + 14) || null;
      if (target) break;
      if (play.inTurnZone && play.junction) play.pushIntent(play.junction.turn < 0 ? 1 : 2);
      S.loop.advance(1 / 30, 0);
      if (!play.alive) return { ok: false, reason: 'search run died at ' + play.z.toFixed(0) };
    }
    if (!target) return { ok: false, reason: 'no block ahead' };
    play.lane = play.laneTarget = target.lane;
    play.laneT = 1;
    play.x = target.x;
    // Drive coll/ directly at max speed. Stepping z by hand deliberately skips
    // play.fixedUpdate, which keeps corners out of the picture entirely — this
    // check is about the collision sweep and nothing else.
    S.ctx.get('coll').enabled = true;
    S.ctx.get('coll')._prevZ = play.z;
    track.obstacles = track.obstacles.filter((o) => o === target);
    const guard = target.z + 6;
    let steps = 0;
    while (play.z < guard && play.alive && steps < 4000) {
      play.z += S.config.tune.maxSpeed / 60;
      S.ctx.get('coll').fixedUpdate();
      steps++;
    }
    return { ok: !play.alive };
  });
  check('no tunnelling through blocks at max speed', tunnel.ok, tunnel.reason || '');

  // ---- particle effects ----
  const fxRes = await g.page.evaluate(() => {
    const S = window.SVU;
    S.ctx.restart();
    const fx = S.ctx.get('fx');
    const before = fx.alive;
    S.ctx.get('fx').burstStar({ x: 0, y: 1, z: S.ctx.get('play').z + 1 });
    S.loop.advance(0, 1);
    const afterBurst = fx.alive;
    // run long enough for every particle to expire
    for (let i = 0; i < 200; i++) S.loop.advance(0, 1);
    const settled = fx.alive;
    // pool must never be exceeded, however hard it is hammered
    for (let n = 0; n < 400; n++) fx.burstDeath();
    S.loop.advance(0, 1);
    return { before, afterBurst, settled, capped: fx.alive, pool: fx.count };
  });
  check('particles spawn on pickup', fxRes.afterBurst > fxRes.before,
    `${fxRes.before} -> ${fxRes.afterBurst}`);
  check('particles expire', fxRes.settled === 0, `${fxRes.settled} still alive`);
  check('particle pool is a hard cap', fxRes.capped <= fxRes.pool,
    `${fxRes.capped} alive, pool ${fxRes.pool}`);

  // ---- junction turns ----
  const turnRes = await g.page.evaluate(() => {
    const S = window.SVU;
    const play = S.ctx.get('play');
    const cam = S.scene.activeCamera;
    const run = (mode) => {
      S.ctx.restart();
      S.ctx.get('coll').enabled = false;   // obstacles are tested elsewhere
      let maxCamJump = 0;
      let lastCam = null;
      for (let i = 0; i < 9000; i++) {
        if (play.inTurnZone && play.junction) {
          if (mode === 'correct') play.pushIntent(play.junction.turn < 0 ? 1 : 2);
          if (mode === 'wrong')   play.pushIntent(play.junction.turn < 0 ? 2 : 1);
        }
        S.loop.advance(1 / 60, 1);
        if (lastCam) {
          const d = Math.hypot(cam.position.x - lastCam[0], cam.position.z - lastCam[1]);
          if (d > maxCamJump) maxCamJump = d;
        }
        lastCam = [cam.position.x, cam.position.z];
        if (!play.alive) break;
      }
      window.__maxCamJump = maxCamJump;
      const track = S.ctx.get('track');
      const p = track.path;
      const w = [0, 0, 0];
      p.toWorld(play.z, play.x, play.y, w);
      // Sweep the outer lane across every corner and measure the largest
      // single-step jump in WORLD space. Before the frame blend this was a
      // 3.4m instant teleport, which no state-based check could ever see.
      let maxStep = 0;
      const a = [0, 0, 0], b = [0, 0, 0];
      const lat = S.config.tune.laneWidth;
      for (const seg of p.segments) {
        if (seg.turn === 0) continue;
        const js = seg.s0 + seg.len;
        for (let d = -6; d < 6; d += 0.2) {
          p.toWorld(js + d, lat, 0, a);
          p.toWorld(js + d + 0.2, lat, 0, b);
          const step = Math.hypot(b[0] - a[0], b[2] - a[2]);
          if (step > maxStep) maxStep = step;
        }
      }
      return {
        z: +play.z.toFixed(0), turns: play.turnsMade, alive: play.alive,
        finite: Number.isFinite(w[0]) && Number.isFinite(w[2]),
        segs: p.segments.length, maxStep, maxCamJump,
      };
    };
    return { correct: run('correct'), never: run('never'), wrong: run('wrong') };
  });

  check('turning correctly survives many corners',
    turnRes.correct.alive && turnRes.correct.turns >= 4,
    `${turnRes.correct.turns} turns, ${turnRes.correct.z}m`);
  check('failing to turn ends the run',
    !turnRes.never.alive && turnRes.never.turns === 0,
    `died at ${turnRes.never.z}m`);
  check('turning the wrong way ends the run',
    !turnRes.wrong.alive,
    `died at ${turnRes.wrong.z}m`);
  check('world stays finite after many corners', turnRes.correct.finite);
  check('corner path is continuous — no sideways teleport', turnRes.correct.maxStep < 1.2,
    `largest single-step world jump ${turnRes.correct.maxStep.toFixed(2)}m in the outer lane`);
  // The camera is smoothed in path space precisely so it cannot cut a corner
  // and swing through the barrier. A world-space lerp would show up here as a
  // large per-frame jump at every junction.
  check('camera never whips through a corner', turnRes.correct.maxCamJump < 0.9,
    `largest per-step camera move ${turnRes.correct.maxCamJump.toFixed(2)}m`);
  check('path segments are pruned, not accumulated',
    turnRes.correct.segs < 40, `${turnRes.correct.segs} segments after ${turnRes.correct.z}m`);

  await g.context.close();

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
