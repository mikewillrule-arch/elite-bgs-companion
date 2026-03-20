'use strict';

const fs       = require('fs');
const path     = require('path');
const os       = require('os');
const https    = require('https');
const http     = require('http');
const chokidar = require('chokidar');

// All known locations Elite Dangerous may write journals to
// Priority order: most common first, then fallbacks.
const _home     = os.homedir();
const _upf      = process.env.USERPROFILE || _home;   // explicit %USERPROFILE%
const _username = os.userInfo().username;

// Dynamically build secondary-drive equivalents (D:, E:, F:) for users
// who have their Windows profile on a non-C: drive.
function _altDrivePaths(rel) {
  return ['D:', 'E:', 'F:', 'G:'].map(d => path.join(d, 'Users', _username, rel));
}

const _ED_REL    = path.join('Saved Games', 'Frontier Developments', 'Elite Dangerous');
const _ED_REL2   = path.join('Documents',   'Frontier Developments', 'Elite Dangerous');
const _ED_REL2L  = path.join('Documents',   'Frontier Developments', 'Elite Dangerous', 'Logs');

const JOURNAL_SEARCH_PATHS = [
  // ── Primary Windows location (most users) ────────────────────────────────
  path.join(_home, 'Saved Games', 'Frontier Developments', 'Elite Dangerous'),
  path.join(_upf,  'Saved Games', 'Frontier Developments', 'Elite Dangerous'),

  // ── Documents fallback ────────────────────────────────────────────────────
  path.join(_home, 'Documents', 'Frontier Developments', 'Elite Dangerous'),
  path.join(_home, 'Documents', 'Frontier Developments', 'Elite Dangerous', 'Logs'),
  path.join(_upf,  'Documents', 'Frontier Developments', 'Elite Dangerous'),

  // ── OneDrive — Saved Games sync ───────────────────────────────────────────
  path.join(_home, 'OneDrive', 'Saved Games', 'Frontier Developments', 'Elite Dangerous'),
  path.join(_home, 'OneDrive - Personal', 'Saved Games', 'Frontier Developments', 'Elite Dangerous'),
  path.join(_home, 'OneDrive - ' + _username, 'Saved Games', 'Frontier Developments', 'Elite Dangerous'),
  path.join(_upf,  'OneDrive', 'Saved Games', 'Frontier Developments', 'Elite Dangerous'),

  // ── OneDrive — Documents sync (some setups redirect Documents to OneDrive) ─
  path.join(_home, 'OneDrive', 'Documents', 'Frontier Developments', 'Elite Dangerous'),
  path.join(_home, 'OneDrive - Personal', 'Documents', 'Frontier Developments', 'Elite Dangerous'),
  path.join(_home, 'OneDrive - ' + _username, 'Documents', 'Frontier Developments', 'Elite Dangerous'),

  // ── Secondary drives (D:, E:, F:, G:) — users with profile on non-C: drive ─
  ..._altDrivePaths(_ED_REL),
  ..._altDrivePaths(_ED_REL2),
  ..._altDrivePaths(_ED_REL2L),

  // ── Epic Games Store location ─────────────────────────────────────────────
  path.join('C:\\Program Files', 'Epic Games', 'EliteDangerous', 'Products', 'elite-dangerous-64', 'Logs'),
  path.join('C:\\Program Files', 'Epic Games', 'EliteDangerous', 'Products'),
  path.join('D:\\Program Files', 'Epic Games', 'EliteDangerous', 'Products'),

  // ── Steam ─────────────────────────────────────────────────────────────────
  path.join('C:\\Program Files (x86)', 'Steam', 'steamapps', 'common', 'Elite Dangerous', 'Products'),
  path.join('D:\\Program Files (x86)', 'Steam', 'steamapps', 'common', 'Elite Dangerous', 'Products'),
  path.join('D:\\Steam', 'steamapps', 'common', 'Elite Dangerous', 'Products'),
  path.join('E:\\Steam', 'steamapps', 'common', 'Elite Dangerous', 'Products'),

  // ── Microsoft Store / Xbox app ────────────────────────────────────────────
  path.join(process.env.LOCALAPPDATA || path.join(_home, 'AppData', 'Local'),
    'Packages', 'FrontierDevelopmentsplc.EliteDangerous_ndd7vt5srv5pe',
    'LocalCache', 'Local', 'Frontier Developments', 'Elite Dangerous'),
];

function findJournalDir(customPath) {
  // Custom path from user config always wins
  if (customPath && fs.existsSync(customPath)) return customPath;
  for (const p of JOURNAL_SEARCH_PATHS) {
    try {
      if (fs.existsSync(p) && fs.readdirSync(p).some(f => f.startsWith('Journal.'))) return p;
    } catch {}
  }
  // Second pass — accept any path that exists even without journal files yet
  for (const p of JOURNAL_SEARCH_PATHS) {
    try { if (fs.existsSync(p)) return p; } catch {}
  }
  return null;
}

// BGS-relevant Elite Dangerous journal event types
const BGS_EVENTS = new Set([
  'MissionCompleted', 'MissionAccepted', 'MissionAbandoned', 'MissionFailed',
  'BountyRedeemed', 'RedeemVoucher', 'FactionKillBond', 'CapShipBond',
  'MarketSell', 'MarketBuy',
  'SellExplorationData', 'MultiSellExplorationData',
  'FSDJump', 'Location', 'Docked', 'Undocked',
  'CargoDepot',
  // CZ tracking
  'SupercruiseDestinationDrop', 'SupercruiseEntry',
  'ApproachSettlement', 'ShipTargeted',
]);

// ── Compact CZ tracker (BGS-Tally engine for the Electron companion) ──────────
// Tracks space/ground CZ activity per system/faction and uploads via /api/bgs-tally.
const CZ_CONTEXT_MS   = 5 * 60 * 1000;
const CZ_CAPTAIN_RE   = /captain|commander/i;
const CZ_SPECOPS_RE   = /spec.*ops|special.*ops/i;

function _emptyCZFaction() {
  return {
    SpaceCZ:  { l:0, m:0, h:0, cs:0, cp:0, so:0 },
    GroundCZ: { l:0, m:0, h:0 },
  };
}

class CZTracker {
  constructor() {
    this.systems         = {};   // { sysName: { factions: { fName: _emptyCZFaction() }, addr } }
    this.currentSystem   = null;
    this.currentAddr     = null;
    this.lastSpaceCZ     = null; // { type, ts, lastPilot }
    this.spaceCZKills    = 0;
    this.lastSettlement  = null; // { name, ts }
    this.shipsTargeted   = {};   // pilot → { faction, ts }
    this.tickTime        = null;
    this._dirty          = false;
  }

  _faction(sysName, addr, fName) {
    if (!this.systems[sysName]) this.systems[sysName] = { addr, factions: {} };
    if (!this.systems[sysName].factions[fName]) this.systems[sysName].factions[fName] = _emptyCZFaction();
    return this.systems[sysName].factions[fName];
  }

  reset(tickTime) {
    this.systems        = {};
    this.tickTime       = tickTime;
    this.lastSpaceCZ    = null;
    this.spaceCZKills   = 0;
    this.lastSettlement = null;
    this._dirty         = false;
  }

  processEvent(ev) {
    try {
      switch (ev.event) {
        case 'FSDJump': case 'Location': case 'CarrierJump':
          this.currentSystem  = ev.StarSystem  || null;
          this.currentAddr    = ev.SystemAddress || null;
          this.lastSpaceCZ    = null;
          this.spaceCZKills   = 0;
          this.lastSettlement = null;
          break;
        case 'SupercruiseEntry':
          this.lastSpaceCZ  = null;
          this.spaceCZKills = 0;
          break;
        case 'SupercruiseDestinationDrop': {
          const t = ev.Type || '';
          let czType = null;
          if (/warzone_pointrace_lo|warzone_lo/i.test(t))  czType = 'l';
          else if (/warzone_pointrace_me|warzone_me/i.test(t)) czType = 'm';
          else if (/warzone_pointrace_hi|warzone_hi/i.test(t)) czType = 'h';
          if (czType) {
            this.lastSpaceCZ  = { type: czType, ts: Date.now(), lastPilot: null };
            this.spaceCZKills = 0;
          }
          break;
        }
        case 'ApproachSettlement':
          this.lastSettlement = { name: ev.Name || '', ts: Date.now() };
          break;
        case 'ShipTargeted':
          if (ev.TargetLocked && ev.Faction) {
            const pilot = ev.PilotName_Localised || ev.PilotName || '';
            if (pilot) this.shipsTargeted[pilot] = { faction: ev.Faction, ts: Date.now() };
            if (this.lastSpaceCZ) this.lastSpaceCZ.lastPilot = pilot;
          }
          break;
        case 'FactionKillBond': {
          const awarding = ev.AwardingFaction || '';
          if (!awarding || !this.currentSystem) break;
          const now = Date.now();
          // Ground CZ
          if (this.lastSettlement && (now - this.lastSettlement.ts) < CZ_CONTEXT_MS) {
            const reward = ev.Reward || 0;
            const czType = reward <= 5000 ? 'l' : reward <= 38000 ? 'm' : 'h';
            const fa = this._faction(this.currentSystem, this.currentAddr, awarding);
            const sName = this.lastSettlement.name;
            if (!fa._groundSeen) fa._groundSeen = {};
            if (!fa._groundSeen[sName]) { fa._groundSeen[sName] = true; fa.GroundCZ[czType]++; }
            this._dirty = true;
            break;
          }
          // Space CZ
          if (this.lastSpaceCZ && (now - this.lastSpaceCZ.ts) < CZ_CONTEXT_MS) {
            const czType = this.lastSpaceCZ.type;
            const fa = this._faction(this.currentSystem, this.currentAddr, awarding);
            if (this.spaceCZKills === 0) fa.SpaceCZ[czType]++;
            this.spaceCZKills++;
            const pilot = (this.lastSpaceCZ.lastPilot || '').toLowerCase();
            if (CZ_CAPTAIN_RE.test(pilot))      fa.SpaceCZ.cp++;
            else if (CZ_SPECOPS_RE.test(pilot)) fa.SpaceCZ.so++;
            this._dirty = true;
          }
          break;
        }
        case 'CapShipBond': {
          const awarding = ev.AwardingFaction || '';
          if (!awarding || !this.currentSystem) break;
          const fa = this._faction(this.currentSystem, this.currentAddr, awarding);
          fa.SpaceCZ.cs++;
          this._dirty = true;
          break;
        }
      }
    } catch {}
  }

  toUpload() {
    // Convert internal structure to the format the server expects
    const systems = {};
    for (const [sysName, sysData] of Object.entries(this.systems)) {
      systems[sysName] = { Factions: {} };
      for (const [fName, fa] of Object.entries(sysData.factions)) {
        systems[sysName].Factions[fName] = {
          SpaceCZ:  fa.SpaceCZ,
          GroundCZ: fa.GroundCZ,
        };
      }
    }
    return { tickTime: this.tickTime, currentSystem: this.currentSystem, systems };
  }

  isDirty() { return this._dirty; }
  markClean() { this._dirty = false; }
}

// ── Game file types ED writes automatically ───────────────────────────────────
// These are written by the game to the journal directory when the player
// opens the corresponding panel — perfectly accurate, no OCR needed.
const GAME_FILES = {
  'Status.json':     'status',      // real-time game state (docked, location, flags)
  'Market.json':     'market',      // commodities market — written when player opens it
  'Outfitting.json': 'outfitting',  // modules — written when player opens outfitting
  'Shipyard.json':   'shipyard',    // ships for sale — written when player opens shipyard
  'NavRoute.json':   'nav_route',   // plotted route
  'ModulesInfo.json':'modules',     // ship module loadout
  'Cargo.json':      'cargo',       // cargo manifest
};

// Fields to strip from Status.json to avoid leaking identity
const STATUS_STRIP = new Set(['Pips', 'Firegroup', 'GuiFocus']);

class JournalWatcher {
  constructor({ serverUrl, slug, cmdrName, sessionToken, journalDir, onStatus, onPathNeeded, onDocked, onUndocked }) {
    this.serverUrl    = serverUrl || 'https://elite-bgs.store';
    this.slug         = slug;
    this.cmdrName     = cmdrName;
    this.sessionToken = sessionToken;
    this.onStatus     = onStatus     || (() => {});
    this.onPathNeeded = onPathNeeded || (() => {});
    this.onDocked     = onDocked     || (() => {});
    this.onUndocked   = onUndocked   || (() => {});

    this.watchDir       = findJournalDir(journalDir) || null;
    this.watcher        = null;
    this.fileWatcher    = null;   // watches *.json game files in watchDir
    this.fileOffsets    = new Map();  // journal log file read positions
    this.jsonFileSizes  = new Map();  // game json file sizes (size-change detection)
    this.eventBatch     = [];
    this.uploadTimer    = null;
    this.sweepTimer     = null;
    this.jsonSweepTimer = null;   // separate 8s sweep for game json files
    this.running        = false;

    this.czTracker      = new CZTracker();
    this.tallyTimer     = null;   // debounce timer for bgs-tally uploads
    this.tickPollTimer  = null;   // polls tick.infomancer.uk every 5 min
  }

  updateCredentials({ slug, cmdrName, sessionToken, serverUrl }) {
    this.slug         = slug         || this.slug;
    this.cmdrName     = cmdrName     || this.cmdrName;
    this.sessionToken = sessionToken || this.sessionToken;
    this.serverUrl    = serverUrl    || this.serverUrl;
  }

  updateJournalDir(customPath) {
    const found = findJournalDir(customPath);
    if (!found) { this.onStatus('⚠ Journal path not found: ' + customPath); return false; }
    const wasRunning = this.running;
    if (wasRunning) this.stop();
    this.watchDir = found;
    this.onStatus('Journal folder set: ' + found);
    if (wasRunning) this.start();
    return true;
  }

  start() {
    if (this.running) return;

    // Re-check path in case it wasn't found at construction time
    if (!this.watchDir) this.watchDir = findJournalDir(null);

    if (!this.watchDir) {
      this.onStatus('⚠ Journal folder not found — please set path in settings.');
      this.onPathNeeded();
      return;
    }

    this.running = true;
    this._initialScan = true;   // true until chokidar finishes its first scan
    this.onStatus('Journal watcher starting…');

    // ── Watch journal log files ───────────────────────────────────────────────
    this.watcher = chokidar.watch(path.join(this.watchDir, 'Journal.*.log'), {
      persistent:       true,
      ignoreInitial:    false,
      awaitWriteFinish: { stabilityThreshold: 600, pollInterval: 150 },
    });

    this.watcher
      .on('add',    fp => this._onAdded(fp))
      .on('change', fp => this._onChanged(fp))
      .on('ready',  () => { this._initialScan = false; });

    // ── Watch ALL *.json files in watchDir (game state files) ────────────────
    this.fileWatcher = chokidar.watch(path.join(this.watchDir, '*.json'), {
      persistent:       true,
      ignoreInitial:    false,
      awaitWriteFinish: { stabilityThreshold: 300, pollInterval: 100 },
    });

    this.fileWatcher
      .on('add',    fp => this._onJsonFileAdded(fp))
      .on('change', fp => this._onJsonFileChanged(fp));

    // Every 30 minutes: sweep all known journal log files for size changes chokidar may have missed
    this.sweepTimer = setInterval(() => this._sweepAll(), 30 * 60 * 1000);

    // Every 8 seconds: sweep all known game json files for size changes
    this.jsonSweepTimer = setInterval(() => this._sweepJsonFiles(), 8000);

    // Poll galaxy tick every 5 minutes — resets CZ tally when a new tick fires
    this._checkTick();
    this.tickPollTimer = setInterval(() => this._checkTick(), 5 * 60 * 1000);

    this.onStatus('Journal watcher active ✓ — ' + this.watchDir);
  }

  stop() {
    if (!this.running) return;
    this.running = false;
    this.watcher?.close();
    this.fileWatcher?.close();
    clearInterval(this.sweepTimer);
    clearInterval(this.jsonSweepTimer);
    clearInterval(this.tickPollTimer);
    clearTimeout(this.uploadTimer);
    clearTimeout(this.tallyTimer);
    if (this.eventBatch.length) this._upload(true);
    this.onStatus('Journal watcher stopped.');
  }

  // ── Private ────────────────────────────────────────────────────────────────

  _onAdded(fp) {
    this.onStatus(`Journal: ${path.basename(fp)}`);
    if (!this.fileOffsets.has(fp)) {
      if (this._initialScan) {
        // File existed before the watcher started — seek to the end so we don't
        // replay already-sent events on every restart.
        try { this.fileOffsets.set(fp, fs.statSync(fp).size); } catch { this.fileOffsets.set(fp, 0); }
      } else {
        // Truly new log file created while we are running — read from the start.
        this.fileOffsets.set(fp, 0);
        this._readNewBytes(fp);
      }
    } else {
      this._readNewBytes(fp);
    }
  }

  _onChanged(fp) { this._readNewBytes(fp); }

  _readNewBytes(fp) {
    try {
      const stat   = fs.statSync(fp);
      const offset = this.fileOffsets.get(fp) || 0;
      if (stat.size <= offset) return;

      const fd  = fs.openSync(fp, 'r');
      const buf = Buffer.alloc(stat.size - offset);
      fs.readSync(fd, buf, 0, buf.length, offset);
      fs.closeSync(fd);

      this.fileOffsets.set(fp, stat.size);

      const lines = buf.toString('utf8').split('\n');
      let added = 0;

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        try {
          const ev = JSON.parse(trimmed);

          // Fire docked/undocked callbacks for GalNet Courier prompt lifecycle
          if (ev.event === 'Docked' && ev.StarSystem && ev.StationName) {
            this.onDocked({ systemName: ev.StarSystem, stationName: ev.StationName });
          }
          if (ev.event === 'Undocked') {
            this.onUndocked();
          }

          // Feed every journal event through the CZ tracker
          this.czTracker.processEvent(ev);

          if (BGS_EVENTS.has(ev.event)) {
            const clean = { ...ev };
            delete clean.UserLocalPart;
            delete clean.UserName;
            delete clean.FID;
            this.eventBatch.push(clean);
            added++;
          }
        } catch {}
      }

      if (added > 0) {
        this.onStatus(`+${added} event${added > 1 ? 's' : ''} queued`);
        this._scheduleUpload();
      }

      if (this.czTracker.isDirty()) {
        this._scheduleTallyUpload();
      }
    } catch (e) {
      this.onStatus(`⚠ Read error: ${e.message}`);
    }
  }

  _onJsonFileAdded(fp) {
    const filename = path.basename(fp);
    const fileType = GAME_FILES[filename];
    if (!fileType) return;   // ignore non-game JSON files
    try {
      const stat = fs.statSync(fp);
      this.jsonFileSizes.set(fp, stat.size);
      if (stat.size > 0) this._readGameFile(fp, filename, fileType);
    } catch {}
  }

  _onJsonFileChanged(fp) {
    const filename = path.basename(fp);
    const fileType = GAME_FILES[filename];
    if (!fileType) return;
    try {
      const stat    = fs.statSync(fp);
      const oldSize = this.jsonFileSizes.get(fp) || 0;
      if (stat.size === oldSize) return;   // no size change — skip
      this.jsonFileSizes.set(fp, stat.size);
      this._readGameFile(fp, filename, fileType);
    } catch {}
  }

  _sweepJsonFiles() {
    for (const [fp, oldSize] of this.jsonFileSizes) {
      try {
        const stat = fs.statSync(fp);
        if (stat.size !== oldSize) {
          const filename = path.basename(fp);
          const fileType = GAME_FILES[filename];
          if (fileType) {
            this.jsonFileSizes.set(fp, stat.size);
            this._readGameFile(fp, filename, fileType);
          }
        }
      } catch {}
    }
  }

  _readGameFile(fp, filename, fileType) {
    try {
      const raw = fs.readFileSync(fp, 'utf8').trim();
      if (!raw) return;

      const data = JSON.parse(raw);

      // Strip identity fields from Status.json
      if (fileType === 'status') {
        STATUS_STRIP.forEach(k => delete data[k]);
        // Only upload status when docked/landed/supercruise — skip mid-flight noise
        const flags = data.Flags || 0;
        const isDocked = !!(flags & 0x10);
        const isLanded = !!(flags & 0x04);
        const isSuper  = !!(flags & 0x20);
        if (!isDocked && !isLanded && !isSuper) return;
      }

      this._uploadGameFile(fileType, data, filename);
    } catch (e) {
      // Silently ignore — game sometimes writes partial JSON mid-update
    }
  }

  _uploadGameFile(fileType, data, filename) {
    if (!this.slug || !this.sessionToken || !this.cmdrName) return;

    const body = JSON.stringify({
      fileType,
      data,
      cmdrName: this.cmdrName,
    });

    try {
      const parsed = new URL(`${this.serverUrl}/t/${this.slug}/api/game-file`);
      const lib    = parsed.protocol === 'https:' ? https : http;

      const req = lib.request({
        hostname: parsed.hostname,
        port:     parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
        path:     parsed.pathname,
        method:   'POST',
        headers:  {
          'Content-Type':   'application/json',
          'Content-Length': Buffer.byteLength(body),
          'x-session-key':  this.sessionToken,
        },
      }, (res) => {
        let resp = '';
        res.on('data', c => resp += c);
        res.on('end', () => {
          if (res.statusCode === 200) {
            if (fileType !== 'status') {
              this.onStatus(`✓ ${filename} uploaded`);
            }
          }
        });
      });

      req.on('error', () => {}); // silently ignore network errors for game files
      req.write(body);
      req.end();
    } catch {}
  }

  _sweepAll() {
    for (const [fp] of this.fileOffsets) {
      try {
        const stat = fs.statSync(fp);
        if (stat.size > (this.fileOffsets.get(fp) || 0)) this._readNewBytes(fp);
      } catch {}
    }
  }

  _checkTick() {
    try {
      const lib = http;
      const req = lib.request({
        hostname: 'tick.infomancer.uk',
        path:     '/galtick.json',
        method:   'GET',
        timeout:  10000,
      }, (res) => {
        let data = '';
        res.on('data', c => data += c);
        res.on('end', () => {
          try {
            const obj  = JSON.parse(data);
            const tick = obj.lastTick || obj.tickTime || null;
            if (!tick) return;
            if (tick !== this.czTracker.tickTime) {
              this.czTracker.reset(tick);
            }
          } catch {}
        });
      });
      req.on('error', () => {});
      req.end();
    } catch {}
  }

  _scheduleTallyUpload() {
    if (this.tallyTimer) return;
    this.tallyTimer = setTimeout(() => {
      this.tallyTimer = null;
      this._uploadTally();
    }, 4000);
  }

  _uploadTally() {
    if (!this.czTracker.isDirty()) return;
    if (!this.slug || !this.sessionToken || !this.cmdrName) return;
    const tally = this.czTracker.toUpload();
    const body  = JSON.stringify({ cmdrName: this.cmdrName, tally });
    try {
      const parsed = new URL(`${this.serverUrl}/t/${this.slug}/api/bgs-tally`);
      const lib    = parsed.protocol === 'https:' ? https : http;
      const req    = lib.request({
        hostname: parsed.hostname,
        port:     parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
        path:     parsed.pathname,
        method:   'POST',
        headers:  {
          'Content-Type':   'application/json',
          'Content-Length': Buffer.byteLength(body),
          'x-session-key':  this.sessionToken,
        },
      }, (res) => {
        if (res.statusCode === 200) {
          this.czTracker.markClean();
          this.onStatus('CZ tally synced ✓');
        }
        res.resume();
      });
      req.on('error', () => {});
      req.write(body);
      req.end();
    } catch {}
  }

  _scheduleUpload() {
    if (this.uploadTimer) return;
    this.uploadTimer = setTimeout(() => {
      this.uploadTimer = null;
      this._upload(false);
    }, 3000);
  }

  _upload(immediate) {
    if (!this.eventBatch.length) return;
    if (!this.slug || !this.sessionToken || !this.cmdrName) {
      this.onStatus('⚠ Not logged in — events held');
      return;
    }

    const events = this.eventBatch.splice(0, 200);
    const body   = JSON.stringify({ events, cmdrName: this.cmdrName });

    try {
      const parsed = new URL(`${this.serverUrl}/t/${this.slug}/api/journal-stream`);
      const lib    = parsed.protocol === 'https:' ? https : http;

      const req = lib.request({
        hostname: parsed.hostname,
        port:     parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
        path:     parsed.pathname,
        method:   'POST',
        headers:  {
          'Content-Type':   'application/json',
          'Content-Length': Buffer.byteLength(body),
          'x-session-key':  this.sessionToken,
        },
      }, (res) => {
        let data = '';
        res.on('data', c => data += c);
        res.on('end', () => {
          if (res.statusCode === 200) {
            try {
              const parsed = JSON.parse(data);
              if (parsed.recorded === false) {
                this.onStatus(`✓ ${events.length} event${events.length > 1 ? 's' : ''} processed (no BGS activity)`);
              } else {
                this.onStatus(`✓ ${events.length} event${events.length > 1 ? 's' : ''} uploaded`);
              }
            } catch {
              this.onStatus(`✓ ${events.length} event${events.length > 1 ? 's' : ''} uploaded`);
            }
          } else {
            this.onStatus(`⚠ Upload ${res.statusCode}`);
            this.eventBatch.unshift(...events);
          }
        });
      });

      req.on('error', (e) => {
        this.onStatus(`⚠ Upload error: ${e.message}`);
        this.eventBatch.unshift(...events);
      });

      req.write(body);
      req.end();
    } catch (e) {
      this.onStatus(`⚠ Upload failed: ${e.message}`);
      this.eventBatch.unshift(...events);
    }
  }
}

module.exports = { JournalWatcher, findJournalDir, JOURNAL_SEARCH_PATHS };
