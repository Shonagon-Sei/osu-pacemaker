'use strict';

const fs = require('fs');
const { BinaryReader } = require('../util/binaryReader');

const GAMEMODE = { STD: 0, TAIKO: 1, CATCH: 2, MANIA: 3 };

/**
 * Cheap header-only parse for indexing. Reads just enough of the file to learn
 * the beatmap MD5, player name and judgement counts WITHOUT touching the
 * (LZMA-compressed) replay payload. The fields we need all precede the life-bar
 * graph string, so a small prefix read is always sufficient.
 */
function parseHeader(filePath) {
  const fd = fs.openSync(filePath, 'r');
  try {
    const buf = Buffer.alloc(4096);
    const read = fs.readSync(fd, buf, 0, 4096, 0);
    const r = new BinaryReader(buf.subarray(0, read));

    const mode = r.byte();
    const version = r.int();
    const beatmapMD5 = r.string();
    const player = r.string();
    const replayMD5 = r.string();

    const count300 = r.short();
    const count100 = r.short();
    const count50 = r.short();
    const countGeki = r.short(); // mania: MAX / rainbow 300
    const countKatu = r.short(); // mania: 200
    const countMiss = r.short();

    const totalScore = r.int();
    const maxCombo = r.short();
    const perfect = r.byte();
    const mods = r.int();

    return {
      mode,
      version,
      beatmapMD5,
      player,
      replayMD5,
      mods,
      maxCombo,
      stableScore: totalScore,
      counts: { max: countGeki, n300: count300, n200: countKatu, n100: count100, n50: count50, miss: countMiss },
    };
  } finally {
    fs.closeSync(fd);
  }
}

/**
 * Content-sniff a file to decide whether it's an osu! replay, returning the
 * parsed header or `null` if it doesn't look like one.
 *
 * This is how we find replays in osu!lazer's content-addressable file store:
 * lazer saves replays as legacy `.osr` blobs under `files/<hash>` with no
 * extension, so we can't filter by name — we validate the binary shape instead.
 * Fast-rejects on the very first byte (a valid game mode is 0-3) so the ~98% of
 * store files that aren't replays cost almost nothing.
 */
function sniffHeader(filePath) {
  let fd;
  try {
    fd = fs.openSync(filePath, 'r');
    const buf = Buffer.alloc(4096);
    const read = fs.readSync(fd, buf, 0, 4096, 0);
    if (read < 16) return null;
    if (buf.readUInt8(0) > 3) return null; // not a valid game mode -> not a replay

    const r = new BinaryReader(buf.subarray(0, read));
    const mode = r.byte();
    const version = r.int();
    if (version < 0 || version > 99999999) return null;
    const beatmapMD5 = r.string();
    if (!/^[0-9a-fA-F]{32}$/.test(beatmapMD5)) return null; // the clincher: a real MD5

    const player = r.string();
    const replayMD5 = r.string();
    r.short(); r.short(); r.short(); r.short(); r.short(); r.short(); // counts
    r.int();   // score
    r.short(); // max combo
    r.byte();  // perfect
    const mods = r.int();

    return { mode, version, beatmapMD5, player, replayMD5, mods };
  } catch {
    return null; // malformed string flag / truncated => not a replay
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

/**
 * Full parse: header + raw (still-compressed) replay block. We hand the
 * compressed buffer off to the simulator/worker which decodes it with LZMA.
 * Keeping decode out of here means the cheap header path stays cheap.
 */
function parseReplay(filePath) {
  const buf = fs.readFileSync(filePath);
  const r = new BinaryReader(buf);

  const mode = r.byte();
  const version = r.int();
  const beatmapMD5 = r.string();
  const player = r.string();
  const replayMD5 = r.string();

  const count300 = r.short();
  const count100 = r.short();
  const count50 = r.short();
  const countGeki = r.short();
  const countKatu = r.short();
  const countMiss = r.short();

  const totalScore = r.int();
  const maxCombo = r.short();
  const perfect = r.byte();
  const mods = r.int();

  const lifeBar = r.string();
  const timestamp = r.long(); // Windows ticks (BigInt)
  const replayLength = r.int();
  const replayData = replayLength > 0 ? Buffer.from(r.bytes(replayLength)) : Buffer.alloc(0);

  return {
    mode,
    version,
    beatmapMD5,
    player,
    replayMD5,
    mods,
    maxCombo,
    perfect,
    stableScore: totalScore,
    counts: { max: countGeki, n300: count300, n200: countKatu, n100: count100, n50: count50, miss: countMiss },
    timestamp: timestamp.toString(),
    replayData,
  };
}

/**
 * Decode the LZMA replay payload into absolute-time key frames.
 *
 * Decompressed payload is ASCII: comma-separated `w|x|y|z` tuples where
 *   w = ms since previous frame
 *   x = pressed-column bitmask (mania)   <-- the bit we care about
 *   y = unused in mania
 *   z = legacy key bitmask
 *
 * Frames with w == -12345 are the RNG-seed marker (newer replays) and are dropped.
 */
function decodeFrames(replayData, lzma) {
  return new Promise((resolve, reject) => {
    if (!replayData || replayData.length === 0) return resolve([]);
    lzma.decompress(replayData, (result, error) => {
      if (error) return reject(error);
      try {
        const text = Buffer.isBuffer(result) ? result.toString('latin1') : Buffer.from(result).toString('latin1');
        const frames = [];
        let t = 0;
        for (const tuple of text.split(',')) {
          if (!tuple) continue;
          const parts = tuple.split('|');
          if (parts.length < 4) continue;
          const w = parseInt(parts[0], 10);
          if (w === -12345) continue; // seed frame
          const x = parseInt(parts[1], 10);
          t += w;
          frames.push({ t, keys: x | 0 });
        }
        frames.sort((a, b) => a.t - b.t);
        resolve(frames);
      } catch (e) {
        reject(e);
      }
    });
  });
}

module.exports = { GAMEMODE, parseHeader, sniffHeader, parseReplay, decodeFrames };
