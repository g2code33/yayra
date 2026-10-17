import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { setupDomShim } from './dom-shim.mjs';

setupDomShim();

import {
  OPEN_EXTERNAL_SCHEME,
  decodeOpenExternalRequest,
  buildWebAuthnWatchdogScript,
  buildGoogleSearchThinkingWatchdogScript,
  createWebviewBridge
} from '../electron/webviewBridge.cjs';

/**
 * Passkey/WebAuthn stuck-request watchdog.
 *
 * Inside Electron, sites' navigator.credentials.get() calls for passkeys
 * can hang forever ("Waiting for input from browser interaction...") when
 * the needed authenticator UI doesn't exist (phone/synced passkeys,
 * Chrome's QR hybrid flow - most visibly on Linux). The watchdog script
 * is injected into the page's MAIN world on dom-ready and shows an
 * escape-hatch banner only when a publicKey request stays unsettled.
 * These tests execute the real injected script in a VM with the DOM shim.
 */

function runWatchdog({ waitMs = 15 } = {}) {
  const openedWindows = [];
  let settleGet;
  const credentials = {
    get: () => new Promise((resolve) => { settleGet = resolve; }),
    create: () => new Promise(() => {})
  };
  const windowObj = {
    PublicKeyCredential: function PublicKeyCredential() {},
    __yayraWebauthnWaitMs: waitMs,
    location: { href: 'https://github.com/sessions/two-factor/webauthn' },
    open: (url) => { openedWindows.push(url); return null; }
  };
  const sandbox = {
    window: windowObj,
    navigator: { credentials },
    document: globalThis.document,
    setTimeout,
    clearTimeout
  };
  vm.createContext(sandbox);
  vm.runInContext(buildWebAuthnWatchdogScript(), sandbox);
  return {
    sandbox,
    credentials,
    openedWindows,
    resolvePendingGet: (value) => settleGet && settleGet(value),
    banner: () => globalThis.document.body.querySelector('#yayra-webauthn-helper')
  };
}

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

test.afterEach(() => {
  globalThis.document.body.querySelector('#yayra-webauthn-helper')?.remove();
});

test('stuck publicKey get(): helper banner appears after the wait window, with open-external and dismiss actions', async () => {
  const { credentials, openedWindows, banner } = runWatchdog({ waitMs: 10 });

  const pending = credentials.get({ publicKey: { challenge: new Uint8Array(1) } });
  assert.equal(banner(), null, 'no banner immediately - working flows (Windows Hello, touched USB key) never see it');

  await wait(40);
  const el = banner();
  assert.ok(el, 'banner shown once the request is clearly stuck');

  el.querySelector('#yayra-webauthn-open-external').click();
  assert.equal(openedWindows.length, 1);
  assert.ok(openedWindows[0].startsWith(OPEN_EXTERNAL_SCHEME), 'open-external goes through the sentinel scheme the main process intercepts');
  assert.equal(
    decodeOpenExternalRequest(openedWindows[0]),
    'https://github.com/sessions/two-factor/webauthn',
    'sentinel round-trips back to the exact stuck page URL'
  );

  el.querySelector('#yayra-webauthn-dismiss').click();
  assert.equal(banner(), null, 'dismiss removes the banner');
  void pending;
});

test('request that settles (success or cancel) removes the banner and cancels the timer', async () => {
  const { credentials, resolvePendingGet, banner } = runWatchdog({ waitMs: 10 });

  const pending = credentials.get({ publicKey: {} });
  await wait(40);
  assert.ok(banner(), 'banner up while stuck');

  resolvePendingGet({ id: 'cred' });
  await pending;
  await wait(5);
  assert.equal(banner(), null, 'banner removed the moment the passkey request settles');
});

test('password-manager credentials.get() (no publicKey) is never watched', async () => {
  const { credentials, banner } = runWatchdog({ waitMs: 10 });
  credentials.get({ password: true });
  await wait(40);
  assert.equal(banner(), null, 'non-WebAuthn credential requests never trigger the helper');
});

test('decodeOpenExternalRequest is a security gate: only http(s) targets pass', () => {
  const ok = `${OPEN_EXTERNAL_SCHEME}${encodeURIComponent('https://github.com/login')}`;
  assert.equal(decodeOpenExternalRequest(ok), 'https://github.com/login');
  assert.equal(decodeOpenExternalRequest(`${OPEN_EXTERNAL_SCHEME}${encodeURIComponent('javascript:alert(1)')}`), null);
  assert.equal(decodeOpenExternalRequest(`${OPEN_EXTERNAL_SCHEME}${encodeURIComponent('file:///etc/passwd')}`), null);
  assert.equal(decodeOpenExternalRequest('https://github.com/login'), null, 'plain URLs are not open-external requests');
  assert.equal(decodeOpenExternalRequest(`${OPEN_EXTERNAL_SCHEME}%E0%A4%A`), null, 'malformed encoding rejected, not thrown');
});

/* ------------------------------------------------------------------ */
/* Bridge integration: injection on dom-ready + sentinel interception  */
/* ------------------------------------------------------------------ */

function makeBridgeHarness() {
  const handlers = new Map();
  const ipcMain = { handle: (c, fn) => handlers.set(c, fn), on: () => {} };
  const sentEvents = [];
  const fakeWin = {
    isDestroyed: () => false,
    webContents: { send: (channel, payload) => sentEvents.push({ channel, payload }) },
    contentView: { children: [], addChildView(v) { this.children.push(v); }, removeChildView() {} }
  };
  const externalCalls = [];
  const shell = { openExternal: async (url) => { externalCalls.push(url); } };
  const views = [];
  const WebContentsView = function FakeWebContentsView() {
    const listeners = new Map();
    let windowOpenHandler = null;
    const webContents = {
      executedScripts: [],
      loadURL: async () => {},
      isDestroyed: () => false,
      setUserAgent: () => {},
      setWindowOpenHandler: (fn) => { windowOpenHandler = fn; },
      executeJavaScript: (code) => { webContents.executedScripts.push(code); return Promise.resolve(); },
      on: (event, fn) => {
        if (!listeners.has(event)) listeners.set(event, []);
        listeners.get(event).push(fn);
      },
      emit: (event, ...args) => { for (const fn of listeners.get(event) || []) fn(...args); },
      send: () => {},
      _simulateWindowOpen: (details) => windowOpenHandler(details)
    };
    const view = { webContents, setBounds: () => {} };
    views.push(view);
    return view;
  };
  createWebviewBridge({
    WebContentsView,
    ipcMain,
    shell,
    getMainWindow: () => fakeWin,
    logger: { error: () => {} }
  });
  return { handlers, views, externalCalls, sentEvents };
}

test('bridge injects the watchdog into the page main world on every dom-ready', async () => {
  const { handlers, views } = makeBridgeHarness();
  await handlers.get('yayra:webview-ensure')(null, { tabId: 'tab-1', url: 'https://github.com/login' });

  views[0].webContents.emit('dom-ready');
  views[0].webContents.emit('dom-ready');

  assert.equal(views[0].webContents.executedScripts.length, 2, 'both watchdogs are injected together on each document load');
  assert.ok(views[0].webContents.executedScripts[0].includes('__yayraWebauthnWatchdog'), 'passkey watchdog remains installed');
  assert.ok(views[0].webContents.executedScripts[0].includes('__yayraGoogleSearchThinkingWatchdog'), 'Google Search timeout watchdog is installed');
  assert.ok(buildGoogleSearchThinkingWatchdogScript().includes('location.reload()'), 'recovery uses an ordinary page reload');
});

test('bridge intercepts the open-external sentinel: opens the REAL url in the system browser and denies the popup', async () => {
  const { handlers, views, externalCalls, sentEvents } = makeBridgeHarness();
  await handlers.get('yayra:webview-ensure')(null, { tabId: 'tab-1', url: 'https://github.com/login' });

  const result = views[0].webContents._simulateWindowOpen({
    url: `${OPEN_EXTERNAL_SCHEME}${encodeURIComponent('https://github.com/sessions/two-factor/webauthn')}`
  });
  await Promise.resolve();

  assert.deepEqual(result, { action: 'deny' });
  assert.deepEqual(externalCalls, ['https://github.com/sessions/two-factor/webauthn']);
  assert.ok(
    sentEvents.some((e) => e.payload?.type === 'system-browser-handoff'),
    'shell window is told about the handoff (shows the user what happened)'
  );

  // Non-http target inside the sentinel must be refused outright.
  const evil = views[0].webContents._simulateWindowOpen({
    url: `${OPEN_EXTERNAL_SCHEME}${encodeURIComponent('javascript:alert(1)')}`
  });
  assert.notEqual(decodeOpenExternalRequest(`${OPEN_EXTERNAL_SCHEME}${encodeURIComponent('javascript:alert(1)')}`), 'javascript:alert(1)');
  assert.equal(externalCalls.length, 1, 'nothing extra opened externally');
  void evil;
});
