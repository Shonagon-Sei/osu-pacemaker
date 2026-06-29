'use strict';

const fs = require('fs');
const { buildSliderPath, buildTiming } = require('./stdBeatmap');

/**
 * osu!catch beatmap parser for the replay judge.
 *
 * Catch is one-dimensional: only the X of each catchable object matters, plus
 * the time it reaches the catcher. We expand the map into the same nested
 * objects osu! generates:
 *   - fruit         (circle, slider head/repeat/tail)  -> "Great", breaks combo if missed
 *   - droplet       (slider tick)                       -> "Large droplet", breaks combo if missed
 *   - tinyDroplet   (dense filler along the path)       -> "Small droplet", does NOT break combo
 * Bananas (spinners) are bonus and ignored for accuracy.
 *
 * The juice-stream nesting follows osu!: ticks at `tickDistance`, fruits at span
 * ends, and tiny droplets spaced by halving the gap until under ~100ms.
 */
function parseCatchBeatmap(filePath) {
  const lines = fs.readFileSync(filePath, 'utf8').split(/\r?\n/);
  let section = '';
  const D = { CircleSize: 5, SliderMultiplier: 1.4, SliderTickRate: 1 };
  const rawTPs = [], rawObjects = [];
  for (const raw of lines) {
    const line = raw.trim();
    if (!line || line.startsWith('//')) continue;
    if (line.startsWith('[') && line.endsWith(']')) { section = line.slice(1, -1); continue; }
    if (section === 'Difficulty') { const i = line.indexOf(':'); if (i >= 0) { const k = line.slice(0, i).trim(); if (k in D) D[k] = parseFloat(line.slice(i + 1).trim()); } }
    else if (section === 'TimingPoints') rawTPs.push(line);
    else if (section === 'HitObjects') rawObjects.push(line);
  }

  const timing = buildTiming(rawTPs);
  const objects = []; // { kind:'fruit'|'droplet'|'tiny', time, x }

  for (const line of rawObjects) {
    const p = line.split(',');
    if (p.length < 4) continue;
    const x = parseFloat(p[0]), time = parseInt(p[2], 10), type = parseInt(p[3], 10);
    if (!Number.isFinite(time)) continue;

    if (type & 1) { // circle -> fruit
      objects.push({ kind: 'fruit', time, x });
    } else if (type & 2 && p.length >= 8) { // juice stream
      const curve = p[5].split('|');
      const points = [{ x, y: parseFloat(p[1]) }];
      for (let i = 1; i < curve.length; i++) { const c = curve[i].split(':'); points.push({ x: parseFloat(c[0]), y: parseFloat(c[1]) }); }
      const slides = Math.max(1, parseInt(p[6], 10) || 1);
      const pixelLength = parseFloat(p[7]) || 0;
      const path = buildSliderPath(curve[0], points, pixelLength);
      const len = path.length;
      const beat = timing.beatAt(time), sv = timing.svAt(time);
      const velocity = (D.SliderMultiplier * 100 * sv) / beat; // px per ms
      const spanDuration = velocity > 0 ? len / velocity : 0;
      const tickDistance = D.SliderTickRate > 0 ? (D.SliderMultiplier * 100 * sv) / D.SliderTickRate : len;
      const xAt = (d) => path.positionAt(Math.max(0, Math.min(len, d))).x;

      // Ordered span events (fruits + ticks), then tiny droplets fill the gaps.
      const events = [{ kind: 'fruit', time, x: xAt(0) }]; // head
      for (let span = 0; span < slides; span++) {
        const spanStart = time + span * spanDuration;
        const reversed = span % 2 === 1;
        for (let d = tickDistance; d < len - tickDistance / 8; d += tickDistance) {
          const prog = d / len;
          events.push({ kind: 'droplet', time: spanStart + (reversed ? 1 - prog : prog) * spanDuration, x: xAt(reversed ? len - d : d) });
        }
        const endX = xAt((reversed ? 0 : len)); // far end of this span
        events.push({ kind: 'fruit', time: spanStart + spanDuration, x: endX }); // repeat or tail
      }
      events.sort((a, b) => a.time - b.time);

      // Tiny droplets between consecutive events.
      for (let i = 0; i < events.length; i++) {
        objects.push(events[i]);
        if (i + 1 < events.length) {
          const a = events[i], b = events[i + 1];
          const gap = b.time - a.time;
          if (gap > 80) {
            let step = gap;
            while (step > 100) step /= 2;
            for (let t = step; t < gap - 1e-3; t += step) {
              const f = t / gap;
              objects.push({ kind: 'tiny', time: a.time + t, x: a.x + (b.x - a.x) * f });
            }
          }
        }
      }
    } // spinners (type & 8) -> bananas, bonus, ignored
  }

  objects.sort((a, b) => a.time - b.time);
  return { cs: D.CircleSize, objects };
}

module.exports = { parseCatchBeatmap };
