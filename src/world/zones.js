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
// Everything here is data. Textures are baked once at init and crossfaded; no
// per-frame canvas work.

export const ZONE_LENGTH = 620;   // metres per zone
export const BLEND_LENGTH = 150;  // metres of crossfade into the next

/**
 * sky    : gradient stops, top of screen first
 * shaft  : colour of the overhead light shafts
 * glow   : low gem glow, [r,g,b,alpha]
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
      [0.00, '#05050a'], [0.32, '#0c0b13'], [0.60, '#1b151e'],
      [0.82, '#3a2a24'], [1.00, '#09080c'],
    ],
    shaft: 'rgba(255,214,150,',
    shaftAlpha: 0.30,
    glow: [190, 150, 70, 0.30],
    fog: [0.055, 0.050, 0.070],
    env: 1.95, bloom: 0.85,
  },
  {
    name: 'Ruby',
    sky: [
      [0.00, '#0a0308'], [0.30, '#1a0610'], [0.58, '#3a0b1c'],
      [0.80, '#68142c'], [1.00, '#12040a'],
    ],
    shaft: 'rgba(255,170,180,',
    shaftAlpha: 0.26,
    glow: [220, 45, 70, 0.42],
    fog: [0.090, 0.030, 0.048],
    env: 1.85, bloom: 0.95,
  },
  {
    name: 'Sapphire',
    sky: [
      [0.00, '#030610'], [0.30, '#07102a'], [0.58, '#0d2350'],
      [0.80, '#1b4a86'], [1.00, '#050a18'],
    ],
    shaft: 'rgba(180,215,255,',
    shaftAlpha: 0.30,
    glow: [70, 130, 235, 0.38],
    fog: [0.035, 0.055, 0.105],
    env: 2.05, bloom: 0.85,
  },
  {
    name: 'Emerald',
    sky: [
      [0.00, '#02090a'], [0.30, '#05161a'], [0.58, '#0a3230'],
      [0.80, '#166049'], [1.00, '#04100f'],
    ],
    shaft: 'rgba(190,255,225,',
    shaftAlpha: 0.26,
    glow: [40, 200, 140, 0.34],
    fog: [0.035, 0.080, 0.070],
    env: 2.00, bloom: 0.80,
  },
  {
    name: 'Gilt',
    sky: [
      [0.00, '#120c05'], [0.30, '#2a1c08'], [0.58, '#573a10'],
      [0.80, '#a4742a'], [1.00, '#1c1206'],
    ],
    shaft: 'rgba(255,232,180,',
    shaftAlpha: 0.38,
    glow: [255, 190, 90, 0.46],
    fog: [0.130, 0.098, 0.048],
    env: 1.75, bloom: 1.00,
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

/**
 * Paint one zone's backdrop into a 2D context.
 * Kept here rather than in world/ so a zone is defined entirely in one place.
 */
export function paintZone(c, zone, w, h) {
  const g = c.createLinearGradient(0, 0, 0, h);
  for (const [stop, col] of zone.sky) g.addColorStop(stop, col);
  c.fillStyle = g;
  c.fillRect(0, 0, w, h);

  // Overhead light shafts. Slightly irregular spacing — evenly spaced shafts
  // read as a pattern, uneven ones read as architecture.
  const shaftCount = 9;
  for (let i = 0; i < shaftCount; i++) {
    const x = (i / shaftCount) * w + Math.sin(i * 2.3) * w * 0.035;
    const topW = w * 0.028;
    const botW = w * 0.085;
    const sg = c.createLinearGradient(0, 0, 0, h * 0.78);
    sg.addColorStop(0, zone.shaft + zone.shaftAlpha + ')');
    sg.addColorStop(1, zone.shaft + '0)');
    c.fillStyle = sg;
    c.beginPath();
    c.moveTo(x, 0);
    c.lineTo(x + topW, 0);
    c.lineTo(x + botW, h * 0.78);
    c.lineTo(x - botW * 0.35, h * 0.78);
    c.closePath();
    c.fill();
  }

  // Gem glow, low and central, where the corridor vanishes.
  const [gr, gg, gb, ga] = zone.glow;
  const glow = c.createRadialGradient(w * 0.5, h * 0.80, w * 0.01, w * 0.5, h * 0.80, w * 0.46);
  glow.addColorStop(0, `rgba(${gr},${gg},${gb},${ga})`);
  glow.addColorStop(1, `rgba(${gr},${gg},${gb},0)`);
  c.fillStyle = glow;
  c.fillRect(0, h * 0.35, w, h * 0.65);

  // A faint horizon band stops the lower half reading as a flat wash.
  const hb = c.createLinearGradient(0, h * 0.70, 0, h * 0.86);
  hb.addColorStop(0, 'rgba(255,255,255,0)');
  hb.addColorStop(0.5, 'rgba(255,246,230,0.10)');
  hb.addColorStop(1, 'rgba(255,255,255,0)');
  c.fillStyle = hb;
  c.fillRect(0, h * 0.70, w, h * 0.16);
}
