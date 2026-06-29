'use strict';

const { displayAccuracy } = require('./scoreV2');

/**
 * Build an approximate score-over-time curve from a beatmap's object times plus
 * a known EXACT final result. Used when we have the final stats but not the
 * replay frames (global leaderboard ghosts; non-mania modes we don't judge).
 *
 * The score curve follows lazer's standardised ScoreV2 SHAPE rather than rising
 * linearly: the combo portion is weighted by combo^0.5 (so it grows ~frac^1.5)
 * and the accuracy portion grows ~linearly, then it's normalised to end exactly
 * on the real final. This matters because the classic display conversion is
 * non-linear (quadratic for catch) — a linear approximation would warp badly.
 *
 * @param {number[]} objectTimes  hit-object start times (ms), unsorted ok
 * @param {object}   exact        { score, accuracy(0..1)|acc(0..100), maxCombo, counts }
 * @param {number}   stepMs
 */
function buildApproxTimeline(objectTimes, exact, stepMs) {
  const times = objectTimes.slice().sort((a, b) => a - b);
  const n = times.length;
  const finalScore = Math.round(exact.score || 0);
  const finalAcc = exact.acc != null ? exact.acc
    : exact.counts ? +displayAccuracy(exact.counts).toFixed(2)
    : exact.accuracy != null ? +(exact.accuracy * 100).toFixed(2) : 100;
  const maxCombo = exact.maxCombo || 0;
  const ratio = exact.counts ? (exact.counts.n300 > 0 ? +(exact.counts.max / exact.counts.n300).toFixed(2) : exact.counts.max) : 0;

  if (n === 0) {
    return { timeline: [{ t: 0, score: finalScore, acc: finalAcc, combo: maxCombo, ratio }], startTime: 0, endTime: 0, finalScore, finalAcc, maxCombo };
  }

  // lazer standardised shape: 500000·acc·comboProgress + 500000·acc^5·accProgress,
  // with comboProgress ≈ frac^1.5 (combo^0.5 weighting). Normalised so frac=1 → 1.
  const accV = Math.max(0, Math.min(1, finalAcc / 100));
  const cW = accV, aW = Math.pow(accV, 5);
  const denom = cW + aW || 1;
  const shape = (frac) => (cW * Math.pow(frac, 1.5) + aW * frac) / denom;

  const first = times[0];
  const last = times[n - 1];
  const start = Math.floor(first / stepMs) * stepMs;
  const timeline = [];
  let pi = 0;
  for (let t = start; t <= last + stepMs; t += stepMs) {
    while (pi < n && times[pi] <= t) pi++;
    const frac = pi / n;
    timeline.push({
      t,
      score: Math.round(finalScore * shape(frac)),
      acc: finalAcc,
      combo: Math.round(maxCombo * frac),
      ratio,
    });
  }
  if (timeline.length) timeline[timeline.length - 1].score = finalScore;

  return { timeline, startTime: start, endTime: last, finalScore, finalAcc, maxCombo };
}

module.exports = { buildApproxTimeline };
