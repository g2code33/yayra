import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { setupDomShim } from './dom-shim.mjs';

setupDomShim();

import { BrowserShell } from '../packages/shared-ui/src/components/BrowserShell.js';

/**
 * Chrome-style tab strip layout.
 *
 * 1. Tabs are width-capped (CSS flex: 0 1 220px + min-width floor) so a
 *    long page title can never produce a giant tab, and they shrink
 *    together as more tabs open - the CSS lives in design-system.css;
 *    what the DOM must guarantee is the structure below.
 * 2. The "+" new-tab button is a SIBLING of the scrollable tab row, not a
 *    child of it - that is what keeps it permanently visible when many
 *    tabs force the row into horizontal scrolling.
 * 3. Reordering uses renderer pointer events, never native HTML drag/drop;
 *    losing a Linux native drag-end must not be able to freeze this row.
 * 4. Horizontal movement reorders freely; a deliberate downward gesture
 *    tears the website into a separate Yayra window.
 */

test('"+" button is pinned OUTSIDE the scrollable tab row so it never scrolls out of sight', async () => {
  delete globalThis.window.yayra;
  const container = document.createElement('div');
  const shell = new BrowserShell({ container, platform: 'linux', isMobile: false });
  await shell.initialize();
  const el = shell.render(container);

  const newTabBtn = el.querySelector('.fb-btn-newtab');
  assert.ok(newTabBtn, 'new-tab button rendered');
  assert.ok(
    String(newTabBtn.parentElement.className).includes('fb-chrome-tabstrip'),
    'parent is the tab strip itself, NOT the scrollable row'
  );
  assert.ok(
    !String(newTabBtn.parentElement.className).includes('fb-tabs-scroll-container'),
    'must not live inside the overflow-x container'
  );
});

test('"+" button FOLLOWS the last tab while there is room (tab row must not stretch)', () => {
  // Chrome behavior: with a few tabs the "+" sits right next to the last
  // tab; only when tabs fill the strip does it end up pinned at the far
  // end (the row shrinks, tabs compress, then the row scrolls). That is
  // achieved by the scroll row taking ONLY the width its tabs need:
  // flex-grow MUST be 0 (a grow of 1 would stretch the row full-width and
  // park the "+" at the far right even with two tabs open).
  const css = readFileSync(new URL('../packages/shared-ui/src/theme/design-system.css', import.meta.url), 'utf8');
  const rule = css.split('.fb-tabs-scroll-container {')[1].split('}')[0];
  assert.match(rule, /flex:\s*0\s+1\s+auto/, 'row hugs its tabs: flex-grow 0, flex-shrink 1');
  assert.match(rule, /min-width:\s*0/, 'row must still be allowed to shrink for tab compression');
  assert.match(rule, /overflow-x:\s*auto/, 'row still scrolls once tabs hit their min-width floor');
});

test('with MANY tabs the "+" button stays a pinned sibling and still creates tabs', async () => {
  delete globalThis.window.yayra;
  const container = document.createElement('div');
  const shell = new BrowserShell({ container, platform: 'linux', isMobile: false });
  await shell.initialize();
  for (let i = 0; i < 14; i += 1) shell.createNewTab();
  const el = shell.render(container);

  assert.equal(shell.state.tabs.length, 15);
  const scroll = el.querySelector('.fb-tabs-scroll-container');
  const tabs = scroll.querySelectorAll('.fb-tab-item');
  assert.equal(tabs.length, 15, 'all tabs live in the scrollable row');

  const newTabBtn = el.querySelector('.fb-btn-newtab');
  assert.ok(String(newTabBtn.parentElement.className).includes('fb-chrome-tabstrip'));

  newTabBtn.click();
  assert.equal(shell.state.tabs.length, 16, 'pinned button still works at high tab counts');
});

test('tab reordering stays renderer-only and commits once on pointerup', async () => {
  delete globalThis.window.yayra;
  const container = document.createElement('div');
  const shell = new BrowserShell({ container, platform: 'linux', isMobile: false });
  await shell.initialize();
  shell.createNewTab('https://example.com/two');
  shell.createNewTab('https://example.com/three');
  const before = shell.state.tabs.map((tab) => tab.id);
  const el = shell.render(container);
  const row = el.querySelector('.fb-tabs-scroll-container');
  const tabs = row.querySelectorAll('.fb-tab-item');
  tabs.forEach((tab, index) => {
    tab.getBoundingClientRect = () => ({ left: index * 100, width: 100, right: (index + 1) * 100 });
  });

  assert.equal(tabs[0].draggable, false, 'Chromium HTML drag-and-drop is explicitly disabled');
  let nativePrevented = false;
  tabs[0].dispatchEvent({ type: 'dragstart', preventDefault: () => { nativePrevented = true; } });
  assert.equal(nativePrevented, true, 'even an attempted native drag is synchronously cancelled');

  const pointer = (type, x, y = 10) => ({
    type, target: tabs[0], pointerType: 'mouse', button: 0, pointerId: 12,
    clientX: x, clientY: y, preventDefault() {}, stopPropagation() {}
  });
  tabs[0].dispatchEvent(pointer('pointerdown', 10));
  tabs[0].dispatchEvent(pointer('pointermove', 12));
  assert.deepEqual(shell.state.tabs.map((tab) => tab.id), before, 'click jitter does not reorder tabs');
  tabs[0].dispatchEvent(pointer('pointermove', 250));
  assert.ok(tabs[0].classList.contains('fb-tab-pointer-dragging'));
  tabs[0].dispatchEvent(pointer('pointerup', 250));

  assert.deepEqual(
    shell.state.tabs.map((tab) => tab.id),
    [before[1], before[2], before[0]],
    'the source tab moves to the nearest tab center exactly once'
  );
  shell.destroy();
});

test('dragging a website tab downward tears it into a new Yayra window instead of reordering', async () => {
  delete globalThis.window.yayra;
  const container = document.createElement('div');
  const shell = new BrowserShell({
    container,
    platform: 'linux',
    isMobile: false,
    initialUrl: 'https://example.com/tear-off'
  });
  await shell.initialize();
  let detachedTabId = null;
  shell.detachTabToWindow = async (tabId) => { detachedTabId = tabId; return true; };
  const el = shell.render(container);
  const tab = el.querySelector('.fb-tab-item');
  tab.getBoundingClientRect = () => ({ left: 20, top: 0, right: 180, bottom: 32, width: 160, height: 32 });
  const pointer = (type, x, y) => ({
    type, target: tab, pointerType: 'mouse', button: 0, buttons: type === 'pointerup' ? 0 : 1,
    pointerId: 44, clientX: x, clientY: y, preventDefault() {}, stopPropagation() {}
  });

  tab.dispatchEvent(pointer('pointerdown', 60, 12));
  tab.dispatchEvent(pointer('pointermove', 64, 82));
  assert.ok(tab.classList.contains('fb-tab-pointer-detach'), 'downward threshold shows tear-off state');
  assert.ok(document.body.querySelector('.fb-tab-detach-hint'), 'the release action is explained before commit');
  tab.dispatchEvent(pointer('pointerup', 64, 82));
  await Promise.resolve();

  assert.equal(detachedTabId, shell.state.tabs[0].id, 'the exact dragged tab is sent to the new-window path');
  assert.equal(document.body.querySelector('.fb-tab-detach-hint'), null, 'tear-off hint is always cleaned up');
  shell.destroy();
});

test('tab tear-off opens the same URL/profile/privacy in a new app window before closing the source tab', async () => {
  const calls = [];
  globalThis.window.yayra = {
    profiles: {
      openWindow: async (...args) => { calls.push(args); return { ok: true }; }
    }
  };
  const container = document.createElement('div');
  const shell = new BrowserShell({
    container,
    platform: 'linux',
    isMobile: false,
    initialUrl: 'https://example.com/private-path?q=kept',
    initialPrivate: true
  });
  await shell.initialize();
  const sourceId = shell.state.tabs[0].id;
  const moved = await shell.detachTabToWindow(sourceId);

  assert.equal(moved, true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0][1], 'https://example.com/private-path?q=kept');
  assert.deepEqual(calls[0][2], { isPrivate: true });
  assert.equal(shell.state.tabs.some((tab) => tab.id === sourceId), false,
    'source closes only after native window creation succeeds');
  shell.destroy();
  delete globalThis.window.yayra;
});

test('failed tab tear-off keeps the source tab and internal tabs never enter the handoff', async () => {
  let calls = 0;
  globalThis.window.yayra = {
    profiles: {
      openWindow: async () => { calls += 1; return { ok: false }; }
    }
  };
  const container = document.createElement('div');
  const shell = new BrowserShell({
    container,
    platform: 'linux',
    isMobile: false,
    initialUrl: 'https://example.com/must-stay'
  });
  try {
    await shell.initialize();
    const sourceId = shell.state.tabs[0].id;
    assert.equal(await shell.detachTabToWindow(sourceId), false);
    assert.ok(shell.state.tabs.some((tab) => tab.id === sourceId),
      'the source survives until native window creation has succeeded');
    shell.state.tabs[0].url = 'yayra://documents';
    assert.equal(await shell.detachTabToWindow(sourceId), false);
    assert.equal(calls, 1, 'an internal tab never reaches the native new-window bridge');
  } finally {
    shell.destroy();
    delete globalThis.window.yayra;
  }
});

test('desktop tear-off bridge boots a full Yayra shell on the retained site', () => {
  const preload = readFileSync(new URL('../electron/preload.cjs', import.meta.url), 'utf8');
  const main = readFileSync(new URL('../electron/main.cjs', import.meta.url), 'utf8');
  const boot = readFileSync(new URL('../src/browser/main.js', import.meta.url), 'utf8');
  assert.match(preload, /openWindow: \(profileId, url = null, options = \{\}\)[\s\S]{0,260}isPrivate/,
    'preload carries URL and privacy without exposing raw IPC');
  assert.match(main, /await createProfileWindow\(id, initialUrl, \{ isPrivate: Boolean\(isPrivate\) \}\)/,
    'main waits for the independent Yayra window to load before source-tab handoff succeeds');
  assert.match(main, /const bootUrl = normalizeHttpUrl\(initialUrl\);[\s\S]{0,80}if \(bootUrl\) boot\.set\('page', bootUrl\)/,
    'only a parsed HTTP(S) URL can cross the new-window boot boundary');
  assert.match(main, /await win\.loadURL\(`/,
    'native handoff is not reported as successful before the new shell loads');
  assert.match(main, /boot\.set\('private', '1'\)/);
  assert.match(boot, /initialUrl: bootPage \|\| 'yayra:\/\/newtab',[\s\S]{0,80}initialPrivate: bootPrivate/,
    'the new renderer restores the retained site as its initial tab');
});
