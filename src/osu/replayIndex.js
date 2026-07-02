'use strict';

const fs = require('fs');
const path = require('path');
const { sniffHeader } = require('./osrParser');
const log = require('../util/logger');

/**
 * Indexes osu!mania replays by beatmap MD5 across one or both install types:
 *
 *   • stable — scans osu!\Data\r\*.osr (header-only, cached by mtime+size).
 *   • lazer  — walks the content-addressable files\ store and content-sniffs
 *              each blob (lazer saves replays as legacy .osr with hash names, no
 *              extension). The store is immutable/content-addressed, so a file's
 *              presence is enough — we keep a "seen" set to skip re-sniffing the
 *              ~98% of blobs that are beatmaps/audio/skins, not replays.
 *
 * The result is the same MD5 -> [.osr paths] map regardless of source, so the
 * rest of the app is install-agnostic. Cache lives in .cache/replay-index.json.
 */
class ReplayIndex {
  constructor(config) {
    this.config = config;
    this.byMd5 = new Map();    // md5(lowercase) -> [{ path, player, mods }]
    this.replayMeta = [];      // [{ p, md5, player, mods, mtimeMs, size }]
    this.lazerSeen = new Set(); // every lazer path examined (replay or not)
  }

  _loadCache() {
    try {
      if (!fs.existsSync(this.config.indexCacheFile)) return null;
      const raw = JSON.parse(fs.readFileSync(this.config.indexCacheFile, 'utf8'));
      return raw && raw.version === 4 ? raw : null; // v4: all modes (was mania-only)
    } catch {
      return null;
    }
  }

  _saveCache() {
    try {
      fs.mkdirSync(this.config.cacheDir, { recursive: true });
      fs.writeFileSync(
        this.config.indexCacheFile,
        JSON.stringify({ version: 4, replays: this.replayMeta, lazerSeen: [...this.lazerSeen] })
      );
    } catch (e) {
      log.warn('Could not write index cache:', e.message);
    }
  }

  _rebuildMd5Map() {
    this.byMd5.clear();
    for (const e of this.replayMeta) {
      if (!e.md5) continue;
      const key = String(e.md5).toLowerCase(); // match tosu checksum case-insensitively
      if (!this.byMd5.has(key)) this.byMd5.set(key, []);
      this.byMd5.get(key).push({ path: e.p, player: e.player, mods: e.mods });
    }
  }

  /**
   * Build (or refresh) the index across all configured sources.
   *
   * `onProgress(count)` (optional) is called periodically with the number of
   * files examined so callers can surface a live "still scanning" status.
   *
   * The scan is I/O-heavy and, on a cold cache, sniffs the entire lazer store —
   * so we hand control back to the event loop every so often (a real macrotask
   * yield, not just a microtask). Without this the whole process — including the
   * Electron main process that owns the tray, global shortcuts and the overlay's
   * websocket — freezes solid until the scan finishes.
   */
  async build(onProgress) {
    const cache = this._loadCache();
    const cachedReplays = new Map();
    if (cache) for (const r of cache.replays) cachedReplays.set(r.p, r);
    const cachedSeen = new Set(cache ? cache.lazerSeen : []);

    const replays = [];
    const lazerSeen = new Set();
    const stats = { parsed: 0, reused: 0, sniffed: 0 };

    let processed = 0;
    const yieldMaybe = async () => {
      // Every 256 files: report progress and let pending I/O / IPC / shortcuts run.
      if ((++processed & 0xff) === 0) {
        if (onProgress) { try { onProgress(processed); } catch { /* ignore */ } }
        await new Promise((r) => setImmediate(r));
      }
    };

    for (const src of this.config.sources) {
      if (src.type === 'stable') {
        await this._buildStable(src, cachedReplays, replays, stats, yieldMaybe);
      } else if (src.type === 'lazer') {
        await this._buildLazer(src, cachedReplays, cachedSeen, replays, lazerSeen, stats, yieldMaybe);
      }
    }

    this.replayMeta = replays;
    this.lazerSeen = lazerSeen;
    this._rebuildMd5Map();
    this._saveCache();

    log.ok(
      `Replay index: ${replays.length} replays across ${this.byMd5.size} maps ` +
      `(parsed ${stats.parsed}, sniffed ${stats.sniffed}, cached ${stats.reused}).`
    );
  }

  // ── stable: Data\r\*.osr, cached by mtime+size ─────────────────────────────
  async _buildStable(src, cachedReplays, out, stats, yieldMaybe) {
    const dir = src.replayDir;
    if (!fs.existsSync(dir)) return;

    const names = (await fs.promises.readdir(dir)).filter((f) => f.toLowerCase().endsWith('.osr'));
    for (const name of names) {
      await yieldMaybe();
      const full = path.join(dir, name);
      let st;
      try { st = await fs.promises.stat(full); } catch { continue; }

      const cached = cachedReplays.get(full);
      if (cached && cached.mtimeMs === st.mtimeMs && cached.size === st.size) {
        out.push(cached);
        stats.reused++;
        continue;
      }

      const h = sniffHeader(full);
      stats.sniffed++;
      if (h) { // index all rulesets; the active beatmap's mode selects which apply
        out.push({ p: full, md5: h.beatmapMD5, player: h.player, mods: h.mods, mode: h.mode, mtimeMs: st.mtimeMs, size: st.size });
        stats.parsed++;
      }
    }
  }

  // ── lazer: walk files\ store, sniff unknown blobs ──────────────────────────
  async _buildLazer(src, cachedReplays, cachedSeen, out, seenOut, stats, yieldMaybe) {
    const dir = src.filesDir;
    if (!fs.existsSync(dir)) {
      log.warn('Lazer files store missing:', dir);
      return;
    }

    let scanned = 0;
    for await (const full of walk(dir)) {
      await yieldMaybe();
      seenOut.add(full);

      const cached = cachedReplays.get(full);
      if (cached) {                       // known replay (immutable -> trust it)
        out.push(cached);
        stats.reused++;
        continue;
      }
      if (cachedSeen.has(full)) continue; // known non-replay -> skip the sniff

      const h = sniffHeader(full);
      stats.sniffed++;
      if (h) {
        out.push({ p: full, md5: h.beatmapMD5, player: h.player, mods: h.mods, mode: h.mode, mtimeMs: 0, size: 0 });
        stats.parsed++;
      }

      if (++scanned % 20000 === 0) log.info(`  …lazer store: sniffed ${scanned} blobs`);
    }
  }

  /** Return absolute replay paths for a beatmap MD5 (case-insensitive). */
  lookup(md5) {
    if (!md5) return [];
    return (this.byMd5.get(String(md5).toLowerCase()) || []).map((e) => e.path);
  }

  lookupDetailed(md5) {
    if (!md5) return [];
    return this.byMd5.get(String(md5).toLowerCase()) || [];
  }

  get mapCount() {
    return this.byMd5.size;
  }
}

// Recursive file walker (lazer nests blobs as files\<a>\<ab>\<hash>).
async function* walk(dir) {
  let entries;
  try {
    entries = await fs.promises.readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) yield* walk(full);
    else if (e.isFile()) yield full;
  }
}

module.exports = { ReplayIndex };
