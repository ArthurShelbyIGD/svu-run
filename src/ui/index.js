// ui/ — HUD, results screen and menus, as plain DOM over the canvas.
//
// OWNERSHIP: this directory owns every pixel of 2D interface. DOM rather than
// an in-engine GUI because it costs no draw calls, scales correctly on every
// device pixel ratio for free, and is far easier to make accessible.

import { EV } from '../core/ctx.js';

export default class Ui {
  constructor(ctx) {
    this.ctx = ctx;
    this.root = null;
    this.els = {};
    this.stars = 0;
    this.starScore = 0;
    this._shownScore = 0;
    this._offs = [];
    this._dead = false;
    this._deadAt = 0;
    this.best = 0;
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
      <div class="over" id="over" aria-hidden="true">
        <div class="over-card">
          <div class="over-title">RUN OVER</div>
          <div class="over-rows">
            <div class="over-row"><span>Score</span><b id="ovScore">0</b></div>
            <div class="over-row"><span>Distance</span><b id="ovDist">0m</b></div>
            <div class="over-row"><span>Stars</span><b id="ovStars">0</b></div>
            <div class="over-row over-best"><span>Best</span><b id="ovBest">0</b></div>
          </div>
          <button class="over-btn" id="again" type="button">RUN AGAIN</button>
          <div class="over-hint">tap, or press space</div>
        </div>
      </div>
    `;
    document.body.appendChild(root);
    this.root = root;
    const $ = (s) => root.querySelector(s);
    this.els = {
      score: $('#scoreVal'), stars: $('#starVal'), debug: $('#debug'),
      over: $('#over'), ovScore: $('#ovScore'), ovDist: $('#ovDist'),
      ovStars: $('#ovStars'), ovBest: $('#ovBest'), again: $('#again'),
    };

    this._offs.push(this.ctx.on(EV.PICKUP_STAR, (p) => {
      this.stars++;
      this.starScore += p.value;
      this.els.stars.textContent = this.stars;
    }));
    this._offs.push(this.ctx.on(EV.RUN_END, (p) => this._showResults(p)));
    this._offs.push(this.ctx.on(EV.RUN_START, () => this._reset()));

    const again = () => this._restart();
    this.els.again.addEventListener('click', again);
    this._againHandler = again;

    // Space / Enter / tap anywhere also restarts, but only after a short
    // delay — otherwise the input that killed you instantly restarts the run.
    const key = (e) => {
      if (!this._dead) return;
      if (e.code === 'Space' || e.code === 'Enter' || e.code === 'KeyR') {
        e.preventDefault();
        this._restart();
      }
    };
    const tap = () => { if (this._dead) this._restart(); };
    window.addEventListener('keydown', key);
    this.els.over.addEventListener('pointerdown', tap);
    this._offs.push(() => {
      window.removeEventListener('keydown', key);
      this.els.over.removeEventListener('pointerdown', tap);
      this.els.again.removeEventListener('click', again);
    });
  }

  get score() {
    const play = this.ctx.tryGet('play');
    const T = this.ctx.config.tune;
    return this.starScore + Math.floor((play ? play.z : 0) * T.distanceScorePerMetre);
  }

  _showResults(p) {
    this._dead = true;
    this._deadAt = performance.now();
    const s = this.score;
    if (s > this.best) this.best = s;
    this.els.ovScore.textContent = s;
    this.els.ovDist.textContent = `${Math.floor(p.distance)}m`;
    this.els.ovStars.textContent = this.stars;
    this.els.ovBest.textContent = this.best;
    this.els.over.classList.add('show');
    this.els.over.setAttribute('aria-hidden', 'false');
  }

  _restart() {
    // Guard against the killing input immediately restarting the run.
    if (performance.now() - this._deadAt < 400) return;
    if (this.ctx.restart) this.ctx.restart();
  }

  _reset() {
    this._dead = false;
    this.stars = 0;
    this.starScore = 0;
    this._shownScore = 0;
    this.els.stars.textContent = '0';
    this.els.score.textContent = '0';
    this.els.over.classList.remove('show');
    this.els.over.setAttribute('aria-hidden', 'true');
  }

  renderUpdate() {
    const play = this.ctx.tryGet('play');
    if (!play) return;

    if (!this._dead) {
      const target = this.score;
      // ease the displayed number so it ticks up rather than snapping
      this._shownScore += (target - this._shownScore) * 0.25;
      const shown = Math.floor(this._shownScore);
      if (this.els.score.textContent !== String(shown)) {
        this.els.score.textContent = shown;
      }
    }

    if (this.ctx.config.showDebug) {
      const loop = this.ctx.loop;
      const track = this.ctx.tryGet('track');
      this.els.debug.textContent =
        `${(1000 / Math.max(0.01, loop.medianFrameMs())).toFixed(0)} fps` +
        `  p95 ${loop.p95FrameMs().toFixed(1)}ms` +
        `  ${this.ctx.config.presetName}` +
        `  meshes ${this.ctx.scene.getActiveMeshes().length}` +
        (track ? `  ob ${track.obstacles.length}  st ${track.stars.length}` +
                 `  diff ${track.difficultyAt(play.z).toFixed(2)}` : '');
    }
  }

  dispose() {
    for (const off of this._offs) off();
    this._offs.length = 0;
    if (this.root) this.root.remove();
  }
}
