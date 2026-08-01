// track/parts.js — what every object on the track is actually made of.
//
// One function per object. Each builds an Assembly (a Writer per material) and
// returns a single merged multi-material mesh, which the pool then hardware
// instances. Everything here runs once, in init().
//
// Two rules govern this file:
//
//  1. OBSTACLE VISUALS MUST FIT THEIR COLLISION BOX. The half-extents in
//     OB_SIZE are the difficulty of the game and coll/ reads them directly.
//     Every builder below is written against those numbers and stays inside
//     them, so what you see is what you hit. Each one asserts the fit in the
//     comment above it.
//
//  2. DETAIL IS TIERED. `q.name === 'low'` drops the small stuff — balusters,
//     bosses, pilasters, gem settings. Silhouette and the big shapes are
//     identical at every preset, so the game reads the same; only the close-up
//     jewellery goes.

import { Assembly } from './geom.js';

/* ------------------------------------------------------------------ floor */

/**
 * One floor tile: a laid stone floor, not a road.
 *
 * Local origin sits on the running surface at the tile's centre, so the tile
 * root is placed at path height 0 and everything else is authored in absolute
 * metres above the floor. The lane panels are the running surface (top y=0)
 * and the base slab sits 30mm below them, so the joints between panels are
 * real grooves rather than painted lines.
 *
 * `withEdges` builds the border course — kerb, gold cap and rail. Tiles next
 * to a junction are built without it, because a kerb would run straight
 * through the corner.
 */
export function buildTile(scene, mat, q, T, withEdges) {
  const W = T.laneWidth * T.laneCount;      // 7.2
  const L = T.tileLength;                   // 8
  const lw = T.laneWidth;                   // 2.4
  const hw = W * 0.5;
  const hl = L * 0.5;
  const detail = q.name !== 'low';

  const a = new Assembly(scene);
  const stone = a.w(mat.get('trackStone'));
  const dark = a.w(mat.get('marbleDark'));
  const light = a.w(mat.get('marbleLight'));
  const gold = a.w(mat.get('trackInlay'));

  const outer = hw + (withEdges ? 0.74 : 0.0);

  // Base slab. Chamfered, so the tile joints every 8m read as cut grooves.
  stone.bevelBox(0, -0.215, 0, outer, 0.185, hl, 0.055);

  // Lane panels — the running surface, laid as individual stones. Splitting
  // them at the transverse courses is what turns a painted road into a floor:
  // twelve stones per tile with real grooves between them, rather than three
  // long strips with lines drawn on top.
  const gj = 0.085;                                    // half-width of a joint
  const bounds = [-hl + 0.16, -L * 0.25, L * 0.25, hl - 0.16];
  for (let r = 0; r < 3; r++) {
    const z0 = bounds[r] + (r > 0 ? gj : 0);
    const z1 = bounds[r + 1] - (r < 2 ? gj : 0);
    for (let l = 0; l < T.laneCount; l++) {
      const x = (l - (T.laneCount - 1) / 2) * lw;
      dark.bevelBox(x, -0.015, (z0 + z1) * 0.5,
        lw * 0.5 - 0.15, 0.015, (z1 - z0) * 0.5, 0.024);
    }
  }

  // Gold inlay along every lane division, plus the outer border course.
  for (let l = 0; l <= T.laneCount; l++) {
    const x = (l - T.laneCount / 2) * lw;
    const edge = (l === 0 || l === T.laneCount);
    gold.box(x, -0.014, 0, edge ? 0.075 : 0.05, 0.016, hl - 0.17);
  }

  // Transverse courses at quarter points. These are the rhythm of the floor:
  // a 4m ladder streaming under the player is most of the sensation of speed,
  // and lane lines alone cannot supply it because they are parallel to travel.
  for (const cz of [-L * 0.25, L * 0.25]) {
    light.box(0, -0.020, cz, hw - 0.10, 0.014, gj + 0.01);
    gold.box(0, -0.012, cz, hw - 0.10, 0.014, 0.042);
    if (detail) {
      for (let l = 0; l <= T.laneCount; l++) {
        const x = (l - T.laneCount / 2) * lw;
        gold.star(x, -0.004, cz, 0.155, 0.066, 4, 0.014, 'y');
      }
    }
  }

  // Centre medallion. Flat and inlaid — deliberately NOT raised, so it cannot
  // be mistaken for something to collect or something to dodge.
  if (detail) {
    light.star(0, -0.006, 0, 0.94, 0.42, 8, 0.014, 'y', Math.PI / 8);
    gold.star(0, -0.001, 0, 0.44, 0.19, 8, 0.014, 'y');
    gold.star(0, -0.003, 0, 0.98, 0.90, 24, 0.010, 'y');
  }

  if (withEdges) {
    for (const s of [-1, 1]) {
      // pale kerb, gold cap on its inner lip, slim gold rail on its outer lip
      light.bevelBox(s * (hw + 0.36), 0.105, 0, 0.36, 0.215, hl, 0.045);
      gold.box(s * (hw + 0.10), 0.335, 0, 0.10, 0.025, hl);
      gold.bevelBox(s * (hw + 0.60), 0.44, 0, 0.13, 0.13, hl, 0.035);
      if (detail) {
        // a fascia moulding under the lip, seen on the outside of a bend
        light.box(s * (hw + 0.755), -0.30, 0, 0.02, 0.10, hl);
      }
    }
  }

  const mesh = a.build(withEdges ? 'tile' : 'tileBare');
  mesh.receiveShadows = true;
  return mesh;
}

/**
 * Roadside column: base, fluted shaft, gold collars, capital, gem finial.
 * Local origin at floor level.
 */
export function buildColumn(scene, mat, q) {
  const detail = q.name !== 'low';
  const sides = q.name === 'low' ? 6 : 10;
  const a = new Assembly(scene);
  const light = a.w(mat.get('marbleLight'));
  const gold = a.w(mat.get('goldTrim'));
  const rose = a.w(mat.get('roseGold'));

  light.bevelBox(0, 0.15, 0, 0.54, 0.15, 0.54, 0.05);
  gold.bevelBox(0, 0.375, 0, 0.44, 0.075, 0.44, 0.04);
  rose.prism(0, 2.83, 0, 0.34, 0.27, 4.4, sides, 0, 0.06);
  if (detail) {
    gold.collar(0, 0.90, 0, 0.32, 0.385, 0.09, sides);
    gold.collar(0, 4.72, 0, 0.28, 0.345, 0.09, sides);
  }
  gold.bevelBox(0, 5.14, 0, 0.44, 0.10, 0.44, 0.04);
  light.bevelBox(0, 5.30, 0, 0.34, 0.06, 0.34, 0.03);
  if (detail) a.w(mat.get('ruby')).gem(0, 5.52, 0, 0.15, 0.20);

  return a.build('column');
}

/* -------------------------------------------------------------- obstacles */

/**
 * OB.LOW — gilded barrier. Half-extents 1.02 x 0.28 x 0.30, base y=0, top
 * y=0.56. Nothing here goes above 0.56 or wider than 1.02, so the jump
 * clearance the smoke test asserts is exactly the clearance you can see.
 */
export function buildLow(scene, mat, q, s) {
  const detail = q.name !== 'low';
  const top = s.hy * 2;                     // 0.56
  const a = new Assembly(scene);
  const dark = a.w(mat.get('marbleDark'));
  const gold = a.w(mat.get('yellowGold'));
  const trim = a.w(mat.get('goldTrim'));
  const light = a.w(mat.get('marbleLight'));

  dark.bevelBox(0, 0.045, 0, s.hx, 0.045, s.hz, 0.03);          // 0.00-0.09
  for (const sx of [-1, 1]) {
    trim.bevelBox(sx * 0.90, 0.30, 0, 0.11, 0.21, 0.155, 0.035); // 0.09-0.51
    gold.gem(sx * 0.90, 0.525, 0, 0.075, 0.035);                 // finial
  }
  gold.bevelBox(0, top - 0.065, 0, 0.92, 0.065, 0.105, 0.03);    // top rail
  trim.box(0, 0.30, 0, 0.92, 0.032, 0.055);                      // mid rail
  if (detail) {
    for (const bx of [-0.46, 0, 0.46]) {
      light.prism(bx, 0.305, 0, 0.042, 0.042, 0.40, 6, 0, 0.012);
    }
    // A bezel on a vertical face has to be authored in the XY plane; collar()
    // lies flat in XZ and would read as a shelf. A many-pointed star is a
    // faceted disc, which is what a setting looks like anyway.
    trim.star(0, 0.335, -0.142, 0.155, 0.125, 10, 0.028, 'z');
    a.w(mat.get('ruby')).gem(0, 0.335, -0.168, 0.10, 0.115, 0.06);
  }
  return a.build('obLow');
}

/**
 * OB.HIGH — hanging banner under a gilded beam. Half-extents 1.02 x 0.55 x
 * 0.30 centred at y=1.72, so the volume is y 1.17 to 2.27. The banner's
 * scalloped hem touches exactly 1.17 at its lowest points: the visual bottom
 * IS the slide clearance. Chains and header above 2.27 are decoration in dead
 * space and cannot be collided with.
 */
export function buildHigh(scene, mat, q, s) {
  const detail = q.name !== 'low';
  const yBot = s.cy - s.hy;                 // 1.17
  const yTop = s.cy + s.hy;                 // 2.27
  const a = new Assembly(scene);
  const gold = a.w(mat.get('yellowGold'));
  const trim = a.w(mat.get('goldTrim'));
  // Cloth, not marble. At marbleDark's value the banner rendered as a black
  // hole punched in the corridor with no form in it at all.
  const dark = a.w(mat.get('clothCape'));

  trim.bevelBox(0, yTop - 0.11, 0, s.hx, 0.11, 0.20, 0.04);      // beam
  for (const sx of [-1, 1]) {
    gold.bevelBox(sx * 0.93, yTop - 0.14, 0, 0.09, 0.15, 0.25, 0.03);
    gold.prism(sx * 0.70, yTop + 0.62, 0, 0.032, 0.032, 1.24, 6); // hangers
  }
  trim.bevelBox(0, yTop + 1.30, 0, 0.92, 0.07, 0.11, 0.03);       // header
  // banner: top at 2.05, hem troughs land on 1.17
  dark.banner(0, yTop - 0.22, 0, s.hx * 2, (yTop - 0.22) - yBot, 0.025, 3);
  trim.box(0, yTop - 0.235, -0.03, s.hx, 0.035, 0.035);
  if (detail) {
    trim.box(0, yBot + 0.30, -0.03, s.hx * 0.86, 0.022, 0.03);
    trim.star(0, yBot + 0.62, -0.042, 0.28, 0.125, 6, 0.03, 'z');
    a.w(mat.get('ruby')).gem(0, yBot + 0.62, -0.078, 0.13, 0.16, 0.05);
  }
  return a.build('obHigh');
}

/**
 * OB.FULL — carved, gem-set plinth. Half-extents 1.02 x 1.15 x 0.34 centred
 * at 1.15, so y 0 to 2.30. The cornice is the widest part at exactly 1.02;
 * the finial tops out at 2.29.
 */
export function buildFull(scene, mat, q, s) {
  const detail = q.name !== 'low';
  const top = s.cy + s.hy;                  // 2.30
  const a = new Assembly(scene);
  const light = a.w(mat.get('marbleLight'));
  const dark = a.w(mat.get('marbleDark'));
  const trim = a.w(mat.get('goldTrim'));
  const rose = a.w(mat.get('roseGold'));

  light.bevelBox(0, 0.09, 0, s.hx, 0.09, s.hz, 0.04);            // base step
  trim.bevelBox(0, 0.235, 0, 0.93, 0.055, 0.30, 0.035);
  dark.bevelBox(0, 1.14, 0, 0.82, 0.85, 0.255, 0.055);           // shaft
  // Corner pilasters. On low they collapse to one per side, on the front
  // corners only — the back pair is never visible to the player anyway.
  for (const sx of [-1, 1]) {
    rose.prism(sx * 0.91, 1.14, -0.185, 0.095, 0.085, 1.70, 8, 0, 0.025);
    if (detail) rose.prism(sx * 0.91, 1.14, 0.185, 0.095, 0.085, 1.70, 8, 0, 0.025);
  }
  trim.bevelBox(0, top - 0.23, 0, s.hx, 0.08, s.hz, 0.04);       // cornice
  light.bevelBox(0, top - 0.11, 0, 0.86, 0.045, 0.28, 0.03);     // crown
  trim.bevelBox(0, top - 0.045, 0, 0.62, 0.03, 0.20, 0.02);      // cap
  // A gold pinstripe framing the dark front panel. Without it the shaft face
  // reads as a hole cut in the object rather than as a set panel.
  for (const sy of [-1, 1]) trim.box(0, 1.14 + sy * 0.76, -0.268, 0.72, 0.022, 0.016);
  for (const sx of [-1, 1]) trim.box(sx * 0.72, 1.14, -0.268, 0.022, 0.78, 0.016);

  // Front face: a gold star setting with a ruby at its heart. The player sees
  // this face and only this face, so all the jewellery goes here.
  trim.star(0, 1.18, -0.265, 0.44, 0.20, 6, 0.05, 'z');
  if (detail) {
    a.w(mat.get('ruby')).gem(0, 1.18, -0.315, 0.16, 0.19, 0.09);
    for (const sy of [0.52, 1.84]) trim.box(0, sy, -0.268, 0.80, 0.022, 0.018);
  }
  return a.build('obFull');
}

/* ------------------------------------------------------------ collectible */

/**
 * Collectible star — the gold stars that float around the reference NFT.
 * A faceted five-point solid with a ridge from the centre to each tip, so it
 * throws a different highlight on every facet as it turns. The old version was
 * a squashed octahedron, which reads as a gemstone chip, not a star.
 */
export function buildStar(scene, mat, q) {
  const a = new Assembly(scene);
  a.w(mat.get('goldLeaf')).star(0, 0, 0, 0.245, 0.108, 5, 0.075, 'z', Math.PI / 2);
  if (q.name !== 'low') {
    a.w(mat.get('yellowGold')).star(0, 0, 0, 0.115, 0.052, 5, 0.088, 'z', Math.PI / 2);
  }
  return a.build('star');
}

/* --------------------------------------------------------------- junction */

/** Corner pad: the paved square a junction sits on, with a compass rosette. */
export function buildCornerPad(scene, mat, q, w) {
  const detail = q.name !== 'low';
  const half = (w + 1.6) * 0.5;
  const a = new Assembly(scene);
  const stone = a.w(mat.get('trackStone'));
  const dark = a.w(mat.get('marbleDark'));
  const light = a.w(mat.get('marbleLight'));
  const gold = a.w(mat.get('trackInlay'));

  stone.bevelBox(0, -0.215, 0, half, 0.185, half, 0.055);
  dark.bevelBox(0, -0.015, 0, w * 0.5 - 0.06, 0.015, w * 0.5 - 0.06, 0.03);
  // border frame just inside the panel edge
  for (const s of [-1, 1]) {
    gold.box(s * (w * 0.5 - 0.20), -0.012, 0, 0.06, 0.018, w * 0.5 - 0.06);
    gold.box(0, -0.012, s * (w * 0.5 - 0.20), w * 0.5 - 0.06, 0.018, 0.06);
  }
  if (detail) {
    light.star(0, -0.008, 0, 1.85, 0.80, 12, 0.016, 'y', Math.PI / 12);
    gold.star(0, -0.002, 0, 0.95, 0.40, 12, 0.016, 'y');
    a.w(mat.get('ruby')).gem(0, 0.06, 0, 0.20, 0.09);
  }
  const mesh = a.build('cornerPad');
  mesh.receiveShadows = true;
  return mesh;
}

/**
 * Backstop wall — what closes the corridor at a corner. Local origin is the
 * wall's centre, matching where the pool places it.
 */
export function buildJunctionWall(scene, mat, q, w) {
  const detail = q.name !== 'low';
  const hw = (w + 2.2) * 0.5;
  const hh = 2.1;
  const a = new Assembly(scene);
  const stone = a.w(mat.get('trackStone'));
  const dark = a.w(mat.get('marbleDark'));
  const light = a.w(mat.get('marbleLight'));
  const trim = a.w(mat.get('goldTrim'));
  const rose = a.w(mat.get('roseGold'));

  stone.bevelBox(0, 0, 0.12, hw, hh, 0.18, 0.06);                // carcass
  light.bevelBox(0, -hh + 0.24, -0.09, hw, 0.24, 0.21, 0.05);    // plinth
  trim.bevelBox(0, hh - 0.16, -0.10, hw, 0.16, 0.22, 0.05);      // cornice
  light.bevelBox(0, hh - 0.36, -0.06, hw - 0.04, 0.05, 0.19, 0.03);

  // three sunken panels divided by rose-gold pilasters
  const bays = 3;
  const bayW = (hw * 2 - 0.5) / bays;
  for (let b = 0; b < bays; b++) {
    const cx = -hw + 0.25 + bayW * (b + 0.5);
    dark.bevelBox(cx, 0.05, -0.16, bayW * 0.5 - 0.16, 1.30, 0.06, 0.04);
    if (detail) {
      trim.box(cx, 1.40, -0.22, bayW * 0.5 - 0.16, 0.03, 0.02);
      trim.box(cx, -1.30, -0.22, bayW * 0.5 - 0.16, 0.03, 0.02);
    }
  }
  for (let b = 0; b <= bays; b++) {
    const cx = -hw + 0.25 + bayW * b;
    rose.prism(cx, 0.05, -0.15, 0.11, 0.10, 2.7, 8, 0, 0.03);
  }
  return a.build('junctionWall');
}

/**
 * Wall arrow: the single most important piece of signage in the game.
 *
 * It used to be a one-sided triangle fan whose normals faced away from the
 * player — it shaded pure black against a dark wall and the corner had, in
 * practice, no direction indicator at all. It is now a solid plate on a lit
 * backing panel, and both faces exist.
 *
 * Authored at final size; the pool must not scale it. Two protos are built,
 * one pointing left and one right, rather than one proto yawed 180 degrees:
 * yawing it also swung its face away from the player, which is the second
 * reason the old arrow was invisible on left-hand turns.
 */
export function buildWallArrow(scene, mat, q, dir) {
  const a = new Assembly(scene);
  const dark = a.w(mat.get('marbleDark'));
  const trim = a.w(mat.get('goldTrim'));
  const gold = a.w(mat.get('yellowGold'));

  // Backing panel, then a frame made of four BARS. It was a single bevelled
  // slab, which is a solid plate, not a frame — it covered the whole panel in
  // gold and the gold arrow on top of it vanished into its own background.
  dark.bevelBox(0, 0, 0.06, 1.50, 0.98, 0.10, 0.06);
  for (const sy of [-1, 1]) trim.bevelBox(0, sy * 1.04, -0.02, 1.62, 0.10, 0.09, 0.035);
  for (const sx of [-1, 1]) trim.bevelBox(sx * 1.54, 0, -0.02, 0.08, 1.14, 0.09, 0.035);
  gold.arrow(0, 0, -0.11, 1.10 * dir, 0.74, 0.075, 'xy');
  if (q.name !== 'low') {
    const glow = a.w(mat.get('rubyGlow'));
    for (const sy of [-1, 1]) glow.box(0, sy * 0.90, -0.075, 1.42, 0.025, 0.015);
  }
  return a.build(dir > 0 ? 'wallArrowR' : 'wallArrowL');
}

/** Floor chevron on the approach to a corner. */
export function buildChevron(scene, mat, q) {
  const a = new Assembly(scene);
  a.w(mat.get('marbleLight')).arrow(0, 0, 0, 0.95, 0.70, 0.018, 'xz');
  a.w(mat.get('trackInlay')).arrow(0, 0.014, 0, 0.80, 0.58, 0.026, 'xz');
  void q;
  return a.build('chevron');
}
