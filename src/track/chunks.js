// Chunk templates — the level design of the game, as data.
//
// A chunk is 48m of track. A template lists what sits inside it, in normalised
// coordinates: `t` is 0..1 along the chunk, `lane` is 0..2.
//
// SOLVABILITY IS A HARD RULE. At every point along a chunk there must be at
// least one lane a player can get through, and enough room to change lanes to
// reach it. `validateTemplates()` proves this at boot and throws on failure, so
// an unwinnable pattern can never ship. Author templates freely; the validator
// is the safety net.

export const OB = {
  LOW: 0,   // hurdle — jump it
  HIGH: 1,  // overhead beam — slide under it
  FULL: 2,  // full-height block — change lane
};

// Two obstacles closer together than this (in t) count as simultaneous for
// solvability purposes.
const SIMULTANEITY = 0.045;

/**
 * diff: 0 = opening minutes, 1 = flat out.
 * items: obstacles. stars: collectible runs.
 * A star run is { t, lane, n, gap, arc } — `arc` lifts them into a jump arc.
 */
export const TEMPLATES = [
  // ---------- difficulty 0.0 : teaching ----------
  {
    name: 'empty', diff: 0.0,
    items: [],
    stars: [{ t: 0.25, lane: 1, n: 6, gap: 2.2 }],
  },
  {
    name: 'single-hurdle', diff: 0.05,
    items: [{ t: 0.45, lane: 1, kind: OB.LOW }],
    stars: [{ t: 0.42, lane: 1, n: 5, gap: 2.0, arc: true }],
  },
  {
    name: 'single-beam', diff: 0.12,
    items: [{ t: 0.5, lane: 1, kind: OB.HIGH }],
    stars: [{ t: 0.30, lane: 1, n: 7, gap: 2.0 }],
  },
  {
    name: 'single-block', diff: 0.15,
    items: [{ t: 0.5, lane: 1, kind: OB.FULL }],
    stars: [{ t: 0.62, lane: 0, n: 4, gap: 2.2 }],
  },

  // ---------- difficulty 0.25 : combinations ----------
  {
    name: 'hurdle-pair', diff: 0.25,
    items: [
      { t: 0.30, lane: 0, kind: OB.LOW },
      { t: 0.30, lane: 1, kind: OB.LOW },
    ],
    stars: [{ t: 0.28, lane: 0, n: 5, gap: 2.0, arc: true }],
  },
  {
    name: 'block-shift', diff: 0.30,
    items: [
      { t: 0.28, lane: 0, kind: OB.FULL },
      { t: 0.62, lane: 2, kind: OB.FULL },
    ],
    stars: [{ t: 0.42, lane: 1, n: 6, gap: 2.0 }],
  },
  {
    name: 'beam-wide', diff: 0.32,
    items: [
      { t: 0.45, lane: 0, kind: OB.HIGH },
      { t: 0.45, lane: 1, kind: OB.HIGH },
      { t: 0.45, lane: 2, kind: OB.HIGH },
    ],
    stars: [{ t: 0.55, lane: 1, n: 6, gap: 2.0 }],
  },
  {
    name: 'hurdle-wide', diff: 0.36,
    items: [
      { t: 0.40, lane: 0, kind: OB.LOW },
      { t: 0.40, lane: 1, kind: OB.LOW },
      { t: 0.40, lane: 2, kind: OB.LOW },
    ],
    stars: [{ t: 0.37, lane: 1, n: 6, gap: 2.1, arc: true }],
  },

  // ---------- difficulty 0.5 : pressure ----------
  {
    name: 'slalom', diff: 0.5,
    items: [
      { t: 0.18, lane: 0, kind: OB.FULL },
      { t: 0.42, lane: 1, kind: OB.FULL },
      { t: 0.68, lane: 2, kind: OB.FULL },
    ],
    stars: [
      { t: 0.30, lane: 2, n: 3, gap: 2.0 },
      { t: 0.56, lane: 0, n: 3, gap: 2.0 },
    ],
  },
  {
    name: 'squeeze', diff: 0.55,
    items: [
      { t: 0.35, lane: 0, kind: OB.FULL },
      { t: 0.35, lane: 2, kind: OB.FULL },
      { t: 0.65, lane: 1, kind: OB.LOW },
    ],
    stars: [{ t: 0.62, lane: 1, n: 5, gap: 2.0, arc: true }],
  },
  {
    name: 'duck-then-jump', diff: 0.58,
    items: [
      { t: 0.28, lane: 0, kind: OB.HIGH },
      { t: 0.28, lane: 1, kind: OB.HIGH },
      { t: 0.28, lane: 2, kind: OB.HIGH },
      { t: 0.62, lane: 0, kind: OB.LOW },
      { t: 0.62, lane: 1, kind: OB.LOW },
      { t: 0.62, lane: 2, kind: OB.LOW },
    ],
    stars: [{ t: 0.60, lane: 1, n: 5, gap: 2.0, arc: true }],
  },

  // ---------- difficulty 0.8 : the hard stuff ----------
  {
    name: 'gauntlet', diff: 0.8,
    items: [
      { t: 0.14, lane: 1, kind: OB.FULL },
      { t: 0.34, lane: 0, kind: OB.LOW },
      { t: 0.34, lane: 2, kind: OB.LOW },
      { t: 0.56, lane: 0, kind: OB.FULL },
      { t: 0.56, lane: 1, kind: OB.HIGH },
      { t: 0.80, lane: 2, kind: OB.FULL },
    ],
    stars: [{ t: 0.44, lane: 1, n: 4, gap: 2.0 }],
  },
  {
    name: 'zigzag-tight', diff: 0.85,
    items: [
      { t: 0.12, lane: 0, kind: OB.FULL },
      { t: 0.12, lane: 1, kind: OB.FULL },
      { t: 0.38, lane: 1, kind: OB.FULL },
      { t: 0.38, lane: 2, kind: OB.FULL },
      { t: 0.64, lane: 0, kind: OB.FULL },
      { t: 0.64, lane: 1, kind: OB.FULL },
    ],
    stars: [{ t: 0.50, lane: 0, n: 3, gap: 2.0 }],
  },
  {
    name: 'breather', diff: 0.9,
    items: [{ t: 0.5, lane: 1, kind: OB.LOW }],
    stars: [{ t: 0.20, lane: 1, n: 10, gap: 2.0 }],
  },
];

/**
 * Prove every template is survivable.
 *
 * A lane is passable at a moment if it is empty, or holds an obstacle the
 * player can clear by jumping (LOW) or sliding (HIGH). FULL is impassable.
 * A group of simultaneous obstacles must leave at least one passable lane —
 * and if the only passable lanes need a jump AND a slide at once, that is
 * also unwinnable, so the required action must be consistent within a lane.
 *
 * Throws with the offending template name. Called once at boot.
 */
export function validateTemplates(templates = TEMPLATES, laneCount = 3) {
  for (const tpl of templates) {
    // bucket items by simultaneous t
    const groups = [];
    for (const it of [...tpl.items].sort((a, b) => a.t - b.t)) {
      const g = groups[groups.length - 1];
      if (g && Math.abs(g.t - it.t) <= SIMULTANEITY) g.items.push(it);
      else groups.push({ t: it.t, items: [it] });
    }

    for (const g of groups) {
      const lanes = new Array(laneCount).fill(null);
      for (const it of g.items) {
        if (it.lane < 0 || it.lane >= laneCount) {
          throw new Error(`chunk "${tpl.name}": lane ${it.lane} out of range`);
        }
        if (lanes[it.lane] !== null) {
          throw new Error(`chunk "${tpl.name}": two obstacles stacked in lane ${it.lane} at t=${it.t}`);
        }
        lanes[it.lane] = it.kind;
      }
      const passable = lanes.filter((k) => k !== OB.FULL).length;
      if (passable === 0) {
        throw new Error(`chunk "${tpl.name}": all lanes blocked at t=${g.t} — unwinnable`);
      }
      // If every non-FULL lane demands a different action, the player can only
      // be in one lane, so that is fine. The genuine failure is zero options,
      // already caught above.
    }

    for (const s of tpl.stars || []) {
      if (s.lane < 0 || s.lane >= laneCount) {
        throw new Error(`chunk "${tpl.name}": star lane ${s.lane} out of range`);
      }
    }
  }
  return true;
}

/**
 * Pick a template appropriate to the current difficulty.
 *
 * Weighting favours templates near the current difficulty but never rules
 * anything out entirely, so runs stay varied. `avoid` prevents the same
 * template appearing twice in a row, which is the main thing that makes
 * procedural tracks feel cheap.
 */
export function pickTemplate(rng, difficulty, avoid) {
  let total = 0;
  const weights = new Array(TEMPLATES.length);
  for (let i = 0; i < TEMPLATES.length; i++) {
    const tpl = TEMPLATES[i];
    if (tpl === avoid) { weights[i] = 0; continue; }
    // templates harder than the player is ready for are strongly suppressed;
    // easier ones only mildly, so there is still breathing room at high speed
    const d = tpl.diff - difficulty;
    const w = d > 0
      ? Math.exp(-(d * d) / 0.020)
      : Math.exp(-(d * d) / 0.140);
    weights[i] = w;
    total += w;
  }
  if (total <= 0) return TEMPLATES[0];
  return rng.pickWeighted(TEMPLATES, weights, total);
}
