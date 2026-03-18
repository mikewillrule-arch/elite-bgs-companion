'use strict';

const ED_EXE    = 'EliteDangerous64.exe';
const POLL_MS   = 15000;   // check every 15 seconds
const GRACE_MS  = 5 * 60 * 1000; // 5 minutes grace after ED closes

class ProcessMonitor {
  constructor({ onStart, onStop }) {
    this.onStart      = onStart || (() => {});
    this.onStop       = onStop  || (() => {});
    this.pollTimer    = null;
    this.stopTimer    = null;
    this.edRunning    = false;
    this._psList      = null;
  }

  async _loadPsList() {
    if (this._psList) return this._psList;
    // ps-list v7 is CommonJS compatible
    this._psList = require('ps-list');
    return this._psList;
  }

  start() {
    this._check();
    this.pollTimer = setInterval(() => this._check(), POLL_MS);
  }

  stop() {
    clearInterval(this.pollTimer);
    clearTimeout(this.stopTimer);
  }

  async _check() {
    try {
      const psList   = await this._loadPsList();
      const list     = await psList();
      const isRunning = list.some(p => p.name === ED_EXE);

      if (isRunning && !this.edRunning) {
        // Elite just started
        this.edRunning = true;
        clearTimeout(this.stopTimer);
        this.stopTimer = null;
        this.onStart();
      } else if (!isRunning && this.edRunning && !this.stopTimer) {
        // Elite just closed — start grace period timer
        this.stopTimer = setTimeout(() => {
          this.stopTimer  = null;
          this.edRunning  = false;
          this.onStop();
        }, GRACE_MS);
      }
    } catch (e) {
      console.error('[process-monitor] Error:', e.message);
    }
  }
}

module.exports = ProcessMonitor;
