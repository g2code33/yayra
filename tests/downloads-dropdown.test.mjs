/**
 * Smart downloads: toolbar progress ring + Chrome-style dropdown.
 *
 *  - The toolbar download button wears a revolving ring tracking the
 *    live aggregate percentage while anything downloads.
 *  - Clicking it opens a DROPDOWN (latest 5 downloads + state-aware
 *    actions). More expands the complete list inline without navigating;
 *    the full downloads page remains an explicit, separate button.
 *  - Actions are state-aware: in progress -> pause/cancel/copy address
 *    (never open/show-in-folder); completed -> open/show in folder/copy
 *    file path/copy address/open address in tab/remove; failed or
 *    cancelled -> retry/copy address/open in tab/remove.
 *  - Per-chunk progress events update the ring and the open dropdown row
 *    IN PLACE - never a full re-render per chunk.
 *  - Bridge: cancel/pause/resume act on the LIVE Electron DownloadItem;
 *    retry re-requests the original URL through will-download.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { setupDomShim } from './dom-shim.mjs';

setupDomShim();

import { BrowserShell } from '../packages/shared-ui/src/components/BrowserShell.js';
import { createDownloadsBridge } from '../electron/downloadsBridge.cjs';
import { createDownloadsStore } from '../electron/downloadsStore.cjs';

function sampleItems() {
  return [
    { id: 'd1', filename: 'movie.mp4', state: 'Downloading', progress: 42, receivedBytes: 4200, sizeBytes: 10000, size: '10 KB', url: 'https://a.dev/movie.mp4', path: '/dl/movie.mp4' },
    { id: 'd2', filename: 'done.zip', state: 'Completed', progress: 100, sizeBytes: 5000, size: '5 KB', url: 'https://a.dev/done.zip', path: '/dl/done.zip', date: 'Today' },
    { id: 'd3', filename: 'broken.iso', state: 'Failed', url: 'https://a.dev/broken.iso', path: '/dl/broken.iso' },
    { id: 'd4', filename: 'old1.txt', state: 'Completed', url: 'https://a.dev/1', path: '/dl/1' },
    { id: 'd5', filename: 'old2.txt', state: 'Completed', url: 'https://a.dev/2', path: '/dl/2' },
    { id: 'd6', filename: 'old3.txt', state: 'Completed', url: 'https://a.dev/3', path: '/dl/3' }
  ];
}

function installDownloadsBridgeStub(calls = []) {
  globalThis.window.yayra = globalThis.window.yayra || {};
  globalThis.window.yayra.downloads = {
    list: async () => ({ items: [], downloadRoot: '/dl' }),
    clear: async () => ({ ok: true, items: [] }),
    remove: async (id) => { calls.push(['remove', id]); return { ok: true, items: [] }; },
    open: async (id) => { calls.push(['open', id]); return { ok: true }; },
    showInFolder: async (id) => { calls.push(['show', id]); return { ok: true }; },
    cancel: async (id) => { calls.push(['cancel', id]); return { ok: true }; },
    pause: async (id) => { calls.push(['pause', id]); return { ok: true }; },
    resume: async (id) => { calls.push(['resume', id]); return { ok: true }; },
    retry: async (id) => { calls.push(['retry', id]); return { ok: true }; },
    getRoot: async () => ({ root: '/dl' }),
    chooseRoot: async () => ({ ok: false }),
    onEvent: () => () => {}
  };
  return () => { delete globalThis.window.yayra; };
}

async function makeShell() {
  const container = document.createElement('div');
  const shell = new BrowserShell({ container, platform: 'linux', isMobile: false });
  await shell.initialize();
  shell.render(container);
  return { shell, container };
}

test('download button opens the dropdown - NEVER the downloads page', async () => {
  const uninstall = installDownloadsBridgeStub();
  try {
    const { shell, container } = await makeShell();
    const before = shell.getActiveTab().url;
    const btn = container.querySelector('.fb-toolbar-downloads-btn');
    btn.click();
    assert.equal(shell.state.isDownloadsDropdownOpen, true);
    assert.equal(shell.getActiveTab().url, before, 'no navigation happened');
    const dropdown = container.querySelector('.fb-downloads-dropdown');
    assert.ok(dropdown, 'dropdown rendered');
    // The full page is one explicit click away.
    dropdown.querySelector('.fb-dl-open-page').click();
    assert.equal(shell.getActiveTab().url, 'yayra://downloads');
    assert.equal(shell.state.isDownloadsDropdownOpen, false);
  } finally {
    uninstall();
  }
});

test('More expands all downloads inline without navigating away from the current tab', async () => {
  const uninstall = installDownloadsBridgeStub();
  try {
    const { shell, container } = await makeShell();
    shell.state.downloadsItems = sampleItems(); // 6 items
    shell.state.isDownloadsDropdownOpen = true;
    shell.render(container);
    const beforeUrl = shell.getActiveTab().url;
    assert.equal(container.querySelectorAll('.fb-dl-item').length, 5, 'the dropdown starts with the latest 5');
    const more = container.querySelector('.fb-dl-more-btn');
    assert.ok(more, 'More appears when older downloads are hidden');
    assert.match(more.textContent, /^More/);
    more.click();
    assert.equal(shell.state.isDownloadsDropdownExpanded, true);
    assert.equal(container.querySelectorAll('.fb-dl-item').length, 6, 'all downloads are shown inline');
    assert.equal(shell.getActiveTab().url, beforeUrl, 'More does not navigate to the downloads page');
    assert.equal(container.querySelector('.fb-dl-more-btn').textContent, 'Show less');

    container.querySelector('.fb-dl-more-btn').click();
    assert.equal(container.querySelectorAll('.fb-dl-item').length, 5, 'Show less restores the compact list');
  } finally {
    uninstall();
  }
});

test('state-aware actions: in-progress has pause/cancel but NEVER open/show-in-folder', async () => {
  const uninstall = installDownloadsBridgeStub();
  try {
    const { shell, container } = await makeShell();
    shell.state.downloadsItems = sampleItems();
    shell.state.isDownloadsDropdownOpen = true;
    shell.render(container);

    const rows = container.querySelectorAll('.fb-dl-item');
    const row = rows.find((r) => (r.getAttribute('data-dl-id') || r.dataset?.dlId) === 'd1');
    const actions = row.querySelectorAll('.fb-dl-act').map((b) => b.getAttribute('data-dl-action'));
    assert.ok(actions.includes('pause'), 'pause offered');
    assert.ok(actions.includes('cancel'), 'cancel offered');
    assert.ok(actions.includes('copy-url'), 'copy address offered');
    assert.ok(!actions.includes('open'), 'no open - there is no finished file');
    assert.ok(!actions.includes('show'), 'no show in folder yet');
    assert.ok(!actions.includes('retry'), 'nothing to retry while downloading');
    // Progress bar visible for the in-flight row.
    assert.ok(row.querySelector('.fb-dl-progress-fill'), 'progress bar shown');
    // In-progress actions are ALWAYS visible (never hover-gated).
    assert.ok(String(row.querySelector('.fb-dl-item-actions').className).includes('fb-dl-actions-always'));
  } finally {
    uninstall();
  }
});

test('state-aware actions: completed has open/show/copy path/copy address/open-in-tab/remove', async () => {
  const uninstall = installDownloadsBridgeStub();
  try {
    const { shell, container } = await makeShell();
    shell.state.downloadsItems = sampleItems();
    shell.state.isDownloadsDropdownOpen = true;
    shell.render(container);

    const rows = container.querySelectorAll('.fb-dl-item');
    const row = rows.find((r) => (r.getAttribute('data-dl-id') || r.dataset?.dlId) === 'd2');
    const actions = row.querySelectorAll('.fb-dl-act').map((b) => b.getAttribute('data-dl-action'));
    for (const expected of ['open', 'show', 'copy-path', 'copy-url', 'open-url', 'remove']) {
      assert.ok(actions.includes(expected), `${expected} offered for a completed download`);
    }
    assert.ok(!actions.includes('cancel'), 'nothing to cancel - already done');
    assert.ok(!actions.includes('retry'), 'nothing to retry - it worked');
  } finally {
    uninstall();
  }
});

test('state-aware actions: failed has retry (always visible) and never open/show', async () => {
  const uninstall = installDownloadsBridgeStub();
  try {
    const { shell, container } = await makeShell();
    shell.state.downloadsItems = sampleItems();
    shell.state.isDownloadsDropdownOpen = true;
    shell.render(container);

    const rows = container.querySelectorAll('.fb-dl-item');
    const row = rows.find((r) => (r.getAttribute('data-dl-id') || r.dataset?.dlId) === 'd3');
    const actions = row.querySelectorAll('.fb-dl-act').map((b) => b.getAttribute('data-dl-action'));
    assert.ok(actions.includes('retry'), 'retry offered');
    assert.ok(actions.includes('copy-url'), 'copy address offered');
    assert.ok(actions.includes('open-url'), 'open address in tab offered');
    assert.ok(actions.includes('remove'), 'remove offered');
    assert.ok(!actions.includes('open'), 'no open - nothing was saved');
    assert.ok(!actions.includes('show'), 'no show in folder - nothing was saved');
    const retryBtn = row.querySelectorAll('.fb-dl-act').find((b) => b.getAttribute('data-dl-action') === 'retry');
    assert.ok(String(retryBtn.className).includes('fb-dl-act-always'), 'retry never hides behind hover');
  } finally {
    uninstall();
  }
});

test('actions reach the bridge: cancel, pause, open, show in folder, retry', async () => {
  const calls = [];
  const uninstall = installDownloadsBridgeStub(calls);
  try {
    const { shell } = await makeShell();
    shell.state.downloadsItems = sampleItems();
    await shell.performDownloadAction('d1', 'cancel');
    await shell.performDownloadAction('d1', 'pause');
    await shell.performDownloadAction('d2', 'open');
    await shell.performDownloadAction('d2', 'show');
    await shell.performDownloadAction('d3', 'retry');
    assert.deepEqual(calls, [['cancel', 'd1'], ['pause', 'd1'], ['open', 'd2'], ['show', 'd2'], ['retry', 'd3']]);
    assert.ok(!shell.state.downloadsItems.some((it) => it.id === 'd3'), 'retried row replaced by the fresh attempt');
  } finally {
    uninstall();
  }
});

test('"open address in tab" opens the source URL in a new tab', async () => {
  const uninstall = installDownloadsBridgeStub();
  try {
    const { shell } = await makeShell();
    shell.state.downloadsItems = sampleItems();
    await shell.performDownloadAction('d2', 'open-url');
    assert.equal(shell.state.tabs.length, 2, 'new tab created');
    assert.equal(shell.getActiveTab().url, 'https://a.dev/done.zip');
  } finally {
    uninstall();
  }
});

/* --------------------- progress ring on the toolbar --------------------- */

test('revolving ring: appears with the live percentage while downloading, gone when idle', async () => {
  const uninstall = installDownloadsBridgeStub();
  try {
    const { shell, container } = await makeShell();
    assert.equal(container.querySelector('.fb-dl-ring'), null, 'no ring when idle');

    shell.handleDownloadEvent({ type: 'started', id: 'd1', filename: 'movie.mp4', state: 'Downloading', receivedBytes: 0, sizeBytes: 10000 });
    assert.ok(container.querySelector('.fb-dl-ring'), 'ring appears when a download starts');

    shell.handleDownloadEvent({ type: 'progress', id: 'd1', state: 'Downloading', receivedBytes: 5000, sizeBytes: 10000, progress: 50 });
    const btn = container.querySelector('.fb-toolbar-downloads-btn');
    assert.match(btn.getAttribute('title'), /50%/, 'title tracks the live percentage');

    shell.handleDownloadEvent({ type: 'done', id: 'd1', state: 'Completed', progress: 100, sizeBytes: 10000 });
    assert.equal(container.querySelector('.fb-dl-ring'), null, 'ring disappears when nothing is downloading');
  } finally {
    uninstall();
  }
});

test('per-chunk progress is surgical: updates the open dropdown row WITHOUT a full re-render', async () => {
  const uninstall = installDownloadsBridgeStub();
  try {
    const { shell, container } = await makeShell();
    shell.handleDownloadEvent({ type: 'started', id: 'd1', filename: 'movie.mp4', state: 'Downloading', receivedBytes: 0, sizeBytes: 10000, progress: 0 });
    shell.state.isDownloadsDropdownOpen = true;
    shell.render(container);

    // Sentinel: any full re-render would rebuild this node and lose it.
    const dropdown = container.querySelector('.fb-downloads-dropdown');
    dropdown.__sentinel = 'alive';

    shell.handleDownloadEvent({ type: 'progress', id: 'd1', state: 'Downloading', receivedBytes: 7000, sizeBytes: 10000, progress: 70 });

    const sameDropdown = container.querySelector('.fb-downloads-dropdown');
    assert.equal(sameDropdown.__sentinel, 'alive', 'no full re-render per chunk');
    const fill = sameDropdown.querySelector('.fb-dl-progress-fill');
    assert.equal(fill.style.width, '70%', 'row progress bar updated in place');
  } finally {
    uninstall();
  }
});

/* ------------------------- bridge: live item control ------------------------- */

function fakeLiveDownloadItem({ filename, url = 'https://example.com/file.bin', totalBytes = 1000 }) {
  const listeners = {};
  let savePath = null;
  const calls = [];
  let paused = false;
  return {
    calls,
    getFilename: () => filename,
    getURL: () => url,
    getTotalBytes: () => totalBytes,
    getReceivedBytes: () => 500,
    getSavePath: () => savePath,
    setSavePath: (p) => { savePath = p; },
    cancel: () => { calls.push('cancel'); listeners.done?.(null, 'cancelled'); },
    pause: () => { paused = true; calls.push('pause'); },
    canResume: () => paused,
    resume: () => { paused = false; calls.push('resume'); },
    on: (event, cb) => { listeners[event] = cb; },
    once: (event, cb) => { listeners[event] = cb; },
    _fireDone: (state = 'completed') => listeners.done?.(null, state)
  };
}

function makeBridgeHarness() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'yayra-dl-smart-'));
  const downloadsStore = createDownloadsStore({ fs, userDataDir: dir, defaultDownloadsDir: path.join(dir, 'Downloads') });
  const handlers = new Map();
  const ipcMain = { handle: (ch, fn) => handlers.set(ch, fn) };
  const sessListeners = {};
  const sess = { on: (ev, cb) => { sessListeners[ev] = cb; }, emit: (ev, ...a) => sessListeners[ev]?.(...a) };
  const downloadURLs = [];
  let nextId = 0;
  const mainWindow = {
    isDestroyed: () => false,
    webContents: { send: () => {}, downloadURL: (u) => downloadURLs.push(u) }
  };
  createDownloadsBridge({
    ipcMain,
    shell: { openPath: async () => '', showItemInFolder: () => {} },
    dialog: {},
    path,
    fs,
    sessions: [sess],
    downloadsStore,
    getMainWindow: () => mainWindow,
    idFactory: () => `dl-${++nextId}`
  });
  return { handlers, sess, downloadURLs, downloadsStore };
}

test('bridge: cancel acts on the LIVE download item; the row settles as Cancelled', async () => {
  const { handlers, sess, downloadsStore } = makeBridgeHarness();
  const item = fakeLiveDownloadItem({ filename: 'big.bin' });
  sess.emit('will-download', {}, item);

  const res = await handlers.get('yayra:downloads-cancel')(null, { id: 'dl-1' });
  assert.equal(res.ok, true);
  assert.deepEqual(item.calls, ['cancel']);
  const { items } = downloadsStore.load();
  assert.equal(items.find((it) => it.id === 'dl-1').state, 'Cancelled');

  // A settled download can no longer be cancelled.
  const again = await handlers.get('yayra:downloads-cancel')(null, { id: 'dl-1' });
  assert.equal(again.ok, false);
});

test('bridge: pause and resume act on the live item and report state', async () => {
  const { handlers, sess, downloadsStore } = makeBridgeHarness();
  const item = fakeLiveDownloadItem({ filename: 'big.bin' });
  sess.emit('will-download', {}, item);

  assert.equal((await handlers.get('yayra:downloads-pause')(null, { id: 'dl-1' })).ok, true);
  assert.equal(downloadsStore.load().items.find((it) => it.id === 'dl-1').state, 'Paused');
  assert.equal((await handlers.get('yayra:downloads-resume')(null, { id: 'dl-1' })).ok, true);
  assert.equal(downloadsStore.load().items.find((it) => it.id === 'dl-1').state, 'Downloading');
  assert.deepEqual(item.calls, ['pause', 'resume']);
});

test('bridge: retry re-requests the original URL and drops the failed row', async () => {
  const { handlers, sess, downloadURLs, downloadsStore } = makeBridgeHarness();
  const item = fakeLiveDownloadItem({ filename: 'flaky.bin', url: 'https://cdn.dev/flaky.bin' });
  sess.emit('will-download', {}, item);
  item._fireDone('interrupted'); // -> Failed

  const res = await handlers.get('yayra:downloads-retry')(null, { id: 'dl-1' });
  assert.equal(res.ok, true);
  assert.deepEqual(downloadURLs, ['https://cdn.dev/flaky.bin'], 'original URL re-requested');
  assert.ok(!downloadsStore.load().items.some((it) => it.id === 'dl-1'), 'failed row removed - the retry becomes a fresh record');
});
