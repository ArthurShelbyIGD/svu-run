import { launch, openGame } from './harness.mjs';
const b = await launch();
const { page } = await openGame(b, { viewport: 'phone', query: 'q=low&seed=1&capture' });
await page.evaluate(() => window.SVU.loop.advance(6, 2));
const r = await page.evaluate(async () => {
  const play = window.SVU.ctx.get('play');
  const c = window.SVU.ctx.canvas;
  let fired = 0;
  const orig = play.pushIntent.bind(play);
  play.pushIntent = (i) => { if (i) fired++; return orig(i); };
  const fire = (x, y, type) => {
    const t = new Touch({ identifier: 1, target: c, clientX: x, clientY: y });
    c.dispatchEvent(new TouchEvent(type, { changedTouches: [t], touches: type === 'touchend' ? [] : [t], bubbles: true, cancelable: true }));
  };
  // ONE continuous swipe right: 90px in 9 steps of 10px. Threshold is 26px.
  fire(200, 400, 'touchstart');
  for (let i = 1; i <= 9; i++) fire(200 + i * 10, 400, 'touchmove');
  fire(290, 400, 'touchend');
  return { intentsFromOneSwipe: fired };
});
console.log(JSON.stringify(r), r.intentsFromOneSwipe === 1 ? 'PASS' : 'FAIL');
await b.close();
