import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { setupDomShim } from './dom-shim.mjs';

setupDomShim();

import { BrowserShell } from '../packages/shared-ui/src/components/BrowserShell.js';

/**
 * Two Android user reports, fixed:
 *
 *  1. "Mini yayra top-right buttons to hide and expand are not showing" -
 *     the native floating window's title-bar buttons built an ImageButton
 *     and created a TextView with the glyph that was NEVER attached to it:
 *     a backgroundless ImageButton with no image is INVISIBLE. The buttons
 *     are the TextViews now, so hide(-) / expand(square) / close(x) - and
 *     the nav arrows - are actually visible.
 *  2. "Android and web must use Google without saying open in other app" -
 *     Google/YouTube/X/... can never render in the in-shell iframe engine
 *     (X-Frame-Options), so they were handed to Chrome Custom Tabs. The
 *     new ANDROID NATIVE TAB WEBVIEW ENGINE renders them in real WebViews
 *     layered INSIDE Yayra's own window - in-app, no handoff. (Web keeps
 *     the honest auto-new-tab behavior - a plain web page physically
 *     cannot embed Google.)
 */

function makeStorage() {
  const disk = new Map();
  return {
    getItem: (k) => (disk.has(k) ? disk.get(k) : null),
    setItem: (k, v) => disk.set(k, String(v)),
    removeItem: (k) => disk.delete(k),
    key: (i) => [...disk.keys()][i] ?? null,
    get length() { return disk.size; }
  };
}

/**
 * A fake Android (Capacitor) environment: the YayraOverlay plugin now
 * carries the native tab-webview engine (tabWeb* methods + tabWebEvent
 * listener), the Browser plugin records Chrome-Custom-Tab handoffs that
 * should NOT happen anymore, and the App plugin captures the hardware
 * Back-button handler.
 */
function fakeAndroid({ attachResult } = {}) {
  const calls = { attach: [], update: [], visible: [], navigate: [], goBack: [], remove: [], browserOpen: [], exitApp: 0 };
  let eventHandler = null;
  let backHandler = null;
  window.Capacitor = {
    isNativePlatform: () => true,
    Plugins: {
      App: {
        addListener: (name, cb) => { if (name === 'backButton') backHandler = cb; return Promise.resolve({ remove: () => {} }); },
        getLaunchUrl: async () => undefined,
        exitApp: () => { calls.exitApp += 1; }
      },
      Browser: { open: async ({ url }) => { calls.browserOpen.push(url); } },
      YayraOverlay: {
        show: async () => {},
        installSiteAsApp: async () => ({ ok: true }),
        openBrowserWindow: async () => ({ ok: true }),
        addListener: (name, cb) => { if (name === 'tabWebEvent') eventHandler = cb; return Promise.resolve({ remove: () => {} }); },
        tabWebAttach: async (opts) => { calls.attach.push(opts); return attachResult || { ok: true }; },
        tabWebUpdate: async (opts) => { calls.update.push(opts); return { ok: true }; },
        tabWebSetVisible: async (opts) => { calls.visible.push(opts); return { ok: true }; },
        tabWebNavigate: async (opts) => { calls.navigate.push(opts); return { ok: true }; },
        tabWebGoBack: async (opts) => { calls.goBack.push(opts); return { ok: true }; },
        tabWebRemove: async (opts) => { calls.remove.push(opts); return { ok: true }; }
      }
    }
  };
  return {
    calls,
    deliverEvent: (evt) => eventHandler?.(evt),
    pressBack: () => backHandler?.()
  };
}

async function makeShell() {
  globalThis.localStorage = makeStorage();
  const container = document.createElement('div');
  const shell = new BrowserShell({ container, isMobile: true });
  await shell.initialize();
  shell.render(container);
  return { shell, container };
}

const flush = (ms = 25) => new Promise((r) => setTimeout(r, ms));

test('ANDROID: Google renders in the NATIVE in-app engine - no Chrome Custom Tab handoff, no iframe', async () => {
  const android = fakeAndroid();
  const { shell } = await makeShell();
  try {
    const { wrapper, iframe } = shell.createWebContentFrame('https://www.google.com/', { tabId: 'tab-g', allowNative: false });
    await flush();
    assert.equal(iframe, null, 'no iframe is attempted for a frame-hostile site');
    assert.ok(wrapper.classList.contains('fb-android-tabweb-slot'), 'the native engine slot is mounted');
    assert.equal(android.calls.attach.length, 1, 'the native engine attached');
    assert.equal(android.calls.attach[0].id, 'tab-g');
    assert.equal(android.calls.attach[0].url, 'https://www.google.com/');
    assert.deepEqual(android.calls.browserOpen, [], 'NO Chrome Custom Tab handoff - Google stays inside Yayra');
  } finally {
    shell.destroy();
    delete window.Capacitor;
    delete globalThis.localStorage;
  }
});

test('ANDROID: a Google SEARCH opens in-app too (the SERP no longer auto-opens externally)', async () => {
  const android = fakeAndroid();
  const { shell } = await makeShell();
  try {
    const { iframe } = shell.createWebContentFrame('https://www.google.com/search?q=yayra+browser', { tabId: 'tab-s', allowNative: false });
    await flush();
    assert.equal(iframe, null);
    assert.equal(android.calls.attach.length, 1, 'the search results render in the native engine');
    assert.equal(android.calls.attach[0].url, 'https://www.google.com/search?q=yayra+browser');
    assert.deepEqual(android.calls.browserOpen, [], 'no external search handoff');
  } finally {
    shell.destroy();
    delete window.Capacitor;
    delete globalThis.localStorage;
  }
});

test('ANDROID: frame-friendly sites keep the iframe engine (the native layer is only for frame-hostile sites)', async () => {
  fakeAndroid();
  const { shell } = await makeShell();
  try {
    const { iframe } = shell.createWebContentFrame('https://example.com/', { tabId: 'tab-n', allowNative: false });
    assert.ok(iframe, 'normal sites still embed as before');
  } finally {
    shell.destroy();
    delete window.Capacitor;
    delete globalThis.localStorage;
  }
});

test('ANDROID: Google SIGN-IN hosts still hand off honestly (Google blocks sign-in inside embedded WebViews)', async () => {
  const android = fakeAndroid();
  const { shell } = await makeShell();
  try {
    const { iframe } = shell.createWebContentFrame('https://accounts.google.com/signin', { tabId: 'tab-a', allowNative: false });
    await flush();
    assert.equal(iframe, null);
    assert.equal(android.calls.attach.length, 0, 'sign-in pages never enter the in-app engine');
    assert.deepEqual(android.calls.browserOpen, ['https://accounts.google.com/signin'], 'they open in the secure system browser instead');
  } finally {
    shell.destroy();
    delete window.Capacitor;
    delete globalThis.localStorage;
  }
});

test('ANDROID: engine events drive the tab state (address, title, loading) through the shared native-event handler', async () => {
  const android = fakeAndroid();
  const { shell } = await makeShell();
  try {
    shell.state.tabs[0].id = 'tab-e';
    shell.state.activeTabId = 'tab-e';
    // Real usage: the user navigates to the site first (seeding the
    // shell's own history), then link clicks arrive as engine events.
    shell.navigateActiveTab('https://www.youtube.com/');
    await flush();
    assert.equal(android.calls.attach.length, 1, 'youtube attaches to the native engine');

    android.deliverEvent({ id: 'tab-e', type: 'loading-start', url: 'https://www.youtube.com/' });
    assert.equal(shell.state.tabs[0].isLoading, true, 'loading state follows the engine');
    android.deliverEvent({ id: 'tab-e', type: 'title-updated', title: 'YouTube' });
    assert.equal(shell.state.tabs[0].title, 'YouTube', 'title follows the engine');
    android.deliverEvent({
      id: 'tab-e', type: 'navigated', url: 'https://www.youtube.com/watch?v=abc',
      canGoBack: true, canGoForward: false, isLoading: false
    });
    assert.equal(shell.state.tabs[0].url, 'https://www.youtube.com/watch?v=abc', 'address follows the engine (link clicks)');
    assert.equal(shell.state.tabs[0].canGoBack, true);
  } finally {
    shell.destroy();
    delete window.Capacitor;
    delete globalThis.localStorage;
  }
});

test('ANDROID: hardware Back walks the native page history first, and only then exits the app', async () => {
  const android = fakeAndroid();
  const { shell } = await makeShell();
  try {
    shell.state.tabs[0].id = 'tab-b';
    shell.state.activeTabId = 'tab-b';
    shell.createWebContentFrame('https://www.google.com/', { tabId: 'tab-b', allowNative: false });
    await flush();
    shell.state.tabs[0].canGoBack = true;
    android.pressBack();
    assert.equal(android.calls.goBack.length, 1, 'back navigates the native webview');
    assert.equal(android.calls.exitApp, 0, 'the app does NOT exit while the page has history');
    shell.state.tabs[0].canGoBack = false;
    android.pressBack();
    assert.equal(android.calls.exitApp, 1, 'at the page root, back exits the app (standard Android)');
  } finally {
    shell.destroy();
    delete window.Capacitor;
    delete globalThis.localStorage;
  }
});

test('ANDROID: the native surface hides while chrome overlays the page, and returns when it closes', async () => {
  const android = fakeAndroid();
  const { shell, container } = await makeShell();
  try {
    shell.state.tabs[0].id = 'tab-v';
    shell.state.activeTabId = 'tab-v';
    shell.state.tabs[0].url = 'https://www.google.com/';
    shell.render(container);
    await flush();
    const visibleFor = (id) => android.calls.visible.filter((c) => c.id === id).map((c) => c.visible);
    assert.ok(visibleFor('tab-v').includes(true), 'the active page is visible');

    shell.state.isSideDrawerOpen = true; // blocking overlay opens
    shell.render(container);
    await flush();
    const last = android.calls.visible.filter((c) => c.id === 'tab-v').pop();
    assert.equal(last.visible, false, 'the native surface gets out of the way under the drawer');

    shell.state.isSideDrawerOpen = false;
    shell.render(container);
    await flush();
    const back = android.calls.visible.filter((c) => c.id === 'tab-v').pop();
    assert.equal(back.visible, true, 'and comes back when the drawer closes');
  } finally {
    shell.destroy();
    delete window.Capacitor;
    delete globalThis.localStorage;
  }
});

test('ANDROID: closing the tab destroys its native engine (no leaked WebViews)', async () => {
  const android = fakeAndroid();
  const { shell } = await makeShell();
  try {
    const tabId = shell.state.tabs[0].id;
    shell.state.tabs[0].url = 'https://www.google.com/';
    shell.render();
    await flush();
    shell.closeTab(tabId);
    await flush();
    assert.equal(android.calls.remove.length, 1, 'the engine is torn down with the tab');
    assert.equal(android.calls.remove[0].id, tabId);
  } finally {
    shell.destroy();
    delete window.Capacitor;
    delete globalThis.localStorage;
  }
});

test('ANDROID: when the engine cannot attach (very old shell), the honest card + auto-open fallback stays', async () => {
  const android = fakeAndroid({ attachResult: { ok: false } });
  const { shell } = await makeShell();
  try {
    const { wrapper, iframe } = shell.createWebContentFrame('https://www.google.com/', { tabId: 'tab-f', allowNative: false });
    await flush();
    assert.equal(iframe, null);
    const card = wrapper.querySelector('.fb-frame-blocked-fallback');
    assert.ok(card, 'the honest fallback card renders');
    assert.deepEqual(android.calls.browserOpen, ['https://www.google.com/'], 'the site still opens (secure view) - never a dead frame');
  } finally {
    shell.destroy();
    delete window.Capacitor;
    delete globalThis.localStorage;
  }
});

test('KOTLIN PIN: the native tab engine exists, is safe, and reports through tabWebEvent', () => {
  const manager = readFileSync(new URL('../packages/floating-android/src/kotlin/com/yayra/floating/android/YayraTabWebviewManager.kt', import.meta.url), 'utf8');
  assert.ok(manager.includes('class YayraTabWebviewManager'), 'the engine class exists');
  assert.ok(manager.includes('fun attach('), 'attach (create/reuse per tab)');
  assert.ok(manager.includes('fun update('), 'update (follows the DOM slot)');
  assert.ok(manager.includes('fun setVisible('), 'visibility control');
  assert.ok(manager.includes('Bitmap.createBitmap'), 'hiding captures the page frame (no blank flash under chrome)');
  assert.ok(manager.includes('fun navigate('), 'omnibox navigation');
  assert.ok(manager.includes('fun goBack('), 'back history');
  assert.ok(manager.includes('fun remove('), 'per-tab teardown');
  assert.ok(manager.includes('notifyListeners') || manager.includes('emit: (JSObject) -> Unit'), 'events reach the JS layer');
  assert.ok(manager.includes('"tabWebEvent"') || manager.includes('emit(data)'), 'event channel');
  // Security parity with every other Yayra WebView surface.
  assert.ok(manager.includes('settings.javaScriptEnabled = true'), 'JS on (a real browser surface)');
  assert.ok(manager.includes('settings.allowFileAccess = false'), 'file access OFF');
  assert.ok(manager.includes('settings.allowContentAccess = false'), 'content access OFF');

  const plugin = readFileSync(new URL('../packages/floating-android/src/kotlin/com/yayra/floating/android/YayraOverlayPlugin.kt', import.meta.url), 'utf8');
  for (const method of ['tabWebAttach', 'tabWebUpdate', 'tabWebSetVisible', 'tabWebNavigate', 'tabWebGoBack', 'tabWebGoForward', 'tabWebReload', 'tabWebStop', 'tabWebRemove']) {
    assert.ok(plugin.includes(`fun ${method}(call: PluginCall)`), `plugin exposes ${method}`);
  }
  assert.ok(plugin.includes('notifyListeners("tabWebEvent", data)'), 'the plugin forwards engine events');
});

test('KOTLIN PIN (mini window): the title-bar and nav buttons RENDER their glyphs (hide / expand / close are visible)', () => {
  const view = readFileSync(new URL('../packages/floating-android/src/kotlin/com/yayra/floating/android/YayraFloatingBrowserWindowView.kt', import.meta.url), 'utf8');
  // The old bug: an ImageButton with a detached TextView - nothing visible.
  assert.ok(!view.includes('ImageButton(context).apply'), 'no more invisible ImageButtons');
  assert.match(view, /private fun createTitleButton\(label: String, color: Int, onClick: \(\) -> Unit\): TextView/, 'the title button IS the label view');
  assert.match(view, /text = label/, 'the glyph text is set on it');
  assert.match(view, /gravity = Gravity.CENTER/, 'and centered');
  assert.match(view, /private fun createNavButton\(symbol: String, onClick: \(\) -> Unit\): TextView/, 'nav buttons are labels too');
  assert.match(view, /text = symbol/, 'the arrow symbol is actually used');
  // The three top-right controls exist: hide (minimize), expand (maximize), close.
  assert.ok(view.includes('btnMinimize = createTitleButton'), 'hide button');
  assert.ok(view.includes('btnMaximize = createTitleButton'), 'expand button');
  assert.ok(view.includes('btnClose = createTitleButton'), 'close button');
});

test('ANDROID: hardware Back closes the side drawer FIRST, then the mini window, then walks page history, then exits', async () => {
  const android = fakeAndroid();
  const { shell } = await makeShell();
  try {
    // Drawer open -> Back closes the drawer, nothing else.
    shell.state.isSideDrawerOpen = true;
    android.pressBack();
    assert.equal(shell.state.isSideDrawerOpen, false, 'drawer closed');
    assert.equal(android.calls.exitApp, 0, 'app did not exit');
    assert.equal(android.calls.goBack.length, 0, 'page history untouched');

    // Mini window open -> Back closes it.
    shell.state.isFloatingMiniOpen = true;
    android.pressBack();
    assert.equal(shell.state.isFloatingMiniOpen, false, 'mini window closed');
    assert.equal(android.calls.exitApp, 0, 'app did not exit');

    // Native page with history -> Back walks the page.
    shell.state.tabs[0].id = 'tab-bx';
    shell.state.activeTabId = 'tab-bx';
    shell.createWebContentFrame('https://www.google.com/', { tabId: 'tab-bx', allowNative: false });
    await flush();
    shell.state.tabs[0].canGoBack = true;
    android.pressBack();
    assert.equal(android.calls.goBack.length, 1, 'page history walked');
    assert.equal(android.calls.exitApp, 0, 'app did not exit');

    // Page root -> Back exits (standard Android).
    shell.state.tabs[0].canGoBack = false;
    android.pressBack();
    assert.equal(android.calls.exitApp, 1, 'exit at the page root');
  } finally {
    shell.destroy();
    delete window.Capacitor;
    delete globalThis.localStorage;
  }
});

test('KOTLIN PIN (bubble): the Settings quick action launches the real app - never a yayra:// URL in a raw WebView', () => {
  const service = readFileSync(new URL('../packages/floating-android/src/kotlin/com/yayra/floating/android/YayraFloatBubbleService.kt', import.meta.url), 'utf8');
  const block = service.slice(service.indexOf('QuickAction.SETTINGS ->'), service.indexOf('QuickAction.CLOSE_BUBBLE ->'));
  assert.ok(block.includes('getLaunchIntentForPackage'), 'the app own launch intent is used');
  assert.ok(!block.includes('yayra://settings'), 'the unresolvable in-app scheme is gone');
});
