// Bridge that recreates the old Electron `window.universe.*` API on top of
// Tauri's `invoke`. Keeping the same shape means the renderer (universe.js)
// barely changed when migrating from Electron to Tauri.
//
// This is an ES module importing the API directly rather than reading the
// `window.__TAURI__` global: `withGlobalTauri` is off so that a script injected
// into the webview cannot reach `invoke` (and therefore `run_command`) simply
// by touching a global.
import { invoke } from 'tauri/core.js';

export const universe = {
  scanApps: () => invoke('apps_scan'),
  launchApp: (appInfo) => invoke('apps_launch', { app: appInfo }),
  launchAction: (appInfo, action) => invoke('apps_launch_action', { app: appInfo, action }),
  iconData: (iconPath) => invoke('icon_data', { iconPath }),
  getPrefs: () => invoke('prefs_get'),
  setPrefs: (prefs) => invoke('prefs_set', { prefs }),

  // Utilities
  runCommand: (command, inTerminal = false) =>
    invoke('run_command', { command, inTerminal }),
  openTerminal: (path = null) => invoke('open_terminal', { path }),
  systemStats: () => invoke('system_stats'),

  // Window controls
  closeWindow: () => invoke('window_hide'),
  minimizeWindow: () => invoke('window_minimize'),
  toggleMaximize: () => invoke('window_toggle_maximize'),
  nextMonitor: () => invoke('window_next_monitor'),
};
