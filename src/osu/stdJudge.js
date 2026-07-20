'use strict';

/**
 * osu!standard replay judge.
 *
 * Replays the cursor frames against the beatmap geometry to reconstruct a real
 * per-moment score/accuracy/combo curve — the standard analogue of the mania
 * simulator. Circles and slider heads are judged by matching a fresh click,
 * within the OD hit-window, to the cursor being over the object; slider
 * ticks/repeats/tail are judged by the cursor holding inside the follow circle;
 * spinners are assumed cleared (they almost always are, and the final is pinned).
 *
 * The absolute score scale isn't osu-exact (ScoreV2 has a fiddly closed form),
 * so the caller rescales the curve to the replay's exact final — what matters
 * here is the SHAPE: combos build, misses/breaks drop the gain at the right
 * moments. Returns counts too, which the caller verifies against the .osr stats.
 */

const { standardisedRaw, STD_COMBO_EXPONENT } = require('./scoreV2');
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

function judge(bm, frames, opts = {}) {
  const hr = !!opts.hardRock, ez = !!opts.easy;
  const stepMs = opts.stepMs || 100;
  const rate = opts.rate || 1;

  const od = clamp(hr ? bm.od * 1.4 : ez ? bm.od * 0.5 : bm.od, 0, 10);
  const cs = clamp(hr ? bm.cs * 1.3 : ez ? bm.cs * 0.5 : bm.cs, 0, 10);
  const radius = 54.4 - 4.48 * cs;
  const followR = radius * 2.4;
  const w300 = 80 - 6 * od, w100 = 140 - 8 * od, w50 = 200 - 10 * od;

  // Replay frames are recorded in REAL time; multiply by the play's rate to get
  // SONG time so DT/HT plays line up with the map's (song-time) objects. Without
  // this a DT ghost's curve finishes early and then freezes at its final score.
  // HardRock mirrors the playfield vertically.
  const n = frames.length;
  const ft = new Float64Array(n), fx = new Float64Array(n), fy = new Float64Array(n), fk = new Int32Array(n);
  for (let i = 0; i < n; i++) {
    ft[i] = frames[i].t * rate;
    fx[i] = frames[i].x;
    fy[i] = hr ? 384 - frames[i].y : frames[i].y;
    fk[i] = frames[i].k;
  }

  const MASK = 15; // M1|M2|K1|K2
  const presses = []; // fresh key-down events with the cursor position at that frame
  for (let i = 0; i < n; i++) {
    const prev = i ? fk[i - 1] : 0;
    if (((fk[i] & MASK) & ~(prev & MASK)) !== 0) presses.push({ t: ft[i], x: fx[i], y: fy[i], used: false });
  }

  function cursorAt(t) {
    if (n === 0) return { x: 256, y: 192, held: false };
    if (t <= ft[0]) return { x: fx[0], y: fy[0], held: (fk[0] & MASK) !== 0 };
    if (t >= ft[n - 1]) return { x: fx[n - 1], y: fy[n - 1], held: (fk[n - 1] & MASK) !== 0 };
    let lo = 0, hi = n - 1;
    while (hi - lo > 1) { const m = (lo + hi) >> 1; if (ft[m] <= t) lo = m; else hi = m; }
    const f = (t - ft[lo]) / ((ft[hi] - ft[lo]) || 1);
    return { x: fx[lo] + (fx[hi] - fx[lo]) * f, y: fy[lo] + (fy[hi] - fy[lo]) * f, held: (fk[lo] & MASK) !== 0 };
  }

  // Earliest unused press in [t0,t1] within `rad` of (px,py). Moving base pointer
  // keeps this near-linear over the (time-sorted) objects.
  let base = 0;
  function findPress(t0, t1, px, py, rad) {
    while (base < presses.length && presses[base].t < t0) base++;
    for (let i = base; i < presses.length; i++) {
      const p = presses[i];
      if (p.t > t1) break;
      if (!p.used && Math.hypot(p.x - px, p.y - py) <= rad) return p;
    }
    return null;
  }

  // ── play through the objects ───────────────────────────────────────────────
  let combo = 0;
  const counts = { n300: 0, n100: 0, n50: 0, miss: 0 };
  const comboEvents = []; // { t, combo }   (combo after a successful hit; 0 on break)
  const accEvents = [];   // { t, value }   (per main object: 0/50/100/300)
  // Combo-scaled hits for the exact ScoreV1 curve: { t, base, comboBefore }. base
  // is the hit's 300/100/50 value; comboBefore is the combo just before this hit
  // (it already includes slider-tick increments). Ticks/tails aren't combo-scaled
  // in ScoreV1, so they're omitted here (they only advance `combo`).
  const scoreEvents = [];
  let comboMax = 0, idealCombo = 0, comboPortionMax = 0;

  const hit = (t) => { combo++; comboEvents.push({ t, combo }); if (combo > comboMax) comboMax = combo; };
  const brk = (t) => { if (combo) comboEvents.push({ t, combo: 0 }); combo = 0; };
  const ideal = () => { idealCombo++; comboPortionMax += Math.pow(idealCombo, STD_COMBO_EXPONENT); };
  const tally = (v) => { if (v === 300) counts.n300++; else if (v === 100) counts.n100++; else if (v === 50) counts.n50++; else counts.miss++; };

  // Judge a circle/slider-head against the cursor: 300/100/50 or miss. In lazer,
  // these (circles + slider heads) are exactly what feed great/ok/meh/miss.
  const judgeHit = (time, pos) => {
    const p = findPress(time - w50, time + w50, pos.x, pos.y, radius);
    if (p) { p.used = true; const dt = Math.abs(p.t - time); const v = dt <= w300 ? 300 : dt <= w100 ? 100 : 50; tally(v); const cb = combo; hit(p.t); accEvents.push({ t: p.t, value: v }); scoreEvents.push({ t: p.t, base: v, comboBefore: cb }); }
    else { tally(0); brk(time + w50); accEvents.push({ t: time + w50, value: 0 }); }
  };

  for (const o of bm.objects) {
    if (o.kind === 'circle') {
      ideal();
      judgeHit(o.time, o.pos);
    } else if (o.kind === 'slider') {
      ideal();
      judgeHit(o.time, o.pos); // head -> great/ok/meh/miss
      // Ticks / repeats / tail add combo (large-tick / slider-tail), not acc judgements.
      for (const ne of o.nested) {
        if (ne.kind === 'head') continue;
        ideal();
        const c = cursorAt(ne.time);
        if (c.held && Math.hypot(c.x - ne.pos.x, c.y - ne.pos.y) <= followR) hit(ne.time);
        else if (ne.kind !== 'tail') brk(ne.time); // a missed tick/repeat breaks combo; tail doesn't
      }
    } else if (o.kind === 'spinner') {
      ideal();
      tally(300); const cb = combo; hit(o.endTime); accEvents.push({ t: o.endTime, value: 300 }); scoreEvents.push({ t: o.endTime, base: 300, comboBefore: cb }); // assume cleared
    }
  }

  // ── build the per-moment curve (lazer standardised ScoreV2) ──────────────────
  comboEvents.sort((a, b) => a.t - b.t);
  accEvents.sort((a, b) => a.t - b.t);
  const totalMain = accEvents.length; // objects that feed accuracy progress
  const startTime = bm.objects.length ? bm.objects[0].time : 0;
  const endTime = accEvents.length ? accEvents[accEvents.length - 1].t : startTime;

  // comboPortion weights each hit by combo^0.5; accuracy is base/maxBase quality.
  let ci = 0, comboPortion = 0, curCombo = 0;
  let ai = 0, accAchieved = 0, accResolved = 0;
  const ratioRaw = (t) => {
    while (ci < comboEvents.length && comboEvents[ci].t <= t) { const e = comboEvents[ci++]; if (e.combo > 0) comboPortion += Math.pow(e.combo, STD_COMBO_EXPONENT); curCombo = e.combo; }
    while (ai < accEvents.length && accEvents[ai].t <= t) { accAchieved += accEvents[ai++].value; accResolved++; }
    const comboProgress = comboPortionMax > 0 ? comboPortion / comboPortionMax : 0;
    const acc = accResolved > 0 ? accAchieved / (accResolved * 300) : 1;
    const accuracyProgress = totalMain > 0 ? accResolved / totalMain : 0;
    return { raw: standardisedRaw(acc, comboProgress, accuracyProgress), combo: curCombo, acc: acc * 100 };
  };

  const timeline = [];
  for (let t = startTime; t <= endTime; t += stepMs) {
    const r = ratioRaw(t);
    timeline.push({ t, raw: r.raw, acc: +r.acc.toFixed(2), combo: r.combo });
  }
  const end = ratioRaw(endTime + 1);
  timeline.push({ t: endTime, raw: end.raw, acc: +end.acc.toFixed(2), combo: end.combo });

  return {
    counts, maxCombo: comboMax,
    finalAcc: timeline.length ? timeline[timeline.length - 1].acc : 100,
    rawFinal: end.raw, // for rescaling the curve to the exact final score
    scoreEvents,       // combo-scaled hits, for the exact ScoreV1 (stable) curve
    startTime, endTime, stepMs, timeline,
  };
}

module.exports = { judge };
