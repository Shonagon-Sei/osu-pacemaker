'use strict';

/**
 * osu! Pacemaker — packaged desktop app entry point.
 *
 * One process runs everything:
 *   • the backend (replay index, simulation pool, tosu client, relay + http servers)
 *   • the transparent, click-through overlay window
 *   • a system-tray menu (lock/unlock, reload, updates, quit)
 *   • auto-update from GitHub Releases (packaged builds only)
 *
 * Run osu! in Borderless (not exclusive fullscreen) so the overlay composites on top.
 * Ctrl+Shift+L locks/unlocks (click-through) · Ctrl+Shift+O quits.
 */
const path = require('path');
const { app, BrowserWindow, Tray, Menu, screen, globalShortcut, nativeImage, dialog } = require('electron');

// Keep us responsive while in the background (overlay must keep animating).
app.commandLine.appendSwitch('disable-renderer-backgrounding');
app.disableHardwareAcceleration(); // transparent overlays are more reliable without it

// Single instance — a second launch just focuses/relaunches nothing.
if (!app.requestSingleInstanceLock()) { app.quit(); }

let win = null;
let tray = null;
let backend = null;
let locked = true; // overlay starts click-through (locked)

function setLocked(state) {
  locked = state;
  if (!win) return;
  win.setIgnoreMouseEvents(locked, { forward: true });
  win.setFocusable(!locked);
  if (!locked) win.focus();
  win.webContents.executeJavaScript(`window.setOverlayUnlocked && window.setOverlayUnlocked(${!locked})`).catch(() => {});
  if (tray) tray.setContextMenu(buildMenu());
}

function buildMenu() {
  return Menu.buildFromTemplate([
    { label: 'osu! Pacemaker', enabled: false },
    { type: 'separator' },
    { label: 'Unlock overlay (edit)', type: 'checkbox', checked: !locked, click: (i) => setLocked(!i.checked) },
    { label: 'Reload overlay', click: () => win && win.reload() },
    { type: 'separator' },
    { label: 'Check for updates…', enabled: app.isPackaged, click: checkForUpdates },
    { label: `Version ${app.getVersion()}`, enabled: false },
    { type: 'separator' },
    { label: 'Quit', click: () => app.quit() },
  ]);
}

function createWindow(httpPort) {
  const { x, y, width, height } = screen.getPrimaryDisplay().bounds;
  win = new BrowserWindow({
    x, y, width, height,
    transparent: true, frame: false, resizable: false, movable: false,
    minimizable: false, maximizable: false, focusable: false, skipTaskbar: true,
    alwaysOnTop: true, hasShadow: false, fullscreenable: false, backgroundColor: '#00000000',
    webPreferences: { contextIsolation: true, backgroundThrottling: false },
  });
  win.setAlwaysOnTop(true, 'screen-saver');
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  win.setIgnoreMouseEvents(true, { forward: true });
  win.loadURL(`http://localhost:${httpPort}/`);

  setInterval(() => { if (win && !win.isDestroyed()) win.setAlwaysOnTop(true, 'screen-saver'); }, 2000);
}

function createTray() {
  const img = nativeImage.createFromPath(path.join(__dirname, '..', 'build', 'tray.png'));
  tray = new Tray(img.isEmpty() ? nativeImage.createEmpty() : img);
  tray.setToolTip('osu! Pacemaker');
  tray.setContextMenu(buildMenu());
  tray.on('click', () => tray.popUpContextMenu());
}

// ── Auto-update (GitHub Releases) ──────────────────────────────────────────────
function initUpdates() {
  if (!app.isPackaged) return;
  let autoUpdater;
  try { ({ autoUpdater } = require('electron-updater')); } catch { return; }
  autoUpdater.autoDownload = true;
  autoUpdater.on('update-downloaded', () => {
    dialog.showMessageBox({
      type: 'info', buttons: ['Restart now', 'Later'], defaultId: 0,
      title: 'Update ready', message: 'A new version of osu! Pacemaker was downloaded. Restart to apply?',
    }).then((r) => { if (r.response === 0) autoUpdater.quitAndInstall(); });
  });
  autoUpdater.checkForUpdatesAndNotify().catch(() => {});
}
function checkForUpdates() {
  try {
    const { autoUpdater } = require('electron-updater');
    autoUpdater.checkForUpdates().catch(() => {});
    dialog.showMessageBox({ type: 'info', message: 'Checking for updates…' });
  } catch { /* not packaged */ }
}

app.whenReady().then(async () => {
  try {
    backend = await require('../src/index').start();
  } catch (e) {
    dialog.showErrorBox('osu! Pacemaker failed to start', String(e && e.stack ? e.stack : e));
    app.quit();
    return;
  }
  createWindow(backend.httpPort);
  createTray();
  initUpdates();

  globalShortcut.register('CommandOrControl+Shift+O', () => app.quit());
  globalShortcut.register('CommandOrControl+Shift+L', () => setLocked(!locked));
});

app.on('second-instance', () => { if (win) win.show(); });
app.on('window-all-closed', () => app.quit());
app.on('will-quit', async (e) => {
  globalShortcut.unregisterAll();
  if (backend) { const b = backend; backend = null; e.preventDefault(); try { await b.stop(); } catch {} app.exit(0); }
});
