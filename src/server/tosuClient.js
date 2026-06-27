'use strict';

const EventEmitter = require('events');
const path = require('path');
const fs = require('fs');
const WebSocket = require('ws');
const log = require('../util/logger');

/**
 * Connects to tosu (https://tosu.app) and normalises its v2 firehose into the
 * same clean events the rest of the app consumes:
 *   'beatmap' { md5, osuPath, title, mode }   when the selected map changes
 *   'state'   { state }                        game-state transitions
 *   'live'    { time, score, acc, combo, name, hits }  per-tick gameplay
 *
 * Uses tosu's modern v2 API (ws://host:24050/websocket/v2). The v2 schema differs
 * from the legacy gosumemory `/ws` shape:
 *   beatmap.checksum            -> beatmap MD5
 *   directPath.beatmapFile      -> absolute path to the active .osu  (no composing!)
 *   state.number (GameState)    -> 2 === "play"   (tosu keeps gosu's play=2 value)
 *   play.{score,accuracy,combo,playerName,hits}  -> live gameplay
 *   beatmap.time.live           -> current playhead (ms)
 *
 * Auto-reconnects with backoff so the overlay survives tosu restarts.
 */
class TosuClient extends EventEmitter {
  constructor(config) {
    super();
    this.url = config.tosuUrl;
    this.ws = null;
    this.backoff = 1000;
    this.lastMd5 = null;
    this.lastState = null;
    this.closed = false;
    this.warnedSchema = false;

    // Pause/restart tracking. osu! stays in "play" state while paused, so we
    // infer pause from the gameplay clock stalling, and restart from it jumping
    // backwards.
    this.lastGameTime = -1;
    this.lastAdvanceAt = 0;
    this.hasAdvanced = false;
    this.paused = false;
  }

  _resetPlayTracking() {
    this.lastGameTime = -1;
    this.lastAdvanceAt = 0;
    this.hasAdvanced = false;
    this.paused = false;
  }

  connect() {
    this.closed = false;
    this._open();
  }

  _open() {
    log.info('Connecting to tosu:', this.url);
    const ws = new WebSocket(this.url);
    this.ws = ws;

    ws.on('open', () => {
      this.backoff = 1000;
      log.ok('tosu connected.');
    });

    ws.on('message', (buf) => {
      let data;
      try {
        data = JSON.parse(buf.toString());
      } catch {
        return;
      }
      this._handle(data);
    });

    ws.on('close', () => {
      if (this.closed) return;
      log.warn(`tosu disconnected; retrying in ${this.backoff}ms`);
      setTimeout(() => this._open(), this.backoff);
      this.backoff = Math.min(this.backoff * 2, 15000);
    });

    ws.on('error', (e) => {
      log.warn('tosu socket error:', e.message);
      // 'close' fires next and handles the retry.
    });
  }

  _handle(d) {
    // Guard: make sure we're actually talking to the v2 endpoint, not legacy /ws.
    if (!d || !d.beatmap || !d.play || !d.state) {
      if (!this.warnedSchema) {
        this.warnedSchema = true;
        log.warn('Unexpected payload shape — is TOSU_URL pointing at the v2 endpoint (/websocket/v2)?');
      }
      return;
    }

    const beatmap = d.beatmap;
    const play = d.play;
    const stateNum = d.state.number;

    // ── map change ──────────────────────────────────────────────────────────
    // Normalise the checksum and only fire once we ALSO have the .osu path.
    // tosu can populate `directPath.beatmapFile` a tick or two after `checksum`,
    // so we wait for both rather than bailing out and silently skipping the map.
    const md5 = (beatmap.checksum || '').toLowerCase();
    const osuPath = this._resolveOsuPath(d);
    if (md5 && md5 !== this.lastMd5 && osuPath) {
      this.lastMd5 = md5;
      this.emit('beatmap', {
        md5,
        osuPath,
        beatmapId: beatmap.id || 0, // online beatmap id (for the global leaderboard)
        title: this._title(beatmap),
        mode: beatmap.mode ? beatmap.mode.number : 0,
      });
    }

    // ── state change ────────────────────────────────────────────────────────
    if (typeof stateNum === 'number' && stateNum !== this.lastState) {
      this.lastState = stateNum;
      if (stateNum !== 2) this._resetPlayTracking(); // left gameplay (quit/results)
      this.emit('state', { state: stateNum }); // 2 === play
    }

    // ── live gameplay tick ──────────────────────────────────────────────────
    if (stateNum === 2 && play && play.score != null) {
      const time = beatmap.time && typeof beatmap.time.live === 'number' ? beatmap.time.live : 0;
      const h = play.hits || {};
      const combo = play.combo || {};

      // Derive pause/restart from how the gameplay clock moves.
      const now = Date.now();
      let restart = false;
      if (this.lastGameTime < 0) {
        this.lastGameTime = time;
        this.lastAdvanceAt = now;
      } else if (time > this.lastGameTime + 1) {
        this.lastGameTime = time;
        this.lastAdvanceAt = now;
        this.hasAdvanced = true;
        this.paused = false;
      } else if (time < this.lastGameTime - 1000) {
        restart = true;                 // clock jumped back -> retry
        this.lastGameTime = time;
        this.lastAdvanceAt = now;
        this.paused = false;
      } else if (this.hasAdvanced && now - this.lastAdvanceAt > 250) {
        this.paused = true;             // clock stalled mid-song -> paused
      }
      if (restart) this.emit('restart');

      this.emit('live', {
        time,
        paused: this.paused,
        restart,
        score: play.score || 0,
        acc: play.accuracy != null ? +play.accuracy.toFixed(2) : 100,
        combo: combo.current || 0,
        maxCombo: combo.max || 0,
        mods: (play.mods && play.mods.name) || '', // your current mods (for same-mods filter)
        name: play.playerName || 'You',
        hits: {
          n300: h['300'] || 0,
          geki: h.geki || 0,   // mania MAX (320)
          n200: h.katu || 0,   // mania 200
          n100: h['100'] || 0,
          n50: h['50'] || 0,
          miss: h['0'] || 0,
        },
      });
    }
  }

  /**
   * tosu hands us the active map's absolute .osu path directly. Fall back to
   * composing it from the songs folder + beatmap folder + filename if needed.
   */
  _resolveOsuPath(d) {
    const dp = d.directPath || {};
    // NOTE: don't require a .osu extension — lazer's beatmap blobs are hash-named
    // with no extension, yet still contain the raw .osu text. The parser reads by
    // content, so any existing file path tosu hands us is fine.
    if (dp.beatmapFile && fs.existsSync(dp.beatmapFile)) return dp.beatmapFile;

    const folders = d.folders || {};
    const files = d.files || {};
    if (folders.songs && folders.beatmap && files.beatmap) {
      const composed = path.join(folders.songs, folders.beatmap, files.beatmap);
      if (fs.existsSync(composed)) return composed;
    }
    return dp.beatmapFile || null; // last resort: hand back whatever tosu gave
  }

  _title(b) {
    const artist = b.artist || '';
    const title = b.title || '';
    const version = b.version || '';
    if (!artist && !title) return '';
    return `${artist} - ${title} [${version}]`;
  }

  close() {
    this.closed = true;
    if (this.ws) this.ws.close();
  }
}

module.exports = { TosuClient };
