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

// Full legacy (stable) mod bitmask -> acronyms. Lazer-only mods (DC, etc.) don't
// have legacy bits — those come from the replay's solo block / the API instead.
// Precedence: NC implies DT, PF implies SD (show only the superset).
const MOD_BIT = {
  NF: 1, EZ: 2, TD: 4, HD: 8, HR: 16, SD: 32, DT: 64, RX: 128, HT: 256, NC: 512,
  FL: 1024, AT: 2048, SO: 4096, AP: 8192, PF: 16384,
  K4: 32768, K5: 65536, K6: 131072, K7: 262144, K8: 524288,
  FI: 1048576, RD: 2097152, CN: 4194304, TP: 8388608,
  K9: 16777216, COOP: 33554432, K1: 67108864, K3: 134217728, K2: 268435456,
  V2: 536870912, MR: 1073741824,
};
function modString(mods) {
  const m = (mods || 0) >>> 0;
  const has = (bit) => (m & bit) !== 0;
  const out = [];
  if (has(MOD_BIT.EZ)) out.push('EZ');
  if (has(MOD_BIT.NF)) out.push('NF');
  if (has(MOD_BIT.HT)) out.push('HT');
  if (has(MOD_BIT.HR)) out.push('HR');
  if (has(MOD_BIT.PF)) out.push('PF'); else if (has(MOD_BIT.SD)) out.push('SD');
  if (has(MOD_BIT.NC)) out.push('NC'); else if (has(MOD_BIT.DT)) out.push('DT');
  if (has(MOD_BIT.HD)) out.push('HD');
  if (has(MOD_BIT.FL)) out.push('FL');
  if (has(MOD_BIT.RX)) out.push('RX');
  if (has(MOD_BIT.AP)) out.push('AP');
  if (has(MOD_BIT.SO)) out.push('SO');
  if (has(MOD_BIT.TD)) out.push('TD');
  if (has(MOD_BIT.AT)) out.push('AT');
  if (has(MOD_BIT.CN)) out.push('CN');
  if (has(MOD_BIT.FI)) out.push('FI');
  if (has(MOD_BIT.MR)) out.push('MR');
  if (has(MOD_BIT.RD)) out.push('RD');
  if (has(MOD_BIT.TP)) out.push('TP');
  // mania key mods
  if (has(MOD_BIT.K1)) out.push('1K');
  if (has(MOD_BIT.K2)) out.push('2K');
  if (has(MOD_BIT.K3)) out.push('3K');
  if (has(MOD_BIT.K4)) out.push('4K');
  if (has(MOD_BIT.K5)) out.push('5K');
  if (has(MOD_BIT.K6)) out.push('6K');
  if (has(MOD_BIT.K7)) out.push('7K');
  if (has(MOD_BIT.K8)) out.push('8K');
  if (has(MOD_BIT.K9)) out.push('9K');
  if (has(MOD_BIT.COOP)) out.push('CO');
  // V2 (ScoreV2) is intentionally not shown as a gameplay mod.
  return out.length ? out.join('') : 'NM';
}

/**
 * Speed multiplier of a play, honouring lazer's custom rate. Accepts a lazer mod
 * array ([{ acronym, settings }] or ['DT']), a numeric bitmask, or an acronym
 * string. DT/NC default to 1.5x and HT/DC to 0.75x, but a `speed_change` setting
 * (lazer's adjustable rate) overrides that. 1.0 when no speed mod is present.
 */
function modSpeed(mods) {
  if (Array.isArray(mods)) {
    for (const m of mods) {
      const a = (typeof m === 'string' ? m : (m && m.acronym) || '').toUpperCase();
      const sc = (m && typeof m === 'object' && m.settings && +m.settings.speed_change) || 0;
      if (a === 'DT' || a === 'NC') return sc || 1.5;
      if (a === 'HT' || a === 'DC') return sc || 0.75;
    }
    return 1;
  }
  if (typeof mods === 'number') {
    if (mods & (MODS.DoubleTime | MODS.Nightcore)) return 1.5;
    if (mods & MODS.HalfTime) return 0.75;
    return 1;
  }
  const s = String(mods || '').toUpperCase();
  if (/DT|NC/.test(s)) return 1.5;
  if (/HT|DC/.test(s)) return 0.75;
  return 1;
}

module.exports = { MODS, rateFromMods, effectiveOD, modMultiplier, modString, modSpeed };
