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

function installFakeNativeWebview({ auth = null } = {}) {
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
  globalThis.window.yayra = { webview: fake, ...(auth ? { auth } : {}) };
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

test('Native page yields to the tab-group name prompt and returns after Save', async () => {
  const { calls, uninstall } = installFakeNativeWebview();
  try {
    const container = document.createElement('div');
    const shell = new BrowserShell({ container, platform: 'linux', isMobile: false });
    await shell.initialize();
    const tab = shell.getActiveTab();
    shell.navigateActiveTab('https://example.com/');
    shell.render(container);
    calls.setVisible.length = 0;

    const prompt = shell._textPromptDialog({ title: 'New tab group', placeholder: 'Research' });
    const overlay = document.body.querySelector('.fb-text-prompt-overlay');
    assert.ok(overlay, 'the accessible prompt is mounted in the document');
    assert.equal(shell.state.isPageObscured, true, 'native content is marked as obscured');
    assert.ok(calls.setVisible.some((call) => call.tabId === tab.id && call.visible === false), 'native page hides so the prompt can receive clicks');

    shell.render(container);
    assert.equal(shell.healStuckPageSurface(), false, 'a live text prompt prevents the stuck-surface healer from uncovering the page');
    assert.equal(shell.state.isPageObscured, true);

    const input = overlay.querySelector('input');
    input.value = 'Research';
    [...overlay.querySelectorAll('button')].find((button) => button.textContent === 'Save').click();
    assert.equal(await prompt, 'Research');
    assert.equal(shell.state.isPageObscured, false, 'native page is restored after Save');
    assert.ok(calls.setVisible.some((call) => call.tabId === tab.id && call.visible === true), 'the live website comes back after the overlay is removed');
    shell.destroy();
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

test('Install-as-app confirmation hides the native page and restores it after the user confirms', async () => {
  const { calls, uninstall } = installFakeNativeWebview();
  try {
    const container = document.createElement('div');
    const shell = new BrowserShell({ container, platform: 'linux', isMobile: false });
    await shell.initialize();
    const tabId = shell.getActiveTab().id;
    shell.navigateActiveTab('https://example.com/app');
    shell.render(container);
    calls.setVisible.length = 0;

    const choice = shell._installPageAsAppDialog({ title: 'Example App', url: 'https://example.com/app' });
    const overlay = document.getElementById('yayra-install-app-overlay');
    assert.ok(overlay, 'the app-install dialog is mounted');
    assert.equal(shell.state.isPageObscured, true, 'the dialog participates in the native-surface visibility state');
    assert.ok(calls.setVisible.some((call) => call.tabId === tabId && call.visible === false), 'native page hides immediately so the dialog can be clicked');

    overlay.querySelector('.fb-install-app-name').value = 'Example';
    overlay.querySelector('.fb-btn-primary').click();
    assert.equal(await choice, 'Example', 'the chosen app name resolves from the Install button');
    assert.equal(document.getElementById('yayra-install-app-overlay'), null, 'confirmation is removed after the choice');
    assert.equal(shell.state.isPageObscured, false, 'closing the dialog restores the page state');
    assert.ok(calls.setVisible.some((call) => call.tabId === tabId && call.visible === true), 'native page becomes visible again');
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

test('Native engine: direct Google auth system-browser flow preserves tab id, URL, active selection, history and fallback', async () => {
  const { fake, calls, uninstall } = installFakeNativeWebview();
  try {
    fake.ensure = (tabId, url) => {
      calls.ensure.push({ tabId, url });
      return Promise.resolve({ handedOffToSystemBrowser: true });
    };
    const container = document.createElement('div');
    const shell = new BrowserShell({ container, platform: 'linux', isMobile: false });
    await shell.initialize();
    const tab = shell.getActiveTab();
    const tabId = tab.id;

    shell.navigateActiveTab('https://example.com/before-sign-in');
    shell.navigateActiveTab('https://accounts.google.com/o/oauth2/v2/auth?client_id=site-client');
    const originalHistory = [...tab.navigationState.historyStack];
    const originalIndex = tab.navigationState.currentIndex;
    shell.render(container);
    shell.render(container);
    // Allow the ensure() promise microtask to resolve.
    await Promise.resolve();
    await Promise.resolve();

    assert.equal(tab.id, tabId);
    assert.equal(tab.url, 'https://accounts.google.com/o/oauth2/v2/auth?client_id=site-client');
    assert.equal(shell.state.activeTabId, tabId);
    assert.deepEqual(tab.navigationState.historyStack, originalHistory);
    assert.equal(tab.navigationState.currentIndex, originalIndex);
    assert.equal(tab.canGoBack, true);
    const authCard = shell.rootElement.querySelector('.fb-auth-handoff-fallback');
    assert.ok(authCard, 'the source tab explains the secure external-user-agent flow');
    assert.match(authCard.textContent, /secure system browser/i);
    assert.match(authCard.textContent, /never copies browser cookies/i);
    assert.equal(calls.ensure.filter((call) => call.url === tab.url).length, 1, 're-rendering does not reopen the same auth URL');
    assert.ok(calls.setVisible.some((call) => call.tabId === tabId && call.visible === false), 'any previous native page surface is hidden, not painted over the fallback');
  } finally {
    uninstall();
  }
});

test('Yayra account UI explains the secure external user-agent and turns cancellation into clear live copy', async () => {
  const { uninstall } = installFakeNativeWebview();
  try {
    const container = document.createElement('div');
    const shell = new BrowserShell({ container, platform: 'linux', isMobile: false });
    await shell.initialize();
    window.yayra.auth = {};
    shell.state.googleAccount = { status: 'signing-in' };
    const waiting = shell.renderGoogleAccountSectionHtml();
    assert.match(waiting, /secure browser page/i);
    assert.match(waiting, /verified callback/i);
    assert.match(waiting, /update automatically/i);

    shell.state.googleAccount = { status: 'error', error: 'sign_in_cancelled' };
    const cancelled = shell.renderGoogleAccountSectionHtml();
    assert.match(cancelled, /closed before it finished/i);
    assert.doesNotMatch(cancelled, /sign_in_cancelled/);
    shell.destroy();
  } finally {
    uninstall();
  }
});

test('Google profile fields are escaped before account HTML and avatar markup are rendered', async () => {
  const { uninstall } = installFakeNativeWebview();
  try {
    const container = document.createElement('div');
    const shell = new BrowserShell({ container, platform: 'linux', isMobile: false });
    await shell.initialize();
    window.yayra.auth = {};
    shell.state.googleAccount = {
      status: 'signed-in',
      profile: {
        sub: '1',
        name: '<img src=x onerror=alert(1)>',
        email: 'attacker@example.com<script>',
        picture: 'javascript:alert(2)'
      }
    };
    const html = shell.renderGoogleAccountSectionHtml();
    assert.doesNotMatch(html, /<img src=x onerror/);
    assert.match(html, /&lt;img src=x onerror=alert\(1\)&gt;/);
    assert.doesNotMatch(html, /onerror=alert\(2\)/);
    shell.destroy();
  } finally {
    uninstall();
  }
});

test('Native engine: Google Account navigation completes Yayra OAuth and replaces the dead embedded page with connected state', async () => {
  const listeners = new Set();
  let signInCalls = 0;
  const profile = { sub: 'g-1', email: 'connected@example.com', name: 'Connected User' };
  const auth = {
    getSession: async () => ({ signedIn: false }),
    onEvent: (listener) => { listeners.add(listener); return () => listeners.delete(listener); },
    signIn: async () => {
      signInCalls += 1;
      for (const listener of listeners) listener({ type: 'signing-in' });
      for (const listener of listeners) listener({ type: 'signed-in', profile });
      return { ok: true, profile };
    },
    signOut: async () => ({ ok: true }),
    openAccountPage: async () => ({ ok: true }),
    openGoogleProduct: async () => ({ ok: true })
  };
  const { calls, uninstall } = installFakeNativeWebview({ auth });
  let persistedTabs = null;
  const sessionRepo = {
    getLastSession: async () => ({ tabs: [], savedAt: null }),
    saveSession: async (tabs) => { persistedTabs = tabs; }
  };
  try {
    const container = document.createElement('div');
    const shell = new BrowserShell({ container, platform: 'linux', isMobile: false, sessionRepo });
    await shell.initialize();

    shell.navigateActiveTab('https://accounts.google.com/');
    assert.ok(shell.rootElement.querySelector('.fb-google-account-connection'), 'the account tab gets a first-party connection surface');
    assert.equal(shell.rootElement.querySelector('.fb-auth-handoff-fallback'), null, 'the old callback-less handoff card is gone');
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));

    assert.equal(signInCalls, 1, 'typed account navigation starts the callback-returning flow once');
    assert.ok(persistedTabs?.some((entry) => entry.url === 'https://accounts.google.com/'),
      'the account tab is persisted before a Web/PWA full-page OAuth redirect can replace the document');
    assert.equal(shell.state.googleAccount.signedIn, true);
    assert.equal(shell.state.googleAccount.profile.email, profile.email);
    assert.equal(calls.ensure.some((call) => call.url.includes('accounts.google.com')), false,
      'the Google Account page that cannot receive Chrome cookies is never loaded in WebContentsView');
    assert.match(shell.rootElement.querySelector('.fb-google-account-connection').textContent, /Google is connected to Yayra/);

    shell.render();
    shell.render();
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(signInCalls, 1, 'chrome re-renders never reopen OAuth');

    shell.navigateActiveTab('https://accounts.google.com/ManageAccount');
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(signInCalls, 1, 'an already-connected profile is shown immediately without another consent loop');
  } finally {
    uninstall();
  }
});

test('Native engine: Google product login redirect starts Yayra connection and clears the canceled embedded load', async () => {
  const listeners = new Set();
  let continuedOrigin = null;
  const auth = {
    getSession: async () => ({ signedIn: false }),
    onEvent: (listener) => { listeners.add(listener); return () => listeners.delete(listener); },
    signIn: async () => ({ ok: true, pending: true }),
    signOut: async () => ({ ok: true }),
    openAccountPage: async () => ({ ok: true }),
    openGoogleProduct: async (origin) => { continuedOrigin = origin; return { ok: true }; }
  };
  const { fake, uninstall } = installFakeNativeWebview({ auth });
  try {
    const container = document.createElement('div');
    const shell = new BrowserShell({ container, platform: 'linux', isMobile: false });
    await shell.initialize();
    const tab = shell.getActiveTab();
    shell.navigateActiveTab('https://mail.google.com/');
    assert.equal(tab.isLoading, true, 'omnibox navigation starts the loader');

    fake.emit({ tabId: tab.id, type: 'loading-start' });
    fake.emit({ tabId: tab.id, type: 'loading-stop' });
    fake.emit({ tabId: tab.id, type: 'google-account-auth-required', provider: 'google', reason: 'navigation' });
    shell.render();

    assert.equal(tab.isLoading, false, 'the canceled ServiceLogin cannot leave the source tab spinner stuck');
    assert.equal(tab.url, 'https://mail.google.com/', 'the product URL is preserved for secure continuation');
    assert.equal(shell.state.activeTabId, tab.id);
    assert.ok(shell._nativeWebviewTabIds.has(tab.id), 'the source WebContentsView remains associated for cleanup');
    assert.ok(shell.rootElement.querySelector('.fb-google-account-connection'), 'the stale product surface is hidden by connection state');

    for (const listener of listeners) listener({ type: 'signed-in', profile: { sub: 'g-product', email: 'person@example.com' } });
    shell.rootElement.querySelector('.fb-google-account-continue-btn')?.click();
    await Promise.resolve();
    assert.equal(continuedOrigin, 'https://mail.google.com/',
      'continuation passes only the credential-free product origin to the native bridge');
    assert.ok(fake, 'native event source remains alive');
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
