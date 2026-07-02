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
const { app, BrowserWindow, Tray, Menu, screen, globalShortcut, nativeImage, dialog, ipcMain } = require('electron');

// Keep us responsive while in the background (overlay must keep animating).
app.commandLine.appendSwitch('disable-renderer-backgrounding');
app.disableHardwareAcceleration(); // transparent overlays are more reliable without it

// Single instance — a second launch just focuses/relaunches nothing.
if (!app.requestSingleInstanceLock()) { app.quit(); }

let win = null;
let tray = null;
let backend = null;
let locked = true; // overlay starts click-through (locked)
let displayBounds = null; // primary display bounds; origin for renderer-sent coords

function setLocked(state) {
  locked = state;
  if (!win) return;
  // No { forward: true }: forwarding every mouse-move to the renderer across the
  // whole screen floods the overlay (osu! runs high-polling raw input) and lags
  // the cursor. The renderer drives the window size on lock/unlock (see below).
  win.setIgnoreMouseEvents(locked);
  win.setFocusable(!locked);
  if (!locked) win.focus();
  win.webContents.executeJavaScript(`window.setOverlayUnlocked && window.setOverlayUnlocked(${!locked})`).catch(() => {});
  if (tray) tray.setContextMenu(buildMenu());
}

// ── Renderer-driven window bounds ──────────────────────────────────────────────
// A full-screen transparent (layered) window makes Windows composite the cursor
// in software → severe mouse lag while playing. So the page tells us the exact
// rect to use: tight to the board while locked (rest of screen untouched → no
// lag), full-screen while unlocked so the settings panel + drag-to-place work.
// Coords are display-local; we offset by the display origin.
ipcMain.on('overlay:bounds', (_e, b) => {
  if (!win || win.isDestroyed() || !displayBounds || !b) return;
  win.setBounds({
    x: displayBounds.x + Math.round(b.x),
    y: displayBounds.y + Math.round(b.y),
    width: Math.max(1, Math.round(b.width)),
    height: Math.max(1, Math.round(b.height)),
  });
});

ipcMain.on('overlay:full', () => {
  if (!win || win.isDestroyed() || !displayBounds) return;
  win.setBounds({ ...displayBounds });
});

// First-run guide asks to unlock so the settings panel is clickable.
ipcMain.on('overlay:request-unlock', () => { if (locked) setLocked(false); });

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
  displayBounds = screen.getPrimaryDisplay().bounds;
  const { x, y } = displayBounds;
  win = new BrowserWindow({
    // Start small, not full-screen: a full-screen transparent (layered) window
    // forces software cursor composition on Windows and lags the mouse. The
    // renderer drives the real bounds (tight while locked, full while unlocked).
    // resizable must stay true or Windows ignores our programmatic setBounds.
    x, y, width: 480, height: 320,
    transparent: true, frame: false, resizable: true, movable: false,
    minimizable: false, maximizable: false, focusable: false, skipTaskbar: true,
    alwaysOnTop: true, hasShadow: false, fullscreenable: false, backgroundColor: '#00000000',
    webPreferences: {
      contextIsolation: true,
      backgroundThrottling: false,
      preload: path.join(__dirname, 'overlay-preload.js'),
    },
  });
  win.setAlwaysOnTop(true, 'screen-saver');
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  win.setIgnoreMouseEvents(true); // no forward (see setLocked)
  win.loadURL(`http://localhost:${httpPort}/`);

  // Reassert top-most ONLY while locked (playing). While unlocked (editing),
  // reasserting steals focus from native <select>/color-picker popups and snaps
  // them shut — and we don't need to fight a game for top-most while editing.
  setInterval(() => { if (win && !win.isDestroyed() && locked) win.setAlwaysOnTop(true, 'screen-saver'); }, 2000);
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
    // Bring up the whole UI — window, tray, shortcuts, updater — the moment the
    // servers are up, BEFORE the (potentially long) replay scan runs. Doing this
    // after start() resolves would leave the tray absent and the unlock shortcut
    // unregistered for the entire scan, so the app looked frozen on first launch.
    backend = await require('../src/index').start({
      onServersUp: (httpPort) => {
        createWindow(httpPort);
        createTray();
        globalShortcut.register('CommandOrControl+Shift+O', () => app.quit());
        globalShortcut.register('CommandOrControl+Shift+L', () => setLocked(!locked));
        initUpdates();
      },
    });
  } catch (e) {
    dialog.showErrorBox('osu! Pacemaker failed to start', String(e && e.stack ? e.stack : e));
    app.quit();
    return;
  }
});

app.on('second-instance', () => { if (win) win.show(); });
app.on('window-all-closed', () => app.quit());
app.on('will-quit', async (e) => {
  globalShortcut.unregisterAll();
  if (backend) { const b = backend; backend = null; e.preventDefault(); try { await b.stop(); } catch {} app.exit(0); }
});
