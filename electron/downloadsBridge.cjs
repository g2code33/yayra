'use strict';

/**
 * Real file-download tracking for Yayra's Electron desktop build.
 *
 * Wires Electron's `session.on('will-download', ...)` for every session
 * passed in (the shared "persist:yayra-webview" partition that regular tabs
 * use, plus the main window's own session) to electron/downloadsStore.cjs,
 * and exposes the result over IPC as `window.yayra.downloads` (see
 * electron/preload.cjs). This replaces what used to be a hardcoded fake
 * "yayra-v0.1.0-setup.exe" row in the renderer with the app's *actual*
 * download history, and backs the "Open" / "Show in Folder" / "Remove"
 * actions with real shell operations instead of alert() placeholders.
 *
 * Also lets the user pick their own download folder ("storage root") via a
 * native OS folder picker; every new download is saved under that folder
 * (falling back to the OS default Downloads directory until the user picks
 * one), with Chrome-style " (1)", " (2)", ... suffixing on filename
 * collisions so nothing is silently overwritten.
 *
 * Fully dependency-injected (ipcMain, shell, dialog, path, fs, sessions,
 * downloadsStore, getMainWindow) so this is unit-testable with fake
 * DownloadItem/session objects and no real Electron runtime - see
 * tests/downloads-bridge.test.mjs. Mirrors the factory pattern used by
 * createWebviewBridge / createAuthBridge.
 */

const DOWNLOADS_EVENT_CHANNEL = 'yayra:downloads-event';

function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes < 0) return '0 B';
  if (bytes === 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const exp = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  const value = bytes / 1024 ** exp;
  return `${exp === 0 ? value : value.toFixed(1)} ${units[exp]}`;
}

/** Chrome-style collision-avoiding save path: "file.pdf" -> "file (1).pdf" */
function uniqueSavePath({ fs, path, dir, filename }) {
  const ext = path.extname(filename);
  const base = filename.slice(0, filename.length - ext.length);
  let candidate = path.join(dir, filename);
  let n = 1;
  while (fs.existsSync(candidate)) {
    candidate = path.join(dir, `${base} (${n})${ext}`);
    n += 1;
  }
  return candidate;
}

function createDownloadsBridge({
  ipcMain,
  shell,
  dialog,
  path,
  fs,
  sessions = [],
  downloadsStore,
  getMainWindow,
  onDownloadStarted = null,
  onDownloadCompleted = null,
  idFactory = () => `dl-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
  logger = console
}) {
  function send(type, payload = {}) {
    const win = getMainWindow?.();
    if (!win || win.isDestroyed()) return;
    win.webContents.send(DOWNLOADS_EVENT_CHANNEL, { type, ...payload });
  }

  // Live Electron DownloadItem handles for IN-PROGRESS downloads, keyed by
  // our record id - what makes cancel/pause/resume real actions instead of
  // decorations. Entries are dropped the moment a download settles.
  const activeItems = new Map();

  function attachItem(item, sourceWebContents = null) {
    const id = idFactory();
    let dir;
    try {
      dir = downloadsStore.getDownloadRoot();
      fs.mkdirSync(dir, { recursive: true });
    } catch {
      dir = downloadsStore.getDownloadRoot();
    }
    const filename = item.getFilename();
    let savePath;
    try {
      savePath = uniqueSavePath({ fs, path, dir, filename });
      item.setSavePath(savePath);
    } catch (err) {
      logger?.warn?.(`[yayra:downloads] could not set save path: ${err?.message || err}`);
      savePath = item.getSavePath ? item.getSavePath() : filename;
    }

    const record = {
      id,
      filename,
      path: savePath,
      url: typeof item.getURL === 'function' ? item.getURL() : '',
      mimeType: typeof item.getMimeType === 'function' ? item.getMimeType() : '',
      sizeBytes: typeof item.getTotalBytes === 'function' ? item.getTotalBytes() : 0,
      size: formatBytes(typeof item.getTotalBytes === 'function' ? item.getTotalBytes() : 0),
      state: 'Downloading',
      startedAt: new Date().toISOString(),
      date: 'Just now'
    };
    downloadsStore.addOrUpdateItem(record);
    activeItems.set(id, item);
    send('started', record);
    try {
      onDownloadStarted?.({
        webContents: sourceWebContents,
        id,
        url: record.url,
        filename: record.filename,
        mimeType: record.mimeType
      });
    } catch (err) {
      logger?.warn?.(`[yayra:downloads] download handoff notification failed: ${err?.message || err}`);
    }

    // 'updated' fires for every received chunk - persisting EVERY event
    // meant a synchronous disk write on the main thread many times per
    // second for the whole download ("the app freezes while downloading").
    // The live UI keeps every progress event (send() is cheap); the disk
    // only needs a state change or a 750ms-spaced byte checkpoint.
    const persistGate = { at: Date.now(), state: record.state };
    item.on('updated', (_event, state) => {
      const received = typeof item.getReceivedBytes === 'function' ? item.getReceivedBytes() : 0;
      const total = typeof item.getTotalBytes === 'function' ? item.getTotalBytes() : 0;
      const updated = {
        ...record,
        state: state === 'interrupted' ? 'Paused' : 'Downloading',
        receivedBytes: received,
        sizeBytes: total || record.sizeBytes,
        size: formatBytes(total || received),
        progress: total > 0 ? Math.round((received / total) * 100) : null
      };
      const now = Date.now();
      if (updated.state !== persistGate.state || now - persistGate.at >= 750) {
        downloadsStore.addOrUpdateItem(updated);
        persistGate.at = now;
        persistGate.state = updated.state;
      }
      send('progress', updated);
    });

    item.once('done', (_event, state) => {
      const finalState = state === 'completed' ? 'Completed' : state === 'cancelled' ? 'Cancelled' : 'Failed';
      const total = typeof item.getTotalBytes === 'function' ? item.getTotalBytes() : record.sizeBytes;
      const updated = {
        ...record,
        state: finalState,
        sizeBytes: total,
        size: formatBytes(total),
        progress: finalState === 'Completed' ? 100 : null,
        completedAt: new Date().toISOString()
      };
      downloadsStore.addOrUpdateItem(updated);
      activeItems.delete(id);
      send('done', updated);
      if (finalState === 'Completed') {
        try {
          Promise.resolve(onDownloadCompleted?.(updated)).catch((err) => {
            logger?.warn?.(`[yayra:downloads] completion integration failed: ${err?.message || err}`);
          });
        } catch (err) {
          logger?.warn?.(`[yayra:downloads] completion integration failed: ${err?.message || err}`);
        }
      }
    });

    return record;
  }

  function handleWillDownload(_event, item, sourceWebContents) {
    try {
      attachItem(item, sourceWebContents);
    } catch (err) {
      logger?.error?.(`[yayra:downloads] will-download handling failed: ${err?.message || err}`);
    }
  }

  sessions.filter(Boolean).forEach((sess) => {
    sess.on('will-download', handleWillDownload);
  });

  // Later-created sessions (e.g. per-profile partitions for profile
  // windows) can join download tracking too; duplicates are guarded.
  const attachedSessions = new WeakSet(sessions.filter(Boolean));
  function attachSession(sess) {
    if (!sess || attachedSessions.has(sess)) return false;
    attachedSessions.add(sess);
    sess.on('will-download', handleWillDownload);
    return true;
  }

  async function handleList() {
    return downloadsStore.load();
  }

  async function handleClear() {
    const next = downloadsStore.clearItems();
    return { ok: true, items: next.items };
  }

  async function handleRemove(_event, { id } = {}) {
    const next = downloadsStore.removeItem(id);
    return { ok: true, items: next.items };
  }

  async function handleOpen(_event, { id } = {}) {
    const { items } = downloadsStore.load();
    const item = items.find((it) => it.id === id);
    if (!item) return { ok: false, error: 'not_found' };
    try {
      const result = await shell.openPath(item.path);
      if (result) return { ok: false, error: result };
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err?.message || String(err) };
    }
  }

  async function handleShowInFolder(_event, { id } = {}) {
    const { items } = downloadsStore.load();
    const item = items.find((it) => it.id === id);
    if (!item) return { ok: false, error: 'not_found' };
    try {
      shell.showItemInFolder(item.path);
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err?.message || String(err) };
    }
  }

  async function handleCancel(_event, { id } = {}) {
    const item = activeItems.get(id);
    if (!item) return { ok: false, error: 'not_active' };
    try {
      item.cancel();
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err?.message || String(err) };
    }
  }

  async function handlePause(_event, { id } = {}) {
    const item = activeItems.get(id);
    if (!item || typeof item.pause !== 'function') return { ok: false, error: 'not_active' };
    try {
      item.pause();
      const { items } = downloadsStore.load();
      const record = items.find((it) => it.id === id);
      if (record) {
        const updated = { ...record, state: 'Paused' };
        downloadsStore.addOrUpdateItem(updated);
        send('progress', updated);
      }
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err?.message || String(err) };
    }
  }

  async function handleResume(_event, { id } = {}) {
    const item = activeItems.get(id);
    if (!item) return { ok: false, error: 'not_active' };
    try {
      if (typeof item.canResume === 'function' && !item.canResume()) return { ok: false, error: 'cannot_resume' };
      item.resume();
      const { items } = downloadsStore.load();
      const record = items.find((it) => it.id === id);
      if (record) {
        const updated = { ...record, state: 'Downloading' };
        downloadsStore.addOrUpdateItem(updated);
        send('progress', updated);
      }
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err?.message || String(err) };
    }
  }

  // Retry a FAILED/CANCELLED download: re-request the original URL, which
  // flows through will-download again and produces a fresh record; the old
  // failed row is removed so the list never shows a confusing duplicate.
  async function handleRetry(_event, { id } = {}) {
    const { items } = downloadsStore.load();
    const record = items.find((it) => it.id === id);
    if (!record) return { ok: false, error: 'not_found' };
    if (!record.url) return { ok: false, error: 'no_url' };
    const win = getMainWindow?.();
    if (!win || win.isDestroyed()) return { ok: false, error: 'no_window' };
    try {
      downloadsStore.removeItem(id);
      win.webContents.downloadURL(record.url);
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err?.message || String(err) };
    }
  }

  async function handleGetRoot() {
    return { root: downloadsStore.getDownloadRoot() };
  }

  async function handleChooseRoot() {
    const win = getMainWindow?.();
    try {
      const result = await dialog.showOpenDialog(win, {
        title: 'Choose a folder for Yayra downloads',
        properties: ['openDirectory', 'createDirectory']
      });
      if (result.canceled || !result.filePaths?.[0]) return { ok: false, canceled: true };
      const root = result.filePaths[0];
      downloadsStore.setDownloadRoot(root);
      return { ok: true, root };
    } catch (err) {
      return { ok: false, error: err?.message || String(err) };
    }
  }

  ipcMain.handle('yayra:downloads-list', handleList);
  ipcMain.handle('yayra:downloads-clear', handleClear);
  ipcMain.handle('yayra:downloads-remove', handleRemove);
  ipcMain.handle('yayra:downloads-open', handleOpen);
  ipcMain.handle('yayra:downloads-show-in-folder', handleShowInFolder);
  ipcMain.handle('yayra:downloads-get-root', handleGetRoot);
  ipcMain.handle('yayra:downloads-choose-root', handleChooseRoot);
  ipcMain.handle('yayra:downloads-cancel', handleCancel);
  ipcMain.handle('yayra:downloads-pause', handlePause);
  ipcMain.handle('yayra:downloads-resume', handleResume);
  ipcMain.handle('yayra:downloads-retry', handleRetry);

  return {
    attachItem,
    attachSession,
    handleWillDownload,
    handleList,
    handleClear,
    handleRemove,
    handleOpen,
    handleShowInFolder,
    handleGetRoot,
    handleChooseRoot,
    handleCancel,
    handlePause,
    handleResume,
    handleRetry,
    _activeItems: activeItems
  };
}

module.exports = { createDownloadsBridge, DOWNLOADS_EVENT_CHANNEL, formatBytes, uniqueSavePath };
