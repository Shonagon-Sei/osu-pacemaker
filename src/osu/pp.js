'use strict';

const fs = require('fs');
const log = require('../util/logger');

/**
 * PP (performance points) computation via rosu-pp-js (WASM).
 *
 * PP isn't stored in replay files — stable never keeps it locally and we don't
 * read lazer's Realm DB — so we compute it from the .osu plus each play's final
 * stats (mods, accuracy, max combo, misses). One Beatmap is parsed per map and
 * reused; difficulty attributes are cached per mod-set (the expensive part), so
 * a board of dozens of ghosts costs one parse + a few difficulty calcs.
 *
 * rosu-pp-js is loaded lazily (it pulls in a WASM blob) and any failure degrades
 * to pp = 0 rather than breaking the leaderboard.
 */
let rosu = null;
let loadFailed = false;
function getRosu() {
  if (rosu || loadFailed) return rosu;
  try { rosu = require('rosu-pp-js'); }
  catch (e) { loadFailed = true; log.warn('rosu-pp-js unavailable; PP will show as 0:', e.message); }
  return rosu;
}

/**
 * Parse a beatmap for pp calc, converting to the play mode if it's a convert
 * (e.g. an osu! map played as mania). `src` is a .osu path or its raw bytes.
 * Returns a rosu Beatmap, or null if pp can't be computed for this map.
 */
function loadPpMap(src, mode) {
  const r = getRosu();
  if (!r || !src) return null;
  try {
    const content = Buffer.isBuffer(src) ? src : fs.readFileSync(src);
    const map = new r.Beatmap(content);
    if (typeof mode === 'number' && map.mode !== mode) {
      try { map.convert(mode); } catch { /* not convertible -> keep native mode */ }
    }
    return map;
  } catch (e) {
    log.warn('PP: could not parse beatmap:', e.message);
    return null;
  }
}

/**
 * Build a pp calculator bound to one map. Returns `{ pp(play) }` where `play` is
 * `{ mods, accuracy, combo, misses }` (accuracy 0–100). Difficulty attributes are
 * memoised per mod-set. Returns rounded pp, or 0 on any failure.
 *
 * `mode` is the play mode (0=osu,1=taiko,2=catch,3=mania) so the EXACT hit
 * counts can be mapped to rosu's per-mode fields. Passing exact counts (rather
 * than just accuracy) is what makes the result match osu! — accuracy alone is
 * ambiguous and lets rosu assume a best-case distribution, which over/under-
 * estimates (notably mania, where the 320:300 ratio drives pp).
 */
function createPpCalc(map, mode) {
  const r = getRosu();
  if (!r || !map) return { pp: () => 0, timeline: () => [] };
  const diffCache = new Map(); // `${mods}|${lazer}` -> DifficultyAttributes

  return {
    // Compute pp. Uses exact slider-end/large-tick hits when available (parsed
    // from the lazer replay) so std pp matches osu! exactly; otherwise rosu
    // assumes all slider parts hit.
    pp(play) {
      try {
        const mods = play.mods != null ? play.mods : 0;
        const lazer = play.lazer !== false; // default to lazer scoring
        // mods can be a number, string, or lazer APIMod array — key on its content.
        const key = `${typeof mods === 'object' ? JSON.stringify(mods) : mods}|${lazer}`;
        let attrs = diffCache.get(key);
        if (!attrs) {
          attrs = new r.Difficulty({ mods, lazer }).calculate(map);
          diffCache.set(key, attrs);
        }
        const args = { mods, lazer, ...hitCountArgs(mode, play.counts) };
        if (mode !== 3 && play.combo > 0) args.combo = play.combo; // combo unused for mania
        if (play.sliderEndHits != null) args.sliderEndHits = play.sliderEndHits; // exact (lazer std)
        if (play.largeTickHits != null) args.largeTickHits = play.largeTickHits;
        // Fall back to accuracy only when we somehow have no counts.
        if (!play.counts) args.accuracy = Math.max(0, Math.min(100, +play.accuracy || 0));
        const value = new r.Performance(args).calculate(attrs).pp;
        return Number.isFinite(value) ? Math.round(value) : 0;
      } catch {
        return 0;
      }
    },

    /**
     * Build a sparse PP-over-time curve for the race. PP is NOT proportional to
     * score (score lags early while combo builds), so we compute the *partial*
     * pp at sample points via rosu's gradual calculator — this captures the
     * partial star rating (incl. length bonus) correctly. Holds accuracy at the
     * final value across the curve (counts scaled proportionally), which keeps
     * the shape driven by difficulty. Returns [{ t, pp }] ending at finalPp, or
     * [] on failure (caller falls back to a score-scaled estimate).
     */
    timeline(play, objectTimes, sampleCount = 64) {
      try {
        const mods = play.mods != null ? play.mods : 0;
        const lazer = play.lazer !== false;
        const gp = new r.GradualPerformance(new r.Difficulty({ mods, lazer }), map);
        const total = gp.nRemaining;
        const nt = objectTimes && objectTimes.length ? objectTimes.length : total;
        if (!total || !nt) return [];
        const samples = Math.min(sampleCount, total);
        const out = [];
        let processed = 0;
        for (let s = 1; s <= samples; s++) {
          const frac = s / samples;
          const target = Math.max(processed + 1, Math.round(frac * total));
          const advance = target - processed; // objects consumed this step
          processed = target;
          const attrs = gp.nth(scaledState(mode, play, processed, total), advance - 1);
          let pp = attrs && Number.isFinite(attrs.pp) ? Math.round(attrs.pp) : 0;
          // Clamp non-decreasing: with constant accuracy more of the map can only
          // add pp; tiny dips here are just integer-rounding of the scaled counts.
          if (out.length && pp < out[out.length - 1].pp) pp = out[out.length - 1].pp;
          const ti = Math.min(nt - 1, Math.max(0, Math.round(frac * nt) - 1));
          out.push({ t: objectTimes[ti], pp });
          if (gp.nRemaining === 0) break;
        }
        return out;
      } catch {
        return [];
      }
    },
  };
}

// Cumulative ScoreState after `processed` of `total` objects, scaled from the
// play's final counts (so accuracy stays ~constant along the curve). The hit
// buckets are balanced to sum to exactly `processed` so rosu stays consistent.
function scaledState(mode, play, processed, total) {
  const c = play.counts || {};
  const f = total > 0 ? processed / total : 1;
  const sc = (v) => Math.round((v || 0) * f);
  const maxCombo = Math.round((play.combo || 0) * f);
  let buckets, primary;
  switch (mode) {
    case 3: buckets = { nGeki: sc(c.max), n300: sc(c.n300), nKatu: sc(c.n200), n100: sc(c.n100), n50: sc(c.n50), misses: sc(c.miss) }; primary = 'nGeki'; break;
    case 1: buckets = { n300: sc(c.n300), n100: sc(c.n100), misses: sc(c.miss) }; primary = 'n300'; break;
    case 2: buckets = { n300: sc(c.n300), n100: sc(c.n100), n50: sc(c.n50), nKatu: sc(c.n200), misses: sc(c.miss) }; primary = 'n300'; break;
    default: buckets = { n300: sc(c.n300), n100: sc(c.n100), n50: sc(c.n50), misses: sc(c.miss) }; primary = 'n300'; break;
  }
  // Absorb rounding drift into the dominant bucket so the counts sum to processed.
  const sum = Object.values(buckets).reduce((a, b) => a + b, 0);
  buckets[primary] = Math.max(0, buckets[primary] + (processed - sum));
  return { maxCombo, ...buckets };
}

// Map our normalised judgement counts to rosu's per-mode hit-result fields.
// Our counts: { max(=320/geki), n300, n200(=katu), n100, n50, miss }.
function hitCountArgs(mode, c) {
  if (!c) return {};
  switch (mode) {
    case 3: // mania
      return { nGeki: c.max || 0, n300: c.n300 || 0, nKatu: c.n200 || 0, n100: c.n100 || 0, n50: c.n50 || 0, misses: c.miss || 0 };
    case 1: // taiko (great / ok / miss)
      return { n300: c.n300 || 0, n100: c.n100 || 0, misses: c.miss || 0 };
    case 2: // catch (fruits / large+small droplets / tiny-droplet misses)
      return { n300: c.n300 || 0, n100: c.n100 || 0, n50: c.n50 || 0, nKatu: c.n200 || 0, misses: c.miss || 0 };
    default: // osu!standard (300 / 100 / 50 / miss)
      return { n300: c.n300 || 0, n100: c.n100 || 0, n50: c.n50 || 0, misses: c.miss || 0 };
  }
}

/**
 * Attach `finalPp` (exact) and `ppTimeline` (sparse race curve) to each ghost.
 * `finalAcc` is expected to already be the osu!-accurate value (set by the caller
 * from exact lazer stats / the API); the in-race accuracy curve is aligned to it.
 * `objectTimes` are the beatmap's hit-object times (ms) for mapping the curve.
 */
function attachPp(ghosts, calc, objectTimes) {
  for (const g of ghosts) {
    const play = { mods: g.modsExact || g.mods, counts: g.counts, combo: g.maxCombo, lazer: g.lazer, accuracy: g.finalAcc, sliderEndHits: g.sliderEndHits, largeTickHits: g.largeTickHits };
    g.finalPp = calc.pp(play);
    // Align the in-race accuracy curve so it lands on the (osu-accurate) final.
    const at = g.timeline;
    if (at && at.length) {
      const delta = g.finalAcc - at[at.length - 1].acc;
      if (Math.abs(delta) > 0.001) for (const p of at) p.acc = Math.min(100, Math.max(0, +(p.acc + delta).toFixed(2)));
    }
    g.ppTimeline = calc.timeline(play, objectTimes);
    // The gradual curve gives the right SHAPE but its absolute scale can be off:
    // for lazer std it omits slider-end/tick hits (treated as missed), depressing
    // the whole curve. Rescale so the end matches the exact finalPp — the shape
    // (partial star rating) is preserved and the magnitude is anchored correctly.
    const tl = g.ppTimeline;
    if (tl.length) {
      const last = tl[tl.length - 1].pp;
      const k = last > 0 && g.finalPp > 0 ? g.finalPp / last : 1;
      let prev = 0;
      for (const p of tl) { let v = Math.round(p.pp * k); if (v < prev) v = prev; prev = v; p.pp = v; }
      tl[tl.length - 1].pp = g.finalPp; // exact at the end
    }
  }
  return ghosts;
}

module.exports = { loadPpMap, createPpCalc, attachPp };
