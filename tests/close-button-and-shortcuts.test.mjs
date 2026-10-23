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
 *  2. INTERNAL TABS COUNTED AS REAL: requestAppClose and
 *     closeWithSessionMode treated any non-newtab URL (Settings,
 *     History, ...) as a session worth interrogating the user about -
 *     and could persist yayra:// URLs into the saved session.
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

test('close with only internal pages (Settings/History) closes immediately - no pointless prompt', async () => {
  disk.clear();
  const { shell } = await boot();
  const calls = [];
  wireWindowControls(calls);
  shell.state.tabs = [
    { id: 't-s', title: 'Settings', url: 'yayra://settings', isLoading: false, isPrivate: false, favicon: null },
    { id: 't-h', title: 'History', url: 'yayra://history', isLoading: false, isPrivate: false, favicon: null }
  ];
  shell.state.activeTabId = 't-s';
  shell.requestAppClose();
  assert.equal(shell.state.closePrompt, false, 'no session prompt for internal-only tabs');
  assert.deepEqual(calls, ['close'], 'window closed right away');
});

test('close with real websites open prompts; "keep" saves ONLY http(s) URLs', async () => {
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
  assert.deepEqual(saved.tabs.map((t) => t.url), ['https://www.youtube.com/'],
    'yayra:// internal pages never persisted as session tabs');
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
    'Ctrl+H', 'Ctrl+J', 'Ctrl+F', 'Esc']) {
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
