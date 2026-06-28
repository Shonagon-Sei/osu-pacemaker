'use strict';

const fs = require('fs');

/**
 * Full osu!standard beatmap geometry parser for the replay judge.
 *
 * Unlike the lightweight mania parser, this resolves everything the gameplay
 * judge needs: object positions, hit windows (via OD), object radius (via CS),
 * timing points (BPM + slider-velocity), and full slider geometry — the curve
 * path plus the times/positions of the head, ticks, repeats, and tail (the
 * "nested" scoring objects). Spinners get their start/end and required spins.
 *
 * Rate-changing mods (DT/HT) are NOT baked into the times here; the judge keeps
 * everything in song-time and reconciles the replay clock separately.
 */

// ── linear algebra helpers ─────────────────────────────────────────────────────
const sub = (a, b) => ({ x: a.x - b.x, y: a.y - b.y });
const add = (a, b) => ({ x: a.x + b.x, y: a.y + b.y });
const mul = (a, s) => ({ x: a.x * s, y: a.y * s });
const len = (a) => Math.hypot(a.x, a.y);
const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);

// ── slider curve sampling ───────────────────────────────────────────────────────
function bezierSegment(points, out) {
  // Adaptive-ish flattening: sample N points proportional to the control hull length.
  const steps = Math.max(8, Math.ceil(controlLength(points) / 5));
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    out.push(deCasteljau(points, t));
  }
}
function controlLength(points) {
  let l = 0;
  for (let i = 1; i < points.length; i++) l += dist(points[i - 1], points[i]);
  return l;
}
function deCasteljau(points, t) {
  let pts = points.slice();
  while (pts.length > 1) {
    const next = [];
    for (let i = 0; i < pts.length - 1; i++) next.push(add(mul(pts[i], 1 - t), mul(pts[i + 1], t)));
    pts = next;
  }
  return pts[0];
}

function perfectCircle(p0, p1, p2) {
  // Circle through three points; returns a polyline arc p0->p2 through p1.
  const a = dist(p1, p2), b = dist(p0, p2), c = dist(p0, p1);
  const a2 = a * a, b2 = b * b, c2 = c * c;
  const s = a2 * (b2 + c2 - a2) + b2 * (a2 + c2 - b2) + c2 * (a2 + b2 - c2);
  if (Math.abs(s) < 1e-6) return null; // collinear -> caller falls back to linear
  const center = {
    x: (a2 * (b2 + c2 - a2) * p0.x + b2 * (a2 + c2 - b2) * p1.x + c2 * (a2 + b2 - c2) * p2.x) / s,
    y: (a2 * (b2 + c2 - a2) * p0.y + b2 * (a2 + c2 - b2) * p1.y + c2 * (a2 + b2 - c2) * p2.y) / s,
  };
  const r = dist(center, p0);
  const ang = (p) => Math.atan2(p.y - center.y, p.x - center.x);
  let a0 = ang(p0), a1 = ang(p1), a2e = ang(p2);
  // direction: does p1 lie on the CCW or CW arc from p0 to p2
  const cross = (p1.x - p0.x) * (p2.y - p0.y) - (p1.y - p0.y) * (p2.x - p0.x);
  const out = [];
  const TAU = Math.PI * 2;
  if (cross < 0) { // clockwise
    if (a1 > a0) a1 -= TAU;
    if (a2e > a0) a2e -= TAU;
  } else { // counter-clockwise
    if (a1 < a0) a1 += TAU;
    if (a2e < a0) a2e += TAU;
  }
  const arc = a2e - a0;
  const steps = Math.max(8, Math.ceil(Math.abs(arc) * r / 5));
  for (let i = 0; i <= steps; i++) {
    const t = a0 + arc * (i / steps);
    out.push({ x: center.x + r * Math.cos(t), y: center.y + r * Math.sin(t) });
  }
  return out;
}

/** Build a flattened, arc-length-parameterised path capped at `pixelLength`. */
function buildSliderPath(type, points, pixelLength) {
  let poly = [];
  if (type === 'L') {
    poly = points.slice();
  } else if (type === 'P' && points.length === 3) {
    const arc = perfectCircle(points[0], points[1], points[2]);
    poly = arc || points.slice();
  } else {
    // Bezier (B) / Catmull (C, treated as bezier-ish): split on duplicate anchors.
    let seg = [points[0]];
    for (let i = 1; i < points.length; i++) {
      seg.push(points[i]);
      const isAnchor = i < points.length - 1 && points[i].x === points[i + 1].x && points[i].y === points[i + 1].y;
      if (isAnchor || i === points.length - 1) {
        if (seg.length === 1) { /* skip */ }
        else if (seg.length === 2) poly.push(seg[0], seg[1]);
        else bezierSegment(seg, poly);
        seg = [points[i]];
      }
    }
  }
  // Cumulative arc length; then truncate / interpolate to exactly pixelLength.
  const cum = [0];
  for (let i = 1; i < poly.length; i++) cum.push(cum[i - 1] + dist(poly[i - 1], poly[i]));
  const total = cum[cum.length - 1] || 0;
  const target = Math.min(pixelLength, total);
  // positionAt(d): point at distance d along the (truncated) path.
  const positionAt = (d) => {
    d = Math.max(0, Math.min(target, d));
    if (poly.length === 1) return poly[0];
    let lo = 0, hi = cum.length - 1;
    while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (cum[mid] <= d) lo = mid; else hi = mid; }
    const segLen = cum[hi] - cum[lo] || 1;
    const f = (d - cum[lo]) / segLen;
    return add(mul(poly[lo], 1 - f), mul(poly[hi], f));
  };
  return { positionAt, length: target };
}

// ── timing points ──────────────────────────────────────────────────────────────
function buildTiming(rawTPs) {
  const pts = rawTPs.map((l) => {
    const p = l.split(',');
    return { time: parseFloat(p[0]), beatLength: parseFloat(p[1]), uninherited: p.length > 6 ? p[6] === '1' : parseFloat(p[1]) > 0 };
  }).sort((a, b) => a.time - b.time);
  return {
    // Beat length (ms/beat) from the active uninherited point.
    beatAt(t) {
      let bl = 500;
      for (const p of pts) { if (p.uninherited && p.time <= t) bl = p.beatLength; else if (p.time > t) break; }
      return bl > 0 ? bl : 500;
    },
    // Slider-velocity multiplier from the active inherited point (-100/beatLength).
    svAt(t) {
      let sv = 1;
      for (const p of pts) {
        if (p.time > t) break;
        if (!p.uninherited && p.beatLength < 0) sv = Math.max(0.1, Math.min(10, -100 / p.beatLength));
        else if (p.uninherited) sv = 1; // reset on a new BPM section
      }
      return sv;
    },
  };
}

/** Parse a .osu (assumed osu!standard) into geometry the judge consumes. */
function parseStdBeatmap(filePath) {
  const lines = fs.readFileSync(filePath, 'utf8').split(/\r?\n/);
  let section = '';
  const D = { CircleSize: 5, OverallDifficulty: 5, ApproachRate: null, SliderMultiplier: 1.4, SliderTickRate: 1 };
  let stackLeniency = 0.7;
  const rawObjects = [];
  const rawTPs = [];

  for (const raw of lines) {
    const line = raw.trim();
    if (!line || line.startsWith('//')) continue;
    if (line.startsWith('[') && line.endsWith(']')) { section = line.slice(1, -1); continue; }
    if (section === 'General' || section === 'Difficulty') {
      const i = line.indexOf(':'); if (i === -1) continue;
      const k = line.slice(0, i).trim(); const v = line.slice(i + 1).trim();
      if (k === 'StackLeniency') stackLeniency = parseFloat(v);
      else if (k in D) D[k] = parseFloat(v);
    } else if (section === 'TimingPoints') rawTPs.push(line);
    else if (section === 'HitObjects') rawObjects.push(line);
  }
  if (D.ApproachRate == null) D.ApproachRate = D.OverallDifficulty;

  const timing = buildTiming(rawTPs);
  const radius = 54.4 - 4.48 * D.CircleSize; // osu! px
  const objects = [];

  for (const line of rawObjects) {
    const p = line.split(',');
    if (p.length < 4) continue;
    const x = parseFloat(p[0]), y = parseFloat(p[1]), time = parseInt(p[2], 10), type = parseInt(p[3], 10);
    if (!Number.isFinite(time)) continue;

    if (type & 1) { // circle
      objects.push({ kind: 'circle', time, pos: { x, y } });
    } else if (type & 2 && p.length >= 8) { // slider
      const curve = p[5].split('|');
      const ctype = curve[0];
      const points = [{ x, y }];
      for (let i = 1; i < curve.length; i++) { const c = curve[i].split(':'); points.push({ x: parseFloat(c[0]), y: parseFloat(c[1]) }); }
      const slides = Math.max(1, parseInt(p[6], 10) || 1);
      const pixelLength = parseFloat(p[7]) || 0;
      const path = buildSliderPath(ctype, points, pixelLength);
      const beat = timing.beatAt(time);
      const sv = timing.svAt(time);
      const pxPerBeat = D.SliderMultiplier * 100 * sv;
      const spanDuration = pxPerBeat > 0 ? (path.length / pxPerBeat) * beat : 0;
      const duration = spanDuration * slides;
      const endTime = time + duration;

      // Nested scoring objects: head, ticks (per span), repeats, tail.
      const nested = [{ kind: 'head', time, pos: path.positionAt(0) }];
      const tickDist = pxPerBeat / D.SliderTickRate; // px between ticks
      const tickOffsets = [];
      if (tickDist > 0) for (let d = tickDist; d < path.length - 1e-2; d += tickDist) tickOffsets.push(d);
      for (let span = 0; span < slides; span++) {
        const spanStart = time + span * spanDuration;
        const reverse = span % 2 === 1;
        for (const d of tickOffsets) {
          const along = reverse ? path.length - d : d;
          const f = d / path.length;
          nested.push({ kind: 'tick', time: spanStart + (reverse ? (1 - f) : f) * spanDuration, pos: path.positionAt(along) });
        }
        if (span < slides - 1) {
          // repeat point at the far end of this span
          nested.push({ kind: 'repeat', time: time + (span + 1) * spanDuration, pos: path.positionAt(reverse ? 0 : path.length) });
        }
      }
      nested.push({ kind: 'tail', time: endTime, pos: path.positionAt(slides % 2 === 1 ? path.length : 0) });
      nested.sort((a, b) => a.time - b.time);

      objects.push({ kind: 'slider', time, endTime, pos: { x, y }, path, slides, nested });
    } else if (type & 8) { // spinner
      const endTime = parseInt(p[5], 10) || time;
      objects.push({ kind: 'spinner', time, endTime, pos: { x: 256, y: 192 } });
    }
  }

  objects.sort((a, b) => a.time - b.time);
  return {
    cs: D.CircleSize, od: D.OverallDifficulty, ar: D.ApproachRate,
    sliderMultiplier: D.SliderMultiplier, sliderTickRate: D.SliderTickRate, stackLeniency,
    radius, objects,
  };
}

module.exports = { parseStdBeatmap };
