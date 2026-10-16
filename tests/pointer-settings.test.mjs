import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { setupDomShim } from './dom-shim.mjs';

setupDomShim();

import { BrowserShell } from '../packages/shared-ui/src/components/BrowserShell.js';

/**
 * POINTER SETTINGS (user request: "fix the pointer too and add a pointer
 * settings under settings for users to customize their pointer").
 *
 * The pointer-size bug (Chromium's fixed-size bitmap cursors shrinking
 * below the Windows pointer size) is already pinned by
 * tests/native-cursor-size.test.mjs. What was MISSING was user control:
 * Settings > Pointer now offers System (native, OS-sized - default),
 * Yayra accent, and High-visibility styles in three sizes, applied live
 * across everything Yayra renders.
 */

function makeStorage() {
  const disk = new Map();
  return {
    getItem: (k) => (disk.has(k) ? disk.get(k) : null),
    setItem: (k, v) => disk.set(k, String(v)),
    removeItem: (k) => disk.delete(k),
    key: (i) => [...disk.keys()][i] ?? null,
    get length() { return disk.size; }
  };
}

async function makeShell() {
  globalThis.localStorage = makeStorage();
  const container = document.createElement('div');
  const shell = new BrowserShell({ container, isMobile: false });
  await shell.initialize();
  shell.render(container);
  return { shell, container };
}

test('SETTINGS UI: the Pointer section exists with style + size options and a live preview', async () => {
  const { shell, container } = await makeShell();
  try {
    shell.state.tabs[0].url = 'yayra://settings';
    shell.state.settingsActiveCategory = 'pointer';
    shell.render(container);
    const nav = Array.from(container.querySelectorAll('.fb-settings-nav-item'))
      .find((b) => (b.dataset.cat || b.getAttribute('data-cat')) === 'pointer');
    assert.ok(nav, 'Pointer appears in the settings sidebar');
    assert.match(nav.textContent, /Pointer/);

    const section = container.querySelector('#sec-pointer');
    assert.ok(section, 'the Pointer section card renders');
    const styleSelect = section.querySelector('#fb-in-set-pointer-theme');
    assert.ok(styleSelect, 'pointer style select');
    const styleOptions = Array.from(styleSelect.querySelectorAll('option')).map((o) => o.getAttribute('value'));
    assert.deepEqual(styleOptions, ['system', 'yayra', 'high-visibility'], 'System / Yayra accent / High visibility');
    const sizeSelect = section.querySelector('#fb-in-set-pointer-size');
    assert.ok(sizeSelect, 'pointer size select');
    const sizeOptions = Array.from(sizeSelect.querySelectorAll('option')).map((o) => o.getAttribute('value'));
    assert.deepEqual(sizeOptions, ['normal', 'large', 'xlarge'], 'three sizes');
    assert.ok(section.querySelector('.fb-pointer-preview'), 'live preview area');
    assert.match(section.textContent, /native operating-system pointer and its configured size/, 'the System option still explains OS cursor sizing');
  } finally {
    shell.destroy();
    delete globalThis.localStorage;
  }
});

test('APPLICATION: choosing a custom style applies it live (body attribute) and persists; System clears it', async () => {
  const { shell, container } = await makeShell();
  try {
    assert.equal(shell.state.settings.pointerTheme, 'system', 'default is System (native OS cursors)');
    assert.ok(!document.body.getAttribute('data-fb-pointer'), 'no custom attribute by default');

    shell.state.tabs[0].url = 'yayra://settings';
    shell.state.settingsActiveCategory = 'pointer';
    shell.render(container);
    const styleSelect = container.querySelector('#fb-in-set-pointer-theme');
    const sizeSelect = container.querySelector('#fb-in-set-pointer-size');

    styleSelect.value = 'yayra';
    styleSelect.dispatchEvent({ type: 'change', target: styleSelect });
    assert.equal(shell.state.settings.pointerTheme, 'yayra', 'state updated');
    assert.equal(document.body.getAttribute('data-fb-pointer'), 'yayra', 'theme applied to the document');
    const persisted = JSON.parse(globalThis.localStorage.getItem('yayra:settings'));
    assert.equal(persisted.pointerTheme, 'yayra', 'persisted');

    sizeSelect.value = 'xlarge';
    sizeSelect.dispatchEvent({ type: 'change', target: sizeSelect });
    assert.equal(document.body.getAttribute('data-fb-pointer-size'), 'xlarge', 'size applied');

    styleSelect.value = 'system';
    styleSelect.dispatchEvent({ type: 'change', target: styleSelect });
    assert.ok(!document.body.getAttribute('data-fb-pointer'), 'System removes the custom cursors entirely');
  } finally {
    shell.destroy();
    delete globalThis.localStorage;
  }
});

test('PERSISTENCE: a saved custom pointer and size are restored before the first render', async () => {
  const storage = makeStorage();
  storage.setItem('yayra:settings', JSON.stringify({ pointerTheme: 'high-visibility', pointerSize: 'large' }));
  globalThis.localStorage = storage;
  const container = document.createElement('div');
  const shell = new BrowserShell({ container, isMobile: false });
  try {
    await shell.initialize();
    shell.render(container);
    assert.equal(shell.state.settings.pointerTheme, 'high-visibility');
    assert.equal(shell.state.settings.pointerSize, 'large');
    assert.equal(document.body.getAttribute('data-fb-pointer'), 'high-visibility');
    assert.equal(document.body.getAttribute('data-fb-pointer-size'), 'large');
  } finally {
    shell.destroy();
    delete globalThis.localStorage;
  }
});

test('NATIVE WEBSITE VIEWS: pointer style and size are sent live and System restores the native cursor', async () => {
  const previousYayra = window.yayra;
  const pointerCalls = [];
  window.yayra = {
    webview: {
      onEvent: () => () => {},
      setPointerTheme: (tabId, theme, size) => { pointerCalls.push({ tabId, theme, size }); return Promise.resolve({ ok: true }); },
      destroy: async () => ({ ok: true })
    }
  };
  const { shell } = await makeShell();
  try {
    shell._nativeWebviewTabIds.add('tab-site');
    shell.state.settings.pointerTheme = 'yayra';
    shell.state.settings.pointerSize = 'xlarge';
    shell.applyPointerTheme();
    assert.deepEqual(pointerCalls.at(-1), { tabId: 'tab-site', theme: 'yayra', size: 'xlarge' }, 'the selected cursor is applied to an already-open native website tab');
    assert.equal(document.body.getAttribute('data-fb-pointer'), 'yayra');

    shell.state.settings.pointerTheme = 'system';
    shell.applyPointerTheme();
    assert.deepEqual(pointerCalls.at(-1), { tabId: 'tab-site', theme: 'system', size: 'xlarge' }, 'System is forwarded so the site returns to the OS cursor');
    assert.equal(document.body.getAttribute('data-fb-pointer'), null);
  } finally {
    shell.destroy();
    if (previousYayra === undefined) delete window.yayra; else window.yayra = previousYayra;
    delete globalThis.localStorage;
  }
});

test('CSS PIN: custom pointer themes are defined for every style x size, beat inline styles, and keep native text cursors', () => {
  const css = readFileSync(new URL('../packages/shared-ui/src/theme/design-system.css', import.meta.url), 'utf8');
  for (const theme of ['yayra', 'high-visibility']) {
    for (const size of ['', "[data-fb-pointer-size='large']", "[data-fb-pointer-size='xlarge']"]) {
      const selector = `[data-fb-pointer='${theme}']${size}`;
      const at = css.indexOf(selector);
      assert.ok(at > -1, `${selector} defines cursor images`);
      const block = css.slice(at, css.indexOf('}', at));
      assert.match(block, /--fb-ptr-arrow: url\("data:image\/svg\+xml/, 'an SVG arrow cursor');
      assert.match(block, /--fb-ptr-hand: url\("data:image\/svg\+xml/, 'an SVG hand cursor');
    }
  }
  // Application rules must carry !important (the app's cursor styling is
  // mostly inline, and inline beats any non-important rule).
  assert.match(css, /\[data-fb-pointer='yayra'\] \*,\s*\n\s*\[data-fb-pointer='high-visibility'\] \* \{\s*\n\s*cursor: var\(--fb-ptr-arrow, auto\) !important;/, 'the custom arrow wins over inline styles');
  assert.match(css, /cursor: var\(--fb-ptr-hand, pointer\) !important;/, 'the custom hand wins on interactive elements');
  // Text entry keeps the NATIVE I-beam (follows the OS pointer size).
  assert.match(css, /\[data-fb-pointer\] input\[type='text'\][\s\S]{0,420}cursor: text !important;/, 'text fields keep the native I-beam');
});

test('CURSOR POLICY: no Chromium bitmap cursor types anywhere (the pointer stays OS-sized)', () => {
  // Same contract as tests/native-cursor-size.test.mjs, re-verified over
  // the sources changed by the pointer work.
  const shellSrc = readFileSync(new URL('../packages/shared-ui/src/components/BrowserShell.js', import.meta.url), 'utf8');
  const css = readFileSync(new URL('../packages/shared-ui/src/theme/design-system.css', import.meta.url), 'utf8');
  const bitmaps = ['grab', 'grabbing', 'cell', 'alias', 'copy', 'vertical-text', 'zoom-in', 'zoom-out', 'col-resize', 'row-resize', 'context-menu'];
  for (const type of bitmaps) {
    const re = new RegExp(`cursor:\\s*${type}\\b`);
    assert.equal(re.test(shellSrc), false, `BrowserShell never uses bitmap cursor '${type}'`);
    assert.equal(re.test(css), false, `design-system never uses bitmap cursor '${type}'`);
  }
});
