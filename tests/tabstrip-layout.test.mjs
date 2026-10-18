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
