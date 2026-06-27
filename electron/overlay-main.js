'use strict';

/**
 * In-game overlay shell.
 *
 * Wraps the same overlay (served at http://localhost:HTTP_PORT/) in a
 * transparent, frameless, always-on-top, click-through window so it floats over
 * osu! while you play — not just in OBS.
 *
 * IMPORTANT: run osu! in **Borderless** (Options ▸ Graphics ▸ uncheck
 * "Fullscreen"). An always-on-top window cannot draw above an EXCLUSIVE-
 * fullscreen game on Windows; borderless lets the overlay composite on top.
 *
 * Run the backend first (`npm start`), then `npm run overlay`.
 * Hotkeys:  Ctrl+Shift+O quits the overlay,  Ctrl+Shift+L toggles click-through.
 */
const { app, BrowserWindow, screen, globalShortcut } = require('electron');
const { config } = require('../config');

let win = null;
let clickThrough = true;

function createWindow() {
  const display = screen.getPrimaryDisplay();
  const { x, y, width, height } = display.bounds; // full bounds incl. taskbar area

  win = new BrowserWindow({
    x, y, width, height,
    transparent: true,
    frame: false,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    focusable: false,        // never steals focus/keyboard from osu!
    skipTaskbar: true,
    alwaysOnTop: true,
    hasShadow: false,
    fullscreenable: false,
    backgroundColor: '#00000000',
    webPreferences: { contextIsolation: true, backgroundThrottling: false },
  });

  // 'screen-saver' is the highest practical level; keeps us above borderless games.
  win.setAlwaysOnTop(true, 'screen-saver');
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  win.setIgnoreMouseEvents(true, { forward: true }); // clicks pass through to osu!

  win.loadURL(`http://localhost:${config.httpPort}/`);
}

app.whenReady().then(() => {
  // Reduce the chance the compositor pushes us behind the game.
  app.commandLine.appendSwitch('disable-renderer-backgrounding');
  createWindow();

  globalShortcut.register('CommandOrControl+Shift+O', () => app.quit());
  globalShortcut.register('CommandOrControl+Shift+L', () => {
    if (!win) return;
    clickThrough = !clickThrough;
    win.setIgnoreMouseEvents(clickThrough, { forward: true });
    win.setFocusable(!clickThrough); // need focus to receive drag clicks while unlocked
    if (!clickThrough) win.focus();
    // Mirror the lock state into the page so drag/resize handles show/hide.
    win.webContents
      .executeJavaScript(`window.setOverlayUnlocked && window.setOverlayUnlocked(${!clickThrough})`)
      .catch(() => {});
  });

  // Periodically reassert top-most; some games/Windows focus changes can demote it.
  setInterval(() => {
    if (win && !win.isDestroyed()) win.setAlwaysOnTop(true, 'screen-saver');
  }, 2000);
});

app.on('will-quit', () => globalShortcut.unregisterAll());
app.on('window-all-closed', () => app.quit());
