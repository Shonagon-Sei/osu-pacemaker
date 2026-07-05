'use strict';

const { parseHeader } = require('./osrParser');
const { buildApproxTimeline } = require('./approxCurve');
const { accuracyFor } = require('./scoreV2');

// The .osr header's total-score field means different things per client:
//   • lazer  (version >= 30000000): the standardised (ScoreV2) total.
//   • stable (older versions):      the legacy ScoreV1 total — the exact number
//     stable shows in-game and what tosu reports for your live bar.
// We take each at face value and tag stable ghosts `classic` so the overlay
// displays their ScoreV1 as-is (no standardised→classic conversion), keeping
// them on the same scale as a stable player's live score.
const LAZER_VERSION = 30000000;

/**
 * Build a ghost for a NON-mania replay from its header (no LZMA / frame judging
 * here). The exact final score comes straight from the header; the race curve is
 * approximated from the beatmap's object times and anchored to that final.
 * applyJudge() later replaces the curve's SHAPE with a real one from the frames
 * (still anchored to this exact final). Returns null if the header is unreadable
 * or carries no score.
 */
function buildHeaderGhost(osrPath, beatmap, mode, stepMs) {
  let h;
  try { h = parseHeader(osrPath); } catch { return null; }
  if (!(h.stableScore > 0)) return null; // no usable score in the header

  const acc = +accuracyFor(mode, h.counts).toFixed(2);
  const isLazer = h.version >= LAZER_VERSION;
  const objectTimes = beatmap.objects.map((o) => o.time);
  const sim = buildApproxTimeline(objectTimes, { score: h.stableScore, acc, maxCombo: h.maxCombo, counts: h.counts }, stepMs);

  return {
    // Unique per file (not replayMD5, which collides across identical stable
    // scores — see simWorker.js).
    replayId: osrPath,
    player: h.player || 'Ghost',
    mods: h.mods, // numeric bitmask (payload runs it through modString, like mania)
    lazer: isLazer,
    classic: !isLazer, // stable total is ScoreV1 — display it directly, don't convert
    finalScore: h.stableScore, // lazer: standardised · stable: exact ScoreV1
    finalAcc: acc,
    maxCombo: h.maxCombo,
    counts: h.counts,
    stepMs,
    startTime: sim.startTime,
    endTime: sim.endTime,
    timeline: sim.timeline,
  };
}

module.exports = { buildHeaderGhost };
