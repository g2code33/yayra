'use strict';

/**
 * Renderer-driven dragging for frameless shell windows.
 *
 * Electron's CSS `-webkit-app-region: drag` hands input to the window
 * manager before Chromium can dispatch it. On Linux in particular, a native
 * drag can leave the custom tab strip in a compositor-owned input grab, which
 * looks exactly like frozen tabs/window buttons. Keep the complete top chrome
 * renderer-owned and move only when the dedicated handle streams pointer
 * coordinates over IPC.
 */
function createWindowDragController({
  ipcMain,
  BrowserWindow,
  setTimeoutImpl = setTimeout,
  clearTimeoutImpl = clearTimeout,
  logger = console
} = {}) {
  if (!ipcMain || !BrowserWindow) throw new Error('window drag controller requires ipcMain and BrowserWindow');

  const active = new Map();
  const listeners = new Map();

  const senderKey = (event) => event?.sender?.id ?? event?.sender ?? null;
  const senderWindow = (event) => {
    try {
      const win = BrowserWindow.fromWebContents(event?.sender);
      return win && !win.isDestroyed?.() ? win : null;
    } catch {
      return null;
    }
  };
  const point = (value) => {
    if (typeof value?.x !== 'number' || typeof value?.y !== 'number') return null;
    const { x, y } = value;
    return Number.isFinite(x) && Number.isFinite(y)
      && Math.abs(x) <= 10000000 && Math.abs(y) <= 10000000
      ? { x, y }
      : null;
  };

  function cancel(key, { flush = false } = {}) {
    const state = active.get(key);
    if (!state) return false;
    if (flush && state.pendingPoint) apply(state, state.pendingPoint);
    if (state.frameTimer) clearTimeoutImpl(state.frameTimer);
    if (state.safetyTimer) clearTimeoutImpl(state.safetyTimer);
    active.delete(key);
    return true;
  }

  function apply(state, current) {
    if (!state || !current || !state.win || state.win.isDestroyed?.()
      || state.win.isMaximized?.() || state.win.isFullScreen?.()) return false;
    const x = Math.round(state.windowStart.x + (current.x - state.pointerStart.x));
    const y = Math.round(state.windowStart.y + (current.y - state.pointerStart.y));
    try {
      // `setPosition` preserves the current size and is the least disruptive
      // API for a normal resizable BrowserWindow. The setBounds fallback
      // keeps test doubles and older embedders supported.
      if (typeof state.win.setPosition === 'function') state.win.setPosition(x, y, false);
      else if (typeof state.win.setBounds === 'function') {
        const [width, height] = typeof state.win.getSize === 'function' ? state.win.getSize() : [1200, 800];
        state.win.setBounds({ x, y, width, height }, false);
      } else return false;
      return true;
    } catch (err) {
      logger?.warn?.(`[yayra] manual window drag failed: ${err?.message || err}`);
      return false;
    }
  }

  function queueMove(key, current) {
    const state = active.get(key);
    if (!state) return false;
    state.pendingPoint = current;
    if (state.frameTimer) return true;
    // Coalesce a high-frequency pointer stream to at most one native move
    // per frame. Flooding setPosition is itself capable of making some Linux
    // window managers feel stuck.
    state.frameTimer = setTimeoutImpl(() => {
      state.frameTimer = null;
      const latest = state.pendingPoint;
      state.pendingPoint = null;
      if (!apply(state, latest)) cancel(key);
    }, 16);
    state.frameTimer?.unref?.();
    return true;
  }

  function begin(event, rawPoint) {
    const key = senderKey(event);
    const win = senderWindow(event);
    const start = point(rawPoint);
    if (key === null || !win || !start) return false;
    // Moving a maximized/fullscreen window programmatically can fight the
    // compositor. Restore is always available from the adjacent button.
    if (win.isMaximized?.() || win.isFullScreen?.()) return false;
    cancel(key);
    let position;
    try {
      const [x, y] = win.getPosition();
      position = point({ x, y });
      if (!position) return false;
    } catch {
      return false;
    }
    const state = {
      win,
      pointerStart: start,
      windowStart: position,
      pendingPoint: null,
      frameTimer: null,
      safetyTimer: null
    };
    // Lost pointerup/lostpointercapture must never leave a drag session alive.
    state.safetyTimer = setTimeoutImpl(() => cancel(key, { flush: true }), 15000);
    state.safetyTimer?.unref?.();
    active.set(key, state);
    return true;
  }

  function move(event, rawPoint) {
    const key = senderKey(event);
    const current = point(rawPoint);
    return key !== null && current ? queueMove(key, current) : false;
  }

  function end(event) {
    const key = senderKey(event);
    return key !== null ? cancel(key, { flush: true }) : false;
  }

  const channels = {
    'yayra:window-drag-start': begin,
    'yayra:window-drag-move': move,
    'yayra:window-drag-end': end
  };
  for (const [channel, handler] of Object.entries(channels)) {
    const listener = (event, payload) => handler(event, payload);
    listeners.set(channel, listener);
    ipcMain.on(channel, listener);
  }

  return {
    begin,
    move,
    end,
    // Native BrowserWindow focus/blur/minimize recovery does not carry an
    // IPC event object, but the sender WebContents id is the same map key.
    // This lets the main process revoke a renderer drag independently of a
    // potentially lost pointerup message.
    cancelForWebContents(contents, { flush = false } = {}) {
      const key = contents?.id ?? contents ?? null;
      return key !== null ? cancel(key, { flush }) : false;
    },
    activeCount: () => active.size,
    destroy() {
      for (const key of [...active.keys()]) cancel(key);
      if (typeof ipcMain.removeListener === 'function') {
        for (const [channel, listener] of listeners) ipcMain.removeListener(channel, listener);
      }
      listeners.clear();
    }
  };
}

module.exports = { createWindowDragController };
