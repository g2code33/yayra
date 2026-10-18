import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
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
  const lifecycleMessages = [];
  let settleGet;
  let settleCreate;
  let rejectCreate;
  const credentials = {
    get: () => new Promise((resolve) => { settleGet = resolve; }),
    create: () => new Promise((resolve, reject) => { settleCreate = resolve; rejectCreate = reject; })
  };
  const windowObj = {
    PublicKeyCredential: function PublicKeyCredential() {},
    __yayraWebauthnWaitMs: waitMs,
    location: { href: 'https://github.com/sessions/two-factor/webauthn', hostname: 'github.com' },
    open: (url) => { openedWindows.push(url); return null; },
    postMessage: (payload) => { lifecycleMessages.push(payload); }
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
    lifecycleMessages,
    resolvePendingGet: (value = { id: 'ok' }) => settleGet?.(value),
    resolvePendingCreate: (value = { id: 'created' }) => settleCreate?.(value),
    rejectPendingCreate: (error = Object.assign(new Error('No authenticator'), { name: 'NotAllowedError' })) => rejectCreate?.(error),
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

test('website passkey create(): lifecycle is reported immediately with metadata only, then settles successfully', async () => {
  const { credentials, lifecycleMessages, resolvePendingCreate } = runWatchdog({ waitMs: 50 });
  const request = credentials.create({
    publicKey: {
      challenge: new Uint8Array([1, 2, 3]),
      rp: { id: 'github.com', name: 'GitHub' },
      user: { id: new Uint8Array([9]), name: 'private@example.com' },
      authenticatorSelection: { authenticatorAttachment: 'platform' }
    }
  });

  assert.equal(lifecycleMessages.length, 1, 'request is recognized before any delayed helper appears');
  assert.deepEqual(
    {
      source: lifecycleMessages[0].source,
      phase: lifecycleMessages[0].phase,
      action: lifecycleMessages[0].action,
      rpId: lifecycleMessages[0].rpId,
      attachment: lifecycleMessages[0].attachment
    },
    {
      source: 'yayra-site-passkey',
      phase: 'started',
      action: 'create',
      rpId: 'github.com',
      attachment: 'platform'
    }
  );
  assert.equal(JSON.stringify(lifecycleMessages).includes('private@example.com'), false, 'user identity is never exposed');
  assert.equal(JSON.stringify(lifecycleMessages).includes('challenge'), false, 'challenge bytes are never exposed');

  resolvePendingCreate();
  await request;
  await wait(1);
  assert.equal(lifecycleMessages.length, 2);
  assert.equal(lifecycleMessages[1].phase, 'settled');
  assert.equal(lifecycleMessages[1].success, true);
  assert.equal(lifecycleMessages[1].requestId, lifecycleMessages[0].requestId);
});

test('conditional passkey get(): stays silent in-page while retaining immediate lifecycle visibility', async () => {
  const { credentials, lifecycleMessages, resolvePendingGet, banner } = runWatchdog({ waitMs: 10 });
  const request = credentials.get({ publicKey: { rpId: 'github.com' }, mediation: 'conditional' });

  assert.equal(lifecycleMessages[0].conditional, true);
  await wait(40);
  assert.equal(banner(), null, 'passive autofill mediation must not show a false stuck-request warning');
  resolvePendingGet();
  await request;
  assert.equal(lifecycleMessages.at(-1).phase, 'settled');
  assert.equal(lifecycleMessages.at(-1).success, true);
});

test('failed website passkey request remains honest and keeps a system-browser recovery action', async () => {
  const { credentials, lifecycleMessages, rejectPendingCreate, banner } = runWatchdog({ waitMs: 10 });
  const request = credentials.create({ publicKey: { rp: { id: 'github.com' } } });
  await wait(40);
  assert.ok(banner(), 'device/security-key guidance appears while the ceremony is pending');

  rejectPendingCreate();
  await assert.rejects(request, { name: 'NotAllowedError' });
  await wait(1);
  assert.match(banner().textContent, /did not complete/i);
  assert.equal(lifecycleMessages.at(-1).success, false);
  assert.equal(lifecycleMessages.at(-1).errorName, 'NotAllowedError');
  assert.ok(banner().querySelector('#yayra-webauthn-open-external'), 'safe fallback remains available after failure');
});

test('password-manager credentials.get() (no publicKey) is never watched', async () => {
  const { credentials, banner, lifecycleMessages } = runWatchdog({ waitMs: 10 });
  credentials.get({ password: true });
  await wait(40);
  assert.equal(banner(), null, 'non-WebAuthn credential requests never trigger the helper');
  assert.equal(lifecycleMessages.length, 0, 'non-WebAuthn requests are never reported to browser chrome');
});

test('main-world observer and isolated preload share one versioned, metadata-only message contract', () => {
  const watchdog = buildWebAuthnWatchdogScript();
  const preload = readFileSync(new URL('../electron/autofillPreload.cjs', import.meta.url), 'utf8');
  const marker = watchdog.match(/source:\s*'([^']+)'/)?.[1];
  assert.ok(marker, 'observer has an explicit source marker');
  assert.ok(preload.includes(`payload.source !== '${marker}'`), 'preload accepts the exact observer marker');
  assert.match(watchdog, /requestId:\s*'yayra-wa-'/, 'observer request IDs use the preload allowlisted prefix');
  assert.match(preload, /\^yayra-wa-\[a-z0-9-\]/i, 'preload validates the request ID format');
  for (const sensitive of ['challenge', 'credentialId', 'userHandle', 'authenticatorData', 'signature']) {
    assert.equal(watchdog.match(new RegExp(`${sensitive}\\s*:`, 'i')), null, `${sensitive} is never posted to the preload`);
  }
});

test('isolated preload installs the main-world observer at document start and forwards an early real request', async () => {
  const preload = readFileSync(new URL('../electron/autofillPreload.cjs', import.meta.url), 'utf8');
  const windowListeners = new Map();
  const sends = [];
  let resolveCreate;
  const credentials = {
    get: () => Promise.resolve(null),
    create: () => new Promise((resolve) => { resolveCreate = resolve; })
  };
  const pageWindow = {
    PublicKeyCredential: function PublicKeyCredential() {},
    location: { href: 'https://login.github.com/security', hostname: 'login.github.com', origin: 'https://login.github.com' },
    addEventListener(type, listener) {
      const group = windowListeners.get(type) || [];
      group.push(listener);
      windowListeners.set(type, group);
    },
    postMessage(payload) {
      for (const listener of windowListeners.get('message') || []) {
        listener({ source: pageWindow, data: payload });
      }
    },
    getComputedStyle: () => null,
    innerWidth: 1024,
    innerHeight: 768
  };
  const documentStub = {
    readyState: 'complete',
    documentElement: null,
    activeElement: null,
    addEventListener() {},
    querySelector: () => null,
    querySelectorAll: () => [],
    createElement: () => ({})
  };
  const ipcRenderer = {
    send: (channel, payload) => sends.push({ channel, payload }),
    on() {}
  };
  const contextBridge = {
    executeInMainWorld({ func, args = [] }) { return func(...args); }
  };
  const sandbox = {
    require: (name) => {
      assert.equal(name, 'electron');
      return { ipcRenderer, contextBridge };
    },
    window: pageWindow,
    navigator: { credentials },
    document: documentStub,
    location: pageWindow.location,
    Node: { DOCUMENT_POSITION_FOLLOWING: 4 },
    HTMLInputElement: function HTMLInputElement() {},
    Event: function Event() {},
    setTimeout,
    clearTimeout,
    setInterval: () => 1,
    clearInterval: () => {},
    console
  };
  vm.createContext(sandbox);
  vm.runInContext(preload, sandbox);
  // The later dom-ready helper must subscribe to the early observer instead
  // of wrapping navigator.credentials a second time.
  vm.runInContext(buildWebAuthnWatchdogScript(), sandbox);

  const request = credentials.create({
    publicKey: {
      challenge: new Uint8Array([1, 2]),
      rp: { id: 'github.com' },
      user: { name: 'private@example.com' },
      authenticatorSelection: { authenticatorAttachment: 'platform' }
    }
  });
  const started = sends.find((message) => message.channel === 'yayra:site-passkey-request');
  assert.ok(started, 'the preload forwards before dom-ready or a fallback delay');
  assert.equal(started.payload.phase, 'started');
  assert.equal(started.payload.rpId, 'github.com');
  assert.equal(started.payload.attachment, 'platform');
  assert.equal(JSON.stringify(started).includes('private@example.com'), false);
  assert.equal(JSON.stringify(started).includes('challenge'), false);

  resolveCreate({ id: 'credential' });
  await request;
  await Promise.resolve();
  const lifecycle = sends.filter((message) => message.channel === 'yayra:site-passkey-request');
  assert.equal(lifecycle.length, 2);
  assert.equal(lifecycle[1].payload.phase, 'settled');
  assert.equal(lifecycle[1].payload.success, true);
  assert.equal(lifecycle[1].payload.requestId, lifecycle[0].payload.requestId);
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
