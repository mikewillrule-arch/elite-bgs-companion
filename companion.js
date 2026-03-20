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
 *   node companion.js --hud [#hex] — write squadron HUD colors to GraphicsConfigurationOverride.xml
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

  // EDDN contribution (opt-in — contributes market/outfitting/shipyard/route data to the community)
  console.log(`\n  ${dim('EDDN is a community data network used by EDDB, Inara, and other tools.')}`);
  const eddnRaw    = await ask(`  ${cyan('Contribute to EDDN data network?')} ${dim('[Y/n]')}: `);
  const eddnEnabled = eddnRaw.trim().toLowerCase() !== 'n';

  // EDSM (optional — tracks commander travel history and exploration data)
  console.log(`\n  ${dim('EDSM tracks your travel history and shares exploration data. (optional)')}`);
  const edsmCmdrName = (await ask(`  ${cyan('EDSM commander name')} ${dim('[blank to skip]')}: `)).trim();
  const edsmApiKey   = edsmCmdrName ? (await ask(`  ${cyan('EDSM API key')}: `)).trim() : '';

  // HUD color (optional — writes GraphicsConfigurationOverride.xml with squadron colors)
  console.log(`\n  ${dim('Apply a custom HUD color? Use your squadron primary color or any hex code.')}`);
  const hudRaw     = (await ask(`  ${cyan('HUD primary color')} ${dim('[#RRGGBB or blank to skip]')}: `)).trim();
  const hudPrimaryColor = /^#?[0-9a-fA-F]{6}$/.test(hudRaw) ? (hudRaw.startsWith('#') ? hudRaw : '#' + hudRaw) : '';

  iface.close();

  const cfg = { serverUrl, slug, cmdrName, password, journalDir, eddnEnabled, edsmCmdrName, edsmApiKey, hudPrimaryColor };
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
    _displayIntelAlerts(data.alerts);
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
  _displayIntelAlerts(data.alerts);
  return 'ok';
}

// ── Intel alert display & polling ─────────────────────────────────────────────
function _displayIntelAlerts(alerts) {
  if (!Array.isArray(alerts) || !alerts.length) return;
  for (const a of alerts) {
    if (a.type === 'territory_warning') {
      warn(`⚠  ${bold(a.system)} monitored by ${bold(a.monitoringSquadron)} — you have been detected`);
    } else if (a.type === 'cmdr_copresence') {
      const sq = a.otherSquadron ? ` ${dim('[' + a.otherSquadron + ']')}` : '';
      info(`◈  CMDR ${bold(a.otherCmdr)}${sq} is also in ${bold(a.system)}`);
    }
  }
}

async function pollIntelAlerts(cfg, token) {
  try {
    const res  = await fetch(
      `${cfg.serverUrl}/t/${cfg.slug}/api/companion-alerts?cmdrName=${encodeURIComponent(cfg.cmdrName)}`,
      { headers: { 'x-session-key': token }, signal: AbortSignal.timeout(10000) }
    );
    if (!res.ok) return;
    const data = await res.json().catch(() => ({}));
    _displayIntelAlerts(data.alerts);
  } catch {}
}

// ── BGS Tally upload ──────────────────────────────────────────────────────────
async function uploadTally(cfg, token, tally) {
  try {
    const { status, ok: success, data } = await apiPost(
      `${cfg.serverUrl}/t/${cfg.slug}/api/bgs-tally`,
      token,
      { cmdrName: cfg.cmdrName, tally: tally.toUpload() }
    );
    if (status === 401 || data.reauth_required) return 'reauth';
    if (!success) { warn(`BGS Tally upload failed (${status}): ${data.error || ''}`); return 'error'; }
    tally.markClean();
    return 'ok';
  } catch { return 'error'; }
}

// ── EDDN / EDSM helpers ───────────────────────────────────────────────────

// Strip all _Localised keys recursively
function stripLocalised(obj) {
  if (Array.isArray(obj)) return obj.map(stripLocalised);
  if (obj && typeof obj === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(obj)) {
      if (k.endsWith('_Localised')) continue;
      out[k] = stripLocalised(v);
    }
    return out;
  }
  return obj;
}

// Publish a message to the EDDN network
async function publishToEDDN(schemaType, version, message, cfg, state, gameCtx) {
  if (!cfg.eddnEnabled) return;
  try {
    const envelope = {
      '$schemaRef': `https://eddn.edcd.io/schemas/${schemaType}/${version}#`,
      header: {
        uploaderID:      cfg.cmdrName,
        softwareName:    EDDN_SOFTWARE,
        softwareVersion: VERSION,
        gameversion:     gameCtx.gameversion || '',
        gamebuild:       gameCtx.gamebuild   || '',
      },
      message,
    };
    const res = await fetch(EDDN_UPLOAD_URL, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify(envelope),
      signal:  AbortSignal.timeout(15000),
    });
    if (res.status !== 200) {
      const txt = await res.text().catch(() => '');
      warn(`EDDN ${schemaType}/${version} rejected (${res.status}): ${txt.trim().slice(0, 100)}`);
    }
  } catch { /* EDDN non-critical — swallow network errors */ }
}

// Report a journal event to EDSM (rate-limited: max 6/min = 360/hr)
let _edsmLastSent = 0;
async function reportToEDSM(ev, cfg) {
  if (!cfg.edsmCmdrName || !cfg.edsmApiKey) return;
  const now = Date.now();
  if (now - _edsmLastSent < 10000) return;
  _edsmLastSent = now;
  try {
    const body = new URLSearchParams({
      commanderName:       cfg.edsmCmdrName,
      apiKey:              cfg.edsmApiKey,
      fromSoftware:        EDDN_SOFTWARE,
      fromSoftwareVersion: VERSION,
      message:             JSON.stringify(ev),
    });
    await fetch(EDSM_JOURNAL_URL, {
      method:  'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body:    body.toString(),
      signal:  AbortSignal.timeout(15000),
    });
  } catch {}
}

// Build EDDN commodity/3 payload from Market.json data
function buildCommodityMessage(data, gameCtx) {
  if (!data.Items || !gameCtx.currentSystem) return null;
  const commodities = (data.Items || [])
    .filter(c => !c.Rare && c.Name && c.Category !== '$MARKET_category_NonMarketable;')
    .map(c => ({
      name:          c.Name.toLowerCase().replace(/^\$/, '').replace(/_name;$/, '').replace(/;$/, ''),
      meanPrice:     c.MeanPrice     || 0,
      buyPrice:      c.BuyPrice      || 0,
      stock:         c.Stock         || 0,
      stockBracket:  c.StockBracket  || 0,
      sellPrice:     c.SellPrice     || 0,
      demand:        c.Demand        || 0,
      demandBracket: c.DemandBracket || 0,
    }));
  if (!commodities.length) return null;
  return {
    systemName:  gameCtx.currentSystem,
    stationName: gameCtx.currentStation || data.StationName || '',
    marketId:    data.MarketID          || 0,
    horizons:    gameCtx.isHorizons     || false,
    odyssey:     gameCtx.isOdyssey      || false,
    timestamp:   data.timestamp         || new Date().toISOString(),
    commodities,
  };
}

// Build EDDN outfitting/2 payload from Outfitting.json data
function buildOutfittingMessage(data, gameCtx) {
  if (!data.Items || !gameCtx.currentSystem) return null;
  const modules = (data.Items || []).filter(m => m.Name).map(m => m.Name.toLowerCase());
  if (!modules.length) return null;
  return {
    systemName:  gameCtx.currentSystem,
    stationName: gameCtx.currentStation || data.StationName || '',
    marketId:    data.MarketID          || 0,
    horizons:    gameCtx.isHorizons     || false,
    odyssey:     gameCtx.isOdyssey      || false,
    timestamp:   data.timestamp         || new Date().toISOString(),
    modules,
  };
}

// Build EDDN shipyard/2 payload from Shipyard.json data
function buildShipyardMessage(data, gameCtx) {
  if (!data.PriceList || !gameCtx.currentSystem) return null;
  const ships = (data.PriceList || []).filter(s => s.ShipType).map(s => s.ShipType.toLowerCase());
  if (!ships.length) return null;
  return {
    systemName:  gameCtx.currentSystem,
    stationName: gameCtx.currentStation || data.StationName || '',
    marketId:    data.MarketID          || 0,
    horizons:    gameCtx.isHorizons     || false,
    odyssey:     gameCtx.isOdyssey      || false,
    timestamp:   data.timestamp         || new Date().toISOString(),
    ships,
  };
}

// Build EDDN navroute/1 payload from NavRoute.json data
function buildNavrouteMessage(data) {
  const route = (data.Route || [])
    .filter(r => r.StarSystem && r.SystemAddress)
    .map(({ StarSystem, SystemAddress, StarPos, StarClass }) => ({ StarSystem, SystemAddress, StarPos, StarClass }));
  if (!route.length) return null;
  return { timestamp: data.timestamp || new Date().toISOString(), Route: route };
}

// ── HUD color customization (GraphicsConfigurationOverride.xml) ───────────
// Derives the Options/Graphics directory from the journal directory.
// Journal sits at: [prefix]/drive_c/users/[user]/Saved Games/Frontier Developments/Elite Dangerous
// Graphics at:     [prefix]/drive_c/users/[user]/AppData/Local/Frontier Developments/Elite Dangerous/Options/Graphics
function findGraphicsConfigDir(journalDir) {
  const userDir = path.resolve(journalDir, '../../..');
  // Try AppData variants (Proton/Wine version dependent)
  const candidates = [
    path.join(userDir, 'AppData', 'Local', 'Frontier Developments', 'Elite Dangerous', 'Options', 'Graphics'),
    path.join(userDir, 'Local Settings', 'Application Data', 'Frontier Developments', 'Elite Dangerous', 'Options', 'Graphics'),
    path.join(userDir, 'Application Data', 'Frontier Developments', 'Elite Dangerous', 'Options', 'Graphics'),
  ];
  for (const p of candidates) { if (fs.existsSync(p)) return p; }
  return candidates[0]; // Return best-guess path even if it doesn't exist yet
}

// Convert a hex color to an Elite Dangerous HUD color matrix.
// The matrix maps the game's white source signal to the target color.
// Values outside 0–1 are normal; negative values suppress a channel.
function hexToHudMatrix(hex) {
  const h = hex.replace('#', '').padStart(6, '0');
  const r = parseInt(h.slice(0, 2), 16) / 255;
  const g = parseInt(h.slice(2, 4), 16) / 255;
  const b = parseInt(h.slice(4, 6), 16) / 255;

  // Scale each channel (range 0–3 is typical for Elite HUD matrices).
  // Clamp minimum to 0.05 so zero-channels produce dim output rather than pitch black.
  const scale = 3;
  const rs = Math.max(r, 0.05) * scale;
  const gs = Math.max(g, 0.05) * scale;
  const bs = Math.max(b, 0.05) * scale;
  const x  = 0.08; // cross-channel bleed (keeps shadows from going pure black)
  const fmt = v => String(Math.round(v * 100) / 100);

  return {
    matrixRed:   `${fmt(rs)}, ${fmt(gs * x)}, ${fmt(bs * x)}`,
    matrixGreen: `${fmt(rs * x)}, ${fmt(gs)}, ${fmt(bs * x)}`,
    matrixBlue:  `${fmt(rs * x)}, ${fmt(gs * x)}, ${fmt(bs)}`,
  };
}

// Write (or overwrite) GraphicsConfigurationOverride.xml with the given primary color.
function writeHudColorConfig(journalDir, primaryHex) {
  const gfxDir = findGraphicsConfigDir(journalDir);
  fs.mkdirSync(gfxDir, { recursive: true });
  const m    = hexToHudMatrix(primaryHex);
  const xml  = `<?xml version="1.0" encoding="UTF-8" ?>\n<GraphicsConfig>\n   <GUIColour>\n      <Default>\n         <LocalisationName>Standard</LocalisationName>\n         <MatrixRed>${m.matrixRed}</MatrixRed>\n         <MatrixGreen>${m.matrixGreen}</MatrixGreen>\n         <MatrixBlue>${m.matrixBlue}</MatrixBlue>\n      </Default>\n   </GUIColour>\n</GraphicsConfig>\n`;
  const dest = path.join(gfxDir, 'GraphicsConfigurationOverride.xml');
  fs.writeFileSync(dest, xml, 'utf8');
  return dest;
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

// BGS-relevant event types uploaded raw to the server (server-side journal processing)
const BGS_EVENTS = new Set([
  'MissionCompleted', 'MissionAccepted', 'MissionAbandoned', 'MissionFailed',
  'RedeemVoucher', 'FactionKillBond', 'Bounty', 'CapShipBond',
  'MarketSell', 'MarketBuy',
  'SellExplorationData', 'MultiSellExplorationData', 'SellOrganicData',
  'SearchAndRescue', 'CommitCrime',
  'FSDJump', 'Location', 'Docked', 'Undocked', 'CarrierJump', 'StartUp',
  'CargoDepot',
]);

// ── EDDN / EDSM integration ────────────────────────────────────────────────
const EDDN_UPLOAD_URL  = 'https://eddn.edcd.io:4430/upload/';
const EDSM_JOURNAL_URL = 'https://www.edsm.net/api-journal-v1';
const EDDN_SOFTWARE    = 'Elite-BGS-Intelligence-Platform';

// Journal events forwarded to EDDN (journal/1 schema)
const EDDN_JOURNAL_EVENTS = new Set([
  'FSDJump', 'Location', 'Docked', 'Scan', 'ScanBaryCentre',
  'NavBeaconDetail', 'FSSBodySignals', 'FSSSignalDiscovered',
  'SAASignalsFound', 'CodexEntry',
]);

// Journal events reported to EDSM
const EDSM_EVENTS = new Set([
  'FSDJump', 'Location', 'Docked', 'Scan', 'ScanBaryCentre',
  'FSSBodySignals', 'FSSSignalDiscovered', 'SAASignalsFound',
  'SupercruiseExit', 'ApproachBody', 'LeaveBody', 'Touchdown',
  'Liftoff', 'FuelScoop', 'NavBeaconDetail', 'CodexEntry',
]);

// ── BGS Tally engine ──────────────────────────────────────────────────────────
// Mirrors the logic from BGS-Tally (https://github.com/aussig/BGS-Tally).
// Processes ALL journal events locally and builds a detailed per-system,
// per-faction activity breakdown — missions by influence level, bounties,
// combat bonds, conflict zone kills, search & rescue, exploration data, etc.
// This is much more complete than the simple server-side submission stats.

const TALLY_FILE = path.join(__dirname, '.companion.tally.json');

const SANDR_ITEMS = {
  damagedescapepod: 'dp', occupiedcryopod: 'op', thargoidpod: 'tp',
  usscargoblackbox: 'bb', wreckagecomponents: 'wc', personaleffects: 'pe',
  politicalprisoner: 'pp', hostage: 'h',
};

// Combat bond reward → Thargoid type (ascending order so first match wins)
const TW_CBS = [
  [25000, 'r'], [80000, 's'], [1000000, 'ba'], [4500000, 'sg'],
  [8000000, 'c'], [15000000, 'o'], [24000000, 'b'], [40000000, 'm'], [60000000, 'h'],
];

const CZ_CONTEXT_MS      = 5 * 60 * 1000; // 5-minute CZ context window
const CZ_CAPTAIN_RE      = /captain|lieutenant|specialist|wing\s*commander/i;
const CZ_SPECOPS_RE      = /spec\s*ops|special\s*operations/i;
const CZ_CORRESPONDENT_RE = /correspondent|journalist|reporter|propagandist/i;

function _emptyFaction(name) {
  return {
    Faction:               name,
    MissionPoints:         { '1':0, '2':0, '3':0, '4':0, '5':0 },
    MissionPointsSecondary:{ '1':0, '2':0, '3':0, '4':0, '5':0 },
    MissionFailed:         0,
    Bounties:              0,
    CombatBonds:           0,
    TradeBuy:  [{items:0,value:0},{items:0,value:0},{items:0,value:0},{items:0,value:0}],
    TradeSell: [{items:0,value:0,profit:0},{items:0,value:0,profit:0},{items:0,value:0,profit:0},{items:0,value:0,profit:0}],
    BlackMarketProfit:     0,
    CartData:              0,
    ExoData:               0,
    GroundCZ:              { l:0, m:0, h:0 },
    GroundCZSettlements:   {},
    SpaceCZ:               { l:0, m:0, h:0, cs:0, cp:0, so:0, pr:0 },
    Scenarios:             0,
    Murdered:              0,
    GroundMurdered:        0,
    SandR:                 { dp:0, op:0, tp:0, bb:0, wc:0, pe:0, pp:0, h:0 },
  };
}

class BGSTally {
  constructor() { this._init(); }

  _init() {
    // Persistent tally data
    this.tickId         = null;
    this.tickTime       = null;
    this.systems        = {};   // systemName → { System, SystemAddress, Factions:{} }

    // Context state (not persisted — rebuilt from journal)
    this.currentSystem  = null;
    this.currentAddr    = null;
    this.stationFaction = null;
    this.isFC           = false;           // at a fleet carrier
    this.missionLog     = new Map();       // missionId → mission data
    this.shipsTargeted  = {};             // pilotName → { faction, ts }
    this.lastSettlement = null;           // { name, ts }
    this.lastSpaceCZ    = null;           // { type, ts, lastPilot }
    this.lastMegaship   = null;           // { name, ts }
    this.spaceCZKills   = 0;
    this._dirty         = false;
  }

  // ── Tick handling ────────────────────────────────────────────────────────────
  setTick(tickId, tickTime) {
    this.tickId   = tickId;
    this.tickTime = tickTime;
  }

  newTick(tickId, tickTime) {
    const savedMissions = new Map(this.missionLog);
    this._init();
    this.tickId      = tickId;
    this.tickTime    = tickTime;
    this.missionLog  = savedMissions;   // missions survive tick boundaries
    this._dirty      = true;
    log(`BGS Tally: new tick ${tickId}`);
  }

  // ── State helpers ────────────────────────────────────────────────────────────
  _sys(systemName, addr) {
    if (!systemName) return null;
    if (!this.systems[systemName]) {
      this.systems[systemName] = { System: systemName, SystemAddress: String(addr || ''), Factions: {} };
    }
    return this.systems[systemName];
  }

  _faction(systemName, addr, factionName) {
    if (!systemName || !factionName) return null;
    const sys = this._sys(systemName, addr);
    if (!sys.Factions[factionName]) sys.Factions[factionName] = _emptyFaction(factionName);
    return sys.Factions[factionName];
  }

  _sysForAddr(addr) {
    if (!addr) return null;
    for (const [name, s] of Object.entries(this.systems)) {
      if (String(s.SystemAddress) === String(addr)) return name;
    }
    return null;
  }

  // ── Event dispatcher ─────────────────────────────────────────────────────────
  processEvent(ev) {
    try {
      switch (ev.event) {
        case 'StartUp': case 'Location': case 'FSDJump': case 'CarrierJump':
          this._onLocation(ev); break;
        case 'Docked':     this._onDocked(ev);   break;
        case 'Undocked':   this.stationFaction = null; this.stationName = null; this.isFC = false; break;
        case 'SupercruiseEntry': this.lastSpaceCZ = null; this.spaceCZKills = 0; break;

        case 'MissionAccepted':  this._onMissionAccepted(ev);  break;
        case 'MissionCompleted': this._onMissionCompleted(ev); break;
        case 'MissionFailed': case 'MissionAbandoned': this._onMissionFailed(ev); break;

        case 'Bounty':           this._onBounty(ev);          break;
        case 'FactionKillBond':  this._onKillBond(ev);        break;
        case 'CapShipBond':      this._onCapShipBond(ev);     break;
        case 'RedeemVoucher':    this._onRedeemVoucher(ev);   break;

        case 'MarketBuy':        this._onMarketBuy(ev);       break;
        case 'MarketSell':       this._onMarketSell(ev);      break;

        case 'SellExplorationData': case 'MultiSellExplorationData':
          this._onSellExploration(ev); break;
        case 'SellOrganicData':  this._onSellOrganic(ev);     break;
        case 'SearchAndRescue':  this._onSandR(ev);           break;
        case 'CommitCrime':      this._onCommitCrime(ev);     break;
        case 'ShipTargeted':     this._onShipTargeted(ev);    break;

        case 'ApproachSettlement':         this._onApproachSettlement(ev);    break;
        case 'SupercruiseDestinationDrop': this._onSupercrDropDrop(ev);       break;
      }
    } catch {}
  }

  // ── Location ─────────────────────────────────────────────────────────────────
  _onLocation(ev) {
    this.currentSystem = ev.StarSystem || null;
    this.currentAddr   = ev.SystemAddress || null;
    if (ev.Docked && ev.StationFaction) {
      this.stationFaction = ev.StationFaction.Name || null;
      this.isFC = (ev.StationType || '').toLowerCase().includes('fleetcarrier');
    } else {
      this.stationFaction = null;
      this.isFC = false;
    }
    // Clear CZ context on system change
    this.lastSpaceCZ  = null;
    this.spaceCZKills = 0;
    this.lastSettlement = null;
  }

  _onDocked(ev) {
    this.stationFaction = ev.StationFaction?.Name || null;
    this.isFC = (ev.StationType || '').toLowerCase().includes('fleetcarrier');
  }

  // ── Missions ──────────────────────────────────────────────────────────────────
  _onMissionAccepted(ev) {
    if (!ev.MissionID) return;
    this.missionLog.set(ev.MissionID, {
      Faction:           ev.Faction           || '',
      System:            this.currentSystem,
      SystemAddress:     this.currentAddr,
      TargetFaction:     ev.TargetFaction      || null,
      Name:              ev.Name               || '',
    });
  }

  _onMissionCompleted(ev) {
    const logged = this.missionLog.get(ev.MissionID);
    if (!logged) return;
    this.missionLog.delete(ev.MissionID);

    for (const fe of (ev.FactionEffects || [])) {
      const fName = fe.Faction;
      if (!fName) continue;

      const infArr = fe.Influence || [];
      if (!infArr.length) {
        // Fallback for election/war missions with no influence data
        const missionName = (ev.Name || logged.Name || '').toLowerCase();
        const isWar  = /war|assault|destroy|massacre|conflict/.test(missionName);
        const isElec = /election|democracy/.test(missionName);
        const lvl    = isWar ? '2' : isElec ? '1' : null;
        if (lvl && fName === logged.Faction && logged.System) {
          const fa = this._faction(logged.System, logged.SystemAddress, fName);
          if (fa) { fa.MissionPoints[lvl]++; this._dirty = true; }
        }
        continue;
      }

      for (const inf of infArr) {
        const infStr = inf.Influence || '';
        const level  = Math.min((infStr.match(/\+/g) || []).length, 5);
        if (!level) continue;
        const lvlKey = String(level);
        const addr   = inf.SystemAddress || logged.SystemAddress || this.currentAddr;
        const sys    = this._sysForAddr(addr) || logged.System || this.currentSystem;
        if (!sys) continue;

        const isPositive = (inf.Trend || '').includes('Good');
        const isPrimary  = fName === logged.Faction;
        const fa = this._faction(sys, addr, fName);
        if (!fa) continue;

        if (isPrimary) {
          fa.MissionPoints[lvlKey] += isPositive ? 1 : -1;
        } else {
          fa.MissionPointsSecondary[lvlKey] += isPositive ? 1 : -1;
        }
        this._dirty = true;
      }
    }
  }

  _onMissionFailed(ev) {
    const logged = this.missionLog.get(ev.MissionID);
    if (!logged || !logged.Faction || !logged.System) return;
    this.missionLog.delete(ev.MissionID);
    const fa = this._faction(logged.System, logged.SystemAddress, logged.Faction);
    if (fa) { fa.MissionFailed++; this._dirty = true; }
  }

  // ── Combat ───────────────────────────────────────────────────────────────────
  _onBounty(ev) {
    const victim = ev.VictimFaction || '';
    const reward = ev.TotalReward || ev.Reward || 0;

    // Thargoid War kill
    if (/thargoid/i.test(victim) || victim === '$faction_thargoid;') {
      const entry = TW_CBS.find(([max]) => reward <= max);
      if (entry && this.currentSystem) {
        const sys = this._sys(this.currentSystem, this.currentAddr);
        if (sys) {
          if (!sys.TWKills) sys.TWKills = { r:0, s:0, ba:0, sg:0, c:0, b:0, m:0, h:0, o:0 };
          sys.TWKills[entry[1]]++;
          this._dirty = true;
        }
      }
      return;
    }

    // Megaship scenario — a bounty within 5 min of approaching a megaship
    if (this.lastMegaship && (Date.now() - this.lastMegaship.ts) < CZ_CONTEXT_MS && victim && this.currentSystem) {
      const fa = this._faction(this.currentSystem, this.currentAddr, victim);
      if (fa) { fa.Scenarios++; this._dirty = true; }
    }
  }

  _onKillBond(ev) {
    const awarding = ev.AwardingFaction || '';
    const victim   = ev.VictimFaction   || '';
    const reward   = ev.Reward || 0;

    // Thargoid War kill bond
    if (/thargoid/i.test(victim) || victim === '$faction_thargoid;') {
      const entry = TW_CBS.find(([max]) => reward <= max);
      if (entry && this.currentSystem) {
        const sys = this._sys(this.currentSystem, this.currentAddr);
        if (sys) {
          if (!sys.TWKills) sys.TWKills = { r:0, s:0, ba:0, sg:0, c:0, b:0, m:0, h:0, o:0 };
          sys.TWKills[entry[1]]++;
          this._dirty = true;
        }
      }
      return;
    }

    if (!awarding || !this.currentSystem) return;
    const now = Date.now();

    // Ground CZ — within 5 min of approaching a settlement
    if (this.lastSettlement && (now - this.lastSettlement.ts) < CZ_CONTEXT_MS) {
      const czType = reward <= 5000 ? 'l' : reward <= 38000 ? 'm' : 'h';
      const fa     = this._faction(this.currentSystem, this.currentAddr, awarding);
      if (fa) {
        const sName = this.lastSettlement.name;
        if (!fa.GroundCZSettlements[sName]) {
          fa.GroundCZSettlements[sName] = { count: 0, type: czType };
          fa.GroundCZ[czType]++;  // count CZ once when first seen
        }
        fa.GroundCZSettlements[sName].count++;
        this._dirty = true;
      }
      return;
    }

    // Space CZ — within 5 min of dropping into a CZ zone
    if (this.lastSpaceCZ && (now - this.lastSpaceCZ.ts) < CZ_CONTEXT_MS) {
      const czType = this.lastSpaceCZ.type;
      const fa     = this._faction(this.currentSystem, this.currentAddr, awarding);
      if (fa) {
        if (this.spaceCZKills === 0) fa.SpaceCZ[czType]++; // count CZ on first kill
        this.spaceCZKills++;
        // Special objectives from last targeted ship
        const pilot = (this.lastSpaceCZ.lastPilot || '').toLowerCase();
        if (CZ_CAPTAIN_RE.test(pilot))       fa.SpaceCZ.cp++;
        else if (CZ_SPECOPS_RE.test(pilot))  fa.SpaceCZ.so++;
        else if (CZ_CORRESPONDENT_RE.test(pilot)) fa.SpaceCZ.pr++;
        this._dirty = true;
      }
    }
  }

  _onCapShipBond(ev) {
    const awarding = ev.AwardingFaction || '';
    if (!awarding || !this.currentSystem) return;
    const fa = this._faction(this.currentSystem, this.currentAddr, awarding);
    if (fa) { fa.SpaceCZ.cs++; this._dirty = true; }
  }

  _onRedeemVoucher(ev) {
    if (!this.stationFaction || !this.currentSystem) return;
    const type     = (ev.Type || '').toLowerCase();
    const factions = ev.Factions || [];

    if (type === 'bounty') {
      const div = this.isFC ? 2 : 1;
      for (const f of factions) {
        if (!f.Faction || !f.Amount) continue;
        const fa = this._faction(this.currentSystem, this.currentAddr, f.Faction);
        if (fa) { fa.Bounties += Math.floor(f.Amount / div); this._dirty = true; }
      }
    } else if (type === 'combatbond') {
      for (const f of factions) {
        if (!f.Faction || !f.Amount) continue;
        const fa = this._faction(this.currentSystem, this.currentAddr, f.Faction);
        if (fa) { fa.CombatBonds += f.Amount; this._dirty = true; }
      }
    }
  }

  // ── Trade ────────────────────────────────────────────────────────────────────
  _onMarketBuy(ev) {
    if (!this.stationFaction || !this.currentSystem) return;
    const fa  = this._faction(this.currentSystem, this.currentAddr, this.stationFaction);
    const idx = Math.max(0, Math.min(3, ev.StockBracket ?? 0));
    if (fa) { fa.TradeBuy[idx].items += ev.Count || 0; fa.TradeBuy[idx].value += ev.TotalCost || 0; this._dirty = true; }
  }

  _onMarketSell(ev) {
    if (!this.stationFaction || !this.currentSystem) return;
    const fa     = this._faction(this.currentSystem, this.currentAddr, this.stationFaction);
    const items  = ev.Count || 0;
    const value  = ev.TotalSale || 0;
    const profit = value - (items * (ev.AvgPricePaid || 0));
    if (!fa) return;
    if (ev.BlackMarket) {
      fa.BlackMarketProfit += profit;
    } else {
      const idx = Math.max(0, Math.min(3, ev.DemandBracket ?? 0));
      fa.TradeSell[idx].items += items;
      fa.TradeSell[idx].value += value;
      fa.TradeSell[idx].profit += profit;
    }
    this._dirty = true;
  }

  // ── Exploration / Science ─────────────────────────────────────────────────────
  _onSellExploration(ev) {
    if (!this.stationFaction || !this.currentSystem) return;
    const fa  = this._faction(this.currentSystem, this.currentAddr, this.stationFaction);
    const val = ev.TotalEarnings || ((ev.BaseValue || 0) + (ev.Bonus || 0));
    if (fa && val) { fa.CartData += val; this._dirty = true; }
  }

  _onSellOrganic(ev) {
    if (!this.stationFaction || !this.currentSystem) return;
    const val = (ev.BioData || []).reduce((s, b) => s + (b.Value || 0) + (b.Bonus || 0), 0);
    if (!val) return;
    const fa = this._faction(this.currentSystem, this.currentAddr, this.stationFaction);
    if (fa) { fa.ExoData += val; this._dirty = true; }
  }

  // ── Search & Rescue ──────────────────────────────────────────────────────────
  _onSandR(ev) {
    if (!this.stationFaction || !this.currentSystem) return;
    const key = SANDR_ITEMS[(ev.Name || '').toLowerCase()];
    if (!key) return;
    const fa = this._faction(this.currentSystem, this.currentAddr, this.stationFaction);
    if (fa) { fa.SandR[key] += ev.Count || 0; this._dirty = true; }
  }

  // ── Crime ────────────────────────────────────────────────────────────────────
  _onCommitCrime(ev) {
    if (!this.currentSystem) return;
    if (ev.CrimeType === 'murder') {
      const info = this.shipsTargeted[ev.Victim || ''];
      if (info?.faction) {
        const fa = this._faction(this.currentSystem, this.currentAddr, info.faction);
        if (fa) { fa.Murdered++; this._dirty = true; }
      }
    } else if (ev.CrimeType === 'onFoot_murder' && ev.Faction) {
      const fa = this._faction(this.currentSystem, this.currentAddr, ev.Faction);
      if (fa) { fa.GroundMurdered++; this._dirty = true; }
    }
  }

  _onShipTargeted(ev) {
    if (!ev.TargetLocked || !ev.Faction) return;
    const pilot = ev.PilotName_Localised || ev.PilotName || '';
    if (pilot) this.shipsTargeted[pilot] = { faction: ev.Faction, ts: Date.now() };
    if (this.lastSpaceCZ) this.lastSpaceCZ.lastPilot = pilot;
  }

  // ── CZ context ───────────────────────────────────────────────────────────────
  _onApproachSettlement(ev) {
    this.lastSettlement = { name: ev.Name || '', ts: Date.now() };
  }

  _onSupercrDropDrop(ev) {
    const t = ev.Type || '';
    let czType = null;
    if (/warzone_pointrace_lo|warzone_lo/i.test(t))  czType = 'l';
    else if (/warzone_pointrace_me|warzone_me/i.test(t)) czType = 'm';
    else if (/warzone_pointrace_hi|warzone_hi/i.test(t)) czType = 'h';

    if (czType) {
      this.lastSpaceCZ  = { type: czType, ts: Date.now(), lastPilot: null };
      this.spaceCZKills = 0;
      return;
    }
    // Megaship: "XYZ-123 ship name" pattern
    if (/^[a-z]{3}-\d{3}\s/i.test(t)) {
      this.lastMegaship = { name: t, ts: Date.now() };
    }
  }

  // ── Serialization ────────────────────────────────────────────────────────────
  toUpload() {
    return { tickId: this.tickId, tickTime: this.tickTime, currentSystem: this.currentSystem, systems: this.systems };
  }

  toJSON() {
    return { tickId: this.tickId, tickTime: this.tickTime, systems: this.systems };
  }

  isDirty()    { return this._dirty; }
  markClean()  { this._dirty = false; }
}

function loadTallyFile() {
  try {
    if (fs.existsSync(TALLY_FILE)) return JSON.parse(fs.readFileSync(TALLY_FILE, 'utf8'));
  } catch {}
  return null;
}

function saveTallyFile(tally) {
  try { fs.writeFileSync(TALLY_FILE, JSON.stringify(tally.toJSON())); } catch {}
}

// Fetch latest galaxy tick time from tick.infomancer.uk
async function fetchLatestTick() {
  try {
    const res  = await fetch('http://tick.infomancer.uk/galtick.json', { signal: AbortSignal.timeout(10000) });
    const data = await res.json();
    return data.lastGalaxyTick || null;
  } catch { return null; }
}

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
  info(`Journals : ${dim(cfg.journalDir)}`);
  info(`EDDN     : ${cfg.eddnEnabled ? green('contributing') : dim('disabled')}`);
  if (cfg.edsmCmdrName) info(`EDSM     : ${green('enabled')} ${dim('(CMDR ' + cfg.edsmCmdrName + ')')}`);
  if (cfg.hudPrimaryColor) info(`HUD      : ${bold(cfg.hudPrimaryColor)} ${dim('— run --hud to re-apply after game update')}`);
  console.log();

  // Auto-apply HUD color on startup (idempotent — just overwrites the file)
  if (cfg.hudPrimaryColor && !args.includes('--hud')) {
    try {
      writeHudColorConfig(cfg.journalDir, cfg.hudPrimaryColor);
    } catch { /* Non-critical — journal dir may not be accessible yet */ }
  }

  // Runtime state
  const state       = loadState();

  // Generate a persistent EDDN uploader ID (hashed by relay before distribution)
  if (!state.eddnUploaderId) {
    const { randomUUID } = require('crypto');
    state.eddnUploaderId = randomUUID();
    saveState(state);
  }

  // Game context — updated from journal events, used for EDDN message headers
  const gameCtx = {
    gameversion:    '',
    gamebuild:      '',
    currentSystem:  null,
    currentAddr:    null,
    currentStarPos: null,
    currentStation: null,
    currentMarketId: null,
    isHorizons:     false,
    isOdyssey:      false,
  };

  let   token       = state.sessionToken || null;
  let   needsReauth = !token;
  let   eventBuf    = [];
  let   flushTimer  = null;
  let   currentFile = null;   // path of journal file being tailed
  let   filePos     = 0;      // byte offset we've read up to
  let   dirWatcher  = null;
  let   fileWatcher = null;
  const gfTimers    = {};     // debounce timers keyed by filename

  // ── BGS Tally ─────────────────────────────────────────────────────────────
  const bgsTally = new BGSTally();
  // Restore tally from local file (survives companion restarts within a tick)
  const savedTally = loadTallyFile();
  if (savedTally) {
    bgsTally.tickId   = savedTally.tickId   || null;
    bgsTally.tickTime = savedTally.tickTime || null;
    bgsTally.systems  = savedTally.systems  || {};
    if (bgsTally.tickId) info(`BGS Tally restored — tick ${bgsTally.tickId}`);
  }

  let _tallyUploadTimer = null;
  function scheduleTallyUpload(delayMs = 10000) {
    if (_tallyUploadTimer) return;
    _tallyUploadTimer = setTimeout(async () => {
      _tallyUploadTimer = null;
      if (!bgsTally.isDirty()) return;
      if (!await ensureAuth()) return;
      const result = await uploadTally(cfg, token, bgsTally);
      if (result === 'reauth') { needsReauth = true; scheduleTallyUpload(5000); }
      else if (result === 'ok') saveTallyFile(bgsTally);
    }, delayMs);
  }

  // Periodic tally upload every 5 minutes regardless of dirty flag
  const _tallyPeriodicTimer = setInterval(async () => {
    if (!await ensureAuth()) return;
    await uploadTally(cfg, token, bgsTally);
    saveTallyFile(bgsTally);
  }, 5 * 60 * 1000);
  if (_tallyPeriodicTimer.unref) _tallyPeriodicTimer.unref();

  // Intel alert poll — collect queued co-presence / territory alerts every 60 s
  const _intelPollTimer = setInterval(async () => {
    if (!token || needsReauth) return;
    await pollIntelAlerts(cfg, token);
  }, 60 * 1000);
  if (_intelPollTimer.unref) _intelPollTimer.unref();

  // Tick detection — poll tick.infomancer.uk every 5 minutes
  async function checkTick() {
    const latestTick = await fetchLatestTick();
    if (!latestTick) return;
    if (latestTick !== bgsTally.tickTime) {
      // Tick has changed — start a new tally period
      bgsTally.newTick(latestTick, latestTick);
      saveTallyFile(bgsTally);
      if (await ensureAuth()) {
        await uploadTally(cfg, token, bgsTally);
      }
    }
  }
  // Check immediately on startup (in case a tick fired while companion was offline)
  checkTick().catch(() => {});
  const _tickCheckTimer = setInterval(() => checkTick().catch(() => {}), 5 * 60 * 1000);
  if (_tickCheckTimer.unref) _tickCheckTimer.unref();

  // Game files to watch — value is the server fileType (null = EDDN-only, not uploaded to platform)
  const GAME_FILES = {
    'Status.json':      'status',
    'Market.json':      'market',
    'NavRoute.json':    'nav_route',
    'Outfitting.json':  null,   // EDDN only
    'Shipyard.json':    null,   // EDDN only
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

      // Update game context and feed to BGS tally engine
      let tallySignificant = false;
      for (const ev of allEvents) {
        // Track game version from FileHeader/LoadGame
        if (ev.event === 'FileHeader') {
          gameCtx.gameversion = ev.gameversion || gameCtx.gameversion;
          gameCtx.gamebuild   = ev.build       || gameCtx.gamebuild;
          gameCtx.isOdyssey   = ev.Odyssey     !== undefined ? !!ev.Odyssey  : gameCtx.isOdyssey;
          gameCtx.isHorizons  = ev.Horizons    !== undefined ? !!ev.Horizons : gameCtx.isHorizons;
        } else if (ev.event === 'LoadGame') {
          if (ev.gameversion) gameCtx.gameversion = ev.gameversion;
          if (ev.build)       gameCtx.gamebuild   = ev.build;
        } else if (['FSDJump', 'Location', 'CarrierJump'].includes(ev.event)) {
          gameCtx.currentSystem  = ev.StarSystem    || gameCtx.currentSystem;
          gameCtx.currentAddr    = ev.SystemAddress || gameCtx.currentAddr;
          gameCtx.currentStarPos = ev.StarPos       || gameCtx.currentStarPos;
          // Clear station context on jump unless docked at start
          if (!ev.Docked) { gameCtx.currentStation = null; gameCtx.currentMarketId = null; }
        } else if (ev.event === 'Docked') {
          gameCtx.currentSystem  = ev.StarSystem    || gameCtx.currentSystem;
          gameCtx.currentStation = ev.StationName   || null;
          gameCtx.currentMarketId = ev.MarketID     || null;
        } else if (ev.event === 'Undocked') {
          gameCtx.currentStation  = null;
          gameCtx.currentMarketId = null;
        }

        // BGS Tally engine
        bgsTally.processEvent(ev);
        if (['MissionCompleted', 'RedeemVoucher', 'FSDJump', 'CarrierJump',
             'SellExplorationData', 'MultiSellExplorationData', 'SellOrganicData',
             'SearchAndRescue', 'CapShipBond'].includes(ev.event)) {
          tallySignificant = true;
        }

        // Forward to EDDN
        if (EDDN_JOURNAL_EVENTS.has(ev.event)) {
          const cleaned = stripLocalised(ev);
          // Attach StarPos if missing (required for FSDJump/Location by journal/1 schema)
          if (['FSDJump', 'Location'].includes(ev.event) && !cleaned.StarPos && gameCtx.currentStarPos) {
            cleaned.StarPos = gameCtx.currentStarPos;
          }
          publishToEDDN('journal', 1, cleaned, cfg, state, gameCtx).catch(() => {});
        }

        // Forward to EDSM
        if (EDSM_EVENTS.has(ev.event)) {
          reportToEDSM(ev, cfg).catch(() => {});
        }
      }

      if (bgsTally.isDirty()) {
        saveTallyFile(bgsTally);
        scheduleTallyUpload(tallySignificant ? 2000 : 10000);
      }

      // Upload raw BGS events to server for server-side processing
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

  // ── Upload a game file (Market, Status, NavRoute) + publish to EDDN ─────────
  async function handleGameFile(filename) {
    if (!(filename in GAME_FILES)) return;
    const fileType = GAME_FILES[filename];
    const fullPath = path.join(cfg.journalDir, filename);
    try {
      const raw  = fs.readFileSync(fullPath, 'utf8');
      const data = JSON.parse(raw);

      // Upload to platform (status, market, nav_route only — outfitting/shipyard not yet handled server-side)
      if (fileType) {
        if (!await ensureAuth()) return;
        const result = await uploadGameFile(cfg, token, fileType, data);
        if (result === 'reauth') { needsReauth = true; await handleGameFile(filename); return; }
      }

      // Publish to EDDN
      let eddnMsg = null, eddnType = null, eddnVer = null;
      if (filename === 'Market.json') {
        eddnMsg = buildCommodityMessage(data, gameCtx); eddnType = 'commodity'; eddnVer = 3;
      } else if (filename === 'Outfitting.json') {
        eddnMsg = buildOutfittingMessage(data, gameCtx); eddnType = 'outfitting'; eddnVer = 2;
      } else if (filename === 'Shipyard.json') {
        eddnMsg = buildShipyardMessage(data, gameCtx); eddnType = 'shipyard'; eddnVer = 2;
      } else if (filename === 'NavRoute.json') {
        eddnMsg = buildNavrouteMessage(data); eddnType = 'navroute'; eddnVer = 1;
      }
      if (eddnMsg && eddnType && cfg.eddnEnabled) {
        await publishToEDDN(eddnType, eddnVer, eddnMsg, cfg, state, gameCtx);
        info(`EDDN ${eddnType}/${eddnVer} published`);
      }
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
      if (filename in GAME_FILES) {
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

  // ── HUD color application ─────────────────────────────────────────────────
  const hudIdx = args.indexOf('--hud');
  if (hudIdx !== -1) {
    // Accept color inline: --hud #00d4ff  OR fall back to config  OR ask
    let hudHex = (args[hudIdx + 1] || '').startsWith('#') ? args[hudIdx + 1] : null;
    if (!hudHex) hudHex = cfg.hudPrimaryColor || null;
    if (!hudHex) {
      const iface = rl_mod.createInterface({ input: process.stdin, output: process.stdout });
      hudHex = await new Promise(r => iface.question(`  ${cyan('HUD primary color')} ${dim('[e.g. #00d4ff]')}: `, r));
      iface.close();
      hudHex = hudHex.trim();
    }
    if (!/^#?[0-9a-fA-F]{6}$/.test(hudHex)) {
      fail(`Invalid hex color: ${bold(hudHex)} — expected format #RRGGBB`);
    } else {
      if (!hudHex.startsWith('#')) hudHex = '#' + hudHex;
      try {
        const dest = writeHudColorConfig(cfg.journalDir, hudHex);
        ok(`HUD color ${bold(hudHex)} written to:`);
        console.log(`   ${dim(dest)}`);
        info('Restart Elite Dangerous for the change to take effect.');
        // Save to config so future --hud calls use the same color
        if (hudHex !== cfg.hudPrimaryColor) { cfg.hudPrimaryColor = hudHex; saveConfig(cfg); }
      } catch (e) {
        fail(`HUD config write failed: ${e.message}`);
      }
    }
    // Exit unless other runtime flags are also present
    if (!args.some(a => ['--overlay', '--from-start'].includes(a))) process.exit(0);
  }

  // ── Start ─────────────────────────────────────────────────────────────────
  await ensureAuth();
  await startWatching();
  info(`Companion running ${dim('— Ctrl+C to stop')}\n`);

  // Graceful shutdown
  process.on('SIGINT', async () => {
    console.log();
    info('Shutting down...');
    if (dirWatcher)       { try { dirWatcher.close();  } catch {} }
    if (fileWatcher)      { try { fileWatcher.close(); } catch {} }
    if (flushTimer)       { clearTimeout(flushTimer); flushTimer = null; }
    if (_tallyUploadTimer){ clearTimeout(_tallyUploadTimer); _tallyUploadTimer = null; }
    clearInterval(_tallyPeriodicTimer);
    clearInterval(_tickCheckTimer);
    clearInterval(_intelPollTimer);
    await flushEvents();
    // Final tally upload on shutdown
    if (bgsTally.isDirty() && token) {
      await uploadTally(cfg, token, bgsTally);
      saveTallyFile(bgsTally);
    }
    ok('Goodbye, Commander. o7');
    process.exit(0);
  });

  process.on('SIGTERM', () => process.emit('SIGINT'));
}

main().catch(e => {
  console.error(`\n${red('Fatal:')} ${e.message}`);
  process.exit(1);
});
