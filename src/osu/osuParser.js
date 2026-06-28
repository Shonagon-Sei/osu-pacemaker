'use strict';

const fs = require('fs');

/**
 * Parse a .osu beatmap file for the data the mania simulator needs:
 *   - key count (CircleSize)
 *   - Overall Difficulty (drives hit windows)
 *   - hit objects: { time, column, endTime|null }  (endTime set for long notes)
 *
 * Column is derived the way stable mania does it:
 *   column = floor(x * keyCount / 512), clamped to [0, keyCount-1].
 */
function parseBeatmap(filePath) {
  const text = fs.readFileSync(filePath, 'utf8');
  const lines = text.split(/\r?\n/);

  let section = '';
  let overallDifficulty = 5;
  let circleSize = 4;
  let mode = 0;
  let title = '';
  let version = '';
  const rawObjects = [];

  for (let raw of lines) {
    const line = raw.trim();
    if (!line || line.startsWith('//')) continue;

    if (line.startsWith('[') && line.endsWith(']')) {
      section = line.slice(1, -1);
      continue;
    }

    if (section === 'General' || section === 'Metadata' || section === 'Difficulty') {
      const idx = line.indexOf(':');
      if (idx === -1) continue;
      const key = line.slice(0, idx).trim();
      const val = line.slice(idx + 1).trim();
      switch (key) {
        case 'Mode': mode = parseInt(val, 10) || 0; break;
        case 'OverallDifficulty': overallDifficulty = parseFloat(val); break;
        case 'CircleSize': circleSize = parseFloat(val); break;
        case 'Title': title = val; break;
        case 'Version': version = val; break;
        default: break;
      }
    } else if (section === 'HitObjects') {
      rawObjects.push(line);
    }
  }

  const keyCount = Math.max(1, Math.round(circleSize));
  const objects = [];

  for (const line of rawObjects) {
    const p = line.split(',');
    if (p.length < 4) continue;
    const x = parseInt(p[0], 10);
    const time = parseInt(p[2], 10);
    const type = parseInt(p[3], 10);
    if (!Number.isFinite(time)) continue;

    let column = Math.floor((x * keyCount) / 512);
    if (column < 0) column = 0;
    if (column > keyCount - 1) column = keyCount - 1;

    // type bit 7 (128) = mania hold note; endTime is the first ':'-delimited token of the last param
    let endTime = null;
    if (type & 128 && p.length >= 6) {
      const endRaw = p[5].split(':')[0];
      const e = parseInt(endRaw, 10);
      if (Number.isFinite(e) && e > time) endTime = e;
    }

    objects.push({ time, column, endTime });
  }

  objects.sort((a, b) => a.time - b.time);

  const holdCount = objects.reduce((n, o) => n + (o.endTime != null ? 1 : 0), 0);

  return {
    mode,
    title,
    version,
    keyCount,
    overallDifficulty,
    noteCount: objects.length,
    holdCount,
    // Judgement/combo total the way lazer counts mania: every long note scores
    // its head AND its tail, so a hold is worth 2.
    totalHits: objects.length + holdCount,
    objects,
  };
}

/**
 * Parse the break periods from a beatmap's [Events] section.
 * Break lines look like `2,startTime,endTime` (the leading `2` — or `Break` —
 * marks an event of type break). Times are in song-time ms, so they line up with
 * the overlay's playhead regardless of rate-changing mods.
 */
function parseBreaks(filePath) {
  let text;
  try { text = fs.readFileSync(filePath, 'utf8'); } catch { return []; }
  const lines = text.split(/\r?\n/);
  const breaks = [];
  let inEvents = false;
  for (const raw of lines) {
    const line = raw.trim();
    if (line.startsWith('[') && line.endsWith(']')) { inEvents = line === '[Events]'; continue; }
    if (!inEvents || !line || line.startsWith('//')) continue;
    const p = line.split(',');
    if (p[0] !== '2' && p[0] !== 'Break') continue;
    const start = parseInt(p[1], 10), end = parseInt(p[2], 10);
    if (Number.isFinite(start) && Number.isFinite(end) && end > start) breaks.push({ start, end });
  }
  breaks.sort((a, b) => a.start - b.start);
  return breaks;
}

module.exports = { parseBeatmap, parseBreaks };
