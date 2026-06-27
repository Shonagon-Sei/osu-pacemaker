'use strict';

/**
 * Sequential reader for osu!'s little-endian binary format
 * (used by .osr replays and scores.db / osu!.db).
 *
 * The non-obvious part is osu!'s string encoding:
 *   byte 0x00            -> empty/null string
 *   byte 0x0b + ULEB128 length + UTF-8 bytes
 */
class BinaryReader {
  constructor(buffer) {
    this.buf = buffer;
    this.pos = 0;
  }

  get remaining() {
    return this.buf.length - this.pos;
  }

  byte() {
    return this.buf.readUInt8(this.pos++);
  }

  short() {
    const v = this.buf.readUInt16LE(this.pos);
    this.pos += 2;
    return v;
  }

  int() {
    const v = this.buf.readInt32LE(this.pos);
    this.pos += 4;
    return v;
  }

  uint() {
    const v = this.buf.readUInt32LE(this.pos);
    this.pos += 4;
    return v;
  }

  long() {
    const v = this.buf.readBigInt64LE(this.pos);
    this.pos += 8;
    return v; // BigInt
  }

  double() {
    const v = this.buf.readDoubleLE(this.pos);
    this.pos += 8;
    return v;
  }

  // Unsigned LEB128 (variable length integer)
  uleb128() {
    let result = 0;
    let shift = 0;
    let b;
    do {
      b = this.byte();
      result |= (b & 0x7f) << shift;
      shift += 7;
    } while (b & 0x80);
    return result >>> 0;
  }

  // osu! length-prefixed string
  string() {
    const flag = this.byte();
    if (flag === 0x00) return '';
    if (flag !== 0x0b) {
      throw new Error(`BinaryReader: invalid string flag 0x${flag.toString(16)} at offset ${this.pos - 1}`);
    }
    const len = this.uleb128();
    const s = this.buf.toString('utf8', this.pos, this.pos + len);
    this.pos += len;
    return s;
  }

  bytes(n) {
    const slice = this.buf.subarray(this.pos, this.pos + n);
    this.pos += n;
    return slice;
  }

  skip(n) {
    this.pos += n;
  }
}

module.exports = { BinaryReader };
