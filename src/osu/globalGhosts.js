'use strict';

const { fetchLeaderboard } = require('./osuApi');
const { buildApproxTimeline } = require('./approxCurve');

/**
 * Build ghost records from a beatmap's global top-N leaderboard (up to 100).
 *
 * One API request gives every entry's EXACT standardised score / accuracy /
 * combo, so we render exact standings with an approximated race curve (no
 * per-replay downloads). Scores are STANDARDISED (ScoreV2) — the value osu!
 * ranks by — so Classic-mod and every mode share one comparable scale. Each
 * ghost is tagged `global: true` (+ country) for the overlay.
 */
async function fetchGlobalGhosts(config, beatmapId, mode, beatmap, stepMs, count) {
  const board = await fetchLeaderboard(config, beatmapId, mode, count);
  const objectTimes = beatmap.objects.map((o) => o.time);

  return board.map((e) => {
    const score = e.score; // standardised; classic display is applied downstream
    const acc = +(e.accuracy * 100).toFixed(2); // exact, mode-agnostic
    const sim = buildApproxTimeline(objectTimes, { score, acc, maxCombo: e.maxCombo, counts: e.counts }, stepMs);
    return {
      replayId: `g${e.scoreId}`,
      player: e.player,
      mods: e.mods, // acronyms joined, e.g. "HDHRCL"
      lazer: true,  // modern osu! scores are lazer pp (CL mod conveys classic)
      global: true,
      country: e.countryCode || '',
      finalScore: score,
      finalAcc: acc,
      maxCombo: e.maxCombo,
      counts: e.counts,
      stepMs,
      startTime: sim.startTime,
      endTime: sim.endTime,
      timeline: sim.timeline,
    };
  });
}

module.exports = { fetchGlobalGhosts };
