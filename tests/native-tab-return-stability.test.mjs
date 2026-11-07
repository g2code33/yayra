import test from 'node:test';
import assert from 'node:assert/strict';
import { setupDomShim } from './dom-shim.mjs';

setupDomShim();

import { BrowserShell } from '../packages/shared-ui/src/components/BrowserShell.js';

function installNativeWebview() {
  const calls = { ensure: [], visible: [], bounds: [] };
  globalThis.window.yayra = {
    webview: {
      ensure: async (tabId, url) => { calls.ensure.push({ tabId, url }); return {}; },
      setVisible: async (tabId, visible) => { calls.visible.push({ tabId, visible }); },
      setBounds: async (tabId, bounds) => { calls.bounds.push({ tabId, bounds }); },
      capture: async () => ({ snapshot: 'data:image/png;base64,tab-preview' }),
      destroy: async () => {},
      onEvent: () => () => {}
    }
  };
  return { calls, uninstall: () => { delete globalThis.window.yayra; } };
}

test('full chrome renders swap the shell atomically instead of painting an empty frame', async () => {
  delete globalThis.window.yayra;
  const container = document.createElement('div');
  const shell = new BrowserShell({ container, platform: 'linux', isMobile: false });
  await shell.initialize();
  try {
    shell.render(container);
    const previousRoot = shell.rootElement;
    let oldShellStayedPaintedDuringBuild = false;
    const renderDesktopLayout = shell.renderDesktopLayout.bind(shell);
    shell.renderDesktopLayout = (...args) => {
      oldShellStayedPaintedDuringBuild = previousRoot.parentElement === container;
      return renderDesktopLayout(...args);
    };

    shell.state.isSideDrawerOpen = true;
    shell.render(container);

    assert.equal(oldShellStayedPaintedDuringBuild, true,
      'the prior browser surface remains attached while the replacement chrome is assembled');
    assert.notEqual(shell.rootElement, previousRoot, 'the new shell becomes the active tree');
    assert.equal(previousRoot.parentElement, null, 'the prior tree is detached only by the final swap');
    assert.equal(container.querySelectorAll('.fb-browser-shell').length, 1,
      'only one complete shell is left after the atomic replacement');
  } finally {
    shell.destroy();
  }
});

test('returning to a native tab force-restores visibility and fresh nonzero viewport bounds', async () => {
  const { calls, uninstall } = installNativeWebview();
  const container = document.createElement('div');
  const shell = new BrowserShell({ container, platform: 'linux', isMobile: false });
  await shell.initialize();
  try {
    const first = shell.getActiveTab();
    first.url = 'https://first.example.test/dashboard';
    shell.render(container);

    // Give every newly rendered native slot real browser-like geometry. The
    // headless DOM shim intentionally reports zero rectangles by default.
    const attachNativeWebviewSlot = shell.attachNativeWebviewSlot.bind(shell);
    shell.attachNativeWebviewSlot = (wrapper, ...args) => {
      attachNativeWebviewSlot(wrapper, ...args);
      wrapper.getBoundingClientRect = () => ({
        x: 8, y: 88, left: 8, top: 88, right: 1208, bottom: 788, width: 1200, height: 700
      });
    };

    const second = shell.createNewTab(false, { render: false });
    second.url = 'https://second.example.test/';
    shell.render(container);
    calls.visible.length = 0;
    calls.bounds.length = 0;

    shell.selectTab(first.id);

    assert.ok(calls.visible.some((call) => call.tabId === first.id && call.visible === true),
      'the returned WebContentsView is explicitly shown, even if its cached visibility was stale');
    assert.ok(calls.bounds.some((call) => call.tabId === first.id
      && call.bounds.width === 1200 && call.bounds.height === 700),
    'the returned page receives fresh viewport bounds instead of remaining at the hidden 0×0 rectangle');
  } finally {
    shell.destroy();
    uninstall();
  }
});
