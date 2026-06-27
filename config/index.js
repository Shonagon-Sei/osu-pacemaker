'use strict';

const path = require('path');
const os = require('os');
const fs = require('fs');

require('dotenv').config();

// Build-time values baked into a packaged app (proxy URL etc.), written by
// scripts/build-config.js. Absent in dev (we use .env there). Never committed.
let runtime = {};
try { runtime = require('./runtime.json'); } catch { /* dev: no baked config */ }

function bool(v, dflt) {
  if (v === undefined) return dflt;
  return /^(1|true|yes|on)$/i.test(String(v).trim());
}

function int(v, dflt) {
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? n : dflt;
}

const LOCALAPPDATA = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
const APPDATA = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');

// ── Install locations ────────────────────────────────────────────────────────
// Stable keeps replays as Data\r\*.osr; lazer keeps them inside a
// content-addressable `files\` store described by client.realm.
const stableRoot = (process.env.OSU_STABLE_ROOT || process.env.OSU_ROOT || path.join(LOCALAPPDATA, 'osu!')).trim();
const lazerRoot = (process.env.OSU_LAZER_ROOT || path.join(APPDATA, 'osu')).trim();

// auto (default) | stable | lazer  — which install(s) to index.
const mode = (process.env.OSU_MODE || 'auto').toLowerCase();

function looksLikeStable(root) {
  return fs.existsSync(path.join(root, 'Data', 'r'));
}
function looksLikeLazer(root) {
  return fs.existsSync(path.join(root, 'client.realm')) || fs.existsSync(path.join(root, 'files'));
}

const sources = [];
if ((mode === 'auto' || mode === 'stable') && looksLikeStable(stableRoot)) {
  sources.push({ type: 'stable', root: stableRoot, replayDir: path.join(stableRoot, 'Data', 'r') });
}
if ((mode === 'auto' || mode === 'lazer') && looksLikeLazer(lazerRoot)) {
  sources.push({ type: 'lazer', root: lazerRoot, filesDir: path.join(lazerRoot, 'files') });
}

const cpuCount = os.cpus().length || 2;
const requestedWorkers = int(process.env.SIM_WORKERS, 0);

const config = {
  mode,
  stableRoot,
  lazerRoot,
  sources,

  gosuUrl: undefined, // (legacy field removed)
  tosuUrl: process.env.TOSU_URL || process.env.GOSU_URL || 'ws://127.0.0.1:24050/websocket/v2',
  relayPort: int(process.env.RELAY_PORT, 7270),
  httpPort: int(process.env.HTTP_PORT, 7271),

  simStepMs: int(process.env.SIM_STEP_MS, 100),
  simWorkers: requestedWorkers > 0 ? requestedWorkers : Math.max(1, cpuCount - 1),
  maxGhosts: int(process.env.MAX_GHOSTS, 7),
  watchReplays: bool(process.env.WATCH_REPLAYS, true),

  // Global ghosts: preferred path is a proxy URL (holds the secret server-side).
  // Direct client_credentials are a dev/own-key fallback.
  proxyUrl: (process.env.OSU_PROXY_URL || runtime.proxyUrl || '').trim(),
  osuApi: {
    clientId: (process.env.OSU_API_CLIENT_ID || runtime.clientId || '').trim(),
    clientSecret: (process.env.OSU_API_CLIENT_SECRET || runtime.clientSecret || '').trim(),
  },
  globalCount: int(process.env.OSU_GLOBAL_COUNT, 50),

  cacheDir: path.join(__dirname, '..', '.cache'),
};

config.indexCacheFile = path.join(config.cacheDir, 'replay-index.json');
config.apiEnabled = !!(config.proxyUrl || (config.osuApi.clientId && config.osuApi.clientSecret));

// Human-readable summary of what we'll index, e.g. "lazer (C:\…\osu)".
config.sourceSummary = sources.length
  ? sources.map((s) => `${s.type} (${s.root})`).join(', ')
  : '(none detected)';

function validate() {
  const problems = [];
  if (sources.length === 0) {
    problems.push(
      `No osu! install detected.\n` +
      `         Checked stable: ${stableRoot}  (needs Data\\r)\n` +
      `         Checked lazer:  ${lazerRoot}  (needs client.realm / files)\n` +
      `         Set OSU_STABLE_ROOT or OSU_LAZER_ROOT in .env to point at yours.`
    );
  }
  return problems;
}

module.exports = { config, validate };
