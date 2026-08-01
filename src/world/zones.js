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
 *          The horizon sits at v = 0.78, which is where the brightest stop
 *          should go — that is what makes the room read as lit from the sides
 *          rather than as a vertical wash.
 * shaft  : colour of the overhead light shafts and the clerestory windows
 * glow   : low gem glow, [r,g,b,alpha]
 * stone  : masonry silhouette colour, '#rrggbb'
 * warm   : the colour spilling out of the arcade openings
 * fog    : [r,g,b] — must sit close to the gradient's lower half or the track
 *          will appear to fade into a colour that is not behind it
 * env    : scene.environmentIntensity. Dark rooms need MORE, not less: the
 *          metals are lit almost entirely by the environment cubemap, and if
 *          it is dimmed to match the backdrop the character goes flat.
 * bloom  : bloom weight; gem glows want more than daylight would
 */
export const ZONES = [
  {
    name: 'Vault',
    sky: [
      [0.00, '#030306'], [0.20, '#08070e'], [0.44, '#151020'],
      [0.62, '#241a24'], [0.78, '#4a3427'], [0.90, '#140f12'], [1.00, '#050408'],
    ],
    shaft: 'rgba(255,214,150,',
    shaftAlpha: 0.30,
    glow: [190, 150, 70, 0.30],
    stone: '#2a2331',
    warm: '#6b4a26',
    fog: [0.055, 0.050, 0.070],
    env: 1.95, bloom: 0.85,
    gem: [1.00, 0.78, 0.36],
  },
  {
    name: 'Ruby',
    sky: [
      [0.00, '#080206'], [0.20, '#14040c'], [0.44, '#2e0817'],
      [0.62, '#4a0d22'], [0.78, '#8a1c36'], [0.90, '#20060e'], [1.00, '#080205'],
    ],
    shaft: 'rgba(255,170,180,',
    shaftAlpha: 0.26,
    glow: [220, 45, 70, 0.42],
    stone: '#3a1220',
    warm: '#7d1b2c',
    fog: [0.090, 0.030, 0.048],
    env: 1.85, bloom: 0.95,
    gem: [1.00, 0.32, 0.42],
  },
  {
    name: 'Sapphire',
    sky: [
      [0.00, '#02040c'], [0.20, '#050a1e'], [0.44, '#0a1a3e'],
      [0.62, '#123063'], [0.78, '#2a63a6'], [0.90, '#07122a'], [1.00, '#02040c'],
    ],
    shaft: 'rgba(180,215,255,',
    shaftAlpha: 0.30,
    glow: [70, 130, 235, 0.38],
    stone: '#16233f',
    warm: '#1d4a86',
    fog: [0.035, 0.055, 0.105],
    env: 2.05, bloom: 0.85,
    gem: [0.44, 0.66, 1.00],
  },
  {
    name: 'Emerald',
    sky: [
      [0.00, '#010708'], [0.20, '#041113'], [0.44, '#082a28'],
      [0.62, '#0d4438'], [0.78, '#1e7a5c'], [0.90, '#051815'], [1.00, '#010707'],
    ],
    shaft: 'rgba(190,255,225,',
    shaftAlpha: 0.26,
    glow: [40, 200, 140, 0.34],
    stone: '#0e2b2a',
    warm: '#14624a',
    fog: [0.035, 0.080, 0.070],
    env: 2.00, bloom: 0.80,
    gem: [0.36, 1.00, 0.74],
  },
  {
    name: 'Gilt',
    sky: [
      [0.00, '#0a0703'], [0.20, '#1a1006'], [0.44, '#3a260a'],
      [0.62, '#5e3f11'], [0.78, '#b8862f'], [0.90, '#241705'], [1.00, '#0a0703'],
    ],
    shaft: 'rgba(255,232,180,',
    shaftAlpha: 0.38,
    glow: [255, 190, 90, 0.46],
    stone: '#33230d',
    warm: '#8a6320',
    fog: [0.130, 0.098, 0.048],
    env: 1.75, bloom: 1.00,
    gem: [1.00, 0.82, 0.40],
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
 * v = 0 is the zenith, v = 0.78 the horizon, v = 1 the nadir. The room is
 * built in bands: vault, clerestory (the light source), arcade, colonnade,
 * horizon haze, floor.
 */
export function paintZone(c, zone, w, h) {
  const bayW = w / BAYS;
  const stone = rgba(zone.stone);
  const warm = rgba(zone.warm);
  const [gr, gg, gb, ga] = zone.glow;

  const Y_VAULT = h * 0.19;
  const Y_CLERE_T = h * 0.21;
  const Y_CLERE_B = h * 0.44;
  const Y_ARC_T = h * 0.46;
  const Y_ARC_B = h * 0.70;
  const Y_HORIZ = h * 0.78;

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
    halo.addColorStop(0, zone.shaft + (zone.shaftAlpha * 0.85) + ')');
    halo.addColorStop(1, zone.shaft + '0)');
    c.fillStyle = halo;
    c.fillRect(cx - bayW, top - h * 0.06, bayW * 2, (bot - top) + h * 0.12);

    // the opening: a round-headed light with a bright sill
    const wg = c.createLinearGradient(0, top, 0, bot);
    wg.addColorStop(0, 'rgba(255,255,255,0.92)');
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

  // ---- 4. the great arcade ----------------------------------------------
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
    og.addColorStop(0, 'rgba(0,0,0,0.86)');
    og.addColorStop(0.55, 'rgba(0,0,0,0.70)');
    og.addColorStop(1, warm + '0.42)');
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
    const top = Y_ARC_B + (Y_HORIZ - Y_ARC_B) * (0.05 + h1(i + 80) * 0.18);
    c.fillStyle = 'rgba(0,0,0,0.42)';
    c.fillRect(x - wdt * 0.5, top, wdt, Y_HORIZ - top);
  }

  // ---- 6. light shafts, raked off vertical -------------------------------
  // Drawn additively so they brighten what they cross instead of greying it.
  c.globalCompositeOperation = 'lighter';
  for (let i = -1; i <= BAYS; i++) {
    const cx = i * bayW + bayW * 0.5;
    const skew = bayW * 0.30;
    const topW = bayW * 0.16;
    const botW = bayW * 0.44;
    const sg = c.createLinearGradient(0, Y_CLERE_T, 0, Y_HORIZ + h * 0.05);
    sg.addColorStop(0, zone.shaft + (zone.shaftAlpha * 0.9) + ')');
    sg.addColorStop(0.55, zone.shaft + (zone.shaftAlpha * 0.30) + ')');
    sg.addColorStop(1, zone.shaft + '0)');
    c.fillStyle = sg;
    c.beginPath();
    c.moveTo(cx - topW, Y_CLERE_T);
    c.lineTo(cx + topW, Y_CLERE_T);
    c.lineTo(cx + skew + botW, Y_HORIZ + h * 0.05);
    c.lineTo(cx + skew - botW, Y_HORIZ + h * 0.05);
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
    const amp = 0.45 + h1(i + 21) * 0.75;
    const rad = bayW * (0.7 + h1(i + 33) * 0.8);
    const gl = c.createRadialGradient(cx, Y_HORIZ, 1, cx, Y_HORIZ, rad);
    gl.addColorStop(0, `rgba(${gr},${gg},${gb},${ga * amp})`);
    gl.addColorStop(0.4, `rgba(${gr},${gg},${gb},${ga * amp * 0.35})`);
    gl.addColorStop(1, `rgba(${gr},${gg},${gb},0)`);
    c.fillStyle = gl;
    c.fillRect(cx - rad, Y_HORIZ - rad, rad * 2, rad * 2);
  }
  c.globalCompositeOperation = 'source-over';

  // ---- 7. haze -----------------------------------------------------------
  // Everything below the clerestory washes progressively into the fog colour.
  // This is what makes the room feel deep rather than papered: near-black
  // architecture at the top, dissolved architecture at the bottom.
  const [fr, fg, fb] = zone.fog;
  const fogCol = `${Math.round(fr * 255 * 2.6)},${Math.round(fg * 255 * 2.6)},${Math.round(fb * 255 * 2.6)}`;
  const hz = c.createLinearGradient(0, Y_ARC_T, 0, h);
  hz.addColorStop(0, `rgba(${fogCol},0)`);
  hz.addColorStop(0.55, `rgba(${fogCol},0.42)`);
  hz.addColorStop(0.78, `rgba(${fogCol},0.72)`);
  hz.addColorStop(1, 'rgba(0,0,0,0.55)');
  c.fillStyle = hz;
  c.fillRect(0, Y_ARC_T, w, h - Y_ARC_T);

  // a hard-ish horizon line keeps the floor from merging into the wall
  const hb = c.createLinearGradient(0, Y_HORIZ - h * 0.03, 0, Y_HORIZ + h * 0.04);
  hb.addColorStop(0, 'rgba(255,246,230,0)');
  hb.addColorStop(0.45, 'rgba(255,246,230,0.13)');
  hb.addColorStop(1, 'rgba(255,246,230,0)');
  c.fillStyle = hb;
  c.fillRect(0, Y_HORIZ - h * 0.03, w, h * 0.07);

  // ---- 8. floor reflections ---------------------------------------------
  // A polished floor answers the clerestory. Cheap, and it stops the lower
  // third being a dead band.
  c.globalCompositeOperation = 'lighter';
  for (let i = -1; i <= BAYS; i++) {
    const cx = i * bayW + bayW * 0.5;
    const rg = c.createLinearGradient(0, Y_HORIZ, 0, h * 0.96);
    rg.addColorStop(0, zone.shaft + '0.16)');
    rg.addColorStop(1, zone.shaft + '0)');
    c.fillStyle = rg;
    c.beginPath();
    c.moveTo(cx - bayW * 0.10, Y_HORIZ);
    c.lineTo(cx + bayW * 0.10, Y_HORIZ);
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
