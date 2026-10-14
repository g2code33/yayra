import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { setupDomShim } from './dom-shim.mjs';

setupDomShim();

import { BrowserShell } from '../packages/shared-ui/src/components/BrowserShell.js';

/**
 * "Install as an app is still not working / android and web versions still
 *  showing can't open site" - the launch-and-open fixes:
 *
 *  1. ANDROID DEEP LINKS: tapping an installed-site shortcut used to land
 *     frame-hostile sites (Google, YouTube, X - exactly the sites people
 *     install) in the in-shell iframe engine, which can NEVER render them:
 *     the user saw the "can't open site" card and a jump to Chrome. Now
 *     those sites open in Yayra's OWN native floating browser window (a
 *     real WebView - no iframe/X-Frame-Options restrictions), with an
 *     honest fallback to the in-shell tab.
 *  2. ENCODING: the Kotlin shortcut builder used form encoding ('+' for
 *     spaces) which the JS decodeURIComponent cannot reverse - deep-linked
 *     URLs with spaces were mangled. Now RFC 3986 (%20).
 *  3. WEB/PWA: frame-blocked sites now genuinely OPEN (a real new browser
 *     tab, popup-blocker permitting) instead of only showing the card.
 */

function makeStorage() {
  const disk = new Map();
  return {
    getItem: (k) => (disk.has(k) ? disk.get(k) : null),
    setItem: (k, v) => disk.set(k, String(v)),
    removeItem: (k) => disk.delete(k),
    key: (i) => [...disk.keys()][i] ?? null,
    get length() { return disk.size; }
  };
}

async function makeShell() {
  globalThis.localStorage = makeStorage();
  const container = document.createElement('div');
  const shell = new BrowserShell({ container, isMobile: false });
  await shell.initialize();
  shell.render(container);
  return { shell, container };
}

const flush = (ms = 20) => new Promise((r) => setTimeout(r, ms));

function fakeNativeCapacitor({ overlayResponse, launchUrl, openedWindow } = {}) {
  const overlayCalls = [];
  window.Capacitor = {
    isNativePlatform: () => true,
    Plugins: {
      App: {
        addListener: () => {},
        getLaunchUrl: async () => (launchUrl ? { url: launchUrl } : undefined)
      },
      YayraOverlay: {
        show: async () => {},
        installSiteAsApp: async () => ({ ok: true }),
        openBrowserWindow: async (opts) => {
          overlayCalls.push(opts);
          return overlayResponse || { ok: true, method: 'floating-browser' };
        }
      }
    }
  };
  return { overlayCalls };
}

test('DEEP LINK (Android): an installed FRAME-HOSTILE site opens in Yayra\'s own native browser window - not the "can\'t open site" card', async () => {
  const { overlayCalls } = fakeNativeCapacitor({
    launchUrl: `com.yayra.app:/browse?url=${encodeURIComponent('https://www.youtube.com/watch?v=abc')}`
  });
  const { shell } = await makeShell();
  try {
    await flush();
    assert.equal(overlayCalls.length, 1, 'the native browser window was asked to open');
    assert.equal(overlayCalls[0].url, 'https://www.youtube.com/watch?v=abc', 'with the decoded site URL');
    // The in-shell tab must NOT be navigated to a site it can never render.
    assert.equal(
      shell.state.tabs.every((t) => !String(t.url).includes('youtube.com')),
      true,
      'no dead youtube tab is left behind in the iframe shell'
    );
  } finally {
    shell.destroy();
    delete window.Capacitor;
    delete globalThis.localStorage;
  }
});

test('DEEP LINK (Android): when the overlay permission is missing, the shortcut still opens the site as an in-shell tab (honest fallback)', async () => {
  const { overlayCalls } = fakeNativeCapacitor({
    overlayResponse: { ok: false, reason: 'overlay-permission' },
    launchUrl: `com.yayra.app:/browse?url=${encodeURIComponent('https://www.google.com/')}`
  });
  const { shell } = await makeShell();
  try {
    await flush();
    assert.equal(overlayCalls.length, 1, 'the native window was attempted');
    assert.equal(shell.getActiveTab().url, 'https://www.google.com/', 'fallback: the tab navigates to the site');
  } finally {
    shell.destroy();
    delete window.Capacitor;
    delete globalThis.localStorage;
  }
});

test('DEEP LINK (Android): a normal (frame-friendly) site still opens as a regular in-shell tab', async () => {
  const { overlayCalls } = fakeNativeCapacitor({
    launchUrl: `com.yayra.app:/browse?url=${encodeURIComponent('https://shop.example.com/offers')}`
  });
  const { shell } = await makeShell();
  try {
    await flush();
    assert.equal(overlayCalls.length, 0, 'no native window needed for frame-friendly sites');
    assert.equal(shell.getActiveTab().url, 'https://shop.example.com/offers', 'opens straight on the site');
  } finally {
    shell.destroy();
    delete window.Capacitor;
    delete globalThis.localStorage;
  }
});

test('DEEP LINK (encoding): a URL containing a space survives the Kotlin -> JS round trip', async () => {
  // This is exactly what the fixed Kotlin encoder produces now
  // (URLEncoder + '+' -> '%20'); decodeURIComponent must reverse it fully.
  const withSpace = 'https://site.example.com/my great page';
  const encoded = 'https%3A%2F%2Fsite.example.com%2Fmy%20great%20page';
  const decoded = decodeURIComponent(encoded);
  assert.equal(decoded, withSpace, 'the RFC 3986 encoding round-trips');

  const { overlayCalls } = fakeNativeCapacitor({
    launchUrl: `com.yayra.app:/browse?url=${encoded}`
  });
  const { shell } = await makeShell();
  try {
    await flush();
    assert.equal(shell.getActiveTab().url, withSpace, 'the space (and the whole URL) survives the deep link');
  } finally {
    shell.destroy();
    delete window.Capacitor;
    delete globalThis.localStorage;
  }
});

test('WEB: a frame-blocked site now genuinely OPENS in a new browser tab (popup-blocker permitting)', async () => {
  delete window.Capacitor;
  const opened = [];
  const realOpen = window.open;
  window.open = (url, target) => { opened.push({ url, target }); return { closed: false }; };
  const { shell } = await makeShell();
  try {
    const { wrapper, iframe } = shell.createWebContentFrame('https://www.facebook.com/', { tabId: 'tab-w1', allowNative: false });
    assert.equal(iframe, null, 'no iframe is attempted for a known frame-hostile site');
    assert.deepEqual(opened.map((o) => o.url), ['https://www.facebook.com/'], 'the site actually opened in a new browser tab');
    const card = wrapper.querySelector('.fb-frame-blocked-fallback');
    assert.ok(card, 'the honest card stays behind');
    assert.match(card.textContent, /opened for you in a new browser tab/, 'the card says where it opened');
    assert.match(card.querySelector('.fb-frame-blocked-open-btn').textContent, /Open again/);

    // Strictly once per tab+url - re-renders never spam new tabs.
    shell.createWebContentFrame('https://www.facebook.com/', { tabId: 'tab-w1', allowNative: false });
    assert.equal(opened.length, 1, 'auto-open happens exactly once per tab+url');
  } finally {
    shell.destroy();
    if (realOpen) window.open = realOpen; else delete window.open;
    delete globalThis.localStorage;
  }
});

test('WEB: when the popup blocker wins, the one-click card remains (no silent dead end)', async () => {
  delete window.Capacitor;
  const realOpen = window.open;
  window.open = () => null; // blocked
  const { shell } = await makeShell();
  try {
    const { wrapper } = shell.createWebContentFrame('https://www.x.com/', { tabId: 'tab-w2', allowNative: false });
    const card = wrapper.querySelector('.fb-frame-blocked-fallback');
    assert.ok(card, 'card shown');
    assert.match(card.textContent, /must be opened in its own tab/, 'honest wording when nothing auto-opened');
    assert.match(card.querySelector('.fb-frame-blocked-open-btn').textContent, /Open in new tab/);
  } finally {
    shell.destroy();
    if (realOpen) window.open = realOpen; else delete window.open;
    delete globalThis.localStorage;
  }
});

test('KOTLIN PIN: the service opens straight on the deep-linked URL, and the plugin exposes it with an honest permission fallback', () => {
  const service = readFileSync(new URL('../packages/floating-android/src/kotlin/com/yayra/floating/android/YayraFloatBubbleService.kt', import.meta.url), 'utf8');
  assert.ok(service.includes('const val EXTRA_URL'), 'the service accepts a launch URL');
  assert.ok(service.includes('putExtra(EXTRA_URL, url)'), 'the launch intent carries the URL');
  assert.ok(service.includes('getStringExtra(EXTRA_URL)'), 'the deep-linked URL is read on OPEN_BROWSER');
  assert.ok(service.includes('navigateBrowser(target)'), 'and loaded into the native WebView session');

  const plugin = readFileSync(new URL('../packages/floating-android/src/kotlin/com/yayra/floating/android/YayraOverlayPlugin.kt', import.meta.url), 'utf8');
  assert.ok(plugin.includes('fun openBrowserWindow'), 'the plugin method exists');
  assert.ok(plugin.includes('YayraFloatBubbleService.openBrowserWindow(context, url)'), 'it starts the floating browser window on the URL');
  assert.ok(plugin.includes('canDrawOverlays'), 'the overlay permission is checked first');
  assert.ok(plugin.includes('"overlay-permission"'), 'the JS layer gets an honest reason to fall back on');
  // The encoding fix: form-style '+' must be normalized to RFC 3986 %20 so
  // the JS decodeURIComponent round-trips the site URL exactly.
  assert.ok(
    plugin.includes('.replace("+", "%20")'),
    'the deep-link URL is RFC 3986 encoded (spaces as %20, never +)'
  );
});

test('KOTLIN PIN: the pinned shortcut still deep-links back into Yayra on the site', () => {
  const plugin = readFileSync(new URL('../packages/floating-android/src/kotlin/com/yayra/floating/android/YayraOverlayPlugin.kt', import.meta.url), 'utf8');
  assert.ok(plugin.includes('com.yayra.app:/browse?url='), 'shortcut intent unchanged');
});
