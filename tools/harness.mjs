// Shared browser harness for the tooling.
//
// IMPORTANT CAVEAT, read before trusting any number this produces:
// headless Chromium here renders through SwiftShader (software). Visual output
// is faithful — colours, geometry, materials, post-processing all match a real
// GPU closely enough to grade against. Frame timings are NOT. Treat perf
// numbers from this harness as a relative signal between builds only. Real
// performance verdicts come from a real device.

import { chromium } from 'playwright';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';
import { readdirSync, existsSync } from 'node:fs';

export const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
export const BUILD = join(ROOT, 'docs', 'svu-run.html');

const GL_ARGS = [
  '--use-gl=angle',
  '--use-angle=swiftshader',
  '--enable-unsafe-swiftshader',
  '--disable-lcd-text',
  '--force-device-scale-factor=1',
  '--hide-scrollbars',
];

/** Standard viewports. Names are used in screenshot filenames. */
export const VIEWPORTS = {
  desktop: { width: 1600, height: 900, deviceScaleFactor: 1, isMobile: false },
  laptop:  { width: 1280, height: 800, deviceScaleFactor: 1, isMobile: false },
  phone:   { width: 390,  height: 844, deviceScaleFactor: 2, isMobile: true, hasTouch: true },
  tablet:  { width: 820,  height: 1180, deviceScaleFactor: 2, isMobile: true, hasTouch: true },
};

// This container ships a pinned Chromium that may not match the Playwright
// package's expected build number, and browser downloads are disabled. Find a
// usable binary on disk rather than letting Playwright try to fetch one.
function findChromium() {
  if (process.env.PW_CHROMIUM) return process.env.PW_CHROMIUM;
  const base = process.env.PLAYWRIGHT_BROWSERS_PATH || '/opt/pw-browsers';
  let dirs = [];
  try {
    dirs = readdirSync(base)
      .filter((d) => d.startsWith('chromium-'))
      .sort((a, b) => parseInt(b.split('-')[1], 10) - parseInt(a.split('-')[1], 10));
  } catch { return undefined; }
  for (const d of dirs) {
    const p = join(base, d, 'chrome-linux', 'chrome');
    if (existsSync(p)) return p;
  }
  return undefined;
}

export async function launch() {
  return chromium.launch({
    args: GL_ARGS,
    executablePath: findChromium(),
  });
}

/**
 * Open the build in a page and wait until the game reports ready.
 * Returns { page, context, errors } — `errors` collects console errors and
 * page exceptions, which the smoke test treats as failures.
 */
export async function openGame(browser, {
  viewport = 'desktop',
  query = '',
  timeout = 60000,
} = {}) {
  const vp = VIEWPORTS[viewport] || VIEWPORTS.desktop;
  const context = await browser.newContext({
    viewport: { width: vp.width, height: vp.height },
    deviceScaleFactor: vp.deviceScaleFactor,
    isMobile: vp.isMobile,
    hasTouch: !!vp.hasTouch,
    reducedMotion: 'no-preference',
  });

  const errors = [];
  const page = await context.newPage();
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(`console: ${m.text()}`);
  });
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));

  const url = pathToFileURL(BUILD).href + (query ? `?${query}` : '');
  await page.goto(url, { waitUntil: 'load', timeout });
  await page.waitForFunction(() => window.SVU && window.SVU.ready === true, null, { timeout });

  return { page, context, errors, viewport: vp };
}

/** Let the game run for `seconds` of wall clock. */
export async function settle(page, seconds) {
  await page.waitForTimeout(seconds * 1000);
}

/**
 * Wait for N *rendered frames* rather than N seconds.
 *
 * This matters more than it looks: software rendering here can be 20x slower
 * than a real GPU, so any wall-clock wait is really a wait for an unknown and
 * wildly variable number of simulation steps. Frame-based waits make the
 * tooling deterministic regardless of how slow the renderer is.
 */
export async function waitFrames(page, n, timeout = 60000) {
  const start = await page.evaluate(() => window.SVU.loop.frameCount);
  await page.waitForFunction(
    (target) => window.SVU.loop.frameCount >= target,
    start + n,
    { timeout, polling: 50 },
  );
}

/**
 * Step the simulation forward by `seconds` of game time instantly, without
 * waiting for frames. Deterministic and fast — the right tool for posing a
 * capture. Use waitGameTime instead when you are specifically testing that the
 * real render loop drives the simulation.
 */
export async function fastForward(page, seconds, renderSteps = 8) {
  return page.evaluate(
    ([s, r]) => {
      const S = window.SVU;
      S.loop.advance(s, r);
      // The camera is smoothed towards the player over time. Jumping the
      // simulation 25 seconds forward instantly leaves it hundreds of metres
      // behind, and every screenshot is then taken from the wrong place —
      // which looked like "the corner geometry is tiny and unreadable" rather
      // than like a camera bug. Snap it, then re-settle.
      const play = S.ctx.tryGet('play');
      if (play) play._camInit = false;
      S.loop.advance(0, 3);
      return S.ctx.time;
    },
    [seconds, renderSteps],
  );
}

/** Wait until the simulation clock has advanced by `seconds` of game time. */
export async function waitGameTime(page, seconds, timeout = 60000) {
  const start = await page.evaluate(() => window.SVU.ctx.time);
  await page.waitForFunction(
    (target) => window.SVU.ctx.time >= target,
    start + seconds,
    { timeout, polling: 50 },
  );
}

/** Read a snapshot of engine + gameplay state out of the page. */
export async function readState(page) {
  return page.evaluate(() => {
    const S = window.SVU;
    const play = S.ctx.tryGet('play');
    return {
      preset: S.config.presetName,
      time: S.ctx.time,
      frames: S.loop.frameCount,
      medianFrameMs: S.loop.medianFrameMs(),
      p95FrameMs: S.loop.p95FrameMs(),
      activeMeshes: S.scene.getActiveMeshes().length,
      totalMeshes: S.scene.meshes.length,
      materials: S.scene.materials.length,
      drawCalls: S.engine._drawCalls ? S.engine._drawCalls.current : null,
      player: play ? {
        z: play.z, x: play.x, y: play.y,
        lane: play.lane, state: play.state, speed: play.speed, alive: play.alive,
      } : null,
    };
  });
}

export { join };
