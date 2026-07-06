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
    // Stable replays use stable's mania accuracy weighting (MAX and 300 both count
    // as 300 → an all-300 run is 100%); lazer weights MAX as 305.
    const isLazer = replay.version >= LAZER_VERSION;
    const sim = simulate(frames, beatmap, replay.mods, stepMs, !isLazer);

    // The replay header carries lazer's exact final score + judgement counts +
    // max combo. Trust those for the standings; the simulation only supplies the
    // in-between curve shape (lazer stores no time-series), scaled to hit the
    // exact final so the race ends on the real number.
    let finalScore = sim.finalScore;
    let finalAcc = sim.finalAcc;
    let maxCombo = sim.maxCombo;
    let counts = sim.counts;
    let scoreScale = 1;
    let isClassic = false;

    if (replay.stableScore > 0) {
      // Trust the header's exact final score, counts and combo (both clients store
      // them); the simulation only supplies the in-between curve shape, scaled to
      // land on the real final. Lazer's total is standardised ScoreV2; stable's is
      // ScoreV1 — a different scale — so tag stable ghosts `classic` and let the
      // overlay show them verbatim, matching a stable player's live (ScoreV1) bar.
      finalScore = replay.stableScore;
      counts = replay.counts;
      finalAcc = +displayAccuracy(replay.counts, !isLazer).toFixed(2);
      maxCombo = replay.maxCombo;
      scoreScale = sim.finalScore > 0 ? finalScore / sim.finalScore : 1;
      isClassic = !isLazer;
    } else {
      // No usable header score: keep the simulated ScoreV2, applying the mod
      // multiplier so modded plays sit on the same standardised scale as the rest.
      scoreScale = modMultiplier(replay.mods, beatmap.mode);
      finalScore = Math.round(finalScore * scoreScale);
    }

    // Rescale the running Perfect/Great counts to the EXACT final, then derive the
    // per-sample ratio: it progresses over the play but lands on the real value,
    // and an all-Perfect run (0 Greats) scales to 0 Greats so it ranks top.
    const tl = sim.timeline;
    const lastPf = tl.length ? tl[tl.length - 1].pf : 0;
    const lastGr = tl.length ? tl[tl.length - 1].gr : 0;
    const sP = lastPf > 0 ? counts.max / lastPf : 0;
    const sG = lastGr > 0 ? counts.n300 / lastGr : 0;
    const timeline = tl.map((p) => {
      const perf = p.pf * sP, grt = p.gr * sG;
      return {
        t: p.t,
        score: Math.round(p.score * scoreScale),
        acc: p.acc,
        combo: p.combo,
        ratio: grt > 0 ? +(perf / grt).toFixed(2) : Math.round(perf),
      };
    });
    if (timeline.length) timeline[timeline.length - 1].score = finalScore; // exact at the end

    parentPort.postMessage({
      id,
      ok: true,
      ghost: {
        // Unique per file. NOT replayMD5: stable derives that hash from the
        // score's stats with no timestamp, so two plays with an identical score
        // on the same map collide — duplicate ids corrupt the board (bars share
        // a slot, ranks skip 2/4/6). The file path is always unique.
        replayId: osrPath,
        player: replay.player || 'Ghost',
        mods: replay.mods,
        lazer: isLazer, // pp uses lazer vs stable scoring to match the replay's origin
        classic: isClassic, // stable ScoreV1 scale — overlay shows it verbatim
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
