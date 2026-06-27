'use strict';

// osu! mod bitflags (the subset that affects mania timing / hit windows).
const MODS = {
  NoFail: 1 << 0,
  Easy: 1 << 1,
  Hidden: 1 << 3,
  HardRock: 1 << 4,
  DoubleTime: 1 << 6,
  HalfTime: 1 << 8,
  Nightcore: 1 << 9, // implies DoubleTime
  FadeIn: 1 << 20,
};

/**
 * Playback rate multiplier from a mods bitmask.
 * Replays are recorded in *real* elapsed time, while .osu note times are in
 * *song* time. We reconcile the two by converting press times to song time
 * (pressSongTime = pressRealTime * rate). DT/NC = 1.5x, HT = 0.75x.
 */
function rateFromMods(mods) {
  if (mods & (MODS.DoubleTime | MODS.Nightcore)) return 1.5;
  if (mods & MODS.HalfTime) return 0.75;
  return 1.0;
}

/**
 * Effective Overall Difficulty after difficulty-altering mods.
 * HardRock multiplies OD by 1.4 (capped at 10); Easy halves it.
 */
function effectiveOD(od, mods) {
  let v = od;
  if (mods & MODS.HardRock) v = Math.min(10, v * 1.4);
  else if (mods & MODS.Easy) v = v * 0.5;
  return v;
}

/**
 * Lazer standardised score multiplier for a mod combo.
 *
 * NOTE: exact final scores from the .osr header (lazer) and the osu! API already
 * have the multiplier baked in, so this is only used for the *computed* paths
 * (a stable replay we simulate, or the live fallback). Values are lazer-approximate
 * — reducers always apply; the score-boosting mods only raise non-mania scores.
 */
function modMultiplier(mods, mode) {
  let m = 1;
  if (mods & MODS.Easy) m *= 0.5;
  if (mods & MODS.NoFail) m *= 0.5;
  if (mods & MODS.HalfTime) m *= 0.5;
  if (mode !== 3) { // osu!/taiko/catch reward these; mania keeps 1.0x
    if (mods & MODS.HardRock) m *= 1.10;
    if (mods & MODS.Hidden) m *= 1.06;
    if (mods & (MODS.DoubleTime | MODS.Nightcore)) m *= 1.20;
  }
  return m;
}

function modString(mods) {
  const names = [];
  if (mods & MODS.Easy) names.push('EZ');
  if (mods & MODS.NoFail) names.push('NF');
  if (mods & MODS.HardRock) names.push('HR');
  if (mods & MODS.Nightcore) names.push('NC');
  else if (mods & MODS.DoubleTime) names.push('DT');
  if (mods & MODS.HalfTime) names.push('HT');
  if (mods & MODS.Hidden) names.push('HD');
  if (mods & MODS.FadeIn) names.push('FI');
  return names.length ? names.join('') : 'NM';
}

module.exports = { MODS, rateFromMods, effectiveOD, modMultiplier, modString };
