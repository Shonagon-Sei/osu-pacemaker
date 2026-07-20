'use strict';

const fs = require('fs');
const path = require('path');
const { sniffHeader, sniffHeaderAsync } = require('./osrParser');
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
    this._built = false;        // has a full scan run this session yet?
    this.sourceSig = {};        // root -> cheap change signature (dir/realm mtime)
  }

  // A cheap "did anything change?" signature for a source, so repeat rebuilds can
  // skip re-enumerating it. Stable: the replay dir's mtime (adding/removing a .osr
  // bumps it). Lazer: client.realm's mtime (rewritten on every new score), falling
  // back to the files-store dir. Returns null if it can't stat (-> always rescan).
  _sourceSignature(src) {
    try {
      if (src.type === 'stable') return 's:' + fs.statSync(src.replayDir).mtimeMs;
      const realm = path.join(src.root, 'client.realm');
      if (fs.existsSync(realm)) return 'l:' + fs.statSync(realm).mtimeMs;
      if (src.filesDir && fs.existsSync(src.filesDir)) return 'l:' + fs.statSync(src.filesDir).mtimeMs;
    } catch { /* fall through */ }
    return null;
  }

  _underRoot(p, root) {
    return String(p).toLowerCase().startsWith(String(root).toLowerCase());
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
        JSON.stringify({ version: 4, replays: this.replayMeta, lazerSeen: [...this.lazerSeen], sourceSig: this.sourceSig })
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
      // Tag each replay with the install it came from so we can serve only the
      // replays for whichever osu! (stable/lazer) is actually running.
      this.byMd5.get(key).push({ path: e.p, player: e.player, mods: e.mods, src: this._classifySource(e.p) });
    }
  }

  // Which configured source a replay path belongs to ('stable' | 'lazer' | null).
  // Longest-matching root wins so a lazer store nested under a shared parent
  // still classifies correctly.
  _classifySource(p) {
    const lp = String(p).toLowerCase();
    let best = null;
    for (const s of this.config.sources) {
      const root = String(s.root).toLowerCase();
      if (lp.startsWith(root) && (!best || s.root.length > best.len)) best = { type: s.type, len: s.root.length };
    }
    return best ? best.type : null;
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
   *
   * Repeat rebuilds (every map change) are cheap: they reuse the IN-MEMORY index
   * (no disk read/parse) and skip re-enumerating any source whose directory
   * signature is unchanged. Pass `{ force: true }` to bypass the skip (used after
   * a play, when we know a replay was just written).
   */
  async build(onProgress, opts = {}) {
    const force = !!opts.force;
    const firstBuild = !this._built;

    // Cold start: seed the reuse maps from the on-disk cache. Incremental rebuilds
    // reuse the in-memory index instead — no disk read/parse on the hot path.
    let cachedReplays, cachedSeen;
    if (firstBuild) {
      const cache = this._loadCache();
      cachedReplays = new Map();
      if (cache) for (const r of cache.replays) cachedReplays.set(r.p, r);
      cachedSeen = new Set(cache ? cache.lazerSeen : []);
      if (cache && cache.sourceSig) this.sourceSig = cache.sourceSig;
    } else {
      cachedReplays = new Map(this.replayMeta.map((r) => [r.p, r]));
      cachedSeen = new Set(this.lazerSeen);
    }
    const prevSig = this.sourceSig || {};
    const newSig = {};

    const replays = [];
    const lazerSeen = new Set();
    const stats = { parsed: 0, reused: 0, sniffed: 0, skipped: 0 };
    let changed = false;

    let processed = 0;
    const yieldMaybe = async () => {
      // Every 256 files: report progress and let pending I/O / IPC / shortcuts run.
      if ((++processed & 0xff) === 0) {
        if (onProgress) { try { onProgress(processed); } catch { /* ignore */ } }
        await new Promise((r) => setImmediate(r));
      }
    };

    for (const src of this.config.sources) {
      const sig = this._sourceSignature(src);
      newSig[src.root] = sig;
      // Unchanged since the last scan -> carry the cached entries over verbatim and
      // skip the (potentially very expensive) directory walk. This applies on the
      // FIRST build of a session too, so a cold start whose lazer store hasn't
      // changed since last run doesn't re-sniff tens of thousands of blobs — the
      // difference between a ~2-3 min launch and an instant one.
      if (!force && sig != null && sig === prevSig[src.root]) {
        for (const r of cachedReplays.values()) if (this._underRoot(r.p, src.root)) replays.push(r);
        if (src.type === 'lazer') for (const p of cachedSeen) if (this._underRoot(p, src.root)) lazerSeen.add(p);
        stats.skipped++;
        continue;
      }
      changed = true;
      if (src.type === 'stable') {
        await this._buildStable(src, cachedReplays, replays, stats, yieldMaybe);
      } else if (src.type === 'lazer') {
        await this._buildLazer(src, cachedReplays, cachedSeen, replays, lazerSeen, stats, yieldMaybe);
      }
    }

    this.replayMeta = replays;
    this.lazerSeen = lazerSeen;
    this.sourceSig = newSig;
    this._rebuildMd5Map();
    this._built = true;
    if (changed) this._saveCache(); // only touch disk when something actually changed

    if (changed) {
      log.ok(
        `Replay index: ${replays.length} replays across ${this.byMd5.size} maps ` +
        `(parsed ${stats.parsed}, sniffed ${stats.sniffed}, cached ${stats.reused}).`
      );
    } else if (firstBuild) {
      // Cold start with nothing changed since last run — served entirely from cache.
      log.ok(`Replay index: ${replays.length} replays across ${this.byMd5.size} maps (loaded from cache, sources unchanged).`);
    }
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

    const t0 = Date.now();
    // First pass: enumerate the store. Reuse known replays, skip known non-replays,
    // and collect only the blobs we've never seen — those are all we must open.
    const toSniff = [];
    for await (const full of walk(dir)) {
      await yieldMaybe();
      seenOut.add(full);
      const cached = cachedReplays.get(full);
      if (cached) { out.push(cached); stats.reused++; continue; } // immutable -> trust it
      if (cachedSeen.has(full)) continue;                          // known non-replay
      toSniff.push(full);
    }
    const tWalk = Date.now();

    // Second pass: sniff the unseen blobs CONCURRENTLY. Each open can stall (disk,
    // and especially Windows Defender scanning the file), so overlapping many at
    // once turns a long sequential wait into roughly (count / concurrency) — the
    // difference between a multi-minute launch and a few seconds.
    const CONC = 32;
    let idx = 0;
    const worker = async () => {
      while (idx < toSniff.length) {
        const full = toSniff[idx++];
        const h = await sniffHeaderAsync(full);
        stats.sniffed++;
        if (h) {
          out.push({ p: full, md5: h.beatmapMD5, player: h.player, mods: h.mods, mode: h.mode, mtimeMs: 0, size: 0 });
          stats.parsed++;
        }
        if ((stats.sniffed & 0x3ff) === 0) await yieldMaybe();
      }
    };
    await Promise.all(Array.from({ length: Math.min(CONC, toSniff.length) }, worker));

    if (toSniff.length > 2000 || (Date.now() - t0) > 1500) {
      log.info(`  lazer store: walked in ${tWalk - t0}ms, sniffed ${toSniff.length} new blob(s) in ${Date.now() - tWalk}ms (${CONC}-way).`);
    }
  }

  /**
   * Return absolute replay paths for a beatmap MD5 (case-insensitive).
   * Pass `srcType` ('stable' | 'lazer') to restrict to one install; omit it to
   * return replays from every indexed source.
   */
  lookup(md5, srcType) {
    if (!md5) return [];
    const arr = this.byMd5.get(String(md5).toLowerCase()) || [];
    const filtered = srcType ? arr.filter((e) => e.src === srcType) : arr;
    return filtered.map((e) => e.path);
  }

  lookupDetailed(md5) {
    if (!md5) return [];
    return this.byMd5.get(String(md5).toLowerCase()) || [];
  }

  /** Diagnostics: how many replays this md5 has, broken down by source install. */
  breakdown(md5) {
    const arr = this.byMd5.get(String(md5 || '').toLowerCase()) || [];
    const by = {};
    for (const e of arr) { const k = e.src || 'unknown'; by[k] = (by[k] || 0) + 1; }
    return { total: arr.length, by };
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
