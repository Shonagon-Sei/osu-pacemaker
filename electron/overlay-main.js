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
const path = require('path');
const { app, BrowserWindow, screen, globalShortcut, ipcMain } = require('electron');
const { config } = require('../config');

let win = null;
let clickThrough = true;
let displayBounds = null; // primary display bounds; origin for renderer-sent coords

function createWindow() {
  const display = screen.getPrimaryDisplay();
  displayBounds = display.bounds; // full bounds incl. taskbar area
  const { x, y } = displayBounds;

  // Start small, not full-screen: a full-screen transparent (layered) window
  // forces Windows to composite the cursor in software, which lags the mouse
  // while playing. The renderer drives the real bounds — tight to the board
  // while locked, full-screen while unlocked (see the IPC handlers below).
  win = new BrowserWindow({
    x, y, width: 480, height: 320,
    transparent: true,
    frame: false,
    // Must stay resizable: with resizable:false Windows clamps the window to its
    // initial size and ignores our programmatic setBounds (which we use to fit the
    // board). It's frameless + click-through, so the user can't resize it by hand.
    resizable: true,
    movable: false,
    minimizable: false,
    maximizable: false,
    focusable: false,        // never steals focus/keyboard from osu!
    skipTaskbar: true,
    alwaysOnTop: true,
    hasShadow: false,
    fullscreenable: false,
    backgroundColor: '#00000000',
    webPreferences: {
      contextIsolation: true,
      backgroundThrottling: false,
      preload: path.join(__dirname, 'overlay-preload.js'),
    },
  });

  // 'screen-saver' is the highest practical level; keeps us above borderless games.
  win.setAlwaysOnTop(true, 'screen-saver');
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  // Click-through so input passes to osu!. Do NOT use { forward: true }: it makes
  // Electron forward every mouse-move to the renderer across the whole screen,
  // which with osu!'s high-polling raw input floods the overlay and causes severe
  // cursor lag. The renderer doesn't use forwarded moves — lock/unlock is driven
  // by the Ctrl+Shift+L hotkey, and drag/resize only run while unlocked (where
  // click-through is off and the window gets real events directly).
  win.setIgnoreMouseEvents(true);

  win.loadURL(`http://localhost:${config.httpPort}/`);
}

// ── Renderer-driven window bounds ──────────────────────────────────────────────
// The page knows its own size/position (board content, the user's chosen spot),
// so it tells us the exact OS-window rect to use. Coords are display-local; we
// offset by the display origin. Tight bounds while locked keep the cursor on the
// hardware plane (no lag); full-screen while unlocked lets the settings panel and
// drag-to-place work across the whole screen.
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

app.whenReady().then(() => {
  // Reduce the chance the compositor pushes us behind the game.
  app.commandLine.appendSwitch('disable-renderer-backgrounding');
  createWindow();

  globalShortcut.register('CommandOrControl+Shift+O', () => app.quit());
  globalShortcut.register('CommandOrControl+Shift+L', () => {
    if (!win) return;
    clickThrough = !clickThrough;
    win.setIgnoreMouseEvents(clickThrough); // no forward (see createWindow)
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
