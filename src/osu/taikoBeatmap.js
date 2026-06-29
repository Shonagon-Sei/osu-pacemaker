'use strict';

const fs = require('fs');

/**
 * osu!taiko beatmap parser for the replay judge.
 *
 * Taiko ignores cursor position — only key timing and note colour (don/kat)
 * matter — so this is much lighter than the standard parser. We extract:
 *   - notes: { time, kat, big }   (kat = blue/rim, big = finisher)
 *   - drumrolls + dendens for combo (they don't produce great/good/miss)
 *   - OverallDifficulty for the hit windows.
 */
function parseTaikoBeatmap(filePath) {
  const lines = fs.readFileSync(filePath, 'utf8').split(/\r?\n/);
  let section = '';
  let od = 5, sliderMultiplier = 1.4, sliderTickRate = 1;
  const rawTPs = [], rawObjects = [];
  for (const raw of lines) {
    const line = raw.trim();
    if (!line || line.startsWith('//')) continue;
    if (line.startsWith('[') && line.endsWith(']')) { section = line.slice(1, -1); continue; }
    if (section === 'Difficulty') {
      const i = line.indexOf(':'); if (i === -1) continue;
      const k = line.slice(0, i).trim(), v = parseFloat(line.slice(i + 1).trim());
      if (k === 'OverallDifficulty') od = v;
      else if (k === 'SliderMultiplier') sliderMultiplier = v;
      else if (k === 'SliderTickRate') sliderTickRate = v;
    } else if (section === 'TimingPoints') rawTPs.push(line);
    else if (section === 'HitObjects') rawObjects.push(line);
  }

  const tps = rawTPs.map((l) => { const p = l.split(','); return { time: parseFloat(p[0]), beatLength: parseFloat(p[1]), uninherited: p.length > 6 ? p[6] === '1' : parseFloat(p[1]) > 0 }; }).sort((a, b) => a.time - b.time);
  const beatAt = (t) => { let bl = 500; for (const p of tps) { if (p.uninherited && p.time <= t) bl = p.beatLength; else if (p.time > t) break; } return bl > 0 ? bl : 500; };
  const svAt = (t) => { let sv = 1; for (const p of tps) { if (p.time > t) break; if (!p.uninherited && p.beatLength < 0) sv = Math.max(0.1, Math.min(10, -100 / p.beatLength)); else if (p.uninherited) sv = 1; } return sv; };

  const notes = [];     // { time, kat, big }
  const drumTicks = []; // { time }  (combo-only)
  const dendens = [];   // { time, endTime }

  for (const line of rawObjects) {
    const p = line.split(',');
    if (p.length < 5) continue;
    const time = parseInt(p[2], 10), type = parseInt(p[3], 10), hs = parseInt(p[4], 10) || 0;
    if (!Number.isFinite(time)) continue;
    if (type & 1) { // note: kat if whistle(2) or clap(8); big if finish(4)
      notes.push({ time, kat: (hs & 2) !== 0 || (hs & 8) !== 0, big: (hs & 4) !== 0 });
    } else if (type & 2 && p.length >= 8) { // drum roll
      const pixelLength = parseFloat(p[7]) || 0;
      const slides = Math.max(1, parseInt(p[6], 10) || 1);
      const beat = beatAt(time), sv = svAt(time);
      const pxPerBeat = sliderMultiplier * 100 * sv;
      const duration = pxPerBeat > 0 ? (pixelLength / pxPerBeat) * beat * slides : 0;
      // Taiko drum-roll ticks: one per (beat / tickRate / velocity) — approximate.
      const tickSpacing = beat / sliderTickRate * (sv >= 1 ? 1 : 1);
      for (let t = time; t <= time + duration + 1e-3; t += Math.max(20, tickSpacing)) drumTicks.push({ time: t });
    } else if (type & 8) { // denden (spinner)
      dendens.push({ time, endTime: parseInt(p[5], 10) || time });
    }
  }
  notes.sort((a, b) => a.time - b.time);

  return { od, notes, drumTicks, dendens };
}

module.exports = { parseTaikoBeatmap };
