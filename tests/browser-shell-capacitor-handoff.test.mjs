import test from 'node:test';
import assert from 'node:assert/strict';
import { setupDomShim } from './dom-shim.mjs';

setupDomShim();

import { BrowserShell } from '../packages/shared-ui/src/components/BrowserShell.js';

/**
 * Android/iOS (Capacitor) run the whole app - including BrowserShell.js -
 * inside ONE system WebView. A nested <iframe> inside that WebView is
 * subject to the exact same X-Frame-Options/frame-ancestors restrictions a
 * desktop browser tab would see. Google explicitly restricts OAuth
 * authorization in embedded user agents; ordinary account pages are not
 * automatically classified as OAuth, while Apple/Microsoft keep their
 * existing handoff behavior. These tests cover the Capacitor-side routing
 * without requiring a real Android/iOS runtime (unavailable in this
 * environment - see the test names for what is and is not exercised).
 */

function installFakeCapacitorBrowser() {
  const opened = [];
  window.Capacitor = {
    isNativePlatform: () => true,
    Plugins: {
      Browser: {
        open: (opts) => { opened.push(opts.url); return Promise.resolve(); }
      }
    }
  };
  return { opened, uninstall: () => { delete window.Capacitor; } };
}

test('capacitorBrowser getter: absent on plain web/PWA (no window.Capacitor)', async () => {
  delete globalThis.window.Capacitor;
  const container = document.createElement('div');
  const shell = new BrowserShell({ container, platform: 'android', isMobile: true });
  await shell.initialize();
  assert.equal(shell.capacitorBrowser, null);
});

test('capacitorBrowser getter: absent when Capacitor is present but running in a plain mobile web browser tab (isNativePlatform() false)', async () => {
  window.Capacitor = { isNativePlatform: () => false, Plugins: { Browser: { open: async () => {} } } };
  try {
    const container = document.createElement('div');
    const shell = new BrowserShell({ container, platform: 'android', isMobile: true });
    await shell.initialize();
    assert.equal(shell.capacitorBrowser, null);
  } finally {
    delete window.Capacitor;
  }
});

test('isSystemBrowserAuthHost: matches OAuth and interactive Google sign-in, but leaves account/product pages alone', async () => {
  const container = document.createElement('div');
  const shell = new BrowserShell({ container, platform: 'android', isMobile: true });
  await shell.initialize();

  assert.equal(shell.isSystemBrowserAuthHost('https://accounts.google.com/'), false);
  assert.equal(shell.isSystemBrowserAuthHost('https://accounts.google.com/ManageAccount'), false);
  assert.equal(shell.isSystemBrowserAuthHost('https://accounts.google.com/signin/v2/identifier'), true);
  assert.equal(shell.isSystemBrowserAuthHost('https://accounts.google.com/v3/signin/rejected'), true);
  assert.equal(shell.isSystemBrowserAuthHost('https://accounts.google.com/ServiceLogin'), true);
  assert.equal(shell.isSystemBrowserAuthHost('https://accounts.google.com/o/oauth2/v2/auth?client_id=x'), true);
  assert.equal(shell.isSystemBrowserAuthHost('https://accounts.google.com/signin/oauth?client_id=x'), true);
  assert.equal(shell.isSystemBrowserAuthHost('https://appleid.apple.com/auth'), true);
  assert.equal(shell.isSystemBrowserAuthHost('https://sub.login.microsoftonline.com/'), true);
  assert.equal(shell.isSystemBrowserAuthHost('https://www.google.com/search?q=ghana'), false);
  assert.equal(shell.isSystemBrowserAuthHost('https://myaccount.google.com/security'), false);
  assert.equal(shell.isSystemBrowserAuthHost('http://accounts.google.com/signin/v2/identifier'), true);
  assert.equal(shell.isSystemBrowserAuthHost('http://accounts.google.com/o/oauth2/v2/auth'), true);
});

test('Capacitor: HTTP Google OAuth authorization is upgraded before it opens externally', async () => {
  const { opened, uninstall } = installFakeCapacitorBrowser();
  try {
    const container = document.createElement('div');
    const shell = new BrowserShell({ container, platform: 'android', isMobile: true });
    await shell.initialize();
    shell.navigateActiveTab('http://accounts.google.com/o/oauth2/v2/auth?client_id=x');
    await Promise.resolve();
    await Promise.resolve();
    assert.deepEqual(opened, ['https://accounts.google.com/o/oauth2/v2/auth?client_id=x']);
  } finally {
    uninstall();
  }
});

test('Capacitor: Google embedded-browser rejection is reopened as a clean HTTPS ServiceLogin URL', async () => {
  const { opened, uninstall } = installFakeCapacitorBrowser();
  try {
    const container = document.createElement('div');
    const shell = new BrowserShell({ container, platform: 'android', isMobile: true });
    await shell.initialize();
    const rejected = new URL('https://accounts.google.com/v3/signin/rejected');
    rejected.searchParams.set('continue', 'https://mail.google.com/mail/u/0/#inbox');
    shell.navigateActiveTab(rejected.toString());
    await Promise.resolve();
    await Promise.resolve();
    assert.equal(opened.length, 1);
    const repaired = new URL(opened[0]);
    assert.equal(repaired.pathname, '/ServiceLogin');
    assert.equal(repaired.searchParams.get('continue'), 'https://mail.google.com/mail/u/0/');
  } finally {
    uninstall();
  }
});

test('Capacitor (Android/iOS): explicit Google OAuth navigation opens the native in-app browser instead of an embedded iframe', async () => {
  const { opened, uninstall } = installFakeCapacitorBrowser();
  try {
    const container = document.createElement('div');
    const shell = new BrowserShell({ container, platform: 'android', isMobile: true });
    await shell.initialize();

    shell.navigateActiveTab('https://accounts.google.com/o/oauth2/v2/auth?client_id=x');
    const el = shell.rootElement;

    assert.equal(el.querySelector('iframe'), null, 'the OAuth authorization request is never embedded in an iframe');
    // Allow the openExternally() promise microtask to resolve.
    await Promise.resolve();
    await Promise.resolve();
    assert.deepEqual(opened, ['https://accounts.google.com/o/oauth2/v2/auth?client_id=x']);

    shell.render();
    shell.render();
    await Promise.resolve();
    assert.deepEqual(opened, ['https://accounts.google.com/o/oauth2/v2/auth?client_id=x'], 'chrome re-renders do not reopen the same OAuth request');
  } finally {
    uninstall();
  }
});

test('Capacitor (Android/iOS): a google SEARCH opens in the native secure browser view - never a dead card (no engine allows embedded results since Oct 2026)', async () => {
  const { opened, uninstall } = installFakeCapacitorBrowser();
  try {
    const container = document.createElement('div');
    const shell = new BrowserShell({ container, platform: 'android', isMobile: true });
    await shell.initialize();

    shell.navigateActiveTab('https://www.google.com/search?q=ghana');
    const el = shell.rootElement;
    await Promise.resolve();
    await Promise.resolve();

    // VERIFIED Oct 2026: lite/html.duckduckgo.com now send
    // X-Frame-Options: SAMEORIGIN - the old DDG-iframe fallback rendered
    // a REFUSED blank frame. The search now genuinely opens.
    assert.deepEqual(opened, ['https://www.google.com/search?q=ghana'],
      'the REAL google search opens in the secure browser view automatically');
    assert.equal(el.querySelector('iframe'), null, 'no dead embedded results frame');
    const card = el.querySelector('.fb-serp-handoff-fallback');
    assert.ok(card, 'honest search-handoff card stays in the tab');
    assert.match(card.querySelector('.fb-frame-blocked-open-btn').textContent, /Open search/);

    // The card's button hands the ORIGINAL Google URL over again.
    card.querySelector('.fb-frame-blocked-open-btn').click();
    await Promise.resolve();
    await Promise.resolve();
    assert.equal(opened.length, 2, 'the button re-opens the real search on demand');
  } finally {
    uninstall();
  }
});

test('Capacitor (Android/iOS): a frame-hostile NON-search site (google.com homepage) auto-opens in the native secure browser view, card stays with Open again', async () => {
  const { opened, uninstall } = installFakeCapacitorBrowser();
  try {
    const container = document.createElement('div');
    const shell = new BrowserShell({ container, platform: 'android', isMobile: true });
    await shell.initialize();

    shell.navigateActiveTab('https://www.google.com/');
    await Promise.resolve();
    await Promise.resolve();
    assert.deepEqual(opened, ['https://www.google.com/'], 'the user asked for google.com, so google.com OPENS - automatically');

    const el = shell.rootElement;
    const openBtn = el.querySelector('.fb-frame-blocked-open-btn');
    assert.ok(openBtn, 'fallback card remains behind with a re-open action');
    openBtn.click();
    await Promise.resolve();
    await Promise.resolve();
    assert.deepEqual(opened, ['https://www.google.com/', 'https://www.google.com/']);
  } finally {
    uninstall();
  }
});

test('Plain web/PWA (no Capacitor, no Electron): Google OAuth handoff falls back to window.open', async () => {
  delete globalThis.window.Capacitor;
  const originalOpen = window.open;
  const openedUrls = [];
  window.open = (url) => { openedUrls.push(url); };
  try {
    const container = document.createElement('div');
    const shell = new BrowserShell({ container, platform: 'linux', isMobile: false });
    await shell.initialize();

    shell.navigateActiveTab('https://accounts.google.com/o/oauth2/v2/auth?client_id=x');
    await Promise.resolve();
    await Promise.resolve();

    assert.deepEqual(openedUrls, ['https://accounts.google.com/o/oauth2/v2/auth?client_id=x']);
  } finally {
    window.open = originalOpen;
  }
});
