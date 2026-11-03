import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { setupDomShim } from './dom-shim.mjs';

setupDomShim();

import { BrowserShell } from '../packages/shared-ui/src/components/BrowserShell.js';

/**
 * OFFLINE PROMPTING (user report): "when there is no internet connection,
 * it must prompt users so not to give blank pages".
 *
 * Before: opening a page while offline rendered a silent BLANK iframe
 * (the request fails, nothing explains why). After:
 *  1. A NEW page opened while offline shows an honest offline card with
 *     a Retry button - never a blank page.
 *  2. A page that is ALREADY LOADED stays live offline (the loaded-page
 *     contract is untouched).
 *  3. Going offline / coming back online is announced; the online event
 *     immediately retries only the active failed page. The recovery card
 *     remains until positive load completion; healthy live pages are never
 *     reloaded.
 */

function setOnline(v) {
  Object.defineProperty(globalThis, 'navigator', { value: { onLine: v }, configurable: true });
}

async function boot({ url = 'https://example.com/page' } = {}) {
  const container = document.createElement('div');
  const shell = new BrowserShell({ container, platform: 'linux', isMobile: false });
  await shell.initialize();
  shell.state.tabs[0].url = url;
  shell.render(container);
  return { shell, container };
}

test('OFFLINE: a NEW page shows the honest offline card - never a blank frame', async () => {
  setOnline(false);
  const { shell, container } = await boot();
  try {
    const card = shell.viewportElement.querySelector('.fb-offline-fallback');
    assert.ok(card, 'the offline card is shown in place of the page');
    assert.equal(shell.viewportElement.querySelector('iframe'), null, 'no blank iframe is created');
    assert.match(card.querySelector('.fb-offline-retry-btn').textContent, /Try again/);
    assert.match(card.textContent, /offline/i);
  } finally {
    setOnline(true);
    shell.destroy();
  }
});

test('OFFLINE: a page that already LOADED keeps its live frame when the connection drops', async () => {
  setOnline(true);
  const { shell, container } = await boot();
  try {
    const tabId = shell.state.tabs[0].id;
    assert.ok(shell.webFrames.has(tabId), 'the live pooled frame exists while online');
    const liveIframe = shell.webFrames.get(tabId).iframe;
    assert.ok(container.querySelector('iframe') || liveIframe, 'the page is rendered');

    setOnline(false);
    shell.render(container); // any re-render while offline
    assert.ok(shell.webFrames.has(tabId), 'the loaded frame is NEVER dropped');
    assert.equal(shell.webFrames.get(tabId).iframe, liveIframe, 'the exact same live frame object is kept');
    assert.equal(shell.viewportElement.querySelector('.fb-offline-fallback'), null,
      'a loaded page is not replaced by an offline card');
  } finally {
    setOnline(true);
    shell.destroy();
  }
});

test('OFFLINE -> ONLINE: the failed page retries immediately and stays covered until success', async () => {
  setOnline(false);
  const listeners = {};
  const origAdd = globalThis.window.addEventListener;
  globalThis.window.addEventListener = (type, fn) => { listeners[type] = fn; };
  let renders = 0;
  let shell = null;
  try {
    const container = document.createElement('div');
    shell = new BrowserShell({ container, platform: 'linux', isMobile: false });
    shell.showTransientNotice = () => {};
    await shell.initialize();
    shell.state.tabs[0].url = 'https://example.com/page';
    const realRender = shell.render.bind(shell);
    shell.render = (c) => { renders += 1; return realRender(c); };
    shell.render(container);
    assert.ok(shell.viewportElement.querySelector('.fb-offline-fallback'), 'offline card shown');
    assert.ok(listeners.online, 'the online listener is armed');

    setOnline(true);
    listeners.online(); // the connection returns
    assert.ok(renders >= 2, 'the failed destination starts a retry immediately');
    assert.ok(shell.viewportElement.querySelector('.fb-offline-fallback'),
      'the card remains visible while the hidden retry is still loading');
    const frame = shell.webFrames.get(shell.state.activeTabId);
    assert.ok(frame?.iframe, 'the retained URL is retrying in its persistent frame');
    frame.iframe.dispatchEvent({ type: 'load', target: frame.iframe });
    shell.render(container);
    assert.equal(shell.viewportElement.querySelector('.fb-offline-fallback'), null,
      'only positive load completion reveals the website');
  } finally {
    shell?.destroy();
    globalThis.window.addEventListener = origAdd;
    setOnline(true);
  }
});

test('OFFLINE EVENTS: dropping offline and coming back are announced to the user', async () => {
  setOnline(true);
  const listeners = {};
  const origAdd = globalThis.window.addEventListener;
  globalThis.window.addEventListener = (type, fn) => { listeners[type] = fn; };
  try {
    const container = document.createElement('div');
    const shell = new BrowserShell({ container, platform: 'linux', isMobile: false });
    await shell.initialize();
    const notices = [];
    shell.showTransientNotice = (msg) => notices.push(String(msg));
    assert.ok(listeners.offline && listeners.online, 'both connectivity listeners armed');

    listeners.offline();
    assert.ok(notices.some((n) => /offline/i.test(n)), 'going offline is announced');
    listeners.online();
    assert.ok(notices.some((n) => /back online/i.test(n)), 'coming back is announced');
    shell.destroy();
  } finally {
    globalThis.window.addEventListener = origAdd;
  }
});

test('OFFLINE DOCUMENT: a local file opens without network and connectivity changes leave its viewer and tabs untouched', async () => {
  const previousOnline = globalThis.navigator?.onLine;
  const previousYayra = window.yayra;
  const listeners = {};
  const originalAddEventListener = window.addEventListener;
  window.addEventListener = (type, callback) => { listeners[type] = callback; };
  setOnline(false);
  let shell = null;
  try {
    const bytes = new TextEncoder().encode('Saved local document content').buffer;
    window.yayra = {
      system: {
        documents: {
          openFile: async () => ({ ok: true, name: 'offline-notes.txt', data: bytes })
        }
      }
    };
    const container = document.createElement('div');
    shell = new BrowserShell({
      container,
      platform: 'linux',
      isMobile: false,
      documentRecoveryRepo: { save: async () => true }
    });
    const notices = [];
    shell.showTransientNotice = (message) => notices.push(String(message));
    await shell.initialize();
    const originalTabId = shell.getActiveTab().id;
    await shell.openDocument();

    const tab = shell.getActiveTab();
    assert.ok(tab.isDocument, 'the offline file picker still opens a first-class document tab');
    assert.equal(tab.title, 'offline-notes.txt');
    assert.ok(tab.url.startsWith('yayra://doc/'), 'local document routing never goes to a website frame');
    assert.ok(shell.viewportElement.querySelector('.fb-doc-viewer'), 'the bundled viewer renders while offline');
    assert.equal(shell.viewportElement.querySelector('.fb-offline-fallback'), null,
      'website offline recovery never replaces a local document');
    assert.equal(shell.webFrames.has(tab.id), false, 'no network frame is created for the file');
    assert.ok(shell.state.tabs.some((candidate) => candidate.id === originalTabId),
      'opening the file preserves the existing browser tab');

    const tabIds = shell.state.tabs.map((candidate) => candidate.id);
    const activeViewer = shell.viewportElement.querySelector('.fb-doc-viewer');
    let renders = 0;
    const render = shell.render.bind(shell);
    shell.render = (...args) => { renders += 1; return render(...args); };
    listeners.offline?.();
    listeners.online?.();

    assert.deepEqual(shell.state.tabs.map((candidate) => candidate.id), tabIds,
      'connectivity changes do not alter or replace tabs');
    assert.equal(shell.getActiveTab().id, tab.id, 'the document remains the active tab');
    assert.equal(shell.viewportElement.querySelector('.fb-doc-viewer'), activeViewer,
      'connectivity events do not remount or disturb the document viewer');
    assert.equal(renders, 0, 'document viewing does not trigger a connectivity repaint');
    assert.deepEqual(notices, [], 'online/offline website notices never cover a local document');
  } finally {
    shell?.destroy();
    window.addEventListener = originalAddEventListener;
    if (previousYayra === undefined) delete window.yayra;
    else window.yayra = previousYayra;
    setOnline(previousOnline !== false);
  }
});

test('SOURCE PIN: offline wins over every other frame strategy, and tab-scoped retry is wired', () => {
  const src = readFileSync(new URL('../packages/shared-ui/src/components/BrowserShell.js', import.meta.url), 'utf8');
  const fnStart = src.indexOf('createWebContentFrame(url, { frameClassName');
  const fn = src.slice(fnStart, src.indexOf('NATIVE WEBSITE-RENDERING ENGINE', fnStart));
  const offlineAt = fn.indexOf('buildOfflineFallback(url, { tabId, failure })');
  assert.ok(offlineAt > -1, 'the offline card exists in the frame pipeline');
  assert.ok(fn.indexOf('isKnownFrameBlockedUrl(url)') > offlineAt,
    'the offline check runs BEFORE the blocked-hosts strategy - no blank page can win');
  assert.ok(fn.indexOf('getSearchIntent(url)') > offlineAt,
    'the offline check runs BEFORE the search handoff');
  const pooled = src.indexOf('mountPooledWebFrame(webViewContainer, tab) {');
  const pooledFn = src.slice(pooled, pooled + 1100);
  assert.match(pooledFn, /!this\._onLine\(\).*webFrames\?\.has\(tab\.id\)\) return false/,
    'offline blocks NEW pooled frames but never reuses-blocks LOADED ones');
  assert.match(src, /_retrySiteRecovery\(activeFailure\.tabId, \{ reason: 'online' \}\)/,
    'connectivity restoration immediately retries only recorded failure state');
  assert.match(src, /const delays = \[1500, 3000, 6000, 12000, 20000, 30000\]/,
    'automatic retries use bounded backoff');
});
