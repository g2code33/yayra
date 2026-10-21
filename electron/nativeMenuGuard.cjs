'use strict';

/**
 * Electron native popup menus enter an OS-managed input loop. Ordinarily the
 * loop ends on selection, Escape, outside click or app blur; compositor/focus
 * loss can occasionally swallow every one of those terminal events. A menu
 * that outlives its popup then keeps the frameless window's top chrome looking
 * frozen while its independent WebContentsView page continues running.
 *
 * This guard gives every popup deterministic ownership:
 *  - at most one popup per BrowserWindow;
 *  - app/window blur, hide, minimize, close, or renderer loss closes it;
 *  - an independent safety deadline closes an abandoned native input loop;
 *  - cleanup runs exactly once even when Electron invokes callback reentrantly.
 */
const activeByWindow = new WeakMap();

function popupMenuWithRecovery({
  menu,
  window: ownerWindow = null,
  popupOptions = {},
  callback = null,
  timeoutMs = 30000,
  setTimeoutImpl = setTimeout,
  clearTimeoutImpl = clearTimeout,
  logger = console
} = {}) {
  if (!menu || typeof menu.popup !== 'function') return null;

  if (ownerWindow && (typeof ownerWindow === 'object' || typeof ownerWindow === 'function')) {
    try { activeByWindow.get(ownerWindow)?.close('superseded'); } catch { /* old popup already gone */ }
  }

  let settled = false;
  let timer = null;
  const bindings = [];
  const bind = (target, type, listener) => {
    if (!target || typeof target.on !== 'function') return;
    try {
      target.on(type, listener);
      bindings.push([target, type, listener]);
    } catch { /* optional EventEmitter surface */ }
  };
  const unbindAll = () => {
    for (const [target, type, listener] of bindings.splice(0)) {
      try { target.removeListener?.(type, listener); } catch { /* target destroyed */ }
    }
  };
  const settle = (reason = 'callback') => {
    if (settled) return false;
    settled = true;
    if (timer) clearTimeoutImpl(timer);
    timer = null;
    unbindAll();
    if (ownerWindow && activeByWindow.get(ownerWindow)?.settle === settle) {
      activeByWindow.delete(ownerWindow);
    }
    try { callback?.(reason); } catch (error) {
      logger?.warn?.(`[yayra] native menu close callback failed: ${error?.message || error}`);
    }
    return true;
  };
  const close = (reason = 'recovery') => {
    if (settled) return false;
    try { menu.closePopup?.(ownerWindow || undefined); } catch { /* popup already gone */ }
    // Electron normally calls popup.callback from closePopup. Settle here as
    // well because the very failure this guard handles is a missing callback.
    return settle(reason);
  };
  const state = { menu, close, settle };

  if (ownerWindow && (typeof ownerWindow === 'object' || typeof ownerWindow === 'function')) {
    activeByWindow.set(ownerWindow, state);
    const closeFor = (reason) => () => close(reason);
    bind(ownerWindow, 'blur', closeFor('window-blur'));
    bind(ownerWindow, 'hide', closeFor('window-hide'));
    bind(ownerWindow, 'minimize', closeFor('window-minimize'));
    bind(ownerWindow, 'closed', closeFor('window-closed'));
    bind(ownerWindow.webContents, 'render-process-gone', closeFor('renderer-gone'));
    bind(ownerWindow.webContents, 'destroyed', closeFor('renderer-destroyed'));
  }

  const delay = Number.isFinite(Number(timeoutMs)) ? Math.max(1000, Number(timeoutMs)) : 30000;
  timer = setTimeoutImpl(() => close('safety-timeout'), delay);
  timer?.unref?.();

  try {
    menu.popup({
      ...popupOptions,
      ...(ownerWindow ? { window: ownerWindow } : {}),
      callback: () => settle('callback')
    });
  } catch (error) {
    settle('popup-error');
    throw error;
  }
  return state;
}

function closeNativeMenuForWindow(ownerWindow, reason = 'explicit-recovery') {
  if (!ownerWindow || (typeof ownerWindow !== 'object' && typeof ownerWindow !== 'function')) return false;
  try { return Boolean(activeByWindow.get(ownerWindow)?.close(reason)); } catch { return false; }
}

module.exports = { popupMenuWithRecovery, closeNativeMenuForWindow };
