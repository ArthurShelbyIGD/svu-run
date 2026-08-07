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

/** Depth of the intent queue. See the comment on `_q` in the constructor. */
const Q_MAX = 3;

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
    //
    // A SMALL QUEUE, NOT A SINGLE SLOT.
    // This used to be one `_buffered` field, so a second input inside the
    // buffer window silently overwrote the first: swipe left-then-jump quickly
    // and the left vanished. Fixed depth, fixed-size typed arrays, no
    // allocation anywhere on the input path. Depth 3 is enough for any human
    // burst inside a 0.15-0.30s window; a fourth input drops the OLDEST, which
    // is the one least likely to still be wanted.
    this._q = new Uint8Array(Q_MAX);
    this._qAge = new Float32Array(Q_MAX);
    this._qLen = 0;
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
    // Was two object literals emitted per slide. Small, but it is allocation
    // on the hot path and the rule is the rule.
    this._pSlide = { active: false };
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

  /**
   * Touch and mouse.
   *
   * THE SWIPE IS RECOGNISED ON MOVE, NOT ON LIFT. This is the single largest
   * latency win in the game and it is worth spelling out why.
   *
   * The previous version only decided what a gesture meant in `touchend`.
   * Nothing at all happened until the finger left the glass, so the floor on
   * input latency was the whole duration of the gesture — 150-250ms of finger
   * travel — and everything else piled on top of that: the intent buffer, the
   * wait for the next fixed step, the wait for the next presented frame (up to
   * 66ms on a 15fps device), Android's own touch sampling, then the
   * compositor. Measured end to end that is 270-400ms, and it is why the game
   * was reported as "very laggy" on a low-end phone. Almost none of it was
   * frame rate.
   *
   * Deciding the moment the finger crosses `swipeMinDistance` removes the
   * whole first term on every device, phone and desktop alike. touchmove was
   * already bound non-passively to swallow page scrolling, so listening costs
   * nothing.
   *
   * The gesture origin is then RE-ARMED where the swipe was recognised, so a
   * second swipe can start immediately without the finger coming up. That is
   * the other half of "I can't change lanes quickly": before, two lane changes
   * required two complete down-move-up cycles.
   */
  _bindTouch() {
    const canvas = this.ctx.canvas;

    const down = (e) => {
      if (this._touchId !== null) return;
      const t = e.changedTouches ? e.changedTouches[0] : e;
      this._touchId = e.changedTouches ? t.identifier : 'mouse';
      this._arm(t.clientX, t.clientY);
    };

    const move = (e) => {
      // Unconditional, and before any early-out: this listener is also what
      // stops the page scrolling and rubber-banding under the finger.
      if (e.cancelable) e.preventDefault();
      if (this._touchId === null) return;
      const t = this._pickTouch(e);
      if (t) this._recognise(t.clientX, t.clientY);
    };

    const up = (e) => {
      if (this._touchId === null) return;
      const t = this._pickTouch(e);
      if (!t) return;
      this._touchId = null;
      // A flick fast enough to produce no touchmove at all still has to work,
      // and so does a mouse drag on desktop. If the move handler already fired
      // this gesture it re-armed the origin there, so this second look sees a
      // sub-threshold delta and does nothing — no double fire.
      this._recognise(t.clientX, t.clientY);
    };

    const cancel = () => { this._touchId = null; };

    // passive:false on touchstart too — Chrome will not let a non-passive
    // touchmove cancel scrolling that a passive touchstart already conceded.
    canvas.addEventListener('touchstart', down, { passive: false });
    canvas.addEventListener('touchmove', move, { passive: false });
    canvas.addEventListener('touchend', up, { passive: true });
    canvas.addEventListener('touchcancel', cancel, { passive: true });
    canvas.addEventListener('mousedown', down);
    canvas.addEventListener('mousemove', move);
    canvas.addEventListener('mouseup', up);
    this._handlers.push(() => {
      canvas.removeEventListener('touchstart', down);
      canvas.removeEventListener('touchmove', move);
      canvas.removeEventListener('touchend', up);
      canvas.removeEventListener('touchcancel', cancel);
      canvas.removeEventListener('mousedown', down);
      canvas.removeEventListener('mousemove', move);
      canvas.removeEventListener('mouseup', up);
    });
  }

  /** The touch this gesture is tracking, or null. Allocation-free. */
  _pickTouch(e) {
    if (!e.changedTouches) return this._touchId === 'mouse' ? e : null;
    for (let i = 0; i < e.changedTouches.length; i++) {
      if (e.changedTouches[i].identifier === this._touchId) return e.changedTouches[i];
    }
    return null;
  }

  _arm(x, y) {
    this._touchStart.x = x;
    this._touchStart.y = y;
    this._touchStart.t = performance.now();
  }

  /**
   * Test the live gesture against the swipe threshold and fire if it crosses.
   * Returns true if an intent was produced. Called from both touchmove and
   * touchend, and safe to call as often as the browser delivers events.
   */
  _recognise(x, y) {
    const T = this.ctx.config.tune;
    const g = this._touchStart;
    const now = performance.now();

    // A ROLLING window rather than a hard reject. If the finger has been down
    // longer than swipeMaxTime the gesture is not a swipe *yet* — re-arm where
    // it currently sits so a rest-then-flick still reads as a flick. The old
    // code discarded the whole gesture instead, which meant a finger resting
    // on the screen was input-dead until it lifted.
    if ((now - g.t) / 1000 > T.swipeMaxTime) {
      g.x = x; g.y = y; g.t = now;
      return false;
    }

    const dx = x - g.x, dy = y - g.y;
    const adx = dx < 0 ? -dx : dx, ady = dy < 0 ? -dy : dy;
    if (adx < T.swipeMinDistance && ady < T.swipeMinDistance) return false;

    if (adx > ady) this.pushIntent(dx > 0 ? INTENT.RIGHT : INTENT.LEFT);
    else this.pushIntent(dy > 0 ? INTENT.SLIDE : INTENT.JUMP);

    // Re-arm at the point of recognition: the next swipe starts here, now.
    g.x = x; g.y = y; g.t = now;
    return true;
  }

  /** Queue an intent. Buffered briefly so slightly-early inputs still land. */
  pushIntent(intent) {
    if (!intent) return;
    if (this._qLen === Q_MAX) {
      // Full. Drop the oldest — three unserved inputs inside one buffer window
      // means the player is ahead of the game, and the stalest is the least
      // likely to still be wanted.
      for (let i = 1; i < Q_MAX; i++) {
        this._q[i - 1] = this._q[i];
        this._qAge[i - 1] = this._qAge[i];
      }
      this._qLen--;
    }
    this._q[this._qLen] = intent;
    this._qAge[this._qLen] = 0;
    this._qLen++;
  }

  /** Drop queue entry `i`, keeping the rest in order. Allocation-free. */
  _dropIntent(i) {
    for (let k = i + 1; k < this._qLen; k++) {
      this._q[k - 1] = this._q[k];
      this._qAge[k - 1] = this._qAge[k];
    }
    this._qLen--;
  }

  /**
   * How long an unserved intent survives, in seconds of game time.
   *
   * `tune.inputBuffer` alone is a fixed 0.14s, which is about eight rendered
   * frames on a fast phone and TWO on a slow one — so the device that needs
   * the most forgiveness got the least. The window is now also expressed in
   * FRAMES of the device's measured frame time, and the larger of the two
   * wins. On a 60fps device this changes nothing (4 frames = 0.067s, under the
   * 0.14 floor); on a 15fps device it roughly doubles, which is most of "slide
   * and jump are hit and miss".
   *
   * Capped, because an arbitrarily long window turns a late input into a
   * mysterious one — and because the software renderer in the test harness
   * would otherwise buffer for over a second.
   *
   * Pinned to the base value in capture mode so posed screenshots stay
   * bit-identical regardless of how slowly the harness renders.
   */
  get bufferWindow() {
    const T = this.ctx.config.tune;
    if (this.ctx.config.captureMode) return T.inputBuffer;
    const loop = this.ctx.loop;
    const f = loop && loop.avgFrameSec > 0 ? loop.avgFrameSec : 1 / 60;
    const scaled = T.inputBufferFrames * f;
    return Math.min(T.inputBufferMax, scaled > T.inputBuffer ? scaled : T.inputBuffer);
  }

  /** Head of the intent queue, for tools and tests. INTENT.NONE when empty. */
  get buffered() { return this._qLen > 0 ? this._q[0] : INTENT.NONE; }

  // ---- simulation ------------------------------------------------------

  fixedUpdate(dt) {
    if (!this.alive) return;
    const T = this.ctx.config.tune;

    this.stateTime += dt;
    const win = this.bufferWindow;
    for (let i = 0; i < this._qLen;) {
      this._qAge[i] += dt;
      if (this._qAge[i] > win) this._dropIntent(i);
      else i++;
    }

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

  /**
   * Serve at most one intent per simulation step.
   *
   * Walks the queue rather than looking only at the head, so an intent that
   * cannot be served yet — a jump while airborne, say — does not block the
   * lane change queued behind it. The blocked one stays queued until it
   * becomes servable or ages out; that IS the input buffer, and it is the
   * reason a jump pressed a few frames before landing still fires.
   *
   * One per step, not one per frame: at 15fps the loop runs four fixed steps
   * per frame, so a two-swipe burst still drains inside a single frame.
   */
  _consumeIntent(T) {
    for (let i = 0; i < this._qLen; i++) {
      if (this._serveIntent(this._q[i], T)) {
        this._dropIntent(i);
        return;
      }
    }
  }

  /** Attempt one intent. Returns true if it was acted on (or discarded). */
  _serveIntent(i, T) {
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
        return true;
      }

      const next = this.laneTarget + dir;
      if (next >= 0 && next < T.laneCount) {
        this._pLane.from = this.laneTarget;
        this._pLane.to = next;
        this.laneTarget = next;
        this.laneT = 0;
        this.ctx.emit(EV.PLAYER_LANE, this._pLane);
      }
      // Consumed either way. Re-queueing a left at the leftmost lane would
      // fire it the instant the player moved right again, which is a lane
      // change nobody asked for.
      return true;
    }

    if (i === INTENT.JUMP) {
      const canJump = this.state === STATE.RUN ||
        this.state === STATE.SLIDE ||
        (this.state === STATE.AIR && this.groundedTime < T.coyoteTime);
      if (!canJump) return false;   // stays queued — this is the jump buffer
      // v chosen so the apex is exactly jumpHeight
      const g = (8 * T.jumpHeight) / (T.jumpTime * T.jumpTime);
      this.vy = Math.sqrt(2 * g * T.jumpHeight);
      this._setState(STATE.AIR);
      this.ctx.emit(EV.PLAYER_JUMP, null);
      return true;
    }

    if (i === INTENT.SLIDE) {
      if (this.state === STATE.RUN) {
        this._setState(STATE.SLIDE);
        this._pSlide.active = true;
        this.ctx.emit(EV.PLAYER_SLIDE, this._pSlide);
      } else if (this.state === STATE.AIR) {
        this.vy = Math.min(this.vy, -12); // fast-fall into a slide
      }
      return true;
    }

    return true;
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
        this._pSlide.active = false;
        this.ctx.emit(EV.PLAYER_SLIDE, this._pSlide);
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
    this._qLen = 0;
    this._touchId = null;
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
    // Pull the look-ahead point in near a corner.
    //
    // At full look-ahead the target rounds the corner ~8m before the player
    // does, so the camera turns to face the new corridor while the player is
    // still in the old one — and the player slides to the edge of frame at
    // exactly the moment they most need to see themselves. Shortening the
    // look-ahead keeps them centred through the bend.
    const dj = this.junction ? Math.abs(this.junction.s - this.z) : Infinity;
    const nearCorner = Math.min(1, Math.max(0, (dj - 4) / 14));
    const lookAhead = 2.6 + (T.camLookAhead - 2.6) * nearCorner;
    const wantTgtS = this.z + lookAhead;
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
