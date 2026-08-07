// Zone palettes — the world changes as the run goes on.
//
// A single environment for an endless runner is a wasted opportunity: the game
// has an unbounded distance axis and nothing mapped onto it except difficulty.
// Zones give progress a visible face, so a long run feels like a journey rather
// than a treadmill, and reaching a new one is its own small reward.
//
// The art direction is a jewel-box interior throughout: a vast dark space, gold
// light shafts from above, and a gem-coloured glow low down. Zones vary the gem
// and the temperature, never the fundamental language.
//
// Everything here is data. The panorama is baked once per zone at init and
// crossfaded on a sky dome; no per-frame canvas work.

export const ZONE_LENGTH = 620;   // metres per zone
export const BLEND_LENGTH = 150;  // metres of crossfade into the next

/**
 * sky    : gradient stops for the whole panorama, zenith first, nadir last.
 *          On a sphere v = 0.5 IS the horizon — the first version of this
 *          panorama put its bright horizon band at v = 0.78, which is fifty
 *          degrees below eye level, i.e. underground. All the value structure
 *          was painted where the floor covers it. The bright band belongs
 *          just ABOVE 0.5, where a clerestory would actually be.
 * shaft  : colour of the overhead light shafts and the clerestory windows
 * glow   : low gem glow, [r,g,b,alpha]
 * stone  : masonry silhouette colour, '#rrggbb'
 * warm   : the colour spilling out of the arcade openings
 * fog    : [r,g,b] — must sit close to the gradient's lower half or the track
 *          will appear to fade into a colour that is not behind it
 * env    : scene.environmentIntensity.
 *
 *          This used to sit around 2.0, on the reasoning that a dark room
 *          needs MORE image-based light because the metals are lit almost
 *          entirely by the cubemap. That is true of the character, and it was
 *          a disaster for the world, because IBL is ambient: it arrives from
 *          every direction, it casts nothing, and a shadow cannot remove it.
 *          With the environment supplying the large majority of every
 *          surface's light, the directional key had almost nothing left to
 *          take away — so the shadow map rendered correctly all week and
 *          changed almost no pixels.
 *
 *          Halved, with the key roughly doubled to compensate, the same scene
 *          suddenly has a light DIRECTION: lit faces and dark faces on one
 *          column, and hard bars where the colonnade crosses the floor.
 * bloom  : bloom weight. Also halved. At the old values ordinary marble was
 *          clearing the bloom threshold, which turned the bright end of the
 *          corridor into a featureless white oval and every particle into a
 *          soft white disc that read as dirt on the lens.
 *
 * ---------------------------------------------------------------------------
 * THE ROOM, NOT JUST THE SKY.
 *
 * For two rounds a zone was a sky swap and nothing else, and 3000 metres felt
 * like running the same 600 five times with the lights gelled. Everything
 * below is what makes zone 3 a different PLACE rather than a different filter:
 *
 * key    : [x,y,z] direction the key light travels. RE-NORMALISED after
 *          lerping — a component-wise lerp between two unit vectors is not a
 *          unit vector, and a directional light whose direction is 0.93 long
 *          is a directional light that quietly dims mid-crossfade.
 * keyI   : key intensity.
 * keyC   : key diffuse. See THE READABILITY BUDGET below.
 * keyS   : key specular.
 * ambI/ambC/ambG : hemispheric fill — intensity, sky colour, ground colour.
 *          This is where a zone is allowed to be saturated, because ambient
 *          light lifts everything equally and so cannot destroy the value
 *          separation the player reads obstacles by.
 * shadow : ShadowGenerator.darkness. 0 is a black shadow, 1 is no shadow.
 * fogD   : scene.fogDensity. The single strongest "how big is this room" dial
 *          in the file: 0.007 is cold clear air and a hundred visible metres,
 *          0.019 is a humid green murk that closes at fifty.
 * rise   : vertical scale of the transverse vault, about its springing line.
 *          0.8 is a squat barrel you want to duck under, 1.4 a lancet.
 * every  : place that vault on one bay in N. 2 opens the ceiling to the sky.
 * open   : lateral scale of the distant silhouette bands — how far away the
 *          far side of the hall is.
 * high   : vertical scale of the same. Together with `open` this is the
 *          difference between a tight gallery and a cathedral nave.
 *
 * THE READABILITY BUDGET, and it is the reason `keyC` is so timid next to
 * `ambC`. The track speaks three colours (see src/mat/index.js): gold you
 * collect, red you die on, white diamond you ignore. Those three have to
 * survive in all five rooms. A saturated red key in Ruby paints red light on
 * gold stars and on white bezels alike, and the hazard cords stop being the
 * only red thing in frame — which is a gameplay bug wearing an art hat. So
 * the KEY is where the readability budget is spent and it never leaves a
 * narrow warm-to-cool temperature band; the ZONE's colour lives in the air:
 * ambient, fog, the panorama, the glow. Direction and intensity are free —
 * they cost nothing in hue and they change the room completely.
 */
export const ZONES = [
  {
    name: 'Vault',
    sky: [
      [0.00, '#030306'], [0.24, '#0a0810'], [0.38, '#20182a'],
      [0.46, '#4a3327'], [0.56, '#241a1c'], [0.74, '#100b12'], [1.00, '#040308'],
    ],
    shaft: 'rgba(255,214,150,',
    shaftAlpha: 0.30,
    glow: [190, 150, 70, 0.30],
    stone: '#2a2331',
    warm: '#6b4a26',
    fog: [0.055, 0.050, 0.070],
    env: 1.02, bloom: 0.42,
    gem: [1.00, 0.78, 0.36],
    // The black-marble-and-gold hall the owner signed off. These are the
    // numbers that were already in world/index.js, moved here unchanged, and
    // zone 1 is the regression baseline for every other zone: whole-frame mean
    // and p50 must not move.
    key: [-0.80, -0.53, 0.28], keyI: 6.4,
    keyC: [1.00, 0.91, 0.78], keyS: [1.00, 0.96, 0.88],
    ambI: 0.10, ambC: [0.66, 0.74, 0.95], ambG: [0.14, 0.11, 0.09],
    shadow: 0.18, fogD: 0.0115,
    rise: 1.00, every: 1, open: 1.00, high: 1.00,
  },
  {
    name: 'Ruby',
    sky: [
      [0.00, '#080206'], [0.24, '#16050d'], [0.38, '#3d0a1d'],
      [0.46, '#7d1630'], [0.56, '#3a0a17'], [0.74, '#14040b'], [1.00, '#060204'],
    ],
    shaft: 'rgba(255,170,180,',
    shaftAlpha: 0.26,
    glow: [220, 45, 70, 0.42],
    stone: '#3a1220',
    warm: '#7d1b2c',
    fog: [0.090, 0.030, 0.048],
    env: 0.98, bloom: 0.46,
    gem: [1.00, 0.32, 0.42],
    // THE FORGE. A low, tight, smoky room. The key is dropped to seventeen
    // degrees of elevation and swung to the other side, so every column throws
    // a long bar the full width of the road and the lit face of the colonnade
    // changes sides as you cross the boundary — which is the cheapest possible
    // proof to the eye that it has gone somewhere. The red is all in the air:
    // a strong red hemispheric bounce and the densest fog after Emerald. The
    // key itself stays warm-white, or the hazard cords would stop being the
    // only red thing in the frame.
    key: [0.86, -0.30, -0.42], keyI: 7.4,
    keyC: [1.00, 0.86, 0.72], keyS: [1.00, 0.90, 0.80],
    ambI: 0.17, ambC: [0.95, 0.40, 0.40], ambG: [0.26, 0.06, 0.07],
    shadow: 0.10, fogD: 0.0166,
    rise: 0.80, every: 1, open: 0.80, high: 0.84,
  },
  {
    name: 'Sapphire',
    sky: [
      [0.00, '#02040c'], [0.24, '#060c22'], [0.38, '#0e2450'],
      [0.46, '#275c9c'], [0.56, '#0d2851'], [0.74, '#060c1e'], [1.00, '#02040a'],
    ],
    shaft: 'rgba(180,215,255,',
    shaftAlpha: 0.30,
    glow: [70, 130, 235, 0.38],
    stone: '#16233f',
    warm: '#1d4a86',
    fog: [0.035, 0.055, 0.105],
    env: 1.08, bloom: 0.42,
    gem: [0.44, 0.66, 1.00],
    // THE CISTERN. The opposite of Ruby in every dial. A steep, weak, cold key
    // almost straight down, so shadows are short pools rather than bars and
    // the room stops having a side; a big cold ambient doing most of the
    // lifting; the thinnest fog in the game, which is what actually makes it
    // feel vast — you can see the far end. Ceiling lifted to a lancet and the
    // vault only on every other bay, so most of what is overhead is sky.
    key: [-0.34, -0.90, 0.28], keyI: 5.0,
    keyC: [0.86, 0.93, 1.00], keyS: [0.90, 0.96, 1.00],
    ambI: 0.23, ambC: [0.54, 0.72, 1.00], ambG: [0.09, 0.13, 0.22],
    shadow: 0.34, fogD: 0.0072,
    rise: 1.42, every: 2, open: 1.32, high: 1.34,
  },
  {
    name: 'Emerald',
    sky: [
      [0.00, '#010708'], [0.24, '#041315'], [0.38, '#0b3835'],
      [0.46, '#1d785a'], [0.56, '#0a3730'], [0.74, '#041413'], [1.00, '#010606'],
    ],
    shaft: 'rgba(190,255,225,',
    shaftAlpha: 0.26,
    glow: [40, 200, 140, 0.34],
    stone: '#0e2b2a',
    warm: '#14624a',
    fog: [0.035, 0.080, 0.070],
    env: 1.05, bloom: 0.40,
    gem: [0.36, 1.00, 0.74],
    // THE OVERGROWN HALL. Humid: the thickest fog in the game, so the far end
    // is gone by fifty metres and the room reads as a clearing rather than a
    // corridor. The key comes back down and swings right again, but only to
    // forty degrees, and it is a shade green — the one place a tint is safe,
    // because green is not one of the three contract colours and pushing green
    // light onto gold and onto red moves neither of them towards the other.
    // Low ceiling, low silhouettes: everything here has sagged.
    key: [0.62, -0.66, -0.42], keyI: 5.9,
    keyC: [0.92, 1.00, 0.88], keyS: [0.94, 1.00, 0.92],
    ambI: 0.19, ambC: [0.40, 0.90, 0.68], ambG: [0.06, 0.17, 0.12],
    shadow: 0.14, fogD: 0.0188,
    rise: 0.90, every: 1, open: 0.92, high: 0.76,
  },
  {
    name: 'Gilt',
    sky: [
      [0.00, '#0a0703'], [0.24, '#1d1207'], [0.38, '#4d310d'],
      [0.46, '#ad7d2c'], [0.56, '#4a3210'], [0.74, '#1d1206'], [1.00, '#080502'],
    ],
    shaft: 'rgba(255,232,180,',
    shaftAlpha: 0.38,
    glow: [255, 190, 90, 0.46],
    stone: '#33230d',
    warm: '#8a6320',
    fog: [0.130, 0.098, 0.048],
    env: 0.92, bloom: 0.48,
    gem: [1.00, 0.82, 0.40],
    // THE TREASURY. The last zone, and the only one lit from behind the
    // camera: the key travels forward down the corridor, so the faces turned
    // towards the player are the lit ones and the whole room is a wall of
    // light rather than a raking silhouette. Brightest key in the game.
    //
    // This is the zone that can break the colour contract, because a gold room
    // full of gold light is a room where a gold star is not a star. Two things
    // stop it: the key is the COOLEST warm in the set — flatter and whiter
    // than Vault's — so gold reads by its specular, not by being the only warm
    // thing; and the ambient carries the brass instead. Checked by sampling
    // the star and the hazard cord in the lineup shot, not by eye.
    key: [-0.28, -0.62, 0.73], keyI: 8.2,
    keyC: [1.00, 0.96, 0.90], keyS: [1.00, 0.98, 0.94],
    ambI: 0.13, ambC: [1.00, 0.80, 0.48], ambG: [0.22, 0.16, 0.07],
    shadow: 0.22, fogD: 0.0132,
    rise: 1.16, every: 1, open: 1.14, high: 1.18,
  },
];

/**
 * Where the run is, in zone terms.
 * Returns { index, next, blend } where blend is 0..1 into `next`.
 */
export function zoneAt(distance) {
  const total = Math.max(0, distance);
  const index = Math.floor(total / ZONE_LENGTH) % ZONES.length;
  const into = total - Math.floor(total / ZONE_LENGTH) * ZONE_LENGTH;
  const blendFrom = ZONE_LENGTH - BLEND_LENGTH;
  const blend = into <= blendFrom ? 0 : (into - blendFrom) / BLEND_LENGTH;
  return { index, next: (index + 1) % ZONES.length, blend };
}

// Deterministic hash in [0,1). Not randomness — a pure function of an index,
// so the panorama is byte-identical every run without touching ctx.rng.
function h1(i) {
  const s = Math.sin(i * 127.1 + 311.7) * 43758.5453;
  return s - Math.floor(s);
}

/** '#rrggbb' -> 'rgba(r,g,b,' ready for an alpha to be appended. */
function rgba(hex) {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},`;
}

const BAYS = 10;   // architectural bays around the full 360 degrees

/**
 * Paint one zone's panorama into a 2D context.
 *
 * This is an EQUIRECTANGULAR map wrapped on a sky dome, not a screen gradient.
 * That distinction is the whole point: a gradient painted into a screen-space
 * layer cannot move, so the eye reads it as wallpaper no matter how well it is
 * drawn. On a dome the same painting has a real heading, so turning a corner
 * swings the room around the player and the backdrop stops being flat.
 *
 * v = 0 is the zenith, v = 0.5 the HORIZON, v = 1 the nadir. Bands, in order:
 * vault, clerestory (the light source, just above eye level so it reads over
 * the top of the colonnade), entablature, then the far hall below eye level —
 * which is visible either side of the track, because the track is only 7.2m
 * wide and the floor of the world stops at its rails.
 */
export function paintZone(c, zone, w, h) {
  const bayW = w / BAYS;
  const stone = rgba(zone.stone);
  const warm = rgba(zone.warm);
  const [gr, gg, gb, ga] = zone.glow;

  // Band edges, in v. These are not arbitrary: the chase camera sits 3m up and
  // looks DOWN about fourteen degrees, so the only sky that is ever on screen
  // runs from the horizon (v = 0.5) to roughly thirteen degrees above it
  // (v = 0.43). A clerestory painted higher than that is a clerestory nobody
  // will ever see — which is what the previous two versions of this panorama
  // both did, in different ways.
  const Y_VAULT = h * 0.26;     // ribbed vault, only visible on a jump
  const Y_CLERE_T = h * 0.395;  // bright windows start ~19 degrees up
  const Y_CLERE_B = h * 0.487;  // ...and end just above eye level
  const Y_ARC_T = h * 0.515;
  const Y_ARC_B = h * 0.655;
  const Y_FAR = h * 0.70;       // where the hall floor takes over

  // ---- 1. base value structure ----------------------------------------
  const g = c.createLinearGradient(0, 0, 0, h);
  for (const [stop, col] of zone.sky) g.addColorStop(stop, col);
  c.fillStyle = g;
  c.fillRect(0, 0, w, h);

  // ---- 2. the vault overhead -------------------------------------------
  // Ribs converge on the zenith, which is where every column of an
  // equirectangular map meets. Painting them as tapering wedges is therefore
  // geometrically correct as well as cheap.
  for (let i = -1; i <= BAYS; i++) {
    const x = i * bayW;
    c.fillStyle = stone + '0.55)';
    c.beginPath();
    c.moveTo(x - bayW * 0.012, 0);
    c.lineTo(x + bayW * 0.012, 0);
    c.lineTo(x + bayW * 0.075, Y_VAULT);
    c.lineTo(x - bayW * 0.075, Y_VAULT);
    c.closePath();
    c.fill();
    // gold arris along the rib — a hairline is enough to say "gilded"
    c.fillStyle = 'rgba(255,214,150,0.20)';
    c.fillRect(x - bayW * 0.010, Y_VAULT * 0.35, bayW * 0.020, Y_VAULT * 0.65);
  }
  // coffer courses: three faint arcs across the vault
  for (let k = 1; k <= 3; k++) {
    const y = (k / 4) * Y_VAULT;
    c.fillStyle = 'rgba(255,255,255,0.030)';
    c.fillRect(0, y, w, h * 0.006);
  }

  // ---- 2b. triforium: a blind gallery above the windows ------------------
  // The band between vault and clerestory is the top of the screen wherever
  // the corridor is not vaulted, and as a flat wash it was the last part of
  // the panorama still reading as paint. Small dark niches give it scale: you
  // can tell how far away a wall is when you can see its courses.
  const triT = Y_VAULT + (Y_CLERE_T - Y_VAULT) * 0.26;
  const triB = Y_CLERE_T - (Y_CLERE_T - Y_VAULT) * 0.10;
  const triStep = w / (BAYS * 3);
  c.fillStyle = stone + '0.45)';
  c.fillRect(0, triT - h * 0.006, w, h * 0.006);
  for (let i = 0; i < BAYS * 3; i++) {
    const cx = (i + 0.5) * triStep;
    const nw = triStep * 0.28;
    const sp = triT + nw;
    c.fillStyle = 'rgba(0,0,0,0.52)';
    c.beginPath();
    c.moveTo(cx - nw, triB);
    c.lineTo(cx - nw, sp);
    c.arc(cx, sp, nw, Math.PI, 0);
    c.lineTo(cx + nw, triB);
    c.closePath();
    c.fill();
    c.fillStyle = 'rgba(255,236,205,0.06)';
    c.fillRect(cx - nw - triStep * 0.11, triT, triStep * 0.09, triB - triT);
  }
  c.fillStyle = stone + '0.40)';
  c.fillRect(0, triB, w, h * 0.008);

  // ---- 3. clerestory: the light source ----------------------------------
  // Dark piers, bright openings. This band carries almost all the contrast in
  // the image; without it the interior has no reason to be lit at all.
  c.fillStyle = 'rgba(0,0,0,0.42)';
  c.fillRect(0, Y_CLERE_T, w, Y_CLERE_B - Y_CLERE_T);

  for (let i = -1; i <= BAYS; i++) {
    const cx = i * bayW + bayW * 0.5;
    const halfW = bayW * 0.19;
    const top = Y_CLERE_T + (Y_CLERE_B - Y_CLERE_T) * 0.10;
    const bot = Y_CLERE_B - (Y_CLERE_B - Y_CLERE_T) * 0.06;
    const springs = top + halfW;

    // halo first, so the window sits inside its own glare
    const halo = c.createRadialGradient(cx, (top + bot) * 0.5, 1, cx, (top + bot) * 0.5, bayW * 0.62);
    halo.addColorStop(0, zone.shaft + (zone.shaftAlpha * 0.62) + ')');
    halo.addColorStop(1, zone.shaft + '0)');
    c.fillStyle = halo;
    c.fillRect(cx - bayW, top - h * 0.06, bayW * 2, (bot - top) + h * 0.12);

    // the opening: a round-headed light with a bright sill
    const wg = c.createLinearGradient(0, top, 0, bot);
    wg.addColorStop(0, 'rgba(255,252,244,0.80)');
    wg.addColorStop(0.45, zone.shaft + '0.85)');
    wg.addColorStop(1, warm + '0.55)');
    c.fillStyle = wg;
    c.beginPath();
    c.moveTo(cx - halfW, bot);
    c.lineTo(cx - halfW, springs);
    c.arc(cx, springs, halfW, Math.PI, 0);
    c.lineTo(cx + halfW, bot);
    c.closePath();
    c.fill();

    // mullion, so the opening reads as tracery rather than a blob
    c.fillStyle = stone + '0.75)';
    c.fillRect(cx - bayW * 0.012, springs, bayW * 0.024, bot - springs);
    c.fillRect(cx - halfW, springs + (bot - springs) * 0.42, halfW * 2, h * 0.005);
  }

  // ---- 3b. the entablature the clerestory sits on ------------------------
  // A dark horizontal band right at eye level. It is what separates "sky" from
  // "room" and gives the far architecture a base to stand on.
  c.fillStyle = stone + '0.95)';
  c.fillRect(0, Y_CLERE_B, w, Y_ARC_T - Y_CLERE_B);
  c.fillStyle = 'rgba(255,226,180,0.16)';
  c.fillRect(0, Y_CLERE_B, w, h * 0.006);
  c.fillStyle = 'rgba(0,0,0,0.35)';
  c.fillRect(0, Y_ARC_T - h * 0.008, w, h * 0.008);

  // ---- 4. the great arcade, below eye level -----------------------------
  c.fillStyle = 'rgba(0,0,0,0.30)';
  c.fillRect(0, Y_ARC_T, w, Y_ARC_B - Y_ARC_T);

  for (let i = -1; i <= BAYS; i++) {
    const cx = i * bayW + bayW * 0.5;
    const halfW = bayW * 0.30;
    const top = Y_ARC_T + (Y_ARC_B - Y_ARC_T) * 0.06;
    const bot = Y_ARC_B;
    const springs = top + halfW * 0.9;

    // the void beyond the arch, with warmth pooling at its foot
    const og = c.createLinearGradient(0, top, 0, bot);
    og.addColorStop(0, 'rgba(0,0,0,0.88)');
    og.addColorStop(0.5, 'rgba(0,0,0,0.62)');
    og.addColorStop(1, warm + '0.72)');
    c.fillStyle = og;
    c.beginPath();
    c.moveTo(cx - halfW, bot);
    c.lineTo(cx - halfW, springs);
    c.arc(cx, springs, halfW, Math.PI, 0);
    c.lineTo(cx + halfW, bot);
    c.closePath();
    c.fill();

    // arch ring + keystone
    c.strokeStyle = stone + '0.95)';
    c.lineWidth = bayW * 0.045;
    c.beginPath();
    c.arc(cx, springs, halfW + c.lineWidth * 0.5, Math.PI, 0);
    c.stroke();
    c.fillStyle = 'rgba(255,214,150,0.32)';
    c.fillRect(cx - bayW * 0.028, springs - halfW - c.lineWidth, bayW * 0.056, c.lineWidth * 1.8);

    // piers either side, catching a rim of light on one edge
    const px = i * bayW;
    c.fillStyle = stone + '0.90)';
    c.fillRect(px - bayW * 0.085, Y_ARC_T, bayW * 0.17, Y_ARC_B - Y_ARC_T);
    c.fillStyle = 'rgba(255,236,205,0.10)';
    c.fillRect(px - bayW * 0.085, Y_ARC_T, bayW * 0.022, Y_ARC_B - Y_ARC_T);
  }

  // ---- 5. distant colonnade, well below the arcade -----------------------
  for (let i = 0; i < BAYS * 3; i++) {
    const x = (i / (BAYS * 3)) * w + h1(i) * bayW * 0.12;
    const wdt = bayW * (0.055 + h1(i + 40) * 0.04);
    const top = Y_ARC_B + (Y_FAR - Y_ARC_B) * (0.05 + h1(i + 80) * 0.18);
    c.fillStyle = 'rgba(0,0,0,0.42)';
    c.fillRect(x - wdt * 0.5, top, wdt, Y_FAR - top);
  }

  // ---- 6. light shafts, raked off vertical -------------------------------
  // Drawn additively so they brighten what they cross instead of greying it.
  c.globalCompositeOperation = 'lighter';
  for (let i = -1; i <= BAYS; i++) {
    const cx = i * bayW + bayW * 0.5;
    const skew = bayW * 0.30;
    const topW = bayW * 0.16;
    const botW = bayW * 0.44;
    const sg = c.createLinearGradient(0, Y_CLERE_T, 0, Y_FAR + h * 0.06);
    sg.addColorStop(0, zone.shaft + (zone.shaftAlpha * 0.9) + ')');
    sg.addColorStop(0.55, zone.shaft + (zone.shaftAlpha * 0.30) + ')');
    sg.addColorStop(1, zone.shaft + '0)');
    c.fillStyle = sg;
    c.beginPath();
    c.moveTo(cx - topW, Y_CLERE_T);
    c.lineTo(cx + topW, Y_CLERE_T);
    c.lineTo(cx + skew + botW, Y_FAR + h * 0.06);
    c.lineTo(cx + skew - botW, Y_FAR + h * 0.06);
    c.closePath();
    c.fill();
  }

  // hanging lights: a few bright points high in the room
  for (let i = 0; i < BAYS; i += 2) {
    const cx = i * bayW + bayW * 0.5;
    const cy = Y_VAULT + h * 0.02;
    const gl = c.createRadialGradient(cx, cy, 1, cx, cy, bayW * 0.30);
    gl.addColorStop(0, 'rgba(255,240,210,0.85)');
    gl.addColorStop(0.25, zone.shaft + '0.35)');
    gl.addColorStop(1, zone.shaft + '0)');
    c.fillStyle = gl;
    c.fillRect(cx - bayW * 0.4, cy - bayW * 0.4, bayW * 0.8, bayW * 0.8);
  }

  // gem pools along the horizon — several, not one, so a turn always finds
  // light somewhere rather than swinging a single blob into view
  for (let i = 0; i < BAYS; i++) {
    const cx = i * bayW + bayW * (0.2 + h1(i + 7) * 0.6);
    const amp = 0.70 + h1(i + 21) * 0.95;
    const rad = bayW * (0.7 + h1(i + 33) * 0.8);
    const gl = c.createRadialGradient(cx, Y_FAR, 1, cx, Y_FAR, rad);
    gl.addColorStop(0, `rgba(${gr},${gg},${gb},${ga * amp})`);
    gl.addColorStop(0.4, `rgba(${gr},${gg},${gb},${ga * amp * 0.35})`);
    gl.addColorStop(1, `rgba(${gr},${gg},${gb},0)`);
    c.fillStyle = gl;
    c.fillRect(cx - rad, Y_FAR - rad, rad * 2, rad * 2);
  }
  c.globalCompositeOperation = 'source-over';

  // ---- 7. haze -----------------------------------------------------------
  // Everything below the clerestory washes progressively into the fog colour.
  // This is what makes the room feel deep rather than papered: near-black
  // architecture at the top, dissolved architecture at the bottom.
  const [fr, fg, fb] = zone.fog;
  const fogCol = `${Math.round(fr * 255 * 2.6)},${Math.round(fg * 255 * 2.6)},${Math.round(fb * 255 * 2.6)}`;
  const hz = c.createLinearGradient(0, Y_CLERE_B, 0, h);
  hz.addColorStop(0, `rgba(${fogCol},0.14)`);
  hz.addColorStop(0.26, `rgba(${fogCol},0.40)`);
  hz.addColorStop(0.52, `rgba(${fogCol},0.52)`);
  hz.addColorStop(1, 'rgba(0,0,0,0.42)');
  c.fillStyle = hz;
  c.fillRect(0, Y_CLERE_B, w, h - Y_CLERE_B);

  // a hard-ish horizon line keeps the floor from merging into the wall
  const hb = c.createLinearGradient(0, Y_FAR - h * 0.03, 0, Y_FAR + h * 0.04);
  hb.addColorStop(0, 'rgba(255,246,230,0)');
  hb.addColorStop(0.45, 'rgba(255,246,230,0.10)');
  hb.addColorStop(1, 'rgba(255,246,230,0)');
  c.fillStyle = hb;
  c.fillRect(0, Y_FAR - h * 0.03, w, h * 0.07);

  // ---- 8. floor reflections ---------------------------------------------
  // A polished floor answers the clerestory. Cheap, and it stops the lower
  // third being a dead band.
  c.globalCompositeOperation = 'lighter';
  for (let i = -1; i <= BAYS; i++) {
    const cx = i * bayW + bayW * 0.5;
    const rg = c.createLinearGradient(0, Y_FAR, 0, h * 0.96);
    rg.addColorStop(0, zone.shaft + '0.22)');
    rg.addColorStop(1, zone.shaft + '0)');
    c.fillStyle = rg;
    c.beginPath();
    c.moveTo(cx - bayW * 0.10, Y_FAR);
    c.lineTo(cx + bayW * 0.10, Y_FAR);
    c.lineTo(cx + bayW * 0.30, h * 0.96);
    c.lineTo(cx - bayW * 0.30, h * 0.96);
    c.closePath();
    c.fill();
  }
  c.globalCompositeOperation = 'source-over';

  // nadir: fade to black so the pole pinch has nothing to pinch
  const nd = c.createLinearGradient(0, h * 0.90, 0, h);
  nd.addColorStop(0, 'rgba(0,0,0,0)');
  nd.addColorStop(1, 'rgba(0,0,0,0.95)');
  c.fillStyle = nd;
  c.fillRect(0, h * 0.90, w, h * 0.10);
}
