'use strict';

const { parseHeader } = require('./osrParser');
const { buildApproxTimeline } = require('./approxCurve');
const { accuracyFor } = require('./scoreV2');

// Lazer .osr headers store the standardised (ScoreV2) total — including the mod
// multiplier. Stable headers store legacy ScoreV1, which isn't comparable, so we
// skip those for non-mania (we have no frame judge for std/taiko/catch).
const LAZER_VERSION = 30000000;

/**
 * Build a ghost for a NON-mania replay straight from its header (no LZMA / frame
 * judging). The exact standardised final comes from the header; the race curve
 * is approximated from the beatmap's object times and anchored to that final.
 * Returns null for stable (non-standardised) replays.
 */
function buildHeaderGhost(osrPath, beatmap, mode, stepMs) {
  let h;
  try { h = parseHeader(osrPath); } catch { return null; }
  if (h.version < LAZER_VERSION || !(h.stableScore > 0)) return null;

  const acc = +accuracyFor(mode, h.counts).toFixed(2);
  const objectTimes = beatmap.objects.map((o) => o.time);
  const sim = buildApproxTimeline(objectTimes, { score: h.stableScore, acc, maxCombo: h.maxCombo, counts: h.counts }, stepMs);

  return {
    // Unique per file (not replayMD5, which collides across identical stable
    // scores — see simWorker.js).
    replayId: osrPath,
    player: h.player || 'Ghost',
    mods: h.mods, // numeric bitmask (payload runs it through modString, like mania)
    lazer: true, // only lazer (standardised) replays reach here; stable returns null above
    finalScore: h.stableScore,
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
