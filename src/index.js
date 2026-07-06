'use strict';

const path = require('path');
const fs = require('fs');
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
const { parseTaikoBeatmap } = require('./osu/taikoBeatmap');
const { judge: judgeTaiko } = require('./osu/taikoJudge');
const { parseCatchBeatmap } = require('./osu/catchBeatmap');
const { judge: judgeCatch } = require('./osu/catchJudge');
const lzma = require('lzma');
const { classicDisplayScore } = require('./osu/scoreV2');
const { modString, modSpeed } = require('./osu/mods');

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

// Count of "basic" judgements (great-able objects) — the object count lazer's
// classic-score conversion uses (maxBasicJudgements). The mania parser's
// noteCount equals this for osu!std (circles+sliders+spinners) and mania, but
// NOT for taiko (must exclude drum-roll ticks/dendens) or catch (counts fruits,
// not the raw .osu object lines). Using the wrong count makes the classic score
// off — badly for catch, since the catch formula squares it.
function basicObjectCount(mode, osuPath, fallback) {
  try {
    if (mode === GAMEMODE.TAIKO) return parseTaikoBeatmap(osuPath).notes.length;
    if (mode === GAMEMODE.CATCH) return parseCatchBeatmap(osuPath).objects.filter((o) => o.kind === 'fruit').length;
  } catch { /* fall through to the raw count */ }
  return fallback;
}

// Per-mode replay judge: parse the beatmap geometry + judge the cursor/key frames.
const JUDGE = {
  [GAMEMODE.STD]: { parse: parseStdBeatmap, judge: judgeStd },
  [GAMEMODE.TAIKO]: { parse: parseTaikoBeatmap, judge: judgeTaiko },
  [GAMEMODE.CATCH]: { parse: parseCatchBeatmap, judge: judgeCatch },
};

// Build a function score(t) that reconstructs the EXACT osu!stable ScoreV1 curve
// from a judge's combo-scaled hits, pinned to the replay's real final score.
//
// ScoreV1 adds, per combo-scaled hit: base + base·comboBefore·(D·M/25), where D/M
// are the map's difficulty & mod multipliers. Summed to time t this is
//   score(t) = A(t) + C·B(t),   A = Σ base,  B = Σ base·comboBefore,  C = D·M/25.
// We never need D or M: with the exact final known, C = (final − A_total)/B_total.
// B carries the super-linear Σ(base·combo) growth that a standardised curve lacks,
// which is what was causing the mid-race drift. (Flat slider-tick/roll points fold
// into C — a ~2% linear term — so the shape stays faithful.)
function classicScoreSampler(res, finalScore) {
  const evs = (res.scoreEvents || []).slice().sort((a, b) => a.t - b.t);
  if (!evs.length) return null;
  const ts = new Float64Array(evs.length), as = new Float64Array(evs.length), bs = new Float64Array(evs.length);
  let A = 0, B = 0;
  for (let i = 0; i < evs.length; i++) {
    A += evs[i].base;
    B += evs[i].base * evs[i].comboBefore;
    ts[i] = evs[i].t; as[i] = A; bs[i] = B;
  }
  const C = B > 0 ? (finalScore - A) / B : 0;
  let j = 0; // monotonic cursor — applyJudge samples in ascending time order
  return (t) => {
    while (j < ts.length && ts[j] <= t) j++;
    const a = j > 0 ? as[j - 1] : 0, b = j > 0 ? bs[j - 1] : 0;
    return Math.max(0, Math.round(a + C * b));
  };
}

// Replace each ghost's approximated curve with a REAL one: replay the frames
// against the beatmap to get true per-moment score/acc/combo, then rescale to
// the exact final score. Final numbers stay exact; only the in-between shape
// comes from the judge (so misses/breaks show at the right moments). Runs in the
// main process — a one-time per-map cost (a few ms per replay).
async function applyJudge(ghosts, osuPath, mode) {
  const J = JUDGE[mode];
  if (!J || !osuPath || !ghosts.length) return;
  let bm;
  try { bm = J.parse(osuPath); } catch { return; }
  await Promise.all(ghosts.map(async (g) => {
    try {
      const rep = parseReplay(g.replayId); // replayId is the .osr path
      const frames = await decodeCursorFrames(rep.replayData, lzma);
      if (!frames.length) return;
      const res = J.judge(bm, frames, { ...modFlags(g), stepMs: config.simStepMs });
      if (!res.timeline.length || !(res.rawFinal > 0)) return;
      const last = res.timeline[res.timeline.length - 1];
      const accShift = g.finalAcc - last.acc;       // pin the curve to the exact final accuracy
      // Per-sample score. Stable ('classic') ghosts get the exact ScoreV1 curve
      // reconstructed from the combo-scaled hits (see classicScoreSampler); lazer
      // ghosts rescale the standardised curve onto their exact header final.
      const sampler = g.classic ? classicScoreSampler(res, g.finalScore) : null;
      const k = sampler ? 0 : g.finalScore / res.rawFinal;
      g.timeline = res.timeline.map((p) => ({
        t: p.t,
        score: sampler ? sampler(p.t) : Math.round(p.raw * k),
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

// Decide which install ('stable' | 'lazer') the app should serve replays from,
// based on the osu! that's actually running. Prefer tosu's reported game
// directory (authoritative), then fall back to the active beatmap's path.
// Returns null when it can't tell OR when only one source is configured — in
// both cases we fall back to serving every indexed replay (no filtering).
function activeSourceType(gameDir, osuPath) {
  if (config.sources.length < 2) return null; // nothing to disambiguate
  const dir = (gameDir || '').trim();
  if (dir) {
    try {
      if (fs.existsSync(path.join(dir, 'client.realm')) || fs.existsSync(path.join(dir, 'files'))) return 'lazer';
      if (fs.existsSync(path.join(dir, 'Data', 'r'))) return 'stable';
    } catch { /* fall through to the path heuristic */ }
  }
  if (osuPath) {
    const p = osuPath.toLowerCase();
    let best = null;
    for (const s of config.sources) {
      const root = String(s.root).toLowerCase();
      if (p.startsWith(root) && (!best || s.root.length > best.len)) best = { type: s.type, len: s.root.length };
    }
    if (best) return best.type;
  }
  return null; // unknown -> don't filter
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
  // First launch scans your whole replay store, which can take a while. Report
  // live progress so the overlay shows it's working (and, thanks to the periodic
  // yields inside build(), the app stays interactive while it runs).
  await index.build((n) =>
    relay.sendStatus({ phase: 'init', note: `Scanning replays… (${n.toLocaleString()} files)` }));
  // tosu hasn't connected yet — assume it's not running until proven otherwise.
  relay.sendStatus({ phase: 'init', note: 'Waiting for tosu…' });

  const tosu = new TosuClient(config);
  let generation = 0;
  const cache = { md5: null, info: null, beatmap: null, local: null, global: [], breaks: [] }; // memoised per map

  function ghostPayload(g) {
    return {
      replayId: g.replayId,
      player: g.player,
      mods: g.global ? g.mods : (g.modsDisplay || modString(g.mods)),
      rate: modSpeed(g.modsExact || g.mods), // speed multiplier (honours lazer custom rate)
      global: !!g.global,
      classic: !!g.classic, // score is already ScoreV1 (stable) — overlay shows it as-is
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
      const osrPaths = index.lookup(info.md5, info.srcFilter);
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
          // (lazer) with an approximated curve; stable ghosts defer their score
          // to the frame judge below (finalScore null until applyJudge runs).
          local = osrPaths.map((p) => buildHeaderGhost(p, beatmap, info.mode, config.simStepMs)).filter(Boolean);
          const skipped = osrPaths.length - local.length;
          log.ok(`Built ${local.length} local ghost(s) from headers (mode ${info.mode})${skipped ? `, skipped ${skipped} unreadable/zero-score` : ''}.`);
        } else {
          local = [];
          log.info(index.mapCount === 0 ? 'No replays indexed (check install paths / `npm run index`).' : 'No local replays for this map.');
        }
      }
      local = dedupeLocal(local);
      await applyExactStats(local, info.mode); // exact lazer accuracy + slider hits + mods from the .osr
      if (gen !== generation) return;
      await applyJudge(local, info.osuPath, info.mode); // real per-moment curve (std + taiko) from the replay
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

    // NOTE: scores stay STANDARDISED here. Classic display is applied per-frame
    // in the overlay (to ghosts AND your live bar alike) because the catch classic
    // formula is non-linear — scaling the running curve by a constant would warp
    // it. Ranking is unaffected (classic is monotonic in standardised).
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
      basicCount: basicObjectCount(info.mode, info.osuPath, beatmap ? beatmap.noteCount : 0),
      totalHits: beatmap ? beatmap.totalHits : 0,
      breaks: cache.breaks || [],
      ghosts: trimmed.map(ghostPayload),
    });
    relay.sendStatus({ phase: 'ready', map: info.title, ghostCount: trimmed.length });
  }

  // ── post-play replay refresh ────────────────────────────────────────────────
  // When a play ends, osu! writes the just-finished attempt to disk as a NEW
  // replay. The board otherwise only rescans on a genuine map change, so that
  // fresh score wouldn't show up until you reselected the map. Re-scan the store
  // and, if a new replay for the current map actually appeared, rebuild the board
  // in place so the play you just finished joins the ghosts immediately.
  let refreshTimer = null;
  async function refreshAfterPlay(attempt) {
    refreshTimer = null;
    if (!cache.info || !cache.md5) return;
    const srcFilter = cache.info.srcFilter;
    const before = index.lookup(cache.md5, srcFilter).length;
    // force: a replay was just written; don't let the unchanged-dir fast path skip it.
    try { await index.build(null, { force: true }); }
    catch (e) { log.warn('post-play replay scan failed:', e.message); }
    const after = index.lookup(cache.md5, srcFilter).length;
    if (after > before) {
      log.info(`New replay for current map (${before} → ${after}); refreshing board.`);
      // reuseLocal=false forces a fresh local simulation that includes the new
      // .osr; build() doesn't clear the board, so the ghost list updates in place.
      build(cache.info, false).catch((e) => log.err('post-play rebuild error:', e.message));
    } else if (attempt < 3) {
      // The .osr can lag the play ending by a moment (esp. lazer's async import).
      refreshTimer = setTimeout(() => refreshAfterPlay(attempt + 1), 1200);
    }
  }

  // The configured install paths are best-effort guesses at default locations.
  // tosu, however, reports the directory of the osu! that's actually running —
  // so if we're not already indexing it (e.g. stable installed somewhere other
  // than %LOCALAPPDATA%\osu!), add it as a source and rescan. This is what makes
  // "load the replays for the running install" work even for non-default setups.
  async function ensureSourceForGameDir(gameDir) {
    const dir = (gameDir || '').trim();
    if (!dir) return false;
    let norm;
    try { norm = path.resolve(dir).toLowerCase(); } catch { return false; }
    if (config.sources.some((s) => { try { return path.resolve(String(s.root)).toLowerCase() === norm; } catch { return false; } })) {
      return false; // already indexing this install
    }
    try {
      if (fs.existsSync(path.join(dir, 'Data', 'r'))) {
        config.sources.push({ type: 'stable', root: dir, replayDir: path.join(dir, 'Data', 'r') });
        log.ok(`Discovered running stable install via tosu: ${dir}`);
      } else if (fs.existsSync(path.join(dir, 'client.realm')) || fs.existsSync(path.join(dir, 'files'))) {
        config.sources.push({ type: 'lazer', root: dir, filesDir: path.join(dir, 'files') });
        log.ok(`Discovered running lazer install via tosu: ${dir}`);
      } else {
        return false;
      }
    } catch { return false; }
    config.sourceSummary = config.sources.map((s) => `${s.type} (${s.root})`).join(', ');
    await index.build(); // scan the newly-added install so its replays are available
    return true;
  }

  // Which install(s) to serve replays from for this map. Normally just the one
  // that's running (so a stable player doesn't see lazer ghosts and vice versa);
  // null when the overlay's "Load both stable + lazer replays" option is on.
  function computeSrcFilter(info) {
    if (relay.clientConfig.bothInstalls) return null;
    return activeSourceType(info.gameDir, info.osuPath);
  }

  async function onBeatmap(info) {
    // Ignore a duplicate report of the map we're already on (tosu can re-emit) —
    // rebuilding here would clear the board and reset an in-progress play.
    if (info.md5 === cache.md5 && cache.local) return;
    await ensureSourceForGameDir(info.gameDir); // learn the running install if new
    info.srcFilter = computeSrcFilter(info);
    const bd = index.breakdown(info.md5);
    log.info(`Map selected: ${info.title || '(unknown)'}  [id ${info.beatmapId}, md5 ${info.md5.slice(0, 8)}…]`);
    log.info(`  replays for map: total ${bd.total} ${JSON.stringify(bd.by)} · running=${info.srcFilter || '(all)'} · gameDir="${info.gameDir || ''}"`);
    if (refreshTimer) { clearTimeout(refreshTimer); refreshTimer = null; } // drop a pending post-play refresh
    relay.clearGhosts(); // genuine map change -> reset the board
    await build(info, false);
  }

  tosu.on('beatmap', (info) => { onBeatmap(info).catch((e) => log.err('build error:', e.message)); });

  // Overlay toggled an option (e.g. global) -> rebuild current map. Reuse the
  // cached local ghosts UNLESS the replay-source filter changed (the "both
  // installs" toggle), which needs a fresh local lookup + simulation.
  relay.on('clientConfig', () => {
    if (!cache.info) return;
    const next = computeSrcFilter(cache.info);
    const filterChanged = next !== cache.info.srcFilter;
    cache.info.srcFilter = next;
    build(cache.info, !filterChanged).catch((e) => log.err('rebuild error:', e.message));
  });

  let prevGameState = null;
  tosu.on('state', ({ state }) => {
    relay.sendStatus({ phase: 'state', state });
    // Left gameplay (2 -> anything else): a pass/fail just wrote a new replay.
    // Schedule a scan; the count check inside refreshAfterPlay makes a plain quit
    // (no new replay) a cheap no-op that won't needlessly rebuild the board.
    if (prevGameState === 2 && state !== 2) {
      if (refreshTimer) clearTimeout(refreshTimer);
      refreshTimer = setTimeout(() => refreshAfterPlay(0), 800);
    }
    prevGameState = state;
  });
  tosu.on('live', (live) => relay.sendLive(live));
  // Reflect the tosu connection in the status line so a cold start without tosu
  // running shows "Waiting for tosu…" instead of a stale "loading" message.
  tosu.on('open', () => { if (!cache.md5) relay.sendStatus({ phase: 'init', note: 'Waiting for a beatmap…' }); });
  tosu.on('close', () => relay.sendStatus({ phase: 'init', note: 'Waiting for tosu…' }));
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
