import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setupDomShim } from './dom-shim.mjs';

const repoRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

setupDomShim();

import { BrowserShell } from '../packages/shared-ui/src/components/BrowserShell.js';

/**
 * Regression coverage for the "everything renders on different cards" bug
 * on Electron desktop: a native WebContentsView always paints ABOVE the
 * HTML document, so the side drawer / modals / mini window / dropdowns
 * used to be covered and clipped by the page instead of overlaying it.
 *
 * The fix: whenever any chrome overlay is open (hasBlockingOverlay()),
 * the native page surface is hidden - with a pre-hide snapshot captured
 * and shown as a still image in the page slot - and restored when the
 * overlay closes. Also covers the "two floating bubbles" fix (the in-page
 * DOM bubble is suppressed on Electron where the native overlay-window
 * bubble exists) and the desktop update download/install pipeline.
 */

function installFakeNativeWebview() {
  const calls = { ensure: [], setBounds: [], setVisible: [], destroy: [] };
  const fake = {
    ensure: (tabId, url, isPrivate) => { calls.ensure.push({ tabId, url, isPrivate }); return Promise.resolve({ handedOffToSystemBrowser: false }); },
    setBounds: (tabId, bounds) => { calls.setBounds.push({ tabId, bounds }); return Promise.resolve(); },
    setVisible: (tabId, visible, options) => {
      calls.setVisible.push({ tabId, visible, options });
      if (visible === false && options && options.capture) {
        return Promise.resolve({ snapshot: 'data:image/png;base64,SNAPSHOT' });
      }
      return Promise.resolve();
    },
    goBack: () => Promise.resolve(),
    goForward: () => Promise.resolve(),
    reload: () => Promise.resolve(),
    stop: () => Promise.resolve(),
    destroy: (tabId) => { calls.destroy.push(tabId); return Promise.resolve(); },
    onEvent: () => () => {}
  };
  globalThis.window.yayra = { webview: fake };
  return { fake, calls, uninstall: () => { delete globalThis.window.yayra; } };
}

// Update prompt cards mount on document.body (window-level overlays).
function clearUpdateCards() {
  document.getElementById('yayra-update-prompt-card')?.remove();
  document.getElementById('yayra-update-install-card')?.remove();
}

async function makeDesktopShellOnExternalPage() {
  const container = document.createElement('div');
  const shell = new BrowserShell({ container, platform: 'linux', isMobile: false });
  await shell.initialize();
  shell.navigateActiveTab('https://www.google.com/search?q=ghana');
  shell.render(container);
  return { container, shell };
}

test('opening the side drawer hides the native page surface (with a pre-hide capture) so the menu truly overlays the page', async () => {
  const { calls, uninstall } = installFakeNativeWebview();
  try {
    const { container, shell } = await makeDesktopShellOnExternalPage();
    const tabId = shell.getActiveTab().id;
    calls.setVisible.length = 0;

    shell.state.isSideDrawerOpen = true;
    const el = shell.render(container);

    const hide = calls.setVisible.find((c) => c.tabId === tabId && c.visible === false);
    assert.ok(hide, 'native view is hidden while the drawer is open');
    assert.equal(hide.options?.capture, true, 'a snapshot is requested BEFORE hiding');
    assert.ok(el.querySelector('.fb-side-drawer-menu'), 'drawer chrome is rendered');
    assert.ok(el.querySelector('.fb-page-snapshot-img'), 'a still image stands in for the page under the drawer');

    // Closing the drawer shows the live page again.
    calls.setVisible.length = 0;
    shell.state.isSideDrawerOpen = false;
    const closed = shell.render(container);
    const show = calls.setVisible.find((c) => c.tabId === tabId && c.visible === true);
    assert.ok(show, 'native view becomes visible again once the drawer closes');
    assert.equal(closed.querySelector('.fb-page-snapshot-img'), null, 'snapshot placeholder is gone');
  } finally {
    uninstall();
  }
});

test('every chrome overlay kind blocks the page surface: modal, security dropdown, account menu, mini window, radial, find bar', async () => {
  const { uninstall } = installFakeNativeWebview();
  try {
    const { shell } = await makeDesktopShellOnExternalPage();
    assert.equal(shell.hasBlockingOverlay(), false);
    const flags = [
      ['activeModal', 'menu'],
      ['isSecurityDropdownOpen', true],
      ['isAccountMenuOpen', true],
      ['isFloatingMiniOpen', true],
      ['isRadialLauncherOpen', true],
      ['isPageObscured', true]
    ];
    for (const [key, value] of flags) {
      shell.state[key] = value;
      assert.equal(shell.hasBlockingOverlay(), true, `${key} must hide the native page surface`);
      shell.state[key] = key === 'activeModal' ? null : false;
    }
    shell.state.findInPage.isOpen = true;
    assert.equal(shell.hasBlockingOverlay(), true, 'find-in-page bar must hide the native page surface');
    shell.state.findInPage.isOpen = false;
    assert.equal(shell.hasBlockingOverlay(), false);
  } finally {
    uninstall();
  }
});

test('ONE bubble on desktop: the in-page DOM bubble is suppressed when the native overlay bubble exists (Electron)', async () => {
  const { uninstall } = installFakeNativeWebview();
  try {
    const { shell, container } = await makeDesktopShellOnExternalPage();
    shell.render(container);
    assert.equal(document.getElementById('yayra-persistent-assistive-bubble'), null,
      'no in-page bubble on Electron - the native overlay window is the single bubble');
  } finally {
    uninstall();
  }
});

test('the in-page bubble still exists on web/PWA builds (no native overlay window is possible there)', async () => {
  delete globalThis.window.yayra;
  const container = document.createElement('div');
  const shell = new BrowserShell({ container, platform: 'pwa', isMobile: false });
  await shell.initialize();
  shell.render(container);
  assert.ok(document.getElementById('yayra-persistent-assistive-bubble'),
    'web builds keep the in-page assistive bubble');
  document.getElementById('yayra-persistent-assistive-bubble')?.remove();
});

test('"minimize to bubble" on Electron hides the real OS window via the overlay bridge instead of faking it in-page', async () => {
  const { uninstall } = installFakeNativeWebview();
  const minimizeCalls = [];
  globalThis.window.yayra.overlay = { minimizeMainWindow: () => minimizeCalls.push(true) };
  try {
    const { shell } = await makeDesktopShellOnExternalPage();
    shell.minimizeToBubble();
    assert.equal(minimizeCalls.length, 1, 'OS window hidden through the overlay bridge');
    assert.equal(shell.state.isMinimizedToBubble, false, 'no in-page fake-minimize state on Electron');
  } finally {
    uninstall();
  }
});

test('desktop update pipeline: confirming an available update downloads via the main process, verifies, then launches the installer', async () => {
  const { uninstall } = installFakeNativeWebview();
  const downloadCalls = [];
  const installCalls = [];
  globalThis.window.yayra.updates = {
    check: async () => ({ status: 'checking' }),
    download: async (payload) => { downloadCalls.push(payload); return { status: 'staged', path: '/tmp/staged/yayra-0.4.0.deb' }; },
    install: async (payload) => { installCalls.push(payload); return { status: 'install_started', method: 'os-installer' }; },
    onEvent: () => () => {}
  };
  const updateService = {
    installedVersion: '0.3.0',
    target: 'linux',
    check: async () => ({
      status: 'available',
      version: '0.4.0',
      installedVersion: '0.3.0',
      download: { url: 'https://github.com/g2code33/yayra/releases/download/v0.4.0/yayra-0.4.0.deb', sha256: 'abc123', bytes: 1000 }
    })
  };
  window.alert = () => {};
  try {
    const container = document.createElement('div');
    const shell = new BrowserShell({ container, platform: 'linux', isMobile: false, updateService });
    await shell.initialize();
    shell.render(container);

    await shell.checkForUpdates(true);
    // The in-app update card offers "Download & install now" / "Later" -
    // accept it, which kicks off the async desktop download; let it settle.
    const card = document.getElementById('yayra-update-prompt-card');
    assert.ok(card, 'update card rendered for the available update');
    assert.match(String(card.querySelector('.fb-update-prompt-now').textContent), /Download/i, 'desktop pipeline wording');
    card.querySelector('.fb-update-prompt-now').click();
    await new Promise((resolve) => setTimeout(resolve, 10));

    // Staged (downloaded + verified) now ASKS when to install: now, when
    // opened again, or later - choose "Install & restart now".
    assert.equal(downloadCalls.length, 1, 'download already ran');
    assert.equal(installCalls.length, 0, 'install must NOT run behind the user\u2019s back');
    const installCard = document.getElementById('yayra-update-install-card');
    assert.ok(installCard, 'install choice card rendered after staging');
    assert.ok(installCard.querySelector('.fb-update-install-next-launch'), 'offers install-on-next-launch');
    assert.ok(installCard.querySelector('.fb-update-install-later'), 'offers later/manual');
    installCard.querySelector('.fb-update-install-now').click();
    await new Promise((resolve) => setTimeout(resolve, 10));

    assert.equal(downloadCalls.length, 1, 'main-process download started');
    assert.equal(downloadCalls[0].url, 'https://github.com/g2code33/yayra/releases/download/v0.4.0/yayra-0.4.0.deb');
    assert.equal(downloadCalls[0].sha256, 'abc123', 'manifest checksum is passed for fail-closed verification');
    assert.equal(downloadCalls[0].bytes, 1000);
    assert.equal(downloadCalls[0].target, 'linux');
    assert.deepEqual(installCalls, [{ path: '/tmp/staged/yayra-0.4.0.deb', version: '0.4.0' }], 'verified staged file (path + version) is handed to the OS installer');
    // The OS installer is now replacing the app - the honest state is
    // "installing" (it only falls back to "staged" if the install fails).
    assert.equal(shell.state.updateState.status, 'installing');
  } finally {
    clearUpdateCards();
    delete window.alert;
    uninstall();
  }
});

test('desktop update pipeline: a failed/tampered download surfaces as an error state - never as installed', async () => {
  const { uninstall } = installFakeNativeWebview();
  globalThis.window.yayra.updates = {
    check: async () => ({ status: 'checking' }),
    download: async () => ({ status: 'error', reason: 'checksum:sha256-mismatch expected=x actual=y' }),
    install: async () => { throw new Error('must never be called'); },
    onEvent: () => () => {}
  };
  const updateService = {
    installedVersion: '0.3.0',
    target: 'linux',
    check: async () => ({
      status: 'available', version: '0.4.0', installedVersion: '0.3.0',
      download: { url: 'https://example.com/yayra.deb', sha256: 'x', bytes: 10 }
    })
  };
  window.alert = () => {};
  try {
    const container = document.createElement('div');
    const shell = new BrowserShell({ container, platform: 'linux', isMobile: false, updateService });
    await shell.initialize();
    shell.render(container);
    await shell.checkForUpdates(true);
    const card = document.getElementById('yayra-update-prompt-card');
    assert.ok(card, 'update card rendered');
    card.querySelector('.fb-update-prompt-now').click();
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(shell.state.updateState.status, 'error');
    assert.match(shell.state.updateState.notes, /sha256-mismatch/);
  } finally {
    clearUpdateCards();
    delete window.alert;
    uninstall();
  }
});

test('manual update check gives visible feedback even when already up to date (transient notice)', async () => {
  delete globalThis.window.yayra;
  const notices = [];
  const container = document.createElement('div');
  const updateService = {
    installedVersion: '0.3.0',
    target: 'pwa',
    check: async () => ({ status: 'upToDate', version: '0.3.0', installedVersion: '0.3.0' })
  };
  const shell = new BrowserShell({ container, platform: 'pwa', isMobile: true, updateService });
  shell.showTransientNotice = (message) => notices.push(message);
  await shell.initialize();
  await shell.checkForUpdates(true);
  assert.equal(notices.length, 1, 'manual check always answers the user');
  assert.match(notices[0], /up to date/i);
  assert.match(notices[0], /0\.3\.0/);
});

test('a thrown update check is reported as an error state with feedback - not silently shown as "up to date"', async () => {
  delete globalThis.window.yayra;
  const notices = [];
  const container = document.createElement('div');
  const updateService = {
    installedVersion: '0.3.0',
    target: 'pwa',
    check: async () => { throw new Error('network down'); }
  };
  const shell = new BrowserShell({ container, platform: 'pwa', isMobile: true, updateService });
  shell.showTransientNotice = (message) => notices.push(message);
  await shell.initialize();
  await shell.checkForUpdates(true);
  assert.equal(shell.state.updateState.status, 'error');
  assert.equal(notices.length, 1);
  assert.match(notices[0], /failed/i);
});

/* -----------------------------------------------------------------
 * Overlay ordering: capture starts before the native surface is hidden,
 * but the view hides synchronously so chrome can never sit behind it.
 * The fresh still is painted asynchronously over the last available one.
 * ----------------------------------------------------------------- */

function installCaptureCapableWebview() {
  const order = [];
  const calls = { capture: [], setVisible: [] };
  const fake = {
    ensure: () => Promise.resolve({ handedOffToSystemBrowser: false }),
    setBounds: () => Promise.resolve(),
    capture: (tabId) => {
      calls.capture.push(tabId);
      order.push('capture');
      return Promise.resolve({ snapshot: 'data:image/png;base64,LIVE-SNAPSHOT' });
    },
    setVisible: (tabId, visible, options) => {
      calls.setVisible.push({ tabId, visible, options });
      order.push(`setVisible:${visible}`);
      return Promise.resolve();
    },
    goBack: () => Promise.resolve(),
    goForward: () => Promise.resolve(),
    reload: () => Promise.resolve(),
    stop: () => Promise.resolve(),
    destroy: () => Promise.resolve(),
    onEvent: () => () => {}
  };
  globalThis.window.yayra = { webview: fake };
  return { fake, calls, order, uninstall: () => { delete globalThis.window.yayra; } };
}

async function waitForCondition(cond, ms = 2000) {
  const start = Date.now();
  while (Date.now() - start < ms) {
    if (cond()) return true;
    await new Promise((r) => setTimeout(r, 15));
  }
  return false;
}

test('drawer shows immediately: starts capture before hiding the native view and paints the fresh still asynchronously', async () => {
  const { calls, order, uninstall } = installCaptureCapableWebview();
  try {
    const { container, shell } = await makeDesktopShellOnExternalPage();
    const tabId = shell.getActiveTab().id;
    calls.setVisible.length = 0;
    calls.capture.length = 0;
    order.length = 0;

    shell.state.isSideDrawerOpen = true;
    shell.render(container);

    // Start a fresh capture from the active page, then immediately hide the
    // native surface so the drawer is never composited underneath the page.
    assert.deepEqual(calls.capture, [tabId], 'capture requested for the active tab');
    assert.equal(calls.setVisible.length, 1, 'native view is hidden synchronously');
    assert.equal(calls.setVisible[0].visible, false);
    assert.deepEqual(order.slice(0, 2), ['capture', 'setVisible:false'], 'capture starts immediately before the hide');

    // The live chrome is already visible; only the higher-quality still is
    // asynchronous and replaces the cached/empty placeholder when ready.
    const still = container.querySelector('.fb-page-snapshot-img');
    assert.ok(still, 'still image placeholder rendered');
    assert.equal(order[0], 'capture', 'capture starts before the hide');
    assert.ok(order.indexOf('setVisible:false') > order.indexOf('capture'));
    assert.ok(await waitForCondition(() => still.src === 'data:image/png;base64,LIVE-SNAPSHOT'),
      'freshly captured snapshot painted into the slot');

    // Closing the drawer restores the live page.
    shell.state.isSideDrawerOpen = false;
    shell.render(container);
    assert.ok(calls.setVisible.some((c) => c.visible === true), 'page surface restored');
  } finally {
    uninstall();
  }
});

test('overlay stays in front even when the asynchronous snapshot capture fails', async () => {
  const { fake, calls, uninstall } = installCaptureCapableWebview();
  fake.capture = () => Promise.reject(new Error('capture backend gone'));
  try {
    const { container, shell } = await makeDesktopShellOnExternalPage();
    calls.setVisible.length = 0;

    shell.state.isSideDrawerOpen = true;
    shell.render(container);

    assert.ok(await waitForCondition(() => calls.setVisible.some((c) => c.visible === false)),
      'hide still happens when the capture fails');
  } finally {
    uninstall();
  }
});

test('THE update prompt overlays ANYTHING: while it is up the native page surface is held back', async () => {
  const { uninstall } = installFakeNativeWebview();
  try {
    const { shell } = await makeDesktopShellOnExternalPage();
    assert.equal(shell.hasBlockingOverlay(), false);
    shell.state.updatePrompt = { version: '9.9.9', notes: '', relaunch: false, desktopPipeline: false };
    assert.equal(shell.hasBlockingOverlay(), true,
      '"Update available" card must hide the native page surface (it paints ABOVE all HTML - without this the prompt is invisible)');
    shell.state.updatePrompt = null;
    shell.state.updateInstallPrompt = { path: '/tmp/yayra.deb', version: '9.9.9' };
    assert.equal(shell.hasBlockingOverlay(), true,
      '"Update downloaded" install-choice card must do the same');
    shell.state.updateInstallPrompt = null;
    assert.equal(shell.hasBlockingOverlay(), false, 'the live page returns once the prompt is gone');
  } finally {
    clearUpdateCards();
    uninstall();
  }
});

test('THE update prompt is a window-level card on document.body at the TOP RIGHT CORNER - and "Later" removes it', async () => {
  const { uninstall } = installFakeNativeWebview();
  try {
    const { shell, container } = await makeDesktopShellOnExternalPage();
    shell.state.updatePrompt = { version: '9.9.9', notes: '', relaunch: false, desktopPipeline: false };
    shell.render(container);
    const card = document.getElementById('yayra-update-prompt-card');
    assert.ok(card, 'prompt card rendered');
    assert.equal(card.parentElement, document.body,
      'mounted on document.body - no shell stacking context can ever cover it');
    assert.ok(card.className.includes('fb-update-prompt-card'), 'keeps the styled class');
    assert.equal(container.querySelector('.fb-update-prompt-card'), null,
      'NOT buried inside the shell tree');

    card.querySelector('.fb-update-prompt-later').click();
    assert.equal(document.getElementById('yayra-update-prompt-card'), null,
      '"Later" removes the card - a dismissed prompt never lingers');
    assert.equal(shell.hasBlockingOverlay(), false);
  } finally {
    clearUpdateCards();
    uninstall();
  }
});

test('the update prompt CSS pins it to the top right corner at the MAXIMUM z-index (nothing can overlay it)', () => {
  const css = fs.readFileSync(path.join(repoRoot, 'packages/shared-ui/src/theme/design-system.css'), 'utf8');
  const match = css.match(/\.fb-update-prompt-card\s*\{[^}]*\}/);
  assert.ok(match, '.fb-update-prompt-card rule exists');
  const block = match[0];
  assert.match(block, /position:\s*fixed/, 'window-level overlay');
  assert.match(block, /top:\s*12px/, 'at the top right corner (top)');
  assert.match(block, /right:\s*12px/, 'at the top right corner (right)');
  assert.match(block, /z-index:\s*2147483647/,
    'maximum CSS z-index - above every other layer including the update splash (2147483000) and close-prompt modals (600001)');
});
