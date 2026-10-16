import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { setupDomShim } from './dom-shim.mjs';

setupDomShim();

import { BrowserShell } from '../packages/shared-ui/src/components/BrowserShell.js';

/**
 * Three user reports from the light-mode/web audit:
 *
 *  1. LIGHT MODE readability: many surfaces hardcoded dark backgrounds and
 *     light text inline, so Settings > Theme > Light produced invisible
 *     text and dark islands. The drawer, submenus and mini window now
 *     follow the theme, and every inline-styled surface uses theme tokens
 *     (var(--fb-...)) with its dark value as the fallback.
 *  2. GOOGLE ON WEB: window.open from the async render path had lost the
 *     user's Enter-key activation, so popup blockers ate it and the user
 *     hit the dead "can't open" card. The open now happens synchronously
 *     inside navigateActiveTab (still in the activation window), for
 *     frame-hostile sites AND search URLs, and the render shows the
 *     honest already-opened card without double-opening.
 *  3. THE DRAWER: it lives on the RIGHT, with submenus opening sideways to
 *     the LEFT rather than expanding inside the menu. Its scrim stays fully
 *     transparent, so the page is never dimmed or blurred.
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

/* ---------------- 2. GOOGLE ON WEB ---------------- */

test('GOOGLE (web): pressing Enter opens Google SYNCHRONOUSLY - inside the user activation window', async () => {
  delete window.Capacitor;
  delete window.yayra;
  delete window.ibrowse;
  const opened = [];
  const realOpen = window.open;
  window.open = (url, target) => { opened.push({ url, target }); return { closed: false }; };
  const { shell } = await makeShell();
  try {
    shell.navigateActiveTab('google.com');
    assert.equal(opened.length, 1, 'Google opened on the FIRST try, no dead card');
    assert.equal(opened[0].url, 'https://google.com');
    assert.equal(opened[0].target, '_blank');
    // The tab itself shows the honest already-opened state.
    const tab = shell.getActiveTab();
    assert.equal(tab.url, 'https://google.com');
    const card = shell.viewportElement?.querySelector('.fb-frame-blocked-fallback');
    assert.ok(card, 'the honest card renders');
    assert.match(card.textContent, /opened for you in a new browser tab/, 'and says where it opened');
  } finally {
    shell.destroy();
    if (realOpen) window.open = realOpen; else delete window.open;
    delete globalThis.localStorage;
  }
});

test('GOOGLE (web): searches open too, and the render path NEVER double-opens', async () => {
  delete window.Capacitor;
  const opened = [];
  const realOpen = window.open;
  window.open = (url) => { opened.push(url); return { closed: false }; };
  const { shell } = await makeShell();
  try {
    // A search: interpretUrl turns plain words into the engine's search url.
    shell.navigateActiveTab('latest news');
    await flush();
    assert.equal(opened.length, 1, `the search genuinely opened (${opened[0]})`);
    assert.match(opened[0], /search|q=/, 'it is the search results url');
    // The same tab+url renders again (re-render): strictly one open.
    shell.render();
    await flush();
    assert.equal(opened.length, 1, 're-renders never open a second tab');
  } finally {
    shell.destroy();
    if (realOpen) window.open = realOpen; else delete window.open;
    delete globalThis.localStorage;
  }
});

test('GOOGLE (web): a blocked popup falls back to the one-click card, never a dead end', async () => {
  delete window.Capacitor;
  const realOpen = window.open;
  window.open = () => null; // popup blocker wins
  const { shell } = await makeShell();
  try {
    shell.navigateActiveTab('x.com');
    const card = shell.viewportElement?.querySelector('.fb-frame-blocked-fallback');
    assert.ok(card, 'the card renders');
    assert.match(card.querySelector('.fb-frame-blocked-open-btn').textContent, /Open in new tab/, 'with the one-click open button');
  } finally {
    shell.destroy();
    if (realOpen) window.open = realOpen; else delete window.open;
    delete globalThis.localStorage;
  }
});

test('GOOGLE (native engines): the web auto-open NEVER fires - Android renders in-app, desktop in its native view', async () => {
  const opened = [];
  const realOpen = window.open;
  window.open = (url) => { opened.push(url); return { closed: false }; };
  window.Capacitor = {
    isNativePlatform: () => true,
    Plugins: {
      App: { addListener: () => Promise.resolve({ remove: () => {} }), getLaunchUrl: async () => undefined },
      YayraOverlay: {
        show: async () => {},
        addListener: () => Promise.resolve({ remove: () => {} }),
        tabWebAttach: async () => ({ ok: true }),
        tabWebUpdate: async () => ({ ok: true }),
        tabWebSetVisible: async () => ({ ok: true }),
        tabWebRemove: async () => ({ ok: true })
      }
    }
  };
  const { shell } = await makeShell();
  try {
    shell.navigateActiveTab('google.com');
    await flush();
    assert.equal(opened.length, 0, 'no browser-tab escape on native builds');
    assert.ok(shell.viewportElement.querySelector('.fb-android-tabweb-slot'), 'Google renders in the in-app native engine');
  } finally {
    shell.destroy();
    delete window.Capacitor;
    if (realOpen) window.open = realOpen; else delete window.open;
    delete globalThis.localStorage;
  }
});

/* ---------------- 1. LIGHT MODE ---------------- */

test('LIGHT MODE: the drawer, submenus and mini window follow the theme (no black islands)', () => {
  const css = readFileSync(new URL('../packages/shared-ui/src/theme/design-system.css', import.meta.url), 'utf8');
  assert.ok(css.includes('--fb-drawer-bg: #ffffff'), 'drawer background token flips to white');
  assert.ok(css.includes('--fb-drawer-submenu-bg: #ffffff'), 'submenu flyouts flip too');
  assert.ok(css.includes('--fb-drawer-hover: rgba(15, 23, 42, 0.06)'), 'hover state flips');
  assert.ok(css.includes('[data-theme="light"] .fb-floating-popup-window') && css.includes('background: rgba(245, 248, 252, 0.96)'), 'the mini window flips');
});

test('LIGHT MODE: inline-styled surfaces use theme tokens (dark values only as fallbacks)', () => {
  const src = readFileSync(new URL('../packages/shared-ui/src/components/BrowserShell.js', import.meta.url), 'utf8');
  // The raw hardcoded literals are gone - every surface reads the tokens.
  for (const raw of ['background:#15171c;', 'background:#141824;', 'background:#11141d;', 'background:#141722;', 'background:rgba(17,20,29,0.97);', 'color:#dfe4ee;', 'color:#d7dbe3;', 'color:#9aa3b2;']) {
    assert.ok(!src.includes(raw), `no hardcoded ${raw} left in inline styles`);
  }
  // ...and the token reads with dark fallbacks are in place.
  assert.ok(src.includes('var(--fb-text-primary,#dfe4ee)'), 'doc viewer text is tokenized');
  assert.ok(src.includes('var(--fb-bg-elevated,#15171c)'), 'fallback cards are tokenized');
  assert.ok(src.includes('var(--fb-bg-glass-input,rgba(255,255,255,0.07))'), 'buttons are tokenized');
});

test('LIGHT MODE (behavior): the document viewer renders with tokenized surfaces (no dark islands)', async () => {
  const { shell } = await makeShell();
  try {
    shell._docEngineOverride = { getDocument: () => ({ promise: Promise.resolve({ numPages: 1, getPage: async () => ({ rotate: 0, getViewport: () => ({ width: 600, height: 800 }), render: () => ({ promise: Promise.resolve() }), getTextContent: async () => ({ items: [] }) }), destroy: () => {} }) }) };
    shell.addDocumentTab({ name: 'light.pdf', bytes: new Uint8Array([1]).buffer });
    await flush(20);
    const viewer = shell.viewportElement.querySelector('.fb-doc-viewer');
    assert.ok(viewer, 'viewer renders');
    const bars = viewer.querySelectorAll('.fb-doc-toolbar');
    assert.ok(bars.length >= 2, 'toolbar rows render');
    for (const bar of bars) {
      assert.match(String(bar.style && bar.style.cssText || ''), /var\(--fb-bg-/, 'toolbar backgrounds read the theme token');
    }
  } finally {
    shell.destroy();
    delete globalThis.localStorage;
  }
});

/* ---------------- 3. THE DRAWER ---------------- */

test('DRAWER: opens on the RIGHT with sideways flyouts to its left, without dimming or blurring the page', () => {
  const css = readFileSync(new URL('../packages/shared-ui/src/theme/design-system.css', import.meta.url), 'utf8');
  const menuAt = css.indexOf('.fb-side-drawer-menu {');
  assert.ok(menuAt > -1);
  const menu = css.slice(menuAt, css.indexOf('}', menuAt));
  assert.match(menu, /right: 0;/, 'the drawer is anchored to the right edge');
  assert.ok(!/left: 0;/.test(menu), 'it is not anchored to the left');
  assert.match(css, /@keyframes fb-drawer-slide \{\s*from \{ transform: translateX\(100%\); \}/, 'it slides in from the right');
  const subAt = css.indexOf('.fb-drawer-submenu {');
  const submenu = css.slice(subAt, css.indexOf('}', subAt));
  assert.match(submenu, /position: absolute;/, 'submenus are positioned as flyouts, not inline accordions');
  assert.match(submenu, /right: calc\(100% - 1px\);/, 'flyouts open to the LEFT of the right-side drawer');
  assert.match(css, /\.fb-drawer-submenu\.is-open \{\s*display: flex;/, 'only active lateral flyouts are displayed');
  assert.ok(!/\.fb-drawer-item-has-submenu\.open > \.fb-drawer-submenu \{\s*position: static;/.test(css), 'open submenus never become inline');
  // The scrim is fully transparent: the page is never dimmed or blurred.
  const scrimAt = css.indexOf('.fb-side-drawer-scrim {');
  const scrim = css.slice(scrimAt, css.indexOf('}', scrimAt));
  assert.match(scrim, /background: transparent;/, 'the scrim is invisible');
  assert.ok(!/backdrop-filter/.test(scrim), 'the scrim never blurs the page');
  assert.match(menu, /backdrop-filter: none !important;/, 'the drawer itself never blurs the page');
});

test('DRAWER (behavior): submenus leave the scroll list and open beside the menu; click-outside closes', async () => {
  const { shell, container } = await makeShell();
  try {
    shell.state.tabs[0].url = 'https://example.com/';
    shell.state.isSideDrawerOpen = true;
    shell.render(container);
    const menu = container.querySelector('.fb-side-drawer-menu');
    assert.ok(menu, 'the menu renders');

    const parentButton = menu.querySelector('.fb-dr-tabgroups-parent');
    const parent = parentButton.parentElement;
    const flyout = parent.querySelector('.fb-drawer-submenu');
    menu.getBoundingClientRect = () => ({ left: 680, top: 0, right: 1000, bottom: 768, width: 320, height: 768 });
    parentButton.getBoundingClientRect = () => ({ left: 704, top: 400, right: 980, bottom: 440, width: 276, height: 40 });
    flyout.getBoundingClientRect = () => ({ left: 0, top: 0, right: 270, bottom: 220, width: 270, height: 220 });
    parentButton.click();
    assert.equal(parent.classList.contains('open'), true, 'the parent opens on tap/click');
    assert.equal(flyout.parentElement, menu, 'the submenu is detached from the scrolling list');
    assert.equal(flyout.classList.contains('is-open'), true, 'the detached submenu is visible as a lateral flyout');
    assert.equal(flyout.style.left, '-269px', 'the submenu is positioned outside the drawer on its left side');
    parentButton.click();
    assert.equal(flyout.parentElement, parent, 'closing the submenu restores it to its source item');
    assert.equal(parent.classList.contains('open'), false, 'a second click closes the flyout');

    const scrim = container.querySelector('.fb-side-drawer-scrim');
    assert.ok(scrim, 'the invisible close target renders');
    scrim.click();
    assert.equal(shell.state.isSideDrawerOpen, false, 'clicking outside closes the menu');
  } finally {
    shell.destroy();
    delete globalThis.localStorage;
  }
});
