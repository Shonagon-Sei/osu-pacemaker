'use strict';

// Bakes deploy-specific, non-source values into config/runtime.json so the
// packaged app works without a .env. Run automatically before `npm run dist`.
//
// Only the PROXY URL is needed for the recommended setup (the secret lives in
// the Worker, never in the app). If you instead embed your own key directly,
// OSU_API_CLIENT_ID/SECRET are baked too — but note they're extractable from
// the build. runtime.json is gitignored.

const fs = require('fs');
const path = require('path');
require('dotenv').config();

const out = {};
const proxy = (process.env.OSU_PROXY_URL || '').trim();

if (proxy) {
  // Recommended path: bake ONLY the public proxy URL. The secret stays in the
  // Worker and never ships in the build.
  out.proxyUrl = proxy;
} else if (process.env.OSU_API_CLIENT_ID && process.env.OSU_API_CLIENT_SECRET) {
  // Fallback: embed the key directly. WARNING — this is extractable from the .exe.
  // Set OSU_PROXY_URL instead to avoid shipping the secret.
  out.clientId = process.env.OSU_API_CLIENT_ID.trim();
  out.clientSecret = process.env.OSU_API_CLIENT_SECRET.trim();
}

const dest = path.join(__dirname, '..', 'config', 'runtime.json');
fs.writeFileSync(dest, JSON.stringify(out, null, 2));

if (out.proxyUrl) console.log(`build-config: baked proxy URL ${out.proxyUrl} (secret stays server-side ✓)`);
else if (out.clientId) console.warn('build-config: WARNING — embedding the osu! API key in the build (extractable). Set OSU_PROXY_URL to use the proxy instead.');
else console.log('build-config: no global config (global ghosts disabled in this build)');
