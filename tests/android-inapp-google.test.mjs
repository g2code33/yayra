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
  const calls = { attach: [], update: [], visible: [], pointerTheme: [], navigate: [], goBack: [], remove: [], browserOpen: [], exitApp: 0 };
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
        tabWebSetPointerTheme: async (opts) => { calls.pointerTheme.push(opts); return { ok: true }; },
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

test('ANDROID: a native-page OAuth redirect is canceled, opened with Browser, and leaves the source tab/history intact', async () => {
  const android = fakeAndroid();
  const { shell } = await makeShell();
  try {
    shell.navigateActiveTab('https://www.google.com/search?q=ghana');
    const tab = shell.getActiveTab();
    const activeTabId = shell.state.activeTabId;
    const history = [...tab.navigationState.historyStack];

    android.deliverEvent({ id: tab.id, type: 'loading-start', url: tab.url });
    assert.equal(tab.isLoading, true, 'an in-progress page navigation turns the loader on');
    // YayraTabWebviewManager emits loading-stop before auth-navigation-blocked,
    // because a canceled WebView navigation may never reach onPageFinished.
    android.deliverEvent({ id: tab.id, type: 'loading-stop' });
    android.deliverEvent({
      id: tab.id,
      type: 'auth-navigation-blocked',
      url: 'https://accounts.google.com/o/oauth2/v2/auth?client_id=site-client'
    });
    await flush();

    assert.equal(tab.isLoading, false, 'canceled OAuth navigation cannot leave the source tab spinner stuck');
    assert.deepEqual(android.calls.browserOpen, ['https://accounts.google.com/o/oauth2/v2/auth?client_id=site-client']);

    android.deliverEvent({ id: tab.id, type: 'auth-navigation-blocked', url: 'http://accounts.google.com/o/oauth2/v2/auth?client_id=second-client' });
    await flush();
    assert.deepEqual(android.calls.browserOpen, [
      'https://accounts.google.com/o/oauth2/v2/auth?client_id=site-client',
      'https://accounts.google.com/o/oauth2/v2/auth?client_id=second-client'
    ], 'an insecure OAuth URL is upgraded before it reaches the system browser');
    assert.equal(shell.state.activeTabId, activeTabId);
    assert.equal(tab.url, 'https://www.google.com/search?q=ghana');
    assert.deepEqual(tab.navigationState.historyStack, history);
  } finally {
    shell.destroy();
    delete window.Capacitor;
    delete globalThis.localStorage;
  }
});

test('ANDROID: account browsing stays native while interactive Google sign-in uses the secure browser', async () => {
  const android = fakeAndroid();
  const { shell } = await makeShell();
  try {
    const browsingUrls = [
      'https://accounts.google.com/',
      'https://accounts.google.com/ManageAccount'
    ];
    for (const [index, url] of browsingUrls.entries()) {
      const { iframe } = shell.createWebContentFrame(url, { tabId: `tab-account-${index}`, allowNative: false });
      assert.equal(iframe, null, `${url} uses the in-app native WebView, not an iframe`);
    }
    const signInUrl = 'https://accounts.google.com/signin/v2/identifier';
    const { iframe } = shell.createWebContentFrame(signInUrl, { tabId: 'tab-account-signin', allowNative: false });
    assert.equal(iframe, null);
    await flush();
    assert.deepEqual(android.calls.attach.map((call) => call.url), browsingUrls);
    assert.deepEqual(android.calls.browserOpen, [signInUrl]);
  } finally {
    shell.destroy();
    delete window.Capacitor;
    delete globalThis.localStorage;
  }
});

test('ANDROID: an explicit Google OAuth endpoint still uses the system browser', async () => {
  const android = fakeAndroid();
  const { shell } = await makeShell();
  try {
    const authUrl = 'https://accounts.google.com/o/oauth2/v2/auth?client_id=site-client';
    const { iframe } = shell.createWebContentFrame(authUrl, { tabId: 'tab-oauth', allowNative: false });
    await flush();
    assert.equal(iframe, null);
    assert.equal(android.calls.attach.length, 0, 'OAuth authorization is never embedded');
    assert.deepEqual(android.calls.browserOpen, [authUrl]);
  } finally {
    shell.destroy();
    delete window.Capacitor;
    delete globalThis.localStorage;
  }
});

test('ANDROID: custom pointer settings reach existing and newly opened native website views', async () => {
  const android = fakeAndroid();
  const { shell } = await makeShell();
  try {
    shell.createWebContentFrame('https://www.google.com/', { tabId: 'tab-1', allowNative: false });
    await flush();
    assert.equal(android.calls.attach[0].pointerTheme, 'system', 'the saved/default theme is sent when a site view is created');

    shell.state.settings.pointerTheme = 'high-visibility';
    shell.state.settings.pointerSize = 'xlarge';
    shell.applyPointerTheme();
    await flush();
    assert.ok(android.calls.pointerTheme.some((item) => item.id === 'tab-1' && item.theme === 'high-visibility' && item.size === 'xlarge'), 'an open website gets the live change');
    assert.equal(document.body.getAttribute('data-fb-pointer'), 'high-visibility', 'Yayra chrome uses the same setting');

    shell.createWebContentFrame('https://www.google.com/search?q=pointer', { tabId: 'tab-pointer-new' });
    await flush();
    const next = android.calls.attach.at(-1);
    assert.equal(next.pointerTheme, 'high-visibility', 'future website tabs inherit the saved theme');
    assert.equal(next.pointerSize, 'xlarge');
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
  assert.ok(manager.includes('fun setPointerTheme('), 'website pointer preference reaches live Android tabs');
  assert.ok(manager.includes('applyPointerThemeToPage'), 'the custom cursor is injected into the page renderer');
  assert.ok(manager.includes("input[type='checkbox']") && manager.includes("[role='combobox']"), 'native website styles recognize form and ARIA controls');
  assert.ok(manager.includes('val handTargetSelector = "$interactiveSelector:not(html)"'), 'the hand selector includes non-link controls');
  assert.ok(manager.includes('$handTargetSelector, $handTargetSelector *'), 'the hand cursor also covers nested icons and labels');
  assert.ok(manager.includes("input[type='tel']") && manager.includes("[contenteditable]:not([contenteditable='false'])"), 'text-entry fields keep the native I-beam');
  assert.ok(manager.includes("data-yayra-selectable-text") && manager.includes('caretRangeFromPoint'), 'actual page text gets an I-beam and remains selectable');
  assert.ok(manager.includes("ev.pointerType==='touch'&&ev.type!=='pointerdown'"), 'touch pointerdown enables Android native selection/action mode');
  assert.ok(manager.includes("style[nonce],script[nonce]"), 'site CSP nonces are reused where available so custom cursors remain visible');
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
  assert.ok(manager.includes('isSystemBrowserAuthUrl(uri)'), 'Google auth is path-classified rather than all of accounts.google.com');
  assert.ok(manager.includes('val GOOGLE_AUTH_PATH = Regex(') && manager.includes('signin/oauth'), 'Android hands off explicit OAuth routes');
  assert.ok(manager.includes('v3/signin') && manager.includes('ServiceLogin'), 'interactive Google Account sign-in also uses the external user-agent');
  assert.equal(manager.includes('|signin(?:/|$)'), false, 'a broad /signin prefix is not enough to trigger handoff');
  assert.ok(manager.includes('GOOGLE_REJECTED_SIGNIN_PATH') && manager.includes('appendPath("ServiceLogin")'), 'embedded-browser rejection is repaired before system-browser launch');
  assert.ok(manager.includes('request.isForMainFrame && isSystemBrowserAuthUrl(targetUri)'), 'top-level provider redirects are stopped before loading');
  const authNavigationGuard = manager.slice(
    manager.indexOf('if (request.isForMainFrame && isSystemBrowserAuthUrl(targetUri))'),
    manager.indexOf('val target = targetUri.toString()')
  );
  assert.ok(authNavigationGuard.includes('emitEvent(id, "loading-stop")'), 'a canceled native OAuth navigation clears the loader even when onPageFinished will not fire');
  assert.ok(manager.includes('auth-navigation-blocked'), 'the shell receives a safe handoff request');
  assert.ok(manager.includes('secureSystemBrowserAuthUrl(targetUri)'), 'HTTP provider endpoints are upgraded before handoff');
  assert.ok(manager.includes('uri.buildUpon().scheme("https")'), 'the native helper never opens auth over plaintext HTTP');
  assert.ok(manager.includes('onCreateWindow'), 'OAuth popups are routed instead of silently failing in the native view');
  assert.ok(manager.includes('setSupportMultipleWindows(true)'), 'user-initiated popups reach the routing callback');

  const plugin = readFileSync(new URL('../packages/floating-android/src/kotlin/com/yayra/floating/android/YayraOverlayPlugin.kt', import.meta.url), 'utf8');
  for (const method of ['tabWebAttach', 'tabWebUpdate', 'tabWebSetVisible', 'tabWebSetPointerTheme', 'tabWebNavigate', 'tabWebGoBack', 'tabWebGoForward', 'tabWebReload', 'tabWebStop', 'tabWebRemove']) {
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

test('KOTLIN PIN (compile guard): Capacitor PluginCall getters are @Nullable - every call site must survive null (the v1.0.39 Android release build died on this)', () => {
  const plugin = readFileSync(new URL('../packages/floating-android/src/kotlin/com/yayra/floating/android/YayraOverlayPlugin.kt', import.meta.url), 'utf8');
  // getDouble sites must elvis; getBoolean sites must elvis when the callee
  // wants a non-null Boolean; getString may stay nullable ONLY where the
  // callee accepts String?.
  for (const line of plugin.split('\n')) {
    const trimmed = line.trim();
    if (trimmed.startsWith('//')) continue;
    if (/call\.getDouble\(/.test(trimmed)) {
      assert.ok(/\?\:/.test(trimmed), `getDouble site must elvis a default: ${trimmed}`);
    }
    if (/call\.getBoolean\(/.test(trimmed)) {
      assert.ok(/\?\:/.test(trimmed), `getBoolean site must elvis a default (Boolean? -> Boolean killed the v1.0.39 APK build): ${trimmed}`);
    }
  }
});
