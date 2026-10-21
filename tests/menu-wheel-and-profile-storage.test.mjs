/**
 * P31: real menu actions + per-profile persistence + the synced radial
 * action wheel.
 *
 * THE BUGS THESE GUARD AGAINST:
 * 1. The production app constructed BrowserShell with NO repositories,
 *    so bookmarks/history/settings silently went nowhere. The new
 *    profileStorage module is the real, per-profile localStorage layer.
 * 2. The wheel customizer WROTE customizations to localStorage but
 *    nothing ever read them back - every restart reset the wheel. The
 *    wheel repo stores plain {id,title,url,type} and strips legacy
 *    icon-HTML blobs.
 * 3. The native bubble's double-tap radial showed a fixed ring: now it
 *    mirrors the customized wheel (yayra:overlay-set-wheel-items), shows
 *    REAL favicons for link items, has the customizer down-arrow, and
 *    forwards renderer-only actions to the main window.
 * 4. Menu "Developer tools" (and friends) were fake alert() calls: the
 *    webview bridge now exposes real devtools/print/save/zoom/reader/
 *    media IPC.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  createProfileScopedStorage,
  createHistoryRepo,
  createBookmarksRepo,
  createEmailAddressesRepo,
  createSettingsRepo,
  createWheelRepo
} from '../packages/shared-ui/src/services/profileStorage.js';
import { createOverlayBridge } from '../electron/overlayWindow.cjs';
import { createOverlayStore, DEFAULTS } from '../electron/overlayStore.cjs';
import { createWebviewBridge } from '../electron/webviewBridge.cjs';

// ---------------------------------------------------------------------
// profileStorage: the per-profile persistence layer
// ---------------------------------------------------------------------

function fakeLocalStorage(initial = {}) {
  const map = new Map(Object.entries(initial));
  return {
    map,
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => map.set(k, String(v)),
    removeItem: (k) => map.delete(k)
  };
}

test('profile storage: keys are namespaced per profile and follow profile switches live', async () => {
  const backing = fakeLocalStorage();
  let profile = 'default';
  const storage = createProfileScopedStorage({ backing, getProfileId: () => profile });

  await storage.set('settings', { theme: 'dark' });
  profile = 'work';
  await storage.set('settings', { theme: 'light' });

  assert.ok(backing.map.has('yayra:p:default:settings'), 'default profile key written');
  assert.ok(backing.map.has('yayra:p:work:settings'), 'work profile key written');
  assert.deepEqual(await storage.get('settings'), { theme: 'light' }, 'reads follow the current profile');
  profile = 'default';
  assert.deepEqual(await storage.get('settings'), { theme: 'dark' }, 'switching back re-scopes reads');
});

test('profile storage: the default profile adopts legacy un-scoped keys exactly once (no data loss on upgrade)', async () => {
  const backing = fakeLocalStorage({ 'yayra:settings': JSON.stringify({ searchEngine: 'google' }) });
  const storage = createProfileScopedStorage({
    backing,
    getProfileId: () => 'default',
    legacyKeys: { settings: 'yayra:settings' }
  });
  assert.deepEqual(await storage.get('settings'), { searchEngine: 'google' }, 'legacy value adopted');
  assert.ok(backing.map.has('yayra:p:default:settings'), 'migrated to the scoped key');

  // A NON-default profile never inherits another user's legacy data.
  const other = createProfileScopedStorage({
    backing,
    getProfileId: () => 'work',
    legacyKeys: { settings: 'yayra:settings' }
  });
  assert.equal(await other.get('settings'), null);
});

test('history repo: records visits newest-first, collapses reloads, skips newtab, and remove/clear work', async () => {
  const storage = createProfileScopedStorage({ backing: fakeLocalStorage(), getProfileId: () => 'default' });
  const repo = createHistoryRepo(storage);

  await repo.addEntry('yayra://newtab', 'New Tab');
  await repo.addEntry('https://a.com', 'A');
  await repo.addEntry('https://a.com', 'A again'); // reload - collapsed
  await repo.addEntry('https://b.com', 'B');

  const items = await repo.getEntries();
  assert.deepEqual(items.map((i) => i.url), ['https://b.com', 'https://a.com'], 'newest first, reload collapsed, newtab skipped');
  assert.equal(items[1].title, 'A again', 'collapsed entry keeps the freshest title');

  await repo.removeEntry(items[0].id);
  assert.deepEqual((await repo.getEntries()).map((i) => i.url), ['https://a.com']);
  await repo.clear();
  assert.deepEqual(await repo.getEntries(), []);
});

test('frequent sites: EMPTY on a fresh install / new profile, then built from real visits, never more than 5', async () => {
  const backing = fakeLocalStorage();
  let profile = 'default';
  const storage = createProfileScopedStorage({ backing, getProfileId: () => profile });
  const repo = createHistoryRepo(storage);

  // Fresh install: nothing invented.
  assert.deepEqual(await repo.getTopSites(), [], 'no fabricated DuckDuckGo/Wikipedia/GitHub tiles');

  // Real browsing: visit counts drive the order.
  for (const url of ['https://a.com', 'https://a.com', 'https://a.com', 'https://b.com', 'https://b.com', 'https://c.com']) {
    await repo.addEntry(url, url);
  }
  // Internal pages never become "frequent sites".
  await repo.addEntry('yayra://settings', 'Settings');
  let top = await repo.getTopSites();
  assert.deepEqual(top.map((i) => i.url), ['https://a.com', 'https://b.com', 'https://c.com'], 'ordered by real visit count');
  assert.equal(top[0].visitCount, 3, 'repeat visits aggregate instead of duplicating rows');

  // Cap: with 7 distinct sites only the top 5 show.
  for (const url of ['https://d.com', 'https://e.com', 'https://f.com', 'https://g.com']) {
    await repo.addEntry(url, url);
  }
  top = await repo.getTopSites(50);
  assert.equal(top.length, 5, 'hard cap at 5 even when more is requested');

  // A brand-new profile starts empty - frequency never leaks across profiles.
  profile = 'work';
  assert.deepEqual(await repo.getTopSites(), [], 'new profile has no frequent sites yet');
});

test('bookmarks repo: dedupes by url, answers isBookmarked, removes by url or id', async () => {
  const storage = createProfileScopedStorage({ backing: fakeLocalStorage(), getProfileId: () => 'default' });
  const repo = createBookmarksRepo(storage);

  const first = await repo.addBookmark({ url: 'https://a.com', title: 'A' });
  const dupe = await repo.addBookmark({ url: 'https://a.com', title: 'A copy' });
  assert.equal(dupe.id, first.id, 'same url returns the existing bookmark');
  assert.equal((await repo.getAllBookmarks()).length, 1);
  assert.equal(await repo.isBookmarked('https://a.com'), true);
  assert.equal(await repo.isBookmarked('https://b.com'), false);

  await repo.removeBookmark('https://a.com');
  assert.equal(await repo.isBookmarked('https://a.com'), false);
});

test('bookmark groups: migrate legacy items, set a profile-scoped default, move and remove groups safely', async () => {
  let activeProfile = 'personal';
  const backing = fakeLocalStorage({
    'yayra:p:personal:bookmarks': JSON.stringify([{ id: 'legacy', url: 'https://legacy.example', title: 'Legacy' }])
  });
  const storage = createProfileScopedStorage({ backing, getProfileId: () => activeProfile });
  const repo = createBookmarksRepo(storage);

  const groups = await repo.getGroups();
  assert.deepEqual(groups.slice(0, 3).map((group) => group.name), ['Bookmarks Bar', 'Mobile Bookmarks', 'Other Bookmarks']);
  const migrated = await repo.getAllBookmarks();
  assert.equal(migrated[0].groupId, 'bookmarks-bar', 'old bookmarks stay visible in the default folder');

  const workResult = await repo.createGroup('Work');
  assert.equal(workResult.ok, true);
  const work = workResult.group;
  assert.equal((await repo.setDefaultGroup(work.id)).ok, true);
  const added = await repo.addBookmark({ url: 'https://work.example', title: 'Work' });
  assert.equal(added.groupId, work.id, 'new bookmarks use the selected default group');
  assert.equal(await repo.getDefaultGroupId(), work.id);

  assert.equal((await repo.moveBookmark('legacy', work.id)).ok, true);
  assert.equal((await repo.getAllBookmarks()).find((item) => item.id === 'legacy').groupId, work.id);
  assert.equal((await repo.removeGroup(work.id)).ok, true);
  assert.equal(await repo.getDefaultGroupId(), 'bookmarks-bar', 'removing the default group falls back to Bookmarks Bar');
  assert.ok((await repo.getAllBookmarks()).every((item) => item.groupId === 'bookmarks-bar'), 'removed group bookmarks are preserved in the fallback');

  activeProfile = 'work-profile';
  assert.deepEqual(await repo.getGroups(), groups, 'custom folders do not leak across profiles');
  assert.deepEqual(await repo.getAllBookmarks(), [], 'bookmarks remain profile-scoped');
});

test('email address repo: saves valid addresses locally per profile, deduplicates, and supports deletion', async () => {
  let activeProfile = 'personal';
  const storage = createProfileScopedStorage({ backing: fakeLocalStorage(), getProfileId: () => activeProfile });
  const repo = createEmailAddressesRepo(storage);

  assert.equal(await repo.addEmail('not-an-email'), null, 'invalid values are ignored');
  assert.equal(await repo.addEmail('ada @example.com'), null, 'addresses containing spaces are rejected');
  const first = await repo.addEmail('Ado.Example@example.com');
  const duplicate = await repo.addEmail('ado.example@EXAMPLE.com');
  assert.equal(duplicate.id, first.id, 'same address is deduplicated case-insensitively');
  assert.equal((await repo.getAllEmails()).length, 1);
  assert.equal((await repo.getAllEmails())[0].email, 'Ado.Example@example.com', 'the first user-entered casing is retained');

  activeProfile = 'work';
  assert.deepEqual(await repo.getAllEmails(), [], 'email addresses do not leak between profiles');
  await repo.addEmail('work@example.org');
  activeProfile = 'personal';
  await repo.removeEmail(first.id);
  assert.deepEqual(await repo.getAllEmails(), [], 'an address can be removed from its own profile');
  activeProfile = 'work';
  assert.deepEqual((await repo.getAllEmails()).map((item) => item.email), ['work@example.org']);
  await repo.clear();
  assert.deepEqual(await repo.getAllEmails(), []);
});

test('settings repo: updateSettings merges partials instead of overwriting the whole blob', async () => {
  const storage = createProfileScopedStorage({ backing: fakeLocalStorage(), getProfileId: () => 'default' });
  const repo = createSettingsRepo(storage);
  await repo.updateSettings({ theme: 'dark', adBlockEnabled: true });
  await repo.updateSettings({ theme: 'light' });
  assert.deepEqual(await repo.getSettings(), { theme: 'light', adBlockEnabled: true });
});

test('wheel repo: persists only plain {id,title,url,type} and strips legacy icon-HTML blobs on read', async () => {
  const backing = fakeLocalStorage({
    // Legacy customizer format: serialized icon HTML + positions + no reader.
    yayra_radial_actions: JSON.stringify([
      { id: 'chatgpt', title: 'Ask ChatGPT', icon: '<svg>stale</svg>', x: 125, y: -125 },
      { id: 'site-1', title: 'YouTube', url: 'https://youtube.com', icon: '<img src="...">', type: 'site' },
      { broken: true } // junk entries are dropped
    ])
  });
  const storage = createProfileScopedStorage({
    backing,
    getProfileId: () => 'default',
    legacyKeys: { 'radial-wheel': 'yayra_radial_actions' }
  });
  const repo = createWheelRepo(storage);
  const items = await repo.getItems();
  assert.deepEqual(items, [
    { id: 'chatgpt', title: 'Ask ChatGPT', url: null, type: null },
    { id: 'site-1', title: 'YouTube', url: 'https://youtube.com', type: 'site' }
  ], 'legacy wheel adopted, icon HTML and positions stripped, junk dropped');

  await repo.setItems([{ id: 'x', title: 'X', url: 'https://x.com', type: 'site', icon: '<b>no</b>' }]);
  assert.deepEqual(await repo.getItems(), [{ id: 'x', title: 'X', url: 'https://x.com', type: 'site' }]);
  await repo.reset();
  assert.equal(await repo.getItems(), null, 'reset means "use defaults"');
});

// ---------------------------------------------------------------------
// Native bubble radial: synced custom wheel + real favicons + forwarding
// ---------------------------------------------------------------------

function fakeIpcMain() {
  const handlers = new Map();
  const onHandlers = new Map();
  return {
    handlers,
    onHandlers,
    handle: (channel, fn) => handlers.set(channel, fn),
    on: (channel, fn) => onHandlers.set(channel, fn)
  };
}

function makeFakeBrowserWindowClass() {
  const instances = [];
  class FakeBrowserWindow {
    constructor(opts) {
      this.opts = opts;
      this.destroyed = false;
      this.movable = true;
      this.loadedUrl = null;
      this._listeners = {};
      this._position = [opts.x, opts.y];
      this.sent = [];
      this.webContents = { send: (channel, payload) => this.sent.push({ channel, payload }) };
      instances.push(this);
    }
    setAlwaysOnTop() {}
    setVisibleOnAllWorkspaces() {}
    setContentProtection() {}
    setFocusable() {}
    once() {}
    removeListener() {}
    setMovable(flag) { this.movable = flag; }
    setPosition(x, y) { this._position = [x, y]; }
    getPosition() { return this._position; }
    setBounds(bounds) { this.bounds = { ...bounds }; this._position = [bounds.x, bounds.y]; }
    loadURL(url) { this.loadedUrl = url; }
    on(event, cb) { this._listeners[event] = cb; }
    hide() { this.hidden = true; }
    show() { this.hidden = false; }
    focus() {}
    isVisible() { return !this.hidden; }
    close() { this.destroyed = true; this._listeners.closed?.(); }
    isDestroyed() { return this.destroyed; }
  }
  return { FakeBrowserWindow, instances };
}

function makeOverlayHarness() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'yayra-wheel-'));
  const overlayStore = createOverlayStore({ fs, userDataDir: dir });
  const { FakeBrowserWindow, instances } = makeFakeBrowserWindowClass();
  const ipcMain = fakeIpcMain();
  const mainWin = {
    destroyed: false,
    isDestroyed() { return this.destroyed; },
    isMinimized: () => false,
    restore() {},
    show() { this.shown = true; },
    focus() {},
    sent: [],
    webContents: { send(channel, payload) { mainWin.sent.push({ channel, payload }); } }
  };
  const bridge = createOverlayBridge({
    BrowserWindow: FakeBrowserWindow,
    app: { setLoginItemSettings: () => {}, getPath: () => dir },
    ipcMain,
    screen: {
      getPrimaryDisplay: () => ({ workAreaSize: { width: 1920, height: 1080 }, size: { width: 1920, height: 1080 }, scaleFactor: 1, id: 7 }),
      getCursorScreenPoint: () => ({ x: 500, y: 300 })
    },
    path,
    preloadPath: '/fake/overlayPreload.cjs',
    mainPreloadPath: '/fake/preload.cjs',
    overlayStore,
    getMainWindow: () => mainWin,
    platform: 'win32',
    fsImpl: { readFileSync: () => Buffer.from('png') },
    logoPath: '/fake/logo.png'
  });
  return { bridge, overlayStore, instances, ipcMain, mainWin };
}

function bubbleHtml(instances) {
  return decodeURIComponent(instances[0].loadedUrl.replace('data:text/html;charset=utf-8,', ''));
}

test('native radial: default ring shows REAL favicons for the link assistants and the customize down-arrow', () => {
  const { bridge, instances } = makeOverlayHarness();
  bridge.ensureOverlayWindow();
  const html = bubbleHtml(instances);
  for (const host of ['chatgpt.com', 'gemini.google.com', 'claude.ai', 'perplexity.ai']) {
    assert.ok(html.includes(`icons.duckduckgo.com/ip3/${host}.ico`), `real favicon for ${host}`);
  }
  assert.ok(html.includes('data-action="customize"'), 'down-arrow opens the wheel customizer');
  assert.equal(DEFAULTS.wheelItems, null, 'fresh installs ship the classic ring');
});

test('native radial: yayra:overlay-set-wheel-items persists the sanitized wheel and rebuilds the ring to mirror it', () => {
  const { bridge, overlayStore, instances, ipcMain } = makeOverlayHarness();
  bridge.ensureOverlayWindow();
  assert.ok(ipcMain.handlers.has('yayra:overlay-set-wheel-items'), 'IPC channel registered');

  ipcMain.handlers.get('yayra:overlay-set-wheel-items')(null, [
    { id: 'notes', title: 'Quick Notes' },
    { id: 'site-1', title: 'YouTube', url: 'https://youtube.com', type: 'site', icon: '<script>evil</script>' },
    { id: 'bad-url', title: 'Nope', url: 'javascript:alert(1)' }
  ]);

  const saved = overlayStore.load().wheelItems;
  assert.equal(saved.length, 3);
  assert.equal(saved[1].url, 'https://youtube.com');
  assert.equal(saved[1].icon, undefined, 'icon HTML never persisted');
  assert.equal(saved[2].url, null, 'javascript: urls are refused');

  const html = bubbleHtml(instances);
  assert.ok(html.includes('data-action="wheel:notes"'), 'custom wheel item on the ring');
  assert.ok(html.includes('data-action="wheel:site-1"'), 'user site on the ring');
  assert.ok(html.includes('icons.duckduckgo.com/ip3/youtube.com.ico'), 'link items use the real site favicon');
  assert.ok(html.includes('data-action="customize"'), 'down-arrow still present on custom rings');
  assert.ok(html.includes('data-action="close"'), 'center close still present');

  // null restores the classic default ring.
  ipcMain.handlers.get('yayra:overlay-set-wheel-items')(null, null);
  assert.equal(overlayStore.load().wheelItems, null);
  assert.ok(bubbleHtml(instances).includes('data-action="ai"'), 'classic ring restored');
});

test('native radial: custom wheel actions run natively for links and forward renderer-only ids to the main window', () => {
  const { bridge, ipcMain, mainWin } = makeOverlayHarness();
  bridge.ensureOverlayWindow();
  ipcMain.handlers.get('yayra:overlay-set-wheel-items')(null, [
    { id: 'notes', title: 'Quick Notes' },
    { id: 'site-1', title: 'YouTube', url: 'https://youtube.com', type: 'site' }
  ]);

  // Link item -> opens in yayra mini right from the bubble.
  bridge.handleBubbleTap(2);
  bridge.handleRadialAction('wheel:site-1');
  assert.equal(bridge.isRadialOpen(), false, 'radial closed');
  assert.ok(bridge.getMiniWindow(), 'mini window opened for the link');

  // Renderer-only item -> the full browser is woken and told to run it.
  bridge.handleRadialAction('wheel:notes');
  assert.deepEqual(mainWin.sent.at(-1), { channel: 'yayra:wheel-action', payload: 'notes' });

  // The down-arrow forwards 'customize' (opens the in-app customizer).
  bridge.handleRadialAction('customize');
  assert.deepEqual(mainWin.sent.at(-1), { channel: 'yayra:wheel-action', payload: 'customize' });
});

// ---------------------------------------------------------------------
// Webview bridge: the real More-tools IPC (devtools/print/save/zoom/media)
// ---------------------------------------------------------------------

function makeWebviewHarness({ dialog } = {}) {
  const handlers = new Map();
  const ipcMain = {
    handle: (channel, fn) => handlers.set(channel, fn),
    on: () => {}
  };
  const fakeWin = {
    destroyed: false,
    isDestroyed() { return this.destroyed; },
    webContents: { send: () => {} },
    contentView: {
      children: [],
      addChildView(view) { this.children.push(view); },
      removeChildView(view) { this.children = this.children.filter((v) => v !== view); }
    }
  };
  const views = [];
  const WebContentsView = function FakeWebContentsView() {
    const calls = [];
    const view = {
      calls,
      bounds: null,
      setBounds(b) { this.bounds = b; },
      webContents: {
        calls,
        loadURL: async () => {},
        isDestroyed: () => false,
        close: () => {},
        on: () => {},
        setWindowOpenHandler: () => {},
        setUserAgent: () => {},
        getTitle: () => 'My Page: a/b',
        openDevTools: (opts) => calls.push(['openDevTools', opts]),
        print: (opts) => calls.push(['print', opts]),
        savePage: async (file, mode) => calls.push(['savePage', file, mode]),
        setZoomFactor: (f) => calls.push(['setZoomFactor', f]),
        isCurrentlyAudible: () => true,
        isAudioMuted: () => false,
        setAudioMuted: (m) => calls.push(['setAudioMuted', m]),
        executeJavaScript: async () => ({ title: 'T', url: 'https://a.com', blocks: [{ tag: 'p', text: 'hello' }] })
      }
    };
    views.push(view);
    return view;
  };
  createWebviewBridge({
    WebContentsView,
    ipcMain,
    shell: { openExternal: async () => {} },
    getMainWindow: () => fakeWin,
    dialog,
    logger: { error: () => {} }
  });
  return { handlers, views };
}

test('webview IPC: Developer tools really opens detached DevTools on the tab view (fallback: the shell itself)', async () => {
  const { handlers, views } = makeWebviewHarness();
  await handlers.get('yayra:webview-ensure')(null, { tabId: 'tab-1', url: 'https://example.com/' });

  const res = await handlers.get('yayra:webview-open-devtools')(null, { tabId: 'tab-1' });
  assert.equal(res.ok, true);
  assert.deepEqual(views[0].calls.at(-1), ['openDevTools', { mode: 'detach' }], 'detached devtools on the page view');

  // Internal yayra:// pages have no native view - the SHELL's own
  // webContents (the sender) is inspected instead of failing.
  const senderCalls = [];
  const fakeEvent = { sender: { openDevTools: (opts) => senderCalls.push(opts) } };
  const res2 = await handlers.get('yayra:webview-open-devtools')(fakeEvent, { tabId: 'no-such-tab' });
  assert.equal(res2.ok, true);
  assert.deepEqual(senderCalls, [{ mode: 'detach' }]);
});

test('webview IPC: print, zoom (clamped), media state and mute act on the real page webContents', async () => {
  const { handlers, views } = makeWebviewHarness();
  await handlers.get('yayra:webview-ensure')(null, { tabId: 'tab-1', url: 'https://example.com/' });
  const calls = views[0].calls;

  assert.equal((await handlers.get('yayra:webview-print')(null, { tabId: 'tab-1' })).ok, true);
  assert.deepEqual(calls.at(-1), ['print', {}]);

  assert.equal((await handlers.get('yayra:webview-set-zoom')(null, { tabId: 'tab-1', factor: 99 })).ok, true);
  assert.deepEqual(calls.at(-1), ['setZoomFactor', 5], 'zoom factor clamped to a sane maximum');

  const media = await handlers.get('yayra:webview-media-state')(null, { tabId: 'tab-1' });
  assert.deepEqual(media, { ok: true, audible: true, muted: false });

  assert.equal((await handlers.get('yayra:webview-set-muted')(null, { tabId: 'tab-1', muted: true })).ok, true);
  assert.deepEqual(calls.at(-1), ['setAudioMuted', true]);

  const reader = await handlers.get('yayra:webview-reader-extract')(null, { tabId: 'tab-1' });
  assert.equal(reader.ok, true);
  assert.deepEqual(reader.blocks, [{ tag: 'p', text: 'hello' }]);
});

test('webview IPC: Save page as... goes through the OS dialog, sanitizes the filename, and honours cancel', async () => {
  const saveCalls = [];
  const dialog = {
    showSaveDialog: async (_win, opts) => {
      saveCalls.push(opts);
      return { canceled: false, filePath: '/tmp/out.html' };
    }
  };
  const { handlers, views } = makeWebviewHarness({ dialog });
  await handlers.get('yayra:webview-ensure')(null, { tabId: 'tab-1', url: 'https://example.com/' });

  const res = await handlers.get('yayra:webview-save-page')(null, { tabId: 'tab-1' });
  assert.deepEqual(res, { ok: true, path: '/tmp/out.html' });
  assert.ok(!saveCalls[0].defaultPath.includes('/') || saveCalls[0].defaultPath.lastIndexOf('/') === -1
    ? true : !path.basename(saveCalls[0].defaultPath).includes(':'), 'illegal filename chars stripped');
  assert.equal(saveCalls[0].defaultPath, 'My Page- a-b.html', 'title sanitized into the suggested filename');
  assert.deepEqual(views[0].calls.at(-1), ['savePage', '/tmp/out.html', 'HTMLComplete']);

  // Cancel = no error, nothing written.
  dialog.showSaveDialog = async () => ({ canceled: true });
  const cancelled = await handlers.get('yayra:webview-save-page')(null, { tabId: 'tab-1' });
  assert.deepEqual(cancelled, { ok: false, canceled: true });

  // Without the dialog module (older callers) it reports honestly.
  const bare = makeWebviewHarness();
  await bare.handlers.get('yayra:webview-ensure')(null, { tabId: 'tab-1', url: 'https://example.com/' });
  const noDialog = await bare.handlers.get('yayra:webview-save-page')(null, { tabId: 'tab-1' });
  assert.deepEqual(noDialog, { ok: false, reason: 'unavailable' });
});
