'use strict';

/* ─────────────────────────────────────────────────────────────────────────────
   osu! Local Leaderboard — overlay client.

   Renders a live-sorting leaderboard of ghost replays + your live play, with a
   user-editable config screen (colors / size / layout / sort mode), a distinct
   colour for #1 pace, and an optional "same mods only" filter.
   ───────────────────────────────────────────────────────────────────────────── */

(() => {
  // ── ScoreV2 (mirrors src/osu/scoreV2.js; only used as a live fallback) ──────
  const SCORE = { COMBO_PORTION: 150000, ACC_PORTION: 850000, MAX_BASE: 305, COMBO_BASE: 0.2 };
  function computeScoreV2(baseScore, comboPortion, judged, totalHits, maxComboPortion) {
    if (totalHits <= 0 || judged <= 0) return 0;
    const progress = judged / totalHits;
    const comboProgress = maxComboPortion > 0 ? comboPortion / maxComboPortion : 0;
    const acc = baseScore / (judged * SCORE.MAX_BASE);
    return Math.round(SCORE.COMBO_PORTION * comboProgress + SCORE.ACC_PORTION * Math.pow(acc, 2 + 2 * acc) * progress);
  }
  function maxComboPortionFor(n) { let s = 0; for (let i = 1; i <= n; i++) s += Math.pow(i, SCORE.COMBO_BASE); return s; }

  // lazer standardised -> classic display conversion (mirrors src/osu/scoreV2.js).
  function classicDisplayScore(standardised, mode, objectCount) {
    const oc = Math.max(1, objectCount || 0);
    const scaled = standardised / 1_000_000;
    switch (mode) {
      case 0: return Math.round((oc * oc * 32.57 + 100000) * scaled);
      case 1: return Math.round((oc * 1109 + 100000) * scaled);
      case 2: return Math.round(Math.pow(scaled * oc, 2) * 21.62 + standardised / 10);
      default: return Math.round(standardised); // mania unchanged
    }
  }

  // ── Settings ────────────────────────────────────────────────────────────────
  const SETTINGS_KEY = 'osu-leaderboard-settings';
  const DEFAULTS = {
    // sorting & behaviour
    sortBy: 'score',        // score | accuracy | combo | ratio
    maxGhosts: 10,
    focusMe: true,          // window the board around your rank when it's long
    aheadCount: 4,          // players shown directly above you
    behindCount: 1,         // players shown directly below you
    swapCooldown: 450,      // ms a bar must wait before swapping again (debounce)
    showLeader: true,       // distinct colour for #1
    sameModsOnly: false,    // only ghosts whose mods match yours
    includeGlobal: false,   // pull the beatmap's global top-N as ghosts
    globalCount: 50,        // how many global scores to include
    scoring: 'standardised', // standardised (ScoreV2) | classic (ScoreV1)
    // colours
    colYou: '#ffcc22',
    colLeader: '#46e07a',
    colGhost: '#cfd8ff',
    colText: '#ffffff',
    // size & layout
    barHeight: 46,
    barGap: 6,
    boardWidth: 340,
    fontScale: 1,
    uiScale: 1,
    shadow: 2,
    left: 24,
    top: 24,
  };

  const SCHEMA = [
    { group: 'Sorting & behaviour' },
    { key: 'sortBy', label: 'Rank by', type: 'select', options: [['score', 'Score'], ['accuracy', 'Accuracy'], ['combo', 'Combo'], ['ratio', 'Perfect:Great ratio']] },
    { key: 'maxGhosts', label: 'Max rows (full view)', type: 'range', min: 1, max: 50, step: 1 },
    { key: 'focusMe', label: 'Follow my rank (window)', type: 'bool' },
    { key: 'aheadCount', label: 'Players above me', type: 'range', min: 0, max: 15, step: 1 },
    { key: 'behindCount', label: 'Players below me', type: 'range', min: 0, max: 5, step: 1 },
    { key: 'swapCooldown', label: 'Sort debounce (ms)', type: 'range', min: 0, max: 2000, step: 50 },
    { key: 'showLeader', label: 'Highlight #1 pace', type: 'bool' },
    { key: 'sameModsOnly', label: 'Only ghosts with my mods', type: 'bool' },
    { key: 'includeGlobal', label: 'Include global top scores', type: 'bool' },
    { key: 'globalCount', label: 'Global count (max 100)', type: 'range', min: 1, max: 100, step: 1 },
    { key: 'scoring', label: 'Scoring', type: 'select', options: [['standardised', 'Standardised (V2)'], ['classic', 'Classic (V1)']] },
    { group: 'Colours' },
    { key: 'colYou', label: 'You', type: 'color' },
    { key: 'colLeader', label: '#1 pace', type: 'color' },
    { key: 'colGhost', label: 'Rank number', type: 'color' },
    { key: 'colText', label: 'Text', type: 'color' },
    { group: 'Size & layout' },
    { key: 'barHeight', label: 'Bar height', type: 'range', min: 28, max: 80, step: 1, unit: 'px' },
    { key: 'barGap', label: 'Bar gap', type: 'range', min: 0, max: 24, step: 1, unit: 'px' },
    { key: 'boardWidth', label: 'Width', type: 'range', min: 200, max: 640, step: 5, unit: 'px' },
    { key: 'fontScale', label: 'Font scale', type: 'range', min: 0.6, max: 2, step: 0.05 },
    { key: 'uiScale', label: 'Overall scale', type: 'range', min: 0.4, max: 3, step: 0.05 },
    { key: 'shadow', label: 'Text shadow', type: 'range', min: 0, max: 6, step: 0.5, unit: 'px' },
  ];

  let settings = loadSettings();
  function loadSettings() {
    try { return { ...DEFAULTS, ...(JSON.parse(localStorage.getItem(SETTINGS_KEY)) || {}) }; }
    catch { return { ...DEFAULTS }; }
  }
  function saveSettings() {
    try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings)); } catch { /* ignore */ }
  }

  // hex -> "r,g,b"
  function rgbOf(hex) {
    const n = parseInt(hex.replace('#', ''), 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  }
  function darkTint(hex) { const [r, g, b] = rgbOf(hex); return `rgba(${(r * 0.33) | 0},${(g * 0.33) | 0},${(b * 0.33) | 0},0.72)`; }

  function applySettings() {
    const r = document.documentElement.style;
    r.setProperty('--you', settings.colYou);
    r.setProperty('--leader', settings.colLeader);
    r.setProperty('--ghost', settings.colGhost);
    r.setProperty('--text', settings.colText);
    r.setProperty('--bg-bar-you', darkTint(settings.colYou));
    r.setProperty('--bg-bar-leader', darkTint(settings.colLeader));
    r.setProperty('--bar-height', `${settings.barHeight}px`);
    r.setProperty('--bar-gap', `${settings.barGap}px`);
    r.setProperty('--board-width', `${settings.boardWidth}px`);
    r.setProperty('--font-scale', settings.fontScale);
    r.setProperty('--ui-scale', settings.uiScale);
    const s = settings.shadow;
    r.setProperty('--shadow', s <= 0 ? 'none' : `0 0 ${s}px #000, 0 0 ${s * 2}px #000, 0 2px ${s + 3}px rgba(0,0,0,0.9)`);
    overlayEl.style.left = `${settings.left}px`;
    overlayEl.style.top = `${settings.top}px`;
  }

  const SLOT = () => settings.barHeight + settings.barGap;

  // ── State ────────────────────────────────────────────────────────────────────
  const state = {
    ghosts: [],          // full received list (sorted by final score desc)
    totalHits: 0,
    maxComboPortion: 0,
    mode: 3,             // beatmap mode (for classic-score conversion of the live bar)
    objectCount: 0,      // basic object count (for classic conversion)
    playing: false,
    paused: false,
    finished: false,
    order: [],
    lastSwap: new Map(),
    lastTime: 0,
    lastTimeAt: 0,
    you: { name: 'You', score: 0, acc: 100, combo: 0, maxCombo: 0, ratio: 0, mods: '', prevCombo: 0, comboPortion: 0 },
  };

  // ── DOM ──────────────────────────────────────────────────────────────────────
  const overlayEl = document.getElementById('overlay');
  const board = document.getElementById('board');
  const titleEl = document.getElementById('map-title');
  const connEl = document.getElementById('conn');
  const statusEl = document.getElementById('status');
  const headerEl = document.getElementById('header');
  const resizeHandle = document.getElementById('resize-handle');
  const template = document.getElementById('bar-template');
  const configBtn = document.getElementById('config-btn');
  const configPanel = document.getElementById('config-panel');
  const bars = new Map();

  const fmt = (n) => Math.round(n).toLocaleString('en-US');
  // Normalise a mod string for comparison. CL (Classic) is dropped because most
  // global scores carry it while a fresh lazer play does not — comparing it would
  // make "same mods" match almost nothing.
  const normMods = (m) => (m || '').toUpperCase().replace(/NM|CL/g, '').match(/../g)?.sort().join('') || '';

  // ── Per-metric helpers for sorting + display ──────────────────────────────────
  // `margin` only damps tiny jitter / exact ties — it must stay well below real
  // gaps. Top scores pack within a few hundred points, so the score margin has to
  // be tiny or a clearly-higher score gets stuck below a lower one. Visual
  // stability is handled by the cooldown (the "Sort debounce" setting), not this.
  const METRIC = {
    score:    { val: (e) => e.score,  margin: 1,    fmt: (e) => fmt(e.display) },
    accuracy: { val: (e) => e.acc,    margin: 0.005, fmt: (e) => `${e.acc.toFixed(2)}%` },
    combo:    { val: (e) => e.combo,  margin: 0.5,  fmt: (e) => `${e.combo || 0}x` },
    ratio:    { val: (e) => e.ratio,  margin: 0.01, fmt: (e) => `${(e.ratio || 0).toFixed(2)}:1` },
  };
  function ratioOf(counts) { return counts ? (counts.n300 > 0 ? counts.max / counts.n300 : counts.max) : 0; }

  // ── Ghost interpolation ───────────────────────────────────────────────────────
  function ghostAt(g, t) {
    const tl = g.timeline;
    if (!tl.length) return { score: 0, acc: g.finalAcc, combo: 0, ratio: 0 };
    if (t <= tl[0].t) return { score: 0, acc: g.finalAcc, combo: 0, ratio: 0 };
    if (t >= tl[tl.length - 1].t) {
      const last = tl[tl.length - 1];
      return { score: g.finalScore, acc: g.finalAcc, combo: g.maxCombo, ratio: ratioOf(g.counts) };
    }
    let lo = 0, hi = tl.length - 1;
    while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (tl[mid].t <= t) lo = mid; else hi = mid; }
    const a = tl[lo], b = tl[hi];
    const f = (t - a.t) / ((b.t - a.t) || 1);
    const near = f < 0.5 ? a : b;
    return {
      score: a.score + (b.score - a.score) * f,
      acc: a.acc + (b.acc - a.acc) * f,
      combo: near.combo,
      ratio: near.ratio != null ? near.ratio : 0,
    };
  }

  function playhead() {
    if (state.playing) return state.paused ? state.lastTime : state.lastTime + (performance.now() - state.lastTimeAt);
    if (state.finished) return state.lastTime;
    return Infinity; // idle -> final-score preview
  }

  // ── Build per-frame entries ───────────────────────────────────────────────────
  // All ghosts that should participate in ranking (mods filter applied here;
  // the row-count limit / windowing happens after ranking so your true rank is
  // correct even when you're rank 40 of 50).
  function visibleGhosts() {
    if (settings.sameModsOnly && (state.playing || state.finished)) {
      const mine = normMods(state.you.mods);
      return state.ghosts.filter((g) => normMods(g.mods) === mine);
    }
    return state.ghosts;
  }

  function collectEntries() {
    const t = playhead();
    const idle = t === Infinity;
    const showMax = idle || state.finished;
    const entries = [];

    for (const g of visibleGhosts()) {
      let score, acc, combo, ratio;
      // Per-sample ratio is rescaled to the exact final (see simWorker), so it
      // progresses over the play yet ends correct. Idle/finished use the final.
      if (idle) { score = g.finalScore; acc = g.finalAcc; combo = g.maxCombo; ratio = ratioOf(g.counts); }
      else { const s = ghostAt(g, t); score = s.score; acc = s.acc; combo = showMax ? g.maxCombo : s.combo; ratio = s.ratio != null ? s.ratio : ratioOf(g.counts); }
      entries.push({ id: g.replayId, name: g.player, mods: g.mods, score, acc, combo, ratio, isYou: false, global: g.global });
    }

    if (state.playing || state.finished) {
      entries.push({
        id: '__you__', name: state.you.name, mods: state.you.mods,
        score: state.you.score, acc: state.you.acc,
        combo: showMax ? state.you.maxCombo : state.you.combo, ratio: state.you.ratio, isYou: true,
      });
    }
    return entries;
  }

  // ── Debounced ordering by the chosen metric ───────────────────────────────────
  // A bar must beat the one above it by `margin` to rise, and can't re-move within
  // `swapCooldown` (the debounce). A single move relocates a bar PAST AS MANY bars
  // as it now beats — so passing 4 people happens in one jump, not 4 cooldowns.
  // The cooldown only exists to damp thrashing while scores actively cross; if
  // NOTHING has changed for a moment (a break / static section), we skip it and
  // let the board settle to the true order immediately.
  const STATIC_MS = 200;       // no value changed for this long -> not thrashing
  const lastVals = new Map();
  let lastChangeAt = 0;

  function applyOrder(entries) {
    const cooldown = settings.swapCooldown;
    const m = METRIC[settings.sortBy] || METRIC.score;
    const byId = new Map(entries.map((e) => [e.id, e]));
    state.order = state.order.filter((id) => byId.has(id));
    const known = new Set(state.order);
    const fresh = entries.filter((e) => !known.has(e.id)).sort((a, b) => m.val(b) - m.val(a));
    for (const e of fresh) state.order.push(e.id);

    const now = performance.now();
    const val = (id) => m.val(byId.get(id));

    // Did any sort value change since last frame? (A roster change counts too.)
    let changed = fresh.length > 0 || lastVals.size !== byId.size;
    for (const [id, e] of byId) {
      const v = m.val(e);
      if (Math.abs((lastVals.get(id) ?? NaN) - v) > 1e-6) changed = true;
      lastVals.set(id, v);
    }
    for (const id of lastVals.keys()) if (!byId.has(id)) lastVals.delete(id);
    if (changed) lastChangeAt = now;
    const isStatic = now - lastChangeAt > STATIC_MS; // scores settled -> no thrash risk

    let moved = true;
    let guard = 0;
    while (moved && guard++ < state.order.length + 1) {
      moved = false;
      for (let i = 1; i < state.order.length; i++) {
        const id = state.order[i];
        if (!isStatic && now - (state.lastSwap.get(id) || 0) <= cooldown) continue; // debounced (only while scores move)
        // How far up should it go? Past every consecutive bar above it that it
        // now beats by the margin.
        let j = i;
        while (j > 0 && val(id) > val(state.order[j - 1]) + m.margin) j--;
        if (j < i) {
          state.order.splice(i, 1);
          state.order.splice(j, 0, id);
          state.lastSwap.set(id, now); // one cooldown for the whole multi-rank jump
          moved = true;
          break; // indices shifted — rescan
        }
      }
    }
    return state.order.map((id, i) => { const e = byId.get(id); e.rank = i + 1; return e; });
  }

  // Pick which ranked rows to actually show. In "follow my rank" mode a long
  // board collapses to: #1, a "⋯ N more ⋯" gap, the N players just above you,
  // you, and M players just below you. Otherwise it's the top `maxGhosts`.
  function windowEntries(ranked) {
    if (!settings.focusMe) return ranked.slice(0, settings.maxGhosts);
    const yi = ranked.findIndex((e) => e.isYou);
    if (yi < 0) return ranked.slice(0, settings.maxGhosts); // not playing -> top N

    const ahead = settings.aheadCount, behind = settings.behindCount;
    const aboveStart = Math.max(1, yi - ahead);
    const out = [ranked[0]];                       // always the leader
    const hidden = aboveStart - 1;                 // ranks between #1 and the window
    if (hidden > 0) out.push({ id: '__gap__', gap: true, hidden });
    for (let i = aboveStart; i <= yi; i++) if (i !== 0) out.push(ranked[i]); // above + you
    for (let i = yi + 1; i <= Math.min(ranked.length - 1, yi + behind); i++) out.push(ranked[i]);
    return out;
  }

  // ── Bars ──────────────────────────────────────────────────────────────────────
  function ensureBar(id) {
    let bar = bars.get(id);
    if (bar) return bar;
    const el = template.content.firstElementChild.cloneNode(true);
    board.appendChild(el);
    bar = {
      el,
      refs: {
        rank: el.querySelector('.rank'), name: el.querySelector('.name'),
        mods: el.querySelector('.mods'), s1: el.querySelector('.s1'), s2: el.querySelector('.s2'),
        score: el.querySelector('.score'),
      },
      display: 0, prevRank: 99,
    };
    bars.set(id, bar);
    requestAnimationFrame(() => el.classList.add('visible'));
    return bar;
  }

  function render(entries) {
    const seen = new Set();
    const slot = SLOT();
    const sortBy = settings.sortBy;
    const subKeys = ['accuracy', 'combo', 'score', 'ratio'].filter((k) => k !== sortBy).slice(0, 2);

    entries.forEach((e, i) => {
      seen.add(e.id);
      const bar = ensureBar(e.id);
      const ty = `translateY(${i * slot}px)`;
      bar.el.style.setProperty('--ty', ty);
      bar.el.style.transform = ty;

      // "⋯ N more ⋯" separator between #1 and the window.
      if (e.gap) {
        bar.el.classList.add('gap');
        bar.el.classList.remove('you', 'leader');
        bar.refs.rank.textContent = '';
        bar.refs.name.textContent = `⋯ ${e.hidden} more ⋯`;
        bar.refs.mods.textContent = bar.refs.s1.textContent = bar.refs.s2.textContent = bar.refs.score.textContent = '';
        return;
      }
      bar.el.classList.remove('gap');

      const rank = e.rank;                          // TRUE rank, not the row index
      bar.el.classList.toggle('you', e.isYou);
      bar.el.classList.toggle('leader', settings.showLeader && rank === 1);

      if (e.isYou && rank < bar.prevRank) {
        bar.el.classList.remove('promote'); void bar.el.offsetWidth; bar.el.classList.add('promote');
      }
      bar.prevRank = rank;

      bar.display += (e.score - bar.display) * 0.25;
      if (Math.abs(e.score - bar.display) < 1) bar.display = e.score;
      e.display = bar.display;

      bar.refs.rank.textContent = rank;
      bar.refs.name.textContent = (e.global ? '🌐 ' : '') + e.name;
      bar.refs.mods.textContent = e.mods && normMods(e.mods) ? e.mods : '';
      bar.refs.score.textContent = METRIC[sortBy].fmt(e);
      bar.refs.s1.textContent = subKeys[0] ? METRIC[subKeys[0]].fmt(e) : '';
      bar.refs.s2.textContent = subKeys[1] ? METRIC[subKeys[1]].fmt(e) : '';
    });

    for (const [id, bar] of bars) {
      if (!seen.has(id)) { bar.el.remove(); bars.delete(id); }
    }
    board.style.height = `${entries.length * slot}px`;
  }

  function frame() {
    overlayEl.classList.toggle('paused', state.playing && state.paused);
    render(windowEntries(applyOrder(collectEntries())));
    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);

  // ── Live from tosu ────────────────────────────────────────────────────────────
  function updateYouFromLive(live) {
    const c = live.combo;
    const h = live.hits;
    // The live bar is exactly what tosu reports — your in-game score on whatever
    // scale lazer is currently showing. We DON'T convert it; instead the ghosts
    // are converted to the chosen Scoring scale, so set the overlay's Scoring to
    // match your lazer display and the two line up.
    state.you.score = live.score || 0;
    state.you.ratio = h.n300 > 0 ? h.geki / h.n300 : h.geki;
    state.you.acc = live.acc;
    state.you.combo = c;
    state.you.maxCombo = live.maxCombo || Math.max(state.you.maxCombo, c);
    state.you.mods = live.mods || '';
    state.you.name = live.name || 'You';
    state.paused = !!live.paused;
    state.lastTime = live.time;
    state.lastTimeAt = performance.now();
  }

  function resetYou() {
    Object.assign(state.you, { score: 0, acc: 100, combo: 0, maxCombo: 0, ratio: 0, prevCombo: 0, comboPortion: 0 });
  }

  // ── Messages ──────────────────────────────────────────────────────────────────
  function onMessage(msg) {
    switch (msg.type) {
      case 'ghosts': {
        state.ghosts = msg.ghosts || [];
        const total = msg.totalHits || msg.noteCount || 0;
        state.totalHits = total;
        state.maxComboPortion = maxComboPortionFor(total);
        state.mode = msg.mode != null ? msg.mode : 3;
        state.objectCount = msg.noteCount || 0;
        if (msg.map) titleEl.textContent = msg.map;
        statusEl.textContent = `${state.ghosts.length} ghost${state.ghosts.length === 1 ? '' : 's'} loaded`;
        break;
      }
      case 'clear':
        state.ghosts = []; state.playing = false; state.finished = false; state.paused = false; resetYou();
        break;
      case 'live':
        if (!state.playing || state.finished || msg.restart) { state.playing = true; state.finished = false; resetYou(); }
        updateYouFromLive(msg);
        break;
      case 'status':
        handleStatus(msg);
        break;
    }
  }

  function handleStatus(s) {
    if (s.map) titleEl.textContent = s.map;
    if (s.phase === 'init') {
      titleEl.textContent = 'osu! Pacemaker';
      statusEl.textContent = s.note || 'Initializing…';
    } else if (s.phase === 'loading') {
      statusEl.innerHTML = typeof s.progress === 'number'
        ? `Simulating replays<span class="progress"><i style="width:${Math.round(s.progress * 100)}%"></i></span>`
        : 'Loading map…';
    } else if (s.phase === 'ready') {
      statusEl.textContent = s.ghostCount ? `${s.ghostCount} ghost${s.ghostCount === 1 ? '' : 's'} ready` : 'No local replays for this map';
    } else if (s.phase === 'state') {
      if (s.state !== 2 && state.playing) { state.playing = false; state.paused = false; state.finished = true; }
    }
  }

  // ── Config panel (built from SCHEMA) ──────────────────────────────────────────
  function buildConfig() {
    const body = document.getElementById('config-body');
    body.innerHTML = '';
    for (const item of SCHEMA) {
      if (item.group) {
        const h = document.createElement('div');
        h.className = 'cfg-group-title'; h.textContent = item.group; body.appendChild(h);
        continue;
      }
      const row = document.createElement('div');
      row.className = 'cfg-row';
      const label = document.createElement('label');
      label.textContent = item.label; row.appendChild(label);

      let input, valEl;
      if (item.type === 'select') {
        input = document.createElement('select');
        for (const [v, t] of item.options) { const o = document.createElement('option'); o.value = v; o.textContent = t; input.appendChild(o); }
        input.value = settings[item.key];
        input.onchange = () => { settings[item.key] = input.value; onSettingChanged(item.key); };
      } else if (item.type === 'bool') {
        input = document.createElement('input'); input.type = 'checkbox'; input.checked = !!settings[item.key];
        input.onchange = () => { settings[item.key] = input.checked; onSettingChanged(item.key); };
      } else if (item.type === 'color') {
        input = document.createElement('input'); input.type = 'color'; input.value = settings[item.key];
        input.oninput = () => { settings[item.key] = input.value; onSettingChanged(item.key); };
      } else { // range
        input = document.createElement('input'); input.type = 'range';
        input.min = item.min; input.max = item.max; input.step = item.step; input.value = settings[item.key];
        valEl = document.createElement('span'); valEl.className = 'cfg-val';
        const show = () => { valEl.textContent = `${(+settings[item.key]).toFixed(item.step < 1 ? 2 : 0)}${item.unit || ''}`; };
        show();
        input.oninput = () => { settings[item.key] = +input.value; show(); onSettingChanged(item.key); };
      }
      row.appendChild(input);
      if (valEl) row.appendChild(valEl);
      body.appendChild(row);
    }
  }

  function onSettingChanged(key) {
    if (key === 'sortBy') { state.order = []; state.lastSwap.clear(); }
    if (key === 'includeGlobal' || key === 'globalCount' || key === 'scoring') sendConfig();
    applySettings();
    saveSettings();
  }

  // Tell the backend which optional ghost sources to produce.
  let socket = null;
  function sendConfig() {
    if (socket && socket.readyState === 1) {
      socket.send(JSON.stringify({ type: 'config', includeGlobal: settings.includeGlobal, globalCount: settings.globalCount, scoring: settings.scoring }));
    }
  }

  configBtn.onclick = () => { configPanel.hidden = !configPanel.hidden; };
  document.getElementById('config-close').onclick = () => { configPanel.hidden = true; };
  document.getElementById('config-reset').onclick = () => {
    settings = { ...DEFAULTS, left: settings.left, top: settings.top };
    state.order = []; state.lastSwap.clear();
    buildConfig(); applySettings(); saveSettings();
  };

  // ── Lock / unlock (Electron) + drag + resize ──────────────────────────────────
  const isElectron = /electron/i.test(navigator.userAgent);
  function setUnlocked(on) {
    overlayEl.classList.toggle('unlocked', !!on);
    if (!on) configPanel.hidden = true;
  }
  setUnlocked(!isElectron);
  window.setOverlayUnlocked = setUnlocked;

  function onDrag(handle, onStart, onMove) {
    handle.addEventListener('pointerdown', (e) => {
      if (!overlayEl.classList.contains('unlocked')) return;
      // Don't hijack clicks on controls inside the handle (e.g. the ⚙ gear) —
      // capturing the pointer here would otherwise swallow their click.
      if (e.target.closest('button, input, select, a')) return;
      e.preventDefault();
      handle.setPointerCapture(e.pointerId);
      const start = onStart(e);
      const move = (ev) => onMove(ev, start);
      const up = () => { handle.releasePointerCapture(e.pointerId); handle.removeEventListener('pointermove', move); handle.removeEventListener('pointerup', up); saveSettings(); };
      handle.addEventListener('pointermove', move);
      handle.addEventListener('pointerup', up);
    });
  }
  onDrag(headerEl,
    (e) => ({ px: e.clientX, py: e.clientY, left: settings.left, top: settings.top }),
    (ev, s) => {
      settings.left = Math.max(0, s.left + (ev.clientX - s.px));
      settings.top = Math.max(0, s.top + (ev.clientY - s.py));
      overlayEl.style.left = `${settings.left}px`; overlayEl.style.top = `${settings.top}px`;
    });
  onDrag(resizeHandle,
    (e) => ({ px: e.clientX, py: e.clientY, scale: settings.uiScale }),
    (ev, s) => {
      settings.uiScale = Math.min(3, Math.max(0.4, s.scale + ((ev.clientX - s.px) + (ev.clientY - s.py)) / 360));
      document.documentElement.style.setProperty('--ui-scale', settings.uiScale);
    });

  // Don't let clicks inside the config panel reach drag handlers behind it.
  configPanel.addEventListener('pointerdown', (e) => e.stopPropagation());

  buildConfig();
  applySettings();

  // ── WebSocket with auto-reconnect ──────────────────────────────────────────────
  async function getRelayPort() {
    try { const cfg = await (await fetch('/config.json')).json(); return cfg.relayPort || 7270; }
    catch { return 7270; }
  }
  async function connect() {
    const port = await getRelayPort();
    const url = `ws://${location.hostname || 'localhost'}:${port}`;
    const open = () => {
      const ws = new WebSocket(url);
      socket = ws;
      ws.onopen = () => { connEl.className = 'connected'; connEl.title = 'relay connected'; sendConfig(); };
      ws.onmessage = (ev) => { try { onMessage(JSON.parse(ev.data)); } catch { /* ignore */ } };
      ws.onclose = () => { connEl.className = 'disconnected'; connEl.title = 'relay disconnected — retrying'; setTimeout(open, 1500); };
      ws.onerror = () => ws.close();
    };
    open();
  }
  connect();
})();
