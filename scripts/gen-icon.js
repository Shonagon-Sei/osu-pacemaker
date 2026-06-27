'use strict';

// Generates simple PNG icons (no external deps) so the build/tray have an image:
//   build/icon.png  (256x256, app icon — electron-builder converts to .ico)
//   build/tray.png  (32x32, system tray)
// A magenta disc with a lighter ring — placeholder; swap in real art anytime.

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const CRC = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; }
  return (buf) => { let c = 0xffffffff; for (let i = 0; i < buf.length; i++) c = t[(c ^ buf[i]) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
})();

function chunk(type, data) {
  const t = Buffer.from(type, 'ascii');
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length, 0);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(CRC(Buffer.concat([t, data])), 0);
  return Buffer.concat([len, t, data, crc]);
}

function png(size) {
  const rgba = Buffer.alloc(size * size * 4);
  const c = (size - 1) / 2;
  const rOuter = size * 0.46;
  const rInner = size * 0.30;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const d = Math.hypot(x - c, y - c);
      const i = (y * size + x) * 4;
      let col = [0, 0, 0, 0];
      if (d <= rOuter) col = (d > rInner && d <= rInner + size * 0.06) ? [255, 230, 245, 255] : [255, 90, 170, 255];
      // soft 1px edge
      if (d > rOuter - 1 && d <= rOuter) col[3] = Math.round(col[3] * (rOuter - d));
      rgba[i] = col[0]; rgba[i + 1] = col[1]; rgba[i + 2] = col[2]; rgba[i + 3] = col[3];
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; ihdr[9] = 6; // 8-bit, RGBA
  const stride = size * 4;
  const raw = Buffer.alloc((stride + 1) * size);
  for (let y = 0; y < size; y++) rgba.copy(raw, y * (stride + 1) + 1, y * stride, y * stride + stride);
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

const dir = path.join(__dirname, '..', 'build');
fs.mkdirSync(dir, { recursive: true });
fs.writeFileSync(path.join(dir, 'icon.png'), png(256));
fs.writeFileSync(path.join(dir, 'tray.png'), png(32));
console.log('gen-icon: wrote build/icon.png (256) and build/tray.png (32)');
