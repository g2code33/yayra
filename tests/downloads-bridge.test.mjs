import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createDownloadsBridge, formatBytes, uniqueSavePath } from '../electron/downloadsBridge.cjs';
import { createDownloadsStore } from '../electron/downloadsStore.cjs';

function makeTempDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function fakeIpcMain() {
  const handlers = new Map();
  return { handlers, handle: (channel, fn) => handlers.set(channel, fn) };
}

function fakeSession() {
  const listeners = {};
  return {
    on: (event, cb) => { listeners[event] = cb; },
    emit: (event, ...args) => listeners[event]?.(...args)
  };
}

function fakeDownloadItem({ filename, url = 'https://example.com/file', mimeType = 'application/octet-stream', totalBytes = 1000 }) {
  const listeners = {};
  let savePath = null;
  return {
    getFilename: () => filename,
    getURL: () => url,
    getMimeType: () => mimeType,
    getTotalBytes: () => totalBytes,
    getReceivedBytes: () => totalBytes,
    getSavePath: () => savePath,
    setSavePath: (p) => { savePath = p; },
    on: (event, cb) => { listeners[event] = cb; },
    once: (event, cb) => { listeners[event] = cb; },
    _fireUpdated: (state = 'progressing') => listeners.updated?.(null, state),
    _fireDone: (state = 'completed') => listeners.done?.(null, state)
  };
}

test('formatBytes: renders human-readable sizes like a real browser', () => {
  assert.equal(formatBytes(0), '0 B');
  assert.equal(formatBytes(512), '512 B');
  assert.equal(formatBytes(1024 * 1024 * 58.4), '58.4 MB');
});

test('uniqueSavePath: adds Chrome-style " (1)", " (2)" suffixes on filename collisions instead of overwriting', () => {
  const dir = makeTempDir('yayra-dl-unique-');
  fs.writeFileSync(path.join(dir, 'report.pdf'), 'x');
  fs.writeFileSync(path.join(dir, 'report (1).pdf'), 'x');

  const result = uniqueSavePath({ fs, path, dir, filename: 'report.pdf' });
  assert.equal(result, path.join(dir, 'report (2).pdf'));
});

test('downloadsBridge: a real will-download event is tracked, correlated to its page, indexed, and reaches "Completed"', async () => {
  const dir = makeTempDir('yayra-dl-store-');
  const downloadsStore = createDownloadsStore({ fs, userDataDir: dir, defaultDownloadsDir: path.join(dir, 'Downloads') });
  const ipcMain = fakeIpcMain();
  const sess = fakeSession();
  const sent = [];
  const handoffs = [];
  const completed = [];
  const sourceWebContents = { id: 42 };
  const mainWindow = { isDestroyed: () => false, webContents: { send: (ch, payload) => sent.push(payload) } };

  createDownloadsBridge({
    ipcMain,
    shell: { openPath: async () => '', showItemInFolder: () => {} },
    dialog: {},
    path,
    fs,
    sessions: [sess],
    downloadsStore,
    getMainWindow: () => mainWindow,
    onDownloadStarted: (details) => handoffs.push(details),
    onDownloadCompleted: (record) => completed.push(record),
    idFactory: () => 'dl-test-1'
  });

  const item = fakeDownloadItem({ filename: 'setup.exe', mimeType: 'application/vnd.microsoft.portable-executable', totalBytes: 2048 });
  sess.emit('will-download', {}, item, sourceWebContents);

  // Started: real path was set under the configured download root.
  assert.ok(item.getSavePath().startsWith(downloadsStore.getDownloadRoot()));
  let { items } = downloadsStore.load();
  assert.equal(items.length, 1);
  assert.equal(items[0].state, 'Downloading');
  assert.equal(items[0].mimeType, 'application/vnd.microsoft.portable-executable');
  assert.equal(sent.at(-1).type, 'started');
  assert.equal(handoffs.length, 1);
  assert.equal(handoffs[0].webContents, sourceWebContents, 'the page that initiated the handoff is preserved for ERR_FAILED correlation');

  item._fireUpdated('progressing');
  ({ items } = downloadsStore.load());
  assert.equal(items[0].state, 'Downloading');
  assert.equal(sent.at(-1).type, 'progress');

  item._fireDone('completed');
  ({ items } = downloadsStore.load());
  assert.equal(items[0].state, 'Completed');
  assert.equal(sent.at(-1).type, 'done');
  await Promise.resolve();
  assert.equal(completed.length, 1, 'completed files are offered to the Documents-library integration');
  assert.equal(completed[0].path, item.getSavePath());
});

test('downloadsBridge: never seeds fake history - list() reflects only what has actually been downloaded', async () => {
  const dir = makeTempDir('yayra-dl-empty-');
  const downloadsStore = createDownloadsStore({ fs, userDataDir: dir, defaultDownloadsDir: '/dl' });
  const ipcMain = fakeIpcMain();
  createDownloadsBridge({
    ipcMain,
    shell: {},
    dialog: {},
    path,
    fs,
    sessions: [],
    downloadsStore,
    getMainWindow: () => null
  });

  const result = await ipcMain.handlers.get('yayra:downloads-list')();
  assert.deepEqual(result.items, []);
});

test('downloadsBridge: open()/showInFolder() call the real shell APIs with the tracked file path, not an alert() placeholder', async () => {
  const dir = makeTempDir('yayra-dl-open-');
  const downloadsStore = createDownloadsStore({ fs, userDataDir: dir, defaultDownloadsDir: '/dl' });
  downloadsStore.addOrUpdateItem({ id: 'dl-1', filename: 'a.txt', path: '/dl/a.txt' });

  const opened = [];
  const shown = [];
  const ipcMain = fakeIpcMain();
  createDownloadsBridge({
    ipcMain,
    shell: {
      openPath: async (p) => { opened.push(p); return ''; },
      showItemInFolder: (p) => { shown.push(p); }
    },
    dialog: {},
    path,
    fs,
    sessions: [],
    downloadsStore,
    getMainWindow: () => null
  });

  const openResult = await ipcMain.handlers.get('yayra:downloads-open')(null, { id: 'dl-1' });
  assert.equal(openResult.ok, true);
  assert.deepEqual(opened, ['/dl/a.txt']);

  const showResult = await ipcMain.handlers.get('yayra:downloads-show-in-folder')(null, { id: 'dl-1' });
  assert.equal(showResult.ok, true);
  assert.deepEqual(shown, ['/dl/a.txt']);
});

test('downloadsBridge: chooseRoot() persists the user-picked folder via the real OS dialog, and does nothing when canceled', async () => {
  const dir = makeTempDir('yayra-dl-root-');
  const downloadsStore = createDownloadsStore({ fs, userDataDir: dir, defaultDownloadsDir: '/dl' });
  const ipcMain = fakeIpcMain();
  let canceled = true;
  createDownloadsBridge({
    ipcMain,
    shell: {},
    dialog: { showOpenDialog: async () => (canceled ? { canceled: true, filePaths: [] } : { canceled: false, filePaths: ['/mnt/drive/Downloads'] }) },
    path,
    fs,
    sessions: [],
    downloadsStore,
    getMainWindow: () => null
  });

  let result = await ipcMain.handlers.get('yayra:downloads-choose-root')();
  assert.equal(result.canceled, true);
  assert.equal(downloadsStore.getDownloadRoot(), '/dl');

  canceled = false;
  result = await ipcMain.handlers.get('yayra:downloads-choose-root')();
  assert.equal(result.ok, true);
  assert.equal(result.root, '/mnt/drive/Downloads');
  assert.equal(downloadsStore.getDownloadRoot(), '/mnt/drive/Downloads');
});

test('downloadsBridge: clear()/remove() actually mutate the persisted store', async () => {
  const dir = makeTempDir('yayra-dl-clear-');
  const downloadsStore = createDownloadsStore({ fs, userDataDir: dir, defaultDownloadsDir: '/dl' });
  downloadsStore.addOrUpdateItem({ id: 'a', filename: 'a' });
  downloadsStore.addOrUpdateItem({ id: 'b', filename: 'b' });

  const ipcMain = fakeIpcMain();
  createDownloadsBridge({ ipcMain, shell: {}, dialog: {}, path, fs, sessions: [], downloadsStore, getMainWindow: () => null });

  let result = await ipcMain.handlers.get('yayra:downloads-remove')(null, { id: 'a' });
  assert.deepEqual(result.items.map((it) => it.id), ['b']);

  result = await ipcMain.handlers.get('yayra:downloads-clear')();
  assert.deepEqual(result.items, []);
});
