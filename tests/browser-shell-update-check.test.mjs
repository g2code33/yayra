import test from 'node:test';
import assert from 'node:assert/strict';
import { setupDomShim } from './dom-shim.mjs';

setupDomShim();

import { BrowserShell } from '../packages/shared-ui/src/components/BrowserShell.js';

/**
 * Regression coverage for a real production bug seen on the deployed PWA
 * (https://yayra.pages.dev): BrowserShell.checkForUpdates() used to have a
 * SECOND, independent "fallback" path that fetched the raw GitHub Releases
 * API directly and compared the tag against a version string hardcoded to
 * the literal '0.1.0'. That path ran any time the real UpdateService (wired
 * to the Cloudflare Worker's /updates/manifest.json) reported the app was
 * already up to date, because the only early-return guard checked for
 * status === 'available' | 'ready'. Since '0.1.0' can never equal a real
 * release tag, it declared an update "ready" on every single check -
 * including immediately after the user clicked "restart and apply", which
 * just reloads the page and re-runs the same broken check - producing an
 * infinite update-prompt loop that only stopped when the user declined.
 *
 * Fix: delete the duplicate fallback entirely; trust the Worker-backed
 * UpdateService as the single source of truth, and stop hardcoding version
 * strings anywhere in the prompt/menu UI.
 *
 * The prompt itself is now an IN-APP CARD (.fb-update-prompt-card) with
 * explicit "Download & install now / Update now" and "Later" buttons -
 * native window.confirm() is never used for updates anymore.
 */

function installFakeUpdateService(resultsQueue, { installedVersion = '0.1.9' } = {}) {
  const calls = [];
  return {
    installedVersion,
    check: async (opts) => {
      calls.push(opts);
      const next = resultsQueue.length > 1 ? resultsQueue.shift() : resultsQueue[0];
      return { installedVersion, ...next };
    },
    calls
  };
}

function installDialogSpies() {
  const confirms = [];
  window.confirm = (msg) => { confirms.push(msg); return true; };
  window.alert = () => {};
  window.location = window.location || {};
  const reloads = [];
  window.location.reload = () => reloads.push(true);
  return { confirms, reloads, uninstall: () => { delete window.confirm; delete window.alert; } };
}

// The prompt is a WINDOW-LEVEL overlay: it mounts on document.body at the
// top right corner (see BrowserShell.renderUpdatePromptCard), never
// inside the shell container. `container` is kept in the call signature
// for readability at the call sites.
function findUpdateCard(container) {
  return document.getElementById('yayra-update-prompt-card')
    || document.querySelector('.fb-update-prompt-card');
}

// Cards are body-level, so they outlive their test's container unless
// cleared (re-renders of a dead shell can no longer clean them up).
function clearUpdateCards() {
  document.getElementById('yayra-update-prompt-card')?.remove();
  document.getElementById('yayra-update-install-card')?.remove();
}

test('checkForUpdates: already up to date NEVER shows the update card, even though no real update exists', async () => {
  const container = document.createElement('div');
  const updateService = installFakeUpdateService([{ status: 'upToDate', version: '0.1.9' }]);
  const shell = new BrowserShell({ container, platform: 'pwa', isMobile: true, updateService });
  await shell.initialize();
  shell.render(container);
  const { confirms, uninstall } = installDialogSpies();
  try {
    await shell.checkForUpdates(false);
    assert.equal(shell.state.updatePrompt, null, 'no update card when already up to date');
    assert.equal(findUpdateCard(container), null, 'no card in the DOM either');
    assert.equal(confirms.length, 0, 'native confirm() must never be used for updates');
    assert.equal(shell.state.updateState.status, 'uptodate');
    assert.equal(shell.state.updateState.availableVersion, null);
  } finally {
    uninstall();
  }
});

test('checkForUpdates: repeated checks while up to date never escalate into a prompt (regression for the infinite-loop bug)', async () => {
  const container = document.createElement('div');
  const updateService = installFakeUpdateService([{ status: 'upToDate', version: '0.1.9' }]);
  const shell = new BrowserShell({ container, platform: 'pwa', isMobile: true, updateService });
  await shell.initialize();
  shell.render(container);
  const { uninstall } = installDialogSpies();
  try {
    // Simulate several page loads worth of checks in a row (what happened in
    // production every time the broken fallback reloaded the page).
    await shell.checkForUpdates(false);
    await shell.checkForUpdates(false);
    await shell.checkForUpdates(false);
    assert.equal(shell.state.updatePrompt, null, 'no update card should ever appear across repeated up-to-date checks');
  } finally {
    uninstall();
  }
});

test('checkForUpdates: a genuinely available update shows ONE correctly-versioned card; "now" applies the update', async () => {
  const container = document.createElement('div');
  const updateService = installFakeUpdateService([{ status: 'available', version: '0.2.0', force: false }], { installedVersion: '0.1.9' });
  const shell = new BrowserShell({ container, platform: 'pwa', isMobile: true, updateService });
  await shell.initialize();
  shell.render(container);
  const { reloads, uninstall } = installDialogSpies();
  try {
    await shell.checkForUpdates(false);
    assert.ok(shell.state.updatePrompt, 'card state set');
    assert.equal(shell.state.updatePrompt.version, '0.2.0', 'card carries the REAL version, nothing hardcoded');
    const card = findUpdateCard(container);
    assert.ok(card, 'update card rendered');
    const nowBtn = card.querySelector('.fb-update-prompt-now');
    assert.ok(nowBtn, 'has an explicit "now" action');
    assert.ok(card.querySelector('.fb-update-prompt-later'), 'has an explicit "Later" action');

    nowBtn.click();
    assert.equal(shell.state.updatePrompt, null, 'card dismissed after accepting');
    assert.equal(reloads.length, 1, 'accepting applies (reloads) exactly once');

    // A later check in the same session must not re-prompt (one per session).
    await shell.checkForUpdates(false);
    assert.equal(shell.state.updatePrompt, null, 'never a second card in the same session');
  } finally {
    clearUpdateCards();
    uninstall();
  }
});

test('checkForUpdates: "Later" dismisses the card without applying and does not loop on its own', async () => {
  const container = document.createElement('div');
  const updateService = installFakeUpdateService([{ status: 'available', version: '0.2.0', force: false }], { installedVersion: '0.1.9' });
  const shell = new BrowserShell({ container, platform: 'pwa', isMobile: true, updateService });
  await shell.initialize();
  shell.render(container);
  const { reloads, uninstall } = installDialogSpies();
  try {
    await shell.checkForUpdates(false);
    const card = findUpdateCard(container);
    assert.ok(card, 'update card rendered');
    card.querySelector('.fb-update-prompt-later').click();
    assert.equal(shell.state.updatePrompt, null, 'card dismissed');
    assert.equal(reloads.length, 0, 'Later must not reload the page');
    assert.equal(shell.state.updateState.status, 'ready', 'update stays ready for the toolbar chip/menu');
  } finally {
    clearUpdateCards();
    uninstall();
  }
});

test('checkForUpdates: never calls out to the raw GitHub Releases API directly (that duplicate fallback was removed)', async () => {
  const container = document.createElement('div');
  const updateService = installFakeUpdateService([{ status: 'upToDate', version: '0.1.9' }]);
  const shell = new BrowserShell({ container, platform: 'pwa', isMobile: true, updateService });
  await shell.initialize();
  const originalFetch = globalThis.fetch;
  let fetchCalled = false;
  globalThis.fetch = async (url) => {
    fetchCalled = true;
    throw new Error(`unexpected direct fetch during checkForUpdates: ${url}`);
  };
  const { uninstall } = installDialogSpies();
  try {
    await shell.checkForUpdates(false);
    assert.equal(fetchCalled, false, 'checkForUpdates must rely solely on the injected UpdateService, never a direct fetch');
  } finally {
    uninstall();
    globalThis.fetch = originalFetch;
  }
});

test('checkForUpdates: with no updateService configured, reports "unknown" instead of fabricating a false "ready" state', async () => {
  const container = document.createElement('div');
  const shell = new BrowserShell({ container, platform: 'pwa', isMobile: true });
  await shell.initialize();
  shell.render(container);
  const { uninstall } = installDialogSpies();
  try {
    await shell.checkForUpdates(false);
    assert.equal(shell.state.updatePrompt, null);
    assert.equal(shell.state.updateState.status, 'unknown');
  } finally {
    uninstall();
  }
});

test('checkForUpdates: a blocked/throwing alert() during applyUpdate must not be mistaken for a failed update check or skip the reload', async () => {
  // Regression for a second bug found while fixing the first: applyUpdate()
  // used to call the bare `alert(...)` global (not window.alert) inside the
  // same try/catch as the network check, so if the dialog ever throws or is
  // blocked (e.g. Chrome's "Prevent this page from creating additional
  // dialogs" safeguard), the state was silently reset to 'uptodate' and
  // window.location.reload() was never reached, with no visible error.
  const container = document.createElement('div');
  const updateService = installFakeUpdateService([{ status: 'available', version: '0.2.0', force: false }], { installedVersion: '0.1.9' });
  const shell = new BrowserShell({ container, platform: 'pwa', isMobile: true, updateService });
  await shell.initialize();
  shell.render(container);
  window.alert = () => { throw new Error('dialogs blocked by browser'); };
  window.location = window.location || {};
  const reloads = [];
  window.location.reload = () => reloads.push(true);
  try {
    await shell.checkForUpdates(false);
    findUpdateCard(container).querySelector('.fb-update-prompt-now').click();
    assert.equal(shell.state.updateState.status, 'ready', 'a blocked alert() must not be mistaken for a failed update check');
    assert.equal(shell.state.updateState.availableVersion, '0.2.0');
    assert.equal(reloads.length, 1, 'reload must still happen even if the informational alert() throws/is blocked');
  } finally {
    clearUpdateCards();
    delete window.alert;
  }
});

test('constructor: installedVersion is seeded from the real UpdateService, not a hardcoded placeholder', async () => {
  const container = document.createElement('div');
  const updateService = installFakeUpdateService([{ status: 'upToDate', version: '0.1.9' }], { installedVersion: '0.1.9' });
  const shell = new BrowserShell({ container, platform: 'pwa', isMobile: true, updateService });
  await shell.initialize();
  assert.equal(shell.state.updateState.installedVersion, '0.1.9');
});
