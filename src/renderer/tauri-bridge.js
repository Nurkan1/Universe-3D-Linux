// Bridge that recreates the old Electron `window.universe.*` API on top of
// Tauri's `invoke`. Keeping the same shape means the renderer (universe.js)
// barely changed when migrating from Electron to Tauri.
const { invoke } = window.__TAURI__.core;

window.universe = {
  scanApps: () => invoke('apps_scan'),
  launchApp: (appInfo) => invoke('apps_launch', { app: appInfo }),
  iconData: (iconPath) => invoke('icon_data', { iconPath }),
  getPrefs: () => invoke('prefs_get'),
  setPrefs: (prefs) => invoke('prefs_set', { prefs }),

  // New utilities
  runCommand: (command, inTerminal = false) =>
    invoke('run_command', { command, inTerminal }),
  openTerminal: (path = null) => invoke('open_terminal', { path }),
  systemStats: () => invoke('system_stats'),

  // Window controls
  closeWindow: () => invoke('window_hide'),
  minimizeWindow: () => invoke('window_minimize'),
};
