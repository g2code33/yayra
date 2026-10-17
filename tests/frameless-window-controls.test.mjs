import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { setupDomShim } from './dom-shim.mjs';

setupDomShim();

import { BrowserShell } from '../packages/shared-ui/src/components/BrowserShell.js';

/**
 * Frameless Electron window chrome.
 *
 * The OS title bar (plain "yayra" text) and the File/Edit/View/Window menu
 * block are removed (electron/main.cjs: frame:false + setApplicationMenu(null)).
 * Yayra draws its own top chrome: the tab strip shows the official brand
 * wordmark, window controls, and a dedicated drag handle. This keeps tab
 * clicks out of the OS titlebar path. On web/PWA the bridge is absent and
 * the browser supplies window chrome, so native controls/drag handle must
 * never render there.
 */

function installFakeWindowControls() {
  const calls = { minimize: 0, toggleMaximize: 0, close: 0 };
  globalThis.window.yayra = {
    windowControls: {
      minimize: () => { calls.minimize += 1; return Promise.resolve(); },
      toggleMaximize: () => { calls.toggleMaximize += 1; return Promise.resolve(true); },
      isMaximized: () => Promise.resolve(false),
      close: () => { calls.close += 1; return Promise.resolve(); }
    }
  };
  return { calls, uninstall: () => { delete globalThis.window.yayra; } };
}

test('tab strip always shows the brand wordmark image at the top of the app', async () => {
  delete globalThis.window.yayra;
  const container = document.createElement('div');
  const shell = new BrowserShell({ container, platform: 'linux', isMobile: false });
  await shell.initialize();
  const el = shell.render(container);

  const brand = el.querySelector('.fb-tabstrip-brand');
  assert.ok(brand, 'brand wordmark container rendered in the tab strip');
  assert.ok(
    String(brand.innerHTML).includes('fb-official-brand-wordmark'),
    'uses the official wordmark image (yayrawriing asset), not plain text'
  );
});

test('web/PWA (no bridge): no window-control buttons - the browser owns the window chrome', async () => {
  delete globalThis.window.yayra;
  const container = document.createElement('div');
  const shell = new BrowserShell({ container, platform: 'linux', isMobile: false });
  await shell.initialize();
  const el = shell.render(container);

  assert.equal(shell.windowControls, null);
  assert.equal(el.querySelector('.fb-window-controls'), null);
  assert.equal(el.querySelector('.fb-tabstrip-drag-handle'), null, 'web/PWA has no native window drag handle');
});

test('frameless tab strip limits native dragging to its dedicated handle', () => {
  const css = readFileSync(new URL('../packages/shared-ui/src/theme/design-system.css', import.meta.url), 'utf8');
  const tabStripRule = css.match(/\.fb-chrome-tabstrip\s*\{([\s\S]*?)\}/)?.[1] || '';
  const dragHandleRule = css.match(/\.fb-tabstrip-drag-handle\s*\{([\s\S]*?)\}/)?.[1] || '';
  const tabListRule = css.match(/\.fb-chrome-tabstrip \.fb-tab-item,[\s\S]*?\{([\s\S]*?)\}/)?.[1] || '';

  assert.match(tabStripRule, /-webkit-app-region:\s*no-drag/, 'the tab strip no longer acts as a whole-window titlebar');
  assert.match(dragHandleRule, /-webkit-app-region:\s*drag/, 'window movement remains available through the explicit handle');
  assert.match(tabListRule, /-webkit-app-region:\s*no-drag/, 'tab items and their scroll area remain clickable');
});

test('Exit bridge quits the whole Electron app separately from closing only the current window', () => {
  const preload = readFileSync(new URL('../electron/preload.cjs', import.meta.url), 'utf8');
  const main = readFileSync(new URL('../electron/main.cjs', import.meta.url), 'utf8');
  assert.match(preload, /quit:\s*\(\)\s*=>\s*ipcRenderer\.invoke\('yayra:app-quit'\)/, 'preload exposes an explicit app-wide quit action');
  assert.match(main, /ipcMain\.handle\('yayra:app-quit',[\s\S]{0,220}app\.quit\(\)/, 'the menu can terminate tray/bubble windows too');
  assert.match(main, /ipcMain\.handle\('yayra:window-close',[\s\S]{0,140}senderWindow\(event\)\?\.close\(\)/, 'the regular close button still closes only its window');
});

test('Electron (bridge present): real minimize/maximize/close buttons render and drive the IPC bridge', async () => {
  const { calls, uninstall } = installFakeWindowControls();
  try {
    const container = document.createElement('div');
    const shell = new BrowserShell({ container, platform: 'linux', isMobile: false });
    await shell.initialize();
    const el = shell.render(container);

    const controls = el.querySelector('.fb-window-controls');
    assert.ok(controls, 'window controls cluster rendered in the tab strip');
    assert.ok(el.querySelector('.fb-tabstrip-drag-handle'), 'Electron retains window movement through a dedicated handle');

    el.querySelector('.fb-wc-minimize').click();
    el.querySelector('.fb-wc-maximize').click();
    el.querySelector('.fb-wc-close').click();

    assert.equal(calls.minimize, 1, 'minimize goes through the IPC bridge');
    assert.equal(calls.toggleMaximize, 1, 'maximize/restore goes through the IPC bridge');
    assert.equal(calls.close, 1, 'close ACTUALLY closes the window via IPC (not a decorative button)');
  } finally {
    uninstall();
  }
});
