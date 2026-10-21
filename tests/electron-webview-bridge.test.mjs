import test from 'node:test';
import assert from 'node:assert/strict';
import { runInNewContext } from 'node:vm';
import {
  requiresSystemBrowserAuth,
  secureSystemBrowserAuthUrl,
  sanitizeBounds,
  buildBrowserUserAgent,
  buildContextMenuTemplate,
  buildPointerThemeCss,
  buildPointerThemeScript,
  buildPointerTextCursorScript,
  buildTextSelectionActionsScript,
  createWebviewBridge,
  WEBVIEW_EVENT_CHANNEL
} from '../electron/webviewBridge.cjs';

// --- Pure helper logic -------------------------------------------------

test('requiresSystemBrowserAuth: hands off Google OAuth and interactive sign-in endpoints while preserving other providers', () => {
  assert.equal(requiresSystemBrowserAuth('https://accounts.google.com/o/oauth2/v2/auth?client_id=x'), true);
  assert.equal(requiresSystemBrowserAuth('https://accounts.google.com/oauth2/v2/auth?client_id=x'), true);
  assert.equal(requiresSystemBrowserAuth('https://accounts.google.com/signin/oauth?client_id=x'), true);
  assert.equal(requiresSystemBrowserAuth('https://accounts.google.com/gsi/select?client_id=x'), true);
  assert.equal(requiresSystemBrowserAuth('https://accounts.google.com/signin/v2/identifier'), true);
  assert.equal(requiresSystemBrowserAuth('https://accounts.google.com/v3/signin/challenge/pwd'), true);
  assert.equal(requiresSystemBrowserAuth('https://accounts.google.com/ServiceLogin'), true);
  assert.equal(requiresSystemBrowserAuth('https://appleid.apple.com/auth/authorize'), true);
  assert.equal(requiresSystemBrowserAuth('https://login.live.com/'), true);
  assert.equal(requiresSystemBrowserAuth('https://sub.login.microsoftonline.com/'), true);
});

test('requiresSystemBrowserAuth: ordinary Google browsing/account pages stay in Yayra', () => {
  assert.equal(requiresSystemBrowserAuth('https://www.google.com/search?q=ghana'), false);
  assert.equal(requiresSystemBrowserAuth('https://mail.google.com/mail/u/0/'), false);
  assert.equal(requiresSystemBrowserAuth('https://accounts.google.com/'), false);
  assert.equal(requiresSystemBrowserAuth('https://accounts.google.com/ManageAccount'), false);
  assert.equal(requiresSystemBrowserAuth('https://accounts.google.com/Logout'), false);
  assert.equal(requiresSystemBrowserAuth('https://accounts.google.com/signin'), false, 'a broad signin prefix is not enough');
  assert.equal(requiresSystemBrowserAuth('https://myaccount.google.com/security'), false);
  assert.equal(requiresSystemBrowserAuth('https://accounts.google.com.evil.example/signin'), false);
  assert.equal(requiresSystemBrowserAuth('https://www.youtube.com/'), false);
  assert.equal(requiresSystemBrowserAuth('not a url'), false);
});

test('secureSystemBrowserAuthUrl: upgrades exact auth routes and repairs Google embedded-browser rejection URLs', () => {
  const httpOAuthUrl = 'http://accounts.google.com/o/oauth2/v2/auth?client_id=x';
  assert.equal(requiresSystemBrowserAuth(httpOAuthUrl), true);
  assert.equal(secureSystemBrowserAuthUrl(httpOAuthUrl), 'https://accounts.google.com/o/oauth2/v2/auth?client_id=x');
  assert.equal(secureSystemBrowserAuthUrl('http://login.live.com/'), 'https://login.live.com/');
  assert.equal(secureSystemBrowserAuthUrl('https://accounts.google.com/o/oauth2/v2/auth'), 'https://accounts.google.com/o/oauth2/v2/auth');
  assert.equal(requiresSystemBrowserAuth('http://accounts.google.com/signin'), false);
  assert.equal(secureSystemBrowserAuthUrl('http://accounts.google.com/signin'), 'http://accounts.google.com/signin', 'broad lookalikes are not rewritten');
  assert.equal(secureSystemBrowserAuthUrl('http://www.google.com/search?q=ghana'), 'http://www.google.com/search?q=ghana');
  const rejected = new URL('https://accounts.google.com/v3/signin/rejected');
  rejected.searchParams.set('continue', 'https://mail.google.com/mail/u/0/#inbox');
  rejected.searchParams.set('hl', 'en-GB');
  const repaired = new URL(secureSystemBrowserAuthUrl(rejected.toString()));
  assert.equal(repaired.pathname, '/ServiceLogin');
  assert.equal(repaired.searchParams.get('continue'), 'https://mail.google.com/mail/u/0/');
  assert.equal(repaired.searchParams.get('hl'), 'en-GB');
  const unsafe = new URL('https://accounts.google.com/v3/signin/rejected');
  unsafe.searchParams.set('continue', 'javascript:alert(1)');
  assert.equal(secureSystemBrowserAuthUrl(unsafe.toString()), 'https://accounts.google.com/ServiceLogin');
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
  assert.match(css, /\[data-yayra-selectable-text="true"\][\s\S]*cursor: text !important[\s\S]*user-select: text !important/, 'hit-tested site text gets a native I-beam and stays selectable');
  assert.match(buildPointerThemeCss('high-visibility', 'xlarge'), /%23ffd400/, 'high-visibility keeps its yellow outline');
  assert.match(buildPointerThemeScript('system'), /yayra-custom-pointer-theme/, 'System removes any injected cursor stylesheet');
  const textCursorScript = buildPointerTextCursorScript('yayra');
  assert.match(textCursorScript, /caretRangeFromPoint|caretPositionFromPoint/, 'cursor selection follows actual text hit-testing');
  assert.match(textCursorScript, /pointermove/);
  assert.match(textCursorScript, /POINTER_TEXT_CURSOR|data-yayra-selectable-text/);
  assert.match(textCursorScript, /interactiveSelector/, 'links and controls keep their hand cursor');
  assert.match(buildPointerTextCursorScript('system'), /__yayraSelectableTextCursorState/, 'System removes the text-cursor listener');
});

test('native selection actions are page-local, bounded, editable-aware, and non-modal', () => {
  const script = buildTextSelectionActionsScript();
  assert.doesNotThrow(() => runInNewContext(`new Function(${JSON.stringify(script)})`), 'the injected source parses as JavaScript');
  assert.match(script, /Text selection actions/);
  for (const action of ["'Copy'", "'Cut'", "'Paste'", "'Search'", "'Ask Yayra AI'"]) {
    assert.ok(script.includes(action), `${action} is offered from highlighted text`);
  }
  assert.match(script, /pointerdown[\s\S]*hide\(true\)/, 'an outside press closes the toolbar without a modal scrim');
  assert.match(script, /event\.preventDefault\(\); event\.stopPropagation\(\)/, 'toolbar presses preserve the underlying selection');
  assert.match(script, /\['password','hidden'/, 'password and non-text fields are never read into the toolbar');
  assert.match(script, /MAX_COPY = 100000/);
  assert.match(script, /MAX_QUERY = 2000/);
  assert.match(script, /navigator\.clipboard[\s\S]*document\.execCommand|document\.execCommand[\s\S]*navigator\.clipboard/, 'copy has native and async clipboard paths');
  assert.match(script, /window\.open\(url, '_blank', 'noopener,noreferrer'\)/, 'explicit Search/AI actions use the existing safe new-tab route');
  assert.doesNotMatch(script, /ipcRenderer|sendTo\(/, 'selected text never crosses Electron IPC');
});

test('custom text cursor uses caret hit-testing, excludes controls, and cleans up scheduled work', () => {
  const documentListeners = new Map();
  const windowListeners = new Map();
  const frames = new Map();
  let nextFrame = 1;
  let hitNode = null;
  const textBounds = { left: 0, top: 0, right: 100, bottom: 20 };
  const document = {
    addEventListener(type, listener) {
      const listeners = documentListeners.get(type) || new Set();
      listeners.add(listener);
      documentListeners.set(type, listeners);
    },
    removeEventListener(type, listener) { documentListeners.get(type)?.delete(listener); },
    caretRangeFromPoint() { return hitNode ? { startContainer: hitNode } : null; },
    createRange() {
      return {
        selectNodeContents() {},
        getClientRects() { return [textBounds]; },
        setStart(node) { this.startContainer = node; },
        collapse() {}
      };
    }
  };
  const window = {
    addEventListener(type, listener) {
      const listeners = windowListeners.get(type) || new Set();
      listeners.add(listener);
      windowListeners.set(type, listeners);
    },
    removeEventListener(type, listener) { windowListeners.get(type)?.delete(listener); },
    requestAnimationFrame(callback) {
      const id = nextFrame++;
      frames.set(id, callback);
      return id;
    },
    cancelAnimationFrame(id) { frames.delete(id); }
  };
  const makeElement = ({ interactive = false, shadowHost = null } = {}) => {
    const attributes = new Map();
    return {
      nodeType: 1,
      parentElement: null,
      attributes,
      closest() { return interactive ? this : null; },
      getRootNode() { return shadowHost ? { host: shadowHost } : document; },
      setAttribute(name, value) { attributes.set(name, value); },
      removeAttribute(name) { attributes.delete(name); },
      getAttribute(name) { return attributes.get(name) ?? null; }
    };
  };
  const makeTextNode = (parentElement) => ({ nodeType: 3, nodeValue: 'selectable page text', parentElement });
  const dispatch = (listeners, type, event) => {
    for (const listener of [...(listeners.get(type) || [])]) listener({ type, ...event });
  };
  const flushFrame = () => {
    const [id, callback] = frames.entries().next().value || [];
    if (callback) {
      frames.delete(id);
      callback();
    }
  };

  runInNewContext(buildPointerTextCursorScript('yayra'), { window, document, setTimeout, clearTimeout });
  const paragraph = makeElement();
  const paragraphText = makeTextNode(paragraph);
  hitNode = paragraphText;
  dispatch(documentListeners, 'pointermove', { pointerType: 'mouse', target: paragraph, clientX: 25, clientY: 10 });
  assert.equal(paragraph.getAttribute('data-yayra-selectable-text'), null, 'hover updates are frame-batched');
  flushFrame();
  assert.equal(paragraph.getAttribute('data-yayra-selectable-text'), 'true', 'a caret hit over actual text marks its element');

  const buttonHost = makeElement({ interactive: true });
  const shadowText = makeElement({ shadowHost: buttonHost });
  hitNode = makeTextNode(shadowText);
  dispatch(documentListeners, 'pointerdown', { pointerType: 'mouse', target: shadowText, clientX: 25, clientY: 10 });
  assert.equal(buttonHost.getAttribute('data-yayra-selectable-text'), null, 'interactive custom-element hosts are excluded across shadow boundaries');
  assert.equal(paragraph.getAttribute('data-yayra-selectable-text'), null, 'moving into a control clears the previous I-beam marker');

  const secondParagraph = makeElement();
  hitNode = makeTextNode(secondParagraph);
  dispatch(documentListeners, 'pointerdown', { pointerType: 'mouse', target: secondParagraph, clientX: 25, clientY: 10 });
  assert.equal(secondParagraph.getAttribute('data-yayra-selectable-text'), 'true', 'pointerdown marks text synchronously before native drag selection begins');

  const touchParagraph = makeElement();
  hitNode = makeTextNode(touchParagraph);
  dispatch(documentListeners, 'pointerdown', { pointerType: 'touch', target: touchParagraph, clientX: 25, clientY: 10 });
  assert.equal(touchParagraph.getAttribute('data-yayra-selectable-text'), 'true', 'touch pointerdown enables native long-press selection too');

  const cleanup = window.__yayraSelectableTextCursorState.cleanup;
  dispatch(documentListeners, 'pointermove', { pointerType: 'mouse', target: secondParagraph, clientX: 25, clientY: 10 });
  assert.equal(frames.size, 1, 'a hover update is pending');
  cleanup();
  assert.equal(frames.size, 0, 'cleanup cancels any pending animation frame');
  assert.equal(secondParagraph.getAttribute('data-yayra-selectable-text'), null, 'cleanup removes the text marker');
  assert.equal([...documentListeners.values()].reduce((count, listeners) => count + listeners.size, 0), 0, 'cleanup removes document listeners');
  assert.equal([...windowListeners.values()].reduce((count, listeners) => count + listeners.size, 0), 0, 'cleanup removes window listeners');
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
  let currentUrl = '';
  const calls = [];
  return {
    loadURL: async (url) => { currentUrl = String(url || ''); },
    getURL: () => currentUrl,
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
    setBackgroundThrottling: (enabled) => calls.push(['setBackgroundThrottling', enabled]),
    getOSProcessId: () => 4242,
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
  return {
    webContents,
    bounds: null,
    setBounds(b) { this.bounds = b; }
  };
}

function makeHarness({ authHosts, autofillPreloadPath, pageUnresponsiveReloadDelayMs, pageUnresponsiveReloadCooldownMs, webauthnSession, Dialog, openExternalImpl } = {}) {
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
  const shell = {
    openExternal: async (url) => {
      externalCalls.push(url);
      if (openExternalImpl) return openExternalImpl(url);
    }
  };
  const views = [];
  const WebContentsView = function FakeWebContentsView(opts) {
    const view = createFakeWebContentsView();
    view.__options = opts || null;
    if (webauthnSession) view.webContents.session = webauthnSession;
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
    dialog: Dialog,
    clipboard,
    getMainWindow: () => fakeWin,
    authHosts,
    autofillPreloadPath,
    pageUnresponsiveReloadDelayMs,
    pageUnresponsiveReloadCooldownMs,
    logger: { error: () => {}, warn: () => {} }
  });

  return {
    bridge, handlers, listeners, sentEvents, fakeWin, externalCalls, views,
    clipboardWrites, popupCalls
  };
}

test('webview bridge: creating a tab adds a WebContentsView as a child view and loads the URL', async () => {
  const { handlers, fakeWin, views } = makeHarness();
  await handlers.get('yayra:webview-ensure')(null, { tabId: 'tab-1', url: 'https://www.google.com/' });

  assert.equal(views.length, 1, 'exactly one native view created');
  assert.equal(fakeWin.contentView.children.length, 1, 'view attached to the window content view (not an <iframe>)');
});

test('webview bridge: superseded ERR_ABORTED navigation is silent but a final ERR_FAILED remains visible', async () => {
  const { handlers, views, sentEvents } = makeHarness();
  await handlers.get('yayra:webview-ensure')(null, { tabId: 'tab-errors', url: 'https://example.com/' });
  const webContents = views[0].webContents;
  webContents.emit('did-fail-load', {}, -3, 'net::ERR_ABORTED (-3)', 'https://example.com/old', true);
  assert.equal(sentEvents.some((event) => event.payload.type === 'fail-load'), false, 'superseded navigation does not reach the shell as an error');

  webContents.emit('did-fail-load', {}, -2, 'net::ERR_FAILED (-2)', 'https://example.com/final', true);
  assert.ok(sentEvents.some((event) => event.payload.type === 'fail-load' && event.payload.errorCode === -2), 'a genuine active failure is still surfaced');
  webContents.emit('did-fail-load', {}, -2, 'net::ERR_FAILED (-2)', 'https://example.com/iframe', false);
  assert.equal(sentEvents.filter((event) => event.payload.type === 'fail-load').length, 1, 'subframe errors are not misreported as top-level navigation failures');
});

test('webview bridge: positive main-frame completion is distinct from loading-stop for recovery', async () => {
  const { handlers, views, sentEvents } = makeHarness();
  await handlers.get('yayra:webview-ensure')(null, { tabId: 'tab-recovered', url: 'https://example.com/recovered' });
  const webContents = views[0].webContents;
  webContents.getURL = () => 'https://example.com/recovered';
  webContents.emit('did-start-loading');
  webContents.emit('did-finish-load');
  const success = sentEvents.find((event) => event.payload.type === 'load-succeeded');
  assert.ok(success, 'the renderer receives an unambiguous success event');
  assert.equal(success.payload.url, 'https://example.com/recovered');

  const beforeFailure = sentEvents.filter((event) => event.payload.type === 'load-succeeded').length;
  webContents.emit('did-start-loading');
  webContents.emit('did-fail-load', {}, -106, 'net::ERR_INTERNET_DISCONNECTED', 'https://example.com/offline', true);
  webContents.emit('did-finish-load'); // Chromium's own error document can still finish
  assert.equal(sentEvents.filter((event) => event.payload.type === 'load-succeeded').length, beforeFailure,
    'an Electron error document can never masquerade as successful recovery');
});

test('webview bridge: recovery explicitly loads the retained failed URL instead of guessing with reload()', async () => {
  const { handlers, views } = makeHarness();
  await handlers.get('yayra:webview-ensure')(null, { tabId: 'tab-retry-url', url: 'https://old.example/' });
  const target = 'https://offline.example/requested?q=kept';
  const result = handlers.get('yayra:webview-retry')(null, { tabId: 'tab-retry-url', url: target });
  assert.deepEqual(result, { ok: true, url: target });
  assert.equal(views[0].webContents.getURL(), target, 'loadURL receives the retained destination');
  assert.equal(views[0].webContents._calls.includes('reload'), false, 'plain reload is not used for a failed uncommitted navigation');
  assert.deepEqual(handlers.get('yayra:webview-retry')(null, { tabId: 'tab-retry-url', url: 'file:///etc/passwd' }),
    { ok: false, reason: 'invalid-target' }, 'recovery accepts only web URLs');
});

test('webview task metrics and background throttling are scoped to the requesting shell window', async () => {
  const { handlers, views } = makeHarness();
  const hostA = { id: 101, send() {}, isDestroyed: () => false };
  const hostB = { id: 202, send() {}, isDestroyed: () => false };
  const ensure = handlers.get('yayra:webview-ensure');
  await ensure({ sender: hostA }, { tabId: 'tab-1', url: 'https://a.example/' });
  assert.deepEqual(views[0].webContents._calls.at(-1), ['setBackgroundThrottling', false],
    'live-sites is the fail-open default even before a renderer preference arrives');
  const applied = await handlers.get('yayra:webview-set-background-throttling')({ sender: hostA }, { enabled: true });
  assert.deepEqual(applied, { ok: true, enabled: true, updated: 1 });
  assert.deepEqual(views[0].webContents._calls.at(-1), ['setBackgroundThrottling', true]);

  await ensure({ sender: hostA }, { tabId: 'tab-2', url: 'https://b.example/' });
  assert.deepEqual(views[1].webContents._calls.at(-1), ['setBackgroundThrottling', true], 'future tabs inherit the shell window preference');
  await ensure({ sender: hostB }, { tabId: 'tab-1', url: 'https://other.example/' });
  assert.deepEqual(views[2].webContents._calls.at(-1), ['setBackgroundThrottling', false],
    'another shell independently defaults to live sites');

  const taskTabs = await handlers.get('yayra:webview-list-task-tabs')({ sender: hostA });
  assert.equal(taskTabs.ok, true);
  assert.deepEqual(taskTabs.tabs, [{ tabId: 'tab-1', pid: 4242 }, { tabId: 'tab-2', pid: 4242 }]);
  const otherTabs = await handlers.get('yayra:webview-list-task-tabs')({ sender: hostB });
  assert.deepEqual(otherTabs.tabs, [{ tabId: 'tab-1', pid: 4242 }]);
});

test('reader extraction returns bounded article metadata and safe link-aware blocks', async () => {
  const { handlers, views } = makeHarness();
  const host = { id: 303, send() {}, isDestroyed: () => false };
  await handlers.get('yayra:webview-ensure')({ sender: host }, { tabId: 'article', url: 'https://news.example/story' });
  let script = '';
  views[0].webContents.executeJavaScript = async (source, userGesture) => {
    script = source;
    assert.equal(userGesture, true);
    return {
      title: 'A story', url: 'https://news.example/story', siteName: 'News', language: 'en',
      wordCount: 12, readingMinutes: 1,
      blocks: [{ tag: 'p', type: 'text', text: 'Read this story.', segments: [{ text: 'Read this story.', href: 'https://news.example/story' }] }]
    };
  };
  const result = await handlers.get('yayra:webview-reader-extract')({ sender: host }, { tabId: 'article' });
  assert.equal(result.ok, true);
  assert.equal(result.siteName, 'News');
  assert.equal(result.wordCount, 12);
  assert.equal(result.blocks[0].segments[0].href, 'https://news.example/story');
  assert.ok(script.includes(String.raw`text.split(/\s+/)`), 'reader word counts split on whitespace in the page context');
  assert.match(script, /resolved\.protocol === 'http:' \|\| resolved\.protocol === 'https:'/);
  assert.match(script, /blocks\.length >= 600/, 'extraction work is bounded');
});

test('webview bridge: a site renderer that stays unresponsive is reloaded once after a grace period', async () => {
  const { handlers, views, sentEvents } = makeHarness({ pageUnresponsiveReloadDelayMs: 10, pageUnresponsiveReloadCooldownMs: 100 });
  await handlers.get('yayra:webview-ensure')(null, { tabId: 'tab-hung', url: 'https://example.com/' });
  const wc = views[0].webContents;

  wc.emit('unresponsive');
  assert.ok(sentEvents.some((event) => event.payload.type === 'page-unresponsive' && event.payload.recoveryScheduled), 'shell receives the actual recovery state');
  await new Promise((resolve) => setTimeout(resolve, 25));
  assert.equal(wc._calls.filter((call) => call === 'reload').length, 1, 'only the affected page is reloaded');
  assert.ok(sentEvents.some((event) => event.payload.type === 'page-recovery-start'), 'shell is told when the bridge begins a reload attempt');

  wc.emit('responsive');
  assert.ok(sentEvents.some((event) => event.payload.type === 'page-responsive'), 'shell can announce a responsive page');
  wc.emit('unresponsive');
  await new Promise((resolve) => setTimeout(resolve, 25));
  assert.equal(wc._calls.filter((call) => call === 'reload').length, 1, 'cooldown blocks a repeated reload loop');
});

test('webview bridge: recovery timer is canceled if the site becomes responsive or a navigation starts', async (t) => {
  for (const recoveryEvent of ['responsive', 'did-start-loading']) {
    await t.test(recoveryEvent, async () => {
      const { handlers, views } = makeHarness({ pageUnresponsiveReloadDelayMs: 20 });
      await handlers.get('yayra:webview-ensure')(null, { tabId: `tab-cancel-${recoveryEvent}`, url: 'https://example.com/' });
      const wc = views[0].webContents;
      wc.emit('unresponsive');
      await new Promise((resolve) => setTimeout(resolve, 5));
      wc.emit(recoveryEvent);
      await new Promise((resolve) => setTimeout(resolve, 30));
      assert.equal(wc._calls.includes('reload'), false, `no auto reload after ${recoveryEvent}`);
    });
  }
});

test('webview bridge: Google account home and management pages stay in the native in-app view', async () => {
  const { handlers, views, externalCalls } = makeHarness();
  await handlers.get('yayra:webview-ensure')(null, { tabId: 'tab-google-home', url: 'https://accounts.google.com/' });
  await handlers.get('yayra:webview-ensure')(null, { tabId: 'tab-google-account', url: 'https://accounts.google.com/ManageAccount' });
  assert.equal(views.length, 2, 'both ordinary Google account URLs create an in-app WebContentsView');
  assert.deepEqual(externalCalls, []);
});

test('webview bridge: accounts.google.com redirect to interactive sign-in is canceled into the system browser', async () => {
  const { handlers, views, fakeWin, sentEvents, externalCalls } = makeHarness();
  const homeUrl = 'https://accounts.google.com/';
  const signInUrl = 'https://accounts.google.com/signin/v2/identifier';
  const result = await handlers.get('yayra:webview-ensure')(null, { tabId: 'tab-google-root-redirect', url: homeUrl });
  assert.deepEqual(result, { handedOffToSystemBrowser: false });
  assert.equal(views.length, 1);
  const wc = views[0].webContents;
  const redirect = { prevented: false, preventDefault() { this.prevented = true; } };

  wc.emit('did-start-loading');
  wc.emit('will-redirect', redirect, { url: signInUrl, isMainFrame: true });
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(redirect.prevented, true, 'interactive account sign-in never commits in the embedded surface');
  assert.deepEqual(externalCalls, [signInUrl]);
  assert.equal(fakeWin.contentView.children[0], views[0], 'the source view remains attached and unchanged');
  assert.equal(wc.isDestroyed(), false);
  assert.ok(sentEvents.some((event) => event.payload.type === 'loading-stop'));
  const handoff = sentEvents.find((event) => event.payload.type === 'system-browser-handoff');
  assert.deepEqual(handoff.payload, {
    tabId: 'tab-google-root-redirect',
    type: 'system-browser-handoff',
    provider: 'google',
    reason: 'navigation'
  }, 'renderer receives metadata only, never the authorization URL');
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
  assert.ok(frameScripts.filter((script) => script.includes('caretRangeFromPoint')).length >= 2, 'native text-cursor hit-testing is installed in both the main and child frames');
  assert.ok(frameScripts.filter((script) => script.includes('__yayraTextSelectionActionsState')).length >= 2,
    'highlight actions are installed page-locally in the main and child frames');

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
  assert.ok(frameScripts.some((script) => script.includes('__yayraSelectableTextCursorState') && script.includes('cleanup')), 'System removes page text-cursor listeners and markers too');
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

test('webview bridge: existing Apple/Microsoft system-browser handoff behavior remains unchanged', async () => {
  const { handlers, sentEvents, externalCalls, views } = makeHarness();
  const appleResult = await handlers.get('yayra:webview-ensure')(null, { tabId: 'tab-apple', url: 'https://appleid.apple.com/auth/authorize' });
  const microsoftResult = await handlers.get('yayra:webview-ensure')(null, { tabId: 'tab-microsoft', url: 'https://login.microsoftonline.com/' });

  assert.equal(views.length, 0, 'no native view is created for either existing provider handoff');
  assert.deepEqual(externalCalls, ['https://appleid.apple.com/auth/authorize', 'https://login.microsoftonline.com/']);
  assert.equal(appleResult.handedOffToSystemBrowser, true);
  assert.equal(microsoftResult.handedOffToSystemBrowser, true);
  const handoffEvent = sentEvents.find((e) => e.payload.type === 'system-browser-handoff');
  assert.ok(handoffEvent, 'renderer is notified of the handoff');
  assert.equal(handoffEvent.channel, WEBVIEW_EVENT_CHANNEL);
});

test('webview bridge: direct Google OAuth authorization opens only in the OS external user-agent', async () => {
  const { handlers, externalCalls, views, sentEvents } = makeHarness();
  const authUrl = 'https://accounts.google.com/o/oauth2/v2/auth?client_id=site-client&state=private-state';
  const result = await handlers.get('yayra:webview-ensure')(null, { tabId: 'tab-auth', url: authUrl, profileId: 'work' });

  assert.deepEqual(result, { handedOffToSystemBrowser: true });
  assert.deepEqual(externalCalls, [authUrl]);
  assert.equal(views.length, 0, 'no embedded/app-controlled provider view is created');
  const handoff = sentEvents.find((event) => event.payload.type === 'system-browser-handoff');
  assert.equal(handoff.payload.provider, 'google');
  assert.equal(handoff.payload.reason, 'direct-navigation');
  assert.equal(JSON.stringify(handoff.payload).includes('private-state'), false, 'auth URL state is never echoed over IPC');
});

test('webview bridge: a failed system-browser launch creates no provider view and reports metadata only', async () => {
  const { handlers, sentEvents, views } = makeHarness({
    openExternalImpl: async () => { throw new Error('no browser handler'); }
  });
  const result = await handlers.get('yayra:webview-ensure')(null, {
    tabId: 'tab-auth-failed',
    url: 'https://accounts.google.com/ServiceLogin?continue=https%3A%2F%2Fmail.google.com%2F'
  });
  assert.deepEqual(result, { handedOffToSystemBrowser: false });
  assert.equal(views.length, 0);
  const failure = sentEvents.find((event) => event.payload.type === 'system-browser-handoff-failed');
  assert.deepEqual(failure.payload, {
    tabId: 'tab-auth-failed',
    type: 'system-browser-handoff-failed',
    provider: 'google',
    reason: 'direct-navigation'
  });
});

test('webview bridge: direct Google account sign-in pages use the system browser, while account management stays in Yayra', async () => {
  const { handlers, externalCalls, views } = makeHarness();
  const signInUrl = 'https://accounts.google.com/signin/v2/identifier';
  const result = await handlers.get('yayra:webview-ensure')(null, { tabId: 'tab-account-signin', url: signInUrl });
  assert.equal(result.handedOffToSystemBrowser, true);
  assert.deepEqual(externalCalls, [signInUrl]);
  assert.equal(views.length, 0);
  const management = await handlers.get('yayra:webview-ensure')(null, { tabId: 'tab-account-management', url: 'https://accounts.google.com/ManageAccount' });
  assert.equal(management.handedOffToSystemBrowser, false);
  assert.equal(views.length, 1);
});

test('webview bridge: direct HTTP Google OAuth is upgraded before opening in the system browser', async () => {
  const { handlers, externalCalls, views } = makeHarness();
  const result = await handlers.get('yayra:webview-ensure')(null, { tabId: 'tab-insecure-auth', url: 'http://accounts.google.com/o/oauth2/v2/auth?client_id=site-client' });
  assert.equal(result.handedOffToSystemBrowser, true);
  assert.deepEqual(externalCalls, ['https://accounts.google.com/o/oauth2/v2/auth?client_id=site-client']);
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

test('webview bridge: Google OAuth and account sign-in popups use the system browser', async () => {
  const { handlers, views, externalCalls, sentEvents } = makeHarness();
  await handlers.get('yayra:webview-ensure')(null, { tabId: 'tab-1', url: 'https://mail.google.com/' });
  const guestWebContents = views[0].webContents;
  const oauthUrl = 'https://accounts.google.com/signin/oauth?client_id=site-client';
  const accountUrl = 'https://accounts.google.com/signin/v2/identifier';

  assert.deepEqual(guestWebContents._simulateWindowOpen({ url: oauthUrl }), { action: 'deny' });
  assert.deepEqual(guestWebContents._simulateWindowOpen({ url: accountUrl }), { action: 'deny' });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(externalCalls, [oauthUrl, accountUrl]);
  assert.equal(sentEvents.filter((event) => event.payload.type === 'system-browser-handoff').length, 2);
  assert.equal(sentEvents.some((event) => event.payload.type === 'new-window-request'), false);
});

test('webview bridge: top-level Google OAuth and account sign-in redirects are canceled into the system browser', async () => {
  const { handlers, views, sentEvents, externalCalls } = makeHarness();
  await handlers.get('yayra:webview-ensure')(null, { tabId: 'tab-site', url: 'https://mail.google.com/' });
  const wc = views[0].webContents;
  const authUrl = 'https://accounts.google.com/o/oauth2/v2/auth?client_id=site-client&state=secret-state';
  const event = { prevented: false, preventDefault() { this.prevented = true; } };

  // Electron 44 details-object signature.
  wc.emit('will-redirect', event, { url: authUrl, isMainFrame: true });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(event.prevented, true);
  assert.deepEqual(externalCalls, [authUrl]);
  assert.equal(sentEvents.some((e) => e.payload.type === 'navigated'), false, 'a canceled auth redirect does not rewrite source history');
  assert.ok(sentEvents.some((e) => e.payload.type === 'loading-stop'));
  const handoff = sentEvents.find((e) => e.payload.type === 'system-browser-handoff');
  assert.equal(JSON.stringify(handoff.payload).includes('secret-state'), false);

  const signInUrl = 'https://accounts.google.com/signin/v2/identifier';
  const signInEvent = {
    url: signInUrl,
    isMainFrame: true,
    prevented: false,
    preventDefault() { this.prevented = true; }
  };
  wc.emit('will-navigate', signInEvent);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(signInEvent.prevented, true);
  assert.deepEqual(externalCalls, [authUrl, signInUrl]);

  // Legacy positional signature still ignores subframe provider navigation.
  const subframe = { prevented: false, preventDefault() { this.prevented = true; } };
  wc.emit('will-navigate', subframe, authUrl, false, false);
  assert.equal(subframe.prevented, false);

  const ordinaryGoogle = { prevented: false, preventDefault() { this.prevented = true; } };
  wc.emit('will-redirect', ordinaryGoogle, { url: 'https://www.google.com/search?q=ghana', isMainFrame: true });
  assert.equal(ordinaryGoogle.prevented, false, 'ordinary Google search is not rerouted by auth handling');
  assert.deepEqual(externalCalls, [authUrl, signInUrl]);
});

test('webview bridge: HTTP Google auth redirects are upgraded before the system browser opens', async () => {
  const { handlers, views, sentEvents, externalCalls } = makeHarness();
  await handlers.get('yayra:webview-ensure')(null, { tabId: 'tab-source', url: 'https://example.com/' });
  const event = { prevented: false, preventDefault() { this.prevented = true; } };
  const httpOAuthUrl = 'http://accounts.google.com/o/oauth2/v2/auth?client_id=x';
  views[0].webContents.emit('will-redirect', event, { url: httpOAuthUrl, isMainFrame: true });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(event.prevented, true);
  assert.deepEqual(externalCalls, ['https://accounts.google.com/o/oauth2/v2/auth?client_id=x']);
  assert.ok(sentEvents.some((e) => e.payload.type === 'system-browser-handoff'
    && e.payload.provider === 'google'
    && !('url' in e.payload)));
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
  assert.deepEqual(
    views[0].bounds,
    { x: 10, y: 36, width: 800, height: 584 },
    'a stale y-coordinate is clipped below the custom tab/caption row'
  );

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
 * Standards-based website passkey routing / account selection
 * ----------------------------------------------------------------- */

test('website passkeys: valid lifecycle metadata reaches only the owning shell and hostile/replayed events are dropped', async () => {
  const { handlers, listeners, sentEvents, views } = makeHarness({ autofillPreloadPath: '/fake/p.cjs' });
  await handlers.get('yayra:webview-ensure')(null, { tabId: 'tab-passkey', url: 'https://login.github.com/security' });
  const route = listeners.get('yayra:site-passkey-request');
  const sender = views[0].webContents;
  const started = {
    source: 'yayra-site-passkey',
    phase: 'started',
    requestId: 'yayra-wa-request-0001',
    action: 'create',
    rpId: 'github.com',
    attachment: 'platform',
    conditional: false,
    challenge: 'must-never-cross-the-bridge',
    userName: 'private@example.com'
  };

  route({ sender }, started);
  const forwarded = sentEvents.find((event) => event.payload?.type === 'webauthn-request');
  assert.ok(forwarded, 'a real origin-bound request is recognized immediately');
  assert.deepEqual(forwarded.payload, {
    type: 'webauthn-request',
    tabId: 'tab-passkey',
    phase: 'started',
    requestId: 'yayra-wa-request-0001',
    action: 'create',
    rpId: 'github.com',
    conditional: false,
    attachment: 'platform',
    provider: {
      mode: 'native',
      available: false,
      reason: 'native-platform-authenticator'
    },
    success: undefined,
    errorName: ''
  });
  assert.equal(JSON.stringify(forwarded).includes('private@example.com'), false, 'identity metadata is stripped');
  assert.equal(JSON.stringify(forwarded).includes('must-never-cross'), false, 'ceremony secrets are stripped');

  route({ sender }, { ...started, requestId: 'yayra-wa-hostile-001', rpId: 'evil.example' });
  assert.equal(sentEvents.filter((event) => event.payload?.type === 'webauthn-request').length, 1, 'unrelated RP IDs cannot spoof browser chrome');

  route({ sender }, {
    source: started.source,
    phase: 'settled',
    requestId: started.requestId,
    action: 'get',
    rpId: 'login.github.com',
    conditional: true,
    attachment: 'cross-platform',
    success: true
  });
  const lifecycle = sentEvents.filter((event) => event.payload?.type === 'webauthn-request');
  assert.equal(lifecycle.length, 2);
  assert.equal(lifecycle[1].payload.action, 'create', 'settle cannot rewrite immutable start metadata');
  assert.equal(lifecycle[1].payload.rpId, 'github.com');
  assert.equal(lifecycle[1].payload.conditional, false);
  route({ sender }, {
    source: started.source,
    phase: 'settled',
    requestId: started.requestId,
    action: started.action,
    rpId: started.rpId,
    success: false,
    errorName: 'NotAllowedError'
  });
  assert.equal(sentEvents.filter((event) => event.payload?.type === 'webauthn-request').length, 2, 'a settled request cannot be replayed');
});

test('website passkeys: discoverable-account chooser is installed once per Session and always completes exactly once', async () => {
  const sessionListeners = new Map();
  const webauthnSession = {
    on(event, listener) { sessionListeners.set(event, listener); },
    listenerCount(event) { return sessionListeners.has(event) ? 1 : 0; }
  };
  const shownDialogs = [];
  const Dialog = {
    async showMessageBox(_owner, options) {
      shownDialogs.push(options);
      return { response: 1 };
    }
  };
  const { handlers, listeners, sentEvents, views, externalCalls } = makeHarness({ webauthnSession, Dialog });
  await handlers.get('yayra:webview-ensure')(null, { tabId: 'tab-account-1', url: 'https://github.com/login' });
  await handlers.get('yayra:webview-ensure')(null, { tabId: 'tab-account-2', url: 'https://github.com/settings' });
  const requestingFrame = {};
  views[0].webContents.mainFrame = requestingFrame;
  assert.equal(webauthnSession.listenerCount('select-webauthn-account'), 1, 'one listener serves every tab in the same Session');
  listeners.get('yayra:site-passkey-request')({ sender: views[0].webContents }, {
    phase: 'started',
    requestId: 'yayra-wa-conditional-account-1',
    action: 'get',
    rpId: 'github.com',
    conditional: true,
    attachment: 'platform'
  });

  const credentialA = 'AQID';
  const credentialB = 'BAUG';
  const callbacks = [];
  sessionListeners.get('select-webauthn-account')(
    {},
    {
      relyingPartyId: 'github.com',
      frame: requestingFrame,
      accounts: [
        { credentialId: credentialA, name: 'ada@example.com', displayName: 'Ada' },
        { credentialId: credentialB, name: 'grace@example.com', displayName: 'Grace' }
      ]
    },
    (credentialId) => callbacks.push(credentialId)
  );
  await Promise.resolve();
  await Promise.resolve();

  assert.equal(shownDialogs.length, 1);
  assert.match(shownDialogs[0].message, /github\.com/);
  assert.equal(callbacks.length, 1, 'Electron callback is completed exactly once');
  assert.equal(callbacks[0], credentialB, 'the selected credential ID is returned unchanged');
  const notice = sentEvents.find((event) => event.payload?.type === 'webauthn-account-selection');
  assert.deepEqual(notice?.payload, {
    tabId: 'tab-account-1',
    type: 'webauthn-account-selection',
    relyingPartyId: 'github.com',
    accountCount: 2,
    requestId: 'yayra-wa-conditional-account-1'
  });
  assert.equal(JSON.stringify(notice).includes('ada@example.com'), false, 'account identities stay in native chooser UI');
  const activated = await handlers.get('yayra:webview-continue-passkey')(null, {
    tabId: 'tab-account-1',
    requestId: 'yayra-wa-conditional-account-1'
  });
  assert.deepEqual(activated, { ok: true, handedOff: true },
    'account choice promotes conditional mediation into an actionable request');
  assert.deepEqual(externalCalls, ['https://github.com/login']);

  const canceled = [];
  sessionListeners.get('select-webauthn-account')(
    {},
    { relyingPartyId: 'github.com', frame: null, accounts: [{ credentialId: credentialA, name: 'Ada' }] },
    (credentialId) => canceled.push(credentialId)
  );
  assert.deepEqual(canceled, [undefined], 'a navigated/destroyed requesting frame is canceled exactly once');
  assert.equal(shownDialogs.length, 1, 'no chooser is attached to an unrelated fallback window');
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
