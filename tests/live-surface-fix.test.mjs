import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { setupDomShim } from './dom-shim.mjs';

setupDomShim();

import { BrowserShell } from '../packages/shared-ui/src/components/BrowserShell.js';

/**
 * THE SECOND FREEZE CLASS (field report: "refreshing does not even work
 * during this time, it only unfreezes back to normal after I click the
 * search bar and search or run the site again - after doing that all the
 * remaining pages now snap back with it").
 *
 * On desktop the live page is a NATIVE surface. Whenever Yayra chrome
 * overlays it, the surface is hidden and replaced by a still snapshot.
 * The "obscured" flag is sticky state - ONE missed close path (frozen
 * background timer, exception, re-render mid-interaction) and the flag
 * outlives its overlay: the user stares at a dead snapshot that swallows
 * every click and wheel event. Refresh runs invisibly BEHIND the hidden
 * surface (looks dead), every tab is frozen the same way, and only a
 * fresh navigation happens to clear the flag - which is exactly why
 * "running a site again" made all the remaining pages snap back at once.
 *
 * THE FIX, pinned here:
 *  1. Truth-based invariant healStuckPageSurface(): if the flag says
 *     obscured but NO genuine overlay exists on screen, the live surface
 *     is restored - from render(), reload(), hardReload() and the moment
 *     the user returns to the window.
 *  2. The update splash yields the native surface on desktop (the native
 *     view paints above all HTML) and EVERY dismiss path restores it.
 *  3. A loaded page stays LIVE: connectivity restoration retries only a
 *     tab already marked failed; it never refreshes a healthy loaded page.
 */

async function makeShell(withBridge = false) {
  const calls = [];
  if (withBridge) {
    globalThis.window.yayra = {
      webview: {
        ensure: async () => ({}), setBounds: async (tabId, bounds) => { calls.push(['setBounds', tabId, bounds]); },
        setVisible: async (tabId, visible) => { calls.push(['setVisible', tabId, visible]); },
        stop: async () => {}, goBack: async () => {}, goForward: async () => {},
        reload: async (tabId) => { calls.push(['reload', tabId]); },
        destroy: async () => {}, capture: async () => ({}), onEvent: () => () => {}
      }
    };
  }
  const container = document.createElement('div');
  const shell = new BrowserShell({ container, isMobile: false });
  await shell.initialize();
  if (withBridge) {
    shell.state.tabs[0].url = 'https://example.com/live-page';
    shell._nativeWebviewTabIds.add(shell.state.tabs[0].id);
  }
  shell.render(container);
  return { shell, container, calls };
}

function lastVisibleCall(calls) {
  return [...calls].reverse().find((c) => c[0] === 'setVisible') || null;
}

test('LIVE SURFACE: a stuck obscured flag (dead snapshot, dead scrolling) is healed by the next render', async () => {
  const { shell, container, calls } = await makeShell(true);
  try {
    // Simulate the exact desync: a popup obscured the page and its close
    // path never ran (frozen timer / missed blur) - flag stuck TRUE with
    // NOTHING on screen.
    shell.setPageObscured(true);
    await new Promise((r) => setTimeout(r, 0)); // let the capture/hide microtask settle
    assert.equal(shell.state.isPageObscured, true);
    assert.ok(calls.some((c) => c[0] === 'setVisible' && c[2] === false),
      'the live surface was hidden behind its still image');

    shell.render(container); // ANY state change / repaint heals
    assert.equal(shell.state.isPageObscured, false,
      'no overlay on screen = no justification for a hidden page');
    const last = lastVisibleCall(calls);
    assert.ok(last && last[2] === true, 'the live native surface is visible again');
  } finally {
    shell.destroy();
    delete globalThis.window.yayra;
  }
});

test('SEARCH NAVIGATION: submitting while suggestions are open cannot leave Google behind a static screenshot', async () => {
  const { shell, calls } = await makeShell(true);
  try {
    const list = shell.rootElement.querySelector('.fb-search-suggestions');
    assert.ok(list, 'desktop omnibox owns a suggestion surface');
    list.hidden = false;
    shell.setPageObscured(true);
    await new Promise((r) => setTimeout(r, 0));
    assert.equal(shell.state.isPageObscured, true, 'suggestions temporarily yield the native page');

    shell.navigateActiveTab('icons');

    assert.equal(shell.getActiveTab().url, 'https://www.google.com/search?q=icons');
    assert.equal(shell.state.isPageObscured, false,
      'navigation retires the dropdown before its input/render tree disappears');
    const last = lastVisibleCall(calls);
    assert.ok(last && last[2] === true, 'the Google destination owns a live, interactive native surface');
  } finally {
    shell.destroy();
    delete globalThis.window.yayra;
  }
});

test('ASYNC SUGGESTIONS: a response from a detached omnibox cannot re-freeze the new page', async () => {
  const { shell, calls } = await makeShell(true);
  try {
    let resolveSuggestions;
    shell.getGoogleSearchSuggestions = () => new Promise((resolve) => { resolveSuggestions = resolve; });
    const oldInput = shell.rootElement.querySelector('.fb-omnibox-input');
    oldInput.value = 'icons';
    oldInput.dispatchEvent({ type: 'input', target: oldInput });
    await Promise.resolve();
    assert.equal(typeof resolveSuggestions, 'function', 'old omnibox request is pending');

    shell.navigateActiveTab('icons');
    const callsAfterNavigation = calls.length;
    resolveSuggestions(['icons download', 'icons png']);
    await Promise.resolve();
    await Promise.resolve();

    assert.equal(shell.state.isPageObscured, false);
    assert.equal(calls.slice(callsAfterNavigation).some((call) => call[0] === 'setVisible' && call[2] === false), false,
      'detached async work never hides the destination after navigation');
  } finally {
    shell.destroy();
    delete globalThis.window.yayra;
  }
});

test('LOAD COMPLETION: a zero-bounds desync is actively re-shown even when the obscured flag is already false', async () => {
  const { shell, calls } = await makeShell(true);
  try {
    const tabId = shell.state.activeTabId;
    calls.length = 0;
    shell.state.isPageObscured = false;
    shell.handleNativeWebviewEvent({ tabId, type: 'loading-stop' });

    assert.ok(calls.some((call) => call[0] === 'setVisible' && call[1] === tabId && call[2] === true),
      'loading-stop reasserts the live native surface');
    assert.ok(calls.some((call) => call[0] === 'setBounds' && call[1] === tabId),
      'loading-stop re-reports real bounds instead of trusting a stale visibility flag');
  } finally {
    shell.destroy();
    delete globalThis.window.yayra;
  }
});

test('REFRESH HEALS: reload() hands back the live surface even when nothing else ran', async () => {
  const { shell, calls } = await makeShell(true);
  try {
    shell.setPageObscured(true);
    await new Promise((r) => setTimeout(r, 0));
    shell.reload();
    assert.equal(shell.state.isPageObscured, false, 'refresh always restores the live page');
    assert.ok(calls.some((c) => c[0] === 'reload'), 'the page reload itself also ran');
    const last = lastVisibleCall(calls);
    assert.ok(last && last[2] === true, 'surface visible again');
  } finally {
    shell.destroy();
    delete globalThis.window.yayra;
  }
});

test('RETURN HEALS: coming back to the window repairs a stuck surface instantly', async () => {
  const { shell } = await makeShell(true);
  try {
    // The shim document has no event API - capture the listener the
    // shell registers (exactly what a real visibilitychange fires).
    const listeners = [];
    document.addEventListener = (type, fn) => { listeners.push({ type, fn }); };
    shell.setPageObscured(true); // arms the return-to-window heal
    delete document.addEventListener; // restore the shim's default (absent)
    assert.ok(listeners.some((l) => l.type === 'visibilitychange'),
      'obscuring a surface arms the return-heal');

    // The user comes back to the window (hidden -> false).
    document.hidden = false;
    for (const l of listeners) if (l.type === 'visibilitychange') l.fn();
    assert.equal(shell.state.isPageObscured, false,
      'the moment the user is back, the live surface is back');
    delete document.hidden;
  } finally {
    shell.destroy();
    delete globalThis.window.yayra;
    try { delete document.hidden; } catch { /* already gone */ }
  }
});

test('LEGIT OVERLAYS: real chrome is never fought by the heal - and the splash round-trips the surface', async () => {
  const { shell, container } = await makeShell(true);
  try {
    shell.setPageObscured(true);
    shell.state.isSideDrawerOpen = true; // genuine chrome on screen
    shell.render(container);
    assert.equal(shell.state.isPageObscured, true, 'drawer up = page legitimately obscured');
    shell.state.isSideDrawerOpen = false;

    // A young splash is legitimate chrome too - and on desktop the
    // surface must yield so the splash is actually VISIBLE.
    shell.showUpdateSplash('9.9.9', '9.9.8');
    await new Promise((r) => setTimeout(r, 0));
    assert.equal(shell.state.isPageObscured, true, 'splash showing = surface yielded');
    shell.render(container);
    assert.equal(shell.state.isPageObscured, true, 'a young splash is not retired by the sweep');
    assert.ok(document.querySelector('.fb-update-splash'), 'splash still on screen');

    // ...and dismissing it (click path) hands the live surface back.
    document.querySelector('.fb-update-splash').click();
    assert.equal(shell.state.isPageObscured, false, 'dismiss restores the live page surface');
  } finally {
    shell.destroy();
    delete globalThis.window.yayra;
  }
});

test('COMPOSITION: a frozen splash (aged past 10s) is retired by render AND the surface heals in the SAME render', async () => {
  const { shell, container } = await makeShell(true);
  try {
    shell.showUpdateSplash('9.9.9', '9.9.8');
    await new Promise((r) => setTimeout(r, 0));
    assert.equal(shell.state.isPageObscured, true, 'desktop yields the surface to the splash');
    const splash = document.querySelector('.fb-update-splash');
    splash.dataset.shownAt = String(Date.now() - 20000); // every dismiss trigger died
    shell.render(container);
    assert.equal(document.querySelector('.fb-update-splash'), null, 'sweep retires the dead splash');
    assert.equal(shell.state.isPageObscured, false,
      'the same render heals the surface - blur wall AND dead snapshot both gone');
  } finally {
    shell.destroy();
    delete globalThis.window.yayra;
  }
});

test('ESC closes the omnibox suggestion dropdown too (it also obscures the page)', async () => {
  const { shell } = await makeShell(false);
  try {
    const list = document.createElement('div');
    list.className = 'fb-search-suggestions';
    list.hidden = false;
    document.body.appendChild(list);
    let prevented = 0;
    shell.handleGlobalKeyDown({ key: 'Escape', preventDefault() { prevented += 1; } });
    assert.equal(list.hidden, true, 'the suggestion dropdown is closed by Esc');
    assert.equal(prevented, 1, 'the key press is consumed');
  } finally {
    shell.destroy();
  }
});

test('STAYS LIVE (source pin): connectivity retries the active FAILED tab but never reloads healthy pages', () => {
  const src = readFileSync(new URL('../packages/shared-ui/src/components/BrowserShell.js', import.meta.url), 'utf8');
  // A loaded page must remain live even with disconnected internet. Online
  // recovery is intentionally conditional: only an active tab with recorded
  // failure state gets an immediate retry; no blanket reload/navigation is
  // allowed for healthy pages or background tabs.
  const connStart = src.indexOf('_armConnectivityAwareness() {');
  assert.ok(connStart > -1, 'connectivity awareness exists');
  const connBlock = src.slice(connStart, src.indexOf('buildOfflineFallback', connStart));
  assert.match(connBlock, /'offline'/, 'offline notice armed');
  assert.match(connBlock, /'online'/, 'online recovery armed');
  assert.match(connBlock, /const activeFailure = this\._siteFailureFor\(this\.state\.activeTabId\)/,
    'online recovery first proves the active tab failed');
  assert.match(connBlock, /if \(activeFailure\)[\s\S]*?_retrySiteRecovery/,
    'that failed active tab gets the requested immediate retry');
  assert.doesNotMatch(connBlock, /this\.reload\(/, 'there is no blanket reload call');
  assert.doesNotMatch(connBlock, /navigateActiveTab/, 'connectivity events never replace the address');
  assert.match(connBlock, /Pages you already opened stay available/, 'the healthy-page promise is stated to the user');
  // The heal invariant is wired into render(), reload() and hardReload().
  const renderStart = src.indexOf('render(container = null) {');
  const renderHead = src.slice(renderStart, renderStart + 2000);
  assert.match(renderHead, /healStuckPageSurface\(\)/, 'render() heals a stuck surface');
  const reloadStart = src.indexOf('  reload() {');
  const reloadBlock = src.slice(reloadStart, reloadStart + 800);
  assert.match(reloadBlock, /healStuckPageSurface\(\)/, 'reload() heals');
  const hardStart = src.indexOf('  async hardReload() {');
  const hardBlock = src.slice(hardStart, hardStart + 800);
  assert.match(hardBlock, /healStuckPageSurface\(\)/, 'hardReload() heals');
  // Obscuring a surface arms the return-to-window heal.
  assert.match(src, /this\.ensureSurfaceHealOnReturn\(\);/, 'obscure arms the return-heal');
  assert.match(src, /visibilitychange[\s\S]{0,200}healStuckPageSurface\(\)/, 'the return listener heals');
});
