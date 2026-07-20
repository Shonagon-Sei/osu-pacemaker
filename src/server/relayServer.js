'use strict';

const EventEmitter = require('events');
const WebSocket = require('ws');
const log = require('../util/logger');

/**
 * Local WebSocket hub the overlay connects to. Two payload classes:
 *
 *   Bulk (sent once per map): full ghost timelines so the browser can
 *   interpolate locally without per-frame ghost traffic.
 *     { type: 'ghosts', map, step, ghosts: [...] }
 *
 *   Stream (sent every tosu tick): your live numbers + the playhead time.
 *     { type: 'live', time, score, acc, combo, name }
 *
 * New clients immediately receive the latest cached 'ghosts' + status so an
 * overlay that connects mid-song is fully populated.
 */
class RelayServer extends EventEmitter {
  constructor(port) {
    super();
    this.port = port;
    this.wss = null;
    this.lastGhosts = null;
    this.lastStatus = { type: 'status', phase: 'idle' };
    this.lastWarn = null; // sticky diagnostic banner (e.g. cache not writable)
    // Latest overlay preferences that affect what the backend produces.
    this.clientConfig = { includeGlobal: false, globalCount: 50, scoring: 'standardised', bothInstalls: false };
  }

  start() {
    this.wss = new WebSocket.Server({ port: this.port });
    this.wss.on('connection', (ws) => {
      log.info('Overlay connected.');
      ws.send(JSON.stringify(this.lastStatus));
      if (this.lastGhosts) ws.send(JSON.stringify(this.lastGhosts));
      if (this.lastWarn) ws.send(JSON.stringify(this.lastWarn)); // replay any active warning
      ws.on('message', (buf) => this._onClientMessage(buf));
    });
    this.wss.on('error', (e) => log.err('Relay server error:', e.message));
    log.ok(`Relay WebSocket listening on ws://localhost:${this.port}`);
  }

  // The overlay sends its config (e.g. "include global top 50") so the backend
  // only does the heavier work when actually requested.
  _onClientMessage(buf) {
    let msg;
    try { msg = JSON.parse(buf.toString()); } catch { return; }
    if (msg.type !== 'config') return;
    const next = {
      includeGlobal: !!msg.includeGlobal,
      globalCount: Math.max(1, Math.min(100, msg.globalCount || 50)),
      scoring: msg.scoring === 'classic' ? 'classic' : 'standardised',
      bothInstalls: !!msg.bothInstalls,
    };
    const changed = next.includeGlobal !== this.clientConfig.includeGlobal ||
                    next.globalCount !== this.clientConfig.globalCount ||
                    next.scoring !== this.clientConfig.scoring ||
                    next.bothInstalls !== this.clientConfig.bothInstalls;
    this.clientConfig = next;
    if (changed) this.emit('clientConfig', next);
  }

  _broadcast(obj) {
    if (!this.wss) return;
    const json = JSON.stringify(obj);
    for (const client of this.wss.clients) {
      if (client.readyState === WebSocket.OPEN) client.send(json);
    }
  }

  sendStatus(status) {
    this.lastStatus = { type: 'status', ...status };
    this._broadcast(this.lastStatus);
  }

  // Sticky warning banner shown in the overlay. Pass '' (or nothing) to clear it.
  // Re-sent to any overlay that connects later, so a warning isn't missed on reload.
  sendWarn(text) {
    this.lastWarn = text ? { type: 'warn', text: String(text) } : null;
    this._broadcast({ type: 'warn', text: text ? String(text) : '' });
  }

  sendGhosts(payload) {
    this.lastGhosts = { type: 'ghosts', ...payload };
    this._broadcast(this.lastGhosts);
  }

  clearGhosts() {
    this.lastGhosts = null;
    this._broadcast({ type: 'clear' });
  }

  sendLive(live) {
    this._broadcast({ type: 'live', ...live });
  }
}

module.exports = { RelayServer };
