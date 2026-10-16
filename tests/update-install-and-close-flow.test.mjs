/**
 * 1) Post-download install choices: once an update is downloaded &
 *    verified (staged), Yayra ASKS when to install - "Install & restart
 *    now", "Install when Yayra opens again" (persisted and honoured on
 *    the next launch), or "Later - manually". All of these also live in
 *    Settings -> "Yayra Updates", reachable from the menu's update
 *    section, so "Later" is never a dead end.
 *
 * 2) Close prompt & session handover: closing the app with real tabs
 *    open asks what to do - "Keep all tabs & close" reopens them
 *    automatically next launch; "Just close" offers them as recent tabs
 *    next launch; "Close all tabs & close" starts fresh.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { setupDomShim } from './dom-shim.mjs';

setupDomShim();

import { BrowserShell } from '../packages/shared-ui/src/components/BrowserShell.js';

class MemoryLocalStorage {
  constructor() { this.map = new Map(); }
  getItem(key) { return this.map.has(key) ? this.map.get(key) : null; }
  setItem(key, val) { this.map.set(key, String(val)); }
  removeItem(key) { this.map.delete(key); }
}

function withLocalStorage(fn) {
  const storage = new MemoryLocalStorage();
  globalThis.localStorage = storage;
  const cleanup = () => { delete globalThis.localStorage; };
  return { storage, cleanup };
}

function installUpdatesBridge({ downloads = [], installs = [] } = {}) {
  globalThis.window.yayra = globalThis.window.yayra || {};
  globalThis.window.yayra.updates = {
    check: async () => ({ status: 'checking' }),
    download: async (payload) => { downloads.push(payload); return { status: 'staged', path: '/tmp/yayra-new.deb' }; },
    install: async (payload) => { installs.push(payload); return { status: 'install_started', method: 'os-installer' }; },
    onEvent: () => () => {}
  };
  return { downloads, installs, uninstall: () => { delete globalThis.window.yayra; } };
}

async function makeShell(opts = {}) {
  const container = document.createElement('div');
  const shell = new BrowserShell({ container, platform: 'linux', isMobile: false, ...opts });
  await shell.initialize();
  shell.render(container);
  return { shell, container };
}

/* ------------------- staged update: the three choices ------------------- */

test('staged update: "Install when Yayra opens again" persists and the NEXT launch installs it', async () => {
  const { storage, cleanup } = withLocalStorage();
  const installs = [];
  const bridge = installUpdatesBridge({ installs });
  try {
    const { shell } = await makeShell();
    shell.state.updateState = { ...shell.state.updateState, status: 'staged', stagedPath: '/tmp/yayra-new.deb', availableVersion: '2.0.0' };
    shell.state.updateInstallPrompt = { path: '/tmp/yayra-new.deb', version: '2.0.0' };

    shell.deferInstallToNextLaunch();

    assert.equal(shell.state.updateInstallPrompt, null, 'prompt dismissed');
    assert.equal(installs.length, 0, 'nothing installs in this session');
    const pending = JSON.parse(storage.getItem('yayra:pending-update-install'));
    assert.equal(pending.path, '/tmp/yayra-new.deb');
    assert.equal(pending.version, '2.0.0');

    // "When opened again": a brand-new shell (next launch) honours it.
    const { shell: nextLaunch } = await makeShell();
    await new Promise((r) => setTimeout(r, 10));
    assert.deepEqual(installs, [{ path: '/tmp/yayra-new.deb', version: '2.0.0' }], 'scheduled install runs at next launch');
    assert.equal(storage.getItem('yayra:pending-update-install'), null, 'consumed exactly once');
    assert.ok(nextLaunch, 'next launch shell is fine');
  } finally {
    bridge.uninstall();
    cleanup();
  }
});

test('staged update: "Later - manually" dismisses but Settings -> Yayra Updates still offers install now / next launch', async () => {
  const { cleanup } = withLocalStorage();
  const installs = [];
  const bridge = installUpdatesBridge({ installs });
  try {
    const { shell, container } = await makeShell();
    shell.state.updateState = { ...shell.state.updateState, status: 'staged', stagedPath: '/tmp/yayra-new.deb', availableVersion: '2.0.0' };
    shell.state.updateInstallPrompt = { path: '/tmp/yayra-new.deb', version: '2.0.0' };
    shell.render(container);

    // The install card is a window-level overlay on document.body now.
    const installCard = document.getElementById('yayra-update-install-card');
    assert.ok(installCard, 'install choice card rendered');
    installCard.querySelector('.fb-update-install-later').click();
    assert.equal(shell.state.updateInstallPrompt, null);
    assert.equal(document.getElementById('yayra-update-install-card'), null, 'dismissed card is gone from the DOM');
    assert.equal(installs.length, 0);

    // Manual home: the "Yayra Updates" settings section still has BOTH options.
    shell.state.settingsActiveCategory = 'updates';
    shell.state.activeSettingsCategory = 'updates';
    shell.openInternalPage('yayra://settings');
    shell.render(container);
    const section = container.querySelector('#sec-updates');
    assert.ok(section, 'Yayra Updates settings section exists');
    assert.ok(container.querySelector('.fb-up-install-now'), 'manual Install & restart now');
    assert.ok(container.querySelector('.fb-up-install-next'), 'manual Install when opened again');
    assert.ok(container.querySelector('.fb-up-check'), 'manual Check for updates');

    container.querySelector('.fb-up-install-now').click();
    await new Promise((r) => setTimeout(r, 10));
    assert.deepEqual(installs, [{ path: '/tmp/yayra-new.deb', version: '2.0.0' }], 'manual install carries the staged path and version');
  } finally {
    // Window-level prompt cards live on document.body - clear them so a
    // failed assertion cannot leak a card into later tests.
    document.getElementById('yayra-update-install-card')?.remove();
    document.getElementById('yayra-update-prompt-card')?.remove();
    bridge.uninstall();
    cleanup();
  }
});

test('settings: a scheduled next-launch install is visible and cancellable', async () => {
  const { storage, cleanup } = withLocalStorage();
  const bridge = installUpdatesBridge();
  try {
    // Schedule first (no bridge consumption in the SAME shell).
    storage.setItem('yayra:pending-update-install', JSON.stringify({ path: '/tmp/yayra-new.deb', version: '2.0.0' }));
    const container = document.createElement('div');
    const shell = new BrowserShell({ container, platform: 'linux', isMobile: false });
    // Do NOT initialize() (that would consume the schedule) - just open settings.
    shell.state.settingsActiveCategory = 'updates';
    shell.state.activeSettingsCategory = 'updates';
    shell.render(container);
    shell.openInternalPage('yayra://settings');
    shell.render(container);

    const cancelBtn = container.querySelector('.fb-up-cancel-scheduled');
    assert.ok(cancelBtn, 'scheduled install shown with a Cancel button');
    cancelBtn.click();
    assert.equal(storage.getItem('yayra:pending-update-install'), null, 'cancelled');
  } finally {
    bridge.uninstall();
    cleanup();
  }
});

test('menu: the update section has an "Update options" button that opens Settings -> Yayra Updates', async () => {
  const { shell, container } = await makeShell();
  shell.state.isSideDrawerOpen = true;
  shell.render(container);

  const btn = container.querySelector('.fb-update-options-btn');
  assert.ok(btn, 'Update options button lives in the menu');
  btn.click();
  assert.equal(shell.state.settingsActiveCategory, 'updates');
  const tab = shell.getActiveTab();
  assert.equal(tab.url, 'yayra://settings', 'opens the settings page');
});

/* ------------- staged update: every button says INSTALL ------------- */

test('staged update: toolbar chip reads "Install" and clicking it INSTALLS the staged file (never re-downloads)', async () => {
  const { cleanup } = withLocalStorage();
  const downloads = [];
  const installs = [];
  const bridge = installUpdatesBridge({ downloads, installs });
  try {
    const { shell, container } = await makeShell();
    shell.state.updateState = {
      ...shell.state.updateState,
      status: 'staged',
      stagedPath: '/tmp/yayra-new.deb',
      availableVersion: '2.0.0',
      download: { url: 'https://example.com/yayra-2.0.0.deb' }
    };
    shell.render(container);

    const chip = container.querySelector('.fb-update-chip');
    assert.ok(chip, 'update chip stays visible while an install is pending');
    const label = container.querySelector('.fb-update-chip-label');
    assert.equal(label.textContent, 'Install', 'post-download the chip says Install, not Update/Download');

    chip.click();
    await new Promise((r) => setTimeout(r, 10));
    assert.equal(downloads.length, 0, 'no re-download of an already staged update');
    assert.equal(installs.length, 1, 'clicking Install actually installs');
    assert.equal(installs[0].path, '/tmp/yayra-new.deb');
  } finally {
    bridge.uninstall();
    cleanup();
  }
});

test('staged update: the menu update section offers a real "Install" button wired to the staged file', async () => {
  const { cleanup } = withLocalStorage();
  const installs = [];
  const bridge = installUpdatesBridge({ installs });
  try {
    const { shell, container } = await makeShell();
    shell.state.updateState = { ...shell.state.updateState, status: 'staged', stagedPath: '/tmp/yayra-new.deb', availableVersion: '2.0.0' };
    shell.state.isSideDrawerOpen = true;
    shell.render(container);

    const installBtn = container.querySelector('.fb-drawer-install-btn');
    assert.ok(installBtn, 'drawer shows an actionable Install button when staged');
    assert.match(installBtn.textContent, /Install Yayra v2\.0\.0/);
    installBtn.click();
    await new Promise((r) => setTimeout(r, 10));
    assert.deepEqual(installs.map((i) => i.path), ['/tmp/yayra-new.deb']);
  } finally {
    bridge.uninstall();
    cleanup();
  }
});

test('install failure keeps the download STAGED (retry stays possible) and never closes the window', async () => {
  const { cleanup } = withLocalStorage();
  const closes = [];
  globalThis.window.yayra = globalThis.window.yayra || {};
  globalThis.window.yayra.updates = {
    check: async () => ({ status: 'checking' }),
    download: async () => ({ status: 'staged', path: '/tmp/yayra-new.deb' }),
    install: async () => ({ status: 'error', reason: 'authorization-declined' }),
    onEvent: () => () => {}
  };
  globalThis.window.yayra.windowControls = { close: () => closes.push(true), minimize: () => {}, toggleMaximize: () => {} };
  try {
    const { shell } = await makeShell();
    shell.state.updateState = { ...shell.state.updateState, status: 'staged', stagedPath: '/tmp/yayra-new.deb', availableVersion: '2.0.0' };
    await shell.installDesktopUpdateNow();
    assert.equal(shell.state.updateState.status, 'staged', 'failed install falls back to staged, not a dead end');
    assert.equal(shell.state.updateState.stagedPath, '/tmp/yayra-new.deb');
    assert.equal(closes.length, 0, 'the renderer NEVER closes the window itself anymore');
  } finally {
    delete globalThis.window.yayra;
    cleanup();
  }
});

test('main-process install events: install-failed restores staged; install-finished shows installing', async () => {
  const { cleanup } = withLocalStorage();
  const bridge = installUpdatesBridge();
  try {
    const { shell } = await makeShell();
    shell.state.updateState = { ...shell.state.updateState, status: 'installing', stagedPath: '/tmp/yayra-new.deb', availableVersion: '2.0.0' };

    shell.handleDesktopUpdateEvent({ type: 'install-failed', reason: 'package-manager-exited-1' });
    assert.equal(shell.state.updateState.status, 'staged', 'failure goes back to staged');
    assert.match(shell.state.updateState.notes, /package-manager-exited-1/);

    shell.handleDesktopUpdateEvent({ type: 'install-finished', version: '2.0.0', relaunching: true });
    assert.equal(shell.state.updateState.status, 'installing', 'success reports installing while the app relaunches');
  } finally {
    bridge.uninstall();
    cleanup();
  }
});

/* ---------------------- close prompt & session modes ---------------------- */

function installWindowControls(closes) {
  globalThis.window.yayra = globalThis.window.yayra || {};
  globalThis.window.yayra.windowControls = {
    close: () => closes.push(true),
    minimize: () => {},
    toggleMaximize: () => {}
  };
  return () => { delete globalThis.window.yayra; };
}

test('close with real tabs open shows the 3-way prompt; a pristine window just closes', async () => {
  const closes = [];
  const uninstall = installWindowControls(closes);
  try {
    const { shell, container } = await makeShell();
    // Pristine (only yayra://newtab): no prompt, straight close.
    shell.requestAppClose();
    assert.equal(closes.length, 1, 'pristine window closes immediately');
    assert.equal(shell.state.closePrompt, false);

    // With a real tab: prompt appears instead of closing.
    shell.getActiveTab().url = 'https://example.com/';
    shell.requestAppClose();
    assert.equal(closes.length, 1, 'no close before the user chooses');
    assert.equal(shell.state.closePrompt, true);
    shell.render(container);
    const modal = container.querySelector('.fb-close-prompt-modal');
    assert.ok(modal, 'close prompt rendered');
    assert.ok(modal.querySelector('.fb-close-keep-tabs'), 'keep all tabs option');
    assert.ok(modal.querySelector('.fb-close-just-close'), 'just close option');
    assert.ok(modal.querySelector('.fb-close-all-tabs'), 'close all tabs option');

    // Cancel keeps the app open.
    modal.querySelector('.fb-close-cancel').click();
    assert.equal(shell.state.closePrompt, false);
    assert.equal(closes.length, 1, 'cancel never closes');
  } finally {
    uninstall();
  }
});

test('"Keep all tabs & close" -> next launch REOPENS every tab automatically', async () => {
  const { storage, cleanup } = withLocalStorage();
  const closes = [];
  const uninstall = installWindowControls(closes);
  try {
    const { shell } = await makeShell();
    shell.getActiveTab().url = 'https://a.dev/';
    shell.getActiveTab().title = 'A';
    shell.createNewTab();
    shell.getActiveTab().url = 'https://b.dev/';
    shell.getActiveTab().title = 'B';

    shell.closeWithSessionMode('restore');
    assert.equal(closes.length, 1, 'window closed');
    assert.equal(JSON.parse(storage.getItem('yayra:close-session')).mode, 'restore');

    const { shell: next } = await makeShell();
    assert.deepEqual(next.state.tabs.map((t) => t.url), ['https://a.dev/', 'https://b.dev/'], 'all tabs reopened');
    assert.equal(next.state.recentTabsOffer, null, 'no offer needed - already restored');
    assert.equal(storage.getItem('yayra:close-session'), null, 'consumed exactly once');
  } finally {
    uninstall();
    cleanup();
  }
});

test('"Just close" -> next launch OFFERS the recent tabs; Reopen restores them', async () => {
  const { storage, cleanup } = withLocalStorage();
  const closes = [];
  const uninstall = installWindowControls(closes);
  try {
    const { shell } = await makeShell();
    shell.getActiveTab().url = 'https://a.dev/';
    shell.closeWithSessionMode('recent');
    assert.equal(JSON.parse(storage.getItem('yayra:close-session')).mode, 'recent');

    const { shell: next, container: nextContainer } = await makeShell();
    assert.equal(next.state.tabs[0].url, 'yayra://newtab', 'starts on a fresh tab');
    assert.ok(next.state.recentTabsOffer, 'recent tabs offered');
    const offer = nextContainer.querySelector('.fb-recent-tabs-offer');
    assert.ok(offer, 'offer card rendered');

    offer.querySelector('.fb-recent-tabs-reopen').click();
    assert.deepEqual(next.state.tabs.map((t) => t.url), ['https://a.dev/'], 'recent tabs reopened on demand');
    assert.equal(next.state.recentTabsOffer, null);
  } finally {
    uninstall();
    cleanup();
  }
});

test('"Close all tabs & close" -> next launch starts completely fresh', async () => {
  const { storage, cleanup } = withLocalStorage();
  const closes = [];
  const uninstall = installWindowControls(closes);
  try {
    const { shell } = await makeShell();
    shell.getActiveTab().url = 'https://a.dev/';
    shell.closeWithSessionMode('fresh');
    assert.deepEqual(JSON.parse(storage.getItem('yayra:close-session')).tabs, [], 'nothing saved');

    const { shell: next } = await makeShell();
    assert.equal(next.state.tabs.length, 1);
    assert.equal(next.state.tabs[0].url, 'yayra://newtab');
    assert.equal(next.state.recentTabsOffer, null);
  } finally {
    uninstall();
    cleanup();
  }
});

test('private tabs are NEVER written into the close session', async () => {
  const { storage, cleanup } = withLocalStorage();
  const closes = [];
  const uninstall = installWindowControls(closes);
  try {
    const { shell } = await makeShell();
    shell.getActiveTab().url = 'https://public.dev/';
    shell.createNewTab(true);
    shell.getActiveTab().url = 'https://secret.dev/';

    shell.closeWithSessionMode('restore');
    const saved = JSON.parse(storage.getItem('yayra:close-session'));
    assert.deepEqual(saved.tabs.map((t) => t.url), ['https://public.dev/'], 'incognito never persisted');
  } finally {
    uninstall();
    cleanup();
  }
});
