'use strict';

const path = require('path');
const { config, validate } = require('../config');
const log = require('./util/logger');
const { ReplayIndex } = require('./osu/replayIndex');
const { parseBeatmap, parseBreaks } = require('./osu/osuParser');
const { SimPool } = require('./sim/simPool');
const { TosuClient } = require('./server/tosuClient');
const { RelayServer } = require('./server/relayServer');
const { startStaticServer } = require('./server/httpServer');
const { fetchGlobalGhosts } = require('./osu/globalGhosts');
const { buildHeaderGhost } = require('./osu/headerGhost');
const { loadPpMap, createPpCalc, attachPp } = require('./osu/pp');
const { GAMEMODE, readSoloStats, parseReplay, decodeCursorFrames } = require('./osu/osrParser');
const { parseStdBeatmap } = require('./osu/stdBeatmap');
const { judge: judgeStd } = require('./osu/stdJudge');
const lzma = require('lzma');
const { classicDisplayScore } = require('./osu/scoreV2');
const { modString } = require('./osu/mods');

/**
 * Orchestrator.
 *  - On map change: parse .osu, simulate matching LOCAL replays (exact scores),
 *    and broadcast. If the overlay has the global option on, also fetch the
 *    beatmap's global top-N and merge them in.
 *  - On overlay config change (e.g. toggling global): rebuild for the current
 *    map, reusing the cached local simulation.
 *  - Generation-guarded so map switches abandon stale in-flight work.
 */
// Collapse indistinguishable local replays into one ghost. Stable saves a new
// .osr for every play, so grinding a chart leaves many identical scores; without
// this the board fills with duplicate-looking rows. Two replays with the same
// player + final score + combo + accuracy are the same achievement on the board.
function dedupeLocal(ghosts) {
  const seen = new Set();
  const out = [];
  for (const g of ghosts) {
    const key = `${(g.player || '').toLowerCase()}|${g.finalScore}|${g.maxCombo}|${g.finalAcc}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(g);
  }
  return out;
}

// osu! accuracy as DISPLAYED by lazer, from a replay's exact statistics. Unlike
// the classic header counts, lazer weights slider tails (150) and large ticks
// (30) alongside circles/heads (300/100/50); "ignore" results (slider bodies)
// don't count. Weights verified by round-tripping rosu's own generator.
const ACC_WEIGHT = {
  great: 300, perfect: 300, good: 200, ok: 100, meh: 50, miss: 0,
  large_tick_hit: 30, large_tick_miss: 0, slider_tail_hit: 150, small_tick_hit: 10, small_tick_miss: 0,
};
function exactAccuracy(stats, max) {
  let num = 0, den = 0;
  for (const k in max) { const w = ACC_WEIGHT[k]; if (w != null) den += w * max[k]; }
  for (const k in stats) { const w = ACC_WEIGHT[k]; if (w != null) num += w * stats[k]; }
  return den > 0 ? +(num / den * 100).toFixed(2) : null;
}

// Acronym string from a lazer mods array (items are strings or {acronym,...}).
function modAcronyms(mods) {
  const a = mods.map((m) => (typeof m === 'string' ? m : m && m.acronym)).filter(Boolean);
  return a.length ? a.join('') : 'NM';
}

// For lazer replays, read the exact data embedded in the .osr:
//  • mods (incl. lazer-only ones like DC and custom rates) — the legacy bitmask
//    drops these, so display and pp would otherwise miss them. All modes.
//  • std only: slider-accurate accuracy + slider-hit counts (for exact pp).
// Stable replays keep their legacy bitmask + classic accuracy.
async function applyExactStats(ghosts, mode) {
  await Promise.all(ghosts.map(async (g) => {
    if (g.lazer === false) return; // stable: legacy bitmask is authoritative
    try {
      const solo = await readSoloStats(g.replayId, lzma);
      if (!solo) return;
      if (Array.isArray(solo.mods) && solo.mods.length) {
        g.modsExact = solo.mods;                 // for rosu (correct rate/star/pp)
        g.modsDisplay = modAcronyms(solo.mods);  // for the overlay
      }
      if (mode === GAMEMODE.STD && solo.statistics && solo.maximum_statistics) {
        const acc = exactAccuracy(solo.statistics, solo.maximum_statistics);
        if (acc != null) g.finalAcc = acc;
        if (solo.statistics.slider_tail_hit != null) g.sliderEndHits = solo.statistics.slider_tail_hit;
        if (solo.statistics.large_tick_hit != null) g.largeTickHits = solo.statistics.large_tick_hit;
      }
    } catch { /* keep legacy values */ }
  }));
}

// Rate / HR / EZ for the std judge — prefer the exact lazer mods, fall back to
// the legacy bitmask for stable replays.
function modFlags(g) {
  const acr = Array.isArray(g.modsExact) ? g.modsExact.map((m) => (typeof m === 'string' ? m : m && m.acronym)) : [];
  const num = typeof g.mods === 'number' ? g.mods : 0;
  const has = (a, bit) => acr.includes(a) || (num & bit) !== 0;
  const dt = has('DT', 64) || has('NC', 512);
  const ht = has('HT', 256) || acr.includes('DC');
  return { rate: dt ? 1.5 : ht ? 0.75 : 1, hardRock: has('HR', 16), easy: has('EZ', 2) };
}

// Replace each std ghost's approximated curve with a REAL one: replay the cursor
// frames against the beatmap (see stdJudge) to get true per-moment score/acc/
// combo, then rescale to the exact final score. Final numbers stay exact; only
// the in-between shape comes from the judge (so misses/breaks show at the right
// moments). Runs in the main process — a one-time per-map cost.
async function applyStdJudge(ghosts, osuPath, mode) {
  if (mode !== GAMEMODE.STD || !osuPath || !ghosts.length) return;
  let bm;
  try { bm = parseStdBeatmap(osuPath); } catch { return; }
  await Promise.all(ghosts.map(async (g) => {
    try {
      const rep = parseReplay(g.replayId); // replayId is the .osr path
      const frames = await decodeCursorFrames(rep.replayData, lzma);
      if (!frames.length) return;
      const res = judgeStd(bm, frames, { ...modFlags(g), stepMs: config.simStepMs });
      if (!res.timeline.length || !(res.rawFinal > 0)) return;
      const k = g.finalScore / res.rawFinal;       // pin the curve to the exact final score
      const last = res.timeline[res.timeline.length - 1];
      const accShift = g.finalAcc - last.acc;       // and to the exact final accuracy
      g.timeline = res.timeline.map((p) => ({
        t: p.t,
        score: Math.round(p.raw * k),
        acc: Math.min(100, Math.max(0, +(p.acc + accShift).toFixed(2))),
        combo: p.combo,
        ratio: 0,
      }));
      g.timeline[g.timeline.length - 1].score = g.finalScore;
      g.startTime = res.startTime;
      g.endTime = res.endTime;
    } catch { /* keep the approximated curve on any failure */ }
  }));
}

async function start({ onServersUp } = {}) {
  log.info('osu! Local Leaderboard starting...');
  log.info('Indexing source(s):', config.sourceSummary);
  log.info('osu! API (global ghosts):', config.apiEnabled ? 'enabled' : 'not configured');

  for (const p of validate()) log.warn(p);

  // Bring the servers up FIRST so the overlay can open and show "Initializing…"
  // immediately — the replay scan below can take a few seconds on a cold start.
  const relay = new RelayServer(config.relayPort);
  relay.start();

  startStaticServer(config.httpPort, path.join(__dirname, '..', 'public'), {
    relayPort: config.relayPort,
    maxGhosts: config.maxGhosts,
    simStepMs: config.simStepMs,
    apiEnabled: config.apiEnabled,
    globalCount: config.globalCount,
  });

  relay.sendStatus({ phase: 'init', note: 'Scanning replays…' });
  if (onServersUp) { try { onServersUp(config.httpPort); } catch { /* ignore */ } }

  const pool = new SimPool(config.simWorkers);
  log.info(`Simulation pool: ${config.simWorkers} worker(s), step ${config.simStepMs}ms.`);

  const index = new ReplayIndex(config);
  await index.build();
  relay.sendStatus({ phase: 'init', note: 'Waiting for a beatmap…' });

  const tosu = new TosuClient(config);
  let generation = 0;
  const cache = { md5: null, info: null, beatmap: null, local: null, global: [], breaks: [] }; // memoised per map

  function ghostPayload(g) {
    return {
      replayId: g.replayId,
      player: g.player,
      mods: g.global ? g.mods : (g.modsDisplay || modString(g.mods)),
      global: !!g.global,
      country: g.country || '',
      finalScore: g.finalScore,
      finalAcc: g.finalAcc,
      finalPp: g.finalPp || 0,
      ppTimeline: g.ppTimeline || [],
      maxCombo: g.maxCombo,
      counts: g.counts,
      startTime: g.startTime,
      endTime: g.endTime,
      timeline: g.timeline,
    };
  }

  async function build(info, reuseLocal) {
    const gen = ++generation;
    // Lazy pp calculator for this map: parses the .osu once and is reused for
    // both local and global ghosts within this build.
    let _ppCalc = null;
    const ppCalc = () => (_ppCalc || (_ppCalc = createPpCalc(loadPpMap(info.osuPath, info.mode), info.mode)));
    // NOTE: we do NOT clear the board here. Clearing (which resets your live play
    // on the overlay) only happens on a genuine map change. Same-map rebuilds
    // (e.g. toggling global) update the ghost list in place so nothing collapses
    // mid-play.
    if (!reuseLocal) relay.sendStatus({ phase: 'loading', map: info.title, md5: info.md5 });

    // ── local ghosts (memoised per map) ──────────────────────────────────────
    let beatmap = cache.beatmap;
    let local = reuseLocal && cache.md5 === info.md5 ? cache.local : null;

    if (!local) {
      if (config.watchReplays) { await index.build(); if (gen !== generation) return; }
      const osrPaths = index.lookup(info.md5);
      if (!info.osuPath) {
        log.warn('tosu did not provide a .osu path; cannot simulate.');
        beatmap = null; local = [];
      } else {
        try { beatmap = parseBeatmap(info.osuPath); }
        catch (e) { log.err('Failed to parse .osu:', e.message); return; }
        if (osrPaths.length && info.mode === GAMEMODE.MANIA) {
          // mania: frame-accurate simulation (worker pool) + exact-header finals.
          log.info(`Simulating ${osrPaths.length} local mania replay(s) | ${beatmap.keyCount}K OD${beatmap.overallDifficulty}, ${beatmap.noteCount} notes...`);
          local = await pool.simulateBatch(osrPaths, beatmap, config.simStepMs, (done, total) => {
            if (gen === generation) relay.sendStatus({ phase: 'loading', map: info.title, progress: done / total });
          });
          if (gen !== generation) return;
          log.ok(`Matched ${local.length} local replay(s).`);
        } else if (osrPaths.length) {
          // std/taiko/catch: no frame judge — use exact standardised header finals
          // (lazer) with an approximated curve. Stable replays are skipped.
          local = osrPaths.map((p) => buildHeaderGhost(p, beatmap, info.mode, config.simStepMs)).filter(Boolean);
          const skipped = osrPaths.length - local.length;
          log.ok(`Built ${local.length} local ghost(s) from headers (mode ${info.mode})${skipped ? `, skipped ${skipped} non-standardised` : ''}.`);
        } else {
          local = [];
          log.info(index.mapCount === 0 ? 'No replays indexed (check install paths / `npm run index`).' : 'No local replays for this map.');
        }
      }
      local = dedupeLocal(local);
      await applyExactStats(local, info.mode); // exact lazer accuracy + slider hits + mods from the .osr
      if (gen !== generation) return;
      await applyStdJudge(local, info.osuPath, info.mode); // real per-moment std curve from the replay
      if (gen !== generation) return;
      local = attachPp(local, ppCalc(), beatmap ? beatmap.objects.map((o) => o.time) : []);
      cache.md5 = info.md5; cache.info = info; cache.beatmap = beatmap; cache.local = local; cache.global = [];
      cache.breaks = info.osuPath ? parseBreaks(info.osuPath) : [];
    }

    // ── global ghosts (on demand) ────────────────────────────────────────────
    let global = [];
    const wantGlobal = relay.clientConfig.includeGlobal;
    if (wantGlobal && config.apiEnabled && info.beatmapId && beatmap) {
      try {
        const count = relay.clientConfig.globalCount || config.globalCount;
        global = await fetchGlobalGhosts(config, info.beatmapId, info.mode, beatmap, config.simStepMs, count);
        if (gen !== generation) return;
        attachPp(global, ppCalc(), beatmap ? beatmap.objects.map((o) => o.time) : []);
        cache.global = global; // remember the good result
        log.ok(`Fetched global top ${global.length} for beatmap ${info.beatmapId}.`);
      } catch (e) {
        // Keep whatever we already had so a transient failure doesn't make the
        // global rows vanish mid-play.
        global = cache.global;
        log.warn('Global leaderboard fetch failed (keeping previous):', e.message);
      }
    } else if (wantGlobal && !config.apiEnabled) {
      log.warn('Global ghosts requested but OSU_API_CLIENT_ID/SECRET are not set.');
    }

    // ── merge (dedupe your own name from global), rank, send ──────────────────
    const localNames = new Set(local.map((g) => g.player.toLowerCase()));
    let merged = local.concat(global.filter((g) => !localNames.has(g.player.toLowerCase())));

    // Classic display: convert every (standardised) ghost to lazer's classic
    // display score, matching the in-game "Classic" setting. Linear for std/taiko
    // so rescaling the curve to the new final keeps it exact; mania is unchanged.
    if (relay.clientConfig.scoring === 'classic' && beatmap) {
      const oc = beatmap.noteCount;
      merged = merged.map((g) => {
        const cf = classicDisplayScore(g.finalScore, info.mode, oc);
        const k = g.finalScore > 0 ? cf / g.finalScore : 1;
        return { ...g, finalScore: cf, timeline: g.timeline.map((p) => ({ ...p, score: Math.round(p.score * k) })) };
      });
    }

    merged.sort((a, b) => b.finalScore - a.finalScore);
    const cap = Math.max(config.maxGhosts, wantGlobal ? (relay.clientConfig.globalCount || config.globalCount) : 0) + local.length;
    const trimmed = merged.slice(0, cap);

    relay.sendGhosts({
      map: info.title,
      md5: info.md5,
      step: config.simStepMs,
      mode: info.mode,
      scoring: relay.clientConfig.scoring,
      keyCount: beatmap ? beatmap.keyCount : 0,
      noteCount: beatmap ? beatmap.noteCount : 0,
      totalHits: beatmap ? beatmap.totalHits : 0,
      breaks: cache.breaks || [],
      ghosts: trimmed.map(ghostPayload),
    });
    relay.sendStatus({ phase: 'ready', map: info.title, ghostCount: trimmed.length });
  }

  tosu.on('beatmap', (info) => {
    // Ignore a duplicate report of the map we're already on (tosu can re-emit) —
    // rebuilding here would clear the board and reset an in-progress play.
    if (info.md5 === cache.md5 && cache.local) return;
    log.info(`Map selected: ${info.title || '(unknown)'}  [id ${info.beatmapId}, md5 ${info.md5.slice(0, 8)}…]`);
    relay.clearGhosts(); // genuine map change -> reset the board
    build(info, false).catch((e) => log.err('build error:', e.message));
  });

  // Overlay toggled an option (e.g. global) -> rebuild current map, reuse local.
  relay.on('clientConfig', () => {
    if (cache.info) build(cache.info, true).catch((e) => log.err('rebuild error:', e.message));
  });

  tosu.on('state', ({ state }) => relay.sendStatus({ phase: 'state', state }));
  tosu.on('live', (live) => relay.sendLive(live));
  tosu.connect();

  // Handle to tear everything down (used by the Electron app on quit).
  return {
    httpPort: config.httpPort,
    relayPort: config.relayPort,
    async stop() { log.info('Stopping backend...'); tosu.close(); await pool.destroy(); },
  };
}

module.exports = { start };

// CLI / dev: `node src/index.js`
if (require.main === module) {
  start()
    .then((h) => {
      const shutdown = async () => { await h.stop(); process.exit(0); };
      process.on('SIGINT', shutdown);
      process.on('SIGTERM', shutdown);
    })
    .catch((e) => { log.err('Fatal:', e.stack || e.message); process.exit(1); });
}
