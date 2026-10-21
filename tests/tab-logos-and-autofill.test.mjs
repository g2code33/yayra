/**
 * P39: real site logos in tabs + personal autofill in the address bar.
 *
 *  1. A tab showing a real website must display THAT SITE'S logo
 *     (favicon) in the tab strip - not a generic globe. The globe is
 *     only the under-image fallback; yayra:// pages keep their icons
 *     and the loading hourglass is untouched.
 *
 *  2. Typing in the omnibox must autofill from everything the user has
 *     used before: known links (history + bookmarks, matched anywhere
 *     in the address or title), and words/phrases they have actually
 *     searched before (recovered from search-result URLs in history).
 *     Addresses the user has used also inline-complete (score 0).
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { setupDomShim } from './dom-shim.mjs';

setupDomShim();

import { BrowserShell } from '../packages/shared-ui/src/components/BrowserShell.js';

async function makeShell() {
  delete globalThis.window.yayra;
  const container = document.createElement('div');
  const shell = new BrowserShell({ container, platform: 'linux', isMobile: false });
  await shell.initialize();
  shell.render(container);
  return shell;
}

test('tab shows the REAL site logo for web pages (globe only as under-image fallback)', async () => {
  const shell = await makeShell();
  const html = shell.getTabFavicon({ id: 't1', url: 'https://www.youtube.com/watch?v=abc', isLoading: false });
  assert.match(html, /fb-tab-site-logo/, 'real logo img rendered');
  assert.match(html, /icons\.duckduckgo\.com\/ip3\/www\.youtube\.com\.ico/, 'logo resolved from the site host');
  assert.match(html, /fb-tab-logo-fallback/, 'globe fallback kept underneath');
});

test('CSP-safe sources only: data: favicons win, https page favicons resolve via the allowed icon host', async () => {
  const shell = await makeShell();
  // The shell CSP only allows chrome images from self/data:/the icon
  // service - a page-reported https favicon URL would be BLOCKED and
  // show as a broken-image glyph (the exact field bug).
  const blocked = shell.getTabFavicon({ id: 't1', url: 'https://example.com/', favicon: 'https://example.com/fav.png', isLoading: false });
  assert.doesNotMatch(blocked, /example\.com\/fav\.png/, 'never embeds a CSP-blocked favicon URL');
  assert.match(blocked, /icons\.duckduckgo\.com\/ip3\/example\.com\.ico/, 'resolved through the allowed icon host instead');
  const inlined = shell.getTabFavicon({ id: 't2', url: 'https://example.com/', favicon: 'data:image/png;base64,AAA', isLoading: false });
  assert.match(inlined, /src="data:image\/png;base64,AAA"/, 'data: favicons are CSP-safe and win');
});

test('no inline onerror/onload (blocked by CSP) - fallbacks bound programmatically', async () => {
  const shell = await makeShell();
  const html = shell.getTabFavicon({ id: 't1', url: 'https://example.com/', isLoading: false });
  assert.doesNotMatch(html, /onerror=|onload=/, 'inline handlers are dead under script-src without unsafe-inline');
  assert.equal(typeof shell.bindTabLogoFallbacks, 'function', 'programmatic binder exists');

  // Binder wires load -> hide globe, error -> remove broken img.
  const scope = document.createElement('div');
  const stack = document.createElement('span');
  stack.className = 'fb-tab-logo-stack';
  const fallback = document.createElement('span');
  fallback.className = 'fb-tab-logo-fallback';
  const img = document.createElement('img');
  img.className = 'fb-tab-site-logo';
  const handlers = {};
  img.addEventListener = (type, fn) => { handlers[type] = fn; };
  let removed = false;
  img.remove = () => { removed = true; };
  img.parentElement = stack;
  stack.querySelector = (sel) => (sel === '.fb-tab-logo-fallback' ? fallback : null);
  stack.appendChild(fallback);
  stack.appendChild(img);
  scope.appendChild(stack);
  const realQsa = scope.querySelectorAll?.bind(scope);
  scope.querySelectorAll = (sel) => (sel === '.fb-tab-site-logo' ? [img] : (realQsa ? realQsa(sel) : []));

  shell.bindTabLogoFallbacks(scope);
  assert.equal(typeof handlers.load, 'function', 'load listener attached');
  assert.equal(typeof handlers.error, 'function', 'error listener attached');
  handlers.load();
  assert.equal(fallback.style.display, 'none', 'logo loaded -> globe hidden');
  handlers.error();
  assert.equal(removed, true, 'logo failed -> broken img removed, globe stays');
});

test('hourglass while loading and internal-page icons are untouched', async () => {
  const shell = await makeShell();
  assert.match(
    shell.getTabFavicon({ id: 't1', url: 'https://example.com/', isLoading: true }),
    /fb-tab-loading-hourglass/,
    'time sign still shows while loading'
  );
  const settingsIcon = shell.getTabFavicon({ id: 't2', url: 'yayra://settings', isLoading: false });
  assert.doesNotMatch(settingsIcon, /fb-tab-site-logo/, 'yayra:// pages keep their own icons');
});

test('continue cards keep internal pages without requesting settings.ico or downloads.ico', async () => {
  const shell = await makeShell();
  shell.state.continueTabs = [
    { url: 'yayra://settings', title: 'Settings' },
    { url: 'yayra://downloads', title: 'Downloads' },
    { url: 'https://afaregistration.com/', title: 'AFA Registration' }
  ];
  const cardHost = document.createElement('div');
  shell.appendContinueCard(cardHost, []);
  const card = cardHost.children[0];
  assert.ok(card, 'continue card is appended');
  assert.equal((card.innerHTML.match(/class="fb-continue-item"/g) || []).length, 3, 'session restoration still includes each saved tab');
  assert.doesNotMatch(card.innerHTML, /settings\.ico|downloads\.ico/);
  assert.match(card.innerHTML, /<svg/, 'internal pages use Yayra-owned icon markup');
  assert.match(card.innerHTML, /fb-tab-site-logo/);
  assert.doesNotMatch(card.innerHTML, /onerror=/, 'favicon fallback remains CSP-safe');
});

test('autofill matches known links from history AND bookmarks, anywhere in address or title', async () => {
  const shell = await makeShell();
  shell.state.historyItems = [
    { url: 'https://www.youtube.com/', title: 'YouTube' },
    { url: 'https://news.ycombinator.com/', title: 'Hacker News' },
    { url: 'ftp://ignored.example/', title: 'not web' }
  ];
  shell.state.bookmarksItems = [{ url: 'https://github.com/g2code33/yayra', title: 'yayra repo' }];

  const byAddressStart = shell.getAutofillMatches('you');
  assert.equal(byAddressStart[0].url, 'https://www.youtube.com/', 'address-start match ranks first');
  assert.equal(byAddressStart[0].score, 0, 'score 0 = inline-completable');

  const byTitle = shell.getAutofillMatches('hacker');
  assert.equal(byTitle[0].url, 'https://news.ycombinator.com/', 'title match found');

  const anywhere = shell.getAutofillMatches('code33');
  assert.equal(anywhere[0].url, 'https://github.com/g2code33/yayra', 'match ANYWHERE in the address, from bookmarks too');

  assert.equal(shell.getAutofillMatches('ignored').length, 0, 'non-web schemes never suggested');
});

test('words the user searched before are remembered and suggested', async () => {
  const shell = await makeShell();
  shell.state.historyItems = [
    { url: 'https://www.google.com/search?q=best+jollof+recipe', title: 'best jollof recipe - Google Search' },
    { url: 'https://duckduckgo.com/?q=electron+wayland+fix', title: 'DuckDuckGo' },
    { url: 'https://example.com/plain', title: 'Plain page' }
  ];
  const phrases = shell.getRememberedSearchPhrases();
  assert.ok(phrases.includes('best jollof recipe'), 'google search words recovered');
  assert.ok(phrases.includes('electron wayland fix'), 'duckduckgo search words recovered');

  const suggestions = shell.getLocalSearchSuggestions('jollof');
  assert.ok(suggestions.includes('best jollof recipe'), 'previously searched words resurface while typing');
});

test('pasted logs, multiline text, and internal routes stay local instead of being sent to remote search suggestions', async () => {
  const shell = await makeShell();
  const originalFetch = globalThis.fetch;
  let requests = 0;
  globalThis.fetch = async () => { requests += 1; return new Response(JSON.stringify(['x', []]), { status: 200 }); };
  try {
    assert.deepEqual(await shell.getGoogleSearchSuggestions('x'.repeat(500)), []);
    assert.deepEqual(await shell.getGoogleSearchSuggestions('line one\nline two'), []);
    assert.deepEqual(await shell.getGoogleSearchSuggestions('yayra://settings'), []);
    assert.equal(requests, 0, 'sensitive, oversized, and internal text is never sent to the worker');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('a superseded suggestion request cannot return stale remote text', async () => {
  const shell = await makeShell();
  const originalFetch = globalThis.fetch;
  let resolveRemote;
  let requests = 0;
  globalThis.fetch = () => {
    requests += 1;
    return new Promise((resolve) => { resolveRemote = resolve; });
  };
  try {
    const previousQuery = shell.getGoogleSearchSuggestions('ghana weather');
    await new Promise((resolve) => setTimeout(resolve, 210));
    assert.equal(requests, 1, 'the first query reached the suggestion service after debounce');
    const currentQuery = await shell.getGoogleSearchSuggestions('pasted log\nsecond line');
    assert.deepEqual(currentQuery, [], 'multiline input remains local');
    resolveRemote(new Response(JSON.stringify(['ghana weather', ['stale remote result']]), { status: 200 }));
    const staleResult = await previousQuery;
    assert.equal(staleResult.includes('stale remote result'), false, 'an older in-flight response is discarded');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('dropdown shows personal autofill rows for typed text', async () => {
  const shell = await makeShell();
  shell.state.historyItems = [{ url: 'https://www.youtube.com/', title: 'YouTube' }];

  const input = document.createElement('input');
  input.dataset = input.dataset || {};
  const host = document.createElement('div');
  host.className = 'fb-omnibox-container';
  host.appendChild(input);
  input.closest = (sel) => (sel === '.fb-omnibox-container' ? host : null);
  shell.bindSearchSuggestions(input);

  const matches = shell.getAutofillMatches('youtu');
  assert.equal(matches.length, 1);
  assert.equal(matches[0].kind, 'history');
  assert.equal(matches[0].title, 'YouTube');
});
