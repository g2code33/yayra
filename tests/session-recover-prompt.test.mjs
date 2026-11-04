/**
 * P40: "the recover recent tab is still not coming" - root causes & pins.
 *
 * Two real bugs silently destroyed the last-session snapshot before the
 * user ever saw the "Continue with these tabs?" prompt:
 *
 *  1. LAUNCH-WIPE: a fresh run opens on a lone newtab and the rolling
 *     snapshot (600ms debounce) saved [] over the previous session. If
 *     the user quit again without browsing - or the app auto-reopened
 *     after an update - the offer was gone forever.
 *  2. MINI-SHELL CLOBBER: the bubble's mini panel runs its own shell on
 *     the SAME profile storage; it must write to a separate mini-prefixed
 *     session key rather than replacing the main window's snapshot.
 *
 * Pinned here: the offer survives idle runs and mini-panel usage, mini and
 * main sessions remain independent, the prompt renders (ABOVE the frequent
 * tiles), "No thanks" answers it for good, and "Restore all" consumes it.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { setupDomShim } from './dom-shim.mjs';

setupDomShim();

// Shared "disk" so consecutive shells behave like consecutive app runs.
const disk = new Map();
globalThis.localStorage = {
  getItem: (k) => (disk.has(k) ? disk.get(k) : null),
  setItem: (k, v) => disk.set(k, String(v)),
  removeItem: (k) => disk.delete(k),
  key: (i) => [...disk.keys()][i] ?? null,
  get length() { return disk.size; }
};

const { BrowserShell } = await import('../packages/shared-ui/src/components/BrowserShell.js');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const KEY = 'yayra:p:default:last-session-tabs';
const diskTabs = () => (JSON.parse(disk.get(KEY) || 'null')?.tabs || []).map((t) => t.url);

async function boot(opts = {}) {
  delete globalThis.window.yayra;
  const container = document.createElement('div');
  const shell = new BrowserShell({ container, platform: 'linux', isMobile: false, ...opts });
  await shell.initialize();
  shell.render(container);
  return { shell, container };
}

test('full lifecycle: browse -> quit -> idle relaunch (+ bubble mini) -> offer STILL prompts', async () => {
  disk.clear();

  // RUN 1: the user browses two sites, then the app dies.
  {
    const { shell } = await boot();
    shell.state.tabs.push(
      { id: 't-a', title: 'YouTube', url: 'https://www.youtube.com/', isLoading: false, isPrivate: false, favicon: null },
      { id: 't-b', title: 'GitHub', url: 'https://github.com/', isLoading: false, isPrivate: false, favicon: null }
    );
    shell.render();
    await sleep(900); // flush the 600ms snapshot debounce
    assert.deepEqual(diskTabs(), ['https://www.youtube.com/', 'https://github.com/'], 'rolling snapshot saved');
  }

  // RUN 2: relaunch, user does NOTHING (newtab only), also opens the
  // bubble mini panel; previously both paths wiped the snapshot.
  {
    const { container } = await boot();
    assert.ok(container.querySelector('.fb-continue-card'), 'prompt shown on the fresh newtab');
    const mini = await boot({ isMiniShell: true, isMobile: true });
    mini.shell.render();
    await sleep(900);
    assert.deepEqual(diskTabs(), ['https://www.youtube.com/', 'https://github.com/'],
      'snapshot SURVIVES an idle run and mini-panel usage (the launch-wipe + mini-clobber fixes)');
  }

  // RUN 3: the offer must still prompt; "No thanks" answers it.
  {
    const { shell, container } = await boot();
    const items = container.querySelectorAll('.fb-continue-item');
    assert.ok(container.querySelector('.fb-continue-card'), 'prompt STILL shown on the next run');
    assert.ok(items.length >= 2, 'both last-session tabs offered');
    shell.dismissContinueTabs();
    await sleep(900);
    assert.equal(container.querySelector('.fb-continue-card'), null, 'No thanks removes the card');
    assert.deepEqual(diskTabs(), [], 'rolling snapshot resumes once the offer is answered');
  }

  // RUN 4: no zombie re-prompt of a dismissed/consumed session.
  {
    const { container } = await boot();
    const fromSession = [...container.querySelectorAll('.fb-continue-meta')]
      .some((m) => (m.textContent || '').includes('From last session'));
    assert.equal(fromSession, false, 'dismissed session never re-offers its tabs');
  }
});

test('Restore all consumes the offer and reopens every tab', async () => {
  disk.clear();
  {
    const { shell } = await boot();
    shell.state.tabs.push(
      { id: 't-a', title: 'YouTube', url: 'https://www.youtube.com/', isLoading: false, isPrivate: false, favicon: null }
    );
    shell.render();
    await sleep(900);
  }
  {
    const { shell } = await boot();
    const entries = (shell.state.continueTabs || []).map((t) => ({ url: t.url, title: t.title }));
    assert.equal(entries.length, 1, 'offer loaded');
    shell.restoreContinueTabs(entries);
    assert.equal(shell.getActiveTab().url, 'https://www.youtube.com/', 'newtab became the restored tab');
    assert.equal(shell.state.continueTabs.length, 0, 'offer consumed');
  }
});

test('layout: restore bar docked into BOTH chrome layouts; continue card BELOW the tiles (source-order pin)', () => {
  const src = fs.readFileSync(new URL('../packages/shared-ui/src/components/BrowserShell.js', import.meta.url), 'utf8');
  const barCalls = src.split('this.renderRestoreBar(root);').length - 1;
  assert.equal(barCalls, 2, 'restore bar rendered in desktop AND mobile layouts');
  assert.equal(src.includes('appendRestoreToast'), false,
    'the old floating newtab-only toast is gone - it could not survive on real pages (native view paints over HTML overlays)');
  const tilesAt = src.indexOf('frequentSection.appendChild(frequentGrid);');
  const cardAt = src.indexOf('this.appendContinueCard(newTabPage, frequentSites);');
  assert.ok(tilesAt > 0 && cardAt > 0, 'tiles + card blocks exist');
  assert.ok(tilesAt < cardAt, 'continue card is appended AFTER the frequent-sites section');
});

test('"Restore pages?" bar PERSISTS through searches, tab switches and renders until MANUALLY closed', async () => {
  disk.clear();
  // Previous run with one real tab.
  {
    const { shell } = await boot();
    shell.state.tabs.push(
      { id: 't-a', title: 'YouTube', url: 'https://www.youtube.com/', isLoading: false, isPrivate: false, favicon: null }
    );
    shell.render();
    await sleep(900);
  }
  // Fresh launch: bar AND card both prompt.
  {
    const { shell, container } = await boot();
    assert.ok(container.querySelector('.fb-restore-bar'), 'docked Restore pages? bar shown');
    assert.ok(container.querySelector('.fb-continue-card'), 'continue card also present below');

    // The user browses around - the bar must NOT leave.
    shell.navigateActiveTab('https://example.com/search');
    assert.ok(container.querySelector('.fb-restore-bar'), 'bar survives a search/navigation');
    shell.createNewTab();
    assert.ok(container.querySelector('.fb-restore-bar'), 'bar survives opening a new tab');
    shell.selectTab(shell.state.tabs[0].id);
    assert.ok(container.querySelector('.fb-restore-bar'), 'bar survives switching tabs');
    shell.render();
    assert.ok(container.querySelector('.fb-restore-bar'), 'bar survives arbitrary re-renders');

    // Only the manual X closes it - and the card keeps offering.
    container.querySelector('.fb-restore-bar-close').click();
    assert.equal(container.querySelector('.fb-restore-bar'), null, 'bar dismissed by the user');
    shell.render();
    assert.equal(container.querySelector('.fb-restore-bar'), null, 'stays closed once answered');
    assert.ok(shell.state.continueTabs.length > 0, 'offer NOT consumed by closing the bar');
  }
  // Next launch: bar returns (X was for that run only); Restore works.
  {
    const { shell, container } = await boot();
    const btn = container.querySelector('.fb-restore-bar-btn');
    assert.ok(btn, 'bar prompts again on the next run');
    btn.click();
    assert.equal(shell.getActiveTab().url, 'https://www.youtube.com/', 'Restore reopened the last session');
    assert.equal(container.querySelector('.fb-restore-bar'), null, 'bar gone after restoring');
    assert.equal(shell.state.continueTabs.length, 0, 'offer consumed');
  }
});

test('mini shell keeps a separate profile-scoped snapshot and does not consume main-browser close choices', async () => {
  disk.clear();
  const { shell: main } = await boot();
  main.state.tabs.push({ id: 'main-session', title: 'Main session', url: 'https://main.example.test/', isLoading: false, isPrivate: false, favicon: null });
  main.render();
  await sleep(900);
  const mainSnapshot = disk.get(KEY);
  assert.deepEqual(diskTabs(), ['https://main.example.test/']);

  const { shell: mini } = await boot({ isMiniShell: true });
  mini.state.tabs.push({ id: 'mini-session', title: 'Mini session', url: 'https://mini.example.test/', isLoading: false, isPrivate: false, favicon: null });
  mini.render();
  await sleep(900);
  const miniKey = 'yayra:p:default:mini:last-session-tabs';
  assert.deepEqual(JSON.parse(disk.get(miniKey))?.tabs?.map((tab) => tab.url), ['https://mini.example.test/']);
  assert.equal(disk.get(KEY), mainSnapshot, 'mini navigation never overwrites the main browser snapshot');
  assert.equal(mini.closeSessionStorageKey(), 'yayra:mini:close-session:default');

  const mainCloseKey = 'yayra:close-session:default';
  const mainCloseChoice = JSON.stringify({ mode: 'recent', profileId: 'default', tabs: [{ url: 'https://main-close.example.test/' }] });
  disk.set(mainCloseKey, mainCloseChoice);
  disk.set('yayra:close-session', mainCloseChoice);
  await mini.restoreCloseSession();
  assert.equal(disk.get(mainCloseKey), mainCloseChoice, 'mini ignores the main browser close choice');
  assert.equal(disk.get('yayra:close-session'), mainCloseChoice, 'mini does not migrate/remove the legacy main close choice');
  assert.equal(mini.state.recentTabsOffer, null, 'no main-session close prompt leaks into mini');

  const miniReload = await boot({ isMiniShell: true });
  assert.deepEqual(miniReload.shell.state.continueTabs.map((tab) => tab.url), ['https://mini.example.test/'],
    'the next mini launch restores only the mini window’s own tabs');
  const mainReload = await boot();
  assert.deepEqual(mainReload.shell.state.continueTabs.map((tab) => tab.url), ['https://main.example.test/'],
    'the main browser still restores its own independent tab snapshot');
  await mainReload.shell.restoreCloseSession();
  assert.equal(disk.has(mainCloseKey), false, 'the main shell alone consumes its scoped close choice');
  assert.equal(mainReload.shell.state.recentTabsOffer?.[0]?.url, 'https://main-close.example.test/');

  const src = fs.readFileSync(new URL('../packages/shared-ui/src/components/BrowserShell.js', import.meta.url), 'utf8');
  assert.match(src, /scoped\.get\(`mini:\$\{key\}`\)/, 'mini sessions use their own key namespace within the profile');
  const mainJs = fs.readFileSync(new URL('../src/browser/main.js', import.meta.url), 'utf8');
  assert.match(mainJs, /isMiniShell,/, 'main.js passes the mini flag into the shell');
  assert.match(mainJs, /onOpenPage\?\.\(\(\{ url \} = \{\}\) => browserShell\.openUrlHandoff/, 'mini listens for main-tab handoffs');
});

test('calculator, dictionary, document hub and website tabs all reappear from the saved session', async () => {
  disk.clear();
  const originalUrls = [
    'yayra://calculator', 'yayra://dictionary?q=ghana', 'yayra://documents', 'https://example.com/active'
  ];
  {
    const { shell } = await boot();
    shell.state.tabs = originalUrls.map((url, index) => ({
      id: `restore-${index}`, title: `Open ${index}`, url, isLoading: false, isPrivate: false, favicon: null
    }));
    shell.state.activeTabId = 'restore-0';
    shell.render();
    await sleep(900);
    assert.deepEqual(diskTabs(), originalUrls, 'rolling recovery snapshot contains safe Yayra tool routes in order');
  }
  {
    const { shell } = await boot();
    assert.deepEqual((shell.state.continueTabs || []).map((tab) => tab.url), originalUrls);
    await shell.restoreContinueTabs(shell.state.continueTabs);
    assert.deepEqual(shell.state.tabs.map((tab) => tab.url), originalUrls, 'restore recreates calculator, dictionary, documents and websites');
  }
});
