'use strict';

const fs = require('fs');
const log = require('../util/logger');

/**
 * Minimal osu! API v2 client (guest / client_credentials grant).
 *
 * Verified capabilities with a client_credentials token (no user login needed):
 *   - GET /api/v2/beatmaps/{id}/scores      -> global top 50 (exact score/acc/
 *                                              combo/statistics/mods)
 *   - GET /api/v2/scores/{mode}/{id}/download -> the .osr (mode-prefixed form)
 *
 * We only need the leaderboard for exact final stats; replay download is exposed
 * for future use (accurate race curves) but not required.
 */

const MODE_STR = ['osu', 'taiko', 'fruits', 'mania'];
function modeStr(n) { return MODE_STR[n] || 'osu'; }

let token = null;
let tokenExpiresAt = 0;

async function getToken(cfg) {
  if (token && Date.now() < tokenExpiresAt - 60_000) return token;
  const r = await fetch('https://osu.ppy.sh/oauth/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({
      client_id: Number(cfg.osuApi.clientId),
      client_secret: cfg.osuApi.clientSecret,
      grant_type: 'client_credentials',
      scope: 'public',
    }),
  });
  if (!r.ok) throw new Error(`osu! token request failed (${r.status})`);
  const j = await r.json();
  if (!j.access_token) throw new Error('osu! token response had no access_token');
  token = j.access_token;
  tokenExpiresAt = Date.now() + (j.expires_in || 3600) * 1000;
  return token;
}

// Max scores the leaderboard endpoint will return.
const MAX_LIMIT = 100;

/**
 * Fetch the global leaderboard for a beatmap (up to 100 with the modern API).
 *
 * We send `x-api-version` so scores come back in the modern "solo_score" shape,
 * which gives `total_score` — the STANDARDISED (ScoreV2) value osu! ranks by,
 * consistent across all modes and Classic-mod scores. (The legacy `score` field
 * is raw ScoreV1: ~1M for mania but 100M+ for std, and unusable for a mixed
 * board.) `classic_total_score` is also captured for the optional Classic view.
 */
async function fetchLeaderboard(cfg, beatmapId, mode, limit) {
  const n = Math.max(1, Math.min(MAX_LIMIT, limit || 50));
  let r;
  if (cfg.proxyUrl) {
    // Proxy holds the secret server-side; the app only knows the public URL.
    const base = cfg.proxyUrl.replace(/\/+$/, '');
    r = await fetch(`${base}/leaderboard?beatmap=${beatmapId}&mode=${modeStr(mode)}&limit=${n}`, {
      headers: { Accept: 'application/json' },
    });
  } else {
    // Direct (dev / your-own-key): needs client_credentials in config.
    const t = await getToken(cfg);
    r = await fetch(
      `https://osu.ppy.sh/api/v2/beatmaps/${beatmapId}/scores?mode=${modeStr(mode)}&limit=${n}`,
      { headers: { Authorization: `Bearer ${t}`, Accept: 'application/json', 'x-api-version': '20240529' } }
    );
  }
  if (!r.ok) throw new Error(`leaderboard request failed (${r.status})`);
  const j = await r.json();
  const scores = j.scores || [];
  return scores.map((s) => {
    const st = s.statistics || {};
    const mods = (s.mods || []).map((m) => (typeof m === 'string' ? m : m.acronym)).filter(Boolean);
    return {
      scoreId: s.id,
      legacyScoreId: s.legacy_score_id || s.best_id || s.id,
      mode: s.mode || modeStr(mode),
      player: (s.user && s.user.username) || 'Player',
      countryCode: s.user && s.user.country_code,
      score: s.total_score ?? s.score ?? 0,            // standardised (ScoreV2)
      classicScore: s.classic_total_score ?? s.legacy_total_score ?? 0, // ScoreV1
      accuracy: s.accuracy ?? 1,                        // 0..1 (exact, mode-agnostic)
      maxCombo: s.max_combo ?? 0,
      mods: mods.join(''),                              // e.g. "HDHRCL"
      hasReplay: !!(s.has_replay ?? s.replay),
      // Modern mania statistics keys (for the Perfect:Great ratio display).
      counts: {
        max: st.perfect || 0,                          // MAX / rainbow 300
        n300: st.great || 0,
        n200: st.good || 0,
        n100: st.ok || 0,
        n50: st.meh || 0,
        miss: st.miss || 0,
      },
    };
  });
}

/** Download a replay .osr to `dest` (cached by caller). Returns dest on success. */
async function downloadReplay(cfg, mode, scoreId, dest) {
  const t = await getToken(cfg);
  const url = `https://osu.ppy.sh/api/v2/scores/${modeStr(mode)}/${scoreId}/download`;
  const r = await fetch(url, { headers: { Authorization: `Bearer ${t}` } });
  if (!r.ok) throw new Error(`replay download failed (${r.status})`);
  const buf = Buffer.from(await r.arrayBuffer());
  if (buf.length < 16 || buf.readUInt8(0) > 3) throw new Error('downloaded file is not a replay');
  fs.writeFileSync(dest, buf);
  return dest;
}

module.exports = { getToken, fetchLeaderboard, downloadReplay, modeStr };
