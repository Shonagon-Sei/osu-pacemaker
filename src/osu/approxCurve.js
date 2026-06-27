'use strict';

const { displayAccuracy } = require('./scoreV2');

/**
 * Build an approximate score-over-time curve from a beatmap's object times plus
 * a known EXACT final result. Used when we have the final stats but not the
 * replay frames (global leaderboard ghosts; non-mania modes we don't judge).
 *
 * The curve rises ~linearly with objects passed and ends exactly on the real
 * score/combo, so mid-race position is an estimate but the standings are exact.
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
      score: Math.round(finalScore * frac),
      acc: finalAcc,
      combo: Math.round(maxCombo * frac),
      ratio,
    });
  }
  if (timeline.length) timeline[timeline.length - 1].score = finalScore;

  return { timeline, startTime: start, endTime: last, finalScore, finalAcc, maxCombo };
}

module.exports = { buildApproxTimeline };
