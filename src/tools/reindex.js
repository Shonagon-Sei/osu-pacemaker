'use strict';

// Standalone: force a full rebuild of the replay index and print a summary.
// Useful for verifying your install paths are correct before running the overlay.
const { config, validate } = require('../../config');
const { ReplayIndex } = require('../osu/replayIndex');
const log = require('../util/logger');

(async () => {
  log.info('Indexing source(s):', config.sourceSummary);
  for (const p of validate()) log.warn(p);
  const index = new ReplayIndex(config);
  await index.build();

  // Show the maps with the most replays — good candidates to test the overlay on.
  const rows = [...index.byMd5.entries()]
    .map(([md5, list]) => ({ md5, count: list.length }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 10);

  log.info('Top maps by replay count:');
  for (const r of rows) console.log(`  ${r.count.toString().padStart(4)}  ${r.md5}`);
})();
