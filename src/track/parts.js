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

/**
 * Height of the top of the running surface for anything inlaid into it.
 * The paving's top face is y=0; inlays sit 2mm proud so they are never
 * swallowed by the panel they decorate, and 2mm is far too little to read as
 * a step or to trip the eye at speed.
 */
const INLAY = 0.002;

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

  // FOUR MATERIALS, AND NOT FIVE.
  //
  // A tile is instanced 27 times and every distinct material in it is another
  // submesh, so one extra material on this mesh is 27 extra draw calls a
  // frame — on the preset that has to hold 60fps on a phone. The base slab and
  // the course bed are therefore the same dark marble even though a separate
  // stone for the slab would have been marginally nicer, because nothing that
  // costs 27 draws may be justified by "marginally nicer".
  const a = new Assembly(scene);
  const pave = a.w(mat.get('stoneCarved'));
  const dark = a.w(mat.get('marbleDark'));
  const light = a.w(mat.get('marbleLight'));
  const gold = a.w(mat.get('trackInlay'));

  const outer = hw + (withEdges ? 0.74 : 0.0);

  // THE VALUE SCHEME, AND WHY IT IS THE WAY ROUND IT IS.
  //
  // The running surface used to be `marbleDark`: albedo 0.22 at roughScale
  // 0.34, which is a dark near-mirror. On the largest surface in every frame
  // that is precisely the failure ARCHITECTURE section 7 records. The floor
  // stopped owning its own value and borrowed the studio environment's
  // instead, so the paving rendered as wet black patent with white reflection
  // blobs sliding across it, and every piece of construction underneath —
  // courses, joints, medallions, roundels — was invisible beneath the
  // reflection. Captures are explicitly untrustworthy for exactly this class
  // of surface, so guessing was not an option; the fix has to remove the
  // dependence on the environment rather than tune it.
  //
  // The paving is therefore `stoneCarved`: pale cut stone, roughScale 1.0,
  // metal 6/255. It is a diffuse dielectric, so its value is its albedo and
  // nothing else, and it cannot go black in a dark hall or white against a
  // bright horizon. It also inverts the floor's contrast: a PALE field with
  // DARK inlaid courses is what a laid marble floor in a jewel-box hall
  // actually is, it matches the cream-and-silver key of the reference, and it
  // gives every obstacle on the track a light ground to be a dark silhouette
  // against — which is the single biggest thing legibility at speed needs.
  //
  // BASE SLAB AND COURSE BED ARE ONE BOX.
  //
  // The dark bed the paving is laid into doubles as the tile's carcass: its
  // top face is 8mm below the paving, so every gap between two stones shows as
  // a dark inlaid course rather than an ambiguous seam. That is what turns
  // nine separate slabs into ONE LAID FLOOR — border courses are the thing the
  // eye reads as construction, and they only exist if they are a different
  // value from the stones they frame.
  //
  // Keeping it to one box rather than a slab plus a bed matters for fill rate,
  // not for vertices: a second full-tile-area horizontal face under the paving
  // is a whole extra screen-covering layer of opaque overdraw, on the surface
  // that occupies most of the frame, times 27 live tiles.
  //
  // It also replaces the four hairline boxes that used to be inset in every
  // stone — 36 boxes a tile, 864 vertices, and at 25 m they were sub-pixel.
  // One bed reads better than thirty-six slivers and costs nothing extra.
  dark.bevelBox(0, -0.204, 0, outer, 0.196, hl, 0.055);

  // Paving stones — the running surface, laid as individual stones and set
  // proud of the course bed. Splitting them at the transverse courses is what
  // turns a painted road into a floor: nine stones per tile with real
  // channels between them, rather than three long strips with lines on top.
  const gj = 0.18;                                     // half-width of a course
  const bounds = [-hl + 0.18, -L * 0.25, L * 0.25, hl - 0.18];
  for (let r = 0; r < 3; r++) {
    const z0 = bounds[r] + (r > 0 ? gj : 0);
    const z1 = bounds[r + 1] - (r < 2 ? gj : 0);
    const cz = (z0 + z1) * 0.5;
    const pz = (z1 - z0) * 0.5;
    const px = lw * 0.5 - 0.18;
    for (let l = 0; l < T.laneCount; l++) {
      const x = (l - (T.laneCount - 1) / 2) * lw;
      pave.bevelBox(x, -0.0075, cz, px, 0.0075, pz, 0.022);
    }
  }

  // Gold inlay set into the middle of every course. A stripe laid on top of a
  // slab is a painted line; a stripe running down the centre of a dark course
  // that is itself sunk below the paving is inlay, and reads as inlay.
  for (let l = 0; l <= T.laneCount; l++) {
    const x = (l - T.laneCount / 2) * lw;
    const edge = (l === 0 || l === T.laneCount);
    gold.box(x, -0.014, 0, edge ? 0.055 : 0.075, 0.014, hl - 0.18);
  }

  // Transverse courses at quarter points. These are the rhythm of the floor:
  // a 4m ladder streaming under the player is most of the sensation of speed,
  // and lane lines alone cannot supply it because they are parallel to travel.
  for (const cz of [-L * 0.25, L * 0.25]) {
    gold.box(0, -0.014, cz, hw - 0.09, 0.014, 0.062);
    if (detail) {
      for (let l = 0; l <= T.laneCount; l++) {
        const x = (l - T.laneCount / 2) * lw;
        gold.star(x, INLAY, cz, 0.155, 0.066, 4, 0.012, 'y');
      }
    }
  }

  // Medallions, inlaid flush, in the OUTER lanes only. They were in the centre
  // lane and fought the corner chevrons, which are also centred and matter
  // more: two pieces of gold on top of each other read as neither.
  //
  // NOTE THE DATUM. star() puts its rim at cy and its ridge at cy+depth, so an
  // inlay authored at cy=0 has most of its area BELOW the panel it sits on and
  // is swallowed by it — the first build of this showed nothing but a small
  // spiky highlight where the ridge broke the surface. The rim goes just above
  // the paving and the whole motif is then visible.
  //
  // They are ROUNDELS, not stars. The first version was an eight-point star
  // and at gameplay distance a bright star lying in a lane is the same visual
  // word as a collectible. Concentric rings cannot be misread that way.
  // The outer ring is DARK now, not pale: the field it is inlaid into is pale
  // cut stone, and a pale ring on pale stone is a ring nobody can see.
  if (detail) {
    for (const sx of [-1, 1]) {
      dark.collar(sx * lw, INLAY + 0.004, 0, 0.60, 0.72, 0.014, 20);
      gold.collar(sx * lw, INLAY + 0.004, 0, 0.31, 0.41, 0.012, 20);
      gold.star(sx * lw, INLAY, 0, 0.17, 0.075, 4, 0.010, 'y');
    }
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

/*
 * THE THREE OBSTACLES ARE THREE WORDS, AND THE PLAYER READS THEM AT 25 METRES.
 *
 * Judged from the chase camera at spawn distance, each obstacle is about sixty
 * pixels tall inside a corridor packed with columns, beams and gold. All three
 * used to be dark objects with gold trim on a dark ground, so they arrived as
 * one indistinct shape and the player had to be close enough to be committed
 * before knowing which of jump / slide / dodge was being asked for.
 *
 * They are now built around three reads that survive being sixty pixels tall,
 * and the reads are carried by the LARGEST mass in each object, because that
 * is the only part with enough pixels to say anything:
 *
 *   LOW   a bright pale block, wide and ankle-height          -> step over it
 *   HIGH  a dark curtain in the air with a lit hem            -> go under it
 *   FULL  a tall pale monolith with a dark, jewelled panel    -> go round it
 *
 * The lit hem is the important one. A gap you must fit through has to show
 * WHERE its edge is, and an emissive cord is the only mark that keeps working
 * when the corridor lighting dips, when the obstacle is backlit, and at every
 * quality preset — `rubyGlow` is a plain emissive PBR material, no glow layer,
 * so it costs one submesh and nothing else. It is the same argument the corner
 * wall arrow won: signage that the player cannot see is not signage.
 *
 * Nothing below leaves its collision box. The extents in OB_SIZE are unchanged
 * and every builder is still written against them.
 */

/**
 * OB.LOW — gilded barrier on a pale marble kerb. Half-extents 1.02 x 0.28 x
 * 0.30, base y=0, top y=0.56. Nothing here goes above 0.56 or wider than 1.02,
 * so the jump clearance the smoke test asserts is exactly what you can see.
 *
 * The base block used to be marbleDark, which put the object's biggest mass at
 * the value of the ground it stands on. It is pale now: at distance the whole
 * barrier reads as one bright horizontal bar lying across the lane, which is
 * the clearest possible way of saying "this is a thing at ankle height".
 */
export function buildLow(scene, mat, q, s) {
  const detail = q.name !== 'low';
  const top = s.hy * 2;                     // 0.56
  const a = new Assembly(scene);
  const light = a.w(mat.get('marbleLight'));
  const gold = a.w(mat.get('yellowGold'));
  const glow = a.w(mat.get('rubyGlow'));

  // Pale kerb block, full width. 0.00-0.13.
  light.bevelBox(0, 0.065, 0, s.hx, 0.065, s.hz, 0.035);
  // A gold plinth course capping it, so the pale block is set stone and not a
  // slab of polystyrene. 0.13-0.175.
  gold.bevelBox(0, 0.1525, 0, 0.96, 0.0225, 0.245, 0.018);

  for (const sx of [-1, 1]) {
    gold.bevelBox(sx * 0.90, 0.335, 0, 0.11, 0.185, 0.155, 0.035); // posts
    gold.gem(sx * 0.90, 0.525, 0, 0.075, 0.035);                   // finial
  }
  gold.bevelBox(0, top - 0.065, 0, 0.92, 0.065, 0.105, 0.03);      // top rail
  // The lit edge, on the face the player runs at, level with the top rail.
  // This is the line you have to clear, drawn.
  glow.box(0, top - 0.075, -0.115, 0.86, 0.020, 0.010);
  if (detail) {
    light.box(0, 0.315, 0, 0.90, 0.030, 0.050);                    // mid rail
    for (const bx of [-0.46, 0, 0.46]) {
      light.prism(bx, 0.325, 0, 0.042, 0.042, 0.30, 6, 0, 0.012);  // balusters
    }
    // A bezel on a vertical face has to be authored in the XY plane; collar()
    // lies flat in XZ and would read as a shelf. A many-pointed star is a
    // faceted disc, which is what a setting looks like anyway.
    gold.star(0, 0.345, -0.142, 0.150, 0.120, 10, 0.028, 'z');
    a.w(mat.get('ruby')).gem(0, 0.345, -0.168, 0.10, 0.115, 0.06);
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
  // Cloth, not marble. At marbleDark's value the banner rendered as a black
  // hole punched in the corridor with no form in it at all.
  const dark = a.w(mat.get('clothCape'));
  const glow = a.w(mat.get('rubyGlow'));

  // The beam and the header are yellowGold, not goldTrim. goldTrim tiles its
  // hammer map at 6.0 against yellowGold's 4.0 with a third of the bump, so on
  // a part this size its dishes fall below a pixel and turn the whole beam
  // into crawling specular glitter. mat/ makes the same argument about the
  // lane rails; it applies with more force to something moving towards camera.
  gold.bevelBox(0, yTop - 0.11, 0, s.hx, 0.11, 0.20, 0.04);      // beam
  for (const sx of [-1, 1]) {
    gold.bevelBox(sx * 0.93, yTop - 0.14, 0, 0.09, 0.15, 0.25, 0.03);
    gold.prism(sx * 0.70, yTop + 0.62, 0, 0.032, 0.032, 1.24, 6); // hangers
  }
  gold.bevelBox(0, yTop + 1.30, 0, 0.92, 0.07, 0.11, 0.03);       // header
  // banner: top at 2.05, hem troughs land on 1.17
  dark.banner(0, yTop - 0.22, 0, s.hx * 2, (yTop - 0.22) - yBot, 0.025, 3);
  gold.box(0, yTop - 0.235, -0.03, s.hx, 0.035, 0.035);

  // THE SLIDE LINE. A ruby cord run straight across the banner at the height
  // of its lowest hem trough — which is the collision floor, 1.17, exactly.
  // The scalloped hem is the right shape for a banner and the wrong shape for
  // a gap: its edge rises and falls, so the eye has to guess which part of it
  // is the part that will hit you. The cord does not rise and fall, it is
  // emissive so it survives being backlit by the corridor, and it is the one
  // mark on the object that says how low you have to get.
  glow.box(0, yBot + 0.035, -0.048, s.hx * 0.94, 0.030, 0.012);
  if (detail) {
    gold.box(0, yBot + 0.36, -0.03, s.hx * 0.86, 0.022, 0.03);
    gold.star(0, yBot + 0.66, -0.042, 0.28, 0.125, 6, 0.03, 'z');
    a.w(mat.get('ruby')).gem(0, yBot + 0.66, -0.078, 0.13, 0.16, 0.05);
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
  const trim = a.w(mat.get('yellowGold'));
  const rose = a.w(mat.get('roseGold'));

  light.bevelBox(0, 0.09, 0, s.hx, 0.09, s.hz, 0.04);            // base step
  trim.bevelBox(0, 0.235, 0, 0.93, 0.055, 0.30, 0.035);
  // THE SHAFT IS PALE. It was marbleDark, which made the tallest, widest,
  // most dangerous object on the track the same value as the corridor behind
  // it — a dark block in a dark hall has no silhouette, and this is the one
  // obstacle you cannot jump, slide or survive. Pale marble gives it the
  // biggest tonal separation available from the background, and a monolith is
  // what the shape wants to be anyway.
  light.bevelBox(0, 1.14, 0, 0.82, 0.85, 0.255, 0.055);          // shaft
  // Corner pilasters. On low they collapse to one per side, on the front
  // corners only — the back pair is never visible to the player anyway.
  for (const sx of [-1, 1]) {
    rose.prism(sx * 0.91, 1.14, -0.185, 0.095, 0.085, 1.70, 8, 0, 0.025);
    if (detail) rose.prism(sx * 0.91, 1.14, 0.185, 0.095, 0.085, 1.70, 8, 0, 0.025);
  }
  trim.bevelBox(0, top - 0.23, 0, s.hx, 0.08, s.hz, 0.04);       // cornice
  light.bevelBox(0, top - 0.11, 0, 0.86, 0.045, 0.28, 0.03);     // crown
  trim.bevelBox(0, top - 0.045, 0, 0.62, 0.03, 0.20, 0.02);      // cap

  // The dark went where dark earns its keep: a sunk panel on the front face,
  // the one face the player ever sees. It is now the plinth's jewellery
  // setting rather than its bulk — a dark ground for the gold star, framed by
  // pale marble, which is how a set stone is mounted and how it reads.
  dark.bevelBox(0, 1.16, -0.252, 0.62, 0.68, 0.012, 0.03);
  for (const sy of [-1, 1]) trim.box(0, 1.16 + sy * 0.70, -0.266, 0.66, 0.022, 0.016);
  for (const sx of [-1, 1]) trim.box(sx * 0.66, 1.16, -0.266, 0.022, 0.72, 0.016);

  // Front face: a gold star setting with a ruby at its heart. The player sees
  // this face and only this face, so all the jewellery goes here.
  //
  // The gem's z is measured, not guessed. gem()'s third radius is its HALF
  // depth, so the old call sat its tip at -0.405 on a box whose front face is
  // -0.34: the one piece of jewellery on the object was sticking 6.5cm out
  // through the collision hull, where it could be visually clipped by a player
  // who had legitimately cleared the obstacle. -0.295 with a 0.045 half depth
  // lands the tip exactly on -0.34 and still stands 2.5cm proud of the star.
  trim.star(0, 1.18, -0.265, 0.44, 0.20, 6, 0.05, 'z');
  if (detail) {
    a.w(mat.get('ruby')).gem(0, 1.18, -0.295, 0.16, 0.19, 0.045);
    for (const sy of [0.44, 1.90]) trim.box(0, sy, -0.266, 0.80, 0.022, 0.018);
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
  const pave = a.w(mat.get('stoneCarved'));
  const dark = a.w(mat.get('marbleDark'));
  const light = a.w(mat.get('marbleLight'));
  const gold = a.w(mat.get('trackInlay'));

  // Same three courses as buildTile, in the same order and the same materials.
  // A corner paved differently from the straights reads as a different floor,
  // which is the one thing a corner must not do.
  dark.bevelBox(0, -0.204, 0, half, 0.196, half, 0.055);
  pave.bevelBox(0, -0.0075, 0, w * 0.5 - 0.18, 0.0075, w * 0.5 - 0.18, 0.03);
  // border frame just inside the panel edge
  for (const s of [-1, 1]) {
    gold.box(s * (w * 0.5 - 0.09), -0.014, 0, 0.055, 0.014, w * 0.5 - 0.06);
    gold.box(0, -0.014, s * (w * 0.5 - 0.09), w * 0.5 - 0.06, 0.014, 0.055);
  }
  if (detail) {
    // Concentric rings, raised a little more than the straight-run inlays.
    // Floor tiles from BOTH corridors overlap the corner square, so whatever
    // goes here is always partly covered — rings still read as a rosette when
    // half of them is hidden, where a twelve-point star just read as debris
    // poking through the paving.
    dark.collar(0, 0.020, 0, 1.72, 1.96, 0.018, 28);
    gold.collar(0, 0.020, 0, 1.18, 1.36, 0.016, 28);
    gold.collar(0, 0.020, 0, 0.44, 0.58, 0.016, 24);
    a.w(mat.get('ruby')).gem(0, 0.080, 0, 0.22, 0.085);
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
