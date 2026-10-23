/**
 * "THE APP ALSO FREEZES SOMETIMES" - root causes & pins.
 *
 * Four real stall sources, each fixed and pinned here:
 *
 *  1. THUNDERING HERD: session-restored tabs all stamped
 *     lastLoadCompletedAt at the same instant, so 5 minutes later EVERY
 *     background tab reloaded in the SAME 60s tick - a periodic
 *     network/CPU/GPU spike that froze the app for seconds. Now at most
 *     ONE tab (the stalest) reloads per tick.
 *  2. DOWNLOAD WRITE STORM: every DownloadItem 'updated' event (many per
 *     second) did a synchronous read+write of downloads.json on the MAIN
 *     thread - the whole app stuttered while anything downloaded. Disk
 *     persistence is now gated to state changes or 750ms checkpoints;
 *     the UI still gets every progress event.
 *  3. MAIN-THREAD DISK POLLING: downloadsStore re-read + re-parsed its
 *     file synchronously on every renderer poll. It now caches (this
 *     process is the only writer), and the renderer poll dropped from
 *     4s to 15s with a document.hidden skip - the 'storage' event
 *     listener remains the real-time sync path.
 *  4. OVERLAY SNAPSHOT LIFECYCLE: native pages hide immediately while one
 *     deduplicated asynchronous capture is in flight, so menus never wait on
 *     capture or freeze input. Captures remain lossless/native-resolution so
 *     website text beneath Yayra overlays is clear rather than JPEG-softened.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { setupDomShim } from './dom-shim.mjs';
import { createDownloadsBridge } from '../electron/downloadsBridge.cjs';
import { createDownloadsStore } from '../electron/downloadsStore.cjs';
import { createWebviewBridge } from '../electron/webviewBridge.cjs';

setupDomShim();
const disk = new Map();
globalThis.localStorage = {
  getItem: (k) => (disk.has(k) ? disk.get(k) : null),
  setItem: (k, v) => disk.set(k, String(v)),
  removeItem: (k) => disk.delete(k),
  key: (i) => [...disk.keys()][i] ?? null,
  get length() { return disk.size; }
};

const { BrowserShell } = await import('../packages/shared-ui/src/components/BrowserShell.js');

// ---- 1. background tabs are NEVER reloaded (Chrome keep-alive) ---------

test('background tabs are never reloaded, not even one per tick - restored sessions never reload in a herd (Chrome keep-alive)', async () => {
  disk.clear();
  const reloads = [];
  globalThis.window.yayra = {
    webview: {
      ensure: async () => ({}), setBounds: async () => {}, setVisible: async () => {},
      stop: async () => {}, goBack: async () => {}, goForward: async () => {},
      reload: async (tabId) => { reloads.push(tabId); }, destroy: async () => {},
      capture: async () => ({}), onEvent: () => () => {}
    }
  };
  const container = document.createElement('div');
  const shell = new BrowserShell({ container, platform: 'linux', isMobile: false });
  await shell.initialize();
  shell.render(container);

  const activeId = shell.state.activeTabId;
  const mkTab = (id, age) => {
    const t = { id, title: id, url: `https://${id}.example.com/`, isLoading: false, isPrivate: false, favicon: null, lastLoadCompletedAt: Date.now() - age };
    shell.state.tabs.push(t);
    shell._nativeWebviewTabIds.add(id);
    return t;
  };
  // Three background tabs, ALL overdue at once (the restored-session case).
  mkTab('t-old', 30 * 60 * 1000);
  mkTab('t-older', 40 * 60 * 1000);
  mkTab('t-oldest', 60 * 60 * 1000);
  shell.state.activeTabId = activeId;

  // Chrome keep-alive: however stale they are, loaded pages are left
  // completely alone - no herd, no stagger, no reloads at all. Let time
  // pass and poke the shell's own background services.
  shell.startBackgroundRefresh();
  await new Promise((r) => setTimeout(r, 30));
  shell.stopBackgroundRefresh();
  assert.deepEqual(reloads, [], 'zero background reloads - every loaded page stays intact');
  shell.destroy();
  delete globalThis.window.yayra;
});

test('background store poll: 15s cadence with a hidden-window skip (static pin)', () => {
  const src = fs.readFileSync(new URL('../packages/shared-ui/src/components/BrowserShell.js', import.meta.url), 'utf8');
  assert.match(src, /document\.hidden === true\) return;\s*\n\s*this\.backgroundRefreshTick/,
    'hidden/minimized windows skip the whole polling pass');
  assert.match(src, /\}, 15000\);/, 'poll cadence is 15s');
  assert.equal(/backgroundRefreshTick\(\)\.catch\(\(\) => \{\}\);\s*\n\s*\}, 4000\)/.test(src), false,
    'the old 4s store-churn cadence is gone');
});

// ---- 2+3. downloads: no main-thread disk storms -------------------------

function fakeIpcMain() {
  const handlers = new Map();
  return { handlers, handle: (channel, fn) => handlers.set(channel, fn) };
}

function fakeSession() {
  const listeners = {};
  return { on: (event, cb) => { listeners[event] = cb; }, emit: (event, ...args) => listeners[event]?.(...args) };
}

function fakeDownloadItem({ filename, totalBytes = 1000 }) {
  const listeners = {};
  let savePath = null;
  let received = 0;
  return {
    getFilename: () => filename,
    getURL: () => 'https://example.com/file',
    getTotalBytes: () => totalBytes,
    getReceivedBytes: () => received,
    getSavePath: () => savePath,
    setSavePath: (p) => { savePath = p; },
    on: (event, cb) => { listeners[event] = cb; },
    once: (event, cb) => { listeners[event] = cb; },
    _progress: (bytes, state = 'progressing') => { received = bytes; listeners.updated?.(null, state); },
    _fireDone: (state = 'completed') => listeners.done?.(null, state)
  };
}

test('download progress events do NOT each hit the disk: writes are gated, UI still gets every event', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'yayra-dl-throttle-'));
  const downloadsStore = createDownloadsStore({ fs, userDataDir: dir, defaultDownloadsDir: path.join(dir, 'Downloads') });
  let persistCalls = 0;
  const realAdd = downloadsStore.addOrUpdateItem;
  downloadsStore.addOrUpdateItem = (item) => { persistCalls += 1; return realAdd(item); };

  const ipcMain = fakeIpcMain();
  const sess = fakeSession();
  const sent = [];
  createDownloadsBridge({
    ipcMain,
    shell: {},
    dialog: {},
    path,
    fs,
    sessions: [sess],
    downloadsStore,
    getMainWindow: () => ({ isDestroyed: () => false, webContents: { send: (ch, payload) => sent.push(payload) } }),
    idFactory: () => 'dl-storm-1'
  });

  const item = fakeDownloadItem({ filename: 'big.iso', totalBytes: 100_000 });
  sess.emit('will-download', {}, item);
  const persistedAfterStart = persistCalls;

  // A burst of 25 chunk events in the same instant (real downloads fire
  // many per second). Previously: 25 synchronous main-thread disk writes.
  for (let i = 1; i <= 25; i += 1) item._progress(i * 1000);
  assert.equal(persistCalls, persistedAfterStart,
    'same-state progress bursts inside the checkpoint window never touch the disk');
  assert.equal(sent.filter((p) => p.type === 'progress').length, 25, 'the LIVE UI still got all 25 progress events');

  // A state change persists immediately (pause must survive a crash)...
  item._progress(26_000, 'interrupted');
  assert.equal(persistCalls, persistedAfterStart + 1, 'state change -> immediate persist');
  assert.equal(downloadsStore.load().items[0].state, 'Paused');

  // ...and completion always persists the final record.
  item._fireDone('completed');
  assert.equal(downloadsStore.load().items[0].state, 'Completed');
});

test('downloadsStore caches reads: repeat load()/list() polls never re-read the file from disk', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'yayra-dl-cache-'));
  let reads = 0;
  const countingFs = {
    ...fs,
    existsSync: (p) => fs.existsSync(p),
    readFileSync: (p, enc) => { reads += 1; return fs.readFileSync(p, enc); },
    writeFileSync: (p, data, opts) => fs.writeFileSync(p, data, opts),
    mkdirSync: (p, opts) => fs.mkdirSync(p, opts)
  };
  const store = createDownloadsStore({ fs: countingFs, userDataDir: dir, defaultDownloadsDir: '/dl' });
  store.addOrUpdateItem({ id: 'a', filename: 'x.txt', state: 'Completed' });

  const before = reads;
  for (let i = 0; i < 50; i += 1) store.load(); // the renderer poll, 50 times over
  assert.equal(reads, before, '50 polls, zero disk reads - the cache serves them all');
  assert.equal(store.load().items[0].id, 'a', 'cache stays correct after writes');

  // A fresh process/instance still reads the truth from disk.
  const store2 = createDownloadsStore({ fs: countingFs, userDataDir: dir, defaultDownloadsDir: '/dl' });
  assert.equal(store2.load().items[0].id, 'a', 'persistence across instances intact');
});

// ---- 4. snapshots are asynchronous, deduplicated, and lossless ----------

function makeWebviewHarness() {
  const handlers = new Map();
  const ipcMain = { handle: (c, f) => handlers.set(c, f), on: () => {} };
  const views = [];
  const WebContentsView = function FakeView() {
    const view = {
      webContents: {
        loadURL: async () => {},
        on: () => {}, once: () => {},
        setWindowOpenHandler: () => {}, setUserAgent: () => {},
        isDestroyed: () => false, close: () => {}
      },
      bounds: null,
      setBounds(b) { this.bounds = b; }
    };
    views.push(view);
    return view;
  };
  const fakeWin = {
    isDestroyed: () => false,
    webContents: { send: () => {} },
    contentView: { children: [], addChildView(v) { this.children.push(v); }, removeChildView() {} }
  };
  createWebviewBridge({ WebContentsView, ipcMain, shell: { openExternal: async () => {} }, getMainWindow: () => fakeWin, logger: { error: () => {} } });
  return { handlers, views };
}

test('page snapshots stay lossless at native resolution so overlays never blur website text', async () => {
  const { handlers, views } = makeWebviewHarness();
  await handlers.get('yayra:webview-ensure')(null, { tabId: 'tab-1', url: 'https://example.com/' });

  const resizeCalls = [];
  const jpegCalls = [];
  views[0].webContents.capturePage = async () => ({
    isEmpty: () => false,
    getSize: () => ({ width: 2560, height: 1440 }),
    resize: (opts) => { resizeCalls.push(opts); return null; },
    toJPEG: (quality) => { jpegCalls.push(quality); return Buffer.from('lossy'); },
    toDataURL: () => 'data:image/png;base64,FULL-NATIVE-RESOLUTION'
  });

  const result = await handlers.get('yayra:webview-capture')(null, { tabId: 'tab-1' });
  assert.equal(result.snapshot, 'data:image/png;base64,FULL-NATIVE-RESOLUTION');
  assert.deepEqual(resizeCalls, [], 'the capture is never downscaled');
  assert.deepEqual(jpegCalls, [], 'the capture is never JPEG-compressed');
});

test('snapshot falls back to PNG when the captured image lacks resize/toJPEG', async () => {
  const { handlers, views } = makeWebviewHarness();
  await handlers.get('yayra:webview-ensure')(null, { tabId: 'tab-1', url: 'https://example.com/' });
  views[0].webContents.capturePage = async () => ({ isEmpty: () => false, toDataURL: () => 'data:image/png;base64,SNAP' });
  const result = await handlers.get('yayra:webview-capture')(null, { tabId: 'tab-1' });
  assert.equal(result.snapshot, 'data:image/png;base64,SNAP', 'graceful PNG fallback keeps snapshots working');
});
