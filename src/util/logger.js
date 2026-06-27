'use strict';

// Tiny dependency-free logger with levels + timestamps. Keeps the hot path cheap.
const COLORS = { info: '\x1b[36m', ok: '\x1b[32m', warn: '\x1b[33m', err: '\x1b[31m', dim: '\x1b[90m', reset: '\x1b[0m' };

function stamp() {
  return new Date().toISOString().slice(11, 23);
}

function log(color, tag, args) {
  process.stdout.write(`${COLORS.dim}${stamp()}${COLORS.reset} ${color}${tag}${COLORS.reset} `);
  console.log(...args);
}

module.exports = {
  info: (...a) => log(COLORS.info, '[info]', a),
  ok: (...a) => log(COLORS.ok, '[ ok ]', a),
  warn: (...a) => log(COLORS.warn, '[warn]', a),
  err: (...a) => log(COLORS.err, '[err ]', a),
};
