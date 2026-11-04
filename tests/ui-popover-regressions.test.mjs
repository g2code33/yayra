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
  const picker = ruleBody('.fb-tab-groups-picker-list.fb-tab-groups-picker');
  const flyout = ruleBody('.fb-tab-group-hover-flyout');

  assert.match(list, /overflow-x:\s*hidden/, 'the picker clips accidental horizontal overflow');
  assert.match(item, /box-sizing:\s*border-box/, '100% row width includes its padding and border');
  assert.match(item, /min-width:\s*0/, 'long titles may shrink inside the row');
  assert.match(item, /overflow:\s*hidden/, 'long tab details stay inside the rounded row');
  assert.match(popover, /background:\s*#[0-9a-f]{6}/i, 'popover owns an opaque background');
  assert.match(picker, /display:\s*flex/, 'the group picker stays a compact single column');
  assert.doesNotMatch(picker, /grid-template-columns:/, 'member previews do not widen the picker into a permanent second pane');
  assert.match(flyout, /position:\s*fixed/, 'hovered group members render in a separate anchored flyout');
  const docViewer = css.match(/\.fb-doc-viewer\s*\{([^}]*)\}/)?.[1] || '';
  assert.match(docViewer, /min-width:\s*0/, 'document controls cannot widen and shift the entire app viewport');
  assert.match(ruleBody('.fb-doc-toolbar2'), /flex-wrap:\s*wrap !important/, 'document controls wrap instead of leaving their first controls clipped offscreen');
});


test('compact tab-group picker previews tabs to the right on hover and closes when the pointer leaves', async () => {
  delete globalThis.window.yayra;
  const container = document.createElement('div');
  const shell = new BrowserShell({ container, platform: 'linux', isMobile: false });
  await shell.initialize();
  try {
    shell._textPromptDialog = async () => 'Research';
    assert.equal(await shell.createTabGroup(), true);
    const group = shell.getTabGroups().find((candidate) => candidate.name === 'Research');
    assert.ok(group);
    assert.equal(group.tabs.length, 2);

    shell.openModal('tab-groups');
    const picker = container.querySelector('.fb-tab-groups-picker-list');
    assert.ok(picker?.classList.contains('fb-tab-groups-picker'), 'the picker uses a compact single-column layout');
    assert.ok(picker.querySelector('.fb-tab-groups-picker-groups'), 'only group choices occupy the main picker');
    assert.equal(picker.querySelector('.fb-tab-group-members'), null, 'the member preview is not permanently shown');

    const card = picker.querySelector('.fb-tab-group-picker-card');
    card.getBoundingClientRect = () => ({ left: 40, right: 300, top: 60, bottom: 110 });
    card.dispatchEvent({ type: 'mouseenter' });
    let flyout = document.body.querySelector('.fb-tab-group-hover-flyout');
    assert.ok(flyout, 'hovering a group opens its member preview');
    assert.equal(flyout.style.left, '308px', 'the preview opens immediately to the right of the hovered group');
    assert.equal(flyout.querySelectorAll('.fb-tab-group-member-open').length, 2,
      'all member tabs are listed in the hover preview');

    card.dispatchEvent({ type: 'mouseleave' });
    flyout.dispatchEvent({ type: 'mouseenter' });
    await new Promise((resolve) => setTimeout(resolve, 165));
    assert.equal(document.body.querySelector('.fb-tab-group-hover-flyout'), flyout,
      'moving from the group row into its preview keeps it open');
    flyout.dispatchEvent({ type: 'mouseleave' });
    await new Promise((resolve) => setTimeout(resolve, 165));
    assert.equal(document.body.querySelector('.fb-tab-group-hover-flyout'), null,
      'the preview closes after the pointer leaves the group and preview');

    card.dispatchEvent({ type: 'mouseenter' });
    flyout = document.body.querySelector('.fb-tab-group-hover-flyout');
    const target = group.tabs[1];
    flyout.querySelectorAll('.fb-tab-group-member-open')[1].click();
    assert.equal(shell.getActiveTab().id, target.id,
      'choosing a member from the hover preview opens that tab as the active tab');
    assert.equal(document.body.querySelector('.fb-tab-group-hover-flyout'), null,
      'opening a member also removes the transient preview');
  } finally {
    shell.destroy();
    delete globalThis.localStorage;
  }
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
    tab.getBoundingClientRect = () => ({ left: 170, bottom: 68 });
    el.querySelector('.fb-chrome-tabstrip').getBoundingClientRect = () => ({ bottom: 72 });
    el.querySelector('.fb-chrome-navbar').getBoundingClientRect = () => ({ bottom: 112 });
    shell.viewportElement.getBoundingClientRect = () => ({ top: 170 });

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
    assert.equal(card.style.top, '118px',
      'the tooltip starts below the navigation/address toolbar, not between the tab strip and toolbar');

    const hoverRule = ruleBody('.fb-tab-hover-card');
    assert.match(hoverRule, /z-index:\s*2147483647/,
      'the tooltip overlays browser chrome rather than sitting behind another HTML layer');
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
