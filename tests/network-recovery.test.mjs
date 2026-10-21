import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { setupDomShim } from './dom-shim.mjs';

setupDomShim();

import { BrowserShell } from '../packages/shared-ui/src/components/BrowserShell.js';

function installNativeBridge() {
  const calls = [];
  let eventHandler = null;
  window.yayra = {
    webview: {
      ensure: async (tabId, url) => { calls.push(['ensure', tabId, url]); return {}; },
      setBounds: async (tabId, bounds) => { calls.push(['setBounds', tabId, bounds]); },
      setVisible: async (tabId, visible) => { calls.push(['setVisible', tabId, visible]); },
      stop: async (tabId) => { calls.push(['stop', tabId]); },
      reload: async (tabId) => { calls.push(['reload', tabId]); },
      retry: async (tabId, url) => { calls.push(['reload', tabId, url]); return { ok: true, url }; },
      goBack: async () => {},
      goForward: async () => {},
      destroy: async () => {},
      capture: async () => ({}),
      onEvent: (handler) => { eventHandler = handler; return () => { eventHandler = null; }; }
    }
  };
  return { calls, emit: (event) => eventHandler?.(event) };
}

async function makeNativeShell(url = 'https://offline.example/presentation') {
  const bridge = installNativeBridge();
  const container = document.createElement('div');
  const shell = new BrowserShell({ container, initialUrl: url, isMobile: false });
  shell.showTransientNotice = () => {};
  await shell.initialize();
  shell.render(container);
  return { shell, container, ...bridge };
}

function countCalls(calls, type) {
  return calls.filter((call) => call[0] === type).length;
}

test('NETWORK RECOVERY: a native main-frame failure keeps the URL and replaces the blank surface with an informative page', async () => {
  const { shell, container, calls } = await makeNativeShell();
  try {
    const tab = shell.getActiveTab();
    const requestedUrl = 'https://offline.example/current-target?slide=7';
    shell.handleNativeWebviewEvent({
      tabId: tab.id,
      type: 'fail-load',
      url: requestedUrl,
      errorCode: -106,
      errorDescription: 'net::ERR_INTERNET_DISCONNECTED'
    });
    shell.render(container);

    assert.equal(tab.url, requestedUrl, 'the address stays on the site the user requested');
    assert.equal(shell.state.urlInputValue, requestedUrl, 'the omnibox retains that address too');
    assert.ok(shell._siteFailureFor(tab.id), 'the failure belongs to this tab');
    const recovery = shell.viewportElement.querySelector('.fb-network-recovery');
    assert.ok(recovery, 'an in-tab recovery surface replaces the failed native surface');
    assert.match(recovery.textContent, /No internet/);
    assert.match(recovery.textContent, /Checking the network cables, modem, and router/);
    assert.match(recovery.textContent, /ERR_INTERNET_DISCONNECTED/);
    assert.match(recovery.textContent, /reload this active site automatically/);
    assert.ok(calls.some((call) => call[0] === 'setVisible' && call[1] === tab.id && call[2] === false),
      'the failed native layer is hidden so it cannot cover the recovery page');
  } finally {
    shell.destroy();
    delete window.yayra;
  }
});

test('NETWORK RECOVERY: online immediately reloads only the active failed tab, with no overlapping attempt', async () => {
  const { shell, container, calls } = await makeNativeShell('https://retry.example/');
  try {
    const tab = shell.getActiveTab();
    shell.handleNativeWebviewEvent({
      tabId: tab.id,
      type: 'fail-load',
      url: tab.url,
      errorCode: -106,
      errorDescription: 'net::ERR_INTERNET_DISCONNECTED'
    });
    shell.render(container);
    calls.length = 0;

    shell._connectivityListeners.onOnline();
    assert.equal(countCalls(calls, 'reload'), 1, 'connectivity restoration starts the active failed URL immediately');
    assert.equal(calls.find((call) => call[0] === 'reload')?.[2], tab.url,
      'desktop retry explicitly reloads the retained target, even when Chromium committed no failed URL');
    assert.equal(shell._siteFailureFor(tab.id).inFlight, true);
    assert.equal(shell._retrySiteRecovery(tab.id, { reason: 'manual' }), false,
      'a second request cannot overlap the active recovery generation');
    assert.equal(countCalls(calls, 'reload'), 1);

    shell.handleNativeWebviewEvent({ tabId: tab.id, type: 'load-succeeded', url: tab.url });
    shell.render(container);
    assert.equal(shell._siteFailureFor(tab.id), null, 'positive main-frame completion clears recovery state and timers');
    assert.equal(shell.viewportElement.querySelector('.fb-network-recovery'), null);
    assert.ok(calls.some((call) => call[0] === 'setVisible' && call[1] === tab.id && call[2] === true),
      'the successful live site is revealed again');
  } finally {
    shell.destroy();
    delete window.yayra;
  }
});

test('NETWORK RECOVERY: connectivity changes never reload a healthy page or a failed background tab', async () => {
  const { shell, calls } = await makeNativeShell('https://healthy.example/');
  try {
    shell._connectivityListeners.onOnline();
    assert.equal(countCalls(calls, 'reload'), 0, 'a healthy loaded page is never refreshed on an online event');

    const failed = shell.getActiveTab();
    shell.handleNativeWebviewEvent({
      tabId: failed.id,
      type: 'fail-load',
      url: failed.url,
      errorCode: -106,
      errorDescription: 'net::ERR_INTERNET_DISCONNECTED'
    });
    shell.createNewTab();
    calls.length = 0;
    shell._connectivityListeners.onOnline();
    assert.equal(countCalls(calls, 'reload'), 0, 'background failure state is retained without an invisible reload');
    assert.ok(shell._siteFailureFor(failed.id), 'the background tab can recover when selected later');
  } finally {
    shell.destroy();
    delete window.yayra;
  }
});

test('NETWORK RECOVERY: explicit navigation cancels the stale URL, watchdog, and retry timer', async () => {
  const { shell } = await makeNativeShell('https://failed.example/');
  try {
    const tab = shell.getActiveTab();
    shell.handleNativeWebviewEvent({
      tabId: tab.id,
      type: 'fail-load',
      url: tab.url,
      errorCode: -105,
      errorDescription: 'net::ERR_NAME_NOT_RESOLVED'
    });
    const failure = shell._siteFailureFor(tab.id);
    assert.ok(failure?.retryTimer, 'bounded automatic retry is armed');

    shell.navigateActiveTab('https://replacement.example/');
    assert.equal(shell._siteFailureFor(tab.id), null);
    assert.equal(failure.retryTimer, null, 'the old timer is synchronously canceled');
    assert.equal(tab.url, 'https://replacement.example/');
  } finally {
    shell.destroy();
    delete window.yayra;
  }
});

test('NETWORK RECOVERY: web/PWA starts with a card while offline, retries hidden, then reveals the successful pooled frame', async () => {
  const previousNavigator = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  const connection = { onLine: false, userAgent: 'test' };
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: connection });
  delete window.yayra;
  const container = document.createElement('div');
  const shell = new BrowserShell({ container, initialUrl: 'https://frame.example/article', isMobile: false });
  shell.showTransientNotice = () => {};
  try {
    await shell.initialize();
    shell.render(container);
    const tab = shell.getActiveTab();
    assert.ok(shell.viewportElement.querySelector('.fb-network-recovery'));
    assert.equal(shell.webFrames.has(tab.id), false, 'offline first paint does not expose about:blank');

    connection.onLine = true;
    shell._connectivityListeners.onOnline();
    shell.render(container);
    const frame = shell.webFrames.get(tab.id);
    assert.ok(frame?.iframe, 'the retry frame is created behind the recovery page');
    assert.equal(shell.webFrameLayer.style.display, 'none', 'a retry frame cannot replace the card before success');

    frame.iframe.dispatchEvent({ type: 'load', target: frame.iframe });
    shell.render(container);
    assert.equal(shell._siteFailureFor(tab.id), null);
    assert.equal(shell.viewportElement.querySelector('.fb-network-recovery'), null);
    shell.syncWebFrameLayer();
    assert.equal(shell.webFrameLayer.style.display, 'block', 'the successful live frame becomes visible');
  } finally {
    shell.destroy();
    if (previousNavigator) Object.defineProperty(globalThis, 'navigator', previousNavigator);
    else delete globalThis.navigator;
  }
});

test('NETWORK RECOVERY source contract: retries are bounded, tab-scoped, and success has a distinct native event', () => {
  const shellSource = readFileSync(new URL('../packages/shared-ui/src/components/BrowserShell.js', import.meta.url), 'utf8');
  const bridgeSource = readFileSync(new URL('../electron/webviewBridge.cjs', import.meta.url), 'utf8');
  const androidSource = readFileSync(new URL('../packages/floating-android/src/kotlin/com/yayra/floating/android/YayraTabWebviewManager.kt', import.meta.url), 'utf8');
  const androidPluginSource = readFileSync(new URL('../packages/floating-android/src/kotlin/com/yayra/floating/android/YayraOverlayPlugin.kt', import.meta.url), 'utf8');
  assert.match(shellSource, /const delays = \[1500, 3000, 6000, 12000, 20000, 30000\]/,
    'automatic retries back off to a bounded 30-second ceiling');
  assert.match(shellSource, /tabId !== this\.state\.activeTabId/, 'background retry work is rejected');
  assert.match(shellSource, /failure\.url !== tab\.url/, 'stale URL generations are canceled');
  assert.match(bridgeSource, /did-finish-load[\s\S]{0,240}load-succeeded/,
    'Electron distinguishes positive completion from did-stop-loading');
  assert.match(androidSource, /onReceivedError[\s\S]{0,500}fail-load/,
    'Android reports main-frame failures to the same recovery state machine');
  assert.match(androidSource, /load-succeeded/, 'Android also has a positive completion signal');
  const androidFinished = androidSource.slice(
    androidSource.indexOf('override fun onPageFinished'),
    androidSource.indexOf('override fun doUpdateVisitedHistory')
  );
  assert.ok(androidFinished.indexOf('emitEvent(id, "navigated")') < androidFinished.indexOf('emitEvent(id, "load-succeeded")'),
    'Android publishes a redirected final URL before positive completion so recovery can validate it');
  assert.match(shellSource, /tabWebReload\(\{ id: tabId, url: failure\.url \}\)/,
    'Android recovery also receives the explicitly retained destination');
  assert.match(androidSource, /fun reload\(id: String, retainedUrl: String\? = null\)[\s\S]{0,800}entry\.webView\.loadUrl\(target\)/,
    'Android retries the retained URL instead of relying on a possibly uncommitted WebView location');
  assert.match(androidPluginSource, /tabWeb\(\)\?\.reload\(id, call\.getString\("url"\)\)/,
    'the Capacitor bridge forwards the retained destination to Android WebView');
});
