// world/sky.js — the room the game happens inside.
//
// WHY A DOME AND NOT A LAYER.
// The previous sky was a vertical gradient painted into a background Layer.
// It was cheap and it could not be clipped, but it had one fatal property: it
// never moved. A backdrop that is identical whichever way the player is facing
// is read by the eye as wallpaper within about two seconds, and no amount of
// painting fixes that. The owner's verdict — "I can't even get a sky that
// looks anything like one" — is a verdict on the parallax, not the paint.
//
// This is an equirectangular panorama on a dome with `infiniteDistance`. The
// dome follows the camera's POSITION but not its ROTATION, so:
//   - it can never be clipped by the far plane (it is always centred on the
//     camera, at a radius well inside maxZ) — the bug that killed the first
//     sky sphere;
//   - turning a corner swings the whole room around the player, which is
//     exactly the cue that says "this is a place, not a picture".
//
// Two domes, not one, so zones crossfade: the inner dome carries the incoming
// zone and its alpha is the blend.

import {
  MeshBuilder, StandardMaterial, DynamicTexture, Texture, Color3, Mesh,
} from '../core/bjs.js';
import { ZONES, paintZone } from './zones.js';

const RADIUS = 240;   // comfortably inside the 320m far plane

export default class Sky {
  constructor(ctx) {
    this.ctx = ctx;
    this.textures = [];
    this.domeA = null;
    this.domeB = null;
  }

  init() {
    const scene = this.ctx.scene;
    const q = this.ctx.config.q;

    // A phone does not need a 2048-wide panorama to sell a dark room, and the
    // bake cost is linear in pixels — five zones at full size is the single
    // largest chunk of init time in the whole game.
    const W = q.name === 'low' ? 640 : 1280;
    const H = W >> 1;

    this.textures = ZONES.map((zone, i) => {
      const tex = new DynamicTexture(`sky${i}`, { width: W, height: H }, scene, true);
      paintZone(tex.getContext(), zone, W, H);
      tex.update(false);
      tex.wrapU = Texture.WRAP_ADDRESSMODE;
      tex.wrapV = Texture.CLAMP_ADDRESSMODE;
      tex.anisotropicFilteringLevel = q.anisotropy;
      tex.hasAlpha = false;
      return tex;
    });

    this.domeA = this._makeDome('skyA', RADIUS, q);
    this.domeB = this._makeDome('skyB', RADIUS * 0.985, q);
    this.matB.alpha = 0;
    this.domeB.setEnabled(false);
  }

  _makeDome(name, radius, q) {
    const scene = this.ctx.scene;
    const dome = MeshBuilder.CreateSphere(name, {
      diameter: radius * 2,
      segments: q.name === 'low' ? 20 : 32,
      sideOrientation: Mesh.BACKSIDE,
    }, scene);

    const m = new StandardMaterial(`${name}Mat`, scene);
    m.disableLighting = true;
    m.diffuseColor = new Color3(0, 0, 0);
    m.specularColor = new Color3(0, 0, 0);
    // The panorama goes in the DIFFUSE slot with an emissive tint, not in the
    // emissive slot. Babylon's standard shader ADDS emissiveColor to the
    // emissive texture and then MULTIPLIES the result by the diffuse texture:
    //     finalDiffuse = clamp(lighting * diffuseColor + emissiveColor) * base
    // so an emissive texture with a white emissiveColor renders as solid white
    // — which is exactly what the first build of this dome did. Putting the
    // image in `base` and the tint in `emissiveColor` gives the multiply that
    // was wanted, and makes the whole sky dimmable with one Color3.
    m.diffuseTexture = this.textures[0];
    m.emissiveColor = new Color3(1, 1, 1);
    m.backFaceCulling = true;
    m.disableDepthWrite = false;
    dome.material = m;

    dome.infiniteDistance = true;   // rides with the camera, never clipped
    dome.applyFog = false;          // the room IS the fog; do not fog it twice
    dome.isPickable = false;
    dome.alwaysSelectAsActiveMesh = true;
    dome.doNotSyncBoundingInfo = true;

    if (name === 'skyA') this.matA = m; else this.matB = m;
    return dome;
  }

  /**
   * Point the domes at zone `index`, blended `blend` into `next`.
   * Called every frame from world/, so it must not allocate.
   */
  setZone(index, next, blend) {
    if (!this.domeA) return;
    if (this._index !== index) {
      this._index = index;
      this.matA.diffuseTexture = this.textures[index];
      this.matB.diffuseTexture = this.textures[next];
    }
    this.matB.alpha = blend;
    // A fully transparent dome still costs a full-screen draw. Switching it
    // off outside the crossfade window is free and saves that draw for the
    // ~75% of a zone that is not blending.
    const want = blend > 0.004;
    if (this._bOn !== want) {
      this._bOn = want;
      this.domeB.setEnabled(want);
    }
  }

  dispose() {
    if (this.domeA) { this.domeA.material.dispose(); this.domeA.dispose(); }
    if (this.domeB) { this.domeB.material.dispose(); this.domeB.dispose(); }
    for (const t of this.textures) t.dispose();
    this.textures.length = 0;
  }
}
