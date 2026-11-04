import test from 'node:test';
import assert from 'node:assert/strict';
import { setupDomShim } from './dom-shim.mjs';

setupDomShim();

import { BrowserShell } from '../packages/shared-ui/src/components/BrowserShell.js';

function tick() {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

async function makeShell() {
  const container = document.createElement('div');
  const shell = new BrowserShell({ container, isMobile: false });
  await shell.initialize();
  shell.render(container);
  return { shell, container };
}

test('chrome-only account, security, download, and drawer clicks preserve the shell and viewport nodes', async () => {
  const { shell } = await makeShell();
  try {
    const root = shell.rootElement;
    const viewport = shell.viewportElement;
    const navbar = root.querySelector('.fb-navbar');
    const originalRender = shell.render.bind(shell);
    let fullRenders = 0;
    shell.render = (...args) => { fullRenders += 1; return originalRender(...args); };

    root.querySelector('.fb-account-btn').click();
    assert.equal(shell.state.isAccountMenuOpen, true);
    assert.ok(root.querySelector('.fb-account-dropdown'));
    assert.equal(shell.rootElement, root);
    assert.equal(shell.viewportElement, viewport);
    assert.equal(root.querySelector('.fb-navbar'), navbar);

    root.querySelector('.fb-security-lock-btn').click();
    assert.equal(shell.state.isSecurityDropdownOpen, true);
    assert.ok(root.querySelector('.fb-security-dropdown'));

    root.querySelector('.fb-quick-downloads-btn').click();
    assert.equal(shell.state.isDownloadsDropdownOpen, true);
    assert.ok(root.querySelector('.fb-downloads-dropdown'));

    root.querySelector('.fb-menu-btn').click();
    assert.equal(shell.state.isSideDrawerOpen, true);
    assert.ok(root.querySelector('.fb-side-drawer-menu'));
    assert.equal(shell.rootElement, root);
    assert.equal(shell.viewportElement, viewport);
    assert.equal(root.querySelector('.fb-navbar'), navbar);

    // Close through the same real chrome controls: none should rebuild the
    // base shell either.
    root.querySelector('.fb-menu-btn').click();
    root.querySelector('.fb-quick-downloads-btn').click();
    root.querySelector('.fb-security-lock-btn').click();
    root.querySelector('.fb-account-btn').click();
    assert.equal(shell.state.isSideDrawerOpen, false);
    assert.equal(shell.state.isDownloadsDropdownOpen, false);
    assert.equal(shell.state.isSecurityDropdownOpen, false);
    assert.equal(shell.state.isAccountMenuOpen, false);
    assert.equal(root.querySelector('.fb-navbar'), navbar);
    assert.equal(fullRenders, 0, 'ordinary chrome overlay open/close clicks do not trigger a shell-wide render');
  } finally {
    shell.destroy();
  }
});

test('native surface stays live until its overlay snapshot image has loaded', async () => {
  let finishCapture;
  const calls = [];
  globalThis.window.yayra = {
    webview: {
      ensure: async () => ({}),
      setBounds: async (tabId, bounds) => calls.push(['bounds', tabId, bounds]),
      setVisible: async (tabId, visible) => { calls.push(['visible', tabId, visible]); },
      capture: () => new Promise((resolve) => { finishCapture = resolve; }),
      onEvent: () => () => {},
      destroy: async () => {},
      stop: async () => {},
      goBack: async () => {},
      goForward: async () => {},
      reload: async () => {}
    }
  };
  const container = document.createElement('div');
  const shell = new BrowserShell({ container, isMobile: false });
  await shell.initialize();
  const tab = shell.getActiveTab();
  tab.url = 'https://example.com/';
  shell._nativeWebviewTabIds.add(tab.id);
  shell.render(container);
  calls.length = 0;

  try {
    shell.rootElement.querySelector('.fb-menu-btn').click();
    assert.equal(calls.some((call) => call[0] === 'visible' && call[2] === false), false,
      'the view is not hidden while capturePage is still pending');

    finishCapture({ snapshot: 'data:image/png;base64,TEST' });
    await tick();
    const still = shell.viewportElement.querySelector('.fb-page-snapshot-img');
    assert.ok(still, 'the captured image is mounted below the overlay');
    assert.equal(typeof still.onload, 'function', 'hiding waits for the image load event');
    assert.equal(calls.some((call) => call[0] === 'visible' && call[2] === false), false,
      'the native page remains visible until the still has painted');

    still.onload();
    await tick();
    assert.ok(calls.some((call) => call[0] === 'visible' && call[2] === false),
      'the native view hides only after the placeholder is painted');
  } finally {
    shell.destroy();
    delete globalThis.window.yayra;
  }
});
