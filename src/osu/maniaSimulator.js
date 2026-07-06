'use strict';

const { rateFromMods, effectiveOD } = require('./mods');
const { JUDGE, BASE_VALUE, SCORE, hitWindows, judgeError, computeScore, displayAccuracy, maxComboPortion } = require('./scoreV2');

/**
 * Convert decoded replay frames into per-column press/release events.
 *
 * mania `keys` bitmask: bit i set => column i is held this frame. A rising edge
 * (bit goes 0->1) is a press; a falling edge (1->0) is a release. Times are
 * converted from real time to SONG time via the rate multiplier so they line up
 * with .osu note times.
 */
function extractColumnEvents(frames, keyCount, rate) {
  const presses = Array.from({ length: keyCount }, () => []);
  const releases = Array.from({ length: keyCount }, () => []);
  let prev = 0;

  for (const f of frames) {
    const cur = f.keys;
    const changed = cur ^ prev;
    if (changed) {
      const songTime = f.t * rate;
      for (let col = 0; col < keyCount; col++) {
        const bit = 1 << col;
        if (!(changed & bit)) continue;
        if (cur & bit) presses[col].push(songTime);
        else releases[col].push(songTime);
      }
    }
    prev = cur;
  }
  return { presses, releases };
}

/**
 * Greedy per-column matcher: walk notes in time order, consume the earliest
 * unused press within the miss window. Long-note tails additionally require a
 * release near the tail (relaxed window), else the LN judgement is downgraded.
 *
 * Produces a chronologically ordered list of judgements: { time, judge }.
 */
function judgeColumns(notesByColumn, presses, releases, windows) {
  const judgements = [];

  for (let col = 0; col < notesByColumn.length; col++) {
    const notes = notesByColumn[col];
    const pr = presses[col];
    const rel = releases[col];
    let pi = 0; // press pointer
    let ri = 0; // release pointer

    // Tail windows are widened by lazer's RELEASE_WINDOW_LENIENCE (1.5x).
    const TL = 1.5;
    const tailWindows = {
      max: windows.max * TL, n300: windows.n300 * TL, n200: windows.n200 * TL,
      n100: windows.n100 * TL, n50: windows.n50 * TL, miss: windows.miss * TL,
    };

    for (const note of notes) {
      // advance press pointer to first press not before (note.time - missWindow)
      while (pi < pr.length && pr[pi] < note.time - windows.miss) pi++;

      let headJudge = JUDGE.MISS;
      let headPressTime = null;
      if (pi < pr.length && pr[pi] <= note.time + windows.miss) {
        headPressTime = pr[pi];
        headJudge = judgeError(Math.abs(headPressTime - note.time), windows);
        pi++; // consume this press
      }

      if (note.endTime == null) {
        judgements.push({ time: note.time, judge: headJudge });
        continue;
      }

      // Long note: head + tail are scored separately (lazer counts a hold twice).
      judgements.push({ time: note.time, judge: headJudge });

      // The release that ENDS this hold is the first release at/after the head
      // press. Holding through (late release) still counts; only a far/early
      // release misses. A note can't share a column with another while held, so
      // this release unambiguously belongs to this LN.
      let tailJudge = JUDGE.MISS;
      if (headJudge !== JUDGE.MISS && headPressTime != null) {
        while (ri < rel.length && rel[ri] < headPressTime) ri++;
        if (ri < rel.length) {
          tailJudge = judgeError(Math.abs(rel[ri] - note.endTime), tailWindows);
          ri++;
        } else {
          tailJudge = JUDGE.MAX; // held to the end of the map -> credited
        }
      }
      judgements.push({ time: note.endTime, judge: tailJudge });
    }
  }

  judgements.sort((a, b) => a.time - b.time);
  return judgements;
}

/**
 * Full simulation entry point.
 *
 * @param {object} frames   decoded {t, keys}[] (absolute real-time)
 * @param {object} beatmap  parsed .osu: { keyCount, overallDifficulty, objects }
 * @param {number} mods     replay mod bitmask
 * @param {number} stepMs   timeline sample granularity
 * @returns timeline + final stats
 */
function simulate(frames, beatmap, mods, stepMs, classic) {
  const rate = rateFromMods(mods);
  const od = effectiveOD(beatmap.overallDifficulty, mods);
  const windows = hitWindows(od);
  const keyCount = beatmap.keyCount;

  // bucket notes by column
  const notesByColumn = Array.from({ length: keyCount }, () => []);
  for (const o of beatmap.objects) {
    if (o.column >= 0 && o.column < keyCount) notesByColumn[o.column].push(o);
  }
  for (const list of notesByColumn) list.sort((a, b) => a.time - b.time);

  const { presses, releases } = extractColumnEvents(frames, keyCount, rate);
  const judgements = judgeColumns(notesByColumn, presses, releases, windows);

  const N = beatmap.objects.length;
  // Total judgements = notes + holds (each hold scores head + tail), matching
  // lazer and the live calc. Equals judgements.length.
  const totalHits = judgements.length;
  const maxCombo = maxComboPortion(totalHits); // Σ i^0.5 for a full combo

  // Running tallies, walking judgements in time order while emitting samples on a grid.
  const counts = { max: 0, n300: 0, n200: 0, n100: 0, n50: 0, miss: 0 };
  let baseScore = 0;
  let comboPortion = 0;
  let combo = 0;
  let bestCombo = 0;
  let judged = 0;

  // Cover LN tails too: the last judged time can be an endTime past the last head.
  let lastTime = 0;
  let firstTime = 0;
  if (N > 0) {
    firstTime = beatmap.objects[0].time;
    for (const o of beatmap.objects) {
      const end = o.endTime != null ? o.endTime : o.time;
      if (end > lastTime) lastTime = end;
    }
  }
  const timeline = [];
  let ji = 0;

  // Sample from the first note to slightly past the last, on the step grid.
  const start = Math.floor(firstTime / stepMs) * stepMs;
  for (let t = start; t <= lastTime + stepMs; t += stepMs) {
    while (ji < judgements.length && judgements[ji].time <= t) {
      const j = judgements[ji].judge;
      counts[j]++;
      baseScore += BASE_VALUE[j];
      judged++;
      if (j === JUDGE.MISS) {
        combo = 0;
      } else {
        combo++;
        comboPortion += Math.pow(combo, SCORE.COMBO_BASE);
        if (combo > bestCombo) bestCombo = combo;
      }
      ji++;
    }

    timeline.push({
      t,
      score: computeScore({ baseScore, comboPortion, judged, totalHits, maxCombo }),
      acc: judged > 0 ? +displayAccuracy(counts, classic).toFixed(2) : 100,
      combo,
      // Running Perfect/Great counts. The worker rescales these to the EXACT final
      // counts (our judging mis-splits them) and derives the per-sample ratio, so
      // ratio progresses over the play yet lands on the real final value.
      pf: counts.max,
      gr: counts.n300,
    });
  }

  // Drain any remaining judgements for the final tally.
  while (ji < judgements.length) {
    const j = judgements[ji].judge;
    counts[j]++;
    baseScore += BASE_VALUE[j];
    judged++;
    if (j === JUDGE.MISS) combo = 0;
    else { combo++; comboPortion += Math.pow(combo, SCORE.COMBO_BASE); if (combo > bestCombo) bestCombo = combo; }
    ji++;
  }

  const finalScore = computeScore({ baseScore, comboPortion, judged, totalHits, maxCombo });

  return {
    timeline,
    stepMs,
    startTime: start,
    endTime: lastTime,
    finalScore,
    finalAcc: +displayAccuracy(counts, classic).toFixed(2),
    maxCombo: bestCombo,
    counts,
  };
}

module.exports = { simulate, extractColumnEvents, judgeColumns };
