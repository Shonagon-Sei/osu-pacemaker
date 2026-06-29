'use strict';

/**
 * osu!catch replay judge.
 *
 * The replay records the catcher's X each frame (already accounting for movement
 * speed and hyperdashes), so judging is: interpolate the catcher position at each
 * catchable object's time and check whether the object's X is within the catch
 * width (derived from CS). Fruits and droplets give combo and break it on a miss;
 * tiny droplets only affect accuracy. Final score is pinned by the caller.
 *
 * Count mapping (matches the legacy header): fruit->Great(300), droplet->100,
 * tiny caught->50, tiny missed->katu, fruit/droplet missed->miss.
 */
const { standardisedRaw, STD_COMBO_EXPONENT } = require('./scoreV2');

const CATCHER_BASE = 106.75;
const ALLOWED_CATCH_RANGE = 0.8;

function judge(bm, frames, opts = {}) {
  const stepMs = opts.stepMs || 100;
  // Catch does NOT resize the catcher for HardRock (verified: HR plays mis-miss
  // fruits otherwise). EasyMod enlarges it (CS halved).
  const cs = Math.max(0, Math.min(10, opts.easy ? bm.cs * 0.5 : bm.cs));
  const scale = 1 - 0.7 * (cs - 5) / 5;
  const halfWidth = (CATCHER_BASE * Math.abs(scale) * ALLOWED_CATCH_RANGE) / 2;

  // Catcher X over time (map-time frames, used directly — see taiko/std).
  const n = frames.length;
  const ft = new Float64Array(n), fx = new Float64Array(n);
  for (let i = 0; i < n; i++) { ft[i] = frames[i].t; fx[i] = frames[i].x; }
  let fi = 0;
  function catcherAt(t) {
    if (n === 0) return 256;
    if (t <= ft[0]) return fx[0];
    if (t >= ft[n - 1]) return fx[n - 1];
    while (fi < n - 1 && ft[fi + 1] < t) fi++;
    while (fi > 0 && ft[fi] > t) fi--;
    const f = (t - ft[fi]) / ((ft[fi + 1] - ft[fi]) || 1);
    return fx[fi] + (fx[fi + 1] - fx[fi]) * f;
  }

  let combo = 0, comboMax = 0, comboPortionMax = 0, ideal = 0;
  const counts = { n300: 0, n100: 0, n50: 0, katu: 0, miss: 0 };
  const comboEvents = [], accEvents = []; // accEvents: { t, caught:0|1 }
  const hit = (t) => { combo++; comboEvents.push({ t, combo }); if (combo > comboMax) comboMax = combo; };
  const brk = (t) => { if (combo) comboEvents.push({ t, combo: 0 }); combo = 0; };

  for (const o of bm.objects) {
    const caught = Math.abs(catcherAt(o.time) - o.x) <= halfWidth;
    if (o.kind === 'fruit') {
      ideal++; comboPortionMax += Math.pow(ideal, STD_COMBO_EXPONENT);
      if (caught) { counts.n300++; hit(o.time); } else { counts.miss++; brk(o.time); }
      accEvents.push({ t: o.time, caught: caught ? 1 : 0 });
    } else if (o.kind === 'droplet') {
      ideal++; comboPortionMax += Math.pow(ideal, STD_COMBO_EXPONENT);
      if (caught) { counts.n100++; hit(o.time); } else { counts.miss++; brk(o.time); }
      accEvents.push({ t: o.time, caught: caught ? 1 : 0 });
    } else { // tiny droplet — accuracy only, no combo
      if (caught) counts.n50++; else counts.katu++;
      accEvents.push({ t: o.time, caught: caught ? 1 : 0 });
    }
  }

  // ── lazer standardised ScoreV2 curve, rescaled by the caller ─────────────────
  comboEvents.sort((a, b) => a.t - b.t);
  accEvents.sort((a, b) => a.t - b.t);
  const totalObjs = accEvents.length;
  const startTime = bm.objects.length ? bm.objects[0].time : 0;
  const endTime = bm.objects.length ? bm.objects[bm.objects.length - 1].time : startTime;

  let ci = 0, comboPortion = 0, curCombo = 0, ai = 0, caughtN = 0, resolved = 0;
  const sample = (t) => {
    while (ci < comboEvents.length && comboEvents[ci].t <= t) { const e = comboEvents[ci++]; if (e.combo > 0) comboPortion += Math.pow(e.combo, STD_COMBO_EXPONENT); curCombo = e.combo; }
    while (ai < accEvents.length && accEvents[ai].t <= t) { caughtN += accEvents[ai++].caught; resolved++; }
    const comboProgress = comboPortionMax > 0 ? comboPortion / comboPortionMax : 0;
    const acc = resolved > 0 ? caughtN / resolved : 1; // catch accuracy = fraction caught
    const accuracyProgress = totalObjs > 0 ? resolved / totalObjs : 0;
    return { raw: standardisedRaw(acc, comboProgress, accuracyProgress), combo: curCombo, acc: +(acc * 100).toFixed(2) };
  };

  const timeline = [];
  for (let t = startTime; t <= endTime; t += stepMs) { const r = sample(t); timeline.push({ t, raw: r.raw, acc: r.acc, combo: r.combo }); }
  const end = sample(endTime + 1);
  timeline.push({ t: endTime, raw: end.raw, acc: end.acc, combo: end.combo });

  return { counts, maxCombo: comboMax, finalAcc: end.acc, rawFinal: end.raw, startTime, endTime, stepMs, timeline };
}

module.exports = { judge };
