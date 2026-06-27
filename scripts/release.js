'use strict';

// Release wrapper: loads .env (so GH_TOKEN / OSU_PROXY_URL can live there),
// bakes the runtime config + icons, then runs electron-builder with --publish.
// Child processes inherit process.env, so electron-builder sees GH_TOKEN.

require('dotenv').config();
const { execSync } = require('child_process');

if (!process.env.GH_TOKEN && !process.env.GITHUB_TOKEN) {
  console.error('\n  ✗ No GitHub token found.');
  console.error('    Add GH_TOKEN=ghp_... to your .env (gitignored), or set it in the shell:');
  console.error('      PowerShell:  $env:GH_TOKEN = "ghp_..."');
  console.error('    Token needs the "public_repo" scope (classic) or Contents: Read/Write (fine-grained).\n');
  process.exit(1);
}

const run = (cmd) => execSync(cmd, { stdio: 'inherit', env: process.env });
run('node scripts/build-config.js');
run('node scripts/gen-icon.js');
run('npx electron-builder --publish always');
