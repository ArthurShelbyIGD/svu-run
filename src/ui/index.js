// ui/ — HUD, start screen, pause and results, as plain DOM over the canvas.
//
// OWNERSHIP: this directory owns every pixel of 2D interface. DOM rather than
// an in-engine GUI because it costs no draw calls, scales correctly on every
// device pixel ratio for free, and is far easier to make accessible.
//
// ---------------------------------------------------------------------------
// THE LOOK. The hall is near-black with a gold sun at the vanishing point (see
// shots/hero.png). The interface therefore speaks two colours on that black:
// GOLD for anything that is an accent or a value worth having, OFF-WHITE for
// everything else. Fine serif letterforms, generous letter-spacing, hairline
// rules, a lot of empty space. No bevels, no drop shadows, no neon. The old
// placeholder set ink (#2b2723) on that black hall and the score was literally
// invisible in the hero shot — measure before you trust a colour here.
//
// ---------------------------------------------------------------------------
// FIVE TRAPS THIS FILE HAS ALREADY PAID FOR. All five passed the test suite
// and were only ever visible in a captured frame. Do not re-introduce them.
//
//  1. AN UNOPENED COMMENT TERMINATOR inside the CSS string made an ENTIRE
//     panel background render transparent: CSS error recovery skips to the
//     next semicolon, which happened to be the end of the background rule.
//     Build green, smoke green, title card a bare backdrop.
//     => THE CSS STRING BELOW CONTAINS NO COMMENTS AT ALL. Explain CSS in JS
//        comments above the template literal, never inside it.
//
//  2. A `#svu-ui *` reset out-specified its own class rules — id+universal is
//     (1,0,0), a class is (0,1,0) — and killed every safe-area padding and
//     every button padding. The distance ran half off the top of a phone and
//     BEGIN shrank to a ~20px tap target, i.e. the only way into the game was
//     almost untappable.
//     => There is NO reset here. shell/template.html already applies
//        `* { margin:0; padding:0; box-sizing:border-box }` globally, so one
//        is not needed. If one is ever needed, write it as
//        `:where(#svu-ui, #svu-ui *)`, which is (0,0,0).
//
//  3. THE START SCREEN MUST NOT PAUSE THE LOOP. `ctx.loop.setPaused(true)` at
//     boot takes the gate RED: smoke's first section polls ctx.time against
//     the real render loop 1.5s after boot and then runs to a 180s timeout.
//     => The run is live behind a near-opaque panel. The unsteered player dies
//        behind it; that throwaway RUN_END is IGNORED while phase !== 'run'.
//        BEGIN calls ctx.restart(), which revives everything.
//
//  4. BEGIN ANSWERS TO ENTER, NOT SPACE. Smoke presses Space, ArrowLeft,
//     ArrowRight, ArrowDown, KeyP and KeyM while the panel is up. Enter is the
//     only key it never sends. Same reason KeyP only pauses while phase is
//     'run' — smoke presses KeyP to unlock the AudioContext with a trusted
//     gesture while the start screen is still up.
//     Also: CAPTURE MODE SKIPS THE START SCREEN, or every pose is a title card.
//
//  5. NO BACKDROP-FILTER. A full-screen blur is unverified on the owner's
//     low-end rugged Android and is the classic way to lose a phone's frame
//     budget to the compositor. The panels are near-opaque gradients instead,
//     which is both cheaper and a better read against a black hall.
//
// Also: env(safe-area-inset-*) has never been observed non-zero in this
// harness (no notch), so every use of it is `calc(env(...) + a real number)`
// and never relied on alone. And storage APIs are NOT available where this
// ships — `best` lives in a module variable and dies with the tab. Do not
// reach for localStorage.
//
// ---------------------------------------------------------------------------
// THE POWERUP CHIPS. Contract: `ctx.get('play').pw` — see the header of
// src/play/powerups.js. Three slots in a FIXED order (MAGNET, SHIELD, GLIDE),
// never reallocated, so this file can hold three DOM rows that map 1:1 to them
// and never search, sort or rebuild anything.
//
//  - THE STACK RESERVES ALL THREE ROWS AND HIDES THE INACTIVE ONES with
//    `visibility`, not `display`. A chip therefore always appears in the same
//    place, so where a thing is becomes a second channel on top of what it
//    says. `display:none` collapsed the stack and made two powerups running
//    down together into a row that jumped every time one ended.
//
//  - BOTTOM LEFT, measured against shots/phone.png. Distance owns the top
//    left, stars the top right, SOUND/PAUSE the bottom right, and the runner
//    occupies x 115..290 of 390 from y 415 down. The bottom-left corner is the
//    only piece of a portrait frame that is neither furniture nor track: it is
//    dark pavement, so a near-black chip with a gold hairline reads on it and
//    covers nothing the player has to see.
//
//  - THE SHIELD IS A CHARGE, NOT A CLOCK, so it is not drawn as one. Magnet
//    and glide get a hairline that DRAINS left to right on remaining/total.
//    The shield gets a HELD state instead: gold-washed field, gold border at
//    double the strength, a filled gold lozenge before the word, and a bar
//    that sits full and lit and never moves. Three signals, no clock.
//
//  - THE SPEND IS THE WHOLE POINT. An absorbed hit that looks like nothing
//    reads as a bug — the player expected to die and did not. So a spend gets
//    a full-frame GOLD flash (0.34s) plus the chip flaring to ABSORBED and
//    holding for 0.9s after the charge is gone. GOLD, not red: red in this
//    game is always a hazard edge (see the colour contract) and a save is not
//    a hazard. It is detected by POLLING `pw.lastSpent`, which is exactly what
//    that field is for — the END event payload is pooled and a poll cannot
//    miss the edge, only be one frame late.
//
//  - COST. The per-frame work is three slot reads, one float compare and, at
//    most, one `style.transform` write per timed chip — and that write only
//    happens when the fill changes by a whole percent, which is ~14 writes a
//    second rather than 60. The 101 transform strings are BUILT ONCE in init
//    (`_sx`) so the frame path allocates nothing at all.

import { EV } from '../core/ctx.js';

// Survives a restart, not a reload. See the note above: no storage APIs here.
let BEST_METRES = 0;
let BEST_STARS = 0;

const MILESTONE_EVERY = 500;

/** Slot order is the powerup contract's order and is never anything else. */
const PW_SHIELD = 1;
const PW_SLOTS = 3;
/** How long the spent shield chip stays up shouting after the charge is gone. */
const SPEND_HOLD = 0.9;
/** How long the full-frame gold flash lasts. Matches the CSS fade-out. */
const SPEND_FLASH = 0.34;

export default class Ui {
  constructor(ctx) {
    this.ctx = ctx;
    this.root = null;
    this.els = {};
    this._offs = [];

    /** 'start' | 'run' | 'paused' | 'over' */
    this.phase = 'start';
    this._begun = false;

    this.stars = 0;
    this.starScore = 0;
    this.best = 0;

    this._shownDist = -1;
    this._shownStars = -1;
    this._deadAt = 0;
    this._toastT = 0;
    this._milestone = 0;
    this._muteShown = null;
    this._edgeT = 0;
    this._edgeSeq = -1;
    this._starT = 0;

    // --- powerup chips. Fixed length 3, in the contract's slot order. ---
    /** Which chips are currently up, so the class only gets touched on a change. */
    this._pwOn = [false, false, false];
    /** Last fill written per chip, in whole percent. -1 means "never written". */
    this._pwFill = [-1, -1, -1];
    /** pw.lastSpent as last seen. The spend edge is a poll, not an event. */
    this._spentAt = -1;
    this._spentT = 0;
    this._flashT = 0;
    /**
     * 101 pre-built transform strings, 0% .. 100%. The alternative is building
     * a string every time a bar moves, which is an allocation in the frame
     * path, which is the one thing ARCHITECTURE.md §4.1 forbids outright.
     */
    this._sx = new Array(101);
    for (let i = 0; i <= 100; i++) this._sx[i] = `scaleX(${i / 100})`;
  }

  // ---- boot ------------------------------------------------------------

  init() {
    this._injectCss();
    this._buildDom();
    this._bind();

    // Capture mode must never open on a title card. Everything else opens on
    // the start screen, live run humming away behind it.
    this.phase = this.ctx.config.captureMode ? 'run' : 'start';
    this._begun = this.phase === 'run';
    // A panel caught mid-fade is a stale screenshot with extra steps. Captures
    // are deterministic or they are worthless, so opacity transitions are off
    // in capture mode.
    if (this.ctx.config.captureMode) this.root.classList.add('svu-nofade');
    // The debug readout lives in the bottom-left corner and so does the chip
    // stack. Only one of them can have it, and in debug mode the chips move up.
    if (this.ctx.config.showDebug) this.root.classList.add('svu-dbg');
    this._applyPhase();
    this._syncMute();
  }

  // The CSS lives here rather than in shell/template.html because the shell is
  // lead-owned and this directory owns every pixel of interface. One <style>
  // node, injected once, removed in dispose().
  //
  // Notes on choices that are not obvious:
  //  - `.svu-hud-scrim` is a single linear-gradient, not a blur. The distance
  //    readout sits over whatever the hall is doing; a 96px dark gradient at
  //    the top guarantees the read for the cost of one gradient, and the sun
  //    at the vanishing point is bright enough that it is genuinely needed.
  //  - `text-indent` equal to `letter-spacing` on every centred, tracked-out
  //    line. Letter-spacing appends a trailing space after the final glyph, so
  //    centred tracked text sits visibly left of centre without it.
  //  - the icon buttons carry real padding and a min-height so the tap target
  //    is 44px even though the label is 9px. See trap 2.
  _injectCss() {
    const css = `
#svu-ui {
  position: fixed;
  inset: 0;
  z-index: 20;
  pointer-events: none;
  color: #f2ece1;
  font-family: "Cormorant Garamond", "Didot", "Bodoni MT", "Hoefler Text", "Playfair Display", "Times New Roman", Times, serif;
  -webkit-font-smoothing: antialiased;
  text-rendering: optimizeLegibility;
}

.svu-hud {
  position: absolute;
  inset: 0;
  pointer-events: none;
  opacity: 0;
  visibility: hidden;
  transition: opacity .45s ease, visibility 0s linear .45s;
}
.svu-hud.svu-on {
  opacity: 1;
  visibility: visible;
  transition: opacity .45s ease, visibility 0s linear 0s;
}

.svu-hud-scrim {
  position: absolute;
  left: 0;
  right: 0;
  top: 0;
  height: calc(env(safe-area-inset-top, 0px) + 108px);
  background: linear-gradient(180deg, rgba(0,0,0,.62) 0%, rgba(0,0,0,.34) 46%, rgba(0,0,0,0) 100%);
}

.svu-hud-row {
  position: absolute;
  left: 0;
  right: 0;
  top: 0;
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  padding: calc(env(safe-area-inset-top, 0px) + 16px) calc(env(safe-area-inset-right, 0px) + 18px) 0 calc(env(safe-area-inset-left, 0px) + 18px);
}

.svu-dist-n {
  font-size: clamp(30px, 8.4vw, 46px);
  font-weight: 400;
  line-height: 1;
  letter-spacing: .10em;
  color: #f6f1e6;
  font-variant-numeric: tabular-nums;
}
.svu-dist-l {
  margin-top: 6px;
  font-size: 8.5px;
  letter-spacing: .40em;
  text-indent: .40em;
  color: rgba(216,169,63,.72);
}

.svu-stars {
  display: flex;
  align-items: baseline;
  gap: 9px;
  font-size: clamp(22px, 6vw, 30px);
  line-height: 1;
  letter-spacing: .08em;
  color: #f6f1e6;
  font-variant-numeric: tabular-nums;
}
.svu-star {
  font-size: .62em;
  color: #d8a93f;
  letter-spacing: 0;
  transition: color .30s ease, text-shadow .30s ease;
}
.svu-stars.svu-hit .svu-star {
  color: #ffe6a6;
  text-shadow: 0 0 12px rgba(232,201,121,.85);
  transition: color .04s ease, text-shadow .04s ease;
}

.svu-tools {
  position: absolute;
  right: calc(env(safe-area-inset-right, 0px) + 16px);
  bottom: calc(env(safe-area-inset-bottom, 0px) + 16px);
  display: flex;
  gap: 9px;
  pointer-events: none;
}
.svu-tool {
  pointer-events: auto;
  min-width: 62px;
  min-height: 44px;
  padding: 14px 12px;
  display: flex;
  align-items: center;
  justify-content: center;
  border: 1px solid rgba(216,169,63,.34);
  background: rgba(8,7,6,.46);
  border-radius: 2px;
  color: rgba(242,236,225,.68);
  font-family: inherit;
  font-size: 9px;
  letter-spacing: .26em;
  text-indent: .26em;
  cursor: pointer;
  -webkit-tap-highlight-color: transparent;
}
.svu-tool:active { background: rgba(216,169,63,.16); color: #f2ece1; }

.svu-toast {
  position: absolute;
  left: 0;
  right: 0;
  top: 27%;
  text-align: center;
  font-size: clamp(11px, 3.1vw, 14px);
  letter-spacing: .44em;
  text-indent: .44em;
  color: #e8c979;
  opacity: 0;
}
.svu-toast.svu-on { opacity: 1; transition: opacity .22s ease; }

.svu-edge {
  position: absolute;
  top: 0;
  bottom: 0;
  width: 2px;
  background: #d8453f;
  box-shadow: 0 0 14px 2px rgba(216,69,63,.75);
  opacity: 0;
}
.svu-edge-l { left: 0; }
.svu-edge-r { right: 0; }
.svu-edge.svu-on { opacity: .9; }

.svu-pw {
  position: absolute;
  left: calc(env(safe-area-inset-left, 0px) + 18px);
  bottom: calc(env(safe-area-inset-bottom, 0px) + 18px);
  display: flex;
  flex-direction: column;
  gap: 8px;
  pointer-events: none;
}

.svu-chip {
  min-width: 106px;
  padding: 7px 11px 6px;
  border: 1px solid rgba(216,169,63,.30);
  background: rgba(8,7,6,.58);
  border-radius: 2px;
  opacity: 0;
  visibility: hidden;
  transition: opacity .22s ease, visibility 0s linear .22s;
}
.svu-chip.svu-on {
  opacity: 1;
  visibility: visible;
  transition: opacity .22s ease, visibility 0s linear 0s;
}

.svu-chip-d {
  margin-right: .55em;
  font-size: .82em;
  color: #e8c979;
  letter-spacing: 0;
}

.svu-chip-l {
  font-size: 9px;
  letter-spacing: .26em;
  text-indent: .26em;
  text-align: center;
  white-space: nowrap;
  color: rgba(242,236,225,.84);
}

.svu-chip-t {
  margin-top: 7px;
  height: 2px;
  background: rgba(216,169,63,.18);
}
.svu-chip-f {
  display: block;
  height: 100%;
  background: #d8a93f;
  transform-origin: left center;
  transform: scaleX(1);
}

.svu-chip-hold {
  border-color: rgba(216,169,63,.66);
  background: rgba(216,169,63,.13);
}
.svu-chip-hold .svu-chip-l { color: #e8c979; }
.svu-chip-hold .svu-chip-t { background: rgba(216,169,63,.28); }
.svu-chip-hold .svu-chip-f {
  background: #e8c979;
  box-shadow: 0 0 7px rgba(232,201,121,.85);
}

.svu-chip-spent {
  border-color: rgba(246,232,196,.96);
  background: rgba(232,201,121,.34);
}
.svu-chip-spent .svu-chip-l { color: #fffaf0; }
.svu-chip-spent .svu-chip-t { background: rgba(246,232,196,.34); }
.svu-chip-spent .svu-chip-f { background: rgba(246,232,196,.42); box-shadow: none; }

.svu-pwflash {
  position: absolute;
  inset: 0;
  border: 2px solid rgba(246,232,196,.92);
  background: rgba(216,169,63,.30);
  opacity: 0;
  transition: opacity .34s ease;
}
.svu-pwflash.svu-on { opacity: 1; transition: opacity .04s ease; }

.svu-debug {
  position: absolute;
  left: calc(env(safe-area-inset-left, 0px) + 18px);
  bottom: calc(env(safe-area-inset-bottom, 0px) + 16px);
  font: 400 11px/1.5 ui-monospace, SFMono-Regular, Menlo, monospace;
  letter-spacing: .02em;
  color: rgba(242,236,225,.5);
  white-space: pre;
}

.svu-panel {
  position: absolute;
  inset: 0;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  text-align: center;
  padding: calc(env(safe-area-inset-top, 0px) + 26px) 24px calc(env(safe-area-inset-bottom, 0px) + 26px);
  background: radial-gradient(130% 92% at 50% 38%, rgba(14,13,12,.92) 0%, rgba(6,6,6,.972) 58%, rgba(3,3,3,.99) 100%);
  opacity: 0;
  pointer-events: none;
  transition: opacity .38s ease;
}
.svu-panel.svu-on {
  opacity: 1;
  pointer-events: auto;
}

.svu-title {
  font-size: clamp(30px, 10.8vw, 76px);
  font-weight: 400;
  line-height: 1.02;
  letter-spacing: .28em;
  text-indent: .28em;
  color: #f6f1e6;
}

.svu-rule {
  width: min(230px, 54vw);
  height: 1px;
  margin: 26px 0;
  background: linear-gradient(90deg, rgba(216,169,63,0) 0%, rgba(216,169,63,.78) 50%, rgba(216,169,63,0) 100%);
}
.svu-rule-tight { margin: 20px 0; }

.svu-sub {
  font-size: clamp(9px, 2.4vw, 11.5px);
  letter-spacing: .30em;
  text-indent: .30em;
  color: rgba(242,236,225,.56);
  line-height: 1.9;
}

.svu-label {
  font-size: clamp(9.5px, 2.7vw, 11px);
  letter-spacing: .42em;
  text-indent: .42em;
  color: rgba(242,236,225,.52);
}

.svu-big {
  margin-top: 20px;
  font-size: clamp(58px, 22vw, 140px);
  font-weight: 400;
  line-height: .96;
  letter-spacing: .04em;
  color: #f6f1e6;
  font-variant-numeric: tabular-nums;
}
.svu-big-l {
  margin-top: 12px;
  font-size: 10px;
  letter-spacing: .46em;
  text-indent: .46em;
  color: rgba(216,169,63,.78);
}

.svu-pair {
  display: flex;
  align-items: stretch;
  justify-content: center;
}
.svu-cell {
  padding: 0 clamp(20px, 8vw, 68px);
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 11px;
}
.svu-cell-rule {
  width: 1px;
  align-self: stretch;
  background: linear-gradient(180deg, rgba(216,169,63,0) 0%, rgba(216,169,63,.45) 50%, rgba(216,169,63,0) 100%);
}
.svu-cell-l {
  font-size: 9px;
  letter-spacing: .34em;
  text-indent: .34em;
  color: rgba(242,236,225,.48);
}
.svu-cell-v {
  font-size: clamp(24px, 7.4vw, 34px);
  line-height: 1;
  letter-spacing: .07em;
  color: #f6f1e6;
  font-variant-numeric: tabular-nums;
}
.svu-cell-v-gold { color: #e8c979; }

.svu-newbest {
  margin-top: 24px;
  font-size: 10px;
  letter-spacing: .44em;
  text-indent: .44em;
  color: #e8c979;
  display: none;
}
.svu-newbest.svu-on { display: block; }

.svu-cta {
  pointer-events: auto;
  margin-top: 34px;
  min-height: 52px;
  padding: 17px 40px;
  border: 1px solid rgba(216,169,63,.62);
  background: rgba(216,169,63,.07);
  border-radius: 1px;
  color: #e8c979;
  font-family: inherit;
  font-size: clamp(11px, 3vw, 13px);
  letter-spacing: .34em;
  text-indent: .34em;
  cursor: pointer;
  -webkit-tap-highlight-color: transparent;
  transition: background .16s ease, color .16s ease;
}
.svu-cta:hover { background: rgba(216,169,63,.15); color: #f4e2b4; }
.svu-cta:active { background: rgba(216,169,63,.24); }

.svu-hint {
  margin-top: 30px;
  font-size: clamp(7.8px, 2.0vw, 10.5px);
  letter-spacing: .18em;
  text-indent: .18em;
  color: rgba(242,236,225,.40);
  line-height: 2;
  max-width: 48em;
}

.svu-quiet {
  pointer-events: auto;
  margin-top: 22px;
  min-height: 44px;
  padding: 14px 20px;
  border: 0;
  background: none;
  color: rgba(242,236,225,.46);
  font-family: inherit;
  font-size: 9.5px;
  letter-spacing: .30em;
  text-indent: .30em;
  cursor: pointer;
  -webkit-tap-highlight-color: transparent;
}
.svu-quiet:hover { color: rgba(242,236,225,.78); }

.svu-quiet-row { display: flex; gap: 4px; align-items: center; }
.svu-quiet-sep {
  width: 1px;
  align-self: stretch;
  margin: 12px 0;
  background: linear-gradient(180deg, rgba(216,169,63,0) 0%, rgba(216,169,63,.40) 50%, rgba(216,169,63,0) 100%);
}

#svu-ui.svu-dbg .svu-pw { bottom: calc(env(safe-area-inset-bottom, 0px) + 46px); }

#svu-ui.svu-nofade .svu-panel,
#svu-ui.svu-nofade .svu-hud,
#svu-ui.svu-nofade .svu-toast,
#svu-ui.svu-nofade .svu-chip,
#svu-ui.svu-nofade .svu-pwflash,
#svu-ui.svu-nofade .svu-cta {
  transition: none;
}

@media (prefers-reduced-motion: reduce) {
  .svu-panel, .svu-hud, .svu-toast, .svu-chip, .svu-pwflash { transition: none; }
}
`;
    const style = document.createElement('style');
    style.id = 'svu-ui-css';
    style.textContent = css;
    document.head.appendChild(style);
    this._style = style;
  }

  _buildDom() {
    const root = document.createElement('div');
    root.id = 'svu-ui';
    root.innerHTML = `
<div class="svu-hud" id="svuHud">
  <div class="svu-hud-scrim"></div>
  <div class="svu-hud-row">
    <div class="svu-dist">
      <div class="svu-dist-n" id="svuDist">0</div>
      <div class="svu-dist-l">METRES</div>
    </div>
      <div class="svu-stars" id="svuStarsBox"><span class="svu-star">&#10022;</span><span id="svuStars">0</span></div>
  </div>
  <div class="svu-toast" id="svuToast"></div>
  <div class="svu-edge svu-edge-l" id="svuEdgeL"></div>
  <div class="svu-edge svu-edge-r" id="svuEdgeR"></div>
  <div class="svu-pwflash" id="svuPwFlash"></div>
  <div class="svu-pw" id="svuPw">
    <div class="svu-chip" id="svuChip0">
      <div class="svu-chip-l"><span id="svuChipT0">MAGNET</span></div>
      <div class="svu-chip-t"><i class="svu-chip-f" id="svuChipF0"></i></div>
    </div>
    <div class="svu-chip svu-chip-hold" id="svuChip1">
      <div class="svu-chip-l"><span class="svu-chip-d">&#9670;</span><span id="svuChipT1">SHIELD</span></div>
      <div class="svu-chip-t"><i class="svu-chip-f" id="svuChipF1"></i></div>
    </div>
    <div class="svu-chip" id="svuChip2">
      <div class="svu-chip-l"><span id="svuChipT2">GLIDE</span></div>
      <div class="svu-chip-t"><i class="svu-chip-f" id="svuChipF2"></i></div>
    </div>
  </div>
  <div class="svu-tools">
    <button class="svu-tool" id="svuMute" type="button" aria-label="Sound">SOUND</button>
    <button class="svu-tool" id="svuPause" type="button" aria-label="Pause">PAUSE</button>
  </div>
</div>

<div class="svu-debug" id="svuDebug"></div>

<div class="svu-panel" id="svuStart" aria-hidden="true">
  <div class="svu-title">SVU RUN</div>
  <div class="svu-rule"></div>
  <div class="svu-sub">AN ENDLESS RUN THROUGH THE VAULT</div>
  <button class="svu-cta" id="svuBegin" type="button">BEGIN</button>
  <div class="svu-hint">LEFT AND RIGHT TO STEER &nbsp;&middot;&nbsp; UP TO JUMP &nbsp;&middot;&nbsp; DOWN TO SLIDE</div>
</div>

<div class="svu-panel" id="svuPaused" aria-hidden="true">
  <div class="svu-label">AT REST</div>
  <div class="svu-big" id="svuPauseDist">0</div>
  <div class="svu-big-l">METRES</div>
  <div class="svu-rule"></div>
  <button class="svu-cta" id="svuResume" type="button">RESUME</button>
  <div class="svu-quiet-row">
    <button class="svu-quiet" id="svuPauseMute" type="button">SOUND ON</button>
    <span class="svu-quiet-sep"></span>
    <button class="svu-quiet" id="svuPauseEnd" type="button">START AGAIN</button>
  </div>
</div>

<div class="svu-panel" id="svuOver" aria-hidden="true">
  <div class="svu-label">THE RUN ENDS</div>
  <div class="svu-big" id="svuOvDist">0</div>
  <div class="svu-big-l">METRES</div>
  <div class="svu-rule"></div>
  <div class="svu-pair">
    <div class="svu-cell">
      <div class="svu-cell-l">STARS</div>
      <div class="svu-cell-v" id="svuOvStars">0</div>
    </div>
    <div class="svu-cell-rule"></div>
    <div class="svu-cell">
      <div class="svu-cell-l">BEST</div>
      <div class="svu-cell-v svu-cell-v-gold" id="svuOvBest">0</div>
    </div>
  </div>
  <div class="svu-newbest" id="svuNewBest">A NEW BEST</div>
  <button class="svu-cta" id="svuAgain" type="button">RUN AGAIN</button>
</div>
`;
    document.body.appendChild(root);
    this.root = root;

    const $ = (s) => root.querySelector(s);
    this.els = {
      hud: $('#svuHud'),
      dist: $('#svuDist'),
      stars: $('#svuStars'),
      starsBox: $('#svuStarsBox'),
      toast: $('#svuToast'),
      edgeL: $('#svuEdgeL'),
      edgeR: $('#svuEdgeR'),
      mute: $('#svuMute'),
      pause: $('#svuPause'),
      debug: $('#svuDebug'),
      start: $('#svuStart'),
      begin: $('#svuBegin'),
      paused: $('#svuPaused'),
      pauseDist: $('#svuPauseDist'),
      resume: $('#svuResume'),
      pauseMute: $('#svuPauseMute'),
      pauseEnd: $('#svuPauseEnd'),
      over: $('#svuOver'),
      ovDist: $('#svuOvDist'),
      ovStars: $('#svuOvStars'),
      ovBest: $('#svuOvBest'),
      newBest: $('#svuNewBest'),
      again: $('#svuAgain'),
      pwFlash: $('#svuPwFlash'),
      // Fixed-length arrays indexed by the powerup contract's slot number.
      // Built once; nothing here is ever searched for again.
      chip: [$('#svuChip0'), $('#svuChip1'), $('#svuChip2')],
      chipT: [$('#svuChipT0'), $('#svuChipT1'), $('#svuChipT2')],
      chipF: [$('#svuChipF0'), $('#svuChipF1'), $('#svuChipF2')],
    };
  }

  _bind() {
    this._offs.push(this.ctx.on(EV.PICKUP_STAR, (p) => {
      this.stars++;
      this.starScore += (p && p.value) || 0;
      this.els.stars.textContent = this.stars;
      this._shownStars = this.stars;
      // A pickup should be felt in the corner of the eye, not read. One class
      // on one small element: the glyph flares gold-white and eases back.
      this.els.starsBox.classList.add('svu-hit');
      this._starT = 0.16;
    }));
    this._offs.push(this.ctx.on(EV.RUN_END, (p) => this._onRunEnd(p)));
    // NOTE: this must NOT set the phase. main.js emits RUN_START during boot,
    // after ui.init(), and every ctx.restart() emits it too — so driving the
    // phase from here would dismiss the start screen before anyone saw it.
    this._offs.push(this.ctx.on(EV.RUN_START, () => this._resetRun()));

    const on = (el, type, fn) => {
      el.addEventListener(type, fn);
      this._offs.push(() => el.removeEventListener(type, fn));
    };

    on(this.els.begin, 'click', () => this._begin());
    on(this.els.again, 'click', () => this._again());
    on(this.els.resume, 'click', () => this.setPaused(false));
    on(this.els.pause, 'click', () => this.setPaused(this.phase !== 'paused'));
    on(this.els.mute, 'click', () => this._toggleMute());
    on(this.els.pauseMute, 'click', () => this._toggleMute());
    on(this.els.pauseEnd, 'click', () => this._again());

    // Swallow gestures that land on a live panel so they never reach the
    // canvas and steer the run happening behind it.
    const eat = (e) => { e.stopPropagation(); };
    on(this.els.start, 'pointerdown', eat);
    on(this.els.paused, 'pointerdown', eat);
    on(this.els.over, 'pointerdown', eat);

    // Keyboard. ENTER is the only affirmative key, deliberately — see trap 4.
    const key = (e) => {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      switch (e.code) {
        case 'Enter':
        case 'NumpadEnter':
          if (this.phase === 'start') { e.preventDefault(); this._begin(); }
          else if (this.phase === 'over') { e.preventDefault(); this._again(); }
          else if (this.phase === 'paused') { e.preventDefault(); this.setPaused(false); }
          return;
        case 'Escape':
        case 'KeyP':
          // Only while a run is actually in progress. Smoke presses KeyP to
          // unlock the AudioContext while the start screen is still up.
          if (this.phase === 'run' || this.phase === 'paused') {
            e.preventDefault();
            this.setPaused(this.phase !== 'paused');
          }
          return;
        case 'Space':
        case 'KeyR':
          if (this.phase === 'over') { e.preventDefault(); this._again(); }
          return;
        default:
      }
    };
    window.addEventListener('keydown', key);
    this._offs.push(() => window.removeEventListener('keydown', key));

    // On a phone a run ends every time someone gets a message. Auto-pause on
    // the way out; stay paused on the way back in, so returning is a decision
    // rather than an instant death.
    const vis = () => {
      if (document.hidden && this.phase === 'run') this.setPaused(true);
    };
    document.addEventListener('visibilitychange', vis);
    this._offs.push(() => document.removeEventListener('visibilitychange', vis));
  }

  // ---- phase -----------------------------------------------------------

  _applyPhase() {
    const p = this.phase;
    this._panel(this.els.start, p === 'start');
    this._panel(this.els.paused, p === 'paused');
    this._panel(this.els.over, p === 'over');
    // The HUD comes down for every panel, including pause. Leaving it up put a
    // second, ghosted copy of the distance behind the pause panel's own.
    this.els.hud.classList.toggle('svu-on', p === 'run');
  }

  _panel(el, on) {
    el.classList.toggle('svu-on', on);
    el.setAttribute('aria-hidden', on ? 'false' : 'true');
  }

  /** Force the start screen back up. Used by tools/capture.mjs. */
  showStart() {
    this.phase = 'start';
    this._applyPhase();
  }

  /**
   * Capture affordance, never used in play: hold the transient feedback up so
   * tools/capture.mjs can photograph it. Both of these last a fifth of a
   * second in the game, which is exactly long enough to be ungradeable and
   * exactly the sort of thing that ships wrong because nobody ever saw it.
   */
  preview(side, text) {
    if (side <= 0) this.els.edgeL.classList.add('svu-on');
    if (side >= 0) this.els.edgeR.classList.add('svu-on');
    this._edgeT = 1e6;
    if (text) {
      this._toast(text);
      this._toastT = 1e6;
    }
  }

  /**
   * Capture affordance, never used in play. The shield-spend cue is 0.34s of
   * flash and 0.9s of chip, which is long enough to matter in the hand and far
   * too short to grade from a frame that lands wherever the software renderer
   * happened to get to. A pose calls pw.absorb() for real — so the POLL path
   * is what lights this up, not a special case — and then this holds it open.
   */
  previewSpend() {
    const play = this.ctx.tryGet('play');
    const pw = play && play.pw;
    if (pw) this._spentAt = pw.lastSpent;
    this._onSpend();
    this._spentT = 1e6;
    this._flashT = 1e6;
  }

  setPaused(v) {
    if (v && this.phase !== 'run') return;
    if (!v && this.phase !== 'paused') return;
    this.phase = v ? 'paused' : 'run';
    if (v) this.els.pauseDist.textContent = this._metres();
    this.ctx.loop.setPaused(v);
    this.ctx.emit(v ? EV.RUN_PAUSE : EV.RUN_RESUME, null);
    this._applyPhase();
  }

  _begin() {
    if (this.phase !== 'start') return;
    this._begun = true;
    this.phase = 'run';
    this._applyPhase();
    // The run behind the panel has almost certainly died unsteered. Restart is
    // what makes BEGIN mean "begin" rather than "reveal a corpse".
    if (this.ctx.restart) this.ctx.restart();
  }

  _again() {
    // Guard against the input that killed you instantly restarting the run.
    if (this.phase === 'over' && performance.now() - this._deadAt < 400) return;
    this.phase = 'run';
    this._applyPhase();
    if (this.ctx.restart) this.ctx.restart();
  }

  // ---- run lifecycle ---------------------------------------------------

  _onRunEnd(p) {
    // Trap 3: the start screen does not pause the loop, so an unsteered player
    // dies behind it. That death is not a result anyone wants to see.
    if (this.phase !== 'run') return;
    this._deadAt = performance.now();
    const metres = Math.max(0, Math.floor((p && p.distance) || 0));
    const isBest = metres > BEST_METRES;
    if (isBest) BEST_METRES = metres;
    if (this.stars > BEST_STARS) BEST_STARS = this.stars;
    this.best = BEST_METRES;

    this.els.ovDist.textContent = metres;
    this.els.ovStars.textContent = this.stars;
    this.els.ovBest.textContent = BEST_METRES;
    this.els.newBest.classList.toggle('svu-on', isBest && metres > 0);

    this.phase = 'over';
    this._applyPhase();
  }

  _resetRun() {
    this.stars = 0;
    this.starScore = 0;
    this._shownDist = -1;
    this._shownStars = -1;
    this._milestone = 0;
    this._toastT = 0;
    this._starT = 0;
    this._edgeT = 0;
    this._edgeSeq = -1;
    this.els.starsBox.classList.remove('svu-hit');
    this.els.edgeL.classList.remove('svu-on');
    this.els.edgeR.classList.remove('svu-on');
    this.els.stars.textContent = '0';
    this.els.dist.textContent = '0';
    this.els.toast.classList.remove('svu-on');

    // A RUN_START means every slot is empty and no END events are coming, so
    // the chips are cleared here rather than waited for.
    this._spentAt = -1;
    this._flashT = 0;
    this.els.pwFlash.classList.remove('svu-on');
    this._clearSpend();
    for (let k = 0; k < PW_SLOTS; k++) {
      this._pwOn[k] = false;
      this._pwFill[k] = -1;
      this.els.chip[k].classList.remove('svu-on');
    }
  }

  // ---- sound -----------------------------------------------------------

  _toggleMute() {
    const audio = this.ctx.tryGet('audio');
    if (!audio || typeof audio.setUserMuted !== 'function') return;
    audio.setUserMuted(!audio.userMuted);
    this._syncMute();
  }

  /** Cheap: only touches the DOM when the state actually changed. */
  _syncMute() {
    const audio = this.ctx.tryGet('audio');
    const muted = !!(audio && audio.userMuted);
    if (muted === this._muteShown) return;
    this._muteShown = muted;
    this.els.mute.textContent = muted ? 'MUTED' : 'SOUND';
    this.els.pauseMute.textContent = muted ? 'SOUND OFF' : 'SOUND ON';
  }

  // ---- per-frame -------------------------------------------------------

  _metres() {
    const play = this.ctx.tryGet('play');
    return play ? Math.max(0, Math.floor(play.z)) : 0;
  }

  /** Kept for compatibility with anything that still reads a score. */
  get score() {
    const play = this.ctx.tryGet('play');
    const T = this.ctx.config.tune;
    return this.starScore + Math.floor((play ? play.z : 0) * T.distanceScorePerMetre);
  }

  renderUpdate(dtReal) {
    const play = this.ctx.tryGet('play');
    if (!play) return;

    // main.js unpauses the loop on visibilitychange, which would otherwise
    // resume the game underneath a PAUSED panel.
    if (this.phase === 'paused' && !this.ctx.loop.paused) this.ctx.loop.setPaused(true);

    if (this.phase === 'run') {
      const m = this._metres();
      if (m !== this._shownDist) {
        this._shownDist = m;
        this.els.dist.textContent = m;
        const step = (m / MILESTONE_EVERY) | 0;
        if (step > this._milestone) {
          this._milestone = step;
          this._toast(`${step * MILESTONE_EVERY} METRES`);
        }
      }
      this._pollNearMiss();
      this._pollPowerups(play);
    }

    if (this._toastT > 0) {
      this._toastT -= dtReal;
      if (this._toastT <= 0) this.els.toast.classList.remove('svu-on');
    }
    if (this._starT > 0) {
      this._starT -= dtReal;
      if (this._starT <= 0) this.els.starsBox.classList.remove('svu-hit');
    }
    if (this._edgeT > 0) {
      this._edgeT -= dtReal;
      if (this._edgeT <= 0) {
        this.els.edgeL.classList.remove('svu-on');
        this.els.edgeR.classList.remove('svu-on');
      }
    }
    if (this._flashT > 0) {
      this._flashT -= dtReal;
      if (this._flashT <= 0) this.els.pwFlash.classList.remove('svu-on');
    }
    if (this._spentT > 0) {
      this._spentT -= dtReal;
      if (this._spentT <= 0) this._clearSpend();
    }

    this._syncMute();

    if (this.ctx.config.showDebug) this._debug(play);
  }

  _toast(text) {
    this.els.toast.textContent = text;
    this.els.toast.classList.add('svu-on');
    this._toastT = 1.6;
  }

  /**
   * fx/ owns near-miss detection (it already walks the obstacle list every
   * frame). It publishes a monotonic sequence and a side; this only draws.
   *
   * A 2px hairline plus a short glow, at the screen edge the hazard passed on.
   * A wide soft wash was tried and is INVISIBLE against a black hall — 22vw at
   * 0.22 alpha reads as nothing at all. Never obscure the track.
   */
  _pollNearMiss() {
    const fx = this.ctx.tryGet('fx');
    if (!fx || fx.nearMissSeq === undefined) return;
    if (this._edgeSeq < 0) { this._edgeSeq = fx.nearMissSeq; return; }
    if (fx.nearMissSeq === this._edgeSeq) return;
    this._edgeSeq = fx.nearMissSeq;
    const side = fx.nearMissSide;
    // side 0 means it went straight over or under — the hazard was on both
    // sides at once, so both edges answer.
    if (side <= 0) this.els.edgeL.classList.add('svu-on');
    if (side >= 0) this.els.edgeR.classList.add('svu-on');
    this._edgeT = 0.22;
  }

  /**
   * The powerup chips. Reads `play.pw` — the contract in the header of
   * src/play/powerups.js — and writes DOM only where something changed.
   *
   * THE SPEND IS CHECKED FIRST, deliberately. Do it after the slot loop and
   * the shield chip vanishes for one frame before ABSORBED lights up, because
   * `slot.active` is already false by the time the poll sees the spend.
   */
  _pollPowerups(play) {
    const pw = play.pw;
    if (!pw || !pw.slots) return;
    const slots = pw.slots;

    // Never trust a hardcoded label over the contract. One pass, once.
    if (!this._pwNamed) {
      this._pwNamed = true;
      for (let k = 0; k < PW_SLOTS; k++) {
        if (slots[k] && slots[k].name) this.els.chipT[k].textContent = slots[k].name;
      }
    }

    // `lastSpent` is ctx.time of the last shield spend, or -1. A poll cannot
    // miss the edge, only be a frame late — and -1 can never trigger it, which
    // is what makes a reset safe whichever order the RUN_START listeners run.
    if (pw.lastSpent >= 0 && pw.lastSpent !== this._spentAt) {
      this._spentAt = pw.lastSpent;
      this._onSpend();
    }

    for (let k = 0; k < PW_SLOTS; k++) {
      const s = slots[k];
      if (!s) continue;
      // The spent shield keeps its chip up after the charge is gone: an
      // indicator that disappears at the instant of the save has nothing left
      // to say about the save.
      const on = s.active || (k === PW_SHIELD && this._spentT > 0);
      if (on !== this._pwOn[k]) {
        this._pwOn[k] = on;
        this.els.chip[k].classList.toggle('svu-on', on);
      }
      if (!on) continue;
      // A charge has no clock and is not drawn as one — its bar sits full.
      const f = s.unit === 's' && s.total > 0
        ? (s.remaining / s.total) * 100
        : 100;
      const pct = f <= 0 ? 0 : (f >= 100 ? 100 : Math.round(f));
      if (pct !== this._pwFill[k]) {
        this._pwFill[k] = pct;
        this.els.chipF[k].style.transform = this._sx[pct];
      }
    }
  }

  _onSpend() {
    this._spentT = SPEND_HOLD;
    this._flashT = SPEND_FLASH;
    this.els.pwFlash.classList.add('svu-on');
    this.els.chip[PW_SHIELD].classList.add('svu-chip-spent');
    this.els.chipT[PW_SHIELD].textContent = 'ABSORBED';
  }

  _clearSpend() {
    this._spentT = 0;
    this.els.chip[PW_SHIELD].classList.remove('svu-chip-spent');
    const play = this.ctx.tryGet('play');
    const s = play && play.pw && play.pw.slots && play.pw.slots[PW_SHIELD];
    this.els.chipT[PW_SHIELD].textContent = (s && s.name) || 'SHIELD';
  }

  _debug(play) {
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

  dispose() {
    for (const off of this._offs) off();
    this._offs.length = 0;
    if (this.root) this.root.remove();
    if (this._style) this._style.remove();
    this.root = null;
    this._style = null;
  }
}
