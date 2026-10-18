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
  const ipcListeners = new Map();
  const sends = [];
  let resolveCreate;
  let nativeCreateCalls = 0;
  const credentials = {
    get: () => Promise.resolve(null),
    create: () => {
      nativeCreateCalls += 1;
      return new Promise((resolve) => { resolveCreate = resolve; });
    }
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
    on: (channel, listener) => ipcListeners.set(channel, listener)
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
    crypto: globalThis.crypto,
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
  assert.equal(started.payload.controlled, true, 'main can distinguish the secure pre-invocation gate from an old fallback observer');
  assert.equal(JSON.stringify(started).includes('private@example.com'), false);
  assert.equal(JSON.stringify(started).includes('challenge'), false);
  assert.equal(nativeCreateCalls, 0, 'native CTAP does not start before trusted browser approval');

  assert.equal(
    pageWindow.__yayraSitePasskeyObserver.control(
      { requestId: started.payload.requestId, command: 'release' },
      '0'.repeat(64)
    ),
    false,
    'page JavaScript cannot release its own ceremony without the isolated-world capability'
  );
  assert.equal(nativeCreateCalls, 0);
  ipcListeners.get('yayra:site-passkey-control')({}, {
    requestId: started.payload.requestId,
    command: 'release'
  });
  assert.equal(nativeCreateCalls, 1, 'trusted main-process release starts the untouched native WebAuthn request');

  resolveCreate({ id: 'credential' });
  await request;
  await Promise.resolve();
  const lifecycle = sends.filter((message) => message.channel === 'yayra:site-passkey-request');
  assert.equal(lifecycle.length, 2);
  assert.equal(lifecycle[1].payload.phase, 'settled');
  assert.equal(lifecycle[1].payload.success, true);
  assert.equal(lifecycle[1].payload.requestId, lifecycle[0].payload.requestId);

  const controller = new AbortController();
  const cancelled = credentials.create({
    publicKey: { challenge: new Uint8Array([3]), rp: { id: 'github.com' } },
    signal: controller.signal
  });
  controller.abort();
  await assert.rejects(cancelled, { name: 'AbortError' });
  assert.equal(nativeCreateCalls, 1, 'aborting a held request never enters native WebAuthn');
  assert.equal(sends.at(-1).payload.phase, 'settled');
  assert.equal(sends.at(-1).payload.errorName, 'AbortError');
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

function makeBridgeHarness({ websitePasskeyProvider = null, webauthnSession = null, dialog = null } = {}) {
  const handlers = new Map();
  const listeners = new Map();
  const ipcMain = {
    handle: (c, fn) => handlers.set(c, fn),
    on: (c, fn) => listeners.set(c, fn)
  };
  const sentEvents = [];
  const fakeWin = {
    isDestroyed: () => false,
    webContents: { send: (channel, payload) => sentEvents.push({ channel, payload }) },
    contentView: { children: [], addChildView(v) { this.children.push(v); }, removeChildView() {} }
  };
  const externalCalls = [];
  const shell = { openExternal: async (url) => { externalCalls.push(url); } };
  const views = [];
  const pageMessages = [];
  const WebContentsView = function FakeWebContentsView() {
    const listeners = new Map();
    let windowOpenHandler = null;
    const webContents = {
      executedScripts: [],
      loadedUrls: [],
      session: webauthnSession,
      mainFrame: null,
      focus: () => {},
      loadURL: async (url) => { webContents.loadedUrls.push(url); },
      isDestroyed: () => false,
      setUserAgent: () => {},
      setWindowOpenHandler: (fn) => { windowOpenHandler = fn; },
      executeJavaScript: (code) => { webContents.executedScripts.push(code); return Promise.resolve(); },
      on: (event, fn) => {
        if (!listeners.has(event)) listeners.set(event, []);
        listeners.get(event).push(fn);
      },
      emit: (event, ...args) => { for (const fn of listeners.get(event) || []) fn(...args); },
      send: (channel, payload) => pageMessages.push({ channel, payload }),
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
    websitePasskeyProvider,
    dialog,
    logger: { error: () => {}, warn: () => {} }
  });
  return { handlers, listeners, views, externalCalls, sentEvents, pageMessages };
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


test('bridge attaches the Linux authenticator before any page JavaScript can request a passkey', async () => {
  let releaseAttach;
  const provider = {
    attach: () => new Promise((resolve) => { releaseAttach = resolve; }),
    describe: () => ({ mode: 'local', available: true, reason: '' }),
    detach: () => {}
  };
  const { handlers, views } = makeBridgeHarness({ websitePasskeyProvider: provider });
  const ensure = handlers.get('yayra:webview-ensure')(null, {
    tabId: 'tab-provider-order',
    url: 'https://github.com/settings/security'
  });
  await Promise.resolve();
  assert.equal(views.length, 1);
  assert.deepEqual(views[0].webContents.loadedUrls, [], 'page load is gated on provider initialization');
  releaseAttach({ ok: true });
  await ensure;
  assert.deepEqual(views[0].webContents.loadedUrls, ['https://github.com/settings/security']);
});

test('bridge turns a Linux site passkey request into an explicit secure continuation action', async () => {
  const calls = { attach: [], confirm: [], settle: [] };
  const provider = {
    describe: () => ({ mode: 'local', available: true, reason: '' }),
    attach: async (details) => { calls.attach.push(details); return { ok: true }; },
    confirm: async (details) => { calls.confirm.push(details); return { ok: true, prompted: true }; },
    settle: (details) => { calls.settle.push(details); },
    detach: () => {}
  };
  const { handlers, listeners, views, sentEvents, pageMessages } = makeBridgeHarness({ websitePasskeyProvider: provider });
  await handlers.get('yayra:webview-ensure')(null, { tabId: 'tab-passkey', url: 'https://github.com/settings/security' });
  await Promise.resolve();
  assert.equal(calls.attach.length, 1, 'provider is attached before the page can request WebAuthn');

  listeners.get('yayra:site-passkey-request')({ sender: views[0].webContents }, {
    phase: 'started',
    requestId: 'yayra-wa-linux-1',
    action: 'create',
    rpId: 'github.com',
    conditional: false,
    attachment: 'platform',
    controlled: true
  });
  const started = sentEvents.find((event) => event.payload.type === 'webauthn-request');
  assert.equal(started.payload.provider.mode, 'local');
  assert.equal(calls.confirm.length, 0, 'a site cannot trigger the system-password prompt without the user clicking browser chrome');
  assert.deepEqual(pageMessages.at(-1), {
    channel: 'yayra:site-passkey-control',
    payload: { requestId: 'yayra-wa-linux-1', command: 'hold' }
  }, 'GitHub create() is held before entering Chromium CTAP');

  const continued = await handlers.get('yayra:webview-continue-passkey')(null, {
    tabId: 'tab-passkey',
    requestId: 'yayra-wa-linux-1'
  });
  assert.deepEqual(continued, { ok: true, prompted: true });
  assert.equal(calls.confirm.length, 1);
  assert.equal(calls.confirm[0].rpId, 'github.com');
  assert.equal(calls.confirm[0].isStillActive(), true);
  assert.deepEqual(pageMessages.at(-1), {
    channel: 'yayra:site-passkey-control',
    payload: { requestId: 'yayra-wa-linux-1', command: 'release' }
  }, 'verified presence is armed before the exact native create() call is released');
  assert.ok(sentEvents.some((event) => event.payload.type === 'webauthn-provider-state'
    && event.payload.state === 'prompting'));
  assert.ok(sentEvents.some((event) => event.payload.type === 'webauthn-provider-state'
    && event.payload.state === 'approved'));

  listeners.get('yayra:site-passkey-request')({ sender: views[0].webContents }, {
    phase: 'settled',
    requestId: 'yayra-wa-linux-1',
    action: 'create',
    rpId: 'github.com',
    success: true
  });
  assert.equal(calls.settle.at(-1).requestId, 'yayra-wa-linux-1');
});

test('bridge fails an old ungated observer closed instead of attempting a late virtual touch', async () => {
  let confirmations = 0;
  const provider = {
    describe: () => ({ mode: 'local', available: true, reason: '' }),
    attach: async () => ({ ok: true }),
    confirm: async () => { confirmations += 1; return { ok: true }; },
    settle: () => {},
    detach: () => {}
  };
  const { handlers, listeners, views, sentEvents, externalCalls } = makeBridgeHarness({ websitePasskeyProvider: provider });
  const url = 'https://github.com/settings/security';
  await handlers.get('yayra:webview-ensure')(null, { tabId: 'tab-legacy-gate', url });
  listeners.get('yayra:site-passkey-request')({ sender: views[0].webContents }, {
    phase: 'started',
    requestId: 'yayra-wa-legacy-ungated',
    action: 'create',
    rpId: 'github.com',
    conditional: false,
    controlled: false
  });
  const started = sentEvents.find((event) => event.payload?.type === 'webauthn-request');
  assert.deepEqual(started.payload.provider, {
    mode: 'external',
    available: false,
    reason: 'request-gate-unavailable'
  });
  const result = await handlers.get('yayra:webview-continue-passkey')(null, {
    tabId: 'tab-legacy-gate',
    requestId: 'yayra-wa-legacy-ungated'
  });
  assert.deepEqual(result, { ok: true, handedOff: true });
  assert.equal(confirmations, 0, 'PolicyKit cannot claim success for an already-pending CTAP command');
  assert.deepEqual(externalCalls, [url]);
});

test('bridge defers a conditional account callback until local user verification is armed', async () => {
  const sessionListeners = new Map();
  const session = { on: (event, listener) => sessionListeners.set(event, listener) };
  const order = [];
  const provider = {
    describe: () => ({ mode: 'local', available: true, reason: '' }),
    attach: async () => ({ ok: true }),
    confirm: async () => { order.push('verified'); return { ok: true, prompted: true }; },
    settle: () => {},
    detach: () => {}
  };
  const dialog = {
    showMessageBox: async () => ({ response: 0 })
  };
  const { handlers, listeners, views, pageMessages } = makeBridgeHarness({
    websitePasskeyProvider: provider,
    webauthnSession: session,
    dialog
  });
  await handlers.get('yayra:webview-ensure')(null, {
    tabId: 'tab-conditional',
    url: 'https://github.com/login'
  });
  const frame = {};
  views[0].webContents.mainFrame = frame;
  listeners.get('yayra:site-passkey-request')({ sender: views[0].webContents }, {
    phase: 'started',
    requestId: 'yayra-wa-conditional-local-1',
    action: 'get',
    rpId: 'github.com',
    conditional: true,
    attachment: 'platform',
    controlled: true
  });
  assert.equal(pageMessages.at(-1).payload.command, 'release', 'conditional discovery starts immediately');

  const selected = [];
  sessionListeners.get('select-webauthn-account')({}, {
    relyingPartyId: 'github.com',
    frame,
    accounts: [{ credentialId: 'AQID', name: 'ada@example.com', displayName: 'Ada' }]
  }, (credentialId) => {
    order.push('account-callback');
    selected.push(credentialId);
  });
  await Promise.resolve();
  await Promise.resolve();
  assert.deepEqual(selected, [], 'choosing an account does not enter CTAP before verification');

  const result = await handlers.get('yayra:webview-continue-passkey')(null, {
    tabId: 'tab-conditional',
    requestId: 'yayra-wa-conditional-local-1'
  });
  assert.deepEqual(result, { ok: true, prompted: true });
  assert.deepEqual(selected, ['AQID']);
  assert.deepEqual(order, ['verified', 'account-callback'], 'presence is armed before Chromium receives the selected credential');
});

test('bridge passkey action opens the exact HTTPS page externally when secure local storage is unavailable', async () => {
  const provider = {
    describe: () => ({ mode: 'external', available: false, reason: 'secure-storage-unavailable' }),
    attach: async () => ({ ok: false }),
    settle: () => {},
    detach: () => {}
  };
  const { handlers, listeners, views, externalCalls } = makeBridgeHarness({ websitePasskeyProvider: provider });
  const url = 'https://github.com/settings/security';
  await handlers.get('yayra:webview-ensure')(null, { tabId: 'tab-external', url });
  listeners.get('yayra:site-passkey-request')({ sender: views[0].webContents }, {
    phase: 'started',
    requestId: 'yayra-wa-external-1',
    action: 'create',
    rpId: 'github.com',
    conditional: false
  });
  const result = await handlers.get('yayra:webview-continue-passkey')(null, {
    tabId: 'tab-external',
    requestId: 'yayra-wa-external-1'
  });
  assert.deepEqual(result, { ok: true, handedOff: true });
  assert.deepEqual(externalCalls, [url]);
});
