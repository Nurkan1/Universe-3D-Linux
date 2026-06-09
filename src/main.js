// Electron main process: creates the overlay window and exposes
// IPC handlers to scan .desktop apps, resolve icons and launch apps.
const { app, BrowserWindow, ipcMain, Tray, Menu, nativeImage, desktopCapturer, session, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { spawn } = require('child_process');

let win = null;
let tray = null;
let quitting = false;

// Single instance: a second launch (e.g. panel click) just shows the window
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
}
app.on('second-instance', () => {
  if (win) {
    win.show();
    win.focus();
  }
});

// ---------------------------------------------------------------------------
// Preferences (favorites / recents) persisted as JSON in userData
// ---------------------------------------------------------------------------
const PREFS_PATH = () => path.join(app.getPath('userData'), 'prefs.json');

function loadPrefs() {
  try {
    return JSON.parse(fs.readFileSync(PREFS_PATH(), 'utf8'));
  } catch {
    return { favorites: [], recents: [] };
  }
}

function savePrefs(prefs) {
  try {
    fs.writeFileSync(PREFS_PATH(), JSON.stringify(prefs, null, 2));
  } catch { /* non-fatal */ }
}

// Directories where .desktop entries live (system + user)
const APP_DIRS = [
  '/usr/share/applications',
  '/usr/local/share/applications',
  path.join(os.homedir(), '.local/share/applications'),
];

// Icon search roots, ordered by preference (largest/most complete first)
const ICON_DIRS = [
  '/usr/share/icons',
  '/usr/local/share/icons',
  path.join(os.homedir(), '.local/share/icons'),
  '/usr/share/pixmaps',
];

const ICON_SIZE_PREFERENCE = [
  '128x128', '96x96', '256x256', '64x64', 'scalable', '48x48', '512x512', '32x32',
];
const ICON_EXTS = ['.png', '.svg', '.xpm'];

// ---------------------------------------------------------------------------
// .desktop parsing
// ---------------------------------------------------------------------------

/** Parse the [Desktop Entry] section of a .desktop file into a plain object. */
function parseDesktopFile(filePath) {
  let content;
  try {
    content = fs.readFileSync(filePath, 'utf8');
  } catch {
    return null;
  }
  const entry = {};
  let inDesktopEntry = false;
  for (const rawLine of content.split('\n')) {
    const line = rawLine.trim();
    if (line.startsWith('[')) {
      inDesktopEntry = line === '[Desktop Entry]';
      continue;
    }
    if (!inDesktopEntry || !line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq === -1) continue;
    entry[line.slice(0, eq)] = line.slice(eq + 1);
  }
  return entry;
}

/** Build an icon-name -> absolute-path index lazily (one filesystem walk). */
let iconIndex = null;
function buildIconIndex() {
  iconIndex = new Map();
  const visit = (dir, priority) => {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        // Boost priority for preferred size dirs so big icons win
        const sizeIdx = ICON_SIZE_PREFERENCE.indexOf(e.name);
        visit(full, sizeIdx === -1 ? priority : priority + (ICON_SIZE_PREFERENCE.length - sizeIdx) * 10);
      } else {
        const ext = path.extname(e.name).toLowerCase();
        if (!ICON_EXTS.includes(ext)) continue;
        const name = path.basename(e.name, ext);
        const prev = iconIndex.get(name);
        if (!prev || priority > prev.priority) {
          iconIndex.set(name, { path: full, priority });
        }
      }
    }
  };
  for (const root of ICON_DIRS) visit(root, 0);
}

/** Resolve an Icon= value to an absolute file path (or null). */
function resolveIcon(iconValue) {
  if (!iconValue) return null;
  if (iconValue.startsWith('/')) {
    return fs.existsSync(iconValue) ? iconValue : null;
  }
  if (!iconIndex) buildIconIndex();
  const hit = iconIndex.get(iconValue) || iconIndex.get(iconValue.replace(/\.(png|svg|xpm)$/i, ''));
  return hit ? hit.path : null;
}

/** Scan all app dirs and return the merged, de-duplicated list of apps. */
function scanApps() {
  const apps = new Map(); // keyed by desktop file basename, user dirs override system
  for (const dir of APP_DIRS) {
    let files;
    try {
      files = fs.readdirSync(dir);
    } catch {
      continue;
    }
    for (const file of files) {
      if (!file.endsWith('.desktop')) continue;
      const entry = parseDesktopFile(path.join(dir, file));
      if (!entry || entry.Type !== 'Application' || !entry.Name || !entry.Exec) continue;
      if (entry.Hidden === 'true') continue; // Hidden=true means "deleted"
      const iconPath = resolveIcon(entry.Icon);
      apps.set(file, {
        id: file,
        name: entry.Name,
        comment: entry.Comment || '',
        exec: entry.Exec,
        icon: iconPath, // absolute path or null
        categories: (entry.Categories || '').split(';').filter(Boolean),
        noDisplay: entry.NoDisplay === 'true', // hidden apps still included on purpose
        terminal: entry.Terminal === 'true',
        file: path.join(dir, file),
      });
    }
  }
  return [...apps.values()].sort((a, b) => a.name.localeCompare(b.name));
}

// ---------------------------------------------------------------------------
// Launching
// ---------------------------------------------------------------------------

/** Strip XDG field codes (%f %F %u %U ...) and launch detached. */
function launchApp(appInfo) {
  const cmd = appInfo.exec.replace(/%[fFuUdDnNickvm]/g, '').trim();
  let child;
  if (appInfo.terminal) {
    child = spawn('x-terminal-emulator', ['-e', 'sh', '-c', cmd], {
      detached: true, stdio: 'ignore',
    });
  } else {
    child = spawn('sh', ['-c', cmd], { detached: true, stdio: 'ignore' });
  }
  child.unref();
}

// ---------------------------------------------------------------------------
// Window
// ---------------------------------------------------------------------------

function createWindow() {
  win = new BrowserWindow({
    width: 1280,
    height: 800,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false, // keep rendering/recording when occluded
    },
  });
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  win.once('ready-to-show', () => {
    win.maximize();
    win.show();
  });
  // Daemon mode: closing hides the window so re-opening is instant
  win.on('close', (e) => {
    if (!quitting) {
      e.preventDefault();
      win.hide();
    }
  });
}

function createTray() {
  const iconPath = path.join(__dirname, '..', 'launcher', 'icon.png');
  const icon = nativeImage.createFromPath(iconPath).resize({ width: 22, height: 22 });
  tray = new Tray(icon);
  tray.setToolTip('3D Universe');
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: 'Show 3D Universe', click: () => { win.show(); win.focus(); } },
    { type: 'separator' },
    { label: 'Quit', click: () => { quitting = true; app.quit(); } },
  ]));
  tray.on('click', () => {
    if (win.isVisible()) win.hide();
    else { win.show(); win.focus(); }
  });
}

app.whenReady().then(() => {
  // Screen recording: hand the renderer the full screen as source. Screen
  // capture (unlike window capture on X11) never freezes on view changes,
  // and it includes the HTML UI overlays + mouse cursor.
  session.defaultSession.setDisplayMediaRequestHandler((_request, callback) => {
    desktopCapturer.getSources({ types: ['screen'] }).then((sources) => {
      callback({ video: sources[0] });
    });
  });

  ipcMain.handle('apps:scan', () => scanApps());
  ipcMain.handle('apps:launch', (_e, appInfo) => {
    launchApp(appInfo);
    return true;
  });
  ipcMain.handle('apps:iconData', (_e, iconPath) => {
    // Return icon file as a data URL so the sandboxed renderer can use it
    try {
      const buf = fs.readFileSync(iconPath);
      const ext = path.extname(iconPath).toLowerCase();
      const mime = ext === '.svg' ? 'image/svg+xml' : ext === '.xpm' ? 'image/x-xpixmap' : 'image/png';
      return `data:${mime};base64,${buf.toString('base64')}`;
    } catch {
      return null;
    }
  });
  ipcMain.handle('prefs:get', () => loadPrefs());
  ipcMain.handle('prefs:set', (_e, prefs) => { savePrefs(prefs); return true; });
  ipcMain.handle('video:save', (_e, arrayBuffer) => {
    // Save the recorded WebM into ~/Videos (fallback: home dir)
    let dir = path.join(os.homedir(), 'Videos');
    try {
      fs.mkdirSync(dir, { recursive: true });
    } catch {
      dir = os.homedir();
    }
    const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const file = path.join(dir, `universe3d-${stamp}.webm`);
    fs.writeFileSync(file, Buffer.from(arrayBuffer));
    return file;
  });
  ipcMain.handle('video:showInFolder', (_e, filePath) => {
    shell.showItemInFolder(filePath);
    return true;
  });
  ipcMain.on('window:close', () => win && win.hide());
  ipcMain.on('window:minimize', () => win && win.minimize());

  createWindow();
  createTray();
});

app.on('before-quit', () => { quitting = true; });
app.on('window-all-closed', () => { /* stay resident in tray */ });
