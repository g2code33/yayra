import test from 'node:test';
import assert from 'node:assert/strict';
import {
  requiresSystemBrowserAuth,
  secureSystemBrowserAuthUrl,
  sanitizeBounds,
  buildBrowserUserAgent,
  buildContextMenuTemplate,
  buildPointerThemeCss,
  buildPointerThemeScript,
  createWebviewBridge,
  WEBVIEW_EVENT_CHANNEL
} from '../electron/webviewBridge.cjs';

// --- Pure helper logic -------------------------------------------------

test('requiresSystemBrowserAuth: recognizes Google OAuth/sign-in paths and preserves other providers', () => {
  assert.equal(requiresSystemBrowserAuth('https://accounts.google.com/signin/v2/identifier'), true);
  assert.equal(requiresSystemBrowserAuth('https://accounts.google.com/o/oauth2/v2/auth?client_id=x'), true);
  assert.equal(requiresSystemBrowserAuth('https://accounts.google.com/gsi/select?client_id=x'), true);
  assert.equal(requiresSystemBrowserAuth('https://appleid.apple.com/auth/authorize'), true);
  assert.equal(requiresSystemBrowserAuth('https://login.live.com/'), true);
  assert.equal(requiresSystemBrowserAuth('https://sub.login.microsoftonline.com/'), true);
});

test('requiresSystemBrowserAuth: ordinary Google browsing/account pages stay in Yayra', () => {
  assert.equal(requiresSystemBrowserAuth('https://www.google.com/search?q=ghana'), false);
  assert.equal(requiresSystemBrowserAuth('https://mail.google.com/mail/u/0/'), false);
  assert.equal(requiresSystemBrowserAuth('https://accounts.google.com/'), false);
  assert.equal(requiresSystemBrowserAuth('https://accounts.google.com/ManageAccount'), false);
  assert.equal(requiresSystemBrowserAuth('https://myaccount.google.com/security'), false);
  assert.equal(requiresSystemBrowserAuth('https://accounts.google.com.evil.example/signin'), false);
  assert.equal(requiresSystemBrowserAuth('https://www.youtube.com/'), false);
  assert.equal(requiresSystemBrowserAuth('not a url'), false);
});

test('secureSystemBrowserAuthUrl: upgrades recognized HTTP auth endpoints without broadening Google routing', () => {
  assert.equal(requiresSystemBrowserAuth('http://accounts.google.com/signin'), true);
  assert.equal(secureSystemBrowserAuthUrl('http://accounts.google.com/signin'), 'https://accounts.google.com/signin');
  assert.equal(secureSystemBrowserAuthUrl('http://login.live.com/'), 'https://login.live.com/');
  assert.equal(secureSystemBrowserAuthUrl('https://accounts.google.com/signin'), 'https://accounts.google.com/signin');
  assert.equal(secureSystemBrowserAuthUrl('http://www.google.com/search?q=ghana'), 'http://www.google.com/search?q=ghana');
});

test('buildBrowserUserAgent: never includes the Electron identity token, on any platform', () => {
  for (const platform of ['win32', 'darwin', 'linux']) {
    const ua = buildBrowserUserAgent({ platform, chromeVersion: '130.0.6723.70' });
    assert.doesNotMatch(ua, /Electron/i);
    assert.match(ua, /Chrome\/130\.0\.6723\.70/);
    assert.match(ua, /AppleWebKit\/537\.36/);
  }
});

test('custom pointer CSS covers nested interactive controls, is self-contained, and preserves text cursors', () => {
  const css = buildPointerThemeCss('yayra', 'large');
  assert.match(css, /data:image\/svg\+xml,%3Csvg/, 'cursor art is inline (no network fetch)');
  assert.match(css, /width%3D%2236%22/, 'large cursor image uses the selected size');
  for (const selector of [
    'a, area[href]', 'button', '[role="button"]', '[role="combobox"]',
    'input[type="checkbox"]', 'input[type="file"]', '[onclick]', '[tabindex]'
  ]) assert.ok(css.includes(selector), `${selector} uses the hand cursor`);
  assert.match(css, /:where\([^\n]+\):not\(html\), :where\([^\n]+\):not\(html\) \* \{ cursor:.*pointer !important;/, 'the hand cursor applies to interactive targets and their nested icons/text');
  assert.match(css, /input\[type="email"\][\s\S]*cursor: text !important/, 'text entry keeps its I-beam');
  assert.match(css, /input\[type="tel"\]/, 'telephone fields retain native text-cursor treatment');
  assert.match(buildPointerThemeCss('high-visibility', 'xlarge'), /%23ffd400/, 'high-visibility keeps its yellow outline');
  assert.match(buildPointerThemeScript('system'), /yayra-custom-pointer-theme/, 'System removes any injected cursor stylesheet');
});

test('sanitizeBounds: clamps negative/missing values and rounds floats', () => {
  assert.deepEqual(sanitizeBounds({ x: -5, y: 12.6, width: 300.2, height: NaN }), { x: 0, y: 13, width: 300, height: 0 });
  assert.deepEqual(sanitizeBounds(undefined), { x: 0, y: 0, width: 0, height: 0 });
});

// --- createWebviewBridge wiring (fake Electron primitives) --------------

function createFakeWebContents() {
  const listeners = new Map();
  let windowOpenHandler = null;
  let destroyed = false;
  let backStack = [];
  let forwardStack = [];
  let userAgent = null;
  const calls = [];
  return {
    loadURL: async () => {},
    reload: () => { calls.push('reload'); },
    stop: () => {},
    close: () => { destroyed = true; },
    isDestroyed: () => destroyed,
    canGoBack: () => backStack.length > 0,
    canGoForward: () => forwardStack.length > 0,
    goBack: () => { if (backStack.length) forwardStack.push(backStack.pop()); calls.push('goBack'); },
    goForward: () => { if (forwardStack.length) backStack.push(forwardStack.pop()); calls.push('goForward'); },
    setWindowOpenHandler: (fn) => { windowOpenHandler = fn; },
    setUserAgent: (ua) => { userAgent = ua; },
    get userAgent() { return userAgent; },
    on: (event, fn) => {
      if (!listeners.has(event)) listeners.set(event, []);
      listeners.get(event).push(fn);
    },
    emit: (event, ...args) => {
      for (const fn of listeners.get(event) || []) fn(...args);
    },
    _simulateWindowOpen: (details) => windowOpenHandler(details),
    _simulateContextMenu: (params) => {
      for (const fn of listeners.get('context-menu') || []) fn({}, params);
    },
    _backStack: backStack,
    _forwardStack: forwardStack,
    _calls: calls,
    // Right-click menu actions (Chrome parity) - see buildContextMenuTemplate.
    copy: () => calls.push('copy'),
    cut: () => calls.push('cut'),
    paste: () => calls.push('paste'),
    undo: () => calls.push('undo'),
    redo: () => calls.push('redo'),
    selectAll: () => calls.push('selectAll'),
    inspectElement: (x, y) => calls.push(`inspectElement:${x},${y}`),
    downloadURL: (url) => calls.push(`downloadURL:${url}`)
  };
}


function createFakeWebContentsView() {
  const webContents = createFakeWebContents();
  webContents.loadURL = async () => {};
  return {
    webContents,
    bounds: null,
    setBounds(b) { this.bounds = b; }
  };
}

function makeHarness({ authHosts, autofillPreloadPath } = {}) {
  const handlers = new Map();
  const listeners = new Map();
  const ipcMain = {
    handle: (channel, fn) => handlers.set(channel, fn),
    on: (channel, fn) => listeners.set(channel, fn)
  };
  const sentEvents = [];
  const fakeWin = {
    destroyed: false,
    isDestroyed() { return this.destroyed; },
    webContents: { send: (channel, payload) => sentEvents.push({ channel, payload }) },
    contentView: {
      children: [],
      addChildView(view) { this.children.push(view); },
      removeChildView(view) { this.children = this.children.filter((v) => v !== view); }
    }
  };
  const externalCalls = [];
  const shell = { openExternal: async (url) => { externalCalls.push(url); } };
  const views = [];
  const WebContentsView = function FakeWebContentsView(opts) {
    const view = createFakeWebContentsView();
    view.__options = opts || null;
    view.webContents.sent = [];
    view.webContents.send = (channel, payload) => view.webContents.sent.push({ channel, payload });
    views.push(view);
    return view;
  };

  const clipboardWrites = [];
  const clipboard = { writeText: (text) => clipboardWrites.push(text) };
  const popupCalls = [];
  const Menu = {
    buildFromTemplate: (template) => ({
      template,
      popup: (opts) => popupCalls.push({ template, opts })
    })
  };

  const bridge = createWebviewBridge({
    WebContentsView,
    ipcMain,
    shell,
    Menu,
    clipboard,
    getMainWindow: () => fakeWin,
    authHosts,
    autofillPreloadPath,
    logger: { error: () => {} }
  });

  return { bridge, handlers, listeners, sentEvents, fakeWin, externalCalls, views, clipboardWrites, popupCalls };
}

test('webview bridge: creating a tab adds a WebContentsView as a child view and loads the URL', async () => {
  const { handlers, fakeWin, views } = makeHarness();
  await handlers.get('yayra:webview-ensure')(null, { tabId: 'tab-1', url: 'https://www.google.com/' });

  assert.equal(views.length, 1, 'exactly one native view created');
  assert.equal(fakeWin.contentView.children.length, 1, 'view attached to the window content view (not an <iframe>)');
});

test('webview bridge: an ordinary Google account page stays in the native in-app view', async () => {
  const { handlers, views, externalCalls } = makeHarness();
  await handlers.get('yayra:webview-ensure')(null, { tabId: 'tab-google-account', url: 'https://accounts.google.com/ManageAccount' });
  assert.equal(views.length, 1);
  assert.deepEqual(externalCalls, []);
});

test('webview bridge: user-origin pointer styles bypass site CSP, style child frames best-effort, and update live', async () => {
  const { handlers, views } = makeHarness();
  const ensure = handlers.get('yayra:webview-ensure');
  await ensure(null, { tabId: 'tab-pointer', url: 'https://example.com/', pointerTheme: 'yayra', pointerSize: 'large' });
  const wc = views[0].webContents;
  const frameScripts = [];
  const inserted = new Map();
  const insertionCalls = [];
  let nextKey = 0;
  const makeFrame = () => ({ executeJavaScript: async (script) => { frameScripts.push(script); return true; } });
  const mainFrame = makeFrame();
  const childFrame = makeFrame();
  mainFrame.framesInSubtree = [mainFrame, childFrame];
  wc.mainFrame = mainFrame;
  wc.executeJavaScript = async (script) => { frameScripts.push(script); return true; };
  wc.insertCSS = async (css, options) => {
    const key = `pointer-${++nextKey}`;
    inserted.set(key, { css, options });
    insertionCalls.push({ key, css, options });
    return key;
  };
  wc.removeInsertedCSS = async (key) => { inserted.delete(key); };

  const flushStyles = () => new Promise((resolve) => setImmediate(resolve));
  wc.emit('dom-ready');
  await flushStyles();
  assert.equal(inserted.size, 1, 'the main website document receives a user-origin stylesheet');
  assert.equal(insertionCalls.length, 1);
  assert.equal(insertionCalls[0].options.cssOrigin, 'user', 'page CSP and author !important rules cannot block the native stylesheet');
  assert.ok(insertionCalls[0].css.includes('data:image/svg+xml'), 'cursor artwork is embedded, not fetched from a site');
  assert.ok(frameScripts.some((script) => script.includes("style[nonce],script[nonce]")), 'nonce-aware fallback also styles child frames');

  const setTheme = handlers.get('yayra:webview-set-pointer-theme');
  assert.deepEqual(setTheme(null, { tabId: 'tab-pointer', theme: 'high-visibility', size: 'xlarge' }), { ok: true });
  await flushStyles();
  assert.equal(inserted.size, 1, 'live change replaces, rather than stacks, the old style');
  assert.ok([...inserted.values()].every(({ css }) => css.includes('%23ffd400') && css.includes('width%3D%2248%22')), 'live settings reach the website at the selected size');

  wc.emit('did-frame-finish-load', {}, false, 1, 2);
  await flushStyles();
  assert.equal(inserted.size, 1, 'a later frame load reapplies without leaving duplicate styles');
  assert.equal(insertionCalls.length, 3, 'the user stylesheet refreshes on later frame loads');

  setTheme(null, { tabId: 'tab-pointer', theme: 'system', size: 'normal' });
  await flushStyles();
  assert.equal(inserted.size, 0, 'System removes the installed user style');
  assert.ok(frameScripts.some((script) => script.includes('delete window.__yayraPointerThemeObserver')), 'page-owned child-frame styles are removed too');
});

test('webview bridge: re-ensuring the same tab with the same URL does not reload', async () => {
  const { handlers, views } = makeHarness();
  let loadCount = 0;
  const ensure = handlers.get('yayra:webview-ensure');
  await ensure(null, { tabId: 'tab-1', url: 'https://example.com/' });
  views[0].webContents.loadURL = async () => { loadCount += 1; };
  await ensure(null, { tabId: 'tab-1', url: 'https://example.com/' });
  assert.equal(loadCount, 0, 'no second load for an unchanged URL');
  await ensure(null, { tabId: 'tab-1', url: 'https://example.com/other' });
  assert.equal(loadCount, 1, 'navigates when the URL actually changes');
});

test('webview bridge: identity-provider sign-in hosts (Google/Apple/Microsoft) are handed off to the system browser, never embedded', async () => {
  const { handlers, sentEvents, externalCalls, views } = makeHarness();
  const result = await handlers.get('yayra:webview-ensure')(null, { tabId: 'tab-auth', url: 'https://appleid.apple.com/auth/authorize' });

  assert.equal(views.length, 0, 'no native view is ever created for an auth host');
  assert.deepEqual(externalCalls, ['https://appleid.apple.com/auth/authorize']);
  assert.equal(result.handedOffToSystemBrowser, true);
  const handoffEvent = sentEvents.find((e) => e.payload.type === 'system-browser-handoff');
  assert.ok(handoffEvent, 'renderer is notified of the handoff');
  assert.equal(handoffEvent.channel, WEBVIEW_EVENT_CHANNEL);
});

test('webview bridge: Google sign-in is also handed off to the system browser (not embedded), same as Apple/Microsoft', async () => {
  const { handlers, externalCalls, views } = makeHarness();
  const result = await handlers.get('yayra:webview-ensure')(null, { tabId: 'tab-auth', url: 'https://accounts.google.com/signin' });

  assert.equal(result.handedOffToSystemBrowser, true);
  assert.deepEqual(externalCalls, ['https://accounts.google.com/signin']);
  assert.equal(views.length, 0, 'no native view is ever created for Google sign-in');
});

test('webview bridge: direct HTTP Google sign-in is upgraded before opening externally', async () => {
  const { handlers, externalCalls, views } = makeHarness();
  const result = await handlers.get('yayra:webview-ensure')(null, { tabId: 'tab-insecure-auth', url: 'http://accounts.google.com/signin' });
  assert.equal(result.handedOffToSystemBrowser, true);
  assert.deepEqual(externalCalls, ['https://accounts.google.com/signin']);
  assert.equal(views.length, 0);
});

test('webview bridge: popups to an identity-provider sign-in host from an already-open tab are also handed off externally, not opened as a child view', async () => {
  const { handlers, views, externalCalls } = makeHarness();
  await handlers.get('yayra:webview-ensure')(null, { tabId: 'tab-1', url: 'https://mail.google.com/' });
  const guestWebContents = views[0].webContents;

  const response = guestWebContents._simulateWindowOpen({ url: 'https://appleid.apple.com/auth/authorize' });
  assert.deepEqual(response, { action: 'deny' });
  assert.deepEqual(externalCalls, ['https://appleid.apple.com/auth/authorize']);
});

test('webview bridge: popups to accounts.google.com are also handed off externally, not opened as a child view', async () => {
  const { handlers, views, externalCalls } = makeHarness();
  await handlers.get('yayra:webview-ensure')(null, { tabId: 'tab-1', url: 'https://mail.google.com/' });
  const guestWebContents = views[0].webContents;

  const response = guestWebContents._simulateWindowOpen({ url: 'https://accounts.google.com/signin/oauth' });
  assert.deepEqual(response, { action: 'deny' });
  assert.deepEqual(externalCalls, ['https://accounts.google.com/signin/oauth']);
});

test('webview bridge: top-level OAuth redirects are canceled and handed off without changing the in-app page', async () => {
  const { handlers, views, sentEvents, externalCalls } = makeHarness();
  await handlers.get('yayra:webview-ensure')(null, { tabId: 'tab-site', url: 'https://mail.google.com/' });
  const wc = views[0].webContents;
  const authUrl = 'https://accounts.google.com/o/oauth2/v2/auth?client_id=site-client';
  const event = { prevented: false, preventDefault() { this.prevented = true; } };

  // Electron 44 details-object signature.
  wc.emit('will-redirect', event, { url: authUrl, isMainFrame: true });
  assert.equal(event.prevented, true);
  assert.deepEqual(externalCalls, [authUrl]);
  assert.equal(sentEvents.some((e) => e.payload.type === 'navigated'), false, 'a canceled auth redirect does not rewrite the source tab URL/history');
  assert.ok(sentEvents.some((e) => e.payload.type === 'system-browser-handoff' && e.payload.url === authUrl));
  assert.ok(sentEvents.some((e) => e.payload.type === 'loading-stop'), 'canceled navigation clears the loading state');

  // Electron may place navigation details directly on the event object.
  const eventDetails = {
    url: 'https://accounts.google.com/signin/v2/identifier',
    isMainFrame: true,
    prevented: false,
    preventDefault() { this.prevented = true; }
  };
  wc.emit('will-navigate', eventDetails);
  assert.equal(eventDetails.prevented, true);
  assert.deepEqual(externalCalls, [authUrl, eventDetails.url]);

  // Legacy positional signature still guards against subframe redirects.
  const subframe = { prevented: false, preventDefault() { this.prevented = true; } };
  wc.emit('will-navigate', subframe, 'https://accounts.google.com/signin/v2/identifier', false, false);
  assert.equal(subframe.prevented, false);
  assert.deepEqual(externalCalls, [authUrl, eventDetails.url]);

  const ordinaryGoogle = { prevented: false, preventDefault() { this.prevented = true; } };
  wc.emit('will-redirect', ordinaryGoogle, { url: 'https://www.google.com/search?q=ghana', isMainFrame: true });
  assert.equal(ordinaryGoogle.prevented, false, 'ordinary Google search is not sent to the system browser by auth routing');
  assert.deepEqual(externalCalls, [authUrl, eventDetails.url]);
});

test('webview bridge: HTTP auth redirects are canceled and upgraded before handoff', async () => {
  const { handlers, views, sentEvents, externalCalls } = makeHarness();
  await handlers.get('yayra:webview-ensure')(null, { tabId: 'tab-source', url: 'https://example.com/' });
  const event = { prevented: false, preventDefault() { this.prevented = true; } };
  views[0].webContents.emit('will-redirect', event, { url: 'http://accounts.google.com/signin', isMainFrame: true });
  assert.equal(event.prevented, true);
  assert.deepEqual(externalCalls, ['https://accounts.google.com/signin']);
  assert.ok(sentEvents.some((e) => e.payload.type === 'system-browser-handoff' && e.payload.url === 'https://accounts.google.com/signin'));
});

test('webview bridge: every new tab gets a browser-like user agent without the Electron token', async () => {
  const { handlers, views } = makeHarness();
  await handlers.get('yayra:webview-ensure')(null, { tabId: 'tab-1', url: 'https://example.com/' });
  assert.ok(views[0].webContents.userAgent, 'a custom user agent was set');
  assert.doesNotMatch(views[0].webContents.userAgent, /Electron/i);
});

test('webview bridge: ordinary popups are denied locally and reported to the renderer as new-window-request (opened as a Yayra tab)', async () => {
  const { handlers, views, sentEvents, externalCalls } = makeHarness();
  await handlers.get('yayra:webview-ensure')(null, { tabId: 'tab-1', url: 'https://example.com/' });
  const guestWebContents = views[0].webContents;

  const response = guestWebContents._simulateWindowOpen({ url: 'https://example.com/help' });
  assert.deepEqual(response, { action: 'deny' });
  assert.equal(externalCalls.length, 0);
  const requestEvent = sentEvents.find((e) => e.payload.type === 'new-window-request');
  assert.ok(requestEvent);
  assert.equal(requestEvent.payload.url, 'https://example.com/help');
});

test('webview bridge: did-navigate forwards URL and back/forward state to the renderer', async () => {
  const { handlers, views, sentEvents } = makeHarness();
  await handlers.get('yayra:webview-ensure')(null, { tabId: 'tab-1', url: 'https://example.com/' });
  const wc = views[0].webContents;
  wc._backStack.push('https://example.com/');

  wc.emit('did-navigate', {}, 'https://example.com/page-2');
  const navigated = sentEvents.find((e) => e.payload.type === 'navigated');
  assert.ok(navigated);
  assert.equal(navigated.payload.url, 'https://example.com/page-2');
  assert.equal(navigated.payload.canGoBack, true);
});

test('webview bridge: destroying a tab removes its view from the window and releases it', async () => {
  const { handlers, fakeWin, views } = makeHarness();
  await handlers.get('yayra:webview-ensure')(null, { tabId: 'tab-1', url: 'https://example.com/' });
  assert.equal(fakeWin.contentView.children.length, 1);

  await handlers.get('yayra:webview-destroy')(null, { tabId: 'tab-1' });
  assert.equal(fakeWin.contentView.children.length, 0);
  assert.equal(views[0].webContents.isDestroyed(), true);
});

test('webview bridge: setBounds and setVisible(false) manipulate the native view without destroying it', async () => {
  const { handlers, views } = makeHarness();
  await handlers.get('yayra:webview-ensure')(null, { tabId: 'tab-1', url: 'https://example.com/' });

  await handlers.get('yayra:webview-set-bounds')(null, { tabId: 'tab-1', bounds: { x: 10, y: 20, width: 800, height: 600 } });
  assert.deepEqual(views[0].bounds, { x: 10, y: 20, width: 800, height: 600 });

  await handlers.get('yayra:webview-set-visible')(null, { tabId: 'tab-1', visible: false });
  assert.deepEqual(views[0].bounds, { x: 0, y: 0, width: 0, height: 0 }, 'hidden by zeroing bounds, not by destroying the guest page');
  assert.equal(views[0].webContents.isDestroyed(), false);
});

// --- Chrome-equivalent native right-click context menu ------------------

function findItem(template, label) {
  return template.find((item) => item.label === label);
}

test('buildContextMenuTemplate: plain page click offers Back/Forward/Reload/Inspect, Chrome-style', () => {
  const wc = { canGoBack: () => true, canGoForward: () => false, goBack: () => {}, goForward: () => {}, reload: () => {}, inspectElement: () => {} };
  const template = buildContextMenuTemplate({ params: { x: 5, y: 9 }, wc, tabId: 't1', send: () => {}, clipboard: { writeText: () => {} } });
  assert.ok(findItem(template, 'Back').enabled);
  assert.equal(findItem(template, 'Forward').enabled, false);
  assert.ok(findItem(template, 'Reload'));
  assert.ok(findItem(template, 'Inspect'));
});

test('buildContextMenuTemplate: prefers webContents.navigationHistory over the deprecated legacy methods (Electron 32+)', () => {
  const calls = [];
  const wc = {
    // navigationHistory (modern API) says back IS possible...
    navigationHistory: {
      canGoBack: () => true,
      canGoForward: () => true,
      goBack: () => calls.push('history.goBack'),
      goForward: () => calls.push('history.goForward')
    },
    // ...while the deprecated legacy methods disagree and must NOT be consulted.
    canGoBack: () => { throw new Error('legacy canGoBack must not be called when navigationHistory exists'); },
    canGoForward: () => { throw new Error('legacy canGoForward must not be called when navigationHistory exists'); },
    goBack: () => calls.push('legacy.goBack'),
    goForward: () => calls.push('legacy.goForward'),
    reload: () => {},
    inspectElement: () => {}
  };
  const template = buildContextMenuTemplate({ params: { x: 1, y: 1 }, wc, tabId: 't1', send: () => {}, clipboard: { writeText: () => {} } });
  assert.equal(findItem(template, 'Back').enabled, true);
  assert.equal(findItem(template, 'Forward').enabled, true);
  findItem(template, 'Back').click();
  findItem(template, 'Forward').click();
  assert.deepEqual(calls, ['history.goBack', 'history.goForward']);
});

test('buildContextMenuTemplate: right-clicking a link offers Open Link in New Tab + Copy Link Address', () => {
  const written = [];
  const wc = { canGoBack: () => false, canGoForward: () => false, inspectElement: () => {} };
  const sent = [];
  const template = buildContextMenuTemplate({
    params: { linkURL: 'https://example.com/page' },
    wc,
    tabId: 'tab-1',
    send: (tabId, type, payload) => sent.push({ tabId, type, payload }),
    clipboard: { writeText: (text) => written.push(text) }
  });
  findItem(template, 'Open Link in New Tab').click();
  assert.deepEqual(sent[0], { tabId: 'tab-1', type: 'new-window-request', payload: { url: 'https://example.com/page' } });
  findItem(template, 'Copy Link Address').click();
  assert.deepEqual(written, ['https://example.com/page']);
});

test('buildContextMenuTemplate: right-clicking an image offers Open/Save/Copy Image actions', () => {
  const downloaded = [];
  const written = [];
  const wc = { canGoBack: () => false, canGoForward: () => false, inspectElement: () => {}, downloadURL: (url) => downloaded.push(url) };
  const template = buildContextMenuTemplate({
    params: { mediaType: 'image', srcURL: 'https://example.com/cat.png' },
    wc,
    tabId: 'tab-1',
    send: () => {},
    clipboard: { writeText: (text) => written.push(text) }
  });
  assert.ok(findItem(template, 'Open Image in New Tab'));
  findItem(template, 'Save Image As\u2026').click();
  assert.deepEqual(downloaded, ['https://example.com/cat.png']);
  findItem(template, 'Copy Image Address').click();
  assert.deepEqual(written, ['https://example.com/cat.png']);
});

test('buildContextMenuTemplate: selected text offers Copy + Search Google for "..."', () => {
  const sent = [];
  const wc = { canGoBack: () => false, canGoForward: () => false, inspectElement: () => {}, copy: () => {} };
  const template = buildContextMenuTemplate({
    params: { selectionText: 'hello world' },
    wc,
    tabId: 'tab-1',
    send: (tabId, type, payload) => sent.push(payload),
    clipboard: { writeText: () => {} }
  });
  assert.ok(findItem(template, 'Copy'));
  findItem(template, 'Search Google for "hello world"').click();
  assert.match(sent[0].url, /google\.com\/search\?q=hello%20world/);
});

test('buildContextMenuTemplate: selected text also offers Ask Yayra AI about "..." (Chrome-style AI option)', () => {
  const sent = [];
  const wc = { canGoBack: () => false, canGoForward: () => false, inspectElement: () => {}, copy: () => {} };
  const template = buildContextMenuTemplate({
    params: { selectionText: 'hello world' },
    wc,
    tabId: 'tab-1',
    send: (tabId, type, payload) => sent.push({ type, payload }),
    clipboard: { writeText: () => {} }
  });
  const aiItem = findItem(template, 'Ask Yayra AI about "hello world"');
  assert.ok(aiItem, 'AI item present on selections');
  aiItem.click();
  assert.equal(sent[0].type, 'new-window-request');
  assert.equal(sent[0].payload.url, 'yayra://ai?q=hello%20world', 'selection handed to the AI page, which auto-asks it');
});

test('buildContextMenuTemplate: every right-click offers a general Ask Yayra AI entry', () => {
  const sent = [];
  const wc = { canGoBack: () => false, canGoForward: () => false, inspectElement: () => {} };
  const template = buildContextMenuTemplate({
    params: { x: 1, y: 1 },
    wc,
    tabId: 't1',
    send: (tabId, type, payload) => sent.push(payload),
    clipboard: { writeText: () => {} }
  });
  const aiItem = findItem(template, 'Ask Yayra AI');
  assert.ok(aiItem, 'AI entry present even with nothing selected');
  aiItem.click();
  assert.equal(sent[0].url, 'yayra://ai', 'opens the in-browser AI chat page');
});

test('buildContextMenuTemplate: editable fields offer Cut/Copy/Paste/Undo/Redo/Select All honoring editFlags', () => {
  const wc = { canGoBack: () => false, canGoForward: () => false, inspectElement: () => {} };
  const template = buildContextMenuTemplate({
    params: { isEditable: true, editFlags: { canUndo: true, canRedo: false, canCut: true, canCopy: true, canPaste: false, canSelectAll: true } },
    wc,
    tabId: 'tab-1',
    send: () => {},
    clipboard: { writeText: () => {} }
  });
  assert.equal(findItem(template, 'Undo').enabled, true);
  assert.equal(findItem(template, 'Redo').enabled, false);
  assert.equal(findItem(template, 'Paste').enabled, false);
  assert.equal(findItem(template, 'Select All').enabled, true);
});

test('webview bridge: right-clicking inside an embedded page pops a native Chrome-style menu', async () => {
  const { handlers, views, popupCalls, fakeWin } = makeHarness();
  await handlers.get('yayra:webview-ensure')(null, { tabId: 'tab-1', url: 'https://example.com/' });
  const wc = views[0].webContents;

  wc._simulateContextMenu({ x: 10, y: 20 });
  assert.equal(popupCalls.length, 1, 'a native menu is shown on context-menu');
  assert.equal(popupCalls[0].opts.window, fakeWin);
  assert.ok(popupCalls[0].template.some((item) => item.label === 'Reload'));
});

test('webview bridge: right-click does nothing (never throws) when no Menu implementation is injected', async () => {
  const handlers = new Map();
  const ipcMain = { handle: (channel, fn) => handlers.set(channel, fn) };
  const fakeWin = { destroyed: false, isDestroyed() { return this.destroyed; }, webContents: { send: () => {} }, contentView: { children: [], addChildView(v) { this.children.push(v); }, removeChildView() {} } };
  const views = [];
  const WebContentsView = function FakeWebContentsView() {
    const view = createFakeWebContentsView();
    views.push(view);
    return view;
  };
  createWebviewBridge({ WebContentsView, ipcMain, shell: { openExternal: async () => {} }, getMainWindow: () => fakeWin, logger: { error: () => {} } });

  await handlers.get('yayra:webview-ensure')(null, { tabId: 'tab-1', url: 'https://example.com/' });
  assert.doesNotThrow(() => views[0].webContents._simulateContextMenu({ x: 1, y: 1 }));
});

/* -----------------------------------------------------------------
 * Multi-window support: the floating "yayra mini" window runs its own
 * BrowserShell whose generated tab ids ("tab-1", ...) collide with the
 * main window's. The bridge must namespace views per calling webContents
 * and attach each view to the WINDOW that asked for it.
 * ----------------------------------------------------------------- */

function makeWindowFake() {
  return {
    destroyed: false,
    isDestroyed() { return this.destroyed; },
    webContents: null, // assigned below
    contentView: {
      children: [],
      addChildView(view) { this.children.push(view); },
      removeChildView(view) { this.children = this.children.filter((v) => v !== view); }
    }
  };
}

function makeSenderFake(id, sink) {
  return {
    id,
    isDestroyed: () => false,
    send: (channel, payload) => sink.push({ channel, payload })
  };
}

function makeMultiWindowHarness() {
  const handlers = new Map();
  const ipcMain = { handle: (channel, fn) => handlers.set(channel, fn) };
  const mainEvents = [];
  const miniEvents = [];
  const mainWin = makeWindowFake();
  const miniWin = makeWindowFake();
  mainWin.webContents = makeSenderFake(1, mainEvents);
  miniWin.webContents = makeSenderFake(2, miniEvents);
  const views = [];
  const WebContentsView = function FakeWebContentsView() {
    const view = createFakeWebContentsView();
    views.push(view);
    return view;
  };
  const bridge = createWebviewBridge({
    WebContentsView,
    ipcMain,
    shell: { openExternal: async () => {} },
    getMainWindow: () => mainWin,
    getWindowForWebContents: (wc) => (wc === mainWin.webContents ? mainWin : wc === miniWin.webContents ? miniWin : null),
    logger: { error: () => {} }
  });
  return { bridge, handlers, views, mainWin, miniWin, mainEvents, miniEvents };
}

test('webview bridge: the SAME tabId from two different windows creates two independent views, each attached to its own window', async () => {
  const { handlers, views, mainWin, miniWin } = makeMultiWindowHarness();
  const ensure = handlers.get('yayra:webview-ensure');

  await ensure({ sender: mainWin.webContents }, { tabId: 'tab-1', url: 'https://example.com/a' });
  await ensure({ sender: miniWin.webContents }, { tabId: 'tab-1', url: 'https://example.com/b' });

  assert.equal(views.length, 2, 'no collision: each window got its own native view');
  assert.equal(mainWin.contentView.children.length, 1, 'main window owns exactly its own view');
  assert.equal(miniWin.contentView.children.length, 1, 'mini window owns exactly its own view');
});

test('webview bridge: navigation events go back to the window that owns the view, not always the main window', async () => {
  const { handlers, views, miniWin, mainEvents, miniEvents } = makeMultiWindowHarness();
  await handlers.get('yayra:webview-ensure')({ sender: miniWin.webContents }, { tabId: 'tab-1', url: 'https://example.com/' });

  views[0].webContents.emit('did-navigate', {}, 'https://example.com/next');
  assert.equal(mainEvents.length, 0, 'main window hears nothing about the mini window tab');
  assert.equal(miniEvents.length, 1);
  assert.equal(miniEvents[0].payload.type, 'navigated');
  assert.equal(miniEvents[0].payload.tabId, 'tab-1', 'renderer-facing tabId is NOT namespaced');
});

test('webview bridge: destroyForWebContents tears down only that window\'s views', async () => {
  const { bridge, handlers, mainWin, miniWin } = makeMultiWindowHarness();
  const ensure = handlers.get('yayra:webview-ensure');
  await ensure({ sender: mainWin.webContents }, { tabId: 'tab-1', url: 'https://example.com/a' });
  await ensure({ sender: miniWin.webContents }, { tabId: 'tab-1', url: 'https://example.com/b' });

  bridge.destroyForWebContents(mainWin.webContents);
  assert.equal(mainWin.contentView.children.length, 0, 'main window views destroyed');
  assert.equal(miniWin.contentView.children.length, 1, 'mini window views untouched');
});

/* -----------------------------------------------------------------
 * Overlay-aware hiding: when the renderer hides the active view so its
 * own chrome (menu drawer, modals, mini window) can appear above the
 * page, it asks for a snapshot captured BEFORE the view is zeroed out.
 * ----------------------------------------------------------------- */

test('webview bridge: set-visible(false, capture) returns a page snapshot and then zeroes the bounds', async () => {
  const { handlers, views } = makeHarness();
  await handlers.get('yayra:webview-ensure')(null, { tabId: 'tab-1', url: 'https://example.com/' });
  await handlers.get('yayra:webview-set-bounds')(null, { tabId: 'tab-1', bounds: { x: 0, y: 80, width: 800, height: 600 } });

  const order = [];
  views[0].webContents.capturePage = async () => {
    order.push('capture');
    return { isEmpty: () => false, toDataURL: () => 'data:image/png;base64,SNAP' };
  };
  const originalSetBounds = views[0].setBounds.bind(views[0]);
  views[0].setBounds = (b) => { order.push('bounds'); originalSetBounds(b); };

  const result = await handlers.get('yayra:webview-set-visible')(null, { tabId: 'tab-1', visible: false, capture: true });
  assert.deepEqual(order, ['capture', 'bounds'], 'snapshot is taken BEFORE the view is hidden');
  assert.equal(result.snapshot, 'data:image/png;base64,SNAP');
  assert.deepEqual(views[0].bounds, { x: 0, y: 0, width: 0, height: 0 });
});

test('webview bridge: set-visible(false) without capture, or with a failing capturePage, still hides and never throws', async () => {
  const { handlers, views } = makeHarness();
  await handlers.get('yayra:webview-ensure')(null, { tabId: 'tab-1', url: 'https://example.com/' });

  const plain = await handlers.get('yayra:webview-set-visible')(null, { tabId: 'tab-1', visible: false });
  assert.equal(plain, undefined);
  assert.deepEqual(views[0].bounds, { x: 0, y: 0, width: 0, height: 0 });

  views[0].webContents.capturePage = async () => { throw new Error('gpu context lost'); };
  const failed = await handlers.get('yayra:webview-set-visible')(null, { tabId: 'tab-1', visible: false, capture: true });
  assert.equal(failed, undefined, 'capture failure degrades to a plain hide');
  assert.deepEqual(views[0].bounds, { x: 0, y: 0, width: 0, height: 0 });
});

/* -----------------------------------------------------------------
 * Chrome-style password capture / autofill routing
 * ----------------------------------------------------------------- */

test('autofill: page views get the sandboxed autofill preload when configured', async () => {
  const { handlers, views } = makeHarness({ autofillPreloadPath: '/fake/autofillPreload.cjs' });
  await handlers.get('yayra:webview-ensure')(null, { tabId: 'tab-af', url: 'https://site.dev/' });
  const prefs = views[0].__options.webPreferences;
  assert.equal(prefs.preload, '/fake/autofillPreload.cjs');
  assert.equal(prefs.sandbox, true, 'preload must not weaken the sandbox');
  assert.equal(prefs.contextIsolation, true);
  assert.equal(prefs.nodeIntegration, false);
});

test('autofill: captured login from a page view routes to the owning shell window', async () => {
  const { handlers, listeners, sentEvents, views } = makeHarness({ autofillPreloadPath: '/fake/p.cjs' });
  await handlers.get('yayra:webview-ensure')(null, { tabId: 'tab-cap', url: 'https://site.dev/login' });

  const viewWc = views[0].webContents;
  listeners.get('yayra:autofill-captured')({ sender: viewWc }, {
    url: 'https://site.dev/login', username: 'ada', password: 'pw-1'
  });

  const evt = sentEvents.find((e) => e.payload && e.payload.type === 'autofill-captured');
  assert.ok(evt, 'capture must be forwarded to the shell renderer');
  assert.equal(evt.payload.tabId, 'tab-cap', 'un-namespaced tabId for the renderer');
  assert.equal(evt.payload.username, 'ada');
  assert.equal(evt.payload.password, 'pw-1');
});

test('autofill: private (incognito) views NEVER forward captured credentials', async () => {
  const { handlers, listeners, sentEvents, views } = makeHarness({ autofillPreloadPath: '/fake/p.cjs' });
  await handlers.get('yayra:webview-ensure')(null, { tabId: 'tab-priv', url: 'https://site.dev/', isPrivate: true });

  listeners.get('yayra:autofill-captured')({ sender: views[0].webContents }, {
    url: 'https://site.dev/login', username: 'ada', password: 'pw-1'
  });
  assert.equal(sentEvents.filter((e) => e.payload && e.payload.type === 'autofill-captured').length, 0);
});

test('autofill: fill-credentials pushes saved credentials into the right page view (never private ones)', async () => {
  const { handlers, views } = makeHarness({ autofillPreloadPath: '/fake/p.cjs' });
  await handlers.get('yayra:webview-ensure')(null, { tabId: 'tab-fill', url: 'https://site.dev/' });
  await handlers.get('yayra:webview-ensure')(null, { tabId: 'tab-p', url: 'https://other.dev/', isPrivate: true });

  const result = await handlers.get('yayra:webview-fill-credentials')(null, {
    tabId: 'tab-fill', username: 'ada', password: 'pw-9'
  });
  assert.equal(result.filled, true);
  const pushed = views[0].webContents.sent.find((m) => m.channel === 'yayra:autofill-fill');
  assert.ok(pushed, 'credentials pushed to the page preload');
  assert.equal(pushed.payload.password, 'pw-9');

  const privResult = await handlers.get('yayra:webview-fill-credentials')(null, {
    tabId: 'tab-p', username: 'ada', password: 'pw-9'
  });
  assert.equal(privResult.filled, false, 'private views are never autofilled');
  assert.equal(views[1].webContents.sent.filter((m) => m.channel === 'yayra:autofill-fill').length, 0);
});

test('email recall: focused and submitted addresses route only from non-private page views', async () => {
  const { handlers, listeners, sentEvents, views } = makeHarness({ autofillPreloadPath: '/fake/p.cjs' });
  await handlers.get('yayra:webview-ensure')(null, { tabId: 'tab-email', url: 'https://site.dev/login' });
  await handlers.get('yayra:webview-ensure')(null, { tabId: 'tab-email-private', url: 'https://site.dev/login', isPrivate: true });

  listeners.get('yayra:email-field-focused')({ sender: views[0].webContents }, { url: 'https://site.dev/login' });
  listeners.get('yayra:email-address-captured')({ sender: views[0].webContents }, {
    url: 'https://site.dev/login', email: 'ada@example.com'
  });
  listeners.get('yayra:email-address-captured')({ sender: views[0].webContents }, {
    url: 'https://site.dev/login', email: 'not-an-email'
  });
  listeners.get('yayra:email-field-focused')({ sender: views[1].webContents }, { url: 'https://site.dev/login' });
  listeners.get('yayra:email-address-captured')({ sender: views[1].webContents }, {
    url: 'https://site.dev/login', email: 'private@example.com'
  });

  const routed = sentEvents.map((event) => event.payload).filter((payload) => payload?.type?.startsWith('email-'));
  assert.equal(routed.length, 2, 'one focus event and one valid captured address are forwarded');
  assert.equal(routed[0].type, 'email-field-focused');
  assert.equal(routed[1].type, 'email-address-captured');
  assert.equal(routed[1].email, 'ada@example.com');
  assert.ok(routed.every((payload) => payload.tabId === 'tab-email'));
});

test('email recall: suggestions are sanitized, deduplicated, and never sent to a private view', async () => {
  const { handlers, views } = makeHarness({ autofillPreloadPath: '/fake/p.cjs' });
  await handlers.get('yayra:webview-ensure')(null, { tabId: 'tab-suggest', url: 'https://site.dev/' });
  await handlers.get('yayra:webview-ensure')(null, { tabId: 'tab-suggest-private', url: 'https://site.dev/', isPrivate: true });

  const safe = await handlers.get('yayra:webview-suggest-email-addresses')(null, {
    tabId: 'tab-suggest', emails: ['Ada@example.com', 'ada@EXAMPLE.com', 'invalid', 'lin@example.org']
  });
  assert.deepEqual(safe, { suggested: true, count: 2 });
  const pushed = views[0].webContents.sent.find((message) => message.channel === 'yayra:email-suggestions');
  assert.deepEqual(pushed.payload.emails, ['Ada@example.com', 'lin@example.org']);

  const privateResult = await handlers.get('yayra:webview-suggest-email-addresses')(null, {
    tabId: 'tab-suggest-private', emails: ['ada@example.com']
  });
  assert.deepEqual(privateResult, { suggested: false, count: 0 });
  assert.equal(views[1].webContents.sent.length, 0, 'no address is sent into an Incognito page');
});
