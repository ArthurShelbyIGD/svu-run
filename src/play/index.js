// play/ — input, player state machine, and the chase camera.
//
// OWNERSHIP: this directory owns "what the player is doing and where the
// camera is". It does not own the character's appearance (char/) or the
// collision response (coll/).
//
// Input is normalised into four intents — LEFT, RIGHT, JUMP, SLIDE — so that
// keyboard and touch are completely interchangeable and neither is a
// second-class citizen.

import { Vector3, Scalar } from '../core/bjs.js';
import { EV } from '../core/ctx.js';

export const INTENT = { NONE: 0, LEFT: 1, RIGHT: 2, JUMP: 3, SLIDE: 4 };
export const STATE = { RUN: 0, AIR: 1, SLIDE: 2, STUMBLE: 3, DEAD: 4 };

export default class Play {
  constructor(ctx) {
    this.ctx = ctx;
    const T = ctx.config.tune;

    // --- player state ---
    this.state = STATE.RUN;
    this.lane = 1;                 // 0..laneCount-1
    this.laneTarget = 1;
    this.laneT = 1;                // 0..1 interpolation through a lane change
    this.x = 0;                    // lateral position, metres
    this.y = 0;                    // height above track
    this.z = 0;                    // distance travelled, metres
    this.vy = 0;
    this.speed = T.startSpeed;
    this.baseSpeed = T.startSpeed;
    this._cornerFactor = 1;
    this.stateTime = 0;
    this.groundedTime = 0;
    this.alive = true;

    // --- input ---
    this._buffered = INTENT.NONE;
    this._bufferAge = 0;
    // junction state
    this.junction = null;    // the corner currently being approached
    this._turnOkAt = -1;     // path distance of the corner the player has earned
    this.turnsMade = 0;
    this._pTurn = { dir: 0 };
    this._touchId = null;
    this._touchStart = { x: 0, y: 0, t: 0 };
    this._handlers = [];

    // --- camera (pre-allocated, no per-frame Vector3 churn) ---
    this._camTarget = new Vector3(0, 1, 0);
    this._camInit = false;
    this._wPos = [0, 0, 0];
    this._wTgt = [0, 0, 0];
    // Camera state lives in PATH space: distance along the path, lateral
    // offset, height. See renderUpdate for why that matters at corners.
    this._camS = 0; this._camLat = 0; this._camY = T.camHeight;
    this._tgtS = 0; this._tgtLat = 0; this._tgtY = 1.2;

    // pooled event payloads
    this._pLane = { from: 0, to: 0 };
    this._pLand = { hard: false };
  }

  init() {
    this._bindKeyboard();
    this._bindTouch();
  }

  // ---- input binding ---------------------------------------------------

  _bindKeyboard() {
    const onKey = (e) => {
      let intent = INTENT.NONE;
      switch (e.code) {
        case 'ArrowLeft': case 'KeyA': intent = INTENT.LEFT; break;
        case 'ArrowRight': case 'KeyD': intent = INTENT.RIGHT; break;
        case 'ArrowUp': case 'KeyW': case 'Space': intent = INTENT.JUMP; break;
        case 'ArrowDown': case 'KeyS': intent = INTENT.SLIDE; break;
        default: return;
      }
      e.preventDefault();
      this.pushIntent(intent);
    };
    window.addEventListener('keydown', onKey, { passive: false });
    this._handlers.push(() => window.removeEventListener('keydown', onKey));
  }

  _bindTouch() {
    const canvas = this.ctx.canvas;
    const T = this.ctx.config.tune;

    const down = (e) => {
      if (this._touchId !== null) return;
      const t = e.changedTouches ? e.changedTouches[0] : e;
      this._touchId = e.changedTouches ? t.identifier : 'mouse';
      this._touchStart.x = t.clientX;
      this._touchStart.y = t.clientY;
      this._touchStart.t = performance.now();
    };

    const up = (e) => {
      if (this._touchId === null) return;
      let t = e.changedTouches ? null : e;
      if (e.changedTouches) {
        for (let i = 0; i < e.changedTouches.length; i++) {
          if (e.changedTouches[i].identifier === this._touchId) t = e.changedTouches[i];
        }
      }
      if (!t) return;
      this._touchId = null;

      const dx = t.clientX - this._touchStart.x;
      const dy = t.clientY - this._touchStart.y;
      const dt = (performance.now() - this._touchStart.t) / 1000;
      if (dt > T.swipeMaxTime) return;

      const adx = Math.abs(dx), ady = Math.abs(dy);
      if (Math.max(adx, ady) < T.swipeMinDistance) return;

      if (adx > ady) this.pushIntent(dx > 0 ? INTENT.RIGHT : INTENT.LEFT);
      else this.pushIntent(dy > 0 ? INTENT.SLIDE : INTENT.JUMP);
    };

    const prevent = (e) => e.preventDefault();

    canvas.addEventListener('touchstart', down, { passive: true });
    canvas.addEventListener('touchend', up, { passive: true });
    canvas.addEventListener('touchmove', prevent, { passive: false });
    canvas.addEventListener('mousedown', down);
    canvas.addEventListener('mouseup', up);
    this._handlers.push(() => {
      canvas.removeEventListener('touchstart', down);
      canvas.removeEventListener('touchend', up);
      canvas.removeEventListener('touchmove', prevent);
      canvas.removeEventListener('mousedown', down);
      canvas.removeEventListener('mouseup', up);
    });
  }

  /** Queue an intent. Buffered briefly so slightly-early inputs still land. */
  pushIntent(intent) {
    this._buffered = intent;
    this._bufferAge = 0;
  }

  // ---- simulation ------------------------------------------------------

  fixedUpdate(dt) {
    if (!this.alive) return;
    const T = this.ctx.config.tune;

    this.stateTime += dt;
    this._bufferAge += dt;
    if (this._bufferAge > T.inputBuffer) this._buffered = INTENT.NONE;

    // speed ramp
    const ramp = Math.min(1, this.ctx.time / T.speedRampTime);
    this.baseSpeed = Scalar.Lerp(T.startSpeed, T.maxSpeed, ramp * ramp * (3 - 2 * ramp));

    this._updateJunction();
    this._updateCornerSpeed(dt, T);
    this.speed = this.baseSpeed * this._cornerFactor;
    this.z += this.speed * dt;

    this._consumeIntent(T);
    this._advanceLane(dt, T);
    this._advanceVertical(dt, T);
    this._checkJunctionCrossed();
  }

  /**
   * Ease speed down through a corner and back up afterwards.
   *
   * Asymmetric on purpose: the slowdown bites quickly so the corner feels
   * anticipated rather than sprung, and speed is regained gently so the exit
   * reads as accelerating out of a bend rather than snapping back.
   */
  _updateCornerSpeed(dt, T) {
    const d = this.junction ? this.junction.s - this.z : Infinity;
    const inCorner = d < T.cornerSlowStart && d > -T.cornerSlowEnd;
    const want = inCorner ? T.cornerSlowFactor : 1;
    const rate = want < this._cornerFactor ? T.cornerSlowInRate : T.cornerSlowOutRate;
    const k = 1 - Math.pow(1 - rate, dt * 60);
    this._cornerFactor += (want - this._cornerFactor) * k;
  }

  /** Distance within which left/right means "turn" rather than "change lane". */
  get turnWindow() {
    const T = this.ctx.config.tune;
    // Scales with baseSpeed, not current speed. Using current speed would
    // shrink the reaction window at exactly the moment the corner slowdown
    // kicks in — the window would close as the player approached it.
    return T.turnWindowBase + (this.baseSpeed - T.startSpeed) * T.turnWindowPerSpeed;
  }

  /** Metres past a corner during which a late turn still counts. */
  get turnGrace() {
    return this.ctx.config.tune.turnGraceTime * this.speed;
  }

  /** True when the player is close enough to a corner to be asked to turn. */
  get inTurnZone() {
    if (!this.junction) return false;
    const d = this.junction.s - this.z;
    return d <= this.turnWindow && d >= -this.turnGrace;
  }

  _updateJunction() {
    // Only ever look up a NEW corner when there is no current one.
    //
    // The obvious version of this — "refresh whenever the cached corner is
    // behind us" — is silently broken: z advances at the top of the step, so
    // on the exact step the player crosses a corner the cached junction is
    // already behind them and gets replaced by the *next* one. The crossing is
    // then never checked, and running straight through a wall costs nothing.
    // _checkJunctionCrossed() is what clears this, once it has had its say.
    if (this.junction) {
      // Capture mode drives an unsteered player, so it would die at the first
      // corner and no screenshot past 384m would ever exist. Autopilot the
      // turns instead. Gameplay is unaffected: captureMode is only ever set by
      // the screenshot harness.
      if (this.ctx.config.captureMode && this.inTurnZone) {
        this._turnOkAt = this.junction.s;
      }
      return;
    }
    const track = this.ctx.tryGet('track');
    if (!track) return;
    this.junction = track.nextJunction(this.z);
  }

  _checkJunctionCrossed() {
    const j = this.junction;
    if (!j) return;
    // Do not judge until the grace period has also elapsed, so a turn landing
    // a frame or two late still saves the run.
    if (this.z < j.s + (this._turnOkAt === j.s ? 0 : this.turnGrace)) return;
    if (this._turnOkAt !== j.s) {
      // Ran straight into the backstop wall.
      this.kill('wall');
      return;
    }
    this.turnsMade++;
    this.junction = null;
  }

  _consumeIntent(T) {
    const i = this._buffered;
    if (i === INTENT.NONE) return;

    if (i === INTENT.LEFT || i === INTENT.RIGHT) {
      const dir = i === INTENT.LEFT ? -1 : 1;

      // Context-sensitive: near a corner, sideways input means TURN. Lane
      // changes are suppressed entirely in the turn zone — a player who
      // meant to turn and got a lane change instead would rightly call that
      // broken, and there is no way to tell the two intents apart.
      if (this.inTurnZone) {
        if (dir === this.junction.turn) {
          this._turnOkAt = this.junction.s;
          this._pTurn.dir = dir;
          this.ctx.emit(EV.PLAYER_TURN, this._pTurn);
        }
        // A wrong-way input is ignored rather than fatal, so the player can
        // correct. Failing to turn at all is what kills.
        this._buffered = INTENT.NONE;
        return;
      }

      const next = this.laneTarget + dir;
      if (next >= 0 && next < T.laneCount) {
        this._pLane.from = this.laneTarget;
        this._pLane.to = next;
        this.laneTarget = next;
        this.laneT = 0;
        this.ctx.emit(EV.PLAYER_LANE, this._pLane);
      }
      this._buffered = INTENT.NONE;
      return;
    }

    if (i === INTENT.JUMP) {
      const canJump = this.state === STATE.RUN ||
        this.state === STATE.SLIDE ||
        (this.state === STATE.AIR && this.groundedTime < T.coyoteTime);
      if (canJump) {
        // v chosen so the apex is exactly jumpHeight
        const g = (8 * T.jumpHeight) / (T.jumpTime * T.jumpTime);
        this.vy = Math.sqrt(2 * g * T.jumpHeight);
        this._setState(STATE.AIR);
        this.ctx.emit(EV.PLAYER_JUMP, null);
        this._buffered = INTENT.NONE;
      }
      return;
    }

    if (i === INTENT.SLIDE) {
      if (this.state === STATE.RUN) {
        this._setState(STATE.SLIDE);
        this.ctx.emit(EV.PLAYER_SLIDE, { active: true });
      } else if (this.state === STATE.AIR) {
        this.vy = Math.min(this.vy, -12); // fast-fall into a slide
      }
      this._buffered = INTENT.NONE;
    }
  }

  _advanceLane(dt, T) {
    if (this.laneT < 1) {
      this.laneT = Math.min(1, this.laneT + dt / T.laneChangeTime);
      if (this.laneT >= 1) this.lane = this.laneTarget;
    }
    const from = (this.lane - (T.laneCount - 1) / 2) * T.laneWidth;
    const to = (this.laneTarget - (T.laneCount - 1) / 2) * T.laneWidth;
    // smoothstep gives the move a bit of weight at both ends
    const t = this.laneT;
    const s = t * t * (3 - 2 * t);
    this.x = from + (to - from) * s;
  }

  _advanceVertical(dt, T) {
    const g = (8 * T.jumpHeight) / (T.jumpTime * T.jumpTime);

    if (this.state === STATE.AIR) {
      this.vy -= g * dt;
      this.y += this.vy * dt;
      this.groundedTime += dt;
      if (this.y <= 0) {
        const hard = this.vy < -14;
        this.y = 0;
        this.vy = 0;
        this._setState(STATE.RUN);
        this._pLand.hard = hard;
        this.ctx.emit(EV.PLAYER_LAND, this._pLand);
      }
    } else {
      this.y = 0;
      this.groundedTime = 0;
      if (this.state === STATE.SLIDE && this.stateTime >= T.slideTime) {
        this._setState(STATE.RUN);
        this.ctx.emit(EV.PLAYER_SLIDE, { active: false });
      }
    }
  }

  _setState(s) {
    if (this.state === s) return;
    this.state = s;
    this.stateTime = 0;
  }

  /** Current collision height — lower while sliding. */
  get collisionHeight() {
    const T = this.ctx.config.tune;
    return this.state === STATE.SLIDE ? T.slideHeight : T.playerHeight;
  }

  kill(cause) {
    if (!this.alive) return;
    this.alive = false;
    this._setState(STATE.DEAD);
    this.ctx.emit(EV.PLAYER_DEATH, { cause });
    this.ctx.emit(EV.RUN_END, { distance: this.z, cause });
  }

  reset() {
    const T = this.ctx.config.tune;
    this.state = STATE.RUN;
    this.lane = this.laneTarget = (T.laneCount / 2) | 0;
    this.laneT = 1;
    this.x = this.y = this.z = this.vy = 0;
    this.speed = T.startSpeed;
    this.baseSpeed = T.startSpeed;
    this._cornerFactor = 1;
    this.stateTime = 0;
    this.groundedTime = 0;
    this.alive = true;
    this._buffered = INTENT.NONE;
    this._bufferAge = 0;
    this.junction = null;
    this._turnOkAt = -1;
    this.turnsMade = 0;
    this.camLocked = false;
    this._camInit = false;
    // _camInit=false makes the next renderUpdate snap rather than glide in
    // from wherever the previous run ended.
  }

  // ---- camera ----------------------------------------------------------

  renderUpdate(dtReal) {
    const T = this.ctx.config.tune;
    const cam = this.ctx.scene.activeCamera;
    if (!cam) return;
    // Capture harness takes manual control of the camera for framed shots.
    if (this.camLocked) return;

    // Frame-rate independent smoothing.
    const kp = 1 - Math.pow(1 - T.camLagPos, dtReal * 60);
    const kr = 1 - Math.pow(1 - T.camLagRot, dtReal * 60);

    const track = this.ctx.tryGet('track');
    if (!track) return;
    const path = track.path;

    // SMOOTH IN PATH SPACE, NOT WORLD SPACE.
    //
    // The previous version lerped the camera's world position towards a target
    // world position. On a straight that is identical; through a corner it is
    // not, because a straight line between two points on a right-angled path
    // cuts across the inside of the bend — taking the camera through the
    // barrier and the corner wall. The playtester reported it as still
    // "bouncing off the barrier" after the character's own corner motion had
    // been fixed.
    //
    // Smoothing the path DISTANCE and the lateral offset instead, then
    // converting once, means the camera is always exactly on the path. It
    // physically cannot cut a corner or pass through track geometry.
    const wantS = Math.max(0, this.z - T.camDistance);
    const wantLat = this.x * 0.55;
    const wantY = T.camHeight + this.y * 0.35;
    const wantTgtS = this.z + T.camLookAhead;
    const wantTgtLat = this.x * 0.8;
    const wantTgtY = 1.20 + this.y * 0.55;

    if (!this._camInit) {
      this._camS = wantS; this._camLat = wantLat; this._camY = wantY;
      this._tgtS = wantTgtS; this._tgtLat = wantTgtLat; this._tgtY = wantTgtY;
      this._camInit = true;
    } else {
      // Forward motion is never lagged — lagging it reads as stutter.
      this._camS = wantS;
      this._tgtS = wantTgtS;
      this._camLat += (wantLat - this._camLat) * kp;
      this._camY += (wantY - this._camY) * kp;
      this._tgtLat += (wantTgtLat - this._tgtLat) * kr;
      this._tgtY += (wantTgtY - this._tgtY) * kr;
    }

    path.toWorld(this._camS, this._camLat, this._camY, this._wPos);
    path.toWorld(this._tgtS, this._tgtLat, this._tgtY, this._wTgt);

    cam.position.set(this._wPos[0], this._wPos[1], this._wPos[2]);
    this._camTarget.set(this._wTgt[0], this._wTgt[1], this._wTgt[2]);
    cam.setTarget(this._camTarget);

    // Widen the lens with speed. Small effect, big contribution to feel.
    const sp = (this.speed - T.startSpeed) / (T.maxSpeed - T.startSpeed);
    cam.fov = T.camFovBase + sp * T.camFovSpeedGain;
  }

  dispose() {
    for (const off of this._handlers) off();
    this._handlers.length = 0;
  }
}
