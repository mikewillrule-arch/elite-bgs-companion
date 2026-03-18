'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  // Identity
  isElectron: true,

  // Config
  getConfig:      ()         => ipcRenderer.invoke('get-config'),
  saveConfig:     (cfg)      => ipcRenderer.invoke('save-config', cfg),

  // Window control
  toggleExpand:   ()         => ipcRenderer.invoke('toggle-expand'),
  setOpacity:     (val)      => ipcRenderer.invoke('set-opacity', val),
  openSettings:   ()         => ipcRenderer.invoke('open-settings'),

  // Setup
  setupComplete:  (cfg)      => ipcRenderer.invoke('setup-complete', cfg),

  // Session (called after login in overlay)
  setSession:     (data)     => ipcRenderer.invoke('set-session', data),

  // Journal folder
  selectJournalFolder: ()    => ipcRenderer.invoke('select-journal-folder'),

  // Event listeners (push from main → renderer)
  onExpandState:       (cb)  => ipcRenderer.on('expand-state',       (_, v) => cb(v)),
  onEdStatus:          (cb)  => ipcRenderer.on('ed-status',          (_, v) => cb(v)),
  onJournalStatus:     (cb)  => ipcRenderer.on('journal-status',     (_, v) => cb(v)),
  onJournalPathNeeded: (cb)  => ipcRenderer.on('journal-path-needed',()    => cb()),
});
