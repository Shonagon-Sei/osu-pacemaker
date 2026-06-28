'use strict';

/**
 * Bridges the overlay renderer to the main process so it can drive the OS
 * window's size/position. While "locked" (playing) the renderer shrinks the
 * window to just the board — a full-screen transparent window makes Windows
 * composite the cursor in software and lag the mouse. See overlay-main.js.
 */
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('overlayBounds', {
  // Tight bounds (display-local px) for the locked, click-through board.
  set: (b) => ipcRenderer.send('overlay:bounds', b),
  // Restore the full-screen window (used while unlocked/editing).
  full: () => ipcRenderer.send('overlay:full'),
});

contextBridge.exposeInMainWorld('overlayApp', {
  // Ask the main process to unlock (make interactive) — used by the first-run
  // guide so the settings panel is clickable on first launch.
  requestUnlock: () => ipcRenderer.send('overlay:request-unlock'),
});
