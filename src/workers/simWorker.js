'use strict';

/**
 * Worker thread: given one .osr path + the already-parsed beatmap, do the heavy
 * lifting (read file, LZMA-decode the replay payload, judge, build timeline) off
 * the main event loop. Returns a compact ghost record.
 */
const { parentPort } = require('worker_threads');
const lzma = require('lzma');
const { parseReplay, decodeFrames } = require('../osu/osrParser');
const { simulate } = require('../osu/maniaSimulator');
const { displayAccuracy } = require('../osu/scoreV2');
const { modMultiplier } = require('../osu/mods');

// Replays at/above this format version are osu!lazer, whose .osr header stores
// the EXACT standardised (ScoreV2) total — so we use it verbatim instead of our
// simulated estimate. Stable replays store a legacy (ScoreV1) total on a
// different scale, so those keep the simulated score.
const LAZER_VERSION = 30000000;

parentPort.on('message', async (job) => {
  const { id, osrPath, beatmap, stepMs } = job;
  try {
    const replay = parseReplay(osrPath);
    const frames = await decodeFrames(replay.replayData, lzma);
    const sim = simulate(frames, beatmap, replay.mods, stepMs);

    // The replay header carries lazer's exact final score + judgement counts +
    // max combo. Trust those for the standings; the simulation only supplies the
    // in-between curve shape (lazer stores no time-series), scaled to hit the
    // exact final so the race ends on the real number.
    const isLazer = replay.version >= LAZER_VERSION;
    let finalScore = sim.finalScore;
    let finalAcc = sim.finalAcc;
    let maxCombo = sim.maxCombo;
    let counts = sim.counts;
    let timeline = sim.timeline;

    if (isLazer && replay.stableScore > 0) {
      finalScore = replay.stableScore; // already includes the mod multiplier
      counts = replay.counts;
      finalAcc = +displayAccuracy(replay.counts).toFixed(2);
      maxCombo = replay.maxCombo;

      if (sim.finalScore > 0 && timeline.length) {
        const k = finalScore / sim.finalScore;
        timeline = timeline.map((p) => ({ ...p, score: Math.round(p.score * k) }));
        timeline[timeline.length - 1].score = finalScore; // exact at the end
      }
    } else {
      // Stable replay: our simulated ScoreV2 has no mod multiplier — apply it so
      // modded stable plays sit on the same standardised scale as the rest.
      const mult = modMultiplier(replay.mods, beatmap.mode);
      if (mult !== 1) {
        finalScore = Math.round(finalScore * mult);
        timeline = timeline.map((p) => ({ ...p, score: Math.round(p.score * mult) }));
      }
    }

    parentPort.postMessage({
      id,
      ok: true,
      ghost: {
        replayId: replay.replayMD5 || osrPath,
        player: replay.player || 'Ghost',
        mods: replay.mods,
        exact: isLazer && replay.stableScore > 0,
        stableScore: replay.stableScore,
        finalScore,
        finalAcc,
        maxCombo,
        counts,
        stepMs: sim.stepMs,
        startTime: sim.startTime,
        endTime: sim.endTime,
        timeline,
      },
    });
  } catch (err) {
    parentPort.postMessage({ id, ok: false, error: String(err && err.message ? err.message : err) });
  }
});
