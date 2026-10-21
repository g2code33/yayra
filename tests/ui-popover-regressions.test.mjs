import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { setupDomShim } from './dom-shim.mjs';

setupDomShim();

import { BrowserShell } from '../packages/shared-ui/src/components/BrowserShell.js';

const css = readFileSync(
  new URL('../packages/shared-ui/src/theme/design-system.css', import.meta.url),
  'utf8'
);
const publicCss = readFileSync(
  new URL('../public/styles.css', import.meta.url),
  'utf8'
);
const devServer = readFileSync(
  new URL('../scripts/dev-server.mjs', import.meta.url),
  'utf8'
);

const ruleBody = (selector) => {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const matches = [...css.matchAll(new RegExp(`^\\s*${escaped}\\s*\\{([^}]*)\\}`, 'gm'))];
  assert.ok(matches.length, `missing CSS rule: ${selector}`);
  return matches.at(-1)[1];
};

test('tab-group picker rows are width-safe and cannot create the horizontal scrollbar regression', () => {
  const list = ruleBody('.fb-tab-groups-picker-list');
  const item = ruleBody('.fb-tab-group-picker-item');
  const popover = ruleBody('.fb-modal-card.fb-tab-groups-popover');

  assert.match(list, /overflow-x:\s*hidden/, 'the picker clips accidental horizontal overflow');
  assert.match(item, /box-sizing:\s*border-box/, '100% row width includes its padding and border');
  assert.match(item, /min-width:\s*0/, 'long titles may shrink inside the row');
  assert.match(item, /overflow:\s*hidden/, 'long tab details stay inside the rounded row');
  assert.match(popover, /background:\s*#[0-9a-f]{6}/i, 'popover owns an opaque background');
});

test('custom tab hover card replaces the native title tooltip and remains readable', async () => {
  delete globalThis.window.yayra;
  document.body.querySelectorAll('.fb-tab-hover-card').forEach((card) => card.remove());
  const container = document.createElement('div');
  const shell = new BrowserShell({ container, platform: 'linux', isMobile: false });
  await shell.initialize();
  try {
    shell.state.tabs[0].title = 'New Tab';
    shell.state.tabs[0].url = 'yayra://newtab';
    const el = shell.render(container);
    const tab = el.querySelector('.fb-tab-item');

    assert.equal(tab.getAttribute('title'), null,
      'no native title attribute exists to draw a duplicate tooltip');
    assert.match(tab.getAttribute('aria-label') || '', /New Tab/, 'the accessible label remains available');

    tab.dispatchEvent({ type: 'mouseenter' });
    await new Promise((resolve) => setTimeout(resolve, 475));
    const card = document.body.querySelector('.fb-tab-hover-card');
    assert.ok(card, 'the custom hover card opens');
    assert.equal(card.getAttribute('role'), 'tooltip');
    assert.equal(card.querySelector('strong')?.textContent, 'New Tab');
    assert.equal(card.querySelector('span')?.textContent, 'newtab');

    const hoverRule = ruleBody('.fb-tab-hover-card');
    assert.match(hoverRule, /box-sizing:\s*border-box/);
    assert.match(hoverRule, /background:\s*#111827/);
    assert.match(hoverRule, /color:\s*#f8fafc/);

    tab.dispatchEvent({ type: 'mouseleave' });
    assert.equal(document.body.querySelector('.fb-tab-hover-card'), null, 'the card closes with the pointer');
  } finally {
    shell.destroy();
  }
});

test('tab-group text prompts use an upper-left, opaque, light/dark-safe surface', () => {
  const overlay = ruleBody('.fb-text-prompt-overlay.fb-text-prompt-tab-groups');
  const dialog = ruleBody('.fb-text-prompt-dialog');
  const lightDialog = ruleBody('[data-theme="light"] .fb-text-prompt-dialog');

  assert.match(overlay, /align-items:\s*flex-start/);
  assert.match(overlay, /justify-content:\s*flex-start/);
  assert.match(overlay, /background:\s*transparent/);
  assert.match(dialog, /background:\s*#111b35/);
  assert.match(dialog, /color:\s*#f8fafc/);
  assert.match(lightDialog, /background:\s*#ffffff/);
  assert.match(lightDialog, /color:\s*#0f172a/);
});

test('Google + menu sections are isolated from legacy page cards and recent rows never create native URL tooltips', async () => {
  const reset = publicCss.match(/:where\(#app \.fb-browser-shell\) section\s*\{([^}]*)\}/)?.[1] || '';
  assert.ok(reset, 'the production stylesheet has a low-specificity BrowserShell section reset');
  assert.match(reset, /margin:\s*0/);
  assert.match(reset, /padding:\s*0/);
  assert.match(reset, /background:\s*transparent/);
  assert.match(reset, /border:\s*0/);
  assert.match(reset, /border-radius:\s*0/);
  assert.ok(
    publicCss.indexOf(':where(#app .fb-browser-shell) section') > publicCss.indexOf('@media (prefers-color-scheme: dark)'),
    'the reset follows both the light and dark legacy section-card declarations'
  );
  assert.ok(
    devServer.indexOf('/styles.css?dev=') > -1
      && devServer.indexOf('/styles.css?dev=') < devServer.indexOf('/packages/shared-ui/src/theme/design-system.css?dev='),
    'the dev preview reproduces the production stylesheet cascade instead of hiding this regression'
  );

  delete globalThis.window.yayra;
  const container = document.createElement('div');
  const shell = new BrowserShell({ container, platform: 'linux', isMobile: false });
  await shell.initialize();
  try {
    shell.state.closedTabsHistory = [{
      id: 'closed-menu-regression',
      title: 'Account security',
      url: 'https://github.com/example/security'
    }];
    const el = shell.render(container);
    const row = el.querySelector('.fb-google-recent-tab');
    assert.ok(row, 'a real recent page appears in the Google context menu');
    assert.equal(row.getAttribute('title'), null,
      'no native title bubble can cover the compact menu');
    assert.match(row.getAttribute('aria-label') || '', /Account security/);
    assert.match(row.getAttribute('aria-label') || '', /github\.com\/example\/security/,
      'the URL remains available to assistive technology');

    row.click();
    assert.equal(row.getAttribute('aria-checked'), 'true', 'recent-tab context selection still works');
    for (const selector of ['.fb-google-add-images', '.fb-google-add-files', '.fb-google-create-images', '.fb-google-canvas']) {
      assert.ok(el.querySelector(selector), `${selector} remains present and actionable`);
    }
  } finally {
    shell.destroy();
  }
});
