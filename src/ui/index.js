// ui/ — HUD and menus, as plain DOM over the canvas.
//
// OWNERSHIP: this directory owns every pixel of 2D interface. DOM is used
// rather than an in-engine GUI because it costs no draw calls, scales
// correctly on every device pixel ratio for free, and is far easier to make
// accessible.

import { EV } from '../core/ctx.js';

export default class Ui {
  constructor(ctx) {
    this.ctx = ctx;
    this.root = null;
    this.els = {};
    this.score = 0;
    this._shownScore = 0;
    this._offs = [];
  }

  init() {
    const root = document.createElement('div');
    root.id = 'hud';
    root.innerHTML = `
      <div class="hud-top">
        <div class="hud-score"><span id="scoreVal">0</span></div>
        <div class="hud-stars"><span class="star">&#9733;</span><span id="starVal">0</span></div>
      </div>
      <div class="hud-debug" id="debug"></div>
    `;
    document.body.appendChild(root);
    this.root = root;
    this.els.score = root.querySelector('#scoreVal');
    this.els.stars = root.querySelector('#starVal');
    this.els.debug = root.querySelector('#debug');

    this.stars = 0;
    this._offs.push(this.ctx.on(EV.PICKUP_STAR, (p) => {
      this.stars++;
      this.score += (p && p.value) || this.ctx.config.tune.starValue;
      this.els.stars.textContent = this.stars;
    }));
  }

  renderUpdate() {
    const play = this.ctx.tryGet('play');
    if (!play) return;

    const T = this.ctx.config.tune;
    const target = this.score + Math.floor(play.z * T.distanceScorePerMetre);
    // ease the displayed number so it ticks up rather than snapping
    this._shownScore += (target - this._shownScore) * 0.25;
    const shown = Math.floor(this._shownScore);
    if (this.els.score.textContent !== String(shown)) {
      this.els.score.textContent = shown;
    }

    if (this.ctx.config.showDebug) {
      const loop = this.ctx.loop;
      this.els.debug.textContent =
        `${(1000 / Math.max(0.01, loop.medianFrameMs())).toFixed(0)} fps  ` +
        `p95 ${loop.p95FrameMs().toFixed(1)}ms  ` +
        `${this.ctx.config.presetName}  ` +
        `${this.ctx.engine.getActiveMeshes ? '' : ''}` +
        `draws ${this.ctx.scene.getActiveMeshes().length}`;
    }
  }

  dispose() {
    for (const off of this._offs) off();
    this._offs.length = 0;
    if (this.root) this.root.remove();
  }
}
