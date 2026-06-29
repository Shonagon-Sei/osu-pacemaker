'use strict';

/**
 * osu!taiko replay judge.
 *
 * Taiko is purely rhythmic: each note wants a fresh keypress of the matching
 * colour (don = centre keys, kat = rim keys) within the hit window. From the
 * replay's key bitmask: don = M1|K1 (bits 1|4), kat = M2|K2 (bits 2|8) — verified
 * empirically. Great/Good/Miss come from the notes; drum-roll ticks and dendens
 * add combo only. Final score is pinned by the caller; this supplies the curve.
 */

const { standardisedRaw, STD_COMBO_EXPONENT } = require('./scoreV2');

const DON = 1 | 4, KAT = 2 | 8;

// osu! difficulty range interpolation (OD 0/5/10 anchors).
function diffRange(od, v0, v5, v10) {
  return od < 5 ? v0 + (v5 - v0) * (od / 5) : v5 + (v10 - v5) * ((od - 5) / 5);
}

function judge(bm, frames, opts = {}) {
  const stepMs = opts.stepMs || 100;
  const od = Math.max(0, Math.min(10, opts.hardRock ? bm.od * 1.4 : opts.easy ? bm.od * 0.5 : bm.od));
  const great = diffRange(od, 50, 35, 20);
  const good = diffRange(od, 120, 80, 50);

  // Fresh keypresses, tagged with which colours they can satisfy. Replay frame
  // times are already in map-time (verified: DT/NC plays match with no rate
  // scaling), so we compare directly against note times.
  const MASK = 15;
  const presses = [];
  for (let i = 0; i < frames.length; i++) {
    const prev = i ? frames[i - 1].k : 0;
    const nb = (frames[i].k & MASK) & ~(prev & MASK);
    if (nb) presses.push({ t: frames[i].t, don: (nb & DON) !== 0, kat: (nb & KAT) !== 0, used: false });
  }

  let base = 0;
  function findPress(t0, t1, wantKat) {
    while (base < presses.length && presses[base].t < t0) base++;
    for (let i = base; i < presses.length; i++) {
      const p = presses[i];
      if (p.t > t1) break;
      if (!p.used && (wantKat ? p.kat : p.don)) return p;
    }
    return null;
  }

  let combo = 0, comboMax = 0, comboPortionMax = 0, ideal = 0;
  const counts = { n300: 0, n100: 0, miss: 0 };
  const comboEvents = [], accEvents = []; // accEvents: { t, value } value 300/150/0
  const hit = (t) => { combo++; comboEvents.push({ t, combo }); if (combo > comboMax) comboMax = combo; };
  const brk = (t) => { if (combo) comboEvents.push({ t, combo: 0 }); combo = 0; };
  const need = () => { ideal++; comboPortionMax += Math.pow(ideal, STD_COMBO_EXPONENT); };

  // Merge notes + drum ticks + dendens into one time-ordered pass for combo.
  const events = [];
  for (const n of bm.notes) events.push({ t: n.time, kind: 'note', kat: n.kat, big: n.big });
  for (const d of bm.drumTicks) events.push({ t: d.time, kind: 'tick' });
  for (const d of bm.dendens) events.push({ t: d.endTime, kind: 'denden' });
  events.sort((a, b) => a.t - b.t);

  for (const e of events) {
    need();
    if (e.kind === 'note') {
      const p = findPress(e.t - good, e.t + good, e.kat);
      if (p) {
        p.used = true;
        const dt = Math.abs(p.t - e.t);
        const v = dt <= great ? 300 : 150; // taiko: GREAT=300, GOOD scores 150
        if (v === 300) counts.n300++; else counts.n100++;
        hit(e.t);
        accEvents.push({ t: e.t, value: v });
        if (e.big) { const p2 = findPress(p.t - 30, p.t + 30, e.kat); if (p2) p2.used = true; } // finisher double
      } else {
        counts.miss++; brk(e.t + good); accEvents.push({ t: e.t + good, value: 0 });
      }
    } else {
      // Drum-roll tick / denden completion: any input keeps it; here we credit it
      // as combo (these don't affect great/good/miss accuracy).
      hit(e.t);
    }
  }

  // ── lazer standardised ScoreV2 curve, rescaled by the caller ─────────────────
  comboEvents.sort((a, b) => a.t - b.t);
  accEvents.sort((a, b) => a.t - b.t);
  const totalMain = accEvents.length;
  const startTime = events.length ? events[0].t : 0;
  const endTime = accEvents.length ? accEvents[accEvents.length - 1].t : startTime;

  let ci = 0, comboPortion = 0, curCombo = 0, ai = 0, accAchieved = 0, accResolved = 0;
  const sample = (t) => {
    while (ci < comboEvents.length && comboEvents[ci].t <= t) { const e = comboEvents[ci++]; if (e.combo > 0) comboPortion += Math.pow(e.combo, STD_COMBO_EXPONENT); curCombo = e.combo; }
    while (ai < accEvents.length && accEvents[ai].t <= t) { accAchieved += accEvents[ai++].value; accResolved++; }
    const comboProgress = comboPortionMax > 0 ? comboPortion / comboPortionMax : 0;
    const acc = accResolved > 0 ? accAchieved / (accResolved * 300) : 1;
    const accuracyProgress = totalMain > 0 ? accResolved / totalMain : 0;
    return { raw: standardisedRaw(acc, comboProgress, accuracyProgress), combo: curCombo, acc: acc * 100 };
  };

  const timeline = [];
  for (let t = startTime; t <= endTime; t += stepMs) { const r = sample(t); timeline.push({ t, raw: r.raw, acc: +r.acc.toFixed(2), combo: r.combo }); }
  const end = sample(endTime + 1);
  timeline.push({ t: endTime, raw: end.raw, acc: +end.acc.toFixed(2), combo: end.combo });

  return { counts, maxCombo: comboMax, finalAcc: timeline.length ? timeline[timeline.length - 1].acc : 100, rawFinal: end.raw, startTime, endTime, stepMs, timeline };
}

module.exports = { judge };
