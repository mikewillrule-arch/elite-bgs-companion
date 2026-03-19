'use strict';

const {
  app, BrowserWindow, Tray, Menu, globalShortcut,
  ipcMain, nativeImage, screen, dialog,
} = require('electron');
const path = require('path');
const fs   = require('fs');
const os   = require('os');

// ── Config ────────────────────────────────────────────────────────────────────
const CONFIG_FILE = path.join(app.getPath('userData'), 'config.json');

function loadConfig() {
  try {
    if (fs.existsSync(CONFIG_FILE)) return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
  } catch {}
  return {};
}

function saveConfig(cfg) {
  try {
    fs.mkdirSync(path.dirname(CONFIG_FILE), { recursive: true });
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(cfg, null, 2));
  } catch (e) { console.error('[config] Save failed:', e.message); }
}

// ── Window dimensions ─────────────────────────────────────────────────────────
const COLLAPSED_W = 40,  COLLAPSED_H = 40;
const EXPANDED_W  = 420, EXPANDED_H  = 660;

// ── State ─────────────────────────────────────────────────────────────────────
let config        = {};
let overlayWin    = null;
let setupWin      = null;
let tray          = null;
let isExpanded    = false;
let journalWatcher = null;
let processMonitor = null;

// ── Overlay window ────────────────────────────────────────────────────────────
function createOverlayWindow() {
  const { width: sw, height: sh } = screen.getPrimaryDisplay().workAreaSize;
  const x = config.overlayX ?? (sw - COLLAPSED_W - 20);
  const y = config.overlayY ?? 80;

  const appIconPath = path.join(__dirname, 'assets', 'icon.ico');
  const appIcon     = fs.existsSync(appIconPath) ? appIconPath : undefined;

  overlayWin = new BrowserWindow({
    x, y,
    width:  COLLAPSED_W,
    height: COLLAPSED_H,
    transparent: true,
    frame:        false,
    alwaysOnTop:  true,
    skipTaskbar:  true,
    resizable:    false,
    movable:      true,
    show:         false,   // hidden until Elite Dangerous is running
    icon:         appIcon,
    webPreferences: {
      preload:          path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration:  false,
      webSecurity:      true,
    },
  });

  // Set always-on-top level above fullscreen windows
  overlayWin.setAlwaysOnTop(true, 'screen-saver');

  // Save position on move
  overlayWin.on('moved', () => {
    const [nx, ny] = overlayWin.getPosition();
    config.overlayX = nx;
    config.overlayY = ny;
    saveConfig(config);
  });

  // Save size when user resizes the expanded window
  overlayWin.on('resized', () => {
    if (!isExpanded) return;
    const [nw, nh] = overlayWin.getSize();
    config.overlayW = nw;
    config.overlayH = nh;
    saveConfig(config);
  });

  overlayWin.on('closed', () => { overlayWin = null; isExpanded = false; });

  const base = config.serverUrl || 'https://elite-bgs.store';
  const slug = config.slug || '';
  const url  = slug ? `${base}/t/${slug}/overlay` : `${base}/overlay-setup`;
  overlayWin.loadURL(url);
}

// ── Setup window ──────────────────────────────────────────────────────────────
function createSetupWindow() {
  if (setupWin) { setupWin.focus(); return; }
  const _setupIcon = path.join(__dirname, 'assets', 'icon.ico');
  setupWin = new BrowserWindow({
    width:  540,
    height: 640,
    title:  'Elite BGS Companion — Setup',
    center: true,
    resizable: false,
    icon:   fs.existsSync(_setupIcon) ? _setupIcon : undefined,
    webPreferences: {
      preload:          path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration:  false,
    },
  });
  setupWin.loadFile('setup-wizard.html');
  setupWin.on('closed', () => { setupWin = null; });
}

// ── Tray ──────────────────────────────────────────────────────────────────────
function setupTray() {
  const trayIconPath = path.join(__dirname, 'assets', 'tray-icon.png');
  try {
    tray = new Tray(fs.existsSync(trayIconPath)
      ? nativeImage.createFromPath(trayIconPath)
      : nativeImage.createEmpty());
  } catch {
    tray = new Tray(nativeImage.createEmpty());
  }

  function buildTrayMenu() {
    const overlayVisible = overlayWin?.isVisible() ?? false;
    return Menu.buildFromTemplate([
      {
        label: overlayVisible ? 'Hide Overlay Button' : 'Show Overlay Button',
        click: () => {
          if (!overlayWin) return;
          if (overlayWin.isVisible()) {
            overlayWin.hide();
          } else {
            overlayWin.show();
            toggleExpand(false);   // restore to collapsed state when reshown
          }
          tray.setContextMenu(buildTrayMenu());
        },
      },
      { label: 'Expand Intel Panel',       click: () => { overlayWin?.show(); toggleExpand(true); } },
      { label: 'Settings',                 click: () => createSetupWindow() },
      { type:  'separator' },
      { label: 'Quit Elite BGS Companion', click: () => app.quit() },
    ]);
  }

  tray.setToolTip('Elite BGS Companion');
  tray.setContextMenu(buildTrayMenu());

  // Left-click: show overlay if hidden, otherwise toggle expand/collapse
  tray.on('click', () => {
    if (!overlayWin) return;
    if (!overlayWin.isVisible()) {
      overlayWin.show();
      toggleExpand(false);
      tray.setContextMenu(buildTrayMenu());
    } else {
      toggleExpand();
    }
  });
}

// ── Toggle expand / collapse ──────────────────────────────────────────────────
function toggleExpand(force) {
  if (!overlayWin) return;
  isExpanded = force !== undefined ? force : !isExpanded;

  if (isExpanded) {
    const [cx, cy] = overlayWin.getPosition();
    const { width: sw, height: sh } = screen.getPrimaryDisplay().workAreaSize;
    const savedW = config.overlayW || EXPANDED_W;
    const savedH = config.overlayH || EXPANDED_H;
    // Clamp so the expanded window never goes off any edge
    const newX = Math.max(0, Math.min(cx, sw - savedW - 10));
    const newY = Math.max(0, Math.min(cy, sh - savedH - 10));
    overlayWin.setBounds({ x: newX, y: newY, width: savedW, height: savedH }, false);
    overlayWin.setResizable(true);
    overlayWin.setOpacity(config.opacity ?? 0.92);
  } else {
    const [cx, cy] = overlayWin.getPosition();
    const { width: sw, height: sh } = screen.getPrimaryDisplay().workAreaSize;
    overlayWin.setResizable(false);
    const newX = Math.max(0, Math.min(cx, sw - COLLAPSED_W));
    const newY = Math.max(0, Math.min(cy, sh - COLLAPSED_H - 10));
    overlayWin.setBounds({ x: newX, y: newY, width: COLLAPSED_W, height: COLLAPSED_H }, false);
    overlayWin.setOpacity(1);
  }

  overlayWin.webContents.send('expand-state', isExpanded);
}

// ── IPC handlers ──────────────────────────────────────────────────────────────
ipcMain.handle('get-config',     ()        => config);
ipcMain.handle('save-config',    (_, cfg)  => { Object.assign(config, cfg); saveConfig(config); return true; });
ipcMain.handle('toggle-expand',  ()        => toggleExpand());
ipcMain.handle('set-opacity',    (_, val)  => {
  config.opacity = parseFloat(val);
  saveConfig(config);
  if (isExpanded && overlayWin) overlayWin.setOpacity(config.opacity);
});
ipcMain.handle('open-settings',  ()        => { createSetupWindow(); });

// Setup wizard completion
ipcMain.handle('setup-complete', (_, cfg)  => {
  Object.assign(config, cfg, { setupComplete: true });
  saveConfig(config);
  if (setupWin) { setupWin.close(); setupWin = null; }
  if (overlayWin) {
    // Reload overlay with new slug
    const base = config.serverUrl || 'https://elite-bgs.store';
    overlayWin.loadURL(`${base}/t/${config.slug}/overlay`);
  } else {
    createOverlayWindow();
  }
  startServices();
});

// Journal folder selection (native folder browser)
ipcMain.handle('select-journal-folder', async () => {
  const result = await dialog.showOpenDialog({
    title:       'Select Elite Dangerous Journal Folder',
    buttonLabel: 'Select Folder',
    properties:  ['openDirectory'],
  });
  if (!result.canceled && result.filePaths.length) {
    const chosen = result.filePaths[0];
    config.journalDir = chosen;
    saveConfig(config);
    if (journalWatcher) journalWatcher.updateJournalDir(chosen);
    return chosen;
  }
  return null;
});

// Save login credentials (remember me)
ipcMain.handle('save-login', (_, { cmdrName, password }) => {
  config.savedCmdrName = cmdrName || config.savedCmdrName;
  config.savedPassword = password || config.savedPassword;
  saveConfig(config);
  return true;
});

// Screen capture — returns JPEG as base64 string
ipcMain.handle('capture-screen', async () => {
  try {
    const { desktopCapturer } = require('electron');
    const sources = await desktopCapturer.getSources({
      types: ['screen'],
      thumbnailSize: { width: 1280, height: 720 },
    });
    if (!sources.length) return null;
    return sources[0].thumbnail.toJPEG(85).toString('base64');
  } catch (e) {
    console.error('[capture] Screen capture failed:', e.message);
    return null;
  }
});

// Dismiss the Galnet prompt without capturing
ipcMain.handle('dismiss-galnet-prompt', () => true);

// Galnet capture — takes 15 screenshots every 2 s (30 s total) then uploads
let _galnetCapturing = false;
ipcMain.handle('start-galnet-capture', async (_, { systemName, stationName }) => {
  if (_galnetCapturing) return { ok: false, error: 'Capture already in progress' };
  _galnetCapturing = true;

  const { desktopCapturer } = require('electron');
  const screenshots = [];
  const TOTAL       = 15;   // 15 shots × 2 s = 30 s

  for (let i = 0; i < TOTAL; i++) {
    await new Promise(resolve => setTimeout(resolve, 2000));
    try {
      const sources = await desktopCapturer.getSources({
        types: ['screen'],
        thumbnailSize: { width: 1280, height: 720 },
      });
      if (sources.length) {
        screenshots.push(sources[0].thumbnail.toJPEG(85).toString('base64'));
      }
    } catch {}
    overlayWin?.webContents.send('galnet-capture-progress', { current: i + 1, total: TOTAL });
  }

  _galnetCapturing = false;

  if (screenshots.length && config.sessionToken && config.slug && config.cmdrName) {
    _uploadGalnetCapture(screenshots, systemName, stationName);
  }

  overlayWin?.webContents.send('galnet-capture-done', { count: screenshots.length });
  return { ok: true, count: screenshots.length };
});

// Upload Galnet screenshots to the platform for AI processing
function _uploadGalnetCapture(screenshots, systemName, stationName) {
  const serverUrl = config.serverUrl || 'https://elite-bgs.store';
  const slug      = config.slug      || '';
  const body      = JSON.stringify({
    screenshots,
    systemName,
    stationName:  stationName || '',
    cmdrName:     config.cmdrName,
  });

  try {
    const parsed = new URL(`${serverUrl}/t/${slug}/api/galnet-capture`);
    const lib    = parsed.protocol === 'https:' ? require('https') : require('http');
    const req    = lib.request({
      hostname: parsed.hostname,
      port:     parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
      path:     parsed.pathname,
      method:   'POST',
      headers:  {
        'Content-Type':   'application/json',
        'Content-Length': Buffer.byteLength(body),
        'x-session-key':  config.sessionToken,
      },
    }, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => console.log('[galnet] Upload response:', res.statusCode));
    });
    req.on('error', e => console.error('[galnet] Upload error:', e.message));
    req.write(body);
    req.end();
  } catch (e) {
    console.error('[galnet] Upload failed:', e.message);
  }
}

// Update session key in config (called after overlay login)
ipcMain.handle('set-session', (_, { slug, cmdrName, sessionToken, isLeader, leaderKey }) => {
  Object.assign(config, { slug, cmdrName, sessionToken, isLeader: !!isLeader, leaderKey: leaderKey || null, setupComplete: true });
  saveConfig(config);
  // Pass new credentials to journal watcher
  if (journalWatcher) journalWatcher.updateCredentials({ slug, cmdrName, sessionToken, serverUrl: config.serverUrl });
  // Start background services if they weren't started yet (user logged in via overlay instead of setup wizard)
  if (!journalWatcher) startServices();
});

function startServices() {
  // Stop any existing instances before creating new ones — prevents duplicate
  // journal watchers when setup-complete is called while services are running.
  if (journalWatcher) { journalWatcher.stop(); journalWatcher = null; }
  if (processMonitor) { processMonitor.stop(); processMonitor = null; }

  const { JournalWatcher } = require('./journal-watcher');
  const ProcessMonitor      = require('./process-monitor');

  journalWatcher = new JournalWatcher({
    serverUrl:    config.serverUrl    || 'https://elite-bgs.store',
    slug:         config.slug         || '',
    cmdrName:     config.cmdrName     || '',
    sessionToken: config.sessionToken || '',
    journalDir:   config.journalDir   || null,
    onStatus:     (msg) => {
      console.log('[journal]', msg);
      overlayWin?.webContents.send('journal-status', msg);
    },
    onPathNeeded: () => {
      // Notify overlay to show the journal path prompt in settings
      overlayWin?.webContents.send('journal-path-needed');
      // Also show a native dialog as a fallback
      _promptJournalFolder();
    },
    onDocked: ({ systemName, stationName }) => {
      console.log('[companion] Docked at', stationName, 'in', systemName);
      if (overlayWin && !_galnetCapturing) {
        overlayWin.webContents.send('show-galnet-prompt', { systemName, stationName });
      }
    },
    onUndocked: () => {
      // Dismiss the GalNet Courier prompt the moment the player undocks —
      // prevents it from lingering while flying between systems.
      overlayWin?.webContents.send('dismiss-galnet-prompt');
      console.log('[companion] Undocked — GalNet prompt dismissed');
    },
  });

  // Start journal watcher immediately — don't wait for ED to be detected
  journalWatcher.start();

  processMonitor = new ProcessMonitor({
    onStart: () => {
      console.log('[companion] Elite Dangerous detected — showing overlay');
      if (overlayWin) {
        overlayWin.show();
        overlayWin.setAlwaysOnTop(true, 'screen-saver');
      }
      overlayWin?.webContents.send('ed-status', { running: true });
    },
    onStop: () => {
      console.log('[companion] Elite Dangerous closed — cleaning up in 5 min');
      overlayWin?.webContents.send('ed-status', { running: false });
      setTimeout(() => {
        if (overlayWin) {
          overlayWin.hide();
          isExpanded = false;
          overlayWin.setBounds({ x: overlayWin.getPosition()[0], y: overlayWin.getPosition()[1], width: COLLAPSED_W, height: COLLAPSED_H });
        }
      }, 5 * 60 * 1000);
    },
  });

  processMonitor.start();
}

async function _promptJournalFolder() {
  const result = await dialog.showOpenDialog({
    title:       'Select Elite Dangerous Journal Folder',
    message:     'Could not find your Elite Dangerous journal folder automatically. Please select it.',
    buttonLabel: 'Select Folder',
    properties:  ['openDirectory'],
  });
  if (!result.canceled && result.filePaths.length) {
    const chosen = result.filePaths[0];
    config.journalDir = chosen;
    saveConfig(config);
    if (journalWatcher) journalWatcher.updateJournalDir(chosen);
  }
}

// ── Single-instance lock ──────────────────────────────────────────────────────
// Prevents multiple companion instances from running simultaneously.
// Without this, every launch stacks a new Electron process on top of the old one.
const gotTheLock = app.requestSingleInstanceLock();
if (!gotTheLock) {
  // Another instance is already running — hand off focus and exit immediately.
  app.quit();
} else {
  app.on('second-instance', () => {
    // Someone launched a second instance — bring the existing window to the front.
    if (overlayWin) {
      if (overlayWin.isMinimized()) overlayWin.restore();
      overlayWin.focus();
    } else if (setupWin) {
      setupWin.focus();
    }
  });
}

// ── App lifecycle ─────────────────────────────────────────────────────────────
app.whenReady().then(() => {
  config = loadConfig();

  // Register global toggle hotkey
  try {
    globalShortcut.register('Ctrl+Shift+B', () => toggleExpand());
  } catch {}

  if (!config.setupComplete) {
    createSetupWindow();
    // Also create the overlay in collapsed state even before setup
    createOverlayWindow();
    setupTray();
  } else {
    createOverlayWindow();
    setupTray();
    startServices();
  }
});

// Keep app running when all windows closed (lives in system tray)
app.on('window-all-closed', (e) => e.preventDefault());

app.on('will-quit', () => {
  globalShortcut.unregisterAll();
  journalWatcher?.stop();
  processMonitor?.stop();
});
