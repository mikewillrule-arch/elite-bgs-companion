#!/usr/bin/env node
'use strict';

/**
 * Elite BGS Intelligence Platform — Linux Companion v1.0
 *
 * Watches your Elite Dangerous journal directory and uploads journal events
 * and game file snapshots (Status.json, Market.json, NavRoute.json) to your
 * squadron's BGS platform in real time.
 *
 * Works with: Steam + Proton, Wine (default prefix), Lutris, custom paths.
 * Requires: Node.js 18+ (uses native fetch). Zero external dependencies.
 *
 * Usage:
 *   node companion.js              — start (runs setup wizard on first launch)
 *   node companion.js --setup      — re-run configuration wizard
 *   node companion.js --overlay    — also open the in-game overlay in a browser
 *   node companion.js --from-start — replay the current journal from the beginning
 */

const fs      = require('fs');
const path    = require('path');
const os      = require('os');
const rl_mod  = require('readline');
const { execSync, spawn } = require('child_process');

const VERSION      = '1.0.0';
const CONFIG_FILE  = path.join(__dirname, 'companion.conf');
const STATE_FILE   = path.join(__dirname, '.companion.state');
const FLUSH_DELAY  = 5000;   // ms — batch journal events before uploading
const GF_DEBOUNCE  = 600;    // ms — debounce game file writes
const RETRY_DELAY  = 30000;  // ms — retry when journal dir not found yet
const ED_APP_ID    = '359320';

// ── ANSI helpers ──────────────────────────────────────────────────────────────
const C = { reset:'\x1b[0m', bold:'\x1b[1m', dim:'\x1b[2m', cyan:'\x1b[36m', green:'\x1b[32m', amber:'\x1b[33m', red:'\x1b[31m' };
const cyan  = s => `${C.cyan}${s}${C.reset}`;
const green = s => `${C.green}${s}${C.reset}`;
const amber = s => `${C.amber}${s}${C.reset}`;
const red   = s => `${C.red}${s}${C.reset}`;
const dim   = s => `${C.dim}${s}${C.reset}`;
const bold  = s => `${C.bold}${s}${C.reset}`;

const ts   = () => new Date().toLocaleTimeString('en-GB', { hour12: false });
const log  = msg => console.log(`${dim(ts())}  ${msg}`);
const ok   = msg => console.log(`${dim(ts())}  ${green('✓')} ${msg}`);
const warn = msg => console.log(`${dim(ts())}  ${amber('⚠')} ${msg}`);
const fail = msg => console.log(`${dim(ts())}  ${red('✗')} ${msg}`);
const info = msg => console.log(`${dim(ts())}  ${cyan('◈')} ${msg}`);

// ── Config & state ────────────────────────────────────────────────────────────
function loadConfig() {
  if (!fs.existsSync(CONFIG_FILE)) return null;
  try { return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')); } catch { return null; }
}

function saveConfig(cfg) {
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(cfg, null, 2));
}

function loadState() {
  if (!fs.existsSync(STATE_FILE)) return {};
  try { return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); } catch { return {}; }
}

function saveState(state) {
  try { fs.writeFileSync(STATE_FILE, JSON.stringify(state)); } catch {}
}

// ── Journal directory auto-detection ─────────────────────────────────────────
function findJournalDirs() {
  const home        = os.homedir();
  const user        = os.userInfo().username;
  const edPath      = 'Saved Games/Frontier Developments/Elite Dangerous';
  const protonInfix = `pfx/drive_c/users/steamuser/${edPath}`;

  const candidates = [
    // Steam + Proton — most common Linux installation
    { label: 'Steam (Proton)',    dir: path.join(home, `.steam/steam/steamapps/compatdata/${ED_APP_ID}/${protonInfix}`) },
    { label: 'Steam XDG',         dir: path.join(home, `.local/share/Steam/steamapps/compatdata/${ED_APP_ID}/${protonInfix}`) },
    // Flatpak Steam
    { label: 'Steam (Flatpak)',   dir: path.join(home, `.var/app/com.valvesoftware.Steam/data/Steam/steamapps/compatdata/${ED_APP_ID}/${protonInfix}`) },
    // Wine (default ~/.wine prefix)
    { label: 'Wine (default)',    dir: path.join(home, `.wine/drive_c/users/${user}/${edPath}`) },
    // Common Lutris prefixes
    { label: 'Lutris',            dir: path.join(home, `Games/elite-dangerous/drive_c/users/${user}/${edPath}`) },
    { label: 'Lutris (store)',    dir: path.join(home, `Games/elite-dangerous-store/drive_c/users/${user}/${edPath}`) },
    { label: 'Lutris (epic)',     dir: path.join(home, `Games/elite-dangerous-epic/drive_c/users/${user}/${edPath}`) },
  ];

  // ── Secondary drive scan ────────────────────────────────────────────────────
  // Steam libraries on secondary drives are typically mounted under /mnt or
  // /media — the Windows companion handles D:/E:/F: equivalents; this does the
  // same for Linux mount points.
  const mountRoots = [];
  const _tryRead = dir => { try { return fs.readdirSync(dir); } catch { return []; } };

  _tryRead('/mnt').forEach(d => mountRoots.push(`/mnt/${d}`));
  _tryRead(`/media/${user}`).forEach(d => mountRoots.push(`/media/${user}/${d}`));
  // Also check /media directly for drive-named mounts (some distros skip the username subdir)
  _tryRead('/media').filter(d => d !== user).forEach(d => mountRoots.push(`/media/${d}`));

  for (const root of mountRoots) {
    // Standard Steam library layouts on secondary drives
    for (const libSub of ['SteamLibrary', 'Steam', 'steam', '']) {
      const base = libSub ? path.join(root, libSub) : root;
      candidates.push({ label: `Secondary drive ${root}${libSub ? '/' + libSub : ''}`, dir: path.join(base, 'steamapps', 'compatdata', ED_APP_ID, protonInfix) });
    }
    // Heroic Games Launcher (Proton) — common on secondary drives
    candidates.push({ label: `Heroic (${root})`, dir: path.join(root, 'Games', 'Heroic', 'Prefixes', 'elite-dangerous', 'pfx', 'drive_c', 'users', 'steamuser', edPath) });
    candidates.push({ label: `Heroic (${root})`, dir: path.join(root, 'Games', 'Heroic', 'Prefixes', 'EliteDangerous', 'pfx', 'drive_c', 'users', 'steamuser', edPath) });
  }

  return candidates.filter(c => { try { return fs.existsSync(c.dir); } catch { return false; } });
}

// ── Interactive setup wizard ──────────────────────────────────────────────────
async function runSetup() {
  const iface = rl_mod.createInterface({ input: process.stdin, output: process.stdout });
  const ask   = (q) => new Promise(res => iface.question(q, res));

  console.log(`\n${cyan('◈ ══════════════════════════════════════════════════════════')}`);
  console.log(`${cyan('◈')}  ${bold('ELITE BGS INTELLIGENCE PLATFORM')}  ${dim('Linux Companion')}`);
  console.log(`${cyan('◈ ══════════════════════════════════════════════════════════')}\n`);
  console.log(`  ${dim('This wizard configures your companion once.')}`);
  console.log(`  ${dim('Settings are saved to companion.conf — edit it any time.\n')}`);

  // Server URL
  const rawUrl = await ask(`  ${cyan('Server URL')} ${dim('[https://elite-bgs.store]')}: `);
  const serverUrl = (rawUrl.trim() || 'https://elite-bgs.store').replace(/\/$/, '');

  // Squadron slug
  const rawSlug = await ask(`  ${cyan('Squadron slug')} ${dim('(e.g. my-squadron, visible in your dashboard URL)')}: `);
  const slug = rawSlug.trim().toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '');
  if (!slug) { iface.close(); throw new Error('Squadron slug is required.'); }

  // CMDR name
  const cmdrName = (await ask(`  ${cyan('Your CMDR name')}: `)).trim();
  if (!cmdrName) { iface.close(); throw new Error('CMDR name is required.'); }

  // Password
  const password = (await ask(`  ${cyan('Your portal password')}: `)).trim();
  if (!password) { iface.close(); throw new Error('Password is required.'); }

  // Journal directory
  let journalDir = '';
  const found = findJournalDirs();

  if (found.length === 0) {
    warn('Could not auto-detect journal directory. Common install not found.');
    console.log(`  ${dim('Tip: it\'s the "Saved Games/Frontier Developments/Elite Dangerous" folder')}`);
    console.log(`  ${dim('     inside your Wine/Proton prefix.')}\n`);
    journalDir = (await ask(`  ${cyan('Journal directory path')}: `)).trim();
    if (!journalDir) { iface.close(); throw new Error('Journal directory is required.'); }
  } else if (found.length === 1) {
    ok(`Auto-detected: ${dim(found[0].label)}`);
    journalDir = found[0].dir;
  } else {
    console.log(`\n  ${cyan('Multiple locations found — pick one:')}`);
    found.forEach((f, i) => console.log(`  ${dim(`[${i+1}]`)} ${f.label}\n      ${dim(f.dir)}`));
    const pick = (await ask(`\n  ${cyan('Choice')} ${dim('[1]')}: `)).trim();
    const idx  = Math.max(0, Math.min(parseInt(pick || '1', 10) - 1, found.length - 1));
    journalDir = found[idx].dir;
    ok(`Selected: ${dim(found[idx].label)}`);
  }

  iface.close();

  const cfg = { serverUrl, slug, cmdrName, password, journalDir };
  saveConfig(cfg);

  console.log(`\n  ${green('Setup complete!')} Run ${cyan('node companion.js')} or ${cyan('./start.sh')} to begin.\n`);
  return cfg;
}

// ── HTTP helpers ──────────────────────────────────────────────────────────────
async function apiPost(url, token, body) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers['x-session-key'] = token;
  const res  = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body) });
  const data = await res.json().catch(() => ({}));
  return { status: res.status, ok: res.ok, data };
}

// ── Authentication ────────────────────────────────────────────────────────────
async function login(cfg) {
  info(`Authenticating CMDR ${bold(cfg.cmdrName)}...`);
  const { status, data } = await apiPost(
    `${cfg.serverUrl}/t/${cfg.slug}/api/users/login`,
    null,
    { cmdrName: cfg.cmdrName, password: cfg.password }
  );
  if (!data.ok) throw new Error(data.error || `HTTP ${status}`);
  ok(`Authenticated — ${bold(data.cmdrName)} [${data.rank || 'Member'}]`);
  return data.sessionToken;
}

// ── Journal upload ────────────────────────────────────────────────────────────
async function uploadEvents(cfg, token, events) {
  if (!events.length) return 'ok';
  const { status, ok: success, data } = await apiPost(
    `${cfg.serverUrl}/t/${cfg.slug}/api/journal-stream`,
    token,
    { cmdrName: cfg.cmdrName, events }
  );
  if (status === 401 || data.reauth_required) return 'reauth';
  if (!success) { warn(`Journal upload failed (${status}): ${data.error || ''}`); return 'error'; }
  if (data.recorded === false) {
    ok(`Processed ${cyan(String(events.length))} event(s) — no BGS activity recorded`);
    return 'ok';
  }
  const s = data.subStats || {};
  const parts = [];
  if (s.missionCount)     parts.push(`${s.missionCount} mission(s)`);
  if (s.bountiesRedeemed) parts.push(`${s.bountiesRedeemed} bounty(s)`);
  if (s.combatBonds)      parts.push(`${s.combatBonds} bond(s)`);
  if (s.tradeProfit)      parts.push(`${s.tradeProfit.toLocaleString()} Cr trade`);
  if (s.explorationData)  parts.push(`exploration data`);
  ok(`Uploaded ${cyan(String(events.length))} event(s)${parts.length ? ' — ' + parts.join(', ') : ''}`);
  if ((data.newMedals || []).length) info(`New medal(s) earned: ${data.newMedals.join(', ')}`);
  return 'ok';
}

// ── Game file upload ──────────────────────────────────────────────────────────
async function uploadGameFile(cfg, token, fileType, data) {
  const { status, ok: success, data: resp } = await apiPost(
    `${cfg.serverUrl}/t/${cfg.slug}/api/game-file`,
    token,
    { fileType, data, cmdrName: cfg.cmdrName }
  );
  if (status === 401 || resp.reauth_required) return 'reauth';
  if (!success) { warn(`Game file [${fileType}] upload failed (${status}): ${resp.error || ''}`); return 'error'; }
  ok(`Game file ${cyan('[' + fileType + ']')} sent`);
  return 'ok';
}

// ── GalNet Courier — screenshot capture via system tools ──────────────────────
// Tried in order; first binary found on $PATH wins.
// Each entry: [binary_name, fn(outFile) → shell_command_string]
const _SHOT_CMDS = [
  ['scrot',            f => `scrot -q 85 "${f}"`],
  ['import',           f => `import -window root -quality 85 "${f}"`],  // ImageMagick
  ['gnome-screenshot', f => `gnome-screenshot -f "${f}"`],
  ['grim',             f => `grim "${f}"`],                              // Wayland
  ['spectacle',        f => `spectacle -b -o "${f}"`],                   // KDE
];

function _detectShotTool() {
  for (const [bin] of _SHOT_CMDS) {
    try { execSync(`which ${bin} 2>/dev/null`, { stdio: 'ignore' }); return bin; } catch {}
  }
  return null;
}

function _takeScreenshot(bin, outFile) {
  const entry = _SHOT_CMDS.find(([b]) => b === bin);
  if (!entry) return false;
  try {
    execSync(entry[1](outFile), { timeout: 5000, stdio: 'ignore' });
    return fs.existsSync(outFile);
  } catch { return false; }
}

// BGS-relevant event types — only these are uploaded to the server
const BGS_EVENTS = new Set([
  'MissionCompleted', 'MissionAccepted', 'MissionAbandoned', 'MissionFailed',
  'BountyRedeemed', 'RedeemVoucher', 'FactionKillBond',
  'MarketSell', 'MarketBuy',
  'SellExplorationData', 'MultiSellExplorationData',
  'FSDJump', 'Location', 'Docked', 'Undocked',
  'CargoDepot',
]);

// ── Journal file helpers ──────────────────────────────────────────────────────
function getLatestJournal(dir) {
  try {
    const files = fs.readdirSync(dir)
      .filter(f => /^Journal\.\d{4}-\d{2}-\d{2}T\d{6}\.\d+\.log$/.test(f))
      .sort();
    return files.length ? path.join(dir, files[files.length - 1]) : null;
  } catch { return null; }
}

function parseJsonLines(text) {
  const events = [];
  for (const line of text.split('\n')) {
    const t = line.trim();
    if (!t) continue;
    try {
      const ev = JSON.parse(t);
      if (ev && ev.event) events.push(ev);
    } catch {}
  }
  return events;
}

// ── Main ──────────────────────────────────────────────────────────────────────
async function main() {
  const args = process.argv.slice(2);

  console.clear();
  console.log(`\n${cyan('◈')}  ${bold('Elite BGS Intelligence Platform')} ${dim('— Linux Companion v' + VERSION)}`);
  console.log(`${cyan('◈')}  ${dim('Journal & game-file upload daemon')}\n`);

  // Load or run setup
  let cfg = loadConfig();
  if (!cfg || args.includes('--setup')) {
    cfg = await runSetup();
    if (args.includes('--setup')) process.exit(0);
  }

  info(`Squadron : ${bold(cfg.slug)} @ ${dim(cfg.serverUrl)}`);
  info(`CMDR     : ${bold(cfg.cmdrName)}`);
  info(`Journals : ${dim(cfg.journalDir)}\n`);

  // Runtime state
  const state       = loadState();
  let   token       = state.sessionToken || null;
  let   needsReauth = !token;
  let   eventBuf    = [];
  let   flushTimer  = null;
  let   currentFile = null;   // path of journal file being tailed
  let   filePos     = 0;      // byte offset we've read up to
  let   dirWatcher  = null;
  let   fileWatcher = null;
  const gfTimers    = {};     // debounce timers keyed by filename

  // Game files to watch and their server fileType names
  const GAME_FILES = {
    'Status.json':   'status',
    'Market.json':   'market',
    'NavRoute.json': 'nav_route',
  };

  // ── Auth ──────────────────────────────────────────────────────────────────
  async function ensureAuth() {
    if (token && !needsReauth) return true;
    try {
      token       = await login(cfg);
      needsReauth = false;
      state.sessionToken = token;
      saveState(state);
      return true;
    } catch (e) {
      fail(`Auth failed: ${e.message}. Retrying in 30 s...`);
      await new Promise(r => setTimeout(r, 30000));
      return ensureAuth();
    }
  }

  // ── Event flush ───────────────────────────────────────────────────────────
  async function flushEvents() {
    if (!eventBuf.length) return;
    const batch = eventBuf.splice(0);
    if (!await ensureAuth()) { eventBuf.unshift(...batch); return; }
    const result = await uploadEvents(cfg, token, batch);
    if (result === 'reauth') { needsReauth = true; eventBuf.unshift(...batch); await flushEvents(); }
  }

  function scheduleFlush() {
    if (flushTimer) return;
    flushTimer = setTimeout(async () => { flushTimer = null; await flushEvents(); }, FLUSH_DELAY);
  }

  // ── GalNet Courier prompt ─────────────────────────────────────────────────
  let _galnetActive = false;

  async function promptGalnetCapture(systemName, stationName) {
    // Skip if already prompting, or if stdin is not a real terminal (daemon mode)
    if (_galnetActive || !process.stdin.isTTY) return;

    const tool = _detectShotTool();
    if (!tool) {
      warn('GalNet capture unavailable — install scrot, ImageMagick (import), grim, gnome-screenshot, or spectacle');
      return;
    }

    _galnetActive = true;
    console.log();
    console.log(`${cyan('◈')}  ${bold('GALNET COURIER')} — docked at ${bold(stationName)} in ${bold(systemName)}`);
    console.log(`   ${dim('Navigate to GalNet News at the station and scroll slowly through the articles.')}`);
    console.log(`   ${dim('The companion will capture 15 screenshots over 30 s and upload them for AI processing.')}`);
    console.log(`   ${dim('Couriers receive recognition in the squadron Discord. o7')}`);

    const iface  = rl_mod.createInterface({ input: process.stdin, output: process.stdout });
    const answer = await new Promise(resolve => iface.question(`\n  ${cyan('Capture GalNet news now? [y/N]')}: `, resolve));
    iface.close();

    if (answer.trim().toLowerCase() !== 'y') {
      console.log();
      _galnetActive = false;
      return;
    }

    console.log();
    info(`Using ${bold(tool)} — scroll through GalNet now!`);

    const screenshots = [];
    const tmpDir      = os.tmpdir();

    for (let i = 0; i < 15; i++) {
      await new Promise(r => setTimeout(r, 2000));
      const outFile = path.join(tmpDir, `galnet_${Date.now()}_${i}.jpg`);
      const ok_shot = _takeScreenshot(tool, outFile);
      if (ok_shot) {
        try {
          screenshots.push(fs.readFileSync(outFile).toString('base64'));
          fs.unlinkSync(outFile);
        } catch {}
      }
      process.stdout.write(`\r  ${cyan('◈')}  Captured ${i + 1} / 15   `);
    }
    console.log();

    if (!screenshots.length) {
      warn('No screenshots captured — aborting upload.');
      _galnetActive = false;
      return;
    }

    ok(`${screenshots.length} screenshot(s) captured — uploading to platform...`);
    if (!await ensureAuth()) { _galnetActive = false; return; }

    try {
      const { status, ok: success, data } = await apiPost(
        `${cfg.serverUrl}/t/${cfg.slug}/api/galnet-capture`,
        token,
        { screenshots, systemName, stationName, cmdrName: cfg.cmdrName }
      );
      if (success) {
        ok('GalNet intel uploaded! Thank you, Courier. o7');
      } else {
        warn(`Upload failed (${status}): ${data.error || ''}`);
      }
    } catch (e) {
      warn(`Upload error: ${e.message}`);
    }

    console.log();
    _galnetActive = false;
  }

  // ── Tail current journal file from filePos ────────────────────────────────
  function readNewJournalContent() {
    if (!currentFile) return;
    try {
      const stat = fs.statSync(currentFile);
      if (stat.size <= filePos) return;
      const fd  = fs.openSync(currentFile, 'r');
      const buf = Buffer.alloc(stat.size - filePos);
      fs.readSync(fd, buf, 0, buf.length, filePos);
      fs.closeSync(fd);
      filePos = stat.size;

      const allEvents = parseJsonLines(buf.toString('utf8'));
      const newEvents = allEvents.filter(ev => BGS_EVENTS.has(ev.event));
      if (!newEvents.length) return;

      for (const ev of newEvents) {
        log(`  + ${dim(ev.event)}${ev.StarSystem ? dim(' @ ' + ev.StarSystem) : ''}`);
        // Fire GalNet courier prompt on Docked events
        if (ev.event === 'Docked' && ev.StarSystem && ev.StationName) {
          promptGalnetCapture(ev.StarSystem, ev.StationName).catch(() => {});
        }
      }
      eventBuf.push(...newEvents);
      scheduleFlush();
    } catch (e) { warn(`Journal read error: ${e.message}`); }
  }

  // ── Switch to a journal file ──────────────────────────────────────────────
  async function switchJournal(filePath, fromPos) {
    // Flush anything pending from the previous file first
    if (fileWatcher) { try { fileWatcher.close(); } catch {} fileWatcher = null; }
    if (flushTimer)  { clearTimeout(flushTimer); flushTimer = null; }
    await flushEvents();

    currentFile = filePath;
    filePos     = fromPos;

    info(`Journal: ${bold(path.basename(filePath))}${fromPos === 0 ? '' : dim(' (from end)')}`);
    readNewJournalContent();

    fileWatcher = fs.watch(filePath, { persistent: true }, (eventType) => {
      if (eventType === 'change') readNewJournalContent();
    });
  }

  // ── Upload a game file (Market, Status, NavRoute) ─────────────────────────
  async function handleGameFile(filename) {
    const fileType = GAME_FILES[filename];
    if (!fileType) return;
    const fullPath = path.join(cfg.journalDir, filename);
    try {
      const raw  = fs.readFileSync(fullPath, 'utf8');
      const data = JSON.parse(raw);
      if (!await ensureAuth()) return;
      const result = await uploadGameFile(cfg, token, fileType, data);
      if (result === 'reauth') { needsReauth = true; await handleGameFile(filename); }
    } catch (e) { warn(`${filename}: ${e.message}`); }
  }

  // ── Watch the journal directory ───────────────────────────────────────────
  async function startWatching() {
    const dir = cfg.journalDir;

    if (!fs.existsSync(dir)) {
      warn(`Journal directory not found: ${dim(dir)}`);
      warn('Waiting for Elite Dangerous to start... (retrying in 30 s)');
      setTimeout(startWatching, RETRY_DELAY);
      return;
    }

    ok(`Watching ${cyan(dir)}`);

    // Start tailing the latest journal — from end (only new events going forward)
    const fromStart = args.includes('--from-start');
    const latest    = getLatestJournal(dir);
    if (latest) {
      const startPos = fromStart ? 0 : fs.statSync(latest).size;
      await switchJournal(latest, startPos);
      if (fromStart) info('Replaying current journal from the beginning...');
    } else {
      warn('No journal files yet — waiting for a game session to start...');
    }

    // Directory watcher — catches new journal files and game file changes
    dirWatcher = fs.watch(dir, { persistent: true }, async (eventType, filename) => {
      if (!filename) return;

      // New game session journal
      if (/^Journal\.\d{4}-\d{2}-\d{2}T\d{6}\.\d+\.log$/.test(filename)) {
        const fullPath = path.join(dir, filename);
        if (fullPath !== currentFile && fs.existsSync(fullPath)) {
          info(`New session journal detected: ${bold(filename)}`);
          await switchJournal(fullPath, 0);
        }
        return;
      }

      // Game file change — debounce rapid writes
      if (GAME_FILES[filename]) {
        if (gfTimers[filename]) clearTimeout(gfTimers[filename]);
        gfTimers[filename] = setTimeout(() => handleGameFile(filename), GF_DEBOUNCE);
      }
    });
  }

  // ── Overlay launcher ──────────────────────────────────────────────────────
  if (args.includes('--overlay')) {
    const overlayUrl = `${cfg.serverUrl}/t/${cfg.slug}/overlay`;
    info(`Opening overlay: ${cyan(overlayUrl)}`);
    // Try Chromium-family first (supports --app mode for borderless window)
    const browsers = [
      ['chromium-browser',      [`--app=${overlayUrl}`, '--always-on-top', '--window-size=480,860', '--window-position=1440,100']],
      ['chromium',              [`--app=${overlayUrl}`, '--always-on-top', '--window-size=480,860', '--window-position=1440,100']],
      ['google-chrome',         [`--app=${overlayUrl}`, '--always-on-top', '--window-size=480,860', '--window-position=1440,100']],
      ['google-chrome-stable',  [`--app=${overlayUrl}`, '--always-on-top', '--window-size=480,860', '--window-position=1440,100']],
      ['brave-browser',         [`--app=${overlayUrl}`, '--always-on-top', '--window-size=480,860']],
      ['firefox',               ['--new-window', overlayUrl]],
      ['xdg-open',              [overlayUrl]],
    ];
    let launched = false;
    for (const [bin, bargs] of browsers) {
      try {
        execSync(`which ${bin} 2>/dev/null`, { stdio: 'ignore' });
        spawn(bin, bargs, { detached: true, stdio: 'ignore' }).unref();
        ok(`Overlay opened in ${bold(bin)}`);
        launched = true;
        break;
      } catch {}
    }
    if (!launched) {
      warn('Could not find a browser to launch. Open this URL manually:');
      console.log(`\n  ${cyan(overlayUrl)}\n`);
    }
  }

  // ── Start ─────────────────────────────────────────────────────────────────
  await ensureAuth();
  await startWatching();
  info(`Companion running ${dim('— Ctrl+C to stop')}\n`);

  // Graceful shutdown
  process.on('SIGINT', async () => {
    console.log();
    info('Shutting down...');
    if (dirWatcher)  { try { dirWatcher.close();  } catch {} }
    if (fileWatcher) { try { fileWatcher.close(); } catch {} }
    if (flushTimer)  { clearTimeout(flushTimer); flushTimer = null; }
    await flushEvents();
    ok('Goodbye, Commander. o7');
    process.exit(0);
  });

  process.on('SIGTERM', () => process.emit('SIGINT'));
}

main().catch(e => {
  console.error(`\n${red('Fatal:')} ${e.message}`);
  process.exit(1);
});
