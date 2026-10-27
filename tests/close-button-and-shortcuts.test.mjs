/**
 * P45: "sometimes the close button misbehaves" - root causes & pins,
 * plus the new Shortcuts settings page and the system-wide Ctrl+Alt+Y.
 *
 * Two real close-button bugs:
 *
 *  1. INVISIBLE PROMPT: `closePrompt` was missing from
 *     hasBlockingOverlay(), so with a real website open the native
 *     WebContentsView kept painting OVER the "Close all tabs / Just
 *     close / Keep all tabs" modal. Clicking X looked completely dead.
 *     On yayra://newtab (pure HTML) it worked - hence "sometimes".
 *  2. Internal calculator/dictionary/document hub routes now participate in
 *     restore snapshots through a strict safe-route allowlist; private pages
 *     and arbitrary yayra:// URLs remain excluded.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { setupDomShim } from './dom-shim.mjs';

setupDomShim();

const disk = new Map();
globalThis.localStorage = {
  getItem: (k) => (disk.has(k) ? disk.get(k) : null),
  setItem: (k, v) => disk.set(k, String(v)),
  removeItem: (k) => disk.delete(k),
  key: (i) => [...disk.keys()][i] ?? null,
  get length() { return disk.size; }
};

const { BrowserShell } = await import('../packages/shared-ui/src/components/BrowserShell.js');

async function boot(opts = {}) {
  delete globalThis.window.yayra;
  const container = document.createElement('div');
  const shell = new BrowserShell({ container, platform: 'linux', isMobile: false, ...opts });
  await shell.initialize();
  shell.render(container);
  return { shell, container };
}

function wireWindowControls(calls) {
  globalThis.window.yayra = {
    ...(globalThis.window.yayra || {}),
    windowControls: {
      close: () => calls.push('close'),
      minimize: () => calls.push('minimize'),
      toggleMaximize: () => calls.push('toggleMaximize'),
      isMaximized: async () => false
    }
  };
}

test('close prompt is a BLOCKING overlay (native view must hide so the modal is visible)', async () => {
  disk.clear();
  const { shell } = await boot();
  assert.equal(shell.hasBlockingOverlay(), false, 'no overlay at rest');
  shell.state.closePrompt = true;
  assert.equal(shell.hasBlockingOverlay(), true,
    'closePrompt blocks: without this the modal rendered UNDER the native page and the close button looked dead');
  shell.state.closePrompt = false;
});

test('close with internal tools open offers to restore the safe calculator and dictionary pages', async () => {
  disk.clear();
  const { shell } = await boot();
  const calls = [];
  wireWindowControls(calls);
  shell.state.tabs = [
    { id: 't-c', title: 'Scientific Calculator', url: 'yayra://calculator', isLoading: false, isPrivate: false, favicon: null },
    { id: 't-d', title: 'Dictionary', url: 'yayra://dictionary?q=ghana', isLoading: false, isPrivate: false, favicon: null }
  ];
  shell.state.activeTabId = 't-c';
  shell.requestAppClose();
  assert.equal(shell.state.closePrompt, true, 'safe internal workspaces participate in recovery');
  shell.closeWithSessionMode('keep');
  const closeKey = [...disk.keys()].find((key) => key.startsWith('yayra:close-session:'));
  const saved = JSON.parse(disk.get(closeKey) || 'null');
  assert.deepEqual(saved.tabs.map((tab) => tab.url), ['yayra://calculator', 'yayra://dictionary?q=ghana']);
  assert.deepEqual(calls, ['close'], 'window closes after the recovery choice');
});

test('close with real websites open prompts; "keep" saves websites and safe internal tabs', async () => {
  disk.clear();
  const { shell } = await boot();
  const calls = [];
  wireWindowControls(calls);
  shell.state.tabs = [
    { id: 't-a', title: 'YouTube', url: 'https://www.youtube.com/', isLoading: false, isPrivate: false, favicon: null },
    { id: 't-s', title: 'Settings', url: 'yayra://settings', isLoading: false, isPrivate: false, favicon: null }
  ];
  shell.state.activeTabId = 't-a';
  shell.requestAppClose();
  assert.equal(shell.state.closePrompt, true, 'real session -> user is asked');
  assert.deepEqual(calls, [], 'window NOT closed before the user answers');

  shell.closeWithSessionMode('keep');
  const closeKey = [...disk.keys()].find((key) => key.startsWith('yayra:close-session:'));
  const saved = JSON.parse(disk.get(closeKey) || 'null');
  assert.ok(saved, 'session persisted');
  assert.deepEqual(saved.tabs.map((t) => t.url), ['https://www.youtube.com/', 'yayra://settings'],
    'safe internal pages are restored alongside the website');
  assert.deepEqual(calls, ['close'], 'window closes after the choice');
});

test('system-wide open-Yayra shortcut + clean teardown (static pins on main.cjs)', () => {
  const src = fs.readFileSync(new URL('../electron/main.cjs', import.meta.url), 'utf8');
  assert.match(src, /globalShortcut\.register\('CommandOrControl\+Alt\+Y'/,
    'Ctrl+Alt+Y registered as an OS-level accelerator (opens/focuses main Yayra from anywhere)');
  assert.ok(src.indexOf('globalShortcut') < src.indexOf('require(\'electron\')') + 400 || /,\s*globalShortcut\s*\}/.test(src.split('\n')[0]),
    'globalShortcut imported from electron');
  assert.match(src, /globalShortcut\.unregisterAll\(\)/, 'unregistered on will-quit');
  assert.match(src, /if \(!isSmokeRun && !appModeLaunchUrl\) \{\s*\n\s*try \{\s*\n\s*globalShortcut\.register/,
    'not registered for smoke runs or app-mode child windows');
});

test('Settings -> Shortcuts lists EVERY shortcut: in-app keys, system-wide hotkeys, bubble gestures', async () => {
  disk.clear();
  const { shell, container } = await boot();
  shell.state.settingsActiveCategory = 'shortcuts';
  shell.navigateActiveTab('yayra://settings');

  const nav = [...container.querySelectorAll('.fb-settings-nav-item')]
    .find((b) => b.dataset && b.dataset.cat === 'shortcuts');
  assert.ok(nav, 'Shortcuts entry in the settings nav');
  const section = container.querySelector('#sec-shortcuts');
  assert.ok(section, 'Shortcuts section rendered');

  const text = section.textContent || '';
  // In-browser keys (every binding from handleGlobalKeyDown).
  for (const k of ['Ctrl+T', 'Ctrl+W', 'Ctrl+Shift+T', 'Ctrl+Shift+N', 'Ctrl+L', 'Alt+D',
    'Ctrl+D', 'Ctrl+Shift+D', 'Ctrl+Shift+B', 'Ctrl+R', 'F5', 'Ctrl+Shift+R', 'Ctrl+F5',
    'Ctrl+H', 'Ctrl+J', 'Ctrl+F', 'Ctrl+Alt+Shift+C', 'Esc']) {
    assert.ok(text.includes(k), `in-app shortcut listed: ${k}`);
  }
  // System-wide hotkeys.
  for (const k of ['Ctrl+Alt+Y', 'CapsLock+Y', 'CapsLock+Shift+R', 'Esc (hold) + F1']) {
    assert.ok(text.includes(k), `system-wide hotkey listed: ${k}`);
  }
  // Bubble gestures.
  for (const k of ['Single click', 'Double click', 'Triple click', 'Right-click', 'Drag']) {
    assert.ok(text.includes(k), `bubble gesture listed: ${k}`);
  }
});

test('calculator launch preference supports the desktop mini window, new tab, and Ctrl+Alt+Shift+C', async () => {
  disk.clear();
  const { shell } = await boot();
  const calls = [];
  shell.state.tabs = [{ id: 't-web', title: 'Example', url: 'https://example.com/', isLoading: false, isPrivate: false, favicon: null }];
  shell.state.activeTabId = 't-web';
  window.yayra = { ...(window.yayra || {}), overlay: { openPageInMini: async (url) => { calls.push(url); return true; } } };
  shell.state.settings.calculatorOpenDestination = 'mini';
  shell.openCalculatorFromPreference();
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(calls, ['yayra://calculator']);
  assert.equal(shell.getActiveTab().url, 'https://example.com/', 'mini launch leaves the main tab where it was');

  shell.state.settings.calculatorOpenDestination = 'new-tab';
  shell.openCalculatorFromPreference();
  assert.equal(shell.getActiveTab().url, 'yayra://calculator', 'new-tab destination opens the calculator immediately');
  assert.equal(shell.state.tabs.length, 2);

  let prevented = false;
  shell.state.settings.calculatorOpenDestination = 'mini';
  shell.handleGlobalKeyDown({ ctrlKey: true, metaKey: false, altKey: true, shiftKey: true, key: 'c', preventDefault() { prevented = true; } });
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(prevented, true);
  assert.deepEqual(calls, ['yayra://calculator', 'yayra://calculator'], 'keyboard shortcut follows the same destination');
});

test('Calculator settings toggle persists and its Open button follows the selected destination', async () => {
  disk.clear();
  const { shell, container } = await boot();
  const launches = [];
  window.yayra = { ...(window.yayra || {}), overlay: { openPageInMini: async (url) => { launches.push(url); return true; } } };
  shell.state.settingsActiveCategory = 'calculator';
  shell.navigateActiveTab('yayra://settings');
  const toggle = container.querySelector('#fb-in-calculator-open-mini');
  assert.ok(toggle && !toggle.disabled, 'desktop mini mode is available when the overlay bridge exists');
  toggle.checked = true;
  toggle.dispatchEvent({ type: 'change', target: toggle, preventDefault() {} });
  assert.equal(shell.state.settings.calculatorOpenDestination, 'mini');
  assert.equal(JSON.parse(disk.get('yayra:settings')).calculatorOpenDestination, 'mini');
  container.querySelector('.fb-in-open-calculator').click();
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(launches, ['yayra://calculator']);
  assert.equal(shell.getActiveTab().url, 'yayra://settings', 'mini launch keeps the settings tab intact');
});

test('Calculator toolbar and Tools menu honor the mini-window launch preference', async () => {
  disk.clear();
  const { shell, container } = await boot();
  const launches = [];
  window.yayra = { ...(window.yayra || {}), overlay: { openPageInMini: async (url) => { launches.push(url); return true; } } };
  shell.state.tabs = [{ id: 't-web', title: 'Example', url: 'https://example.com/', isLoading: false, isPrivate: false, favicon: null }];
  shell.state.activeTabId = 't-web';
  shell.state.settings.calculatorOpenDestination = 'mini';
  shell.state.settings.toolbarQuickActions = ['downloads', 'tools', 'calculator'];
  shell.render(container);

  container.querySelector('.fb-quick-calculator-btn').click();
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(launches, ['yayra://calculator'], 'the calculator quick action opens in the mini window');
  assert.equal(shell.getActiveTab().url, 'https://example.com/', 'quick launch preserves the current browser tab');

  container.querySelector('.fb-quick-tools-btn').click();
  assert.equal(shell.state.isToolsDropdownOpen, true, 'the Tools button opens its dropdown');
  assert.ok(container.querySelector('.fb-tools-dropdown'), 'the dropdown is rendered in the browser container');
  const calculatorMenuItem = [...container.querySelectorAll('.fb-tools-menu-item')].find((button) => button.dataset.tool === 'calculator');
  assert.ok(calculatorMenuItem, 'the calculator action is available in the Tools menu');
  calculatorMenuItem.click();
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(launches, ['yayra://calculator', 'yayra://calculator'], 'the Tools menu uses the same mini-window preference');
  assert.equal(shell.getActiveTab().url, 'https://example.com/', 'Tools menu launch also preserves the current browser tab');
  assert.equal(container.querySelector('.fb-tools-dropdown'), null, 'the Tools menu closes after launching the mini calculator');
});
