import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
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

/**
 * THE REPORT: "the back, forward and the other buttons at the bottom of
 * the mini yayra are not showing, also the mini yayra view is that of the
 * mobile or web - let's make it same as the desktop view and add a toggle
 * in mini yayra settings at Settings to toggle between this view."
 *
 * ROOT CAUSES:
 *  1. The mini shell's injected titlebar style shrank #app to
 *     calc(100vh - 30px) but .fb-browser-shell inside kept height:100vh
 *     with overflow hidden - the shell's bottom 30px (the mobile view's
 *     back/forward row) were pushed OFF-SCREEN. The buttons rendered;
 *     they were simply invisible.
 *  2. main.js forced isMobile: true for the mini shell - always the
 *     compact mobile layout, never the desktop chrome the user wanted.
 *
 * THE FIX, pinned here:
 *  - Mini defaults to the DESKTOP view (same tab strip + toolbar as the
 *    main browser); the choice is the user's, stored in the shared
 *    profile storage (Settings > Floating toggle), read at mini boot,
 *    applied live (storage event across windows; direct re-render when
 *    toggled inside the mini's own Settings).
 *  - The shell height fix un-clips the bottom bar in the mobile view.
 *  - Window-width resizes never override the chosen mini layout.
 */

async function bootMini({ pref = null, isMobile } = {}) {
  if (pref) globalThis.localStorage.setItem('yayra:mini-layout', pref);
  else globalThis.localStorage.removeItem('yayra:mini-layout');
  const resolved = isMobile !== undefined ? isMobile : (pref === 'mobile');
  const container = document.createElement('div');
  const shell = new BrowserShell({ container, platform: 'linux', isMiniShell: true, isMobile: resolved });
  await shell.initialize();
  shell.render(container);
  return { shell, container };
}

test('MINI DEFAULTS TO DESKTOP: no stored preference = the desktop view, exactly like the main browser', async () => {
  const { shell, container } = await bootMini();
  try {
    assert.equal(shell.getMiniLayoutPref(), 'desktop', 'desktop is the default view');
    assert.ok(container.querySelector('.fb-chrome-tabstrip'), 'desktop tab strip renders in the mini');
    // (dom-shim supports single-class selectors only)
    assert.ok(container.querySelector('.fb-nav-back'), 'back button renders in the toolbar');
    assert.ok(container.querySelector('.fb-nav-forward'), 'forward button renders');
    assert.ok(container.querySelector('.fb-nav-reload'), 'reload renders');
    assert.equal(container.querySelector('.fb-mobile-bottombar'), null, 'no mobile bottom bar');
  } finally {
    shell.destroy();
  }
});

test('COMPACT MINI TOOLBAR: bookmark, Downloads, Documents, Dictionary and menu stay visible while the address field can shrink', async () => {
  const { shell, container } = await bootMini();
  try {
    for (const selector of ['.fb-omnibox-star', '.fb-toolbar-downloads-btn', '.fb-toolbar-documents-btn', '.fb-toolbar-dictionary-btn', '.fb-menu-btn']) {
      assert.ok(container.querySelector(selector), `${selector} remains rendered in mini chrome`);
    }
    assert.ok(container.querySelector('.fb-omnibox-input'), 'the address/search field remains available');
    const css = readFileSync(new URL('../packages/shared-ui/src/theme/design-system.css', import.meta.url), 'utf8');
    assert.match(css, /\.fb-mini-navbar \.fb-omnibox-container\s*\{[^}]*flex:\s*1 1 0;[^}]*min-width:\s*0;/,
      'the omnibox is the flexible, shrinkable toolbar region');
    assert.match(css, /\.fb-mini-navbar \.fb-toolbar-action-btn\s*\{[^}]*flex:\s*0 0 28px;/,
      'toolbar actions keep a fixed visible hit target');
    assert.match(css, /\.fb-mini-navbar \.fb-omnibox-star\s*\{[^}]*flex:\s*0 0 24px;/,
      'bookmark action does not collapse when the window narrows');
    assert.match(css, /\.fb-mini-navbar \.fb-omnibox-input\s*\{[^}]*flex:\s*1 1 0;[^}]*min-width:\s*0;/,
      'text input can shrink without clipping toolbar actions');
  } finally {
    shell.destroy();
  }
});

test('MOBILE PREF STILL WORKS: the compact view renders WITH its back/forward buttons (the un-clipped bottom bar)', async () => {
  const { shell, container } = await bootMini({ pref: 'mobile' });
  try {
    assert.equal(shell.getMiniLayoutPref(), 'mobile');
    const bottomBar = container.querySelector('.fb-mobile-bottombar');
    assert.ok(bottomBar, 'mobile bottom bar renders');
    const tools = bottomBar.querySelector('.fb-mobile-secondary-tools');
    assert.ok(tools, 'the secondary tools row (back/forward) exists');
    const labeled = [...(tools?.querySelectorAll('.fb-mobile-nav-btn') || [])]
      .map((b) => b.getAttribute('aria-label') || b.title);
    assert.ok(labeled.includes('Back') && labeled.includes('Forward'),
      'the previously off-screen back/forward buttons are in the DOM');
  } finally {
    shell.destroy();
  }
});

test('PREFERENCE PERSISTS + APPLIES LIVE inside the mini (Settings opened in yayra mini itself)', async () => {
  const { shell, container } = await bootMini();
  try {
    assert.equal(shell.setMiniLayoutPref('mobile'), 'mobile');
    assert.equal(globalThis.localStorage.getItem('yayra:mini-layout'), 'mobile', 'written to the shared profile storage');
    assert.equal(shell.state.isMobile, true, 'the open mini re-rendered into the mobile view');
    assert.ok(container.querySelector('.fb-mobile-bottombar'), 'mobile chrome is live');

    assert.equal(shell.setMiniLayoutPref('desktop'), 'desktop');
    assert.equal(shell.state.isMobile, false, 'and back into the desktop view');
    assert.ok(container.querySelector('.fb-chrome-tabstrip'), 'desktop chrome is live');
  } finally {
    shell.destroy();
    globalThis.localStorage.removeItem('yayra:mini-layout');
  }
});

test('RESIZE NEVER OVERRIDES THE CHOICE: a narrow mini window keeps the desktop view', async () => {
  const { shell, container } = await bootMini();
  try {
    const before = globalThis.window.innerWidth;
    globalThis.window.innerWidth = 420; // the mini panel's width - "mobile" by viewport
    try {
      shell.handleViewportResize();
    } finally {
      globalThis.window.innerWidth = before;
    }
    assert.equal(shell.state.isMobile, false, 'the user picked desktop - width cannot flip it');
    assert.ok(container.querySelector('.fb-chrome-tabstrip'), 'desktop chrome still rendered');
  } finally {
    shell.destroy();
  }
});

test('SETTINGS TOGGLE: Settings > Floating renders the mini-view switch, defaulting to desktop, and persists flips', async () => {
  globalThis.localStorage.removeItem('yayra:mini-layout');
  const container = document.createElement('div');
  const shell = new BrowserShell({ container, platform: 'linux', isMobile: false });
  await shell.initialize();
  try {
    shell.state.tabs[0].url = 'yayra://settings';
    shell.render(container);
    const toggle = container.querySelector('#fb-in-set-mini-desktop');
    assert.ok(toggle, 'the toggle exists in the Floating settings section');
    assert.equal(toggle.getAttribute('checked') !== null || toggle.checked === true, true,
      'desktop view is ON by default');

    // Flip it off -> mobile preference persisted immediately.
    toggle.dispatchEvent({ type: 'change', target: { checked: false } });
    assert.equal(globalThis.localStorage.getItem('yayra:mini-layout'), 'mobile');

    // ...and back on.
    toggle.dispatchEvent({ type: 'change', target: { checked: true } });
    assert.equal(globalThis.localStorage.getItem('yayra:mini-layout'), 'desktop');
  } finally {
    shell.destroy();
    globalThis.localStorage.removeItem('yayra:mini-layout');
  }
});

test('NO DOUBLE CHROME: the frameless mini window renders no min/max/close cluster (its titlebar has expand/hide)', async () => {
  globalThis.window.yayra = {
    windowControls: { minimize: () => {}, toggleMaximize: () => {}, close: () => {} }
  };
  try {
    const mini = await bootMini();
    assert.equal(mini.container.querySelector('.fb-window-controls'), null,
      'mini shell: no window-controls cluster');
    mini.shell.destroy();

    // Regression guard: the MAIN window keeps its real window controls.
    const container = document.createElement('div');
    const main = new BrowserShell({ container, platform: 'linux', isMobile: false });
    await main.initialize();
    main.render(container);
    assert.ok(container.querySelector('.fb-window-controls'), 'main window: controls still render');
    main.destroy();
  } finally {
    delete globalThis.window.yayra;
  }
});

test('SOURCE PIN (main.js): desktop default, height un-clip, and cross-window live apply', () => {
  const src = readFileSync(new URL('../src/browser/main.js', import.meta.url), 'utf8');
  assert.match(src, /resolveMiniLayoutPref/, 'preference resolver exists');
  assert.match(src, /yayra:mini-layout/, 'reads the shared storage key');
  assert.match(src, /\? resolveMiniLayoutPref\(\) === 'mobile'/, 'mini layout = the stored choice');
  assert.match(src, /: \['android', 'ios', 'pwa', 'pwa-installed'\]\.includes\(target\)/, 'mobile platforms unaffected (regression guard)');
  // The un-clip: the shell must fill the SHRUNKEN #app, not 100vh.
  assert.match(src, /#app \.fb-browser-shell \{ height: 100% !important; \}/,
    'the 30px titlebar no longer pushes the bottom buttons off-screen');
  assert.match(src, /'storage'/, 'mini listens for preference changes from other windows');
});

test('SOURCE PIN (overlayWindow.cjs): the default mini width gives the desktop toolbar room', () => {
  const src = readFileSync(new URL('../electron/overlayWindow.cjs', import.meta.url), 'utf8');
  const m = /function miniDefaultBounds\(\) \{[\s\S]{0,400}?const width = (\d+);/.exec(src);
  assert.ok(m, 'miniDefaultBounds exists');
  assert.ok(Number(m[1]) >= 480, `desktop-view default width (got ${m[1]}px, want >= 480)`);
});
