import test from 'node:test';
import assert from 'node:assert/strict';
import { setupDomShim } from './dom-shim.mjs';

setupDomShim();

const storage = new Map();
globalThis.localStorage = {
  getItem: (key) => storage.get(key) ?? null,
  setItem: (key, value) => storage.set(key, String(value)),
  removeItem: (key) => storage.delete(key),
  key: (index) => [...storage.keys()][index] ?? null,
  get length() { return storage.size; }
};

const { BrowserShell } = await import('../packages/shared-ui/src/components/BrowserShell.js');

async function makeShell({ close = () => {}, quit = () => {} } = {}) {
  window.yayra = {
    windowControls: {
      close,
      quit,
      minimize: () => {},
      toggleMaximize: () => {},
      isMaximized: async () => false
    }
  };
  const container = document.createElement('div');
  const shell = new BrowserShell({ container, platform: 'linux', isMobile: false });
  await shell.initialize();
  shell.render(container);
  return { shell, container };
}

test('window close works with a website open: the prompt is visible, and choosing close calls the bridge once', async () => {
  storage.clear();
  const calls = [];
  const { shell, container } = await makeShell({ close: () => calls.push('close') });
  try {
    const tab = shell.getActiveTab();
    tab.url = 'https://example.test/dashboard';
    tab.title = 'Dashboard';
    shell.render(container);

    const close = container.querySelector('.fb-wc-close');
    assert.ok(close, 'frameless window close control is rendered');
    assert.equal(close.type, 'button', 'close is never treated as a form submit');
    close.click();

    assert.equal(shell.state.closePrompt, true, 'closing a window with work asks how to preserve the session');
    assert.ok(container.querySelector('.fb-close-prompt-modal'), 'the prompt paints above the browsing surface');
    assert.deepEqual(calls, [], 'the window remains open until a session choice is made');

    container.querySelector('.fb-close-just-close').click();
    assert.deepEqual(calls, ['close'], 'the selected close action reaches the main-process bridge');
    assert.equal(shell.state.closePrompt, false);
  } finally {
    shell.destroy();
    delete window.yayra;
  }
});

test('a rejected window-close IPC reports a retryable message instead of silently appearing dead', async () => {
  const { shell, container } = await makeShell({ close: () => Promise.reject(new Error('IPC unavailable')) });
  const notices = [];
  shell.showTransientNotice = (message) => notices.push(message);
  try {
    container.querySelector('.fb-wc-close').click();
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.deepEqual(notices, ['Yayra could not close this window. Please try again.']);
  } finally {
    shell.destroy();
    delete window.yayra;
  }
});

test('successful native main-frame completion clears stale loading UI and heals the active surface', async () => {
  const { shell, container } = await makeShell();
  try {
    const tab = shell.getActiveTab();
    tab.url = 'https://example.test/slow';
    let healed = 0;
    let ensured = null;
    shell.healStuckPageSurface = () => { healed += 1; };
    shell.ensureActiveNativeSurfaceLive = (tabId) => { ensured = tabId; };
    shell.updateTabLoading(tab.id, true);
    assert.equal(tab.isLoading, true);

    shell.handleNativeWebviewEvent({ tabId: tab.id, type: 'load-succeeded', url: tab.url });

    assert.equal(tab.isLoading, false, 'a positive completion cannot leave the toolbar stuck on Stop');
    assert.equal(container.querySelector('.fb-nav-reload')?.getAttribute('aria-label'), 'Reload');
    assert.equal(healed, 1, 'completion rechecks stale page-snapshot state');
    assert.equal(ensured, tab.id, 'completion restores current native bounds/visibility');
  } finally {
    shell.destroy();
    delete window.yayra;
  }
});

test('slow-load warning is one-shot per navigation and does not stop the page', async () => {
  const { shell } = await makeShell();
  const notices = [];
  shell.showTransientNotice = (message) => notices.push(message);
  try {
    const tab = shell.getActiveTab();
    tab.isLoading = true;
    const startedAt = 1000;

    assert.equal(shell._maybeNotifySlowNativeLoad(tab, startedAt, startedAt + 14999), false,
      'no warning during the normal loading grace period');
    assert.equal(shell._maybeNotifySlowNativeLoad(tab, startedAt, startedAt + 15000), true);
    assert.equal(shell._maybeNotifySlowNativeLoad(tab, startedAt, startedAt + 30000), false,
      'only one notice is emitted for the same navigation generation');
    assert.equal(tab.isLoading, true, 'slow-page feedback never cancels a page that may still finish');
    assert.equal(notices.length, 1);
    assert.match(notices[0], /keep waiting or click Stop/);
  } finally {
    shell.destroy();
    delete window.yayra;
  }
});
