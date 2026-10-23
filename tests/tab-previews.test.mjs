/**
 * P28 - the tab switcher ("Tabs (N)" overview, incl. yayra mini) must show
 * a REAL preview of each opened site, not an empty card.
 *
 * How previews exist: every tab's native WebContentsView is snapshotted
 * via capturePage() into shell._pageSnapshots - when overlays open, when
 * the switcher itself opens (active tab), and (new) when switching AWAY
 * from a tab. The switcher renders those snapshots as <img> thumbnails;
 * tabs never seen on screen fall back to an HONEST favicon + URL
 * placeholder (no fake thumbnails), and late-arriving captures live-update
 * an already-open switcher.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { setupDomShim } from './dom-shim.mjs';

setupDomShim();

import { BrowserShell } from '../packages/shared-ui/src/components/BrowserShell.js';
import { ProfileService } from '../packages/shared-ui/src/services/profileService.js';

class MemoryStorage {
  constructor() { this.map = new Map(); }
  getItem(key) { return this.map.has(key) ? this.map.get(key) : null; }
  setItem(key, val) { this.map.set(key, String(val)); }
  removeItem(key) { this.map.delete(key); }
}

function makeShell() {
  const container = document.createElement('div');
  const profileService = new ProfileService({ storage: new MemoryStorage() });
  const shell = new BrowserShell({ container, isMobile: false, profileService });
  shell.render(container);
  return { shell, container };
}

const SNAP_1 = 'data:image/png;base64,SNAPSHOT-OF-GOOGLE';

function seedTabs(shell) {
  shell.state.tabs = [
    { id: 'tab-a', url: 'https://www.google.com/search?q=ghana', title: 'ghana - Google Search', favicon: null },
    { id: 'tab-b', url: 'https://example.com/docs', title: 'Example Docs', favicon: null }
  ];
  shell.state.activeTabId = 'tab-a';
}

test('tab switcher: a tab WITH a captured snapshot renders it as a real <img> preview', () => {
  const { shell } = makeShell();
  seedTabs(shell);
  shell._pageSnapshots.set('tab-a', SNAP_1);

  const modal = document.createElement('div');
  shell.renderTabSwitcherModal(modal);

  const html = modal.innerHTML;
  assert.ok(html.includes('fb-tab-preview-img'), 'preview image element rendered');
  assert.ok(html.includes(SNAP_1), 'the REAL capturePage snapshot is the preview source');
  const cardA = modal.querySelectorAll('.fb-mobile-tab-card')[0];
  assert.ok(cardA.querySelector('.fb-tab-preview-img'), 'snapshot tab shows the image');
  assert.ok(!cardA.querySelector('.fb-tab-preview-placeholder'), 'no placeholder when a real preview exists');
});

test('tab switcher: a tab with NO snapshot gets the honest favicon+URL placeholder, never a fake image', () => {
  const { shell } = makeShell();
  seedTabs(shell);
  shell._pageSnapshots.set('tab-a', SNAP_1); // only tab-a has one

  const modal = document.createElement('div');
  shell.renderTabSwitcherModal(modal);

  const cardB = modal.querySelectorAll('.fb-mobile-tab-card')[1];
  assert.ok(!cardB.querySelector('.fb-tab-preview-img'), 'no image invented for a never-captured tab');
  const placeholder = cardB.querySelector('.fb-tab-preview-placeholder');
  assert.ok(placeholder, 'placeholder present');
  assert.ok(placeholder.textContent.includes('https://example.com/docs'), 'URL still identifies the tab');
});

test('tab switcher: late-arriving captures live-update an OPEN switcher (active tab was placeholder)', () => {
  const { shell } = makeShell();
  seedTabs(shell);

  const modal = document.createElement('div');
  shell.renderTabSwitcherModal(modal);
  document.body.appendChild(modal);
  shell.state.activeModal = 'tab-switcher';

  assert.ok(!modal.querySelector('.fb-tab-preview-img'), 'opens with placeholders (capture still in flight)');

  // The async capturePage resolves now.
  shell._pageSnapshots.set('tab-a', SNAP_1);
  shell.refreshTabSwitcherPreviews();

  const cardA = modal.querySelectorAll('.fb-mobile-tab-card')[0];
  const img = cardA.querySelector('.fb-tab-preview-img');
  assert.ok(img, 'placeholder swapped for the real preview');
  assert.equal(img.getAttribute('src'), SNAP_1, 'the fresh capture is the preview source');

  // No switcher open -> no DOM poking.
  shell.state.activeModal = null;
  shell.refreshTabSwitcherPreviews(); // must not throw
});

test('selectTab: switching AWAY from a tab snapshots it so background tabs keep real previews', async () => {
  const { shell } = makeShell();
  seedTabs(shell);
  shell.render = () => {}; // isolate the capture side-effect
  shell._nativeWebviewTabIds.add('tab-a');

  const captured = [];
  globalThis.window.yayra = {
    webview: {
      capture: (tabId) => { captured.push(tabId); return Promise.resolve({ snapshot: SNAP_1 }); }
    }
  };
  try {
    shell.selectTab('tab-b');
    await new Promise((r) => setTimeout(r, 0));
    assert.deepEqual(captured, ['tab-a'], 'outgoing tab captured before leaving the screen');
    assert.equal(shell._pageSnapshots.get('tab-a'), SNAP_1, 'preview stored for the switcher');

    // Selecting the SAME tab again captures nothing (no pointless IPC).
    shell.selectTab('tab-b');
    await new Promise((r) => setTimeout(r, 0));
    assert.deepEqual(captured, ['tab-a'], 'no capture when the active tab does not change');
  } finally {
    delete globalThis.window.yayra;
  }
});

test('closeTab: a closed tab\u2019s snapshot is dropped (no dead previews, no leak)', () => {
  const { shell } = makeShell();
  seedTabs(shell);
  shell.render = () => {};
  shell._pageSnapshots.set('tab-b', SNAP_1);

  shell.closeTab('tab-b');
  assert.equal(shell._pageSnapshots.has('tab-b'), false, 'snapshot gone with the tab');
  assert.equal(shell.state.tabs.length, 1, 'tab really closed');
});

test('lossless native snapshot cache is LRU-bounded and released with the shell', () => {
  const { shell } = makeShell();
  for (let index = 0; index < 8; index += 1) {
    assert.equal(shell.storePageSnapshot(`tab-${index}`, `data:image/png;base64,FULL-RES-${index}`), true);
  }
  assert.equal(shell._pageSnapshots.size, 3, 'only three full-resolution captures remain resident');
  assert.deepEqual([...shell._pageSnapshots.keys()], ['tab-5', 'tab-6', 'tab-7'], 'old captures are evicted first');
  assert.equal(shell._pageSnapshots.get('tab-7'), 'data:image/png;base64,FULL-RES-7', 'newest capture stays lossless');
  assert.equal(shell.storePageSnapshot('bad', 'data:image/jpeg;base64,LOSSY'), false, 'lossy/untrusted formats are rejected');
  shell.destroy();
  assert.equal(shell._pageSnapshots.size, 0, 'window teardown releases every capture string');
});
