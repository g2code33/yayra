/**
 * Smart, environment-aware loading UI.
 *
 * The reload button must KNOW the page state:
 *  - site loading  -> X (stop) that actually quits the load;
 *  - fully loaded  -> back to the refresh sign;
 * and the tab's icon slot shows a "time sign" (animated hourglass) the
 * moment loading starts, flipping back to the favicon when done.
 *
 * Regression being pinned: updateTabLoading() used to mutate
 * tab.isLoading WITHOUT touching the DOM, so loading-stop events from
 * native views / iframe load events left the toolbar stuck on the wrong
 * icon (an X on a fully loaded page) until some unrelated full render.
 * The fix updates the button and tab icon surgically in place - no
 * full re-render, no flicker.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { setupDomShim } from './dom-shim.mjs';

setupDomShim();

import { BrowserShell } from '../packages/shared-ui/src/components/BrowserShell.js';

async function makeShell() {
  delete globalThis.window.yayra;
  const container = document.createElement('div');
  const shell = new BrowserShell({ container, platform: 'linux', isMobile: false });
  await shell.initialize();
  const el = shell.render(container);
  return { shell, container, el };
}

function findTabIcon(el, tabId) {
  for (const tabEl of el.querySelectorAll('.fb-tab-item')) {
    const id = (tabEl.dataset && tabEl.dataset.tabId) || tabEl.getAttribute?.('data-tab-id');
    if (id === tabId) return tabEl.querySelector('.fb-tab-favicon');
  }
  return null;
}

test('loading starts: reload button becomes an X (stop) and the tab shows the hourglass time sign', async () => {
  const { shell, el } = await makeShell();
  const tab = shell.getActiveTab();

  shell.updateTabLoading(tab.id, true);

  const btn = el.querySelector('.fb-nav-reload');
  assert.equal(btn.getAttribute('aria-label'), 'Stop', 'button flips to Stop while loading');
  assert.match(btn.innerHTML, /line x1="18"/, 'X (stop) icon shown');
  const icon = findTabIcon(el, tab.id);
  assert.ok(icon, 'tab icon slot found');
  assert.match(icon.innerHTML, /fb-tab-loading-hourglass/, 'hourglass time sign while loading');
});

test('fully loaded: button flips BACK to the refresh sign in place (the stuck-X regression)', async () => {
  const { shell, el } = await makeShell();
  const tab = shell.getActiveTab();

  shell.updateTabLoading(tab.id, true);
  // This is how native loading-stop events and iframe load events arrive -
  // WITHOUT any full re-render around them.
  shell.updateTabLoading(tab.id, false);

  const btn = el.querySelector('.fb-nav-reload');
  assert.equal(btn.getAttribute('aria-label'), 'Reload', 'button returns to Reload when fully loaded');
  assert.doesNotMatch(btn.innerHTML, /line x1="18"/, 'no X anymore');
  assert.match(btn.innerHTML, /M21 12a9 9/, 'refresh icon restored');
  const icon = findTabIcon(el, tab.id);
  assert.doesNotMatch(icon.innerHTML, /fb-tab-loading-hourglass/, 'hourglass gone once loaded');
});

test('clicking the X while loading stops the load and restores the refresh sign immediately', async () => {
  const { shell, el } = await makeShell();
  const tab = shell.getActiveTab();

  shell.updateTabLoading(tab.id, true);
  const btn = el.querySelector('.fb-nav-reload');
  btn.click(); // acts as STOP because the page is loading

  assert.equal(tab.isLoading, false, 'load quit');
  assert.equal(btn.getAttribute('aria-label'), 'Reload', 'back to refresh immediately, not stuck as X');
});

test('Escape stops a loading site when no browser overlay is open', async () => {
  const { shell, el } = await makeShell();
  const tab = shell.getActiveTab();
  shell.updateTabLoading(tab.id, true);
  let prevented = false;
  shell.handleGlobalKeyDown({
    key: 'Escape', ctrlKey: false, metaKey: false, shiftKey: false, altKey: false,
    preventDefault: () => { prevented = true; }
  });
  assert.equal(tab.isLoading, false);
  assert.equal(prevented, true);
  assert.equal(el.querySelector('.fb-nav-reload').getAttribute('aria-label'), 'Reload');
});

test('environment-aware stop: native Electron tabs get a real webContents stop()', async () => {
  const stops = [];
  globalThis.window.yayra = {
    webview: {
      ensure: async () => ({}),
      setBounds: async () => {},
      setVisible: async () => {},
      stop: async (tabId) => { stops.push(tabId); },
      goBack: async () => {}, goForward: async () => {}, reload: async () => {},
      destroy: async () => {}, capture: async () => ({}),
      onEvent: () => () => {}
    }
  };
  try {
    const container = document.createElement('div');
    const shell = new BrowserShell({ container, platform: 'linux', isMobile: false });
    await shell.initialize();
    shell.render(container);
    const tab = shell.getActiveTab();
    shell._nativeWebviewTabIds.add(tab.id);
    shell.updateTabLoading(tab.id, true);

    shell.stopLoading();

    assert.deepEqual(stops, [tab.id], 'native stop() invoked for the native view');
    assert.equal(tab.isLoading, false, 'UI state flips immediately, without waiting for the event');
  } finally {
    delete globalThis.window.yayra;
  }
});

test('only a REAL state change touches the DOM (no churn on repeated identical events)', async () => {
  const { shell, el } = await makeShell();
  const tab = shell.getActiveTab();
  shell.updateTabLoading(tab.id, true);
  const btn = el.querySelector('.fb-nav-reload');
  btn.innerHTML = 'SENTINEL';
  // Same state again -> must NOT rewrite the button.
  shell.updateTabLoading(tab.id, true);
  assert.equal(btn.innerHTML, 'SENTINEL', 'identical loading events are no-ops for the DOM');
});

test('every site loading strip is permanently mounted and follows engine events live without a render or refresh', async () => {
  const { shell, el } = await makeShell();
  const tab = shell.getActiveTab();
  tab.url = 'https://live.example/';
  const bars = [...el.querySelectorAll('.fb-page-loading-bar')];
  assert.ok(bars.length >= 2, 'desktop has a viewport strip plus a chrome-owned strip above native site surfaces');
  assert.ok(bars.every((bar) => bar.style.display === 'none'), 'idle strips are mounted but hidden');

  const rootBefore = shell.rootElement;
  shell.handleNativeWebviewEvent({ tabId: tab.id, type: 'loading-start' });
  assert.equal(shell.rootElement, rootBefore, 'loading-start never rebuilds or refreshes the site');
  assert.ok(bars.every((bar) => bar.style.display === 'block'), 'all strips turn on in the same event turn');
  assert.equal(el.querySelector('.fb-browser-viewport').getAttribute('aria-busy'), 'true');

  shell.handleNativeWebviewEvent({ tabId: tab.id, type: 'loading-stop' });
  assert.equal(shell.rootElement, rootBefore, 'loading-stop is also surgical');
  assert.ok(bars.every((bar) => bar.style.display === 'none'), 'all strips settle immediately');
  assert.equal(el.querySelector('.fb-browser-viewport').getAttribute('aria-busy'), 'false');
});

test('background site loading is live in its tab without disturbing the active site toolbar', async () => {
  const { shell, container } = await makeShell();
  const active = shell.getActiveTab();
  const background = {
    id: 'tab-background-live',
    title: 'Live dashboard',
    url: 'https://dashboard.example/',
    isSecure: true,
    canGoBack: false,
    canGoForward: false,
    isLoading: false,
    isPrivate: false,
    favicon: null
  };
  shell.state.tabs.push(background);
  const el = shell.render(container);
  const activeReload = el.querySelector('.fb-nav-reload');

  shell.updateTabLoading(background.id, true);
  assert.equal(activeReload.getAttribute('aria-label'), 'Reload', 'background activity never changes active controls');
  assert.match(findTabIcon(el, background.id).innerHTML, /fb-tab-loading-hourglass/,
    'background tab advertises its real engine state immediately');

  shell.updateTabLoading(background.id, false);
  assert.doesNotMatch(findTabIcon(el, background.id).innerHTML, /fb-tab-loading-hourglass/,
    'background tab settles without selecting or refreshing it');
  assert.equal(shell.getActiveTab(), active);
});

test('the popup mini follows the same live loading state and its X really stops the site', async () => {
  const { shell, container } = await makeShell();
  const tab = shell.getActiveTab();
  shell.state.isFloatingMiniOpen = true;
  shell.render(container);
  const mini = document.getElementById('yayra-floating-popup-window');
  assert.ok(mini, 'popup mini is open');
  const button = mini.querySelector('.fb-mini-reload-btn');
  assert.equal(button.getAttribute('aria-label'), 'Reload');

  shell.updateTabLoading(tab.id, true);
  assert.equal(button.getAttribute('aria-label'), 'Stop', 'mini updates in the same engine event turn');
  assert.match(button.innerHTML, /line x1="18"/);
  button.click();
  assert.equal(tab.isLoading, false, 'mini stop action settles the shared live site immediately');
  assert.equal(button.getAttribute('aria-label'), 'Reload');
  shell.closeFloatingMini();
  shell.destroy();
});

test('live-sites mode disables native background throttling by default', async () => {
  const calls = [];
  globalThis.window.yayra = {
    webview: {
      ensure: async () => ({}), setBounds: async () => {}, setVisible: async () => {},
      stop: async () => {}, goBack: async () => {}, goForward: async () => {}, reload: async () => {},
      destroy: async () => {}, capture: async () => ({}), onEvent: () => () => {},
      setBackgroundThrottling: async (enabled) => { calls.push(enabled); return { ok: true, enabled }; }
    }
  };
  const container = document.createElement('div');
  const shell = new BrowserShell({ container, platform: 'linux', isMobile: false });
  try {
    await shell.initialize();
    shell.render(container);
    assert.equal(shell.state.settings.keepSitesLive, true);
    assert.equal(shell.state.settings.backgroundTabThrottling, false);
    assert.deepEqual(calls, [false], 'every native site is kept live before the first page view is created');
  } finally {
    shell.destroy();
    delete globalThis.window.yayra;
  }
});
