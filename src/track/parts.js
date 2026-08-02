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
 * Judged from the chase camera at spawn distance an obstacle is about sixty
 * pixels tall, inside a corridor packed with columns, beams and gold, and in
 * portrait the player's own head covers most of the centre lane. So the read
 * cannot come from detail. It comes from three things, in this order:
 *
 *   1. WHERE THE MASS IS.   ankle / head / floor-to-ceiling.
 *   2. WHAT THE MASS DOES.  one long horizontal body / a comb of verticals /
 *                           one uninterrupted slab.
 *   3. THE LIT LINE.        an emissive cord at the exact height that hurts.
 *
 * Each obstacle is also an OBJECT out of this building rather than a block
 * with trim stuck on it, because a thing you recognise is a thing you parse
 * faster than a thing you have to measure:
 *
 *   LOW   a toppled column drum lying across the lane      -> step over it
 *   HIGH  a gilded portcullis hanging from a beam          -> go under it
 *   FULL  a marble display vitrine, glazed and jewelled    -> go round it
 *
 * WHY A CYLINDER FOR THE LOW ONE. Captured in the chase camera the running
 * surface is very dark and the corridor is under-lit for most of its length,
 * so albedo separation alone is not enough — the pale marble of the old LOW
 * barrier went the same value as everything else and it disappeared. A curved
 * body cannot do that: whatever the light is doing, SOME band of a cylinder is
 * near-normal to it, so a drum always carries one continuous bright streak
 * along its length. That streak is the silhouette. Flat-faced boxes have no
 * such guarantee and go uniformly dark whenever the key misses them.
 *
 * WHY A COMB FOR THE HIGH ONE. The old one was a cloth banner, and clothCape
 * tiled at 3.0 on a 2m x 1m sheet renders as a black-and-white herringbone —
 * a dazzle pattern, which is the exact opposite of a readable silhouette. It
 * is also the wrong object: a curtain says "a wall of fabric", and the thing
 * we want the player to think is "bars, with a gap under them". Vertical bars
 * against a horizontal drum against a solid slab is three different textures
 * as well as three different heights, which is what makes them separable when
 * they are sixty pixels tall and half-occluded.
 *
 * THE LIT LINE IS ALWAYS rubyGlow AND ALWAYS AT THE CLEARANCE HEIGHT. Red cord
 * = the edge that will hit you. LOW puts it at its top, HIGH at its underside,
 * FULL runs it up both sides because there is no way through at all. It is a
 * plain emissive PBR material, no glow layer, so it costs one submesh and
 * nothing else, and it is the only mark that survives the corridor going dark.
 *
 * GOLD IS yellowGold HERE, NEVER goldTrim. goldTrim tiles its hammer map at
 * 6.0 with 0.40 bump; on obstacle-sized parts those dishes fall under a pixel
 * and the whole object turns into crawling specular glitter that reads as
 * noise, not metal. yellowGold (tile 4.0, bump 0.22) is the calm one. The same
 * argument applies with more force to a part moving towards the camera.
 *
 * Nothing below leaves its collision box. The extents in OB_SIZE are unchanged
 * and every builder is written against them, with the fit asserted in numbers
 * in the comment above it.
 */

/**
 * OB.LOW — a toppled column drum. Half-extents 1.02 x 0.28 x 0.30, base y=0,
 * top y=0.56.
 *
 * FIT. The drum is r=0.255 centred at y=0.265, so it spans y 0.010..0.520 and
 * z -0.255..0.255. The gold astragals at each end are r=0.295 at the same
 * centre: y -0.030..0.560 — the top touches the collision ceiling exactly and
 * the bottom is buried in the floor, which is what a heavy thing that fell
 * over should look like. Widest x is the astragal at 0.87 and the boss at
 * 0.885, both inside 1.02.
 */
export function buildLow(scene, mat, q, s) {
  const detail = q.name !== 'low';
  const sides = q.name === 'low' ? 8 : 12;
  // Facets straddle the top and bottom rather than meeting in a ridge there.
  // A ridge along the crown of a lying cylinder catches one hairline highlight
  // and reads as a crease; a flat facet catches a broad one and reads as the
  // top of a drum.
  const phase = Math.PI / sides;
  const a = new Assembly(scene);
  const light = a.w(mat.get('marbleLight'));
  const gold = a.w(mat.get('yellowGold'));
  const glow = a.w(mat.get('rubyGlow'));

  // The drum itself, lying across the lane.
  light.prismAxis('x', 0, 0.265, 0, 0.255, 0.255, 1.62, sides, phase, 0.035);
  // Astragal bands at both ends — the mouldings a real column drum is banded
  // with, and the two bright dots that give the object its dumbbell
  // silhouette when the middle has gone dark.
  for (const sx of [-1, 1]) {
    gold.prismAxis('x', sx * 0.80, 0.265, 0, 0.295, 0.295, 0.15, sides, phase, 0.025);
  }
  // A gold plate bolted across the front, with the lit line sitting on its
  // TOP EDGE. A strip glued to bare stone would be nonsense; screwed to a
  // plate it is a marker somebody fitted, which is what it is.
  //
  // NOTHING MAY OVERHANG THE LIT LINE. The first version put the cord in the
  // middle of the plate's front face, and from a chase camera that looks DOWN
  // on the track the 5cm of plate above it shaded the cord out almost
  // completely — the marker was there in the close-up and gone at 26m, which
  // is the only distance that matters. The cord now has clear air above it,
  // and enough depth (z -0.174 to -0.082) that it emerges from the drum's
  // shoulder and shows a top face as well as a front one. Emissive plus bloom
  // makes two pixels of that read; two pixels in shadow read as nothing.
  gold.bevelBox(0, 0.400, -0.135, 0.78, 0.070, 0.034, 0.015);
  glow.box(0, 0.492, -0.128, 0.72, 0.024, 0.046);
  if (detail) {
    // Centre fillet and the gold bosses closing the drum's ends.
    gold.prismAxis('x', 0, 0.265, 0, 0.272, 0.272, 0.11, sides, phase, 0.018);
    for (const sx of [-1, 1]) {
      gold.prismAxis('x', sx * 0.868, 0.265, 0, 0.155, 0.155, 0.034, sides, phase, 0.010);
      a.w(mat.get('ruby')).gem(sx * 0.888, 0.265, 0, 0.030, 0.070, 0.070);
    }
  }
  return a.build('obLow');
}

/**
 * OB.HIGH — a gilded portcullis. Half-extents 1.02 x 0.55 x 0.30 centred at
 * y=1.72, so the volume is y 1.17 to 2.27.
 *
 * FIT. The bottom rail's underside is y=1.17 exactly and the lit cord sits on
 * its front face — the visual bottom IS the slide clearance, with no scallop
 * or fringe to make the player guess which part of the hem is the part that
 * hits. The beam tops out at 2.27. Hangers and header above 2.27 are in dead
 * space above the collision box and cannot be hit.
 */
export function buildHigh(scene, mat, q, s) {
  const detail = q.name !== 'low';
  const yBot = s.cy - s.hy;                 // 1.17
  const yTop = s.cy + s.hy;                 // 2.27
  const a = new Assembly(scene);
  const gold = a.w(mat.get('yellowGold'));
  const dark = a.w(mat.get('marbleDark'));
  const glow = a.w(mat.get('rubyGlow'));

  // Head beam. 2.10-2.27.
  gold.bevelBox(0, yTop - 0.085, 0, s.hx, 0.085, 0.19, 0.04);
  // Valance under it: a dark spandrel, set BACK behind the bars, that gives
  // the top of the object real mass against the lit arch at the vanishing
  // point and gives the upper half of the bars something dark to be
  // silhouetted against. 1.62-2.10, at z +0.06.
  //
  // It stops at 1.62 on purpose. Below that the player must be able to see
  // corridor THROUGH the gate: a gate you can see under says "get under it",
  // and the same gate backed all the way down says "wall". That was the old
  // banner's problem and it is not worth reintroducing for a little more mass.
  dark.bevelBox(0, 1.86, 0.06, 0.94, 0.24, 0.055, 0.035);
  for (const sy of [1.635, 2.085]) gold.box(0, sy, -0.020, 0.95, 0.017, 0.030);

  // Side stiles, floor-of-the-box to beam. These are what close the shape
  // into a gate rather than leaving a comb of loose sticks.
  for (const sx of [-1, 1]) {
    gold.bevelBox(sx * 0.945, 1.72, 0, 0.075, 0.55, 0.105, 0.03);
  }

  // The bars, 1.31 to 1.76. Nine at r=0.046 fills about half the opening with
  // gold, which is the point: at 26m the individual bars are sub-pixel and
  // what survives is their average, so the grille has to be dense enough to
  // read as a body rather than as a few loose sticks with corridor behind.
  const nBar = q.name === 'low' ? 6 : 9;
  for (let i = 0; i < nBar; i++) {
    const x = -0.78 + (1.56 * i) / (nBar - 1);
    gold.prism(x, 1.535, 0, 0.046, 0.046, 0.45, 6, 0, 0.012);
  }

  // Bottom rail. Underside at 1.17 — the slide line, drawn as a solid object
  // rather than inferred from a fringe. The cord sits on its face at 1.20.
  gold.bevelBox(0, yBot + 0.070, 0, s.hx, 0.070, 0.125, 0.03);
  glow.box(0, yBot + 0.055, -0.140, 0.94, 0.026, 0.010);

  if (detail) {
    // A ruby boss at the foot of every other bar, standing ON TOP of the rail.
    // They used to sit on the rail's front face, over the cord, and each one
    // punched a dark notch out of the one line on this object that has to be
    // unbroken. Nothing goes in front of the lit line.
    const ruby = a.w(mat.get('ruby'));
    for (let i = 0; i < nBar; i += 2) {
      const x = -0.78 + (1.56 * i) / (nBar - 1);
      ruby.gem(x, 1.345, 0, 0.052, 0.058, 0.052);
    }
    // Hangers and header, in the dead space above the box.
    for (const sx of [-1, 1]) gold.prism(sx * 0.70, yTop + 0.62, 0, 0.030, 0.030, 1.24, 6);
    gold.bevelBox(0, yTop + 1.30, 0, 0.92, 0.065, 0.10, 0.03);
  }
  return a.build('obHigh');
}

/**
 * OB.FULL — a marble display vitrine. Half-extents 1.02 x 1.15 x 0.34 centred
 * at 1.15, so y 0 to 2.30.
 *
 * FIT. The cornice is the widest part at exactly 1.02 and the cap tops out at
 * 2.29. The gem is the only thing that stands proud of the glazing and its z
 * is measured, not guessed: gem()'s third radius is its HALF DEPTH, so at
 * cz=-0.295 with a 0.045 half depth the tip lands exactly on the collision
 * face at -0.34. A gem poking out past that could be clipped by a player who
 * had legitimately gone round the obstacle.
 *
 * WHY IT STAYS A SOLID PALE SLAB. This is the one obstacle that cannot be
 * jumped, slid or survived, so it gets the biggest tonal separation available
 * from the corridor behind it and an unbroken outline. An actual open-fronted
 * vitrine with four corner posts would be prettier and would have no
 * silhouette at all; a glazed case with a dark window in a pale marble carcass
 * is the same idea with the outline kept.
 */
export function buildFull(scene, mat, q, s) {
  const detail = q.name !== 'low';
  const top = s.cy + s.hy;                  // 2.30
  const a = new Assembly(scene);
  const light = a.w(mat.get('marbleLight'));
  const dark = a.w(mat.get('marbleDark'));
  const trim = a.w(mat.get('yellowGold'));
  const rose = a.w(mat.get('roseGold'));
  const glow = a.w(mat.get('rubyGlow'));

  light.bevelBox(0, 0.09, 0, s.hx, 0.09, s.hz, 0.04);            // base step
  trim.bevelBox(0, 0.235, 0, 0.93, 0.055, 0.30, 0.035);          // course
  light.bevelBox(0, 1.14, 0, 0.82, 0.85, 0.255, 0.055);          // carcass
  // Corner pilasters. On low they collapse to one per side, on the front
  // corners only — the back pair is never visible to the player anyway.
  for (const sx of [-1, 1]) {
    rose.prism(sx * 0.91, 1.14, -0.185, 0.095, 0.085, 1.70, 8, 0, 0.025);
    if (detail) rose.prism(sx * 0.91, 1.14, 0.185, 0.095, 0.085, 1.70, 8, 0, 0.025);
  }
  trim.bevelBox(0, top - 0.23, 0, s.hx, 0.08, s.hz, 0.04);       // cornice
  light.bevelBox(0, top - 0.11, 0, 0.86, 0.045, 0.28, 0.03);     // crown
  trim.bevelBox(0, top - 0.045, 0, 0.62, 0.03, 0.20, 0.02);      // cap

  // THE WINDOW. Dark marble is very nearly a mirror at roughScale 0.34, which
  // on a small vertical panel is exactly what glass does: it holds the room
  // rather than a value of its own. Set into pale marble and gridded with
  // gold glazing bars it reads as a glazed case, and it gives the gold and
  // the gem a dark ground to be seen against.
  const wy = 1.24, wh = 0.60, ww = 0.58;
  dark.bevelBox(0, wy, -0.252, ww, wh, 0.012, 0.025);
  for (const sy of [-1, 1]) trim.box(0, wy + sy * (wh + 0.030), -0.266, ww + 0.06, 0.028, 0.016);
  for (const sx of [-1, 1]) trim.box(sx * (ww + 0.030), wy, -0.266, 0.028, wh + 0.088, 0.016);
  // Glazing bars: one mullion, one transom. Four panes is a case; a single
  // pane is a hole cut in a wall.
  trim.box(0, wy, -0.262, 0.014, wh, 0.012);
  trim.box(0, wy, -0.262, ww, 0.014, 0.012);

  // The exhibit: a bracket shelf, a big ruby on it, and a lit strip under the
  // shelf washing up over the stone. A museum lights its own vitrines.
  trim.bevelBox(0, 0.945, -0.278, 0.26, 0.028, 0.042, 0.012);
  glow.box(0, 0.905, -0.286, 0.22, 0.014, 0.026);
  trim.star(0, wy, -0.262, 0.36, 0.165, 6, 0.038, 'z');
  // THE EXHIBIT GEM IS EMISSIVE, NOT METAL. `ruby` is metallic with roughness
  // 0.10 — a red mirror — and a mirror in an unlit case reflects an unlit
  // room, so the centrepiece of the whole object captured as a black diamond.
  // rubyGlow carries its own light, which is both what a lit vitrine does and
  // the only version of this that survives the corridor going dark.
  if (detail) glow.gem(0, wy, -0.295, 0.155, 0.185, 0.045);

  // NO WAY THROUGH, SAID IN THE SAME VOCABULARY AS THE OTHER TWO. LOW and
  // HIGH each draw one red line at the height that hurts. This one has no
  // height that does not hurt, so the cord runs up both jambs instead of
  // across — a shape the player cannot mistake for a clearance line, saying
  // the same word.
  for (const sx of [-1, 1]) {
    glow.box(sx * 0.845, 1.30, -0.262, 0.014, 0.86, 0.010);
  }
  if (detail) for (const sy of [0.44, 1.98]) trim.box(0, sy, -0.266, 0.80, 0.022, 0.018);
  return a.build('obFull');
}

/* ------------------------------------------------------------ collectible */

/**
 * Collectible star — the gold stars that float around the reference NFT,
 * cut as a stone rather than stamped out of sheet.
 *
 * The old one was Writer.star(): a rim polygon with a single ridge running to
 * one apex on each face. That is a cone with a wavy base, and it captured as a
 * scrap of crumpled foil — one silhouette, one highlight, and as it spun it
 * flickered between "bright triangle" and "nothing". A collectible has to look
 * worth picking up from further away than it can be picked up from.
 *
 * cutStar() gives it three facet families — a girdle wall, crown facets, and a
 * flat table on each face. There is always a facet near-normal to the key, so
 * it glints continuously through the spin instead of blinking, and the girdle
 * catches a bright rim line that draws the outline for free.
 *
 * SIZE IS A GAMEPLAY NUMBER, NOT A TASTE ONE. Outer radius 0.245 put a
 * half-metre ornament on the track, wider than the character and tall enough
 * to hide the obstacle behind it. 0.152 is a 30cm star: bigger than the 23cm
 * it was, small enough that a run of them never masks what kills you.
 */
export function buildStar(scene, mat, q) {
  const a = new Assembly(scene);
  const R = 0.152, r = 0.078;
  a.w(mat.get('goldLeaf'))
    .cutStar(0, 0, 0, R, r, 5, 0.016, 0.050, 0.30, Math.PI / 2);
  if (q.name !== 'low') {
    // A white spark seated in the table on both faces. Only the tips of this
    // little double pyramid clear the gold, so what the player sees is a hot
    // point at the heart of the stone — which is the single cheapest thing
    // that makes a collectible read as valuable at forty metres. It is
    // emissive, so unlike everything else on the star it does not go out when
    // the corridor does.
    a.w(mat.get('catchlight'))
      .star(0, 0, 0, R * 0.32, r * 0.32, 5, 0.084, 'z', Math.PI / 2);
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
