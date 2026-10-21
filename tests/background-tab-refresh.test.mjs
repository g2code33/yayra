/**
 * CHROME-STYLE TAB KEEP-ALIVE (user reversal of the old auto-refresh):
 * "every page once loaded must stay intact and active and functional
 *  without loading again - the same as how Chrome works."
 *
 *  1. A loaded page is NEVER reloaded in the background, no matter how
 *     long it sits: no timer exists, no method exists, the pooled
 *     iframe's src is never touched across renders/switches/time.
 *  2. Memory is bounded the Chrome way: an LRU cap on live pooled
 *     frames; a discarded tab re-mounts FRESH, visibly, on switch-back
 *     (never a silent background reload of a live page; the active
 *     frame is untouchable).
 *  3. The old Settings toggle is gone (no dead setting UI).
 *  4. Reload smoothness (P35, unchanged): a same-URL 'navigated' event
 *     must NOT trigger a full chrome re-render, 'title-updated' patches
 *     the tab label surgically.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { setupDomShim } from './dom-shim.mjs';

setupDomShim();

import { BrowserShell } from '../packages/shared-ui/src/components/BrowserShell.js';

function makeNativeWebviewFake(calls) {
  return {
    ensure: async () => ({}),
    setBounds: async () => {},
    setVisible: async () => {},
    stop: async () => {},
    goBack: async () => {},
    goForward: async () => {},
    reload: async (tabId) => { calls.push(tabId); },
    destroy: async () => {},
    capture: async () => ({}),
    onEvent: () => () => {}
  };
}

async function makeShell(reloadCalls) {
  globalThis.window.yayra = { webview: makeNativeWebviewFake(reloadCalls) };
  const container = document.createElement('div');
  const shell = new BrowserShell({ container, platform: 'linux', isMobile: false });
  await shell.initialize();
  shell.render(container);
  return shell;
}

test('CHROME KEEP-ALIVE: the background auto-reload machinery is GONE - no timer, no method, no reloads ever fire on their own', async () => {
  const reloads = [];
  const shell = await makeShell(reloads);
  try {
    assert.equal('autoRefreshBackgroundTabs' in shell, false, 'the auto-reload method no longer exists');
    assert.equal(shell._tabAutoRefreshTimer, undefined, 'no auto-reload timer is ever armed');
    shell.startBackgroundRefresh();
    assert.equal(shell._tabAutoRefreshTimer, undefined, 'starting background services arms no reload timer');
    shell.stopBackgroundRefresh();

    // Even deeply "stale" tabs (hours old stamps, the old trigger) are
    // never reloaded by the shell itself.
    shell.createNewTab();
    const bgTab = shell.state.tabs[shell.state.tabs.length - 1];
    shell.state.activeTabId = shell.state.tabs[0].id;
    bgTab.url = 'https://scores.example.com/';
    bgTab.lastLoadCompletedAt = Date.now() - 60 * 60 * 1000; // legacy stamp
    shell._nativeWebviewTabIds.add(bgTab.id);
    await new Promise((r) => setTimeout(r, 30));
    assert.deepEqual(reloads, [], 'nothing reloads a tab behind the user\'s back');
  } finally {
    shell.destroy();
    delete globalThis.window.yayra;
  }
});

test('CHROME KEEP-ALIVE: a loaded pooled page stays INTACT across renders, tab switches and time - src never touched, same live DOM node', async () => {
  delete globalThis.window.yayra; // iframe engine (web/PWA/Android), not native
  const container = document.createElement('div');
  const shell = new BrowserShell({ container, platform: 'android', isMobile: true });
  await shell.initialize();
  try {
    shell.state.tabs[0].url = 'https://app.example.com/dashboard';
    shell.render(container);
    const frameA = shell.webFrames.get(shell.state.tabs[0].id);
    assert.ok(frameA, 'pooled frame mounted');
    const nodeA = frameA.iframe;

    // Ten full re-renders + a tab switch away and back: the page must be
    // the SAME live DOM node with an untouched src - zero reloads.
    shell.createNewTab();
    const second = shell.state.tabs[shell.state.tabs.length - 1];
    second.url = 'https://other.example.com/';
    for (let i = 0; i < 10; i += 1) shell.render(container);
    shell.selectTab(shell.state.tabs[0].id);
    shell.render(container);
    const frameB = shell.webFrames.get(shell.state.tabs[0].id);
    assert.ok(frameB, 'frame still pooled after renders + switch');
    assert.equal(frameB.iframe, nodeA, 'the SAME live iframe survives - the page was never destroyed');
    assert.equal(frameB.iframe.src, 'https://app.example.com/dashboard', 'src untouched: no reload, ever');
    assert.equal(frameB.url, 'https://app.example.com/dashboard');
  } finally {
    shell.destroy();
  }
});

test('POOLED SITE LIFECYCLE: a real iframe navigation starts and settles loading live without a chrome refresh', async () => {
  delete globalThis.window.yayra;
  const container = document.createElement('div');
  const shell = new BrowserShell({ container, platform: 'pwa', isMobile: false });
  await shell.initialize();
  try {
    const tab = shell.getActiveTab();
    tab.url = 'https://live.example.com/stream';
    const root = shell.render(container);
    const frame = shell.webFrames.get(tab.id);
    assert.ok(frame, 'live pooled frame exists');
    assert.equal(tab.isLoading, true, 'touching iframe.src starts loading state immediately');
    assert.equal(root.querySelector('.fb-nav-reload').getAttribute('aria-label'), 'Stop');

    const rootBefore = shell.rootElement;
    frame.iframe.dispatchEvent({ type: 'load' });
    assert.equal(tab.isLoading, false, 'the iframe load event settles the site');
    assert.equal(shell.rootElement, rootBefore, 'settling never reconstructs the site or browser chrome');
    assert.equal(root.querySelector('.fb-nav-reload').getAttribute('aria-label'), 'Reload');
  } finally {
    shell.destroy();
  }
});

test('CHROME KEEP-ALIVE: memory saver LRU - beyond the cap only the OLDEST background frames are discarded; the active frame is untouchable; a discarded tab re-mounts fresh on return', async () => {
  delete globalThis.window.yayra;
  const container = document.createElement('div');
  const shell = new BrowserShell({ container, platform: 'android', isMobile: true });
  await shell.initialize();
  try {
    const urls = [];
    const cap = BrowserShell.MAX_POOLED_FRAMES;
    for (let i = 0; i < cap + 2; i += 1) {
      shell.createNewTab();
      const tab = shell.state.tabs[shell.state.tabs.length - 1];
      tab.url = `https://site${i}.example.com/`;
      urls.push({ id: tab.id, url: tab.url });
      shell.render(container); // mounts + stamps this frame as most-recent
    }
    assert.ok(shell.webFrames.size <= cap, `pool is bounded at ${cap} live frames (got ${shell.webFrames.size})`);
    // The active (newest) tab's frame is alive; the two oldest background
    // frames were the ones discarded.
    assert.ok(shell.webFrames.has(urls[urls.length - 1].id), 'active tab frame survives');
    assert.equal(shell.webFrames.has(urls[0].id), false, 'oldest frame discarded by the LRU');
    assert.equal(shell.webFrames.has(urls[1].id), false, 'second-oldest frame discarded by the LRU');
    // Every other frame stayed LIVE (no mass destruction).
    for (let i = 2; i < urls.length - 1; i += 1) {
      assert.ok(shell.webFrames.has(urls[i].id), `frame ${i} still alive`);
    }

    // Switching back to a discarded tab re-mounts it FRESH (a visible,
    // on-demand load - Chrome memory-saver semantics), and the previously
    // discarded sibling stays discarded (no background mass reload).
    shell.selectTab(urls[0].id);
    shell.render(container);
    const revived = shell.webFrames.get(urls[0].id);
    assert.ok(revived, 'discarded tab re-mounts on switch-back');
    assert.equal(revived.url, urls[0].url, 'and loads its URL on demand');
    assert.equal(shell.webFrames.has(urls[1].id), false, 'still-idle sibling stays discarded - no background reloads');
  } finally {
    shell.destroy();
  }
});

test('CHROME KEEP-ALIVE: the Settings page no longer shows the removed auto-refresh toggle (no dead setting UI)', async () => {
  const reloads = [];
  const shell = await makeShell(reloads);
  try {
    shell.openInternalPage('yayra://settings');
    shell.render(shell.container);
    assert.equal(shell.rootElement.querySelector('#fb-in-set-auto-refresh-tabs'), null, 'toggle removed from Settings');
  } finally {
    shell.destroy();
    delete globalThis.window.yayra;
  }
});

test('reload smoothness: a same-URL navigated event does NOT full-render (no blink), a real URL change does', async () => {
  const reloads = [];
  const shell = await makeShell(reloads);
  try {
    const tab = shell.getActiveTab();
    tab.url = 'https://example.com/';
    tab.isPrivate = true; // keep history recording out of this test

    let renders = 0;
    const originalRender = shell.render.bind(shell);
    shell.render = (...args) => { renders += 1; return originalRender(...args); };

    shell.handleNativeWebviewEvent({ tabId: tab.id, type: 'navigated', url: 'https://example.com/', canGoBack: true, canGoForward: false });
    assert.equal(renders, 0, 'reload (same URL) must not rebuild the chrome');

    shell.handleNativeWebviewEvent({ tabId: tab.id, type: 'navigated', url: 'https://example.com/other', canGoBack: true, canGoForward: false });
    assert.equal(renders, 1, 'a real navigation still renders fully');
  } finally {
    shell.destroy();
    delete globalThis.window.yayra;
  }
});

test('title-updated patches the tab label in place instead of re-rendering everything', async () => {
  const reloads = [];
  const shell = await makeShell(reloads);
  try {
    const tab = shell.getActiveTab();

    let renders = 0;
    const originalRender = shell.render.bind(shell);
    shell.render = (...args) => { renders += 1; return originalRender(...args); };

    shell.handleNativeWebviewEvent({ tabId: tab.id, type: 'title-updated', title: 'New Title' });
    assert.equal(renders, 0, 'no full render for a title change');
    assert.equal(shell.rootElement.querySelector('.fb-active-tab .fb-tab-title, .fb-tab.active .fb-tab-title')?.textContent || tab.title, 'New Title');
  } finally {
    shell.destroy();
    delete globalThis.window.yayra;
  }
});

test('TAB-ID UNIQUENESS (production freeze/lag class): rapid same-millisecond tab creation never collides - no aliased frames, ever', async () => {
  delete globalThis.window.yayra;
  const container = document.createElement('div');
  const shell = new BrowserShell({ container, platform: 'android', isMobile: true });
  await shell.initialize();
  try {
    // 30 back-to-back tabs: ids must be unique BY CONSTRUCTION even when
    // many land in the same millisecond (the old `tab-${Date.now()}`
    // collided here, aliasing tabs onto one shared pooled frame).
    for (let i = 0; i < 30; i += 1) shell.createNewTab();
    const ids = shell.state.tabs.map((t) => t.id);
    assert.equal(new Set(ids).size, ids.length, 'every tab id is unique');

    // And the frame pool stays 1:1 with tabs under rapid creation.
    for (const t of shell.state.tabs) t.url = `https://p${t.id}.example.com/`;
    shell.render(container);
    for (const t of shell.state.tabs) shell.selectTab(t.id);
    shell.render(container);
    const frameIds = new Set(Array.from(shell.webFrames.keys()));
    for (const id of ids) {
      if (frameIds.has(id)) {
        assert.equal(shell.webFrames.get(id).url, `https://p${id}.example.com/`, 'no frame aliases two tabs');
      }
    }
    assert.ok(shell.webFrames.size <= BrowserShell.MAX_POOLED_FRAMES, 'pool still bounded');
  } finally {
    shell.destroy();
  }
});
