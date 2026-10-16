import test from 'node:test';
import assert from 'node:assert/strict';
import { setupDomShim } from './dom-shim.mjs';

setupDomShim();

import { BrowserShell } from '../packages/shared-ui/src/components/BrowserShell.js';

/**
 * Covers the renderer half of the native website-rendering engine (see
 * electron/webviewBridge.cjs for the main-process half). These tests verify
 * that:
 *  - without window.yayra.webview (plain web/PWA tab, or Android/iOS
 *    Capacitor WebView), the pre-existing <iframe> fallback renderer is used
 *    unchanged;
 *  - with window.yayra.webview present (Electron desktop), the main browser
 *    viewport NEVER creates an <iframe> for external content and instead
 *    drives the injected native bridge mock.
 */

function installFakeNativeWebview() {
  const calls = { ensure: [], setBounds: [], setVisible: [], capture: [], destroy: [], goBack: [], goForward: [], reload: [], stop: [] };
  let eventListener = null;
  const fake = {
    ensure: (tabId, url, isPrivate) => { calls.ensure.push({ tabId, url, isPrivate }); return Promise.resolve({ handedOffToSystemBrowser: false }); },
    setBounds: (tabId, bounds) => { calls.setBounds.push({ tabId, bounds }); return Promise.resolve(); },
    setVisible: (tabId, visible) => { calls.setVisible.push({ tabId, visible }); return Promise.resolve(); },
    capture: (tabId) => { calls.capture.push(tabId); return Promise.resolve({ snapshot: `data:image/png;base64,${tabId}` }); },
    goBack: (tabId) => { calls.goBack.push(tabId); return Promise.resolve(); },
    goForward: (tabId) => { calls.goForward.push(tabId); return Promise.resolve(); },
    reload: (tabId) => { calls.reload.push(tabId); return Promise.resolve(); },
    stop: (tabId) => { calls.stop.push(tabId); return Promise.resolve(); },
    destroy: (tabId) => { calls.destroy.push(tabId); return Promise.resolve(); },
    onEvent: (cb) => { eventListener = cb; return () => { eventListener = null; }; },
    emit: (evt) => { if (eventListener) eventListener(evt); }
  };
  globalThis.window.yayra = { webview: fake };
  return { fake, calls, uninstall: () => { delete globalThis.window.yayra; } };
}

test('Native engine ABSENT (web/PWA fallback): external navigation still renders the existing <iframe> path', async () => {
  delete globalThis.window.yayra;
  const container = document.createElement('div');
  const shell = new BrowserShell({ container, platform: 'linux', isMobile: false });
  await shell.initialize();
  shell.navigateActiveTab('https://example.com/');
  const el = shell.render(container);

  // The iframe lives in the persistent web-frame layer (a sibling of the
  // shell inside the container) so chrome re-renders never reload it -
  // query the container, not the shell element.
  assert.ok(container.querySelector('iframe'), 'falls back to an <iframe> when no native bridge is present');
  assert.ok(el.querySelector('.fb-web-frame-slot'), 'viewport renders the slot the frame layer tracks');
  assert.equal(el.querySelector('.fb-native-webview-slot'), null);
});

test('Web/PWA no-blink fix: re-rendering chrome REUSES the same <iframe> element and never resets its src', async () => {
  delete globalThis.window.yayra;
  const container = document.createElement('div');
  const shell = new BrowserShell({ container, platform: 'linux', isMobile: false });
  await shell.initialize();
  shell.navigateActiveTab('https://example.com/');
  shell.render(container);

  const frame = shell.webFrames.get(shell.getActiveTab().id);
  assert.ok(frame && frame.iframe, 'pooled frame exists for the active tab');
  const firstIframe = frame.iframe;
  const srcAfterFirstRender = firstIframe.src;

  // Simulate the exact user-visible bug: opening the Yayra menu (and the
  // update-check status flip) re-render the whole chrome.
  shell.state.isSideDrawerOpen = true;
  shell.render();
  shell.state.isSideDrawerOpen = false;
  shell.state.updateState = { ...shell.state.updateState, status: 'checking' };
  shell.render();

  const frameAfter = shell.webFrames.get(shell.getActiveTab().id);
  assert.equal(frameAfter.iframe, firstIframe, 'same iframe element across chrome re-renders (recreating it = full page reload / white flash)');
  assert.equal(frameAfter.iframe.src, srcAfterFirstRender, 'src untouched when the URL did not change');
  assert.equal(frameAfter.iframe.parentElement.parentElement, shell.webFrameLayer, 'frame stays in the persistent layer, never reparented into the rebuilt viewport');

  // Navigating the tab to a NEW url is the only thing allowed to set src.
  shell.navigateActiveTab('https://example.org/');
  const frameNav = shell.webFrames.get(shell.getActiveTab().id);
  assert.equal(frameNav.iframe, firstIframe, 'still the same element after navigation');
  assert.ok(String(frameNav.iframe.src).includes('example.org'), 'src updates on real navigation');
});

test('Web/PWA frame layer: hidden on internal pages, pruned when tabs close', async () => {
  delete globalThis.window.yayra;
  const container = document.createElement('div');
  const shell = new BrowserShell({ container, platform: 'linux', isMobile: false });
  await shell.initialize();
  shell.navigateActiveTab('https://example.com/');
  shell.render(container);
  assert.equal(shell.webFrameLayer.style.display, 'block', 'layer visible while an external page is active');

  const externalTabId = shell.getActiveTab().id;
  shell.openInternalPage('yayra://settings');
  assert.equal(shell.webFrameLayer.style.display, 'none', 'layer hidden when the active page is internal');
  assert.ok(shell.webFrames.has(externalTabId), 'frame for the tab is kept (back/forward must not reload)');

  shell.closeTab(externalTabId);
  assert.equal(shell.webFrames.has(externalTabId), false, 'frame removed when its tab closes');
});

test('Native engine PRESENT (Electron desktop): external navigation NEVER creates an <iframe> and drives the native bridge instead', async () => {
  const { calls, uninstall } = installFakeNativeWebview();
  try {
    const container = document.createElement('div');
    const shell = new BrowserShell({ container, platform: 'linux', isMobile: false });
    await shell.initialize();
    const activeTab = shell.getActiveTab();

    shell.navigateActiveTab('https://www.google.com/search?q=ghana');
    const el = shell.rootElement;

    assert.equal(el.querySelector('iframe'), null, 'no <iframe> is used for external content when the native engine is available - this is the actual fix for the X-Frame-Options failure');
    assert.ok(el.querySelector('.fb-native-webview-slot'), 'a native engine placeholder slot is rendered instead');
    assert.ok(calls.ensure.length >= 1);
    const lastCall = calls.ensure[calls.ensure.length - 1];
    assert.equal(lastCall.tabId, activeTab.id);
    assert.equal(lastCall.url, 'https://www.google.com/search?q=ghana');
  } finally {
    uninstall();
  }
});

test('Native engine: closing a tab destroys its native view', async () => {
  const { calls, uninstall } = installFakeNativeWebview();
  try {
    const container = document.createElement('div');
    const shell = new BrowserShell({ container, platform: 'windows', isMobile: false });
    await shell.initialize();
    const firstTabId = shell.getActiveTab().id;
    shell.navigateActiveTab('https://example.com/');
    shell.render(container);

    shell.createNewTab();
    shell.render(container);

    shell.closeTab(firstTabId);
    assert.ok(calls.destroy.includes(firstTabId));
  } finally {
    uninstall();
  }
});

test('Native engine: visiting an internal yayra:// page hides the active tab\'s native surface instead of leaving it floating on top', async () => {
  const { calls, uninstall } = installFakeNativeWebview();
  try {
    const container = document.createElement('div');
    const shell = new BrowserShell({ container, platform: 'linux', isMobile: false });
    await shell.initialize();
    const tabId = shell.getActiveTab().id;

    shell.navigateActiveTab('https://example.com/');
    shell.render(container);
    assert.ok(calls.setVisible.some((c) => c.tabId === tabId && c.visible === true));

    calls.setVisible.length = 0;
    shell.navigateActiveTab('yayra://settings');
    shell.render(container);
    assert.ok(calls.setVisible.some((c) => c.tabId === tabId && c.visible === false), 'native surface must be hidden behind internal pages');
  } finally {
    uninstall();
  }
});

test('Native overlays hide the active page immediately while fresh snapshots paint asynchronously', async () => {
  const { fake, calls, uninstall } = installFakeNativeWebview();
  let resolveCapture;
  fake.capture = (tabId) => {
    calls.capture.push(tabId);
    return new Promise((resolve) => { resolveCapture = resolve; });
  };
  try {
    const container = document.createElement('div');
    const shell = new BrowserShell({ container, platform: 'linux', isMobile: false });
    await shell.initialize();
    const tabId = shell.getActiveTab().id;
    shell.navigateActiveTab('https://example.com/');
    shell.render(container);

    calls.setVisible.length = 0;
    shell.state.isSideDrawerOpen = true;
    shell.render(container);

    assert.ok(calls.capture.includes(tabId), 'the existing asynchronous screenshot capture is retained');
    assert.ok(calls.setVisible.some((call) => call.tabId === tabId && call.visible === false), 'the native page is hidden before the screenshot promise resolves');
    const still = container.querySelector('.fb-page-snapshot-img');
    assert.ok(still, 'the page slot keeps a snapshot placeholder beneath the drawer');
    assert.equal(still.src || '', '', 'the new snapshot has not been awaited or painted yet');

    resolveCapture({ snapshot: 'data:image/png;base64,captured-page' });
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(still.src, 'data:image/png;base64,captured-page', 'the fresh snapshot paints after capture resolves');

    shell.state.isSideDrawerOpen = false;
    shell.render(container);
    shell.destroy();
  } finally {
    uninstall();
  }
});

test('Native engine: a "navigated" event from the main process updates tab URL, security state, and back/forward state', async () => {
  const { fake, uninstall } = installFakeNativeWebview();
  try {
    const container = document.createElement('div');
    const shell = new BrowserShell({ container, platform: 'linux', isMobile: false });
    await shell.initialize();
    const tab = shell.getActiveTab();
    shell.navigateActiveTab('https://example.com/');
    shell.render(container);

    fake.emit({ tabId: tab.id, type: 'navigated', url: 'https://example.com/deep-link', canGoBack: true, canGoForward: false });

    assert.equal(tab.url, 'https://example.com/deep-link');
    assert.equal(tab.isSecure, true);
    assert.equal(tab.canGoBack, true);
    assert.equal(tab.canGoForward, false);
  } finally {
    uninstall();
  }
});

test('Native engine: Google sign-in handoff preserves tab id, URL, active selection, history and a visible fallback', async () => {
  const { fake, calls, uninstall } = installFakeNativeWebview();
  try {
    fake.ensure = (tabId, url) => {
      calls.ensure.push({ tabId, url });
      return Promise.resolve({ handedOffToSystemBrowser: url.includes('accounts.google.com') });
    };
    const container = document.createElement('div');
    const shell = new BrowserShell({ container, platform: 'linux', isMobile: false });
    await shell.initialize();
    const tab = shell.getActiveTab();
    const tabId = tab.id;

    shell.navigateActiveTab('https://example.com/before-sign-in');
    shell.navigateActiveTab('https://accounts.google.com/signin/v2/identifier');
    const originalHistory = [...tab.navigationState.historyStack];
    const originalIndex = tab.navigationState.currentIndex;
    shell.render(container);
    shell.render(container);
    // Allow the ensure() promise microtask to resolve.
    await Promise.resolve();
    await Promise.resolve();

    assert.equal(tab.id, tabId);
    assert.equal(tab.url, 'https://accounts.google.com/signin/v2/identifier');
    assert.equal(shell.state.activeTabId, tabId);
    assert.deepEqual(tab.navigationState.historyStack, originalHistory);
    assert.equal(tab.navigationState.currentIndex, originalIndex);
    assert.equal(tab.canGoBack, true);
    assert.ok(shell.rootElement.querySelector('.fb-auth-handoff-fallback'), 'the tab explains why sign-in is external');
    assert.equal(calls.ensure.filter((call) => call.url === tab.url).length, 1, 're-rendering does not reopen the same auth URL');
    assert.ok(calls.setVisible.some((call) => call.tabId === tabId && call.visible === false), 'any previous native page surface is hidden, not painted over the fallback');
  } finally {
    uninstall();
  }
});

test('Native engine: reload() and stopLoading() delegate to the native bridge for a tab it controls', async () => {
  const { calls, uninstall } = installFakeNativeWebview();
  try {
    const container = document.createElement('div');
    const shell = new BrowserShell({ container, platform: 'linux', isMobile: false });
    await shell.initialize();
    const tabId = shell.getActiveTab().id;
    shell.navigateActiveTab('https://example.com/');
    shell.render(container);

    shell.reload();
    shell.stopLoading();

    assert.ok(calls.reload.includes(tabId));
    assert.ok(calls.stop.includes(tabId));
  } finally {
    uninstall();
  }
});
