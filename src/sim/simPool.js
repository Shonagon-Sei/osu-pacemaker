'use strict';

const path = require('path');
const { Worker } = require('worker_threads');
const log = require('../util/logger');

/**
 * Fixed-size worker pool for replay simulation. Jobs are queued and dispatched
 * to idle workers; the whole batch resolves together. A single map switch can
 * fan dozens of replays across all cores without blocking the relay/tosu loops.
 */
class SimPool {
  constructor(size) {
    this.size = Math.max(1, size);
    this.workers = [];
    this.idle = [];
    this.queue = [];
    this.jobs = new Map(); // id -> {resolve, reject}
    this.nextId = 1;
    this._spawn();
  }

  _spawn() {
    const workerPath = path.join(__dirname, '..', 'workers', 'simWorker.js');
    for (let i = 0; i < this.size; i++) {
      const w = new Worker(workerPath);
      w.on('message', (msg) => this._onMessage(w, msg));
      w.on('error', (err) => {
        log.err('Sim worker crashed:', err.message);
        // Reject any job this worker was carrying, then keep going.
        if (w._currentId != null && this.jobs.has(w._currentId)) {
          this.jobs.get(w._currentId).reject(err);
          this.jobs.delete(w._currentId);
        }
        w._currentId = null;
        this._release(w);
      });
      this.workers.push(w);
      this.idle.push(w);
    }
  }

  _onMessage(w, msg) {
    const entry = this.jobs.get(msg.id);
    if (entry) {
      this.jobs.delete(msg.id);
      if (msg.ok) entry.resolve(msg.ghost);
      else entry.reject(new Error(msg.error));
    }
    w._currentId = null;
    this._release(w);
  }

  _release(w) {
    this.idle.push(w);
    this._pump();
  }

  _pump() {
    while (this.idle.length && this.queue.length) {
      const w = this.idle.pop();
      const job = this.queue.shift();
      w._currentId = job.id;
      this.jobs.set(job.id, job);
      w.postMessage({ id: job.id, osrPath: job.osrPath, beatmap: job.beatmap, stepMs: job.stepMs });
    }
  }

  simulateOne(osrPath, beatmap, stepMs) {
    return new Promise((resolve, reject) => {
      const id = this.nextId++;
      this.queue.push({ id, osrPath, beatmap, stepMs, resolve, reject });
      this._pump();
    });
  }

  /**
   * Simulate many replays against one beatmap. Failures are swallowed per-replay
   * (a corrupt .osr shouldn't sink the whole leaderboard) and reported.
   */
  async simulateBatch(osrPaths, beatmap, stepMs, onProgress) {
    let done = 0;
    const results = await Promise.all(
      osrPaths.map((p) =>
        this.simulateOne(p, beatmap, stepMs)
          .then((g) => { done++; onProgress && onProgress(done, osrPaths.length); return g; })
          .catch((e) => { done++; onProgress && onProgress(done, osrPaths.length); log.warn('skip replay', path.basename(p), '-', e.message); return null; })
      )
    );
    return results.filter(Boolean);
  }

  async destroy() {
    await Promise.all(this.workers.map((w) => w.terminate()));
    this.workers = [];
    this.idle = [];
  }
}

module.exports = { SimPool };
