import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runInNewContext } from 'node:vm';
import { createOverlayBridge } from '../electron/overlayWindow.cjs';
import { createOverlayStore } from '../electron/overlayStore.cjs';

function makeTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'yayra-overlay-window-'));
}

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

function fakeScreen() {
  return { getPrimaryDisplay: () => ({ workAreaSize: { width: 1920, height: 1080 } }) };
}

function makeFakeBrowserWindowClass() {
  const instances = [];
  const topOrder = [];
  class FakeBrowserWindow {
    constructor(opts) {
      this.opts = opts;
      this.destroyed = false;
      this.alwaysOnTop = null;
      this.visible = opts.show !== false;
      this.visibleOnAllWorkspaces = null;
      this.loadedUrl = null;
      this._listeners = {};
      this._position = [opts.x, opts.y];
      instances.push(this);
    }
    setAlwaysOnTop(flag, level) { this.alwaysOnTop = { flag, level }; }
    isAlwaysOnTop() { return Boolean(this.alwaysOnTop?.flag); }
    isVisible() { return this.visible; }
    moveTop() { topOrder.push(this); }
    show() { this.visible = true; this._listeners.show?.(); }
    hide() { this.visible = false; }
    focus() { this._listeners.focus?.(); }
    setVisibleOnAllWorkspaces(flag, opts) { this.visibleOnAllWorkspaces = { flag, opts }; }
    setContentProtection() {}
    loadURL(url) { this.loadedUrl = url; }
    on(event, cb) { this._listeners[event] = cb; }
    getPosition() { return this._position; }
    close() { this.visible = false; this.destroyed = true; this._listeners.closed?.(); }
    isDestroyed() { return this.destroyed; }
  }
  return { FakeBrowserWindow, instances, topOrder };
}

function fakeApp() {
  const calls = [];
  return {
    calls,
    setLoginItemSettings: (opts) => calls.push(opts),
    getPath: () => '/tmp'
  };
}

test('overlayWindow: initializeOnStartup() creates the bubble window on launch - with no main window ever having opened', () => {
  const dir = makeTempDir();
  const overlayStore = createOverlayStore({ fs, userDataDir: dir });
  const { FakeBrowserWindow, instances } = makeFakeBrowserWindowClass();
  const app = fakeApp();
  const ipcMain = fakeIpcMain();

  const bridge = createOverlayBridge({
    BrowserWindow: FakeBrowserWindow,
    app,
    ipcMain,
    screen: fakeScreen(),
    path,
    preloadPath: '/fake/overlayPreload.cjs',
    overlayStore,
    getMainWindow: () => null // main browser window was never opened
  });

  bridge.initializeOnStartup();

  assert.equal(instances.length, 1, 'overlay window is created independently of the main window');
  assert.equal(app.calls.at(-1).openAtLogin, true, 'launch-at-startup default is committed to the OS on first run');
  const win = instances[0];
  assert.equal(win.alwaysOnTop.level, 'screen-saver', 'uses the highest always-on-top level Electron exposes');
  assert.equal(win.visibleOnAllWorkspaces.flag, true, 'stays visible across virtual desktops/Spaces and fullscreen apps');
  assert.ok(win.loadedUrl.startsWith('data:text/html'));
});

test('overlayWindow: setEnabled(false) destroys the window and setEnabled(true) recreates it', () => {
  const dir = makeTempDir();
  const overlayStore = createOverlayStore({ fs, userDataDir: dir });
  const { FakeBrowserWindow, instances } = makeFakeBrowserWindowClass();
  const bridge = createOverlayBridge({
    BrowserWindow: FakeBrowserWindow,
    app: fakeApp(),
    ipcMain: fakeIpcMain(),
    screen: fakeScreen(),
    path,
    preloadPath: '/fake/overlayPreload.cjs',
    overlayStore,
    getMainWindow: () => null
  });

  bridge.ensureOverlayWindow();
  assert.equal(instances.length, 1);
  assert.equal(instances[0].isDestroyed(), false);

  bridge.setEnabled(false);
  assert.equal(instances[0].isDestroyed(), true);
  assert.equal(overlayStore.load().enabled, false);
  assert.equal(bridge.getOverlayWindow(), null);

  bridge.setEnabled(true);
  assert.equal(instances.length, 2);
  assert.equal(overlayStore.load().enabled, true);
});

test('overlayWindow: setLaunchAtStartup() both persists the preference and calls the real OS login-item API', () => {
  const dir = makeTempDir();
  const overlayStore = createOverlayStore({ fs, userDataDir: dir });
  const app = fakeApp();
  const bridge = createOverlayBridge({
    BrowserWindow: makeFakeBrowserWindowClass().FakeBrowserWindow,
    app,
    ipcMain: fakeIpcMain(),
    screen: fakeScreen(),
    path,
    preloadPath: '/fake/overlayPreload.cjs',
    overlayStore,
    getMainWindow: () => null
  });

  bridge.setLaunchAtStartup(false);
  assert.equal(overlayStore.load().launchAtStartup, false);
  assert.equal(app.calls.at(-1).openAtLogin, false);
});

test('overlayWindow: moving the window persists its new position so it stays put across restarts', () => {
  const dir = makeTempDir();
  const overlayStore = createOverlayStore({ fs, userDataDir: dir });
  const { FakeBrowserWindow, instances } = makeFakeBrowserWindowClass();
  const bridge = createOverlayBridge({
    BrowserWindow: FakeBrowserWindow,
    app: fakeApp(),
    ipcMain: fakeIpcMain(),
    screen: fakeScreen(),
    path,
    preloadPath: '/fake/overlayPreload.cjs',
    overlayStore,
    getMainWindow: () => null
  });

  bridge.ensureOverlayWindow();
  const win = instances[0];
  win._position = [500, 600];
  win._listeners.moved();

  assert.deepEqual(overlayStore.load().position, { x: 500, y: 600 });
});

test('overlayWindow: clicking the bubble (yayra:overlay-restore) shows, un-minimizes, and focuses the main window', () => {
  const dir = makeTempDir();
  const overlayStore = createOverlayStore({ fs, userDataDir: dir });
  const ipcMain = fakeIpcMain();
  const calls = [];
  const fakeMainWindow = {
    isDestroyed: () => false,
    isMinimized: () => true,
    restore: () => calls.push('restore'),
    show: () => calls.push('show'),
    focus: () => calls.push('focus')
  };

  createOverlayBridge({
    BrowserWindow: makeFakeBrowserWindowClass().FakeBrowserWindow,
    app: fakeApp(),
    ipcMain,
    screen: fakeScreen(),
    path,
    preloadPath: '/fake/overlayPreload.cjs',
    overlayStore,
    getMainWindow: () => fakeMainWindow
  });

  ipcMain.onHandlers.get('yayra:overlay-restore')();
  assert.deepEqual(calls, ['restore', 'show', 'focus']);
});

test('overlayWindow: disabled-by-default means ensureOverlayWindow() is a no-op once the user turns it off', () => {
  const dir = makeTempDir();
  const overlayStore = createOverlayStore({ fs, userDataDir: dir });
  overlayStore.save({ enabled: false });
  const { FakeBrowserWindow, instances } = makeFakeBrowserWindowClass();
  const bridge = createOverlayBridge({
    BrowserWindow: FakeBrowserWindow,
    app: fakeApp(),
    ipcMain: fakeIpcMain(),
    screen: fakeScreen(),
    path,
    preloadPath: '/fake/overlayPreload.cjs',
    overlayStore,
    getMainWindow: () => null
  });

  bridge.initializeOnStartup();
  assert.equal(instances.length, 0);
});

/* -----------------------------------------------------------------
 * The bubble as an INDEPENDENT entry point: single click toggles the
 * floating "yayra mini" browser window; "open full browser" recreates
 * the main window after it was closed; Linux gets a real XDG autostart
 * entry so the bubble starts at boot.
 * ----------------------------------------------------------------- */

function makeRicherBrowserWindowClass() {
  const instances = [];
  const topOrder = [];
  class FakeBrowserWindow {
    constructor(opts) {
      this.opts = opts;
      this.destroyed = false;
      this.visible = true;
      this.alwaysOnTop = null;
      this.visibleOnAllWorkspaces = null;
      this.loadedUrl = null;
      this._listeners = {};
      this.webContents = { sent: [], isLoading: () => false, send: (...args) => this.webContents.sent.push(args) };
      this._position = [opts.x, opts.y];
      instances.push(this);
    }
    setAlwaysOnTop(flag, level) { this.alwaysOnTop = { flag, level }; }
    isAlwaysOnTop() { return Boolean(this.alwaysOnTop?.flag); }
    moveTop() { topOrder.push(this); }
    setVisibleOnAllWorkspaces(flag, opts) { this.visibleOnAllWorkspaces = { flag, opts }; }
    setContentProtection() {}
    loadURL(url) { this.loadedUrl = url; }
    on(event, cb) { this._listeners[event] = cb; }
    getPosition() { return this._position; }
    close() { this.destroyed = true; this._listeners.closed?.(); }
    isDestroyed() { return this.destroyed; }
    isVisible() { return this.visible; }
    hide() { this.visible = false; }
    show() { this.visible = true; this._listeners.show?.(); }
    focus() { this._listeners.focus?.(); }
    isMinimized() { return false; }
    restore() {}
  }
  return { FakeBrowserWindow, instances, topOrder };
}

function makeMiniHarness({ getMainWindow = () => null, createMainWindow = null } = {}) {
  const dir = makeTempDir();
  const overlayStore = createOverlayStore({ fs, userDataDir: dir });
  const { FakeBrowserWindow, instances, topOrder } = makeRicherBrowserWindowClass();
  const ipcMain = fakeIpcMain();
  const bridge = createOverlayBridge({
    BrowserWindow: FakeBrowserWindow,
    app: fakeApp(),
    ipcMain,
    screen: fakeScreen(),
    path,
    preloadPath: '/fake/overlayPreload.cjs',
    mainPreloadPath: '/fake/preload.cjs',
    miniUrl: 'yayra://app/index.html?shell=mini&profile=default',
    overlayStore,
    getMainWindow,
    createMainWindow
  });
  return { bridge, ipcMain, instances, topOrder };
}

test('overlayWindow: bubble stays above its mini panel in the Windows sibling z-order', () => {
  const { bridge, ipcMain, instances, topOrder } = makeMiniHarness();
  bridge.initializeOnStartup();
  assert.equal(instances.length, 1, 'just the bubble so far');

  ipcMain.onHandlers.get('yayra:overlay-bubble-click')();
  assert.equal(instances.length, 2, 'bubble + mini window');
  const mini = bridge.getMiniWindow();
  assert.ok(mini, 'mini window is tracked');
  assert.match(mini.loadedUrl, /shell=mini/, 'loads the compact mini shell');
  assert.match(mini.loadedUrl, /profile=default/, 'mini is pinned to the default account profile');
  assert.equal(mini.opts.frame, false, 'frameless floating panel');
  assert.equal(mini.opts.webPreferences.preload, '/fake/preload.cjs', 'full window.yayra API preload (native tabs work inside the mini)');
  assert.equal(mini.alwaysOnTop.level, 'screen-saver', 'floats above other apps like the bubble');
  assert.equal(topOrder.at(-1), instances[0], 'the floating Yayra bubble is raised above the mini window');
  mini.focus();
  assert.equal(topOrder.at(-1), instances[0], 'focusing the mini cannot leave the bubble covered');
});

test('overlayWindow: a selected tab opens in mini through the validated IPC handoff and reuses its tabs', () => {
  const { bridge, ipcMain, instances } = makeMiniHarness();
  const handoff = ipcMain.handlers.get('yayra:overlay-open-mini-page');
  assert.equal(typeof handoff, 'function', 'the preload-facing mini handoff IPC is registered');
  assert.equal(handoff(null, { url: 'javascript:alert(1)' }), false, 'script URLs are rejected');
  assert.equal(handoff(null, { url: 'https://user:password@example.test/' }), false, 'credential-bearing URLs are rejected');
  assert.equal(handoff(null, { url: 'file:///etc/passwd' }), false, 'local file URLs are rejected');

  const firstUrl = 'https://example.test/first';
  assert.equal(handoff(null, { url: firstUrl }), true, 'a valid web page creates the mini browser');
  let mini = bridge.getMiniWindow();
  assert.equal(instances.length, 1, 'only the mini browser is opened');
  assert.ok(mini.loadedUrl.includes(`page=${encodeURIComponent(firstUrl)}`), 'first page is loaded at mini startup');

  const secondUrl = 'yayra://downloads';
  assert.equal(bridge.openPageInMini(secondUrl), true, 'a later handoff is accepted');
  assert.equal(bridge.getMiniWindow(), mini, 'the existing mini window is reused');
  assert.deepEqual(mini.webContents.sent, [['yayra:overlay-mini-open-page', { url: secondUrl, openInNewTab: true }]],
    'the mini renderer receives a safe open-page event with the new-tab preference instead of replacing its session');
  assert.equal(instances.length, 1, 'handoffs do not create duplicate mini windows');
});

test('overlayWindow: radial assistant picks reuse one mini by default or open separate mini windows by preference', () => {
  const { bridge, ipcMain, instances } = makeMiniHarness();
  const first = 'https://chatgpt.com/';
  const second = 'https://claude.ai/new';
  const third = 'https://gemini.google.com/';
  const fourth = 'https://copilot.microsoft.com/';
  const mini = bridge.openMiniPanelAt(first);
  assert.ok(mini.loadedUrl.includes(`page=${encodeURIComponent(first)}`), 'first destination boots directly in the mini');
  assert.equal(bridge.openMiniPanelAt(second), mini, 'the default reuses the same mini window');
  assert.equal(instances.length, 1, 'same-mini preference does not create another window');
  assert.deepEqual(mini.webContents.sent.at(-1), ['yayra:overlay-mini-open-page', { url: second, openInNewTab: true }],
    'the second destination becomes a new tab inside that mini');

  const setPreference = ipcMain.handlers.get('yayra:overlay-set-mini-open-behavior');
  assert.equal(typeof setPreference, 'function', 'Settings has a native preference handler');
  assert.equal(setPreference(null, 'separate-mini').miniOpenBehavior, 'separate-mini', 'the separate-window choice is persisted');
  const otherMini = bridge.openMiniPanelAt(third);
  assert.notEqual(otherMini, mini, 'the alternate preference creates a distinct mini window');
  assert.equal(instances.length, 2, 'one separate mini is created for the selected page');
  assert.ok(otherMini.loadedUrl.includes(`page=${encodeURIComponent(third)}`));
  assert.ok(otherMini.loadedUrl.includes('instance=mini-'), 'separate windows receive unique mini-session identifiers');
  assert.equal(bridge.openMiniPanelAt(fourth), instances[2], 'each later destination opens another separate mini');
  assert.equal(instances.length, 3);

  assert.equal(setPreference(null, 'untrusted-value').miniOpenBehavior, 'same-mini', 'invalid values safely fall back to same-mini');
  assert.equal(bridge.openMiniPanelAt(first), instances[2], 'switching back to same-mini reuses the newest mini');
  assert.equal(instances.length, 3);
  bridge.destroyMiniWindow();
  assert.ok(instances.every((win) => win.isDestroyed()), 'cleaning up the mini feature closes every separate window');
});

test('preload: mini page events are queued until the mini shell subscribes, then delivered and unsubscribed safely', async () => {
  const source = fs.readFileSync(new URL('../electron/preload.cjs', import.meta.url), 'utf8');
  const listeners = new Map();
  let exposed = null;
  const calls = [];
  const ipcRenderer = {
    on: (channel, callback) => listeners.set(channel, callback),
    removeListener: (channel, callback) => { if (listeners.get(channel) === callback) listeners.delete(channel); },
    invoke: async (channel, payload) => { calls.push({ channel, payload }); return true; },
    send: () => {}
  };
  runInNewContext(source, {
    require: (name) => { assert.equal(name, 'electron'); return { ipcRenderer, contextBridge: { exposeInMainWorld: (_name, api) => { exposed = api; } } }; },
    console,
    setTimeout,
    clearTimeout,
    setInterval: () => 1,
    clearInterval: () => {}
  });
  assert.ok(exposed?.overlay?.onOpenPage, 'the main preload exposes the mini handoff subscription');
  const first = { url: 'https://example.test/queued' };
  listeners.get('yayra:overlay-mini-open-page')({}, first);
  const received = [];
  const unsubscribe = exposed.overlay.onOpenPage((payload) => received.push(payload));
  assert.deepEqual(received, [first], 'a page handoff sent during app startup is replayed once the shell is ready');
  const second = { url: 'yayra://downloads' };
  listeners.get('yayra:overlay-mini-open-page')({}, second);
  assert.deepEqual(received, [first, second], 'later handoffs arrive immediately');
  unsubscribe();
  listeners.get('yayra:overlay-mini-open-page')({}, { url: 'https://example.test/ignored' });
  assert.equal(received.length, 2, 'unsubscribe stops renderer callbacks');
  assert.equal(await exposed.overlay.openPageInMini('https://example.test/first'), true);
  assert.equal(calls.at(-1).channel, 'yayra:overlay-open-mini-page');
  assert.equal(calls.at(-1).payload.url, 'https://example.test/first');
  let preference = null;
  const stopPreference = exposed.overlay.onMiniOpenPreference((value) => { preference = value; });
  listeners.get('yayra:overlay-mini-open-preference')({}, { miniOpenBehavior: 'separate-mini' });
  assert.equal(preference, 'separate-mini', 'the mini receives preference changes made from another window');
  await exposed.overlay.setMiniOpenBehavior('separate-mini');
  assert.equal(calls.at(-1).channel, 'yayra:overlay-set-mini-open-behavior');
  stopPreference();
});

test('overlayWindow: a selected tab opens in mini through the validated IPC handoff and reuses its tabs', () => {
  const { bridge, ipcMain, instances } = makeMiniHarness();
  const handoff = ipcMain.handlers.get('yayra:overlay-open-mini-page');
  assert.equal(typeof handoff, 'function', 'the preload-facing mini handoff IPC is registered');
  assert.equal(handoff(null, { url: 'javascript:alert(1)' }), false, 'script URLs are rejected');
  assert.equal(handoff(null, { url: 'https://user:password@example.test/' }), false, 'credential-bearing URLs are rejected');
  assert.equal(handoff(null, { url: 'file:///etc/passwd' }), false, 'local file URLs are rejected');

  const firstUrl = 'https://example.test/first';
  assert.equal(handoff(null, { url: firstUrl }), true, 'a valid web page creates the mini browser');
  let mini = bridge.getMiniWindow();
  assert.equal(instances.length, 1, 'only the mini browser is opened');
  assert.ok(mini.loadedUrl.includes(`page=${encodeURIComponent(firstUrl)}`), 'first page is loaded at mini startup');

  const secondUrl = 'yayra://downloads';
  assert.equal(bridge.openPageInMini(secondUrl), true, 'a later handoff is accepted');
  assert.equal(bridge.getMiniWindow(), mini, 'the existing mini window is reused');
  assert.deepEqual(mini.webContents.sent, [['yayra:overlay-mini-open-page', { url: secondUrl, openInNewTab: true }]],
    'the mini renderer receives a safe new-tab handoff instead of replacing its session');
  assert.equal(instances.length, 1, 'handoffs do not create duplicate mini windows');
});

test('preload: mini page events are queued until the mini shell subscribes, then delivered and unsubscribed safely', async () => {
  const source = fs.readFileSync(new URL('../electron/preload.cjs', import.meta.url), 'utf8');
  const listeners = new Map();
  let exposed = null;
  const calls = [];
  const ipcRenderer = {
    on: (channel, callback) => listeners.set(channel, callback),
    removeListener: (channel, callback) => { if (listeners.get(channel) === callback) listeners.delete(channel); },
    invoke: async (channel, payload) => { calls.push({ channel, payload }); return true; },
    send: () => {}
  };
  runInNewContext(source, {
    require: (name) => { assert.equal(name, 'electron'); return { ipcRenderer, contextBridge: { exposeInMainWorld: (_name, api) => { exposed = api; } } }; },
    console,
    setTimeout,
    clearTimeout,
    setInterval: () => 1,
    clearInterval: () => {}
  });
  assert.ok(exposed?.overlay?.onOpenPage, 'the main preload exposes the mini handoff subscription');
  const first = { url: 'https://example.test/queued' };
  listeners.get('yayra:overlay-mini-open-page')({}, first);
  const received = [];
  const unsubscribe = exposed.overlay.onOpenPage((payload) => received.push(payload));
  assert.deepEqual(received, [first], 'a page handoff sent during app startup is replayed once the shell is ready');
  const second = { url: 'yayra://downloads' };
  listeners.get('yayra:overlay-mini-open-page')({}, second);
  assert.deepEqual(received, [first, second], 'later handoffs arrive immediately');
  unsubscribe();
  listeners.get('yayra:overlay-mini-open-page')({}, { url: 'https://example.test/ignored' });
  assert.equal(received.length, 2, 'unsubscribe stops renderer callbacks');
  assert.equal(await exposed.overlay.openPageInMini('https://example.test/first'), true);
  assert.equal(calls.at(-1).channel, 'yayra:overlay-open-mini-page');
  assert.equal(calls.at(-1).payload.url, 'https://example.test/first');
});

test('overlayWindow: clicking the bubble again hides the mini panel; clicking once more brings the SAME window back', () => {
  const { bridge, ipcMain, instances } = makeMiniHarness();
  bridge.initializeOnStartup();
  const click = ipcMain.onHandlers.get('yayra:overlay-bubble-click');

  click();
  const mini = bridge.getMiniWindow();
  assert.equal(mini.visible, true);
  click();
  assert.equal(mini.visible, false, 'second click hides (does not destroy) the mini');
  click();
  assert.equal(mini.visible, true, 'third click shows it again');
  assert.equal(instances.length, 2, 'never a second mini window instance');
});

test('overlayWindow: "open full browser" recreates the main window when it was closed - the bubble does not depend on it', () => {
  let created = 0;
  const { bridge } = makeMiniHarness({
    getMainWindow: () => null, // main window closed / never opened
    createMainWindow: () => { created += 1; return { fake: true }; }
  });
  bridge.restoreMainWindow();
  assert.equal(created, 1, 'a brand new main window is created on demand');
});

test('overlayWindow: disabling the bubble also closes its mini panel (the panel is anchored to the bubble)', () => {
  const { bridge, ipcMain } = makeMiniHarness();
  bridge.initializeOnStartup();
  ipcMain.onHandlers.get('yayra:overlay-bubble-click')();
  assert.ok(bridge.getMiniWindow());

  bridge.setEnabled(false);
  assert.equal(bridge.getOverlayWindow(), null);
  assert.equal(bridge.getMiniWindow(), null);
});

test('overlayWindow: on Linux, enabling launch-at-startup writes an XDG autostart .desktop entry (and disabling removes it)', () => {
  const dir = makeTempDir();
  const overlayStore = createOverlayStore({ fs, userDataDir: dir });
  const { FakeBrowserWindow } = makeRicherBrowserWindowClass();
  const fakeHome = makeTempDir();
  const bridge = createOverlayBridge({
    BrowserWindow: FakeBrowserWindow,
    app: fakeApp(),
    ipcMain: fakeIpcMain(),
    screen: fakeScreen(),
    path,
    preloadPath: '/fake/overlayPreload.cjs',
    overlayStore,
    getMainWindow: () => null,
    fsImpl: fs,
    homeDir: fakeHome,
    platform: 'linux'
  });

  bridge.applyLoginItemSettings(true);
  const autostartFile = path.join(fakeHome, '.config', 'autostart', 'yayra.desktop');
  assert.ok(fs.existsSync(autostartFile), 'autostart .desktop entry written');
  const contents = fs.readFileSync(autostartFile, 'utf8');
  assert.match(contents, /\[Desktop Entry\]/);
  assert.match(contents, /Exec=/);
  // Boot launches must be bubble-only: the autostart entry carries the
  // flag main.cjs uses to skip opening the main browser window at login.
  assert.match(contents, /--yayra-autostart/);

  bridge.applyLoginItemSettings(false);
  assert.equal(fs.existsSync(autostartFile), false, 'disabling startup removes the entry');
});

test('overlayWindow: bubble shows ONLY the Yayra logo - inlined data URL, no circular backdrop', () => {
  const dir = makeTempDir();
  const overlayStore = createOverlayStore({ fs, userDataDir: dir });
  const { FakeBrowserWindow, instances } = makeFakeBrowserWindowClass();
  const fakePng = Buffer.from('fake-png-bytes');
  const bridge = createOverlayBridge({
    BrowserWindow: FakeBrowserWindow,
    app: fakeApp(),
    ipcMain: fakeIpcMain(),
    screen: fakeScreen(),
    path,
    preloadPath: '/fake/overlayPreload.cjs',
    overlayStore,
    getMainWindow: () => null,
    platform: 'win32',
    fsImpl: { readFileSync: () => fakePng },
    logoPath: '/fake/brand/logomain1-transparent.png'
  });

  bridge.ensureOverlayWindow();
  const html = decodeURIComponent(instances[0].loadedUrl.replace('data:text/html;charset=utf-8,', ''));

  assert.ok(
    html.includes(`data:image/png;base64,${fakePng.toString('base64')}`),
    'brand logo is inlined into the bubble as a base64 data URL'
  );
  assert.ok(html.includes('<img id="bubble"'), 'bubble element IS the logo image itself');
  assert.ok(!html.includes('radial-gradient'), 'no circular gradient plate behind the logo');
  // The BUBBLE itself has no circle clipping or plate. (The double-tap
  // radial menu's action buttons are circles by design - that is a
  // separate, initially hidden layer, not the bubble.)
  const bubbleRule = /#bubble\s*\{[^}]*\}/.exec(html)?.[0] || '';
  assert.ok(bubbleRule, 'bubble CSS rule present');
  assert.ok(!bubbleRule.includes('border-radius'), 'no circle clipping around the logo');
  assert.ok(bubbleRule.includes('background:transparent'), 'bubble background stays fully transparent');
});

test('overlayWindow: bubble falls back to a bare monogram (still no circle) when the logo asset is missing', () => {
  const dir = makeTempDir();
  const overlayStore = createOverlayStore({ fs, userDataDir: dir });
  const { FakeBrowserWindow, instances } = makeFakeBrowserWindowClass();
  const bridge = createOverlayBridge({
    BrowserWindow: FakeBrowserWindow,
    app: fakeApp(),
    ipcMain: fakeIpcMain(),
    screen: fakeScreen(),
    path,
    preloadPath: '/fake/overlayPreload.cjs',
    overlayStore,
    getMainWindow: () => null,
    platform: 'win32',
    fsImpl: { readFileSync: () => { throw new Error('missing'); } },
    logoPath: '/fake/missing.png'
  });

  bridge.ensureOverlayWindow();
  const html = decodeURIComponent(instances[0].loadedUrl.replace('data:text/html;charset=utf-8,', ''));

  assert.ok(html.includes('id="monogram"'), 'fallback renders the bare Y monogram');
  assert.ok(!html.includes('radial-gradient'), 'fallback has no circular gradient either');
  const bubbleRule = /#bubble\s*\{[^}]*\}/.exec(html)?.[0] || '';
  assert.ok(bubbleRule && !bubbleRule.includes('border-radius'), 'fallback bubble has no circle clipping either');
});

test('overlayWindow: setBubbleSize live-resizes the bubble window and persists the size', () => {
  const dir = makeTempDir();
  const overlayStore = createOverlayStore({ fs, userDataDir: dir });
  const { FakeBrowserWindow, instances } = makeFakeBrowserWindowClass();
  FakeBrowserWindow.prototype.setBounds = function setBounds(bounds) { this.bounds = bounds; };
  const bridge = createOverlayBridge({
    BrowserWindow: FakeBrowserWindow,
    app: fakeApp(),
    ipcMain: fakeIpcMain(),
    screen: fakeScreen(),
    path,
    preloadPath: '/fake/overlayPreload.cjs',
    overlayStore,
    getMainWindow: () => null
  });

  bridge.ensureOverlayWindow();
  const next = bridge.setBubbleSize(96);

  assert.equal(next.size, 96, 'new size is returned');
  assert.equal(overlayStore.load().size, 96, 'new size is persisted for the next launch');
  assert.deepEqual(
    { width: instances[0].bounds.width, height: instances[0].bounds.height },
    { width: 96, height: 96 },
    'live window is resized in place'
  );

  // Values are clamped to a sane range so the bubble can never vanish.
  assert.equal(bridge.setBubbleSize(4).size, 40);
  assert.equal(bridge.setBubbleSize(4000).size, 160);
  assert.equal(bridge.setBubbleSize('garbage').size, 64);
});

test('overlayWindow: shadow defaults to none, persists, clamps, and updates the live bubble', () => {
  const dir = makeTempDir();
  const overlayStore = createOverlayStore({ fs, userDataDir: dir });
  const { FakeBrowserWindow, instances } = makeFakeBrowserWindowClass();
  const ipcMain = fakeIpcMain();
  const bridge = createOverlayBridge({
    BrowserWindow: FakeBrowserWindow,
    app: fakeApp(),
    ipcMain,
    screen: fakeScreen(),
    path,
    preloadPath: '/fake/overlayPreload.cjs',
    overlayStore,
    getMainWindow: () => null
  });

  assert.equal(overlayStore.load().shadowPx, 0, 'fresh installs have no bubble shadow');
  bridge.ensureOverlayWindow();
  const defaultHtml = decodeURIComponent(instances[0].loadedUrl.replace('data:text/html;charset=utf-8,', ''));
  const defaultRule = /#bubble\s*\{[^}]*\}/.exec(defaultHtml)?.[0] || '';
  assert.ok(defaultRule.includes('filter:none'), 'default native bubble has no drop shadow');

  const next = bridge.setBubbleShadow(12);
  assert.equal(next.shadowPx, 12);
  assert.equal(overlayStore.load().shadowPx, 12, 'shadow setting persists');
  const updatedHtml = decodeURIComponent(instances[0].loadedUrl.replace('data:text/html;charset=utf-8,', ''));
  const updatedRule = /#bubble\s*\{[^}]*\}/.exec(updatedHtml)?.[0] || '';
  assert.ok(updatedRule.includes('drop-shadow(0 3px 12px'), 'the live overlay renders the selected shadow strength');

  const shadowHandler = ipcMain.handlers.get('yayra:overlay-set-bubble-shadow');
  assert.equal(typeof shadowHandler, 'function', 'the preload-facing IPC route is registered');
  assert.equal(shadowHandler(null, 7).shadowPx, 7, 'IPC updates the persisted setting through the public handler');
  assert.equal(bridge.setBubbleShadow(-1).shadowPx, 0, 'negative values clamp to no shadow');
  assert.equal(bridge.setBubbleShadow(99).shadowPx, 24, 'values clamp to the supported maximum');
  assert.equal(bridge.setBubbleShadow('not-a-number').shadowPx, 0, 'invalid values safely reset to no shadow');
});

test('overlayWindow: setBubbleOpacity re-renders the bubble with the new opacity and persists it', () => {
  const dir = makeTempDir();
  const overlayStore = createOverlayStore({ fs, userDataDir: dir });
  const { FakeBrowserWindow, instances } = makeFakeBrowserWindowClass();
  const bridge = createOverlayBridge({
    BrowserWindow: FakeBrowserWindow,
    app: fakeApp(),
    ipcMain: fakeIpcMain(),
    screen: fakeScreen(),
    path,
    preloadPath: '/fake/overlayPreload.cjs',
    overlayStore,
    getMainWindow: () => null
  });

  bridge.ensureOverlayWindow();
  const next = bridge.setBubbleOpacity(0.5);

  assert.equal(next.opacity, 0.5);
  assert.equal(overlayStore.load().opacity, 0.5, 'opacity persisted');
  const html = decodeURIComponent(instances[0].loadedUrl.replace('data:text/html;charset=utf-8,', ''));
  assert.ok(html.includes('opacity:0.5'), 'bubble HTML reloaded with the new opacity baked in');

  assert.equal(bridge.setBubbleOpacity(0).opacity, 0.2, 'clamped low');
  assert.equal(bridge.setBubbleOpacity(7).opacity, 1, 'clamped high');
});
