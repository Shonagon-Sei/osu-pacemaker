/**
 * osu-pacemaker leaderboard proxy (Cloudflare Worker).
 *
 * Holds the osu! API client_credentials secret server-side so the distributed
 * app never ships it. The app calls:
 *     GET <worker-url>/leaderboard?beatmap=<id>&mode=<osu|taiko|fruits|mania>&limit=<1-100>
 * and gets back osu!'s leaderboard JSON verbatim (modern x-api-version shape).
 *
 * Set secrets once:
 *   wrangler secret put OSU_CLIENT_ID
 *   wrangler secret put OSU_CLIENT_SECRET
 */

let cachedToken = null;
let cachedExpiry = 0;

async function getToken(env) {
  if (cachedToken && Date.now() < cachedExpiry - 60_000) return cachedToken;
  const r = await fetch('https://osu.ppy.sh/oauth/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({
      client_id: Number(env.OSU_CLIENT_ID),
      client_secret: env.OSU_CLIENT_SECRET,
      grant_type: 'client_credentials',
      scope: 'public',
    }),
  });
  if (!r.ok) throw new Error(`token ${r.status}`);
  const j = await r.json();
  cachedToken = j.access_token;
  cachedExpiry = Date.now() + (j.expires_in || 3600) * 1000;
  return cachedToken;
}

const CORS = { 'access-control-allow-origin': '*', 'access-control-allow-methods': 'GET, OPTIONS' };

export default {
  async fetch(req, env) {
    if (req.method === 'OPTIONS') return new Response(null, { headers: CORS });
    const url = new URL(req.url);
    if (url.pathname !== '/leaderboard') return new Response('not found', { status: 404, headers: CORS });

    const beatmap = url.searchParams.get('beatmap');
    if (!beatmap || !/^\d+$/.test(beatmap)) return json({ error: 'bad beatmap' }, 400);
    const mode = (url.searchParams.get('mode') || 'osu').replace(/[^a-z]/g, '');
    const limit = Math.max(1, Math.min(100, parseInt(url.searchParams.get('limit') || '50', 10)));

    try {
      const token = await getToken(env);
      const r = await fetch(
        `https://osu.ppy.sh/api/v2/beatmaps/${beatmap}/scores?mode=${mode}&limit=${limit}`,
        { headers: { Authorization: `Bearer ${token}`, 'x-api-version': '20240529', Accept: 'application/json' } }
      );
      const body = await r.text();
      return new Response(body, { status: r.status, headers: { 'content-type': 'application/json', ...CORS } });
    } catch (e) {
      return json({ error: String(e.message || e) }, 502);
    }
  },
};

function json(obj, status) {
  return new Response(JSON.stringify(obj), { status, headers: { 'content-type': 'application/json', ...CORS } });
}
